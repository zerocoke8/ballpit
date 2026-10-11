// 유효 스탯(플레이어/무기) 계산과 가격. 순수 로직 (PixiJS/DOM 금지).

import {
  COOLDOWN_FLOOR_MUL,
  SELL_RATIO,
  TIER_COOLDOWN_MUL,
  TIER_DAMAGE_MUL,
  TIER_EFFECT_MUL,
  TIER_PRICE_MUL,
} from '../config';
import type {
  BagState,
  CharacterDef,
  Element,
  GearEffect,
  ItemDef,
  PlayerStats,
  StoneEffect,
  Tier,
  WeaponLoadout,
} from '../types';
import { bagItemsInOrder, neighbors } from './bag';

type ItemMap = Record<string, ItemDef>;

export interface StoneBuffs {
  damageMul: number;
  cooldownMul: number;
  elements: Element[];
  countAdd: number;
  pierceAdd: number;
  sourceUids: number[];
}

const ELEMENT_ORDER: readonly Element[] = ['fire', 'ice', 'lightning'];
// ★배수(1.6 등) 합산 오차로 2.9999…가 2로 내려가지 않게
const FLOOR_EPS = 1e-9;

/** 숫자 필드만 mul배, 그 외(element 등)는 그대로. undefined 필드는 생략 */
function scaleNumeric<T extends object>(effect: T, mul: number): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effect)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'number' ? v * mul : v;
  }
  return out as T;
}

function sortElements(set: Iterable<Element>): Element[] {
  const has = new Set(set);
  return ELEMENT_ORDER.filter((e) => has.has(e));
}

export function scaledStone(effect: StoneEffect, tier: Tier): StoneEffect {
  return scaleNumeric(effect, TIER_EFFECT_MUL[tier]);
}

export function scaledGear(effect: GearEffect, tier: Tier): GearEffect {
  return scaleNumeric(effect, TIER_EFFECT_MUL[tier]);
}

export function computePlayerStats(
  character: CharacterDef,
  bag: BagState,
  items: ItemMap,
): PlayerStats {
  let maxHpAdd = 0;
  let moveSpeedMul = 0;
  let regenPerSec = 0;
  let goldMul = 0;
  let damageMul = 0;
  // 가방 안 장비만 (보관함 제외)
  for (const it of bagItemsInOrder(bag)) {
    const def = items[it.defId];
    if (!def || def.kind !== 'gear' || !def.gear) continue;
    const g = scaledGear(def.gear, it.tier);
    maxHpAdd += g.maxHpAdd ?? 0;
    moveSpeedMul += g.moveSpeedMul ?? 0;
    regenPerSec += g.regenPerSec ?? 0;
    goldMul += g.goldMul ?? 0;
    damageMul += g.damageMul ?? 0;
  }
  const p = character.passive;
  return {
    maxHp: Math.round((character.baseMaxHp + maxHpAdd) * (1 + (p.maxHpMul ?? 0))),
    moveSpeed: character.baseMoveSpeed * (1 + (p.moveSpeedMul ?? 0) + moveSpeedMul),
    regenPerSec,
    goldMul: 1 + (p.goldMul ?? 0) + goldMul,
    damageMul: 1 + (p.damageMul ?? 0) + damageMul,
    cooldownMul: 1 + (p.cooldownMul ?? 0),
  };
}

export function stoneBuffsFor(bag: BagState, items: ItemMap, uid: number): StoneBuffs {
  let damageMul = 0;
  let cooldownMul = 0;
  let count = 0;
  let pierce = 0;
  const elements = new Set<Element>();
  const sourceUids: number[] = [];
  for (const nb of neighbors(bag, items, uid)) {
    const def = items[nb.defId];
    if (!def || def.kind !== 'stone' || !def.stone) continue;
    const s = scaledStone(def.stone, nb.tier);
    damageMul += s.damageMul ?? 0;
    cooldownMul += s.cooldownMul ?? 0;
    count += s.projectileCountAdd ?? 0;
    pierce += s.pierceAdd ?? 0;
    if (s.element) elements.add(s.element);
    sourceUids.push(nb.uid);
  }
  return {
    damageMul,
    cooldownMul,
    elements: sortElements(elements),
    countAdd: Math.floor(count + FLOOR_EPS),
    pierceAdd: Math.floor(pierce + FLOOR_EPS),
    sourceUids,
  };
}

/** 가방 안의 무기만 계산. 보관함에 있거나 무기가 아니면 null */
export function computeWeapon(
  bag: BagState,
  items: ItemMap,
  uid: number,
  player: PlayerStats,
): WeaponLoadout | null {
  const item = bag.items.find((it) => it.uid === uid);
  if (!item) return null;
  const def = items[item.defId];
  const weapon = def?.weapon;
  if (!def || def.kind !== 'weapon' || !weapon) return null;

  const proj = weapon.projectile;
  const buffs = stoneBuffsFor(bag, items, uid);
  const cdMul = Math.max(COOLDOWN_FLOOR_MUL, (1 + buffs.cooldownMul) * player.cooldownMul);
  const elements = weapon.element ? [weapon.element, ...buffs.elements] : buffs.elements;

  return {
    uid: item.uid,
    defId: item.defId,
    tier: item.tier,
    cooldown: weapon.cooldown * TIER_COOLDOWN_MUL[item.tier] * cdMul,
    damage: proj.damage * TIER_DAMAGE_MUL[item.tier] * (1 + buffs.damageMul) * player.damageMul,
    count: proj.count + buffs.countAdd,
    spreadDeg: proj.spreadDeg,
    speed: proj.speed,
    radius: proj.radius,
    pierce: proj.pierce + buffs.pierceAdd,
    maxBounces: proj.maxBounces,
    elements: sortElements(elements),
    explodeRadius: proj.explodeRadius ?? 0,
    split: proj.split ? { ...proj.split } : null,
    sprite: proj.sprite,
    spin: proj.spin ?? false,
  };
}

export function computeLoadout(bag: BagState, items: ItemMap, player: PlayerStats): WeaponLoadout[] {
  const out: WeaponLoadout[] = [];
  for (const it of bagItemsInOrder(bag)) {
    const w = computeWeapon(bag, items, it.uid, player);
    if (w) out.push(w);
  }
  return out;
}

export function itemPrice(def: ItemDef, tier: Tier): number {
  return def.price * TIER_PRICE_MUL[tier];
}

export function sellPrice(def: ItemDef, tier: Tier): number {
  return Math.max(1, Math.floor(itemPrice(def, tier) * SELL_RATIO));
}
