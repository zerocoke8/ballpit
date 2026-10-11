// 상점 굴리기·구매·판매·가방 확장·회복. 순수 로직 (PixiJS/DOM 금지).
// 런 상태를 직접 바꾸고 성공 여부를 반환한다. 실패하면 상태는 그대로다.

import {
  BAG_EXPAND_COSTS,
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  BAG_START_COLS,
  BAG_START_ROWS,
  HEAL_COST,
  HEAL_RATIO,
  SHOP_RARITY_WEIGHTS,
  SHOP_SLOTS,
} from '../config';
import type { GameData, ItemDef, Rarity, RunState, ShopSlot, Tier } from '../types';
import { addToStash, expandBag, findByUid, removeByUid } from './bag';
import { Rng } from './rng';
import { computePlayerStats, itemPrice, sellPrice } from './stats';

/** SHOP_RARITY_WEIGHTS의 열 순서 */
const RARITIES: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary'];
/** 이 스테이지 인덱스부터 상점에 ★2가 섞인다 */
const TIER2_MIN_STAGE = 3;
const TIER2_CHANCE = 0.1;

/** 상점·드롭에 나올 수 있는 아이템 (데이터 정의 순서) */
export function shopCandidates(data: GameData, stageIndex: number): ItemDef[] {
  return Object.values(data.items).filter((d) => d.shopWeight > 0 && d.minStage <= stageIndex);
}

/**
 * 상점·드롭 공용 희귀도 규칙으로 아이템 하나를 고른다. 후보가 없으면 null.
 * RNG 소비: 희귀도 1회 + 아이템 1회.
 */
export function rollItemDef(data: GameData, stageIndex: number, rng: Rng): ItemDef | null {
  const candidates = shopCandidates(data, stageIndex);
  const row = SHOP_RARITY_WEIGHTS[Math.max(0, Math.min(stageIndex, SHOP_RARITY_WEIGHTS.length - 1))];
  const rarity = rng.weighted(RARITIES, row);
  const ofRarity = candidates.filter((d) => d.rarity === rarity);
  const pool = ofRarity.length > 0 ? ofRarity : candidates;
  return rng.weighted(
    pool,
    pool.map((d) => d.shopWeight),
  );
}

/** NaN 골드나 음수 비용이면 false. `gold < cost` 비교는 NaN을 통과시켜 공짜 구매·골드 증식이 된다 */
function canAfford(run: RunState, cost: number): boolean {
  return cost >= 0 && run.gold >= cost;
}

function maxHpOf(data: GameData, run: RunState): number {
  const character = data.characters[run.characterId];
  if (!character) throw new Error(`shop: unknown character '${run.characterId}'`);
  return computePlayerStats(character, run.bag, data.items).maxHp;
}

export function rollShop(data: GameData, run: RunState, keepLocked = true): void {
  const rng = new Rng(run.rngState);
  const prev = run.shop.slots;
  const slots: (ShopSlot | null)[] = [];
  for (let i = 0; i < SHOP_SLOTS; i++) {
    const old = prev[i] ?? null;
    if (keepLocked && old?.locked) {
      slots.push(old);
      continue;
    }
    const def = rollItemDef(data, run.stageIndex, rng);
    if (!def) {
      slots.push(null);
      continue;
    }
    const tier: Tier = run.stageIndex >= TIER2_MIN_STAGE && rng.chance(TIER2_CHANCE) ? 2 : 1;
    slots.push({ defId: def.id, tier, price: itemPrice(def, tier), locked: false });
  }
  run.shop.slots = slots;
  run.rngState = rng.state;
}

export function rerollShop(data: GameData, run: RunState): boolean {
  const cost = run.shop.rerollCost;
  if (!canAfford(run, cost)) return false;
  run.gold -= cost;
  rollShop(data, run);
  run.shop.rerollCost = cost + 1;
  return true;
}

export function buySlot(data: GameData, run: RunState, index: number): boolean {
  const slot = run.shop.slots[index];
  if (!slot || !data.items[slot.defId] || !canAfford(run, slot.price)) return false;
  if (!addToStash(run.bag, slot.defId, slot.tier)) return false;
  run.gold -= slot.price;
  run.shop.slots[index] = null;
  return true;
}

export function toggleLock(run: RunState, index: number): void {
  const slot = run.shop.slots[index];
  if (slot) slot.locked = !slot.locked;
}

/** 가방/보관함에서 제거하고 판매가를 지급. 실패 시 0 */
export function sellItem(data: GameData, run: RunState, uid: number): number {
  const found = findByUid(run.bag, uid);
  if (!found) return 0;
  const def = data.items[found.item.defId];
  if (!def) return 0;
  const price = sellPrice(def, found.item.tier);
  removeByUid(run.bag, uid);
  run.gold += price;
  return price;
}

/** 다음 확장 비용. 가로·세로 모두 최대면 null */
export function bagExpandCost(run: RunState): number | null {
  const { cols, rows } = run.bag;
  if (cols >= BAG_MAX_COLS && rows >= BAG_MAX_ROWS) return null;
  const count = Math.max(0, cols - BAG_START_COLS) + Math.max(0, rows - BAG_START_ROWS);
  return BAG_EXPAND_COSTS[count] ?? null;
}

export function buyBagExpand(run: RunState, dir: 'col' | 'row'): boolean {
  const cost = bagExpandCost(run);
  if (cost === null || !canAfford(run, cost)) return false;
  if (!expandBag(run.bag, dir)) return false;
  run.gold -= cost;
  return true;
}

export function canBuyHeal(data: GameData, run: RunState): boolean {
  return !run.shop.healBought && run.hp < maxHpOf(data, run) && canAfford(run, HEAL_COST);
}

export function buyHeal(data: GameData, run: RunState): boolean {
  if (!canBuyHeal(data, run)) return false;
  const maxHp = maxHpOf(data, run);
  run.gold -= HEAL_COST;
  run.hp = Math.min(maxHp, run.hp + Math.round(maxHp * HEAL_RATIO));
  run.shop.healBought = true;
  return true;
}
