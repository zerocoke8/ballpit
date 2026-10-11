// 폰에서 직접 보는 성능 진단 오버레이 (DOM 캔버스 — Pixi 바깥이라 게임 렌더와 따로 그린다).
//
// 켜기: URL에 ?perf  /  3손가락 탭  /  화면 왼쪽 위 구석을 3초 안에 5번 탭 (같은 동작으로 끔)
// 보이는 것: FPS, 최근 3초 프레임 시간 그래프(16.7 / 33.3 ms 기준선), 끊긴 프레임(> 25 ms) 최근 8개와
//           그 프레임 사이에 일어난 일(태그) — 예: "48ms u12 r30 | toast text 9 upload×2"
//
// 태그 남기기 (어느 모듈에서나):
//   import { perfMark, perfNow } from '../debug/perfOverlay';
//   perfMark('explosion');                       // 이번 프레임에 이 일이 있었다
//   const t0 = perfNow(); doWork(); perfMark('bake', t0);   // 걸린 시간(ms)까지
// 꺼져 있으면 perfMark는 즉시 반환하고 perfNow는 0 — 할당 없음. 태그는 상수 문자열을 쓴다(꺼져 있어도
// 문자열 조합 비용이 생기지 않게). 끊김은 '프레임 시작 → 다음 프레임 시작' 간격으로 판정하고, 그 사이에 찍힌
// 태그(직전 프레임의 update·render + 사이의 입력 이벤트)를 붙인다. 태그 없는 끊김('?')은 대개 JS GC·브라우저·GPU.
//
// 렌더러 계측(항상 설치, 꺼져 있으면 래퍼가 원래 함수만 부른다): 텍스처 GPU 업로드 'upload', 글자 래스터화 'text',
// generateTexture 'bake', 그래픽 지오메트리 재빌드(0.5 ms 이상) 'gfx', 셰이더 컴파일 'shader', pixi GC 'pixiGC'.
import type { Renderer } from 'pixi.js';
import type { GameApp } from '../core/app';

/** 이보다 긴 프레임 간격을 끊김으로 기록 (ms) */
const HITCH_MS = 25;
const HITCH_LOG = 8;
/** 한 프레임에 모아 두는 태그 수 상한 (넘치면 개수만 센다) */
const MAX_TAGS = 24;
/** 프레임 기록 링 버퍼 (120 Hz × 3초도 담기게) */
const RING = 512;
const GRAPH_SECONDS = 3;
const GRAPH_MAX_MS = 50;
/** 오버레이 다시 그리는 간격 (ms) — 오버레이 자체 비용을 낮게 */
const DRAW_INTERVAL = 100;
const W = 250;
const H = 176;
const CORNER_PX = 64;
const CORNER_TAPS = 5;
const CORNER_WINDOW_MS = 3000;

interface Hitch {
  /** 부팅 후 초 */
  t: number;
  /** 프레임 간격 (ms) */
  dt: number;
  /** 직전 프레임의 update / render 시간 (ms) */
  upd: number;
  rnd: number;
  tags: string;
}

export interface PerfReport {
  enabled: boolean;
  fps: number;
  frames: number;
  hitches: Hitch[];
}

// ── 상태 (모듈 단일) ─────────────────────────────────────────

let on = false;
let gameApp: GameApp | null = null;

const tagNames: string[] = new Array<string>(MAX_TAGS).fill('');
const tagMs = new Float32Array(MAX_TAGS);
let tagCount = 0;
let tagOverflow = 0;

const ringDt = new Float32Array(RING);
const ringAt = new Float64Array(RING);
let ringHead = 0;
let ringSize = 0;
let frameCount = 0;

let frameStart = 0;
let lastStart = 0;
let midAt = 0;
let lastUpd = 0;
let lastRnd = 0;
const hitches: Hitch[] = [];

let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let lastDraw = 0;

// ── 공개 API ─────────────────────────────────────────────────

/** 오버레이가 켜져 있으면 performance.now(), 아니면 0 (perfMark의 since 인자용) */
export function perfNow(): number {
  return on ? performance.now() : 0;
}

/** 이번 프레임에 일어난 일을 기록. since(perfNow 값)를 주면 걸린 시간도. 꺼져 있으면 아무것도 안 함 */
export function perfMark(tag: string, since = 0): void {
  if (!on) return;
  if (tagCount >= MAX_TAGS) {
    tagOverflow++;
    return;
  }
  tagNames[tagCount] = tag;
  tagMs[tagCount] = since > 0 ? performance.now() - since : -1;
  tagCount++;
}

export function perfEnabled(): boolean {
  return on;
}

/** 스모크/측정 도구용: 지금까지의 끊김 기록 */
export function perfReport(): PerfReport {
  return { enabled: on, fps: currentFps(), frames: frameCount, hitches: hitches.slice() };
}

/**
 * 부팅 때 한 번: 렌더러 계측 + 켜기 제스처 설치, ?perf면 바로 켠다.
 * 렌더러 계측은 텍스처가 등록되기 전에 걸어야 업로드 이벤트까지 잡히므로 createApp 직후에 부른다.
 */
export function installPerf(app: GameApp): void {
  if (gameApp) return;
  gameApp = app;
  instrumentRenderer(app.app.renderer as Renderer);
  installGestures();
  // 탭이 숨겨졌다 돌아온 간격(화면 잠금 등)은 끊김이 아니다
  document.addEventListener('visibilitychange', () => {
    lastStart = 0;
  });
  const q = new URLSearchParams(window.location.search).get('perf');
  if (q !== null && q !== '0' && q !== 'false') setPerfEnabled(true);
}

export function setPerfEnabled(v: boolean): void {
  if (v === on || !gameApp) return;
  on = v;
  const ticker = gameApp.app.ticker;
  if (on) {
    resetCounters();
    // 우선순위: 맨 처음(프레임 시작) / pixi 렌더(-25) 직전 / 맨 끝(렌더 뒤)
    ticker.add(onFrameStart, null, 1000);
    ticker.add(onBeforeRender, null, -24);
    ticker.add(onFrameEnd, null, -1000);
    showCanvas();
  } else {
    ticker.remove(onFrameStart, null);
    ticker.remove(onBeforeRender, null);
    ticker.remove(onFrameEnd, null);
    hideCanvas();
  }
}

// ── 프레임 계측 ──────────────────────────────────────────────

function resetCounters(): void {
  tagCount = 0;
  tagOverflow = 0;
  ringHead = 0;
  ringSize = 0;
  lastStart = 0;
  hitches.length = 0;
  lastDraw = 0;
}

function onFrameStart(): void {
  const now = performance.now();
  frameStart = now;
  if (lastStart > 0) {
    const dt = now - lastStart;
    ringDt[ringHead] = dt;
    ringAt[ringHead] = now;
    ringHead = (ringHead + 1) % RING;
    if (ringSize < RING) ringSize++;
    frameCount++;
    if (dt > HITCH_MS) recordHitch(now, dt);
  }
  lastStart = now;
  tagCount = 0;
  tagOverflow = 0;
}

function onBeforeRender(): void {
  midAt = performance.now();
}

function onFrameEnd(): void {
  const end = performance.now();
  lastUpd = midAt - frameStart;
  lastRnd = end - midAt;
  if (end - lastDraw >= DRAW_INTERVAL) {
    lastDraw = end;
    draw();
  }
}

function recordHitch(now: number, dt: number): void {
  const h: Hitch = {
    t: Math.round(now / 100) / 10,
    dt: Math.round(dt),
    upd: Math.round(lastUpd * 10) / 10,
    rnd: Math.round(lastRnd * 10) / 10,
    tags: summarizeTags(),
  };
  hitches.push(h);
  if (hitches.length > HITCH_LOG) hitches.shift();
  console.debug(`[perf] hitch ${h.dt}ms (update ${h.upd} / render ${h.rnd}) ${h.tags}`);
}

/**
 * 같은 태그는 묶어서 "text×3 12" (합계 ms가 있으면 붙임). 순서: 시간 없는 표시 태그(무슨 일이었나 — goto, toast …)를
 * 나온 순서대로 먼저, 그다음 시간 있는 태그를 오래 걸린 순서로 — 오버레이의 한 줄(45자)에서 잘려도 가장 비싼 원인이 보이게
 */
function summarizeTags(): string {
  if (tagCount === 0) return tagOverflow > 0 ? `+${tagOverflow}` : '?';
  const order: string[] = [];
  const count = new Map<string, number>();
  const ms = new Map<string, number>();
  for (let i = 0; i < tagCount; i++) {
    const k = tagNames[i];
    if (!count.has(k)) order.push(k);
    count.set(k, (count.get(k) ?? 0) + 1);
    if (tagMs[i] >= 0) ms.set(k, (ms.get(k) ?? 0) + tagMs[i]);
  }
  const marks = order.filter((k) => !ms.has(k));
  const timed = order.filter((k) => ms.has(k)).sort((a, b) => (ms.get(b) ?? 0) - (ms.get(a) ?? 0));
  const parts = [...marks, ...timed].map((k) => {
    const n = count.get(k) ?? 1;
    const t = ms.get(k);
    return `${k}${n > 1 ? `×${n}` : ''}${t !== undefined ? ` ${t < 10 ? t.toFixed(1) : Math.round(t)}` : ''}`;
  });
  if (tagOverflow > 0) parts.push(`+${tagOverflow}`);
  return parts.join(' ');
}

function currentFps(): number {
  if (ringSize < 2) return 0;
  const newest = (ringHead - 1 + RING) % RING;
  const now = ringAt[newest];
  let n = 0;
  let sum = 0;
  for (let i = 0; i < ringSize; i++) {
    const k = (newest - i + RING) % RING;
    if (now - ringAt[k] > 1000) break;
    sum += ringDt[k];
    n++;
  }
  return n > 0 && sum > 0 ? Math.round((n * 1000) / sum) : 0;
}

// ── 렌더러 계측 ──────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown;

/** obj[name]을 감싸 걸린 시간을 tag로 남긴다 (꺼져 있으면 원래 함수만). 없으면 무시 */
function wrapTimed(obj: object | undefined, name: string, tag: string, minMs = 0): void {
  if (!obj) return;
  const target = obj as Record<string, unknown>;
  const orig = target[name];
  if (typeof orig !== 'function') return;
  const fn = orig as AnyFn;
  target[name] = function (this: unknown, ...args: unknown[]): unknown {
    if (!on) return fn.apply(this, args);
    const t0 = performance.now();
    const r = fn.apply(this, args);
    const t = performance.now() - t0;
    if (t >= minMs) perfMark(tag, t0);
    return r;
  };
}

function instrumentRenderer(renderer: Renderer): void {
  const r = renderer as unknown as Record<string, object | undefined>;
  // WebGL 텍스처 업로드 (처음 쓰일 때 + 내용이 바뀔 때). 원본 소스의 이벤트 리스너가 이 속성을 통해 등록되도록 부팅 직후에 감싼다
  wrapTimed(r.texture, 'onSourceUpdate', 'upload');
  wrapTimed(r.canvasText, 'getTexture', 'text');
  wrapTimed(renderer, 'generateTexture', 'bake');
  wrapTimed(r.graphicsContext, 'updateGpuContext', 'gfx', 0.5);
  wrapTimed(r.shader, '_createProgramData', 'shader');
  wrapTimed(r.gc, 'run', 'pixiGC');
}

// ── 켜기/끄기 제스처 ─────────────────────────────────────────

function installGestures(): void {
  let lastToggle = 0;
  const toggle = (): void => {
    const now = performance.now();
    if (now - lastToggle < 700) return;
    lastToggle = now;
    setPerfEnabled(!on);
  };
  window.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length >= 3) toggle();
    },
    { passive: true, capture: true },
  );
  const taps: number[] = [];
  window.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      if (e.clientX > CORNER_PX || e.clientY > CORNER_PX) {
        taps.length = 0;
        return;
      }
      const now = performance.now();
      taps.push(now);
      while (taps.length > 0 && now - taps[0] > CORNER_WINDOW_MS) taps.shift();
      if (taps.length >= CORNER_TAPS) {
        taps.length = 0;
        toggle();
      }
    },
    { passive: true, capture: true },
  );
}

// ── 그리기 ───────────────────────────────────────────────────

function showCanvas(): void {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'perf-overlay';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:fixed',
      'left:calc(4px + env(safe-area-inset-left, 0px))',
      'top:calc(4px + env(safe-area-inset-top, 0px))',
      `width:${W}px`,
      `height:${H}px`,
      'pointer-events:none',
      'z-index:30',
      'border-radius:6px',
    ].join(';');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx2d = canvas.getContext('2d');
    ctx2d?.scale(dpr, dpr);
  }
  if (!canvas.isConnected) document.body.appendChild(canvas);
  draw();
}

function hideCanvas(): void {
  canvas?.remove();
}

function draw(): void {
  const c = ctx2d;
  if (!c || !gameApp) return;
  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(10, 6, 18, 0.78)';
  c.fillRect(0, 0, W, H);

  const renderer = gameApp.app.renderer as unknown as {
    resolution: number;
    texture?: { managedTextures?: unknown[] };
  };
  const fps = currentFps();
  c.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
  c.textBaseline = 'top';
  c.fillStyle = fps >= 55 ? '#7CFF8A' : fps >= 40 ? '#FFD45C' : '#FF6B6B';
  c.fillText(`FPS ${fps}`, 6, 4);
  c.font = '10px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle = '#d8d0e8';
  const tex = renderer.texture?.managedTextures?.length ?? 0;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const heap = mem ? ` heap ${Math.round(mem.usedJSHeapSize / 1048576)}M` : '';
  c.fillText(`u ${lastUpd.toFixed(1)} r ${lastRnd.toFixed(1)} res ${renderer.resolution} tex ${tex}${heap}`, 62, 6);

  // 그래프: 최근 GRAPH_SECONDS초, 0..GRAPH_MAX_MS
  const gx = 6;
  const gy = 20;
  const gw = W - 12;
  const gh = 46;
  const yOf = (ms: number): number => gy + gh - (Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS) * gh;
  c.fillStyle = 'rgba(255,255,255,0.06)';
  c.fillRect(gx, gy, gw, gh);
  c.strokeStyle = 'rgba(124,255,138,0.55)';
  c.beginPath();
  c.moveTo(gx, yOf(16.7));
  c.lineTo(gx + gw, yOf(16.7));
  c.stroke();
  c.strokeStyle = 'rgba(255,212,92,0.55)';
  c.beginPath();
  c.moveTo(gx, yOf(33.3));
  c.lineTo(gx + gw, yOf(33.3));
  c.stroke();
  if (ringSize > 1) {
    const newest = (ringHead - 1 + RING) % RING;
    const now = ringAt[newest];
    const span = GRAPH_SECONDS * 1000;
    // 프레임 시간 꺾은선 + 끊긴 프레임은 빨간 막대
    c.strokeStyle = '#7CFF8A';
    c.lineWidth = 1;
    c.beginPath();
    let started = false;
    for (let i = 0; i < ringSize; i++) {
      const k = (newest - i + RING) % RING;
      const age = now - ringAt[k];
      if (age > span) break;
      const x = gx + gw - (age / span) * gw;
      const y = yOf(ringDt[k]);
      if (started) c.lineTo(x, y);
      else {
        c.moveTo(x, y);
        started = true;
      }
    }
    c.stroke();
    for (let i = 0; i < ringSize; i++) {
      const k = (newest - i + RING) % RING;
      const age = now - ringAt[k];
      if (age > span) break;
      const dt = ringDt[k];
      if (dt <= 18) continue;
      const x = gx + gw - (age / span) * gw;
      const y = yOf(dt);
      c.fillStyle = dt > HITCH_MS ? '#FF6B6B' : '#FFD45C';
      c.fillRect(x - 1, y, 2, gy + gh - y);
    }
  }

  // 끊김 기록 (최근이 위)
  c.fillStyle = '#d8d0e8';
  c.fillText(`hitch > ${HITCH_MS}ms (${hitches.length})`, 6, gy + gh + 4);
  let y = gy + gh + 16;
  c.font = '9px ui-monospace, Menlo, Consolas, monospace';
  for (let i = hitches.length - 1; i >= 0; i--) {
    const h = hitches[i];
    c.fillStyle = h.dt > 50 ? '#FF8E8E' : '#FFD45C';
    const line = `${h.t.toFixed(1)}s ${h.dt}ms u${Math.round(h.upd)} r${Math.round(h.rnd)} ${h.tags}`;
    c.fillText(line.length > 45 ? `${line.slice(0, 44)}…` : line, 6, y);
    y += 10.5;
  }
}
