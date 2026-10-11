// 전역 상수. 로직·렌더 양쪽에서 쓰므로 PixiJS/DOM을 import 하지 않는다.

/** 세이브 포맷 버전. RunState 모양이 바뀌면 올린다 */
export const SAVE_VERSION = 1;
export const SAVE_KEY = 'ballshooter.run';
export const SETTINGS_KEY = 'ballshooter.settings';

// ── 화면 (논리 좌표) ──────────────────────────────────────────
export const DESIGN_W = 720;
export const DESIGN_MIN_H = 1280;
/** 9:19.5 */
export const DESIGN_MAX_H = 1560;

// ── 전투 필드 (시뮬레이션 좌표, 화면 크기와 무관) ─────────────
export const FIELD_COLS = 8;
export const CELL = 84;
export const FIELD_W = FIELD_COLS * CELL; // 672
export const FIELD_H = 960;
/** 적 충돌 박스는 칸보다 이만큼 안쪽 (사방) */
export const ENEMY_INSET = 4;

export const PLAYER_HIT_RADIUS = 20;
/** 보이는 크기 반경 (렌더/이동 clamp용) */
export const PLAYER_VISUAL_RADIUS = 34;
/**
 * 플레이어 이동 범위 (필드 좌표): 필드 벽 안 어디든 — 보이는 크기 반경만큼 안쪽. 위로 올라가 적 사이로 들어가도 되지만
 * 적 몸에 닿으면 즉시 패배(sim의 접촉 판정)다.
 */
export const PLAYER_MIN_X = PLAYER_VISUAL_RADIUS;
export const PLAYER_MAX_X = FIELD_W - PLAYER_VISUAL_RADIUS;
export const PLAYER_MIN_Y = PLAYER_VISUAL_RADIUS;
export const PLAYER_MAX_Y = FIELD_H - PLAYER_VISUAL_RADIUS;
/** 시작 위치 y (x는 가운데) */
export const PLAYER_START_Y = FIELD_H - 96;
/**
 * 이동 가속: 정지 → 최고 속도(moveSpeed)까지 이 시간(초). 가속도 = moveSpeed / PLAYER_ACCEL_TIME (방향을 바꾸거나 멈출 때도 같은 가속도).
 * 목표 위치로는 '걸어간다' — 최고 속도로 가다가 목표 앞에서 감속해 지나치지 않고 멈춘다 (logic/combat/movement.ts).
 */
export const PLAYER_ACCEL_TIME = 0.1;
/**
 * 도착 감속의 세기(가속도 대비). 목표까지 거리 d에서 낼 수 있는 속도 = √(2 × 가속도 × 이 값 × d) — 1보다 작게 두어
 * 브레이크에 여유를 남긴다(목표를 지나치거나 떨지 않게). 0.8이면 최고 속도에서 약 26 px 앞부터 감속한다.
 */
export const PLAYER_ARRIVE_BRAKE = 0.8;
export const PLAYER_INVULN_TIME = 1.0;

/** 고정 시뮬레이션 스텝 */
export const SIM_DT = 1 / 60;
/** 한 스텝 내 투사체 서브스텝 상한 (터널링 방지: 이동거리 / (반경) 기준으로 계산) */
export const MAX_SUBSTEPS = 6;
/**
 * 투사체 수명 상한(초). 필드가 투사체로 뒤덮이지 않게 하는 주 장치 — 틈으로 들어가 대형 뒤에서 덜그럭거리는 공은
 * 보통 이 안에 다 때리고 나온다 (밸런스 프로브의 rattle·age-expired 열로 확인).
 */
export const PROJECTILE_MAX_AGE = 6;
/** 분열 자식(새끼오리 등)의 수명 상한(초). 부모보다 짧게 — 한 발이 여러 개로 늘어나는 만큼 빨리 사라진다 */
export const SPLIT_CHILD_MAX_AGE = 2.5;
/** 반사 후 |vy| >= speed × 이 값 보장 */
export const MIN_VERTICAL_RATIO = 0.22;
/** 같은 적을 관통 투사체가 다시 때리기까지 최소 간격(초) */
export const PIERCE_REHIT_TIME = 0.25;
/** 보이는 적이 없을 때 하강 빨리감기 배수 */
export const DESCENT_FAST_FORWARD = 6;
/** 대형 첫 줄이 화면 상단에서 시작하는 높이 오프셋 (rows[0]의 top = -CELL - SPAWN_GAP) */
export const SPAWN_GAP = 0;

// ── 조준 / 입력 ──────────────────────────────────────────────
/** 수동 조준의 수평 여유(도): 조준각은 [-(180° - 이 값), -이 값] (위쪽 반원, 완전 수평 금지) */
export const AIM_MIN_DEG = 8;
/** 포인터가 이만큼(화면 논리 px) 움직이기 전에 떼면 탭(조준), 넘으면 드래그(이동). 390폭 폰에서 ≈ 10 CSS px */
export const TAP_SLOP = 18;
/** 키보드 조준 회전 속도(도/초) — Q/E, ,/. */
export const AIM_KEY_RATE_DEG = 120;

// ── 상태이상 ─────────────────────────────────────────────────
export const BURN_DURATION = 3;
export const BURN_RATIO = 0.25;
export const CHILL_DURATION = 2.5;
export const CHILL_DAMAGE_TAKEN_MUL = 1.25;
/**
 * 냉기 중 공격 타이머가 흐르는 속도(1 = 평소). 냉기는 공격을 멈추지 않고 늦춘다 — 예전처럼 완전히 멈추면
 * 얼음을 여러 무기에 붙인 빌드가 적(특히 보스)을 계속 얼려 st5가 얼음 유무로 갈렸다(docs/DESIGN.md '난이도 목표').
 */
export const CHILL_ATTACK_RATE = 0.4;
/** 엘리트(보스가 아닌 2칸 이상 적 — 곰인형)·보스는 냉기에 강하다: 공격 타이머가 이 속도로 흐른다 */
export const CHILL_ATTACK_RATE_RESIST = 0.8;
/**
 * 보스 연타 감쇠: 같은 투사체가 보스를 이 시간(초) 안에 다시 때리면 그 직접 피해 × BOSS_REHIT_DAMAGE_MUL.
 * 보스 위(천장과 보스 윗면 사이)에 갇혀 덜그럭거리는 공 — 특히 보스를 뚫고 올라가는 양말 개틀링 — 이 보스 피해의
 * 대부분을 내서, 개틀링·거울을 쌓은 빌드가 보스를 순식간에 녹였다. 보스에만 적용(일반 적 대형 뒤 덜그럭거림은 그대로).
 */
export const BOSS_REHIT_WINDOW = 1.0;
export const BOSS_REHIT_DAMAGE_MUL = 0.3;
export const CHAIN_RANGE = 160;
export const CHAIN_TARGETS = 2;
export const CHAIN_DAMAGE_MUL = 0.5;
export const EXPLODE_DAMAGE_MUL = 0.5;

// ── 가방 / 등급 ──────────────────────────────────────────────
export const BAG_START_COLS = 5;
export const BAG_START_ROWS = 4;
export const BAG_MAX_COLS = 7;
export const BAG_MAX_ROWS = 6;
export const STASH_CAPACITY = 8;
export const MAX_TIER = 3;
/** index = tier */
export const TIER_DAMAGE_MUL = [0, 1, 1.6, 2.5] as const;
export const TIER_COOLDOWN_MUL = [0, 1, 0.9, 0.8] as const;
export const TIER_EFFECT_MUL = [0, 1, 1.6, 2.2] as const;
/** 가격(구매/판매) ★ 배수: ★n 아이템 = ★1 두 개 합성의 누적 */
export const TIER_PRICE_MUL = [0, 1, 2, 4] as const;
/** 쿨타임 감소 합산 하한 (기본 쿨의 35%까지만) */
export const COOLDOWN_FLOOR_MUL = 0.35;

// ── 상점 / 경제 ──────────────────────────────────────────────
export const SHOP_SLOTS = 4;
export const SHOP_REROLL_BASE = 2;
export const SELL_RATIO = 0.5;
export const BAG_EXPAND_COSTS = [15, 25, 35, 45] as const;
export const HEAL_COST = 10;
export const HEAL_RATIO = 0.5;
export const STAGE_CLEAR_HEAL_RATIO = 0.3;
/** 스테이지 인덱스별 상점 희귀도 가중치 [common, rare, epic, legendary] */
export const SHOP_RARITY_WEIGHTS: readonly (readonly [number, number, number, number])[] = [
  [80, 20, 0, 0],
  [65, 30, 5, 0],
  [50, 35, 14, 1],
  [40, 38, 19, 3],
  [30, 40, 25, 5],
];

// ── 레이아웃 (화면 논리 좌표) ─────────────────────────────────
export const HUD_H = 100;
export const BOTTOM_BAR_MIN_H = 220;
export const FIELD_X = (DESIGN_W - FIELD_W) / 2; // 24

// ── 색 ───────────────────────────────────────────────────────
export const RARITY_COLORS: Record<'common' | 'rare' | 'epic' | 'legendary', number> = {
  common: 0x9aa4b1,
  rare: 0x3fa3ff,
  epic: 0xb46cff,
  legendary: 0xffb02e,
};
export const ELEMENT_COLORS: Record<'fire' | 'ice' | 'lightning', number> = {
  fire: 0xff6a2b,
  ice: 0x6fd8ff,
  lightning: 0xffe14a,
};
export const UI_COLORS = {
  bg: 0x1a1226,
  panel: 0x2b1d3a,
  panelLight: 0x3d2a52,
  panelBorder: 0x6b4f8f,
  text: 0xffffff,
  textDim: 0xb9a9cf,
  gold: 0xffc93c,
  hp: 0xff4d6d,
  good: 0x5ee07a,
  bad: 0xff5a5a,
  accent: 0x7c5cff,
} as const;
