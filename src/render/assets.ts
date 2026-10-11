// 에셋 로드: manifest의 PNG/스프라이트시트 + 아트가 없는 키는 플레이스홀더(도형 + 이모지) 생성.
import { Assets, Container, Graphics, Rectangle, Text, Texture, type Renderer, type Spritesheet } from 'pixi.js';
import ASSETS_JSON from '../data/assets.json';
import type { AnimState, AssetDef, AssetManifest } from '../types';
import { lighten, mixColor, parseHex, shade } from './color';

export interface AnimFrames {
  frames: Texture[];
  fps: number;
  loop: boolean;
}

const ASSET_DEFS = ASSETS_JSON as unknown as AssetDef[];
const ANIM_STATES: readonly AnimState[] = ['idle', 'move', 'attack', 'hit', 'die'];
const EMOJI_FONT = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif";
/** 플레이스홀더 텍스처 최대 픽셀 변 (메모리 절약) */
const PLACEHOLDER_MAX_PX = 512;
const DEFAULT_FPS = 12;

const textures = new Map<string, Texture>();
const art = new Set<string>();
const anims = new Map<string, Partial<Record<AnimState, AnimFrames>>>();
const warned = new Set<string>();
let missingTexture: Texture | null = null;
let loaded: Promise<void> | null = null;

/** assets.json 전체 (등록 순서) */
export function assetDefs(): readonly AssetDef[] {
  return ASSET_DEFS;
}

export function loadAssets(renderer: Renderer): Promise<void> {
  if (!loaded) loaded = doLoad(renderer);
  return loaded;
}

async function doLoad(renderer: Renderer): Promise<void> {
  missingTexture = makeMissingTexture(renderer);
  const manifest = await fetchManifest();

  await Promise.all(
    ASSET_DEFS.map(async (def) => {
      const rel = manifest.images[def.key];
      if (rel) {
        try {
          const t = await Assets.load<Texture>(assetUrl(rel));
          if (t instanceof Texture) {
            textures.set(def.key, t);
            art.add(def.key);
            return;
          }
        } catch (err) {
          console.warn(`[assets] ${def.key} 이미지 로드 실패 → 플레이스홀더`, err);
        }
      }
      textures.set(def.key, makePlaceholder(renderer, def));
    }),
  );

  const jobs: Promise<void>[] = [];
  for (const [key, states] of Object.entries(manifest.anims)) {
    if (!isRecord(states)) continue;
    for (const state of ANIM_STATES) {
      const spec = (states as Record<string, unknown>)[state];
      if (!isRecord(spec) || typeof spec.sheet !== 'string') continue;
      const fps = typeof spec.fps === 'number' && spec.fps > 0 ? spec.fps : DEFAULT_FPS;
      const loop = typeof spec.loop === 'boolean' ? spec.loop : state === 'idle' || state === 'move';
      const sheetPath = spec.sheet;
      jobs.push(
        (async () => {
          try {
            const sheet = await Assets.load<Spritesheet>(assetUrl(sheetPath));
            const frames = sheetFrames(sheet, state);
            if (frames.length === 0) return;
            let entry = anims.get(key);
            if (!entry) anims.set(key, (entry = {}));
            entry[state] = { frames, fps, loop };
          } catch (err) {
            console.warn(`[assets] ${key}.${state} 스프라이트시트 로드 실패`, err);
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
}

/** 미등록 키는 경고 1회 + 마젠타 '?' 텍스처 */
export function tex(key: string): Texture {
  const t = textures.get(key);
  if (t) return t;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[assets] 알 수 없는 에셋 키: ${key}`);
  }
  return missingTexture ?? Texture.WHITE;
}

export function animFrames(key: string, state: AnimState): AnimFrames | null {
  return anims.get(key)?.[state] ?? null;
}

/** 실제 PNG가 있는지(플레이스홀더 아님) */
export function hasArt(key: string): boolean {
  return art.has(key);
}

/** 로드된 모든 텍스처 (에셋 키 + 애니메이션 프레임 + '?' 텍스처). GPU 미리 올리기용 (render/gpuWarm.ts) */
export function loadedTextures(): Texture[] {
  const out: Texture[] = [...textures.values()];
  for (const entry of anims.values()) {
    for (const st of ANIM_STATES) {
      const a = entry[st];
      if (a) out.push(...a.frames);
    }
  }
  if (missingTexture) out.push(missingTexture);
  return out;
}

// ─────────────────────────────────────────────────────────────

function assetUrl(rel: string): string {
  return new URL(`assets/${rel}`, document.baseURI).href;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function fetchManifest(): Promise<AssetManifest> {
  const empty: AssetManifest = { images: {}, anims: {} };
  try {
    const res = await fetch(assetUrl('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return empty;
    const json: unknown = await res.json();
    if (!isRecord(json)) return empty;
    const images: Record<string, string> = {};
    if (isRecord(json.images)) {
      for (const [k, v] of Object.entries(json.images)) if (typeof v === 'string' && v) images[k] = v;
    }
    const animsJson = isRecord(json.anims) ? (json.anims as AssetManifest['anims']) : {};
    return { images, anims: animsJson };
  } catch {
    // 없거나(개발 서버는 index.html을 돌려줌) 깨진 manifest → 전부 플레이스홀더
    return empty;
  }
}

/** 시트의 프레임: 상태 이름 애니메이션 → 첫 애니메이션 → 프레임 이름 자연 정렬 */
function sheetFrames(sheet: Spritesheet, state: AnimState): Texture[] {
  const animations = (sheet.animations ?? {}) as Record<string, Texture[]>;
  if (animations[state]?.length) return animations[state];
  const first = Object.values(animations).find((a) => a.length > 0);
  if (first) return first;
  const frameTextures = sheet.textures as Record<string, Texture>;
  return Object.keys(frameTextures)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((k) => frameTextures[k]);
}

function emojiText(emoji: string, fontSize: number, resolution: number): Text {
  const t = new Text({ text: emoji, style: { fontFamily: EMOJI_FONT, fontSize, fill: 0xffffff } });
  t.resolution = resolution;
  t.anchor.set(0.5);
  return t;
}

function render(renderer: Renderer, target: Container, w: number, h: number, resolution: number): Texture {
  const texture = renderer.generateTexture({ target, frame: new Rectangle(0, 0, w, h), resolution, antialias: true });
  target.destroy({ children: true });
  return texture;
}

function makePlaceholder(renderer: Renderer, def: AssetDef): Texture {
  const color = parseHex(def.placeholder.color, 0x888888);
  if (def.opaque || def.category === 'background') {
    return makeBackgroundPlaceholder(renderer, def.w ?? 720, def.h ?? 1280, color);
  }
  const s = Math.max(16, def.size || 128);
  const res = Math.min(2, PLACEHOLDER_MAX_PX / s);
  const lw = Math.max(3, s * 0.05);
  const dark = shade(color, 0.55);
  const c = new Container();
  const g = new Graphics();
  if (def.placeholder.shape === 'circle') {
    const r = s / 2 - lw / 2;
    g.circle(s / 2, s / 2, r).fill(color).stroke({ width: lw, color: dark });
    g.ellipse(s * 0.36, s * 0.28, s * 0.17, s * 0.09).fill({ color: 0xffffff, alpha: 0.3 });
  } else {
    const r = s * 0.2;
    const depth = s * 0.07;
    g.roundRect(lw / 2, lw / 2, s - lw, s - lw, r).fill(dark);
    g.roundRect(lw / 2, lw / 2, s - lw, s - lw - depth, r).fill(color).stroke({ width: lw, color: dark });
    g.roundRect(s * 0.18, s * 0.1, s * 0.64, s * 0.1, s * 0.05).fill(mixColor(color, lighten(color, 0.6), 0.45));
  }
  c.addChild(g);
  if (def.placeholder.emoji) {
    const t = emojiText(def.placeholder.emoji, s * 0.52, res);
    t.position.set(s / 2, s / 2 + s * 0.02);
    c.addChild(t);
  }
  return render(renderer, c, s, s, res);
}

function makeBackgroundPlaceholder(renderer: Renderer, w: number, h: number, color: number): Texture {
  const c = new Container();
  const g = new Graphics();
  g.rect(0, 0, w, h).fill(color);
  // 은은한 체크 무늬 (폭 8칸 → 장난감 방은 84px 바닥 타일)
  const cell = Math.round(w / 8);
  const light = lighten(color, 0.5);
  for (let y = 0, row = 0; y < h; y += cell, row++) {
    for (let x = (row % 2) * cell; x < w; x += cell * 2) g.rect(x, y, cell, cell);
  }
  g.fill({ color: light, alpha: 0.08 });
  for (let y = 0; y < h; y += cell) g.rect(0, y, w, 2);
  g.fill({ color: shade(color, 0.6), alpha: 0.12 });
  c.addChild(g);
  return render(renderer, c, w, h, 1);
}

function makeMissingTexture(renderer: Renderer): Texture {
  const s = 64;
  const c = new Container();
  c.addChild(new Graphics().roundRect(1, 1, s - 2, s - 2, 10).fill(0xff00ff).stroke({ width: 3, color: 0x5a005a }));
  const q = new Text({
    text: '?',
    style: { fontFamily: 'sans-serif', fontSize: 44, fontWeight: 'bold', fill: 0xffffff, stroke: { color: 0x5a005a, width: 5 } },
  });
  q.resolution = 2;
  q.anchor.set(0.5);
  q.position.set(s / 2, s / 2);
  c.addChild(q);
  return render(renderer, c, s, s, 2);
}
