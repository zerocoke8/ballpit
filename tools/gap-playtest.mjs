// 틈 쏘기 플레이테스트 — 시스템 Edge(없으면 Chrome), 폰 세로(390×844, dpr 2, 터치)에서 실제 터치로 한 스테이지를 끝까지 한다.
// "사람처럼" 조준: 조준 가이드(traceAim — 화면의 점선과 같은 계산)를 보고, 맨 앞 웨이브가 화면에 다 들어와 있고
// 가이드를 틈으로 통과시켜 웨이브 뒤쪽 끝 이상에서 멈추게 할 수 있으면(±WIN° 흔들려도) 그 각도로 탭(필요하면 먼저 드래그로
// 옆으로 이동), 아니면 / 맨 앞 적이 위험선(DANGER) 아래면 가장 아래 적을 향해 탭. 약 1.3초마다 다시 본다.
// 측정: CombatScene.debugState()의 hits / behindHits(적중점이 맨 앞 웨이브의 뒤쪽 끝 이상) /
//       topHits(공이 적보다 위에서 윗면을 때림 = 웨이브 뒤·위로 들어간 공 — 가장 엄격한 기준).
//
// 사용법: node tools/gap-playtest.mjs [--port 5212] [--char cat] [--headed] [--bursts 3]
// 스크린샷: tools/.out/gap/NN-*.png — 공이 맨 앞 웨이브 뒤에 들어가 있고 그 웨이브가 아직 벽(적 SOLID마리 이상)일 때
//           연속 4장 × bursts (연속 촬영 사이 최소 BURST_GAP초).
// stdout 마지막에 JSON 요약. 페이지 오류면 exit 1.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tools', '.out', 'gap');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(argValue('port', 5212));
const CHAR = argValue('char', 'cat');
const BURSTS = Number(argValue('bursts', 3));
const HEADED = args.includes('--headed');
const BASE_URL = `http://localhost:${PORT}/`;
/** 다시 조준하는 간격(ms, 실제 시간) */
const REAIM_MS = 1300;
/** 틈 쏘기로 인정하는 가이드 흔들림 여유(±도) — 손가락 오차를 견디는 '확실한' 틈만 노린다 */
const WIN = 1.5;
/** 맨 앞 적의 아래 끝이 필드 높이의 이 비율보다 내려오면 틈 대신 맨 앞을 친다 */
const DANGER = 0.7;
/** 연속 스크린샷은 맨 앞 웨이브에 적이 이만큼 남아 '벽'일 때만 */
const SOLID = 8;
/** 연속 촬영 사이 최소 간격(게임 초) */
const BURST_GAP = 6;

const summary = { ok: false, url: BASE_URL, char: CHAR, browser: null, result: null, decisions: [], shots: [], consoleErrors: [], pageErrors: [], failures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 개발 서버 (smoke.mjs와 같은 방식) ─────────────────────────
let server = null;
let serverLog = '';
function startServer() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteArgs = ['--port', String(PORT), '--strictPort'];
  const child = existsSync(viteBin)
    ? spawn(process.execPath, [viteBin, ...viteArgs], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npx', ['vite', ...viteArgs], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const collect = (buf) => {
    serverLog = (serverLog + buf.toString()).slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return child;
}
function stopServer() {
  if (!server || server.exitCode !== null || server.killed) return;
  if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      server.kill('SIGTERM');
    } catch {
      /* 이미 종료 */
    }
  }
}
async function waitForServer(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server exited (code ${server.exitCode}):\n${serverLog}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      /* 아직 */
    }
    await sleep(300);
  }
  throw new Error(`dev server did not respond on ${BASE_URL}:\n${serverLog}`);
}
async function launchBrowser() {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      const b = await chromium.launch({ channel, headless: !HEADED });
      summary.browser = channel;
      return b;
    } catch (err) {
      errors.push(`${channel}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  throw new Error(`system browser launch failed (${errors.join(' | ')})`);
}

// ── 페이지 안에서 도는 계획 (가이드와 같은 traceAim) ──────────
/** 지금 화면을 보고 다음 조준을 정한다. moveTo = 틈 쏘기를 하려면 옮겨 설 필드 x (없으면 null) */
async function plan(page) {
  return page.evaluate(
    async ({ win, danger }) => {
      const { traceAim, FIRE_OFFSET_Y } = await import('/src/logic/combat/sim.ts');
      const s = window.__game.game.scenes.current;
      if (!s?.debugState) return null; // 전투가 끝남
      const sim = s.sim;
      const st = s.debugState();
      const ft = st.frontTop;
      const r = s.guideRadius;
      const out = new Float64Array(6);
      const res = { points: 0, hitId: -1 };
      const STEP = 0.5;
      const gapFrom = (px) => {
        if (ft === null || ft < 0) return null; // 웨이브가 아직 다 안 들어옴 → 뒤쪽 공간 없음
        const oy = sim.player.y - FIRE_OFFSET_Y;
        const ok = [];
        const angles = [];
        for (let deg = -172; deg <= -8; deg += STEP) {
          const a = (deg * Math.PI) / 180;
          traceAim(px, oy, a, r, sim.enemies, 1600, 2, out, res);
          ok.push(res.hitId >= 0 && out[2 * (res.points - 1) + 1] <= ft + 4.5);
          angles.push(a);
        }
        const w = Math.round(win / STEP);
        let best = null;
        for (let i = w; i < ok.length - w; i++) {
          let all = true;
          for (let k = i - w; k <= i + w && all; k++) all = ok[k];
          if (all && (best === null || Math.abs(angles[i] + Math.PI / 2) < Math.abs(best + Math.PI / 2))) best = angles[i];
        }
        return best;
      };
      let lowest = null;
      for (const e of sim.enemies) {
        if (!e.alive || e.y + e.h <= 0) continue;
        const b = e.y + e.h;
        if (!lowest || b > lowest.y + lowest.h + 0.5 || (Math.abs(b - lowest.y - lowest.h) <= 0.5 && Math.abs(e.x + e.w / 2 - sim.player.x) < Math.abs(lowest.x + lowest.w / 2 - sim.player.x))) lowest = e;
      }
      const deepest = lowest ? (lowest.y + lowest.h) / 960 : 0;
      let px = sim.player.x;
      let gap = deepest < danger ? gapFrom(px) : null;
      let moveTo = null;
      if (gap === null && deepest < danger) {
        for (const d of [84, -84, 168, -168, 252, -252]) {
          const x = Math.max(40, Math.min(632, px + d));
          const a = gapFrom(x);
          if (a !== null) {
            moveTo = x;
            gap = a;
            px = x;
            break;
          }
        }
      }
      const oy = sim.player.y - FIRE_OFFSET_Y;
      const angle = gap ?? (lowest ? Math.atan2(lowest.y + lowest.h / 2 - oy, lowest.x + lowest.w / 2 - px) : -Math.PI / 2);
      return { gap: gap !== null, angle, moveTo, deepest, frontTop: ft, frontCount: st.frontCount, aim: st.aimAngle, t: st.time };
    },
    { win: WIN, danger: DANGER },
  );
}

/** 발사점에서 angle 방향으로 필드 안(테두리 벽 포함)에 들어오는 가장 먼(≤ 380px) 점의 화면 CSS 좌표 */
async function tapPointFor(page, angle) {
  return page.evaluate(({ angle }) => {
    const s = window.__game.game.scenes.current;
    if (!s?.sim) return null;
    const p = s.sim.player;
    const ox = p.x;
    const oy = p.y - 30;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    let d = 380;
    while (d > 90) {
      const fx = ox + c * d;
      const fy = oy + sn * d;
      if (fx >= -18 && fx <= 690 && fy >= -8) break;
      d -= 10;
    }
    const g = s.playerLayer.toGlobal({ x: ox + c * d, y: oy + sn * d });
    return { x: g.x, y: g.y };
  }, { angle });
}

/** 전투 씬의 debugState (전투가 끝나 다른 씬으로 넘어갔으면 null) */
const state = (page) => page.evaluate(() => window.__game.game.scenes.current?.debugState?.() ?? null);

/** 화면의 투사체 중 맨 앞 웨이브 뒤쪽 끝보다 위(웨이브 뒤)에 있는 수 */
const behindNow = (page) =>
  page.evaluate(() => {
    const s = window.__game.game.scenes.current;
    if (!s?.debugState) return { behind: 0, total: 0, frontTop: null };
    const ft = s.debugState().frontTop;
    if (ft === null || ft < 0) return { behind: 0, total: s.sim.projectiles.length, frontTop: ft };
    return { behind: s.sim.projectiles.filter((p) => p.y < ft).length, total: s.sim.projectiles.length, frontTop: ft };
  });

// ── 메인 ────────────────────────────────────────────────────
let browser;
try {
  if (existsSync(OUT_DIR)) for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.png')) rmSync(path.join(OUT_DIR, f));
  mkdirSync(OUT_DIR, { recursive: true });
  server = startServer();
  await waitForServer();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url ?? '';
    if (/\/favicon\.ico|fonts\.(googleapis|gstatic)\.com/.test(where + m.text())) return;
    summary.consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => summary.pageErrors.push(String(e?.stack ?? e)));
  await page.routeWebSocket(/^wss?:\/\//, () => {}); // HMR 끔 (실행 중 파일이 바뀌어도 새로고침 안 됨)
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const tap = async (p) => {
    await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
    await sleep(50);
    await touch('touchEnd', []);
  };

  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__game?.scene === 'function', null, { timeout: 30000 });
  await page.evaluate((c) => window.__game.game.startRun(c), CHAR);
  await page.waitForFunction(() => window.__game.game.scenes.current?.debugState?.()?.phase === 'fight', null, { timeout: 15000, polling: 50 });

  /** 하단 바를 드래그해 플레이어를 필드 x로 옮긴다 (드래그 = 상대 이동) */
  const moveTo = async (fx) => {
    const geo = await page.evaluate(() => {
      const s = window.__game.game.scenes.current;
      const a = s.playerLayer.toGlobal({ x: 0, y: 0 });
      const b = s.playerLayer.toGlobal({ x: 100, y: 0 });
      return { cssPerPx: (b.x - a.x) / 100, barY: s.weaponBar.toGlobal({ x: 0, y: 0 }).y };
    });
    const st0 = await state(page);
    if (!st0) return;
    const dx = (fx - st0.playerX) * geo.cssPerPx;
    // 먼저 아래로 살짝 끌어 드래그를 시작(TAP_SLOP 넘김 → 그 자리가 기준점), 그다음 옆으로 dx
    const start = { x: 195 - dx / 2, y: geo.barY + 50 };
    const y = start.y + 16;
    await touch('touchStart', [{ x: start.x, y: start.y, id: 1 }]);
    await touch('touchMove', [{ x: start.x, y: start.y + 8, id: 1 }]);
    await sleep(16);
    await touch('touchMove', [{ x: start.x, y, id: 1 }]);
    await sleep(16);
    let fingerX = start.x;
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      fingerX = start.x + (dx * i) / steps;
      await touch('touchMove', [{ x: fingerX, y, id: 1 }]);
      await sleep(16);
    }
    // 캐릭터는 이동 속도로 걸어간다(가속·도착 감속) — 손가락을 둔 채 도착(멈춤)을 기다리고,
    // 멈췄는데 어긋나 있으면(닫힌 루프 보정) 손가락을 그만큼 더 민다. 걷는 중에 보정하면 목표를 지나쳐 버린다
    for (let k = 0; k < 100; k++) {
      await sleep(30);
      const s = await state(page);
      if (!s || s.status !== 'running') break;
      const err = fx - s.playerX;
      const stopped = Math.abs(s.playerVx) < 1 && Math.abs(s.playerVy) < 1;
      if (!stopped) continue;
      if (Math.abs(err) < 4) break;
      fingerX += err * geo.cssPerPx;
      await touch('touchMove', [{ x: fingerX, y, id: 1 }]);
    }
    await touch('touchEnd', []);
  };

  let bursts = 0;
  let lastBurst = -Infinity;
  let shotNo = 0;
  const samples = [];
  let deepest = 0;
  let last = null;
  for (let guard = 0; guard < 400; guard++) {
    const st = await state(page);
    if (st) last = st;
    if (!st || st.status !== 'running') break;
    const pl = await plan(page);
    if (!pl) break;
    if (pl.moveTo !== null) await moveTo(pl.moveTo);
    // 옮겼으면 그 자리에서 다시 본다
    if (pl.moveTo !== null && (await state(page))?.status !== 'running') continue;
    const p2 = pl.moveTo !== null ? await plan(page) : pl;
    if (!p2) break;
    const diff = Math.abs(Math.atan2(Math.sin(p2.angle - p2.aim), Math.cos(p2.angle - p2.aim)));
    const tp = diff > 0.5 * (Math.PI / 180) ? await tapPointFor(page, p2.angle) : null;
    if (tp) await tap(tp);
    const after = await state(page);
    if (!after) continue;
    summary.decisions.push({
      t: +after.time.toFixed(2),
      kind: p2.gap ? 'gap' : 'front',
      moved: pl.moveTo !== null,
      want: +((p2.angle * 180) / Math.PI).toFixed(1),
      aim: +((after.aimAngle * 180) / Math.PI).toFixed(1),
      deepest: +(p2.deepest * 100).toFixed(0),
      front: p2.frontCount,
    });
    const until = Date.now() + REAIM_MS;
    while (Date.now() < until) {
      const s = await state(page);
      if (s) last = s;
      if (!s || s.status !== 'running') break;
      // 공이 아직 벽인 맨 앞 웨이브 뒤로 들어가 있으면 튀는 모습을 연속으로 찍는다
      if (bursts < BURSTS && s.frontCount >= SOLID && s.time - lastBurst >= BURST_GAP && (await behindNow(page)).behind > 0) {
        bursts++;
        lastBurst = s.time;
        for (let k = 0; k < 4; k++) {
          const s2 = await state(page);
          if (!s2 || s2.status !== 'running') break;
          const b = await behindNow(page);
          const name = `${String(++shotNo).padStart(2, '0')}-burst${bursts}-${k + 1}.png`;
          await page.screenshot({ path: path.join(OUT_DIR, name) });
          summary.shots.push({ file: path.relative(ROOT, path.join(OUT_DIR, name)), t: +s2.time.toFixed(2), frontCount: s2.frontCount, projectilesBehind: b.behind, projectiles: b.total, hits: s2.hits, behindHits: s2.behindHits, topHits: s2.topHits });
          await sleep(220);
        }
      }
      samples.push({ t: s.time, hits: s.hits, behind: s.behindHits, top: s.topHits });
      const lowest = await page.evaluate(() => {
        let m = 0;
        for (const e of window.__game.game.scenes.current?.sim?.enemies ?? []) m = Math.max(m, e.y + e.h);
        return m / 960;
      });
      deepest = Math.max(deepest, lowest);
      await sleep(250);
    }
  }
  // 전투가 끝나면 곧 다른 씬으로 넘어가므로 마지막으로 읽은 전투 상태를 결과로 쓴다
  const end = (await state(page)) ?? last;
  // 결정 직후 3초 동안의 적중을 결정 종류별로 모은다
  const window3 = (t0) => {
    const a = samples.find((s) => s.t >= t0) ?? samples[samples.length - 1];
    const b = [...samples].reverse().find((s) => s.t <= t0 + 3) ?? a;
    return { hits: b.hits - a.hits, behind: b.behind - a.behind, top: b.top - a.top };
  };
  const agg = { gap: { n: 0, hits: 0, behind: 0, top: 0 }, front: { n: 0, hits: 0, behind: 0, top: 0 } };
  for (const d of summary.decisions) {
    const w = window3(d.t);
    const g = agg[d.kind];
    g.n++;
    g.hits += w.hits;
    g.behind += w.behind;
    g.top += w.top;
  }
  summary.result = {
    status: end.status,
    time: +end.time.toFixed(1),
    kills: `${end.kills}/${end.totalEnemies}`,
    deepestPct: Math.round(deepest * 100),
    hpLost: end.maxHp - end.hp,
    hits: end.hits,
    behindHits: end.behindHits,
    behindPct: Math.round((100 * end.behindHits) / Math.max(1, end.hits)),
    topHits: end.topHits,
    topPct: Math.round((100 * end.topHits) / Math.max(1, end.hits)),
    gapTaps: summary.decisions.filter((d) => d.kind === 'gap').length,
    frontTaps: summary.decisions.filter((d) => d.kind === 'front').length,
    next3s: {
      afterGap: { decisions: agg.gap.n, hitsPer: +(agg.gap.hits / Math.max(1, agg.gap.n)).toFixed(1), behindPer: +(agg.gap.behind / Math.max(1, agg.gap.n)).toFixed(1), topPer: +(agg.gap.top / Math.max(1, agg.gap.n)).toFixed(1) },
      afterFront: { decisions: agg.front.n, hitsPer: +(agg.front.hits / Math.max(1, agg.front.n)).toFixed(1), behindPer: +(agg.front.behind / Math.max(1, agg.front.n)).toFixed(1), topPer: +(agg.front.top / Math.max(1, agg.front.n)).toFixed(1) },
    },
  };
  summary.ok = summary.pageErrors.length === 0 && summary.consoleErrors.length === 0;
} catch (err) {
  summary.failures.push(String(err?.stack ?? err));
} finally {
  await browser?.close().catch(() => {});
  stopServer();
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(summary.ok ? 0 : 1);
