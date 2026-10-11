// 잠깐 떴다가 위로 떠오르며 사라지는 알림. 같은 부모에 연달아 띄우면 이전 것들을 위로 민다.
//
// 성능: 예전엔 알림마다 한글 Text(Jua, 외곽선, 줄바꿈) + Graphics를 새로 만들어 그 프레임에 캔버스 래스터화 +
// GPU 업로드 + 지오메트리 빌드가 몰렸다 (측정: 아이템 드롭 알림 프레임 최대 26 ms @ CPU 4배 / 47 ms @ 6배 감속).
// 지금은 문구마다 글자를 한 번만 텍스처로 구워(generateTexture) 캐시(LRU, 고정 항목 제외 MAX_ENTRIES)하고,
// 배경은 색마다 한 번 구운 알약 텍스처를 NineSliceSprite로 늘려 쓰며, 스프라이트 묶음은 풀에서 재사용한다
// → 미리 구워 둔 문구는 show()가 스프라이트 두 개 배치 + 트윈뿐.
//
// 사용:
//   Toast.init(gameApp, canBakeInBackground?)   // main.ts, createApp 직후
//   await Toast.prewarm(texts, { colors })      // 부팅 중 (폰트 로드 뒤) — 전투 중 뜨는 문구
//   Toast.queuePrewarm(texts, colors)           // 메뉴에서 쉬는 프레임마다 하나씩 (전투 밖에서만)
//   Toast.show(parent, text, { color, y })      // 예전과 같음
import { Container, Graphics, NineSliceSprite, Rectangle, Sprite, Text, TextStyle, type Texture } from 'pixi.js';
import { DESIGN_MIN_H, DESIGN_W, UI_COLORS } from '../config';
import type { GameApp } from '../core/app';
import { fontsLoaded, fontsSettled } from '../core/fonts';
import { delay, killTweensOf, tween } from '../core/tween';
import { perfMark, perfNow } from '../debug/perfOverlay';
import { shade } from '../render/color';
import { textStyle } from './text';

export interface ToastOptions {
  /** 배경 색 (기본 패널 색) */
  color?: number;
  /** 중심 y (논리 좌표, 기본 화면 중간쯤) */
  y?: number;
}

export interface ToastPrewarmOptions {
  /** 배경 알약도 미리 구울 색들 */
  colors?: readonly number[];
  /** 진행 콜백 (구운 개수, 전체) */
  onProgress?: (done: number, total: number) => void;
  /** 한 번에 이 시간(ms)까지 굽고 다음 프레임으로 넘긴다 */
  budgetMs?: number;
}

const STACK_GAP = 78;
const LABEL_FONT_SIZE = 34;
const LABEL_WRAP = DESIGN_W - 140;
const PAD_X = 64;
const PAD_Y = 30;
/** 배경 알약: 모서리 반지름 · 외곽선 · 그림자 오프셋 (예전 Graphics와 같은 값) */
const RADIUS = 36;
const STROKE = 4;
const SHADOW_Y = 5;
const HALF_STROKE = STROKE / 2;
/** 알약 텍스처 크기: 모서리 둘 + 늘어나는 가운데 2px, 외곽선·그림자 여백 */
const PILL_CORE = RADIUS * 2 + 2;
const PILL_W = PILL_CORE + STROKE;
const PILL_H = PILL_CORE + STROKE + SHADOW_Y;
const SLICE = HALF_STROKE + RADIUS;
/** 고정(미리 굽기) 항목을 뺀 글자 캐시 상한 */
const MAX_ENTRIES = 64;
const MAX_POOL = 8;

interface LabelEntry {
  text: string;
  tex: Texture;
  /** 구운 해상도 */
  res: number;
  /** 폴백 폰트로 구웠음 (Jua가 늦게 오면 다시 굽는다) */
  fallbackFont: boolean;
  pinned: boolean;
}

interface PillEntry {
  tex: Texture;
  res: number;
}

interface ToastView {
  slot: Container;
  body: Container;
  bg: NineSliceSprite;
  label: Sprite;
}

let gameApp: GameApp | null = null;
let canBake: () => boolean = () => true;
/** Map 삽입 순서 = 최근 사용 순서 (사용할 때마다 지웠다 다시 넣음) */
const labels = new Map<string, LabelEntry>();
const pills = new Map<number, PillEntry>();
const pool: ToastView[] = [];
const showing = new Set<ToastView>();
/** 교체됐지만 아직 화면에 쓰일 수 있는 텍스처 (안 쓰이게 되면 파괴) */
const retired: Texture[] = [];
/** 메뉴에서 쉬는 프레임에 구울 것들 (중복 없이: 키 't:문구' / 'c:색') */
const bgQueue: { text?: string; color?: number }[] = [];
const queued = new Set<string>();
let style: TextStyle | null = null;
const active = new WeakMap<Container, Container[]>();

export class Toast {
  /** 렌더러 연결 + 배경 굽기 펌프 설치. canBakeInBackground가 false면(전투 중) 배경 굽기를 쉰다 */
  static init(app: GameApp, canBakeInBackground?: () => boolean): void {
    if (gameApp) return;
    gameApp = app;
    if (canBakeInBackground) canBake = canBakeInBackground;
    app.app.ticker.add(pumpQueue);
    // 부팅 때 폰트가 타임아웃으로 늦었으면, 실제로 도착했을 때 폴백 폰트로 구운 글자를 (메뉴에서) 다시 굽는다
    void fontsSettled().then(() => {
      for (const e of labels.values()) if (e.fallbackFont) enqueue({ text: e.text });
    });
  }

  /**
   * 문구들을 지금 구워 둔다(고정 항목 — LRU에서 밀려나지 않음). 프레임을 넘겨 가며 굽고 끝나면 resolve.
   * 부팅 로딩 중(폰트 로드 뒤) 전투 중에 뜰 수 있는 알림 문구에 쓴다.
   */
  static async prewarm(texts: readonly string[], opts: ToastPrewarmOptions = {}): Promise<void> {
    if (!gameApp) return;
    const colors = opts.colors ?? [];
    const total = texts.length + colors.length;
    const budget = opts.budgetMs ?? 12;
    let done = 0;
    let sliceStart = performance.now();
    const step = async (): Promise<void> => {
      done++;
      opts.onProgress?.(done, total);
      if (performance.now() - sliceStart > budget) {
        await nextFrame();
        sliceStart = performance.now();
      }
    };
    for (const c of colors) {
      pillTexture(c);
      await step();
    }
    for (const t of texts) {
      const e = labelEntry(t);
      if (e) e.pinned = true;
      await step();
    }
  }

  /** 문구·색을 메뉴 화면에서 쉬는 프레임에 하나씩 굽도록 예약 (고정 항목). 전투 중엔 쉰다 */
  static queuePrewarm(texts: readonly string[], colors: readonly number[] = []): void {
    for (const color of colors) enqueue({ color });
    for (const text of texts) enqueue({ text });
  }

  static show(parent: Container, text: string, opts: ToastOptions = {}): void {
    perfMark('toast');
    const color = opts.color ?? UI_COLORS.panelLight;
    // slot: 쌓기 오프셋 담당, body: 등장/퇴장 애니메이션 담당 (같은 y를 두 트윈이 다투지 않게)
    const view = gameApp ? takeView(text, color) : null;
    const slot = view ? view.slot : legacyToast(text, color);
    slot.position.set(DESIGN_W / 2, opts.y ?? Math.round(DESIGN_MIN_H * 0.42));
    const body = slot.children[0] as Container;

    const list = (active.get(parent) ?? []).filter((c) => !c.destroyed);
    for (const other of list) tween(other, { y: other.y - STACK_GAP }, 0.18, 'outQuad');
    list.push(slot);
    active.set(parent, list);

    parent.addChild(slot);
    body.position.set(0, 0);
    body.scale.set(0.6);
    body.alpha = 0;
    void (async () => {
      await Promise.all([tween(body.scale, { x: 1, y: 1 }, 0.25, 'outBack'), tween(body, { alpha: 1 }, 0.12)]);
      await delay(0.9);
      await tween(body, { y: -64, alpha: 0 }, 0.5, 'inQuad');
      const cur = active.get(parent);
      if (cur) active.set(parent, cur.filter((c) => c !== slot));
      if (view) releaseView(view);
      else if (!slot.destroyed) slot.destroy({ children: true, context: true });
    })();
  }

  /** 디버그/측정용: 캐시 상태 */
  static stats(): { labels: number; pinned: number; fallbackFont: number; pills: number; pool: number; showing: number; queued: number } {
    let pinned = 0;
    let fallbackFont = 0;
    for (const e of labels.values()) {
      if (e.pinned) pinned++;
      if (e.fallbackFont) fallbackFont++;
    }
    return { labels: labels.size, pinned, fallbackFont, pills: pills.size, pool: pool.length, showing: showing.size, queued: bgQueue.length };
  }
}

// ── 굽기 ─────────────────────────────────────────────────────

/**
 * 화면 픽셀 기준 해상도: 논리 1px이 실제로 몇 px로 그려지는가 (root 배율 × 렌더 해상도), 0.25 단위 올림, 1..2.
 * 폰(390pt, dpr 3 → 해상도 2): 0.54 × 2 = 1.08 → 1.25. 글자 텍스처를 렌더 해상도(2)로 그리던 예전보다 메모리 ~40%.
 */
function bakeResolution(): number {
  if (!gameApp) return 1;
  const s = Math.abs(gameApp.root.scale.x) * gameApp.app.renderer.resolution;
  const r = Math.ceil(s * 4) / 4;
  return r < 1 ? 1 : r > 2 ? 2 : r;
}

function labelStyle(): TextStyle {
  style ??= new TextStyle(textStyle('heading', { fontSize: LABEL_FONT_SIZE, wordWrap: true, wordWrapWidth: LABEL_WRAP }));
  return style;
}

/** 캐시된 글자 텍스처 (없으면 지금 굽는다). LRU 순서 갱신 */
function labelEntry(text: string): LabelEntry | null {
  if (!gameApp) return null;
  let e = labels.get(text);
  if (e) {
    labels.delete(text);
    labels.set(text, e);
    // 해상도가 바뀌었으면(품질 설정·화면 회전) 지금 것을 그대로 쓰고 메뉴에서 다시 굽는다
    if (e.res !== bakeResolution()) enqueue({ text });
    return e;
  }
  e = { text, tex: bakeLabel(text), res: bakeResolution(), fallbackFont: !fontsLoaded(), pinned: false };
  labels.set(text, e);
  evict();
  return e;
}

function bakeLabel(text: string): Texture {
  const app = gameApp!;
  const t0 = perfNow();
  const res = bakeResolution();
  const label = new Text({ text, style: labelStyle(), resolution: res });
  label.anchor.set(0.5);
  const tex = app.app.renderer.generateTexture({ target: label, resolution: res });
  label.destroy();
  perfMark('toastBake', t0);
  return tex;
}

/** 이미 있는 항목을 지금 해상도·폰트로 다시 굽는다 (메뉴의 쉬는 프레임에서) */
function rebakeLabel(e: LabelEntry): void {
  const old = e.tex;
  e.tex = bakeLabel(e.text);
  e.res = bakeResolution();
  e.fallbackFont = !fontsLoaded();
  retire(old);
}

function pillTexture(color: number): Texture {
  const res = bakeResolution();
  const cached = pills.get(color);
  if (cached && cached.res === res) return cached.tex;
  const app = gameApp!;
  const g = new Graphics()
    .roundRect(HALF_STROKE, HALF_STROKE + SHADOW_Y, PILL_CORE, PILL_CORE, RADIUS)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(HALF_STROKE, HALF_STROKE, PILL_CORE, PILL_CORE, RADIUS)
    .fill({ color, alpha: 0.96 })
    .stroke({ width: STROKE, color: shade(color, 0.55) });
  const tex = app.app.renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, PILL_W, PILL_H),
    resolution: res,
    antialias: true,
  });
  g.destroy();
  if (cached) retire(cached.tex);
  pills.set(color, { tex, res });
  return tex;
}

/** 고정이 아니고 화면에 안 쓰이는 오래된 항목부터 MAX_ENTRIES까지 줄인다 */
function evict(): void {
  let unpinned = 0;
  for (const e of labels.values()) if (!e.pinned) unpinned++;
  if (unpinned <= MAX_ENTRIES) return;
  for (const [key, e] of labels) {
    if (unpinned <= MAX_ENTRIES) break;
    if (e.pinned || inUse(e.tex)) continue;
    labels.delete(key);
    e.tex.destroy(true);
    unpinned--;
  }
}

function inUse(tex: Texture): boolean {
  for (const v of showing) {
    if (v.slot.destroyed) {
      showing.delete(v);
      continue;
    }
    if (v.label.texture === tex || v.bg.texture === tex) return true;
  }
  return false;
}

function retire(tex: Texture): void {
  if (inUse(tex)) retired.push(tex);
  else tex.destroy(true);
}

function flushRetired(): void {
  for (let i = retired.length - 1; i >= 0; i--) {
    if (inUse(retired[i])) continue;
    retired[i].destroy(true);
    retired.splice(i, 1);
  }
}

/** 메뉴 화면에서 프레임당 하나씩 (전투 중엔 쉼) */
function pumpQueue(): void {
  if (bgQueue.length === 0 || !gameApp || !canBake()) return;
  const job = bgQueue.shift()!;
  queued.delete(job.text !== undefined ? `t:${job.text}` : `c:${job.color}`);
  if (job.color !== undefined) {
    pillTexture(job.color);
    return;
  }
  if (job.text === undefined) return;
  const e = labels.get(job.text);
  if (!e) {
    const made = labelEntry(job.text);
    if (made) made.pinned = true;
  } else if (e.res !== bakeResolution() || (e.fallbackFont && fontsLoaded())) {
    rebakeLabel(e);
  }
}

function enqueue(job: { text?: string; color?: number }): void {
  const key = job.text !== undefined ? `t:${job.text}` : `c:${job.color}`;
  if (queued.has(key)) return;
  queued.add(key);
  bgQueue.push(job);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    // 탭이 백그라운드면 rAF가 멈추므로 타이머로도 넘어간다
    const t = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ── 뷰 풀 ────────────────────────────────────────────────────

function takeView(text: string, color: number): ToastView {
  const entry = labelEntry(text)!;
  const pillTex = pillTexture(color);
  let v = pool.pop();
  if (!v || v.slot.destroyed) {
    const slot = new Container();
    slot.eventMode = 'none';
    const body = new Container();
    const bg = new NineSliceSprite({
      texture: pillTex,
      leftWidth: SLICE,
      rightWidth: SLICE,
      topHeight: SLICE,
      bottomHeight: SLICE + SHADOW_Y,
    });
    const label = new Sprite(entry.tex);
    label.anchor.set(0.5);
    body.addChild(bg, label);
    slot.addChild(body);
    v = { slot, body, bg, label };
  }
  // 풀에서 꺼낸 묶음에 이전 알림의 트윈(쌓기 밀어올림 등)이 남아 있으면 끊는다
  killTweensOf(v.slot);
  killTweensOf(v.body);
  killTweensOf(v.body.scale);
  v.label.texture = entry.tex;
  v.bg.texture = pillTex;
  // 크기는 예전 Graphics와 같은 규칙: 폭 = min(화면 - 60, 글자 + 64), 높이 = 글자 + 30 (+ 외곽선·그림자 여백)
  const w = Math.min(DESIGN_W - 60, entry.tex.width + PAD_X);
  const h = entry.tex.height + PAD_Y;
  v.bg.width = w + STROKE;
  v.bg.height = h + STROKE + SHADOW_Y;
  v.bg.position.set(-w / 2 - HALF_STROKE, -h / 2 - HALF_STROKE);
  v.slot.alpha = 1;
  v.slot.y = 0;
  showing.add(v);
  return v;
}

function releaseView(v: ToastView): void {
  showing.delete(v);
  if (v.slot.destroyed) return;
  v.slot.removeFromParent();
  if (pool.length < MAX_POOL) pool.push(v);
  else v.slot.destroy({ children: true });
  if (retired.length > 0) flushRetired();
}

/** init 전(또는 테스트) 대비: 예전 방식 그대로 */
function legacyToast(text: string, color: number): Container {
  const slot = new Container();
  slot.eventMode = 'none';
  const body = new Container();
  slot.addChild(body);
  const label = new Text({ text, style: labelStyle() });
  label.anchor.set(0.5);
  const w = Math.min(DESIGN_W - 60, label.width + PAD_X);
  const h = label.height + PAD_Y;
  const bg = new Graphics()
    .roundRect(-w / 2, -h / 2 + SHADOW_Y, w, h, h / 2)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(-w / 2, -h / 2, w, h, Math.min(h / 2, RADIUS))
    .fill({ color, alpha: 0.96 })
    .stroke({ width: STROKE, color: shade(color, 0.55) });
  body.addChild(bg, label);
  return slot;
}
