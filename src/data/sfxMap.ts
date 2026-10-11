// 효과음 데이터: sfx.json(생성 프롬프트 + 재생 힌트)과 게임 데이터 → 효과음 id 매핑. 순수 데이터 (PixiJS/DOM 없음).
// 씬 코드는 효과음 id를 여기의 SfxId로만 쓴다 (오타는 타입 오류). 생성 도구 tools/gen-sfx.mjs도 sfx.json을 읽는다.
import type { Element } from '../types';
import { RECIPES } from './recipes';
import SFX_JSON from './sfx.json';

/** 재생 우선순위 순서는 CATEGORY_PRIORITY (전역 동시 재생 상한에서 낮은 것부터 밀려난다) */
export type SfxCategory = 'ui' | 'fire' | 'hit' | 'enemy' | 'reward' | 'jingle';

export interface SfxDef {
  id: SfxId;
  category: SfxCategory;
  /** ElevenLabs 요청 길이(초). API 하한 0.5 — 끝의 무음은 디코드 때 잘라낸다 */
  duration: number;
  /** ElevenLabs prompt_influence (0..1) */
  influence: number;
  /** 같은 프롬프트로 만든 변형 수 (재생 때 무작위, 같은 것 연속 회피) */
  variants: number;
  /** 재생 볼륨 0..1 — 디코드 때 피크 -3 dBFS로 맞춘 뒤 곱한다 (다시 생성하지 않고 조절) */
  volume: number;
  /** 이 id의 동시 재생 상한 (넘으면 가장 오래된 같은 소리를 끊고 재생) */
  maxVoices: number;
  /** 같은 id 재생 최소 간격(초) — 이보다 빨리 오면 버린다 */
  minInterval: number;
  /** 재생 속도(음높이) 무작위 폭 ±pitchVar */
  pitchVar: number;
  /** ElevenLabs 프롬프트 (영어) */
  prompt: string;
}

/** sfx.json의 id 전부 (tests/audio-data.test.ts가 sfx.json과 같은지 검사) */
export const SFX_IDS = [
  'ui_tap',
  'ui_back',
  'ui_error',
  'ui_purchase',
  'ui_sell',
  'ui_reroll',
  'ui_lock',
  'bag_open',
  'bag_close',
  'item_pick',
  'item_place',
  'item_rotate',
  'merge_tier',
  'merge_evolve',
  'bag_expand',
  'heal',
  'fire_hairball',
  'fire_fish',
  'fire_yuzu',
  'fire_sock',
  'fire_duck',
  'fire_toaster',
  'fire_whoopee',
  'fire_watermelon',
  'hit_toy',
  'hit_heavy',
  'bounce_wall',
  'kill_pop',
  'kill_elite',
  'boss_kill',
  'explode',
  'elem_fire',
  'elem_ice',
  'elem_zap',
  'split',
  'enemy_shoot_dart',
  'enemy_shoot_bolt',
  'enemy_shoot_spring',
  'enemy_shoot_gear',
  'player_hurt',
  'coin',
  'item_drop',
  'combo',
  'stage_start',
  'stage_clear',
  'defeat',
  'boss_appear',
  'danger',
  'victory_run',
] as const;

export type SfxId = (typeof SFX_IDS)[number];

export const SFX_DEFS: readonly SfxDef[] = SFX_JSON as SfxDef[];

/** 전역 동시 재생 상한에서 높은 것이 낮은 것을 밀어낸다 (같으면 오래된 것을) */
export const CATEGORY_PRIORITY: Readonly<Record<SfxCategory, number>> = {
  fire: 0,
  hit: 1,
  enemy: 2,
  reward: 3,
  ui: 4,
  jingle: 5,
};

/**
 * 초당 재생 예산(토큰 버킷)에서 이 카테고리가 남겨 둬야 하는 토큰 수 — 예산이 빠듯할 때 발사음·타격음부터 빠진다.
 * null = 예산과 무관 (사용자 조작·징글은 드물고 항상 들려야 한다).
 */
export const CATEGORY_RESERVE: Readonly<Record<SfxCategory, number | null>> = {
  fire: 3,
  hit: 1,
  enemy: 1,
  reward: 0,
  ui: null,
  jingle: null,
};

/**
 * 카테고리 기본값을 id별로 바꾼다: 처치·피격처럼 게임 결과를 알려 주는 소리는 타격음보다 앞에,
 * 벽 튕김처럼 많기만 한 소리는 발사음과 같은 맨 뒤로.
 */
export const SFX_OVERRIDES: Readonly<Partial<Record<SfxId, { priority?: number; reserve?: number | null }>>> = {
  bounce_wall: { priority: 0, reserve: 3 },
  kill_pop: { priority: 2, reserve: 0 },
  kill_elite: { priority: 3, reserve: null },
  boss_kill: { priority: 5, reserve: null },
  explode: { priority: 2, reserve: 0 },
  player_hurt: { priority: 3, reserve: null },
  // 드롭은 드물고(minInterval 0.2초·동시 1개) 꼭 들려야 한다 — 예산에 넣으면 빠른 전투에서 콤보·동전·처치음이 마지막 토큰을 써서 빠졌다
  item_drop: { reserve: null },
};

/** 기본 무기 → 발사음 계열. 진화 무기는 레시피의 기본 무기 계열을 따른다 (weaponFireSfx) */
export const WEAPON_FIRE_SFX: Readonly<Record<string, SfxId>> = {
  w_hairball: 'fire_hairball',
  w_fish: 'fire_fish',
  w_yuzu: 'fire_yuzu',
  w_sock: 'fire_sock',
  w_duck: 'fire_duck',
  w_toaster: 'fire_toaster',
  w_whoopee: 'fire_whoopee',
  w_watermelon: 'fire_watermelon',
};

const FALLBACK_FIRE: SfxId = 'fire_hairball';

/** 무기 defId → 발사음. 진화 무기(레시피 결과)는 기본 무기 계열, 모르는 무기는 털뭉치 소리 */
export function weaponFireSfx(defId: string): SfxId {
  let id = defId;
  // 진화의 진화도 따라가게 (지금은 한 단계뿐)
  for (let guard = 0; guard < 4; guard++) {
    const direct = WEAPON_FIRE_SFX[id];
    if (direct) return direct;
    const recipe = RECIPES.find((r) => r.result === id);
    if (!recipe) break;
    id = recipe.base;
  }
  return FALLBACK_FIRE;
}

/** 적 공격 탄 스프라이트 → 적 발사음 */
export const ENEMY_SHOT_SFX: Readonly<Record<string, SfxId>> = {
  shot_dart: 'enemy_shoot_dart',
  shot_bolt: 'enemy_shoot_bolt',
  shot_spring: 'enemy_shoot_spring',
  shot_gear: 'enemy_shoot_gear',
};

/** 속성 적중에 겹치는 소리 (번개 연쇄도 elem_zap) */
export const ELEMENT_HIT_SFX: Readonly<Record<Element, SfxId>> = {
  fire: 'elem_fire',
  ice: 'elem_ice',
  lightning: 'elem_zap',
};

// ── 전투 효과음 연출 수치 ────────────────────────────────────

/** 피해 ÷ 스테이지 HP 배수가 이 값 이상이면 묵직한 타격음(hit_heavy) — 스테이지가 오를수록 적도 단단하니 같은 기준 */
export const HEAVY_HIT_DAMAGE = 40;
/** 전투 소리 좌우 위치: 필드 x를 -1..1로 바꿔 이만큼 곱한다 (은은하게) */
export const COMBAT_PAN = 0.3;
/** 동전이 HUD에 이 간격(초) 안에 연달아 도착하면 연속으로 쳐서 음이 오른다 */
export const COIN_STREAK_WINDOW = 0.45;
/** 동전 연속 한 번마다 재생 속도 배수 (반음 ≈ 1.0595) / 최대 단계 */
export const COIN_STREAK_STEP = 1.0595;
export const COIN_STREAK_MAX = 7;
/** 콤보 한 번마다 반음씩 올라가고 이 단계에서 멈춘다 */
export const COMBO_PITCH_STEP = 1.0595;
export const COMBO_PITCH_MAX = 10;
/** 방어선 위험 경고(danger)는 위험이 새로 시작될 때만, 그리고 이 간격(초) 안에는 다시 울리지 않는다 */
export const DANGER_REPEAT = 6;
/** 스테이지 클리어 카운트업 '틱' 간격(초)과 볼륨 */
export const COUNT_TICK_INTERVAL = 0.07;
export const COUNT_TICK_VOLUME = 0.45;
