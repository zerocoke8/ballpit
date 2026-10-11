// 런 상태·보상·스테이지 진행·세이브. 순수 로직 (PixiJS 금지, DOM은 localStorage 세이브만).

import {
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  SAVE_KEY,
  SAVE_VERSION,
  SHOP_REROLL_BASE,
  SHOP_SLOTS,
  STAGE_CLEAR_HEAL_RATIO,
} from '../config';
import type {
  CharacterDef,
  GameData,
  KillReward,
  PlayerStats,
  RunState,
  StageDef,
  Tier,
  WeaponLoadout,
} from '../types';
import { addNewToBag, addToStash, canPlace, createBag } from './bag';
import { Rng } from './rng';
import { rollItemDef, rollShop } from './shop';
import { computeLoadout, computePlayerStats, sellPrice } from './stats';

/** 32비트 정수 섞기 (splitmix 계열 finalizer) */
function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d);
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

// goldMul 합산 오차(30 × 2.05 = 61.4999…)로 .5 경계가 내림되지 않게
const ROUND_EPS = 1e-9;

function roundGold(x: number): number {
  return Math.round(x + ROUND_EPS);
}

// ── 생성 / 조회 ──────────────────────────────────────────────

export function newRun(data: GameData, characterId: string, seed: number): RunState {
  const character = data.characters[characterId];
  if (!character) throw new Error(`run: unknown character '${characterId}'`);

  const bag = createBag();
  for (const si of character.startItems) {
    const placed = addNewToBag(bag, data.items, si.defId, si.tier ?? 1, si.x, si.y, si.rot);
    if (!placed) throw new Error(`run: cannot place start item '${si.defId}' for '${characterId}'`);
  }

  const run: RunState = {
    version: SAVE_VERSION,
    characterId,
    stageIndex: 0,
    resumeAt: 'combat',
    gold: 0,
    hp: 0,
    bag,
    shop: {
      slots: new Array<null>(SHOP_SLOTS).fill(null),
      rerollCost: SHOP_REROLL_BASE,
      healBought: false,
    },
    rngState: mix32((seed ^ 0x5bd1e995) >>> 0),
    seed: seed >>> 0,
    stats: { kills: 0, goldEarned: 0, stagesCleared: 0 },
  };
  run.hp = runPlayerStats(data, run).maxHp;
  return run;
}

export function runCharacter(data: GameData, run: RunState): CharacterDef {
  const character = data.characters[run.characterId];
  if (!character) throw new Error(`run: unknown character '${run.characterId}'`);
  return character;
}

export function runPlayerStats(data: GameData, run: RunState): PlayerStats {
  return computePlayerStats(runCharacter(data, run), run.bag, data.items);
}

export function runLoadout(data: GameData, run: RunState): WeaponLoadout[] {
  return computeLoadout(run.bag, data.items, runPlayerStats(data, run));
}

/** 진행 중인 스테이지. 런이 끝났으면(범위 밖) 마지막 스테이지 */
export function currentStage(data: GameData, run: RunState): StageDef {
  const { stages } = data;
  if (stages.length === 0) throw new Error('run: no stages');
  return stages[Math.max(0, Math.min(run.stageIndex, stages.length - 1))];
}

export function combatSeed(run: RunState): number {
  return mix32((run.seed ^ Math.imul(run.stageIndex + 1, 0x9e3779b9)) >>> 0);
}

export function isRunComplete(data: GameData, run: RunState): boolean {
  return run.stageIndex >= data.stages.length;
}

/**
 * 데이터 기준으로 이어서 할 수 있는 런인지. 아이템 id가 바뀐 옛 세이브는 bag/stats가 throw 하므로 거른다:
 * 캐릭터·아이템 id 존재, 가방 아이템이 범위 안 + 겹침 없음, 상점 칸 id 존재, 아직 끝나지 않은 런.
 */
export function isRunValid(data: GameData, run: RunState): boolean {
  if (!data.characters[run.characterId]) return false;
  if (run.stageIndex >= data.stages.length) return false;
  const { bag } = run;
  for (const it of bag.items) {
    if (!data.items[it.defId]) return false;
  }
  // 모든 id가 확인된 뒤에만 canPlace (모르는 id가 섞이면 throw)
  for (const it of bag.items) {
    if (!canPlace(bag, data.items, it.defId, it.x, it.y, it.rot, it.uid)) return false;
  }
  if (bag.stash.some((s) => !data.items[s.defId])) return false;
  return run.shop.slots.every((s) => s === null || data.items[s.defId] !== undefined);
}

/** 전투 밖에서 maxHp가 줄었을 때(장비 판매·보관함 이동) hp를 맞춘다. 늘어난 경우는 건드리지 않음 */
export function clampRunHp(data: GameData, run: RunState): void {
  const { maxHp } = runPlayerStats(data, run);
  if (run.hp > maxHp) run.hp = maxHp;
}

// ── 보상 ─────────────────────────────────────────────────────

/** 상점과 같은 희귀도 규칙으로 ★1 드롭 아이템 하나. 후보가 없으면 null */
export function rollDropItem(
  data: GameData,
  stageIndex: number,
  rng: Rng,
): { defId: string; tier: Tier } | null {
  const def = rollItemDef(data, stageIndex, rng);
  return def ? { defId: def.id, tier: 1 } : null;
}

/**
 * 처치 보상. 골드: g = def.gold × goldMul (소수 가능) → floor(g) 확정 + 소수 부분 확률로 +1.
 * 0골드 처치도 있다. RNG는 매번 골드 1회 → 드롭 판정 1회(→ 드롭 아이템) 순으로 소비한다.
 */
export function rewardKill(data: GameData, run: RunState, enemyDefId: string): KillReward {
  const enemy = data.enemies[enemyDefId];
  if (!enemy) throw new Error(`run: unknown enemy '${enemyDefId}'`);

  const rng = new Rng(run.rngState);
  const g = Math.max(0, enemy.gold * runPlayerStats(data, run).goldMul);
  // 부동소수 오차(2.9999…)로 정수 배가 한 칸 내려가지 않게
  const whole = Math.floor(g + ROUND_EPS);
  const gold = whole + (rng.chance(g - whole) ? 1 : 0);
  run.gold += gold;
  run.stats.kills++;
  run.stats.goldEarned += gold;

  let drop: KillReward['drop'] = null;
  if (rng.chance(enemy.dropChance)) {
    const rolled = rollDropItem(data, run.stageIndex, rng);
    if (rolled) {
      const stashed = addToStash(run.bag, rolled.defId, rolled.tier);
      if (stashed) {
        drop = { ...rolled, uid: stashed.uid, converted: false, convertedGold: 0 };
      } else {
        // 보관함이 가득 → 판매가만큼 환전
        const convertedGold = sellPrice(data.items[rolled.defId], rolled.tier);
        run.gold += convertedGold;
        run.stats.goldEarned += convertedGold;
        drop = { ...rolled, uid: null, converted: true, convertedGold };
      }
    }
  }
  run.rngState = rng.state;
  return { gold, drop };
}

export function completeStage(
  data: GameData,
  run: RunState,
  hpAfterCombat: number,
): { clearGold: number; healed: number; finished: boolean } {
  if (isRunComplete(data, run)) return { clearGold: 0, healed: 0, finished: true };

  const stage = currentStage(data, run);
  const player = runPlayerStats(data, run);

  const clearGold = roundGold(stage.clearGold * player.goldMul);
  run.gold += clearGold;
  run.stats.goldEarned += clearGold;

  // NaN이 들어오면 전투 전 hp 유지 (NaN이 세이브에 새면 JSON null → 로드 실패로 런 유실)
  const hpIn = Number.isNaN(hpAfterCombat) ? run.hp : hpAfterCombat;
  run.hp = Math.min(player.maxHp, Math.max(0, hpIn));
  const healed = Math.min(player.maxHp - run.hp, Math.round(player.maxHp * STAGE_CLEAR_HEAL_RATIO));
  run.hp += healed;

  run.stats.stagesCleared++;
  run.stageIndex++;

  const finished = isRunComplete(data, run);
  if (!finished) {
    rollShop(data, run, true);
    run.shop.rerollCost = SHOP_REROLL_BASE;
    run.shop.healBought = false;
    run.resumeAt = 'shop';
  }
  return { clearGold, healed, finished };
}

// ── 세이브 ───────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null ? localStorage : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInt(v: unknown, min: number, max = Infinity): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isTier(v: unknown): boolean {
  return v === 1 || v === 2 || v === 3;
}

// defId 존재·겹침은 GameData 없이는 확인할 수 없다. 여기선 로직이 터지거나 NaN이 새는 모양만 거른다.
function isBagShape(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const { cols, rows, items, stash, stashCapacity, nextUid } = v;
  if (!isInt(cols, 1, BAG_MAX_COLS) || !isInt(rows, 1, BAG_MAX_ROWS)) return false;
  if (!isInt(stashCapacity, 0) || !isInt(nextUid, 1)) return false;
  if (!Array.isArray(items) || !Array.isArray(stash)) return false;
  if (items.length > cols * rows || stash.length > stashCapacity) return false;

  const uids = new Set<number>();
  const itemOk = (it: unknown): it is Record<string, unknown> => {
    if (!isRecord(it) || !isInt(it.uid, 1, nextUid - 1) || uids.has(it.uid)) return false;
    uids.add(it.uid);
    return typeof it.defId === 'string' && isTier(it.tier);
  };
  return (
    items.every(
      (it) => itemOk(it) && isInt(it.x, 0, cols - 1) && isInt(it.y, 0, rows - 1) && isInt(it.rot, 0, 3),
    ) && stash.every(itemOk)
  );
}

function isShopShape(v: unknown): boolean {
  if (!isRecord(v) || !Array.isArray(v.slots) || v.slots.length !== SHOP_SLOTS) return false;
  const slotOk = (s: unknown): boolean =>
    s === null ||
    (isRecord(s) &&
      typeof s.defId === 'string' &&
      isTier(s.tier) &&
      isNum(s.price) &&
      s.price >= 0 &&
      typeof s.locked === 'boolean');
  return v.slots.every(slotOk) && isInt(v.rerollCost, 0) && typeof v.healBought === 'boolean';
}

function isRunShape(v: unknown): v is RunState {
  if (!isRecord(v) || v.version !== SAVE_VERSION) return false;
  const { stats } = v;
  return (
    typeof v.characterId === 'string' &&
    isInt(v.stageIndex, 0) &&
    (v.resumeAt === 'combat' || v.resumeAt === 'shop') &&
    isNum(v.gold) &&
    v.gold >= 0 &&
    isNum(v.hp) &&
    v.hp >= 0 &&
    isNum(v.rngState) &&
    isNum(v.seed) &&
    isBagShape(v.bag) &&
    isShopShape(v.shop) &&
    isRecord(stats) &&
    isNum(stats.kills) &&
    isNum(stats.goldEarned) &&
    isNum(stats.stagesCleared)
  );
}

export function saveRun(run: RunState): void {
  try {
    storage()?.setItem(SAVE_KEY, JSON.stringify(run));
  } catch {
    // 용량 초과·비공개 모드 등 — 세이브 없이 계속
  }
}

/** data를 넘기면 isRunValid까지 확인한다 (게임에서는 항상 넘길 것) */
export function loadRun(data?: GameData): RunState | null {
  try {
    const raw = storage()?.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRunShape(parsed)) return null;
    return data && !isRunValid(data, parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function clearRun(): void {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    // 무시
  }
}
