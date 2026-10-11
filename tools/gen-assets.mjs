#!/usr/bin/env node
// Codex CLI 내장 이미지 생성으로 src/data/assets.json의 에셋을 만들고
// sharp로 트림/리사이즈해 public/assets/<key>.png 에 저장, manifest.json을 갱신한다.
//
// 사용법:
//   node tools/gen-assets.mjs                 # 없는 에셋만 생성
//   node tools/gen-assets.mjs --only a,b      # 지정 키만
//   node tools/gen-assets.mjs --category enemy
//   node tools/gen-assets.mjs --force         # 이미 있어도 다시 생성
//   node tools/gen-assets.mjs --process-only  # Codex 호출 없이 tools/.raw → public/assets 후처리만
//   node tools/gen-assets.mjs --concurrency 4
//
// 전제: `codex login` (ChatGPT 계정) 완료.

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_JSON = path.join(ROOT, 'src/data/assets.json');
const RAW_DIR = path.join(ROOT, 'tools/.raw');
const OUT_DIR = path.join(ROOT, 'public/assets');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

/** 그림체 레퍼런스 (첨부 이미지). 내용이 아니라 스타일만 따라 하게 한다 */
const STYLE_REF = path.join(ROOT, 'tools/style/style_ref.png');

/** 모든 스프라이트 공통 스타일 */
const STYLE =
  'Very simple flat 2D cartoon mobile-game sprite (Capybara Go! / Legend of Slime look): ' +
  'chibi proportions with a big head and small round body, very simple rounded shapes, ' +
  'FLAT solid color fills with at most one soft darker shade tone, NO gradients, NO texture, NO glossy highlights, NO fine detail, ' +
  'clean uniform medium-thick dark brown outline, tiny simple black dot eyes, small pink blush on faces, ' +
  'slightly muted warm pastel palette, cute and goofy. A single subject centered with a little padding around it. ' +
  'NO text, NO letters, NO numbers, NO health bars, NO watermark, NO ground shadow, NO background scenery.';
const STYLE_BG =
  'Very simple flat 2D cartoon mobile-game background (Capybara Go! look): flat solid color fills, minimal detail, ' +
  'few large simple shapes, soft muted warm pastel palette, subtle simple outlines, low contrast so sprites stand out, ' +
  'NO gradients, NO texture noise, NO text, NO letters, NO watermark, NO UI elements.';
const REF_NOTE =
  'An art-style reference image is attached. Match its ART STYLE exactly (flat fills, outline weight and color, dot eyes, ' +
  'chibi proportions, palette, level of simplicity) but do NOT copy its characters, poses, composition, weapons, UI bars or numbers.';

const CODEX_TIMEOUT_MS = 8 * 60 * 1000;

// ── args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FORCE = flag('force');
const PROCESS_ONLY = flag('process-only');
const ONLY = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const CATEGORY = opt('category');
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? 3));

// ── helpers ─────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) return { images: {}, anims: {} };
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return { images: m.images ?? {}, anims: m.anims ?? {} };
  } catch {
    return { images: {}, anims: {} };
  }
}

let manifestLock = Promise.resolve();
function updateManifest(key, file) {
  // 순차 갱신 (동시 쓰기 방지)
  manifestLock = manifestLock.then(() => {
    const m = loadManifest();
    if (file) m.images[key] = file;
    else delete m.images[key];
    const sorted = Object.fromEntries(Object.entries(m.images).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(MANIFEST, JSON.stringify({ images: sorted, anims: m.anims }, null, 2) + '\n');
  });
  return manifestLock;
}

function codexEntry() {
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const js = path.join(npmRoot, '@openai/codex/bin/codex.js');
  if (!existsSync(js)) throw new Error(`codex not found at ${js}. npm i -g @openai/codex`);
  return js;
}

function buildPrompt(a) {
  const file = `${a.key}.png`;
  const ref = existsSync(STYLE_REF) ? [REF_NOTE] : [];
  if (a.opaque) {
    return [
      'Use your built-in image generation tool to generate exactly ONE image.',
      ...ref,
      `Subject: ${a.prompt}`,
      `Style: ${STYLE_BG}`,
      'The image must be fully opaque and fill the whole canvas edge to edge. Use a tall portrait canvas (e.g. 1024x1536).',
      `Then copy the generated PNG into the current working directory as \`${file}\` (overwrite if it exists).`,
      'Do not create or modify any other files. When finished reply with just: DONE',
    ].join('\n');
  }
  return [
    'Use your built-in image generation tool to generate exactly ONE image.',
    ...ref,
    `Subject: ${a.prompt}`,
    `Style: ${STYLE}`,
    'Background: fully transparent (PNG with alpha). Square canvas (1024x1024).',
    `Then copy the generated PNG into the current working directory as \`${file}\` (overwrite if it exists).`,
    'Do not create or modify any other files. When finished reply with just: DONE',
  ].join('\n');
}

function runCodex(entry, a) {
  return new Promise((resolve, reject) => {
    const prompt = buildPrompt(a);
    // -i 는 여러 값을 받으므로 프롬프트(위치 인자) 뒤에 둔다
    const refArgs = existsSync(STYLE_REF) ? ['-i', STYLE_REF] : [];
    const child = spawn(
      process.execPath,
      [entry, 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt, ...refArgs],
      { cwd: RAW_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, CODEX_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(path.join(RAW_DIR, `${a.key}.log`), log);
      if (code === 0) resolve();
      else reject(new Error(`codex exit ${code}`));
    });
  });
}

/** 알파가 없거나 투명 픽셀이 없으면 모서리 색을 flood-fill로 지운다 (폴백) */
async function ensureTransparent(buf) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  if (transparent > W * H * 0.02) return buf; // 이미 투명 배경

  const idx = (x, y) => (y * W + x) * 4;
  const ref = [data[0], data[1], data[2]];
  const TOL = 48;
  const near = (i) =>
    Math.abs(data[i] - ref[0]) + Math.abs(data[i + 1] - ref[1]) + Math.abs(data[i + 2] - ref[2]) <= TOL * 1.5;
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) stack.push(x, y);
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (seen[p]) continue;
    seen[p] = 1;
    const i = idx(x, y);
    if (!near(i)) continue;
    data[i + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function processRaw(a) {
  const raw = path.join(RAW_DIR, `${a.key}.png`);
  const out = path.join(OUT_DIR, `${a.key}.png`);
  if (a.opaque) {
    await sharp(raw)
      .resize(a.w, a.h, { fit: 'cover', position: 'centre' })
      .flatten({ background: a.placeholder?.color ?? '#000000' })
      .png({ compressionLevel: 9 })
      .toFile(out);
  } else {
    const cleaned = await ensureTransparent(readFileSync(raw));
    const trimmed = await sharp(cleaned).trim({ threshold: 1 }).png().toBuffer();
    await sharp(trimmed)
      .resize(a.size, a.size, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: false })
      .toFile(out);
  }
  await updateManifest(a.key, `${a.key}.png`);
}

// ── main ────────────────────────────────────────────────────
async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(MANIFEST)) writeFileSync(MANIFEST, JSON.stringify({ images: {}, anims: {} }, null, 2) + '\n');

  const all = JSON.parse(readFileSync(ASSETS_JSON, 'utf8'));
  let todo = all.filter((a) => (!ONLY || ONLY.includes(a.key)) && (!CATEGORY || a.category === CATEGORY));
  if (!FORCE) todo = todo.filter((a) => !existsSync(path.join(OUT_DIR, `${a.key}.png`)));
  if (ONLY) {
    const unknown = ONLY.filter((k) => !all.some((a) => a.key === k));
    if (unknown.length) console.warn(`unknown keys: ${unknown.join(', ')}`);
  }
  console.log(`[gen-assets] ${todo.length} asset(s) to process (concurrency ${CONCURRENCY})`);
  if (!todo.length) return;

  const entry = PROCESS_ONLY ? null : codexEntry();
  const failed = [];
  let done = 0;
  const queue = [...todo];

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      const raw = path.join(RAW_DIR, `${a.key}.png`);
      const t0 = Date.now();
      try {
        const haveRaw = existsSync(raw) && statSync(raw).size > 0;
        if (!PROCESS_ONLY && (FORCE || !haveRaw)) {
          let lastErr;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await runCodex(entry, a);
              if (!existsSync(raw)) throw new Error('codex finished but no PNG in tools/.raw');
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              console.warn(`  ! ${a.key} attempt ${attempt} failed: ${e.message}`);
            }
          }
          if (lastErr) throw lastErr;
        } else if (!haveRaw) {
          throw new Error('no raw PNG (process-only)');
        }
        await processRaw(a);
        done++;
        console.log(`  ✓ ${a.key} (${((Date.now() - t0) / 1000).toFixed(0)}s) [${done}/${todo.length}]`);
      } catch (e) {
        failed.push(a.key);
        console.error(`  ✗ ${a.key}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  await manifestLock;
  console.log(`[gen-assets] done ${done}/${todo.length}${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
