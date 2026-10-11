// Playwright 스크린샷 도구 (시스템 Edge → Chrome, 브라우저 다운로드 없음).
//
// 사용법:
//   node tools/screenshot.mjs --url http://localhost:5173 --out tools/.out/shot.png
//        [--width 390] [--height 844] [--dpr 2] [--wait 1500]
//        [--clicks "x,y;x,y"]   CSS px, 클릭마다 400ms 대기
//        [--eval "<js>"]        로드+대기 직후(클릭 전) 평가
//        [--eval-after "<js>"]  클릭 후(스크린샷 직전) 평가
//
// stdout: JSON { consoleErrors, pageErrors, evalResult[, evalAfterResult] }
// 페이지 오류가 있어도 exit 0 (판단은 호출자). 브라우저 실행/페이지 이동 자체가 실패하면 exit 1.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://localhost:5173/';
const out = path.resolve(args.out ?? 'tools/.out/shot.png');
const width = Number(args.width ?? 390);
const height = Number(args.height ?? 844);
const dpr = Number(args.dpr ?? 2);
const waitMs = Number(args.wait ?? 1500);
const clicks = (args.clicks ?? '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(',').map(Number))
  .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
const portrait = height > width;

const result = { consoleErrors: [], pageErrors: [], evalResult: null };

async function launch() {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      errors.push(`${channel}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  throw new Error(`system browser launch failed (${errors.join(' | ')})`);
}

async function evaluate(page, code) {
  try {
    return await page.evaluate(code);
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

let browser;
let exitCode = 0;
try {
  browser = await launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    isMobile: portrait,
    hasTouch: portrait,
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = msg.location()?.url;
    // 브라우저가 자동으로 요청하는 favicon 404는 게임과 무관
    if (where && /\/favicon\.ico(\?|$)/.test(where)) return;
    result.consoleErrors.push(where ? `${msg.text()} @ ${where}` : msg.text());
  });
  page.on('pageerror', (err) => result.pageErrors.push(String(err?.stack ?? err)));

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(waitMs);

  if (args.eval) result.evalResult = await evaluate(page, args.eval);

  for (const [x, y] of clicks) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
  }

  if (args['eval-after']) result.evalAfterResult = await evaluate(page, args['eval-after']);

  mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  result.screenshot = out;
} catch (err) {
  result.fatal = String(err?.message ?? err);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(exitCode);
