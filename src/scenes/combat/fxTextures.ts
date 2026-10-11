// 이펙트용 텍스처(한 번 구워서 재사용)와 숫자용 비트맵 폰트.
// 전투 씬이 스테이지마다 새로 만들어지므로 모듈 단위로 캐시한다 (작아서 해제하지 않음).
import {
  BitmapFont,
  ColorMatrixFilter,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  type Renderer,
} from 'pixi.js';
import { FONT_FAMILY } from '../../core/fonts';
import { tex } from '../../render/assets';
import { OUTLINE_COLOR } from '../../ui';
import { AIM_OUTLINE, LIGHTNING_COLOR } from './visual';

export interface FxTextures {
  /** 가운데가 진한 부드러운 흰 원 (64px) */
  soft: Texture;
  /** 흰 고리 (128px, 반경 58) */
  ring: Texture;
  /** 네 갈래 반짝임 (48px) */
  spark: Texture;
  /** 그림자 타원 (96×30) */
  shadow: Texture;
  /** 조준 가이드 점: 진한 외곽선 + 흰 속 (24px, 바닥 위에서도 잘 보이게) */
  dot: Texture;
}

/**
 * 파티클 아틀라스의 프레임 이름. ParticleContainer는 텍스처 소스 하나만 쓰므로
 * 그림 에셋(fx_* · 적 탄 파편)과 코드로 그린 모양을 한 장에 구워 둔다.
 */
export type FxFrame =
  | 'impact' // fx_impact: 흰·노랑 별 터짐
  | 'puff' // fx_puff: 연기 구름
  | 'boom' // fx_boom: 폭발 구름
  | 'flame' // fx_flame
  | 'ice' // fx_ice: 얼음 조각
  | 'sparkle' // fx_spark: 네 갈래 반짝 (노랑 + 외곽선)
  | 'dust' // fx_dust: 먼지
  | 'bolt' // shot_bolt (파편)
  | 'spring' // shot_spring (파편)
  | 'gear' // shot_gear (파편)
  | 'soft' // 부드러운 흰 원 (glow)
  | 'ring' // 흰 고리 (충격파)
  | 'star' // 흰 네 갈래 별 (색 입히는 반짝임)
  | 'shard' // 흰 마름모 조각 (색 입히는 파편)
  | 'trail' // 꼬리 마디: 왼쪽(머리) 굵고 진함 → 오른쪽 TRAIL_TAPER 배
  | 'beam'; // 번개 마디: 단면이 바깥 노란 빛 → 노란 몸통 → 흰 심 (색이 구워져 있음, tint 안 함)

export type FxAtlas = Record<FxFrame, Texture>;

/** 비트맵 숫자 폰트 이름 (흰 글자 + 진한 외곽선 → tint로 색 입힘) */
export const NUM_FONT = 'CombatNumbers';
export const NUM_FONT_BASE = 44;

/** 꼬리 마디 텍스처 크기와 끝 굵기·알파 비율 (ProjectileLayer가 이 값으로 이어 붙인다) */
export const TRAIL_TEX_W = 64;
export const TRAIL_TEX_H = 32;

/**
 * 번개 마디 텍스처: 길이 방향은 균일, 세로(단면)가 번개 굵기 1배일 때의 빛 폭 BEAM_WORLD_W(필드 px)에 해당.
 * 예전 Graphics 3겹 획(빛 16px · 몸통 7px · 심 2.6px, 둥근 이음)을 매 프레임 다시 그리던 것을 파티클 한 장으로.
 */
export const BEAM_TEX_W = 32;
export const BEAM_TEX_H = 32;
export const BEAM_WORLD_W = 16;

let cache: FxTextures | null = null;
let atlasCache: FxAtlas | null = null;
let fontInstalled = false;
const overlayCache = new Map<string, EnemyOverlayTextures>();

export function fxTextures(renderer: Renderer): FxTextures {
  if (cache) return cache;
  cache = {
    soft: bake(renderer, 64, 64, (g) => {
      for (let i = 0; i < 10; i++) g.circle(32, 32, 31 * (1 - i / 11)).fill({ color: 0xffffff, alpha: 0.13 + i * 0.02 });
    }),
    ring: bake(renderer, 128, 128, (g) => {
      g.circle(64, 64, 52).fill({ color: 0xffffff, alpha: 0.12 });
      g.circle(64, 64, 58).stroke({ width: 9, color: 0xffffff });
    }),
    spark: bake(renderer, 48, 48, (g) => {
      const c = 24;
      const pts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? 23 : 6;
        pts.push(c + Math.cos(a) * r, c + Math.sin(a) * r);
      }
      g.poly(pts).fill(0xffffff);
    }),
    shadow: bake(renderer, 96, 30, (g) => {
      g.ellipse(48, 15, 46, 14).fill({ color: 0x000000, alpha: 0.18 });
      g.ellipse(48, 15, 36, 10).fill({ color: 0x000000, alpha: 0.18 });
    }),
    dot: bake(renderer, 24, 24, (g) => {
      g.circle(12, 12, 11).fill({ color: AIM_OUTLINE, alpha: 0.85 });
      g.circle(12, 12, 7).fill(0xffffff);
    }),
  };
  return cache;
}

/**
 * 파티클 아틀라스 (한 장). 그림 에셋이 아직 없으면 플레이스홀더가 대신 구워진다 — 새 PNG는 새로고침 후 반영.
 * @param trailTaper 꼬리 마디 끝 굵기·알파 비율 (visual.TRAIL_TAPER)
 */
export function fxAtlas(renderer: Renderer, trailTaper: number): FxAtlas {
  if (atlasCache) return atlasCache;
  const PAD = 3;
  const MAX_W = 1024;
  const holder = new Container();
  const placed: { name: FxFrame; x: number; y: number; w: number; h: number }[] = [];
  let x = PAD;
  let y = PAD;
  let rowH = 0;
  const place = (name: FxFrame, node: Container, w: number, h: number): void => {
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (x + w + PAD > MAX_W) {
      x = PAD;
      y += rowH + PAD;
      rowH = 0;
    }
    node.position.set(x, y);
    holder.addChild(node);
    placed.push({ name, x, y, w, h });
    x += w + PAD;
    rowH = Math.max(rowH, h);
  };
  const art: [FxFrame, string][] = [
    ['boom', 'fx_boom'],
    ['impact', 'fx_impact'],
    ['puff', 'fx_puff'],
    ['flame', 'fx_flame'],
    ['ice', 'fx_ice'],
    ['sparkle', 'fx_spark'],
    ['dust', 'fx_dust'],
    ['bolt', 'shot_bolt'],
    ['spring', 'shot_spring'],
    ['gear', 'shot_gear'],
  ];
  for (const [name, key] of art) {
    const t = tex(key);
    const s = new Sprite(t);
    place(name, s, t.width, t.height);
  }
  // 코드로 그린 모양들 (흰색 → tint로 색 입힘)
  const softG = new Graphics();
  for (let i = 0; i < 14; i++) softG.circle(32, 32, 31 * (1 - i / 15)).fill({ color: 0xffffff, alpha: 0.09 + i * 0.012 });
  place('soft', softG, 64, 64);
  const ringG = new Graphics();
  ringG.circle(64, 64, 56).stroke({ width: 10, color: 0xffffff });
  ringG.circle(64, 64, 49).stroke({ width: 5, color: 0xffffff, alpha: 0.35 });
  place('ring', ringG, 128, 128);
  const starG = new Graphics();
  {
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 23 : 5.5;
      pts.push(24 + Math.cos(a) * r, 24 + Math.sin(a) * r);
    }
    starG.poly(pts).fill(0xffffff);
  }
  place('star', starG, 48, 48);
  const shardG = new Graphics();
  shardG.poly([16, 1, 27, 16, 16, 31, 5, 16]).fill(0xffffff);
  place('shard', shardG, 32, 32);
  const trailSpr = trailSprite(trailTaper);
  place('trail', trailSpr, TRAIL_TEX_W, TRAIL_TEX_H);
  const beamSpr = beamSprite();
  place('beam', beamSpr, BEAM_TEX_W, BEAM_TEX_H);

  const atlasH = y + rowH + PAD;
  const rt = renderer.generateTexture({
    target: holder,
    frame: new Rectangle(0, 0, MAX_W, atlasH),
    resolution: 1,
    antialias: true,
  });
  // 캔버스로 만든 임시 텍스처는 구운 뒤 버린다. 그림 에셋 텍스처(tex())는 공용이라 두고,
  // Graphics는 자기 컨텍스트까지 (context: true — 안 그러면 렌더러 GC 때까지 GPU 지오메트리가 남는다)
  trailSpr.texture.destroy(true);
  beamSpr.texture.destroy(true);
  holder.destroy({ children: true, context: true });
  const out = {} as FxAtlas;
  for (const p of placed) {
    out[p.name] = new Texture({ source: rt.source, frame: new Rectangle(p.x, p.y, p.w, p.h) });
  }
  atlasCache = out;
  return out;
}

/** 꼬리 외곽선 색 (그림체의 갈색 외곽선 — 밝은 바닥 위에서도 흰 꼬리가 보이게) */
const TRAIL_RIM = [74, 48, 34];
/** 외곽선 두께 (텍스처 px, 반폭 16 기준) */
const TRAIL_RIM_PX = 3.2;

/**
 * 꼬리 마디: 왼쪽 끝(머리) 굵기 100%·알파 1 → 오른쪽 끝 굵기·알파 taper.
 * 흰 속 + 얇은 갈색 테 (tint를 입히면 속은 원소 색, 테는 그 색의 진한 쪽). 위아래 가장자리는 부드럽게.
 */
function trailSprite(taper: number): Sprite {
  const W = TRAIL_TEX_W;
  const H = TRAIL_TEX_H;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const feather = 1.6;
    for (let px = 0; px < W; px++) {
      const k = px / (W - 1);
      const half = (H / 2 - 1) * (1 + (taper - 1) * k);
      const alphaX = 1 + (taper - 1) * k;
      const rim = TRAIL_RIM_PX * (1 + (taper - 1) * k * 0.5);
      for (let py = 0; py < H; py++) {
        const dist = Math.abs(py + 0.5 - H / 2);
        const edge = Math.max(0, Math.min(1, (half - dist) / feather));
        // 테 → 속 전환 (부드럽게 1px)
        const inner = Math.max(0, Math.min(1, (half - rim - dist) / 1.2 + 0.5));
        const r = TRAIL_RIM[0] + (255 - TRAIL_RIM[0]) * inner;
        const g = TRAIL_RIM[1] + (255 - TRAIL_RIM[1]) * inner;
        const b = TRAIL_RIM[2] + (255 - TRAIL_RIM[2]) * inner;
        // 테는 조금 옅게 (속보다 덜 진한 선)
        const a = edge * alphaX * (0.6 + 0.4 * inner);
        const o = (py * W + px) * 4;
        d[o] = Math.round(r);
        d[o + 1] = Math.round(g);
        d[o + 2] = Math.round(b);
        d[o + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return new Sprite(Texture.from(canvas));
}

/**
 * 번개 마디: 단면(세로)만 변하고 길이 방향은 균일. 바깥 빛(LIGHTNING_COLOR, 알파 0.28, 폭 16) 위에 노란 몸통(0.95, 폭 7),
 * 그 위에 흰 심(폭 2.6)을 'over'로 합성해 굽는다 — 예전 Graphics 획 3겹과 같은 색·굵기.
 */
function beamSprite(): Sprite {
  const W = BEAM_TEX_W;
  const H = BEAM_TEX_H;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const pxPerWorld = H / BEAM_WORLD_W;
    const glowC = [(LIGHTNING_COLOR >> 16) & 255, (LIGHTNING_COLOR >> 8) & 255, LIGHTNING_COLOR & 255];
    const bodyC = [0xff, 0xd2, 0x3f];
    // 가장자리 0.6px(필드 px) 부드럽게
    const cover = (halfW: number, dist: number): number => Math.max(0, Math.min(1, (halfW - dist) / 0.6 + 0.5));
    for (let py = 0; py < H; py++) {
      const dist = Math.abs(py + 0.5 - H / 2) / pxPerWorld;
      // 아래에서 위로 'over' 합성: 빛 → 몸통 → 심
      let a = 0.28 * cover(8, dist);
      let r = glowC[0];
      let g = glowC[1];
      let b = glowC[2];
      const over = (c: readonly number[], ca: number): void => {
        const na = ca + a * (1 - ca);
        if (na <= 0) return;
        r = (c[0] * ca + r * a * (1 - ca)) / na;
        g = (c[1] * ca + g * a * (1 - ca)) / na;
        b = (c[2] * ca + b * a * (1 - ca)) / na;
        a = na;
      };
      over(bodyC, 0.95 * cover(3.5, dist));
      over([255, 255, 255], cover(1.3, dist));
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 4;
        d[o] = Math.round(r);
        d[o + 1] = Math.round(g);
        d[o + 2] = Math.round(b);
        d[o + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return new Sprite(Texture.from(canvas));
}

/** 적 스프라이트 덮개: 흰 실루엣(피격 번쩍임 · 화상 tint) + 얼음 실루엣(냉기 — 명암은 남기고 파랗게) */
export interface EnemyOverlayTextures {
  white: Texture;
  frost: Texture;
}

/** 흰색으로 덮는 행렬 (알파 유지) */
const WHITE_MATRIX = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0];
/**
 * 얼음 행렬: 밝기 → 하늘색~흰 얼음 색. 곱하기 tint(노란 적이 초록이 됨) 대신 밝기만 남겨 다시 칠한다.
 * R' = 0.62L + 0.12, G' = 0.62L + 0.33, B' = 0.36L + 0.66  (L = 0.3R + 0.59G + 0.11B)
 */
const FROST_MATRIX = (() => {
  const row = (k: number, off: number): number[] => [0.3 * k, 0.59 * k, 0.11 * k, 0, off];
  return [...row(0.62, 0.12), ...row(0.62, 0.33), ...row(0.36, 0.66), 0, 0, 0, 1, 0];
})();

/** 적 에셋 키별 덮개 텍스처 (키마다 한 번 굽고 캐시). 원본 텍스처와 같은 크기 */
export function enemyOverlayTextures(renderer: Renderer, key: string): EnemyOverlayTextures {
  const hit = overlayCache.get(key);
  if (hit) return hit;
  const src = tex(key);
  const res: EnemyOverlayTextures = {
    white: bakeMatrix(renderer, src, WHITE_MATRIX),
    frost: bakeMatrix(renderer, src, FROST_MATRIX),
  };
  overlayCache.set(key, res);
  return res;
}

function bakeMatrix(renderer: Renderer, src: Texture, matrix: number[]): Texture {
  const s = new Sprite(src);
  const f = new ColorMatrixFilter({ resolution: 1 });
  f.matrix = matrix as ColorMatrixFilter['matrix'];
  s.filters = [f];
  const holder = new Container();
  holder.addChild(s);
  const w = Math.max(1, Math.ceil(src.width));
  const h = Math.max(1, Math.ceil(src.height));
  const t = renderer.generateTexture({ target: holder, frame: new Rectangle(0, 0, w, h), resolution: 1, antialias: true });
  holder.destroy({ children: true });
  f.destroy();
  return t;
}

/** 숫자 비트맵 폰트 설치 (폰트 로드 후 첫 전투에서 한 번). 'x'는 콤보 배수("x3!")용 */
export function ensureNumberFont(): void {
  if (fontInstalled) return;
  fontInstalled = true;
  BitmapFont.install({
    name: NUM_FONT,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: NUM_FONT_BASE,
      fill: 0xffffff,
      stroke: { color: OUTLINE_COLOR, width: 8, join: 'round' },
    },
    chars: [['0', '9'], '+-/!x'],
    resolution: 2,
    padding: 6,
  });
}

function bake(renderer: Renderer, w: number, h: number, draw: (g: Graphics) => void): Texture {
  const g = new Graphics();
  draw(g);
  const t = renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, w, h), resolution: 2, antialias: true });
  g.destroy();
  return t;
}
