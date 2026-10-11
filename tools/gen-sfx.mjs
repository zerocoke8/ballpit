#!/usr/bin/env node
// ElevenLabs 텍스트 → 효과음(sound-generation)으로 src/data/sfx.json의 효과음을 만들어
// public/sfx/<id>_<n>.mp3 (n = 1..variants)에 저장하고 public/sfx/manifest.json ({ id: [파일, ...] })을 갱신한다.
//
// 사용법:
//   node tools/gen-sfx.mjs                     # 없는 클립만 생성 (npm run gen:sfx)
//   node tools/gen-sfx.mjs --dry-run           # API 호출 없이 만들 클립·총 길이·예상 크레딧만 출력
//   node tools/gen-sfx.mjs --only ui_tap,coin  # 지정 id만
//   node tools/gen-sfx.mjs --category hit      # 카테고리만 (ui, fire, hit, enemy, reward, jingle)
//   node tools/gen-sfx.mjs --force             # 이미 있는 클립도 다시 생성 (크레딧 소모!)
//   node tools/gen-sfx.mjs --concurrency 2     # 동시 요청 수 (기본 2)
//   node tools/gen-sfx.mjs --mock              # API 대신 합성 WAV 자리표시(<id>_<n>.wav) — 크레딧 없이 파이프라인 시험
//   node tools/gen-sfx.mjs --no-env-file       # .env 파일을 읽지 않고 process.env만 (실패 경로 시험용)
//   node tools/gen-sfx.mjs --budget 600        # 총 크레딧이 이만큼 넘을 것 같으면 새 요청을 멈춤
//   node tools/gen-sfx.mjs --max-rate 25       # 몇 클립 뒤 초당 크레딧이 이보다 높으면 멈춤 (기본 25, 측정값 약 10)
//   node tools/gen-sfx.mjs --out <dir>         # 출력 폴더 (기본 public/sfx) — 시험용
//   node tools/gen-sfx.mjs --api-base <url>    # API 주소 (시험용 가짜 서버). 공식 주소가 아니면 .env를 읽지 않는다
//   node tools/gen-sfx.mjs --env-file <path>   # .env 대신 이 파일에서 키를 읽음 (시험용 — 가짜 서버와 함께 써도 읽는다)
//
// 키: process.env.ELEVENLABS_API_KEY 또는 프로젝트 .env 파일의 ELEVENLABS_API_KEY (UTF-8·BOM·UTF-16 모두 읽음).
// 키는 절대 출력하지 않는다 — 서버가 오류 본문에 키를 되돌려 보내도 출력 전에 가린다.
// 만들 클립이 있는데 키가 없으면 API를 부르기 전에 한국어+영어 안내와 함께 종료 코드 1 (기존 클립 그대로).
// 안전한 쓰기: 임시 파일로 받고 성공했을 때만 rename. 실패한 실행은 기존 파일·manifest 항목을 건드리지 않는다.
// 비용: 응답 헤더 'character-cost'를 더해 마지막에 출력한다.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SFX_JSON = path.join(ROOT, 'src/data/sfx.json');
const OFFICIAL_API = 'https://api.elevenlabs.io';
const MODEL_ID = 'eleven_text_to_sound_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
/** API가 받는 길이 범위(초) */
const MIN_DURATION = 0.5;
const MAX_DURATION = 22;
/** 측정값: 0.5초 요청 = 5 크레딧 → 초당 약 10 (예상치 표시용) */
const EXPECTED_CREDITS_PER_SEC = 10;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 4;
/** 이만큼 클립이 끝난 뒤부터 초당 크레딧 감시 */
const RATE_CHECK_AFTER = 3;
const CATEGORIES = ['ui', 'fire', 'hit', 'enemy', 'reward', 'jingle'];

// ── 인자 ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

if (flag('help') || flag('h')) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const FORCE = flag('force');
const DRY_RUN = flag('dry-run');
const MOCK = flag('mock');
const NO_ENV_FILE = flag('no-env-file');
const ONLY = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const CATEGORY = opt('category') ?? null;
const CONCURRENCY = Math.max(1, Math.min(8, Number(opt('concurrency') ?? 2) || 2));
const BUDGET = opt('budget') !== undefined ? Number(opt('budget')) : null;
const MAX_RATE = Number(opt('max-rate') ?? 25) || 25;
const OUT_DIR = path.resolve(ROOT, opt('out') ?? 'public/sfx');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const API_BASE = (opt('api-base') ?? OFFICIAL_API).replace(/\/+$/, '');
const OFFICIAL = API_BASE === OFFICIAL_API;
/** 직접 지정한 키 파일 (시험용) — 없으면 프로젝트 .env */
const EXPLICIT_ENV_FILE = opt('env-file') !== undefined ? path.resolve(opt('env-file')) : null;
const ENV_FILE = EXPLICIT_ENV_FILE ?? path.join(ROOT, '.env');

// ── 키 가리기: 이 프로세스가 출력하는 모든 문자열에서 키를 *** 로 바꾼다 (서버 오류 본문·예외 메시지가 키를 담고 있어도) ──
let SECRET = '';
const redact = (v) => (SECRET.length >= 6 && typeof v === 'string' ? v.split(SECRET).join('***') : v);
for (const m of ['log', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => orig(...a.map(redact));
}

function die(msg, code = 2) {
  console.error(`\n[gen-sfx] ${msg}`);
  process.exit(code);
}

for (const name of ['only', 'category', 'concurrency', 'budget', 'max-rate', 'out', 'api-base', 'env-file']) {
  if (flag(name) && opt(name) === undefined) die(`--${name} 뒤에 값이 필요합니다`);
}
if (MOCK && DRY_RUN) die('--mock 과 --dry-run 은 함께 쓸 수 없습니다');
if (CATEGORY && !CATEGORIES.includes(CATEGORY)) die(`모르는 카테고리 '${CATEGORY}' (가능: ${CATEGORIES.join(', ')})`);
if (BUDGET !== null && !(BUDGET > 0)) die('--budget 은 양수여야 합니다');

// ── 데이터 ──────────────────────────────────────────────────

const defs = JSON.parse(readFileSync(SFX_JSON, 'utf8'));
const byId = new Map(defs.map((d) => [d.id, d]));
if (ONLY) {
  const unknown = ONLY.filter((id) => !byId.has(id));
  if (unknown.length) die(`sfx.json에 없는 id: ${unknown.join(', ')}`);
}

const selected = defs.filter((d) => (!ONLY || ONLY.includes(d.id)) && (!CATEGORY || d.category === CATEGORY));
if (selected.length === 0) die('조건에 맞는 효과음이 없습니다', 1);

const ext = MOCK ? 'wav' : 'mp3';
/** 클립 = (def, n) */
const clips = [];
for (const d of selected) {
  const variants = Math.max(1, Math.floor(d.variants ?? 1));
  for (let n = 1; n <= variants; n++) {
    const file = `${d.id}_${n}.${ext}`;
    const dest = path.join(OUT_DIR, file);
    const exists = existsSync(dest) && statSync(dest).size > 0;
    clips.push({ def: d, n, file, dest, exists, duration: clampDuration(d.duration) });
  }
}
const todo = clips.filter((c) => FORCE || !c.exists);

function clampDuration(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v)) return MIN_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, v));
}

const fmtSec = (s) => `${s.toFixed(2)}s`;
const totalSec = (list) => list.reduce((a, c) => a + c.duration, 0);

// ── manifest ────────────────────────────────────────────────

function readManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    // BOM(Windows 편집기·PowerShell이 붙임)은 떼고 읽는다
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    console.warn(`[gen-sfx] manifest.json을 읽지 못함 — 이번 실행에서 다시 만든다 (원본은 manifest.json.bak으로 보관)`);
    try {
      writeAtomic(`${MANIFEST}.bak`, readFileSync(MANIFEST));
    } catch {
      /* 무시 */
    }
    return {};
  }
}

/** 이번 실행이 다룬 id들의 항목만 디스크 상태로 다시 계산하고 나머지는 그대로 (정렬해서 원자적으로 저장) */
function updateManifest(ids) {
  const manifest = readManifest();
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) continue;
    const prev = Array.isArray(manifest[id]) ? manifest[id] : [];
    const files = [];
    for (let n = 1; n <= Math.max(1, Math.floor(d.variants ?? 1)); n++) {
      const mine = `${id}_${n}.${ext}`;
      const old = prev[n - 1];
      if (isFile(mine)) files.push(mine);
      else if (typeof old === 'string' && isFile(old)) files.push(old);
    }
    if (files.length > 0) manifest[id] = [...new Set(files)];
    else if (prev.some((f) => typeof f === 'string' && isFile(f))) manifest[id] = prev.filter((f) => typeof f === 'string' && isFile(f));
    else delete manifest[id];
  }
  const sorted = {};
  for (const k of Object.keys(manifest).sort()) sorted[k] = manifest[k];
  mkdirSync(OUT_DIR, { recursive: true });
  writeAtomic(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

function isFile(rel) {
  const p = path.join(OUT_DIR, rel);
  try {
    return statSync(p).isFile() && statSync(p).size > 0;
  } catch {
    return false;
  }
}

let tmpSeq = 0;
/** 임시 파일에 다 쓴 뒤 rename — 중간에 실패해도 기존 파일은 그대로 */
function writeAtomic(dest, data) {
  const tmp = `${dest}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    writeFileSync(tmp, data);
    renameRetry(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 없음 */
    }
    throw err;
  }
}

/**
 * Windows에서는 대상 파일을 다른 프로세스(개발 서버 감시·백신·검색 색인)가 잠깐 열고 있으면 rename이 EPERM/EBUSY로 실패한다
 * (실제로 manifest.json에서 한 번 났다) → 잠깐씩 기다리며 몇 번 더 해 본다
 */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

/** manifest 갱신 실패는 실행 전체를 멈추지 않는다 (클립 파일은 이미 안전하게 저장됨 — 다음 실행이 디스크 상태로 다시 맞춘다) */
function tryUpdateManifest(ids) {
  try {
    updateManifest(ids);
    return true;
  } catch (err) {
    console.warn(`  ! manifest.json 갱신 실패 (${String(err?.code ?? err?.message ?? err)}) — 'node tools/gen-sfx.mjs'를 다시 실행하면 API 호출 없이 맞춘다`);
    return false;
  }
}

/** 예전 실행이 남긴 임시 파일 정리 (정상 파일은 건드리지 않음) */
function cleanStaleTemps() {
  if (!existsSync(OUT_DIR)) return;
  for (const f of readdirSync(OUT_DIR)) {
    if (/\.tmp-\d+-\d+$/.test(f)) {
      try {
        unlinkSync(path.join(OUT_DIR, f));
      } catch {
        /* 사용 중이면 둔다 */
      }
    }
  }
}

// ── 키 ─────────────────────────────────────────────────────

/**
 * 키 파일을 문자열로. Windows 메모장은 'UTF-8(BOM)', PowerShell 5.1의 `echo ... > .env`는 UTF-16(BOM)으로 저장한다 —
 * 그대로 utf8로 읽으면 첫 줄이 깨져 '키가 없습니다'가 된다
 */
function readTextFile(file) {
  const buf = readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

/**
 * 키를 읽는다 (출력하지 않음). process.env 우선, 없으면 .env
 * (--no-env-file이면 안 읽음. 시험용 API 주소면 프로젝트 .env는 안 읽고 --env-file로 직접 지정한 파일만)
 */
function readKey() {
  const fromEnv = (process.env.ELEVENLABS_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (NO_ENV_FILE || (!OFFICIAL && !EXPLICIT_ENV_FILE) || !existsSync(ENV_FILE)) return '';
  for (const raw of readTextFile(ENV_FILE).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return v.trim();
  }
  return '';
}

// ── ElevenLabs ──────────────────────────────────────────────

class FatalError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 응답 본문에서 사람이 읽을 메시지만 (짧게) */
async function errorDetail(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const d = j?.detail;
      if (typeof d === 'string') return d.slice(0, 300);
      if (d && typeof d === 'object') return `${d.status ?? ''} ${d.message ?? JSON.stringify(d)}`.trim().slice(0, 300);
      return JSON.stringify(j).slice(0, 300);
    } catch {
      return text.replace(/\s+/g, ' ').slice(0, 200);
    }
  } catch {
    return '';
  }
}

function looksLikeMp3(buf) {
  if (buf.length < 512) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // 'ID3'
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0; // 프레임 동기
}

/** 한 클립 요청 (재시도 포함). 성공하면 { bytes, cost } */
async function requestClip(key, clip) {
  const body = JSON.stringify({
    text: clip.def.prompt,
    duration_seconds: clip.duration,
    prompt_influence: Math.min(1, Math.max(0, Number(clip.def.influence ?? 0.3))),
    model_id: MODEL_ID,
  });
  let lastErr = '';
  /** 서버가 Retry-After로 알려 준 대기(ms) — 지수 백오프와 더하지 않고 둘 중 긴 쪽만 기다린다 */
  let retryAfterMs = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      const wait = Math.max(backoff, retryAfterMs);
      retryAfterMs = 0;
      console.log(`      … ${clip.file} 재시도 ${attempt}/${MAX_RETRIES} (${(wait / 1000).toFixed(1)}초 뒤): ${lastErr}`);
      await sleep(wait);
    }
    let res;
    try {
      res = await fetch(`${API_BASE}/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = `네트워크 오류 (${err?.name === 'TimeoutError' ? '시간 초과' : String(err?.message ?? err).split('\n')[0]})`;
      continue;
    }
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      // 다른 클립도 같은 이유로 실패한다 (키·크레딧·요금제) → 바로 멈춤
      const detail = await errorDetail(res);
      if (/quota|credit/i.test(detail)) throw new FatalError(`크레딧이 부족합니다 (${res.status}): ${detail}`);
      if (res.status === 402) throw new FatalError(`요금제에서 쓸 수 없는 요청입니다 (402): ${detail}`);
      throw new FatalError(
        `ElevenLabs가 키를 거부했습니다 (${res.status}). .env의 ELEVENLABS_API_KEY를 확인하세요. / ElevenLabs rejected the API key (${res.status}); check ELEVENLABS_API_KEY in .env. ${detail}`,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status} ${await errorDetail(res)}`.trim();
      const ra = Number(res.headers.get('retry-after'));
      retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(60, ra) * 1000 : 0;
      continue;
    }
    if (!res.ok) {
      // 400/422 등: 다시 해도 같다
      return { error: `HTTP ${res.status} ${await errorDetail(res)}`.trim() };
    }
    // 200 응답은 이미 크레딧이 나갔을 수 있다 → 본문이 이상해도 다시 요청하지 않고 실패로 보고 (--only로 직접 다시)
    const costHeader = res.headers.get('character-cost');
    const cost = costHeader !== null && Number.isFinite(Number(costHeader)) ? Number(costHeader) : null;
    let bytes;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return { error: `본문 받기 실패 (${String(err?.message ?? err).split('\n')[0]})`, cost };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!looksLikeMp3(bytes) || (type && !/audio|octet-stream/i.test(type))) {
      return { error: `MP3가 아닌 응답 (${type || '형식 없음'}, ${bytes.length} B)`, cost };
    }
    return { bytes, cost };
  }
  return { error: `재시도 ${MAX_RETRIES}번 모두 실패: ${lastErr}` };
}

// ── 자리표시 WAV (--mock) ──────────────────────────────────

/** 16비트 PCM 모노 WAV */
function wavBytes(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 모노
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** 카테고리마다 다른 소리(음높이·엔벨로프), id·변형마다 음높이가 조금씩 다름. 앞뒤에 무음(자르기 시험용) */
function mockSamples(def, n) {
  const sr = 22050;
  const h = createHash('sha1').update(def.id).digest();
  const k = 1 + ((h[0] % 7) - 3) * 0.06 + (n - 1) * 0.08;
  let seed = h.readUInt32LE(1) ^ n;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const lead = 0.06;
  const tail = 0.12;
  const body = Math.min(Math.max(0.1, clampDuration(def.duration) - lead - tail), def.category === 'jingle' ? 1.2 : 0.35);
  const out = new Float32Array(Math.round((lead + body + tail) * sr));
  const off = Math.round(lead * sr);
  const len = Math.round(body * sr);
  let lp = 0;
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const u = i / len;
    let v = 0;
    switch (def.category) {
      case 'ui': {
        const f = 900 * k;
        v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 28);
        break;
      }
      case 'fire': {
        lp += (noise() - lp) * (0.15 + 0.2 * (1 - u));
        const f = (420 - 220 * u) * k;
        phase += (2 * Math.PI * f) / sr;
        v = (lp * 1.6 + Math.sin(phase) * 0.35) * Math.sin(Math.PI * u) ** 0.6;
        break;
      }
      case 'hit': {
        const f = (170 - 110 * u) * k;
        phase += (2 * Math.PI * f) / sr;
        v = (Math.sin(phase) + (i < sr * 0.01 ? noise() * 0.6 : 0)) * Math.exp(-t * 18);
        break;
      }
      case 'enemy': {
        const f = 330 * k;
        v = (Math.sin(2 * Math.PI * f * t) > 0 ? 0.6 : -0.6) * Math.exp(-t * 14);
        break;
      }
      case 'reward': {
        const f = 1320 * k;
        v = (Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 1.5 * t) * 0.4) * Math.exp(-t * 12);
        break;
      }
      default: {
        // jingle: 도-미-솔-도 아르페지오
        const notes = [523.25, 659.25, 783.99, 1046.5];
        const step = Math.min(notes.length - 1, Math.floor(u * notes.length));
        const tl = t - (step * body) / notes.length;
        v = Math.sin(2 * Math.PI * notes[step] * k * t) * Math.exp(-tl * 6) * 0.8;
      }
    }
    out[off + i] = v * 0.55;
  }
  return { samples: out, sampleRate: sr };
}

// ── 실행 ────────────────────────────────────────────────────

function printPlan() {
  const sec = totalSec(todo);
  console.log(`[gen-sfx] ${MOCK ? '자리표시 WAV(--mock)' : DRY_RUN ? '미리보기(--dry-run, API 호출 없음)' : 'ElevenLabs 생성'} → ${path.relative(ROOT, OUT_DIR) || '.'}`);
  console.log(`  대상 ${selected.length}개 id, 클립 ${clips.length}개 (${fmtSec(totalSec(clips))}) · 이미 있음 ${clips.filter((c) => c.exists).length}개${FORCE ? ' (--force: 다시 생성)' : ''}`);
  if (DRY_RUN) {
    for (const c of clips) {
      const state = FORCE || !c.exists ? 'make' : 'skip';
      console.log(`  ${state}  ${c.file.padEnd(28)} ${c.def.category.padEnd(7)} ${fmtSec(c.duration).padStart(6)}${c.duration !== Number(c.def.duration) ? ` (sfx.json ${c.def.duration}s → API 하한/상한)` : ''}`);
    }
  }
  console.log(`  만들 클립 ${todo.length}개, 총 ${fmtSec(sec)}${MOCK ? '' : ` · 예상 약 ${Math.round(sec * EXPECTED_CREDITS_PER_SEC)} 크레딧 (측정값 초당 ~${EXPECTED_CREDITS_PER_SEC})`}`);
}

async function main() {
  printPlan();
  if (DRY_RUN) return 0;
  if (todo.length === 0) {
    const ok = tryUpdateManifest(selected.map((d) => d.id));
    console.log('[gen-sfx] 만들 것이 없습니다 (manifest만 맞춤)');
    return ok ? 0 : 1;
  }

  if (MOCK) {
    mkdirSync(OUT_DIR, { recursive: true });
    cleanStaleTemps();
    for (const c of todo) {
      const { samples, sampleRate } = mockSamples(c.def, c.n);
      writeAtomic(c.dest, wavBytes(samples, sampleRate));
      console.log(`  ok    ${c.file}`);
    }
    const ok = tryUpdateManifest(selected.map((d) => d.id));
    console.log(`[gen-sfx] 자리표시 ${todo.length}개 작성${ok ? ', manifest 갱신' : ''}`);
    return ok ? 0 : 1;
  }

  const key = readKey();
  SECRET = key;
  if (!key) {
    // 한국어 + 영어 (영어 오류 검색·공유용). API를 부르기 전이라 크레딧·기존 파일 모두 그대로 — 종료 코드 1
    die(
      (NO_ENV_FILE || !OFFICIAL
        ? 'ELEVENLABS_API_KEY 환경 변수가 비어 있습니다 (--no-env-file / 시험용 API 주소에서는 .env를 읽지 않음).\n' +
          '[gen-sfx] ELEVENLABS_API_KEY is empty (.env is not read with --no-env-file or a test --api-base).'
        : 'ELEVENLABS_API_KEY가 없습니다. .env.example을 .env로 복사하고 키를 넣으세요.\n' +
          '[gen-sfx] ELEVENLABS_API_KEY not found. Copy .env.example to .env and put your key in it.') +
        '\n[gen-sfx] API를 부르지 않았고 기존 클립은 그대로입니다. / No API call was made; existing clips are untouched.',
      1,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  cleanStaleTemps();

  const results = { ok: [], failed: [], cost: 0, costKnown: 0, seconds: 0 };
  let next = 0;
  let stop = null;
  /** 동시에 나가 있는 요청들의 예상 비용 — 예산 판정에 넣지 않으면 동시 요청 수만큼 예산을 넘는다 */
  let inflight = 0;

  const worker = async () => {
    while (!stop && next < todo.length) {
      const c = todo[next++];
      const expected = c.duration * EXPECTED_CREDITS_PER_SEC;
      if (BUDGET !== null && results.cost + inflight + expected > BUDGET) {
        stop = `예산 ${BUDGET} 크레딧에 닿을 것 같아 멈춤 (지금까지 ${results.cost})`;
        break;
      }
      inflight += expected;
      let r;
      try {
        r = await requestClip(key, c);
      } catch (err) {
        if (err instanceof FatalError) {
          stop = err.message;
          results.failed.push({ clip: c, error: err.message });
          break;
        }
        r = { error: String(err?.message ?? err).split('\n')[0] };
      } finally {
        inflight -= expected;
      }
      // 실패한 응답도 크레딧이 나갔으면(200인데 본문이 이상함) 비용에 넣는다
      if (typeof r.cost === 'number') {
        results.cost += r.cost;
        results.costKnown++;
        results.seconds += c.duration;
      }
      if (r.error) {
        results.failed.push({ clip: c, error: r.error });
        console.log(`  FAIL  ${c.file.padEnd(28)} ${r.error}`);
        continue;
      }
      try {
        writeAtomic(c.dest, r.bytes);
      } catch (err) {
        results.failed.push({ clip: c, error: `저장 실패: ${String(err?.message ?? err).split('\n')[0]}` });
        continue;
      }
      results.ok.push(c);
      tryUpdateManifest([c.def.id]);
      console.log(
        `  ok    ${c.file.padEnd(28)} ${fmtSec(c.duration).padStart(6)}  ${String(r.cost ?? '?').padStart(4)} cr  ${(r.bytes.length / 1024).toFixed(1).padStart(6)} KB   (누계 ${results.cost} cr)`,
      );
      // 비용 감시: 몇 클립 뒤에도 초당 크레딧이 예상보다 훨씬 높으면 멈춘다
      if (results.costKnown >= RATE_CHECK_AFTER && results.seconds > 0) {
        const rate = results.cost / results.seconds;
        if (rate > MAX_RATE) stop = `초당 ${rate.toFixed(1)} 크레딧 — --max-rate ${MAX_RATE}보다 높아 멈춤 (예상 ~${EXPECTED_CREDITS_PER_SEC})`;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  const manifestOk = tryUpdateManifest(selected.map((d) => d.id));

  const notTried = todo.length - results.ok.length - results.failed.length;
  console.log('\n[gen-sfx] 결과');
  console.log(`  성공 ${results.ok.length} · 실패 ${results.failed.length} · 안 함 ${notTried} · 건너뜀(이미 있음) ${clips.length - todo.length}`);
  console.log(
    `  비용(character-cost 합): ${results.cost} 크레딧${results.costKnown < results.ok.length ? ` (비용 헤더 없는 응답 있음)` : ''}` +
      (results.seconds > 0 ? ` · 요청 길이 ${fmtSec(results.seconds)} · 초당 ${(results.cost / results.seconds).toFixed(1)}` : ''),
  );
  if (stop) console.log(`  멈춘 이유: ${stop}`);
  if (results.failed.length > 0) {
    const ids = [...new Set(results.failed.map((f) => f.clip.def.id))];
    for (const f of results.failed) console.log(`  - ${f.clip.file}: ${f.error}`);
    console.log(`  실패한 것만 다시: node tools/gen-sfx.mjs --only ${ids.join(',')}`);
  }
  if (!manifestOk) console.log('  manifest.json을 마지막에 갱신하지 못했습니다 — 다시 실행하면 API 호출 없이 맞춥니다');
  return results.failed.length > 0 || stop || !manifestOk ? 1 : 0;
}

// 끝낼 때 process.exit()를 부르지 않는다 — Windows에서 fetch(undici) 연결이 열린 채 exit하면 libuv assert로 죽는다(exit 127).
// exitCode만 정하고 열린 연결이 닫히면 저절로 끝난다.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('[gen-sfx] 예기치 못한 오류:', String(err?.stack ?? err).split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  },
);
