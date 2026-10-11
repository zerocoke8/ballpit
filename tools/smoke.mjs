// Playwright 스모크 테스트 — 시스템 Edge(없으면 Chrome)로 폰 세로 화면에서 전체 흐름을 한 바퀴 돈다.
//
// 사용법: node tools/smoke.mjs   (npm run smoke)
//   [--port 5210]  자체 개발 서버 포트 (--strictPort)
//   [--headed]     브라우저 창 보이기
//   [--hmr]        Vite HMR 연결 허용 (기본은 막음: 실행 중 파일이 바뀌어도 페이지가 새로고침되지 않게
//                  처음 불러온 코드 그대로 끝까지 검사한다)
//
// 흐름: 타이틀 → (탭) 새 게임 → 캐릭터 선택 → (탭) 카드 + 시작! → 전투(1초·6초 스크린샷, 터치 드래그 이동)
//       → 가방(B) → 닫기(B) → debug.winStage() → 스테이지 클리어 → (탭) 상점으로 → 상점 → toCombat
//       → debug.loseStage() → 결과 → (탭) 타이틀로 → 스트레스(setSpeed(3), 20초 방치)
// 스크린샷: tools/.out/smoke/NN-name.png. stdout 마지막에 JSON 요약.
// 실패(exit 1): 콘솔 에러, 페이지 에러, 단계별 기대 씬(scene())과 다름, 필요한 디버그 훅 없음.
// 개발 서버는 끝날 때(실패 포함) 항상 종료한다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tools', '.out', 'smoke');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(argValue('port', 5210));
const HEADED = args.includes('--headed');
const ALLOW_HMR = args.includes('--hmr');
const BASE_URL = `http://localhost:${PORT}/`;
const VIEWPORT = { width: 390, height: 844 };
const DPR = 2;
const STRESS_SECONDS = 20;
const STRESS_SPEED = 3;

const summary = {
  ok: false,
  url: BASE_URL,
  browser: null,
  hmrMuted: !ALLOW_HMR,
  steps: [],
  consoleErrors: [],
  pageErrors: [],
  ignoredErrors: [],
  failures: [],
  playerMove: null,
  stress: null,
  durationMs: 0,
};
const started = Date.now();

// ── 개발 서버 ────────────────────────────────────────────────

let server = null;
let serverLog = '';

function startServer() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteArgs = ['--port', String(PORT), '--strictPort'];
  // npx vite 와 같지만 npx/셸을 거치지 않아 프로세스 정리가 확실하다
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
  if (process.platform === 'win32' && pid) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
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

// ── 브라우저 ─────────────────────────────────────────────────

async function launchBrowser() {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      const browser = await chromium.launch({ channel, headless: !HEADED });
      summary.browser = channel;
      return browser;
    } catch (err) {
      errors.push(`${channel}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  throw new Error(`system browser launch failed (${errors.join(' | ')})`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 오프라인 등 게임과 무관한 네트워크 오류(웹폰트·favicon)는 무시 목록으로 */
function isIgnorable(text, url) {
  const where = `${url ?? ''} ${text}`;
  return /\/favicon\.ico(\?|$|\s)/.test(where) || /fonts\.(googleapis|gstatic)\.com/.test(where);
}

// ── 메인 ─────────────────────────────────────────────────────

let browser = null;
let page = null;
let stepNo = 0;

function fail(msg) {
  summary.failures.push(msg);
}

async function scene() {
  return page.evaluate(() => window.__game?.scene() ?? '');
}

async function waitScene(expected, timeoutMs = 10000) {
  const want = Array.isArray(expected) ? expected : [expected];
  const deadline = Date.now() + timeoutMs;
  let cur = '';
  while (Date.now() < deadline) {
    cur = await scene();
    if (want.includes(cur)) return cur;
    await sleep(100);
  }
  return cur;
}

/** 단계 기록 + 기대 씬 확인 + 스크린샷 */
async function step(name, expected, { timeoutMs = 10000, settleMs = 0, note } = {}) {
  const want = Array.isArray(expected) ? expected : [expected];
  const cur = await waitScene(want, timeoutMs);
  if (settleMs > 0) await sleep(settleMs);
  const final = await scene();
  const ok = want.includes(final);
  stepNo++;
  const file = path.join(OUT_DIR, `${String(stepNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  const rec = { step: stepNo, name, expected: want.join('|'), scene: final, ok, screenshot: path.relative(ROOT, file) };
  if (note) rec.note = note;
  summary.steps.push(rec);
  if (!ok) fail(`[${name}] expected scene ${want.join('|')} but got '${final || cur}'`);
  return ok;
}

/** 현재 씬에서 이 글자를 가진 Text의 가장 가까운 상호작용 조상(버튼·카드) 가운데 좌표 (CSS px) */
async function findTapTarget(label) {
  return page.evaluate((text) => {
    const root = window.__game?.game.scenes.current;
    if (!root) return null;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.visible === false || node.destroyed) continue;
      if (typeof node.text === 'string' && node.text === text) {
        let target = node;
        while (target && target.eventMode !== 'static' && target !== root) target = target.parent;
        const b = (target && target !== root ? target : node).getBounds();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
      }
      if (node.children) for (const c of node.children) stack.push(c);
    }
    return null;
  }, label);
}

/** 대상이 나타나고 등장 애니메이션(크기 변화)이 끝날 때까지 기다린 뒤 실제 터치 탭 */
async function tapText(label, what, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  let pos = null;
  while (Date.now() < deadline) {
    pos = await findTapTarget(label);
    // 숨쉬기 같은 작은 출렁임(±몇 %)은 허용, 등장 팝(0 → 1)은 끝날 때까지 기다림
    const stable = pos && prev && pos.w > 8 && pos.h > 8 && Math.abs(pos.w - prev.w) / pos.w < 0.06;
    if (stable) break;
    prev = pos;
    await sleep(150);
  }
  if (!pos || pos.w <= 8) {
    fail(`[tap] '${label}' (${what}) not found/visible in ${await scene()}`);
    return false;
  }
  await page.touchscreen.tap(pos.x, pos.y);
  return true;
}

/** CDP 터치 드래그 (Playwright touchscreen은 tap만 지원) */
async function touchDrag(cdp, from, to, steps = 18) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }],
    });
    await sleep(16);
  }
  await sleep(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 전투 씬이 노출하는 플레이어 x (구현에 따라 이름이 달라서 여러 후보를 본다). 없으면 null */
async function playerX() {
  return page.evaluate(() => {
    const s = window.__game?.game.scenes.current;
    if (!s) return null;
    const candidates = [
      () => s.debugState?.().playerX,
      () => s.sim?.player?.x,
      () => s.combat?.player?.x,
      () => s.playerX,
      () => s.player?.x,
    ];
    for (const c of candidates) {
      try {
        const v = c();
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      } catch {
        /* 다음 후보 */
      }
    }
    return null;
  });
}

async function run() {
  if (existsSync(OUT_DIR)) {
    for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.png')) rmSync(path.join(OUT_DIR, f));
  }
  mkdirSync(OUT_DIR, { recursive: true });

  server = startServer();
  await waitForServer();

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
  });
  page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url;
    const text = url ? `${msg.text()} @ ${url}` : msg.text();
    if (isIgnorable(msg.text(), url)) summary.ignoredErrors.push(text);
    else summary.consoleErrors.push(text);
  });
  page.on('pageerror', (err) => summary.pageErrors.push(String(err?.stack ?? err)));
  const cdp = await context.newCDPSession(page);
  if (!ALLOW_HMR) {
    // Vite HMR 웹소켓을 서버에 잇지 않고 열린 척만 → 'full-reload' 메시지가 오지 않는다 (게임은 웹소켓을 쓰지 않음)
    await page.routeWebSocket(/^wss?:\/\//, () => {});
  }

  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__game?.scene === 'function', null, { timeout: 30000 });
  // 이후의 페이지 이동은 Vite HMR 전체 새로고침(누가 파일을 고침) 등 — 흐름이 깨지므로 원인을 남긴다
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) fail(`[reload] page navigated/reloaded mid-run (${frame.url()})${ALLOW_HMR ? ' — Vite HMR full reload while files were being edited?' : ''}`);
  });
  // UI 문자열은 앱과 같은 모듈에서 읽는다 (하드코딩 없이)
  const T = await page.evaluate(async () => {
    const { menu } = (await import('/src/i18n/ko/index.ts')).T;
    return { menu: { newRun: menu.newRun, startRun: menu.startRun, toShop: menu.toShop, viewEnding: menu.viewEnding, toTitle: menu.toTitle } };
  });
  const chars = await page.evaluate(() =>
    Object.values(window.__game.game.data.characters).map((c) => ({ id: c.id, name: c.name })),
  );

  // 1) 타이틀 → 새 게임 (새 컨텍스트라 세이브 없음)
  await step('title', 'TitleScene', { timeoutMs: 20000, settleMs: 2200 });
  await tapText(T.menu.newRun, 'title new game');

  // 2) 캐릭터 선택 → 마지막 캐릭터 카드 탭 → 시작!
  await step('character-select', 'CharacterSelectScene', { settleMs: 1200 });
  const pick = chars[chars.length - 1];
  await tapText(pick.name, `character card ${pick.id}`);
  await sleep(700);
  await step('character-picked', 'CharacterSelectScene');
  await tapText(T.menu.startRun, 'start run');

  // 3) 전투
  await waitScene('CombatScene', 10000);
  const runChar = await page.evaluate(() => window.__game.game.run?.characterId ?? null);
  if (runChar !== pick.id) fail(`[start] run.characterId expected ${pick.id} but got ${runChar}`);
  const tCombat = Date.now();
  await sleep(1000);
  await step('combat-1s', 'CombatScene');

  // 터치 드래그로 플레이어 이동 (화면 아래쪽에서 오른쪽으로)
  const before = await playerX();
  await touchDrag(cdp, { x: VIEWPORT.width * 0.4, y: VIEWPORT.height * 0.72 }, { x: VIEWPORT.width * 0.75, y: VIEWPORT.height * 0.72 });
  await sleep(300);
  const after = await playerX();
  if (before === null || after === null) {
    summary.playerMove = { before, after, verified: false, note: 'CombatScene exposes no player position — screenshot only' };
  } else {
    const moved = Math.abs(after - before) > 1;
    summary.playerMove = { before, after, verified: moved };
    if (!moved) fail(`[drag] player x did not change (${before} → ${after})`);
  }
  await sleep(Math.max(0, 6000 - (Date.now() - tCombat)));
  await step('combat-6s', 'CombatScene');

  // 4) 가방 열기/닫기 (B)
  await page.keyboard.press('b');
  await sleep(700);
  await step('bag-open', 'CombatScene');
  await page.keyboard.press('b');
  await sleep(500);
  await step('bag-closed', 'CombatScene');

  // 5) 승리 → 스테이지 클리어 → (탭) 상점으로
  const won = await page.evaluate(() => window.__game.debug.winStage());
  if (!won) fail('[debug] winStage() not handled by current scene (CombatScene.debugWin missing?)');
  await step('stage-clear', 'StageClearScene', { timeoutMs: 12000, settleMs: 4200 });
  if ((await scene()) === 'StageClearScene') {
    const finished = await page.evaluate(() => window.__game.game.scenes.current?.summary?.finished === true);
    await tapText(finished ? T.menu.viewEnding : T.menu.toShop, 'stage clear proceed');
  }

  // 6) 상점 → 다음 전투
  await step('shop', 'ShopScene', { settleMs: 1200 });
  await page.evaluate(() => {
    window.__game.debug.addGold(50);
    window.__game.debug.addItem('s_fire');
  });
  await sleep(400);
  await step('shop-after-debug-items', 'ShopScene');
  await page.evaluate(() => window.__game.game.toCombat());
  await step('combat-2', 'CombatScene', { settleMs: 1200 });

  // 7) 패배 → 결과 → (탭) 타이틀로
  const lost = await page.evaluate(() => window.__game.debug.loseStage());
  if (!lost) fail('[debug] loseStage() not handled by current scene (CombatScene.debugLose missing?)');
  await step('result', 'ResultScene', { timeoutMs: 12000, settleMs: 2600 });
  if ((await scene()) === 'ResultScene') await tapText(T.menu.toTitle, 'result to title');
  await step('title-again', 'TitleScene', { settleMs: 1500 });
  const saveLeft = await page.evaluate(() => window.__game.game.hasSave());
  if (saveLeft) fail('[result] save should be cleared after the result screen');

  // 8) 스트레스: 빠른 배속으로 방치
  await page.evaluate((id) => window.__game.game.startRun(id), chars[0].id);
  const inCombat = (await waitScene('CombatScene', 10000)) === 'CombatScene';
  if (!inCombat) fail('[stress] could not enter CombatScene');
  await sleep(800);
  const sped = await page.evaluate((mul) => window.__game.debug.setSpeed(mul), STRESS_SPEED);
  if (!sped) fail('[debug] setSpeed() not handled by current scene (CombatScene.setSpeed missing?)');
  const fps = await page.evaluate(async (seconds) => {
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    const start = last;
    await new Promise((resolve) => {
      const tick = (now) => {
        frames++;
        worst = Math.max(worst, now - last);
        last = now;
        if (now - start >= seconds * 1000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { avgFps: Math.round((frames / ((last - start) / 1000)) * 10) / 10, worstFrameMs: Math.round(worst) };
  }, STRESS_SECONDS);
  const stressScene = await scene();
  summary.stress = { seconds: STRESS_SECONDS, speed: STRESS_SPEED, endScene: stressScene, ...fps };
  // 방치하면 지거나(결과) 이길 수도 있다 — 어느 쪽이든 정상 흐름
  await step('stress', ['CombatScene', 'StageClearScene', 'ResultScene']);
  await page.evaluate(() => window.__game.debug.setSpeed(1));

}

let fatal = null;
const cleanup = () => {
  stopServer();
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  await run();
} catch (err) {
  fatal = String(err?.stack ?? err);
  summary.failures.push(`fatal: ${String(err?.message ?? err).split('\n')[0]}`);
  if (page) {
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(OUT_DIR, '99-fatal.png') });
    } catch {
      /* 무시 */
    }
  }
} finally {
  await browser?.close().catch(() => {});
  cleanup();
}

if (summary.consoleErrors.length) summary.failures.push(`${summary.consoleErrors.length} console error(s)`);
if (summary.pageErrors.length) summary.failures.push(`${summary.pageErrors.length} page error(s)`);
summary.ok = summary.failures.length === 0;
summary.durationMs = Date.now() - started;
if (fatal) summary.fatal = fatal;
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(summary.ok ? 0 : 1);
