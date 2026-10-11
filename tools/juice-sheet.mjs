// 연출(이펙트) 리뷰 컨택트 시트 — 시스템 Edge(없으면 Chrome)로 폰 세로 화면(390×844, dpr 2)에서
// 전투 장면 8개를 연출하고, 장면마다 짧은 연속 촬영 중 연출이 가장 잘 보이는 프레임을 골라 한 장으로 붙인다.
//
// 사용법: node tools/juice-sheet.mjs [--port 5213] [--headed] [--hmr]
//
// 장면: 1 st1 기본 플레이(냥냥 시작 무기) · 2 틈 쏘기 '백어택' 콤보 · 3 폭발(수박·화염병) · 4 불(불꽃 토스터)
//       5 얼음(수박 빙수·참치) · 6 번개(정전기 털뭉치) · 7 곰인형(엘리트) 처치 · 8 보스전(무기 10종 스트레스 가방)
// 프레임 고르기: 연속 촬영하면서 매 장 debugState(살아있는 이펙트 파티클 수·콤보)를 같이 읽어 점수가 가장 높은 장.
//   콤보 = 콤보 수가 가장 큰 장, 엘리트 처치 = 처치 순간에서 약 0.18초 뒤(펑 + 폭발 구름)에 가장 가까운 장.
// 연출을 잘 보이게 하려고 장면 상태를 직접 만든다(적 위치 옮기기·HP 고정·플레이어 무적) — 밸런스 측정용이 아니다.
// 출력: tools/.out/juice/NN-<장면>.png(고른 프레임 원본 해상도) + sheet.png(4×2, 장면당 390×844). stdout 마지막에 JSON 요약.
// 실패(exit 1): 콘솔/페이지 에러, 장면 준비 실패. 개발 서버는 끝날 때(실패 포함) 항상 종료한다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tools', '.out', 'juice');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(argValue('port', 5213));
const HEADED = args.includes('--headed');
const ALLOW_HMR = args.includes('--hmr');
const BASE_URL = `http://localhost:${PORT}/`;
const VIEW = { width: 390, height: 844 };
const DPR = 2;
const LABEL_H = 30;
const GAP = 6;

const summary = { ok: false, url: BASE_URL, browser: null, scenes: [], consoleErrors: [], pageErrors: [], failures: [], sheet: null, durationMs: 0 };
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 개발 서버 (smoke.mjs와 같은 방식) ───────────────────────

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
  const pid = server.pid;
  if (process.platform === 'win32' && pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
      const res = await fetch(BASE_URL);
      if (res.ok) return;
    } catch {
      /* 아직 */
    }
    await sleep(300);
  }
  throw new Error(`dev server did not respond on ${BASE_URL} within ${timeoutMs}ms:\n${serverLog}`);
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

const isIgnorable = (text, url) => /\/favicon\.ico(\?|$|\s)/.test(`${url ?? ''} ${text}`) || /fonts\.(googleapis|gstatic)\.com/.test(`${url ?? ''} ${text}`);

// ── 장면 도우미 ──────────────────────────────────────────────

let page = null;

/** 런을 만들고(가방 배치·스테이지 지정) 전투 씬이 'fight'가 될 때까지 */
async function setup({ char = 'cat', stage = 0, items = null, layout = null }) {
  await page.evaluate(
    async ({ char, stage, items, layout }) => {
      const B = await import('/src/logic/bag.ts');
      const R = await import('/src/logic/run.ts');
      const g = window.__game.game;
      const s = g.scenes.current;
      if (s?.__iv) for (const iv of s.__iv) clearInterval(iv);
      g.startRun(char);
      const run = g.run;
      run.stageIndex = stage;
      if (layout) {
        run.bag = B.createBag(layout.cols, layout.rows);
        for (const it of layout.items) {
          if (!B.addNewToBag(run.bag, g.data.items, it.defId, it.tier ?? 1, it.x, it.y, it.rot ?? 0)) throw new Error(`layout ${it.defId}`);
        }
      } else if (items) {
        run.bag = B.createBag(7, 6);
        for (const [id, tier] of items) {
          const spot = B.findFreeSpot(run.bag, g.data.items, id);
          if (!spot || !B.addNewToBag(run.bag, g.data.items, id, tier, spot.x, spot.y, spot.rot)) throw new Error(`item ${id}`);
        }
      }
      run.hp = R.runPlayerStats(g.data, run).maxHp;
      window.__prevScene = g.scenes.current;
      g.toCombat();
    },
    { char, stage, items, layout },
  );
  await page.waitForFunction(
    () => {
      const c = window.__game.game.scenes.current;
      return c !== window.__prevScene && c?.debugState?.()?.phase === 'fight';
    },
    null,
    { timeout: 20000, polling: 50 },
  );
  // 플레이어 무적 (연출을 오래 보려고) — 씬이 바뀌면 같이 버려진다
  await page.evaluate(() => {
    const s = window.__game.game.scenes.current;
    s.__iv = [setInterval(() => s.sim && (s.sim.player.hp = s.sim.player.maxHp), 100)];
  });
}

/** 가장 아래의 보이는 적을 0.25초마다 조준 (사람이 맨 앞 적을 계속 탭하는 흉내) */
const autoAim = () =>
  page.evaluate(() => {
    const s = window.__game.game.scenes.current;
    s.__iv.push(
      setInterval(() => {
        const sim = s.sim;
        let best = null;
        for (const e of sim.enemies) if (e.alive && e.y + e.h > 30 && (!best || e.y + e.h > best.y + best.h)) best = e;
        if (best) s.setAim(Math.atan2(best.y + best.h / 2 - (sim.player.y - 30), best.x + best.w / 2 - sim.player.x));
      }, 250),
    );
  });

const state = () => page.evaluate(() => window.__game.game.scenes.current?.debugState?.() ?? null);

/** 연속 촬영: n장, 간격 every ms. 매 장 직전 debugState와 extra(선택)를 같이 기록 */
async function burst(n, every, extra = null) {
  const frames = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const tf = Date.now();
    const st = await state();
    const ex = extra ? await page.evaluate(extra) : null;
    const buf = await page.screenshot({ type: 'png' });
    frames.push({ buf, ms: tf - t0, st, ex });
    const spent = Date.now() - tf;
    if (spent < every) await sleep(every - spent);
  }
  return frames;
}

function best(frames, score) {
  let b = frames[0];
  let bs = -Infinity;
  for (const f of frames) {
    const s = score(f);
    if (s > bs) {
      bs = s;
      b = f;
    }
  }
  return b;
}

async function keep(no, name, label, frame) {
  const file = path.join(OUT_DIR, `${String(no).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, frame.buf);
  const st = frame.st ?? {};
  const rec = {
    no,
    name,
    label,
    file: path.relative(ROOT, file),
    fxParticles: st.fxParticles ?? null,
    combo: st.combo ?? null,
    hp: st.hp ?? null,
    time: st.time != null ? +st.time.toFixed(1) : null,
    proj: frame.ex?.proj ?? null,
  };
  summary.scenes.push(rec);
  return { ...rec, buf: frame.buf };
}

const projCount = () => ({ proj: window.__game.game.scenes.current?.sim?.projectiles.length ?? 0 });

/**
 * 장면 점수용 연출 상태(내부 필드를 읽는 측정 전용): 투사체 수, 번개 수, 폭발 구름(주황/서리) 수, 불타는·얼어붙은 적 수
 */
const fxDetail = () => {
  const s = window.__game.game.scenes.current;
  const fx = s?.fx;
  const sim = s?.sim;
  if (!fx || !sim) return null;
  let booms = 0;
  let frost = 0;
  for (const f of fx.active) {
    if (f.delay > 0) continue;
    if (f.p.texture === fx.atlas.boom) booms++;
    else if (f.p.texture === fx.atlas.ice) frost++;
  }
  let bolts = 0;
  for (const b of fx.bolts) if (b.active) bolts++;
  let burning = 0;
  let chilled = 0;
  for (const e of sim.enemies) {
    if (!e.alive || e.y + e.h <= 0) continue;
    if (e.burnTime > 0) burning++;
    if (e.chillTime > 0) chilled++;
  }
  return { proj: sim.projectiles.length, bolts, booms, frost, burning, chilled };
};

/** 웨이브가 다 들어올 때까지(맨 앞 웨이브 뒤 끝이 화면 안) 빨리감기 */
async function untilFrontInside(minTop = 84, timeoutMs = 20000) {
  await page.evaluate(() => window.__game.debug.setSpeed(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await state();
    if (st && st.frontTop !== null && st.frontTop >= minTop) break;
    await sleep(100);
  }
  await page.evaluate(() => window.__game.debug.setSpeed(1));
}

/**
 * 조준 가이드(traceAim)로 맨 앞 웨이브 뒤로 확실히 넘어가는(±1.5°) 자리·각도를 찾는다. 지금 자리에서 되면 바로 조준하고
 * { moving: false }, 다른 자리면 그리로 걸어가게만 하고 { moving: true } — 캐릭터는 이동 속도로 걸어가므로 도착한 뒤 다시 계획한다
 */
const planGap = () =>
  page.evaluate(async () => {
    const { traceAim, FIRE_OFFSET_Y } = await import('/src/logic/combat/sim.ts');
    const s = window.__game.game.scenes.current;
    const sim = s.sim;
    const ft = s.debugState().frontTop;
    if (ft === null || ft < 0) return null;
    const r = s.guideRadius;
    const out = new Float64Array(6);
    const res = { points: 0, hitId: -1 };
    for (const px of [sim.player.x, 84, 168, 252, 336, 420, 504, 588]) {
      for (let deg = -170; deg <= -10; deg += 0.5) {
        const a = (deg * Math.PI) / 180;
        let ok = true;
        for (const dd of [-1.5, 0, 1.5]) {
          traceAim(px, sim.player.y - FIRE_OFFSET_Y, a + (dd * Math.PI) / 180, r, sim.enemies, 1600, 2, out, res);
          if (!(res.hitId >= 0 && out[2 * (res.points - 1) + 1] <= ft + 4.5)) ok = false;
        }
        if (ok) {
          if (Math.abs(px - sim.player.x) > 2) {
            s.input.targetX = px;
            s.input.targetY = sim.player.y;
            return { px, deg, moving: true };
          }
          s.setAim(a);
          return { px, deg, moving: false };
        }
      }
    }
    return null;
  });

// ── 장면들 ───────────────────────────────────────────────────

const ST5_BIG = {
  cols: 7,
  rows: 6,
  items: [
    { defId: 'w_sock_gatling', x: 0, y: 0 },
    { defId: 's_haste', x: 1, y: 0 },
    { defId: 'w_yuzu_molotov', x: 2, y: 0 },
    { defId: 's_mirror', x: 3, y: 0 },
    { defId: 'w_static_hairball', x: 4, y: 0 },
    { defId: 's_haste', x: 5, y: 0 },
    { defId: 'w_yuzu', x: 6, y: 0 },
    { defId: 's_mirror', x: 0, y: 1 },
    { defId: 's_power', x: 1, y: 1 },
    { defId: 'w_hairball', x: 2, y: 1 },
    { defId: 'w_flame_toaster', x: 0, y: 2 },
    { defId: 'w_melon_bingsu', x: 2, y: 2 },
    { defId: 'w_mama_duck', x: 4, y: 2 },
    { defId: 'w_methane_bomb', x: 5, y: 2 },
    { defId: 'w_tuna_missile', x: 5, y: 3 },
    { defId: 'g_bandage', x: 0, y: 4 },
    { defId: 'g_potlid', x: 1, y: 4 },
  ],
};

async function sceneNormal(no) {
  await setup({ char: 'cat', stage: 0 });
  await autoAim();
  await sleep(7000);
  const frames = await burst(14, 90, projCount);
  return keep(no, 'st1-normal', 'st1 normal (cat starter)', best(frames, (f) => f.st?.fxParticles ?? 0));
}

async function sceneCombo(no) {
  await setup({ char: 'cat', stage: 0, items: [['w_hairball', 1], ['w_hairball', 1], ['s_power', 1]] });
  let pick = null;
  for (let attempt = 0; attempt < 3 && !pick; attempt++) {
    await untilFrontInside();
    let plan = null;
    for (let i = 0; i < 40 && !plan; i++) {
      const p = await planGap();
      if (p?.moving) {
        // 그 자리까지 걸어가 설 때까지 (최대 약 2.5초) 기다렸다가 다시 계획
        for (let k = 0; k < 50; k++) {
          await sleep(50);
          const st = await state();
          if (!st || (Math.abs(st.playerX - p.px) < 1 && Math.abs(st.playerVx) < 1)) break;
        }
        continue;
      }
      plan = p;
      if (!plan) await sleep(250);
    }
    if (!plan) continue;
    await sleep(700);
    const frames = await burst(26, 80, projCount);
    const top = best(frames, (f) => (f.st?.combo ?? 0) * 1000 + (f.st?.fxParticles ?? 0));
    if ((top.st?.combo ?? 0) >= 2) pick = top;
    else if (attempt === 2) pick = top;
  }
  if (!pick) throw new Error('combo: no gap found');
  return keep(no, 'gap-combo', 'gap shot combo', pick);
}

/** score(ex): 장면마다 그 연출이 가장 잘 보이는 프레임. waitMs = 촬영 전 대기(번개는 연쇄할 이웃 적이 화면에 찰 때까지 더 길게) */
async function sceneElement(no, name, label, items, score, waitMs = 6500) {
  await setup({ char: 'cat', stage: 1, items });
  // 적 HP ×3: 빌드가 대형을 화면에 들어오자마자 지워 버리면 화상·냉기·연쇄가 보일 틈이 없다 (연출 촬영용)
  await page.evaluate(() => {
    for (const e of window.__game.game.scenes.current.sim.enemies) {
      e.hp *= 3;
      e.maxHp *= 3;
    }
  });
  await autoAim();
  await sleep(waitMs);
  const frames = await burst(16, 80, fxDetail);
  return keep(no, name, label, best(frames, (f) => (f.ex ? score(f.ex) : 0) * 100 + (f.st?.fxParticles ?? 0)));
}

async function sceneElite(no) {
  const stage = await page.evaluate(() =>
    window.__game.game.data.stages.findIndex((st) => Object.entries(st.legend).some(([ch, id]) => id === 'teddy' && st.rows.some((r) => r.includes(ch)))),
  );
  await setup({ char: 'cat', stage, items: [['w_tuna_missile', 3], ['w_static_hairball', 2], ['w_sock_gatling', 2]] });
  await sleep(400);
  const ok = await page.evaluate(() => {
    const s = window.__game.game.scenes.current;
    const sim = s.sim;
    const t = sim.enemies.find((e) => e.defId === 'teddy');
    if (!t) return false;
    const dy = 260 - t.y;
    for (const e of sim.enemies) e.y += dy;
    // 곰인형 앞(아래)·사선을 막는 적만 치운다 — 나머지 대형은 그대로 두고 보이게
    for (const e of sim.enemies) {
      if (e === t) continue;
      const below = e.y + e.h > t.y + t.h + 2;
      const beside = e.y + e.h > t.y + 4 && Math.abs(e.x + e.w / 2 - (t.x + t.w / 2)) < t.w / 2 + 90;
      if (below || beside) e.alive = false;
    }
    t.hp = 1e9;
    s.__teddy = t;
    const p = sim.player;
    s.setAim(Math.atan2(t.y + t.h / 2 - (p.y - 30), t.x + t.w / 2 - p.x));
    return true;
  });
  if (!ok) throw new Error('elite: no teddy');
  await sleep(1500);
  await page.evaluate(() => {
    const t = window.__game.game.scenes.current.__teddy;
    t.hp = 1;
  });
  const frames = await burst(20, 60, () => ({ dead: !window.__game.game.scenes.current.__teddy.alive }));
  const killAt = frames.find((f) => f.ex?.dead)?.ms;
  if (killAt === undefined) throw new Error('elite: teddy not killed during burst');
  // 처치 순간 이후 약 0.18초 — 부풀어 하얘진 뒤 연기·폭발 구름이 피어오른 순간
  return keep(no, 'elite-kill', 'teddy (elite) kill', best(frames, (f) => (f.ex?.dead ? -Math.abs(f.ms - killAt - 180) : -1e9)));
}

async function sceneBoss(no) {
  await setup({ char: 'capybara', stage: 4, layout: ST5_BIG });
  await sleep(300);
  await page.evaluate(() => {
    const s = window.__game.game.scenes.current;
    const sim = s.sim;
    const b = sim.enemies.find((e) => e.boss);
    const dy = 120 - b.y;
    for (const e of sim.enemies) e.y += dy;
    // 보스 웨이브만 남긴다 (보스 위아래로 3줄 안의 호위)
    for (const e of sim.enemies) if (!e.boss && (e.y + e.h > b.y + b.h + 2 * 84 || e.y < b.y - 84)) e.alive = false;
    s.__iv.push(setInterval(() => b.alive && b.hp < b.maxHp * 0.45 && (b.hp = b.maxHp * 0.7), 200));
    s.__iv.push(
      setInterval(() => {
        const p = sim.player;
        let best = null;
        for (const e of sim.enemies) if (e.alive && e.y + e.h > 30 && (!best || e.y + e.h > best.y + best.h)) best = e;
        if (best) s.setAim(Math.atan2(best.y + best.h / 2 - (p.y - 30), best.x + best.w / 2 - p.x) + Math.sin(Date.now() / 700) * 0.35);
      }, 250),
    );
  });
  await sleep(6500);
  const frames = await burst(14, 90, projCount);
  return keep(no, 'boss-bigbuild', 'st5 boss, 10-weapon bag', best(frames, (f) => f.st?.fxParticles ?? 0));
}

// ── 시트 ─────────────────────────────────────────────────────

async function makeSheet(cells) {
  const cols = 4;
  const rows = Math.ceil(cells.length / cols);
  const cw = VIEW.width;
  const ch = VIEW.height + LABEL_H;
  const comps = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const left = GAP + (i % cols) * (cw + GAP);
    const top = GAP + Math.floor(i / cols) * (ch + GAP);
    const img = await sharp(c.buf).resize(VIEW.width, VIEW.height).png().toBuffer();
    const info = [c.fxParticles != null ? `fx ${c.fxParticles}` : '', c.proj != null ? `proj ${c.proj}` : '', c.combo ? `combo ${c.combo}` : ''].filter(Boolean).join(' · ');
    const svg = `<svg width="${cw}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#2b1d3a"/>
<text x="8" y="20" font-size="15" font-weight="bold" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif">${c.no}. ${c.label}</text>
<text x="${cw - 8}" y="20" font-size="12" fill="#c9b8e0" text-anchor="end" font-family="Segoe UI, Arial, sans-serif">${info}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left, top });
    comps.push({ input: img, left, top: top + LABEL_H });
  }
  const file = path.join(OUT_DIR, 'sheet.png');
  await sharp({ create: { width: GAP + cols * (cw + GAP), height: GAP + rows * (ch + GAP), channels: 3, background: '#140e1c' } })
    .composite(comps)
    .png()
    .toFile(file);
  return file;
}

// ── 메인 ─────────────────────────────────────────────────────

let browser = null;
try {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.png')) rmSync(path.join(OUT_DIR, f));
  server = startServer();
  await waitForServer();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (!isIgnorable(text, m.location()?.url)) summary.consoleErrors.push(text);
  });
  page.on('pageerror', (e) => summary.pageErrors.push(String(e?.stack ?? e)));
  if (!ALLOW_HMR) await page.routeWebSocket(/^wss?:\/\//, () => {});
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__game?.scene === 'function', null, { timeout: 30000 });
  await sleep(1500);

  const cells = [];
  const run = async (fn) => {
    try {
      cells.push(await fn());
    } catch (err) {
      summary.failures.push(String(err?.message ?? err));
    }
  };
  await run(() => sceneNormal(1));
  await run(() => sceneCombo(2));
  await run(() => sceneElement(3, 'explosion', 'explosion (watermelon, molotov)', [['w_watermelon', 2], ['w_yuzu_molotov', 2]], (e) => e.booms));
  await run(() => sceneElement(4, 'fire', 'fire (flame toaster)', [['w_flame_toaster', 2], ['w_flame_toaster', 1]], (e) => e.burning));
  await run(() => sceneElement(5, 'ice', 'ice (bingsu, tuna)', [['w_melon_bingsu', 1], ['w_tuna_missile', 2]], (e) => e.frost + e.chilled));
  await run(() => sceneElement(6, 'lightning', 'lightning (static hairball)', [['w_static_hairball', 3], ['w_static_hairball', 2]], (e) => e.bolts, 9000));
  await run(() => sceneElite(7));
  await run(() => sceneBoss(8));
  if (cells.length) summary.sheet = path.relative(ROOT, await makeSheet(cells));
} catch (err) {
  summary.failures.push(String(err?.stack ?? err));
} finally {
  try {
    await browser?.close();
  } catch {
    /* 무시 */
  }
  stopServer();
}

if (summary.consoleErrors.length) summary.failures.push(`${summary.consoleErrors.length} console error(s)`);
if (summary.pageErrors.length) summary.failures.push(`${summary.pageErrors.length} page error(s)`);
summary.ok = summary.failures.length === 0 && summary.scenes.length === 8;
summary.durationMs = Date.now() - started;
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
