import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_FLOOR_MUL,
  SELL_RATIO,
  TIER_COOLDOWN_MUL,
  TIER_DAMAGE_MUL,
  TIER_EFFECT_MUL,
  TIER_PRICE_MUL,
} from '../src/config';
import { addNewToBag, addToStash, createBag } from '../src/logic/bag';
import {
  computeLoadout,
  computePlayerStats,
  computeWeapon,
  itemPrice,
  scaledGear,
  scaledStone,
  sellPrice,
  stoneBuffsFor,
} from '../src/logic/stats';
import type {
  BagItem,
  BagState,
  CharacterDef,
  ItemDef,
  PlayerStats,
  ProjectileSpec,
  Rot,
  Tier,
  WeaponDef,
} from '../src/types';

// ── 테스트 전용 최소 픽스처 ─────────────────────────────────

function def(id: string, kind: ItemDef['kind'], w: number, h: number, extra: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    kind,
    name: id,
    desc: '',
    rarity: 'common',
    w,
    h,
    icon: id,
    price: 10,
    shopWeight: 1,
    minStage: 0,
    ...extra,
  };
}

function weapon(cooldown: number, proj: Partial<ProjectileSpec> = {}, element?: WeaponDef['element']): WeaponDef {
  return {
    cooldown,
    element,
    projectile: {
      sprite: 'p_basic',
      radius: 9,
      speed: 650,
      damage: 10,
      count: 1,
      spreadDeg: 0,
      pierce: 0,
      maxBounces: 3,
      ...proj,
    },
  };
}

const SPLIT = { count: 3, damageMul: 0.4, sprite: 'p_child', radius: 5 };

const ITEMS: Record<string, ItemDef> = {
  w_basic: def('w_basic', 'weapon', 1, 1, { weapon: weapon(1) }),
  w_ice: def('w_ice', 'weapon', 1, 1, { weapon: weapon(2, {}, 'ice') }),
  w_fancy: def('w_fancy', 'weapon', 2, 2, {
    weapon: weapon(1.5, { count: 3, spreadDeg: 30, explodeRadius: 70, split: SPLIT, spin: true, pierce: 2, maxBounces: 0, sprite: 'p_fancy', radius: 14, speed: 500, damage: 7 }),
  }),
  w_big: def('w_big', 'weapon', 3, 2, { weapon: weapon(1) }),
  s_power: def('s_power', 'stone', 1, 1, { stone: { damageMul: 0.25 } }),
  s_haste: def('s_haste', 'stone', 1, 1, { stone: { cooldownMul: -0.15 } }),
  s_fire: def('s_fire', 'stone', 1, 1, { stone: { element: 'fire', damageMul: 0.1 } }),
  s_ice: def('s_ice', 'stone', 1, 1, { stone: { element: 'ice', damageMul: 0.1 } }),
  s_lightning: def('s_lightning', 'stone', 1, 1, { stone: { element: 'lightning', damageMul: 0.1 } }),
  s_mirror: def('s_mirror', 'stone', 1, 1, { stone: { projectileCountAdd: 1 } }),
  s_drill: def('s_drill', 'stone', 1, 1, { stone: { pierceAdd: 1 } }),
  s_tenth: def('s_tenth', 'stone', 1, 1, { stone: { projectileCountAdd: 0.1 } }),
  g_lid: def('g_lid', 'gear', 1, 2, { gear: { maxHpAdd: 25 } }),
  g_shoe: def('g_shoe', 'gear', 1, 1, { gear: { moveSpeedMul: 0.2 } }),
  g_band: def('g_band', 'gear', 1, 1, { gear: { regenPerSec: 1 } }),
  g_pig: def('g_pig', 'gear', 1, 1, { gear: { goldMul: 0.25 } }),
  g_glove: def('g_glove', 'gear', 1, 1, { gear: { damageMul: 0.1 } }),
};

function character(passive: CharacterDef['passive'] = {}, baseMaxHp = 100, baseMoveSpeed = 300): CharacterDef {
  return {
    id: 'c',
    name: 'c',
    desc: '',
    sprite: 'char_c',
    portrait: 'portrait_c',
    baseMaxHp,
    baseMoveSpeed,
    startItems: [],
    passive,
    passiveDesc: '',
  };
}

const BASE_PLAYER: PlayerStats = { maxHp: 100, moveSpeed: 300, regenPerSec: 0, goldMul: 1, damageMul: 1, cooldownMul: 1 };

function add(bag: BagState, defId: string, x: number, y: number, tier: Tier = 1, rot: Rot = 0): BagItem {
  const it = addNewToBag(bag, ITEMS, defId, tier, x, y, rot);
  if (!it) throw new Error(`fixture: cannot place ${defId} at ${x},${y}`);
  return it;
}

// ── 배율 적용 ────────────────────────────────────────────────

describe('scaledStone / scaledGear', () => {
  it('scales numeric stone fields by TIER_EFFECT_MUL, keeps element', () => {
    const e = { damageMul: 0.25, cooldownMul: -0.15, element: 'fire' as const, projectileCountAdd: 1, pierceAdd: 1 };
    expect(scaledStone(e, 1)).toEqual(e);
    for (const t of [2, 3] as Tier[]) {
      const m = TIER_EFFECT_MUL[t];
      const s = scaledStone(e, t);
      expect(s.damageMul).toBeCloseTo(0.25 * m);
      expect(s.cooldownMul).toBeCloseTo(-0.15 * m);
      expect(s.projectileCountAdd).toBeCloseTo(m);
      expect(s.pierceAdd).toBeCloseTo(m);
      expect(s.element).toBe('fire');
    }
    // 입력은 그대로
    expect(e.damageMul).toBe(0.25);
  });

  it('does not invent fields that were absent', () => {
    expect(Object.keys(scaledStone({ element: 'ice' }, 3))).toEqual(['element']);
    expect(Object.keys(scaledStone({ pierceAdd: 1 }, 2))).toEqual(['pierceAdd']);
    expect(Object.keys(scaledGear({ regenPerSec: 1 }, 2))).toEqual(['regenPerSec']);
  });

  it('scales every gear field', () => {
    const g = { maxHpAdd: 25, moveSpeedMul: 0.2, regenPerSec: 1, goldMul: 0.25, damageMul: 0.1 };
    expect(scaledGear(g, 1)).toEqual(g);
    const s = scaledGear(g, 2);
    expect(s.maxHpAdd).toBeCloseTo(25 * TIER_EFFECT_MUL[2]);
    expect(s.moveSpeedMul).toBeCloseTo(0.2 * TIER_EFFECT_MUL[2]);
    expect(s.regenPerSec).toBeCloseTo(TIER_EFFECT_MUL[2]);
    expect(s.goldMul).toBeCloseTo(0.25 * TIER_EFFECT_MUL[2]);
    expect(s.damageMul).toBeCloseTo(0.1 * TIER_EFFECT_MUL[2]);
  });
});

// ── 플레이어 ────────────────────────────────────────────────

describe('computePlayerStats', () => {
  it('returns base values with an empty bag and no passive', () => {
    expect(computePlayerStats(character(), createBag(), ITEMS)).toEqual(BASE_PLAYER);
  });

  it('applies character passives', () => {
    const p = computePlayerStats(
      character({ maxHpMul: 0.4, moveSpeedMul: 0.2, cooldownMul: -0.1, damageMul: 0.05, goldMul: 0.5 }),
      createBag(),
      ITEMS,
    );
    expect(p.maxHp).toBe(140);
    expect(p.moveSpeed).toBeCloseTo(360);
    expect(p.cooldownMul).toBeCloseTo(0.9);
    expect(p.damageMul).toBeCloseTo(1.05);
    expect(p.goldMul).toBeCloseTo(1.5);
    expect(p.regenPerSec).toBe(0);
  });

  it('rounds maxHp after the passive multiplier', () => {
    expect(computePlayerStats(character({ maxHpMul: 0.15 }, 101), createBag(), ITEMS).maxHp).toBe(116); // 116.15
    expect(computePlayerStats(character({ maxHpMul: 0.5 }, 101), createBag(), ITEMS).maxHp).toBe(152); // 151.5
  });

  it('sums tier-scaled gear in the bag', () => {
    const bag = createBag();
    add(bag, 'g_lid', 0, 0, 2); // +40 HP
    add(bag, 'g_shoe', 1, 0); // +0.2
    add(bag, 'g_shoe', 2, 0, 3); // +0.44
    add(bag, 'g_band', 3, 0, 2); // +1.6
    add(bag, 'g_band', 4, 0); // +1
    add(bag, 'g_pig', 1, 1, 3); // +0.55
    add(bag, 'g_glove', 2, 1, 2); // +0.16
    const p = computePlayerStats(character({ maxHpMul: 0.4, moveSpeedMul: 0.2, goldMul: 0.1, damageMul: 0.05 }), bag, ITEMS);
    expect(p.maxHp).toBe(Math.round((100 + 25 * TIER_EFFECT_MUL[2]) * 1.4)); // 196
    expect(p.moveSpeed).toBeCloseTo(300 * (1 + 0.2 + 0.2 + 0.2 * TIER_EFFECT_MUL[3]));
    expect(p.regenPerSec).toBeCloseTo(1 + TIER_EFFECT_MUL[2]);
    expect(p.goldMul).toBeCloseTo(1 + 0.1 + 0.25 * TIER_EFFECT_MUL[3]);
    expect(p.damageMul).toBeCloseTo(1 + 0.05 + 0.1 * TIER_EFFECT_MUL[2]);
    expect(p.cooldownMul).toBe(1); // 장비는 쿨에 영향 없음
  });

  it('ignores gear in the stash and non-gear items in the bag', () => {
    const bag = createBag();
    addToStash(bag, 'g_lid', 3);
    addToStash(bag, 'g_glove', 1);
    add(bag, 'w_basic', 0, 0);
    add(bag, 's_power', 1, 0);
    expect(computePlayerStats(character(), bag, ITEMS)).toEqual(BASE_PLAYER);
  });
});

// ── 돌 버프 ──────────────────────────────────────────────────

describe('stoneBuffsFor', () => {
  it('sums scaled effects of edge-adjacent stones only', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 2, 1);
    const p = add(bag, 's_power', 2, 0, 2); // 위
    const h = add(bag, 's_haste', 1, 1, 3); // 왼쪽
    add(bag, 's_power', 1, 0); // 대각
    add(bag, 's_power', 3, 0); // 대각
    addToStash(bag, 's_power', 3);
    const b = stoneBuffsFor(bag, ITEMS, w.uid);
    expect(b.damageMul).toBeCloseTo(0.25 * TIER_EFFECT_MUL[2]);
    expect(b.cooldownMul).toBeCloseTo(-0.15 * TIER_EFFECT_MUL[3]);
    expect(b.elements).toEqual([]);
    expect(b.countAdd).toBe(0);
    expect(b.pierceAdd).toBe(0);
    expect(b.sourceUids).toEqual([p.uid, h.uid]);
  });

  it('ignores adjacent non-stone items', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 0, 0);
    add(bag, 'w_basic', 1, 0);
    add(bag, 'g_glove', 0, 1);
    expect(stoneBuffsFor(bag, ITEMS, w.uid)).toEqual({
      damageMul: 0,
      cooldownMul: 0,
      elements: [],
      countAdd: 0,
      pierceAdd: 0,
      sourceUids: [],
    });
  });

  it('unions elements in fire, ice, lightning order without duplicates', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 1, 1);
    add(bag, 's_lightning', 1, 0);
    add(bag, 's_ice', 0, 1);
    add(bag, 's_fire', 2, 1);
    add(bag, 's_fire', 1, 2, 3);
    const b = stoneBuffsFor(bag, ITEMS, w.uid);
    expect(b.elements).toEqual(['fire', 'ice', 'lightning']);
    expect(b.damageMul).toBeCloseTo(0.1 * 3 + 0.1 * TIER_EFFECT_MUL[3]);
    expect(b.sourceUids).toHaveLength(4);
  });

  it('floors countAdd / pierceAdd after summing tier-scaled values', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 1, 1);
    add(bag, 's_mirror', 1, 0, 2); // 1.6
    add(bag, 's_mirror', 0, 1, 2); // 1.6 → 합 3.2 → 3 (각각 내림이면 2)
    add(bag, 's_drill', 2, 1, 3); // 2.2 → 2
    const b = stoneBuffsFor(bag, ITEMS, w.uid);
    expect(b.countAdd).toBe(3);
    expect(b.pierceAdd).toBe(2);
  });

  it('a single tier-2 mirror adds 1, tier-3 adds 2', () => {
    const bag = createBag();
    const w1 = add(bag, 'w_basic', 0, 0);
    add(bag, 's_mirror', 1, 0, 2);
    const w2 = add(bag, 'w_basic', 4, 3);
    add(bag, 's_mirror', 3, 3, 3);
    expect(stoneBuffsFor(bag, ITEMS, w1.uid).countAdd).toBe(1);
    expect(stoneBuffsFor(bag, ITEMS, w2.uid).countAdd).toBe(2);
  });

  it('is robust to floating point error when flooring', () => {
    // 3×2 무기 둘레 10칸 × 0.1 = 0.9999999999999999 → 1
    const bag = createBag();
    const w = add(bag, 'w_big', 1, 1);
    const ring = [[1, 0], [2, 0], [3, 0], [0, 1], [4, 1], [0, 2], [4, 2], [1, 3], [2, 3], [3, 3]];
    for (const [x, y] of ring) add(bag, 's_tenth', x, y);
    const b = stoneBuffsFor(bag, ITEMS, w.uid);
    expect(b.sourceUids).toHaveLength(10);
    expect(b.countAdd).toBe(1);
  });

  it('returns zero buffs for a uid not in the bag', () => {
    const bag = createBag();
    const s = addToStash(bag, 'w_basic', 1)!;
    expect(stoneBuffsFor(bag, ITEMS, s.uid).sourceUids).toEqual([]);
    expect(stoneBuffsFor(bag, ITEMS, 999).damageMul).toBe(0);
  });
});

// ── 무기 ─────────────────────────────────────────────────────

describe('computeWeapon', () => {
  it('copies projectile fields and applies defaults', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 0, 0);
    expect(computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)).toEqual({
      uid: w.uid,
      defId: 'w_basic',
      tier: 1,
      cooldown: 1,
      damage: 10,
      count: 1,
      spreadDeg: 0,
      speed: 650,
      radius: 9,
      pierce: 0,
      maxBounces: 3,
      elements: [],
      explodeRadius: 0,
      split: null,
      sprite: 'p_basic',
      spin: false,
    });
  });

  it('passes explodeRadius, split, spin and other projectile values through', () => {
    const bag = createBag();
    const w = add(bag, 'w_fancy', 0, 0, 2);
    const l = computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!;
    expect(l).toMatchObject({
      tier: 2,
      count: 3,
      spreadDeg: 30,
      speed: 500,
      radius: 14,
      pierce: 2,
      maxBounces: 0,
      explodeRadius: 70,
      split: SPLIT,
      sprite: 'p_fancy',
      spin: true,
    });
    expect(l.damage).toBeCloseTo(7 * TIER_DAMAGE_MUL[2]);
    expect(l.cooldown).toBeCloseTo(1.5 * TIER_COOLDOWN_MUL[2]);
  });

  it('scales damage and cooldown by tier', () => {
    for (const t of [1, 2, 3] as Tier[]) {
      const bag = createBag();
      const w = add(bag, 'w_basic', 0, 0, t);
      const l = computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!;
      expect(l.damage).toBeCloseTo(10 * TIER_DAMAGE_MUL[t]);
      expect(l.cooldown).toBeCloseTo(TIER_COOLDOWN_MUL[t]);
      expect(l.tier).toBe(t);
    }
  });

  it('multiplies stone damage buff and player damageMul', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 0, 0, 2);
    add(bag, 's_power', 1, 0);
    add(bag, 's_fire', 0, 1, 2);
    const player = { ...BASE_PLAYER, damageMul: 1.1 };
    const l = computeWeapon(bag, ITEMS, w.uid, player)!;
    expect(l.damage).toBeCloseTo(10 * TIER_DAMAGE_MUL[2] * (1 + 0.25 + 0.1 * TIER_EFFECT_MUL[2]) * 1.1);
  });

  it('multiplies stone cooldown buff and player cooldownMul', () => {
    const bag = createBag();
    const w = add(bag, 'w_ice', 0, 0, 3);
    add(bag, 's_haste', 1, 0);
    const player = { ...BASE_PLAYER, cooldownMul: 0.9 };
    const l = computeWeapon(bag, ITEMS, w.uid, player)!;
    expect(l.cooldown).toBeCloseTo(2 * TIER_COOLDOWN_MUL[3] * (1 - 0.15) * 0.9);
  });

  it('clamps the cooldown multiplier at COOLDOWN_FLOOR_MUL', () => {
    const bag = createBag();
    const w = add(bag, 'w_basic', 1, 1, 2);
    add(bag, 's_haste', 1, 0, 3);
    add(bag, 's_haste', 0, 1, 3);
    add(bag, 's_haste', 2, 1, 3); // 합 -0.99
    const l = computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!;
    expect(l.cooldown).toBeCloseTo(TIER_COOLDOWN_MUL[2] * COOLDOWN_FLOOR_MUL);

    // 돌 하나 + 강한 플레이어 쿨 감소로 하한에 걸림: (1-0.15) × 0.4 = 0.34 < 0.35
    const bag2 = createBag();
    const w2 = add(bag2, 'w_basic', 0, 0);
    add(bag2, 's_haste', 1, 0);
    const l2 = computeWeapon(bag2, ITEMS, w2.uid, { ...BASE_PLAYER, cooldownMul: 0.4 })!;
    expect(l2.cooldown).toBeCloseTo(COOLDOWN_FLOOR_MUL);

    // 하한 바로 위는 그대로
    const l3 = computeWeapon(bag2, ITEMS, w2.uid, { ...BASE_PLAYER, cooldownMul: 0.5 })!;
    expect(l3.cooldown).toBeCloseTo(0.85 * 0.5);
  });

  it('adds floored count / pierce buffs', () => {
    const bag = createBag();
    const w = add(bag, 'w_fancy', 1, 1); // count 3, pierce 2
    add(bag, 's_mirror', 1, 0, 3); // 2.2
    add(bag, 's_mirror', 2, 0, 2); // 1.6 → 3.8 → 3
    add(bag, 's_drill', 0, 1, 2); // 1.6 → 1
    const l = computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!;
    expect(l.count).toBe(6);
    expect(l.pierce).toBe(3);
  });

  it('merges intrinsic and stone elements in canonical order', () => {
    const bag = createBag();
    const w = add(bag, 'w_ice', 1, 1);
    add(bag, 's_lightning', 1, 0);
    add(bag, 's_fire', 0, 1);
    add(bag, 's_ice', 2, 1);
    expect(computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!.elements).toEqual(['fire', 'ice', 'lightning']);

    const bag2 = createBag();
    const w2 = add(bag2, 'w_ice', 0, 0);
    expect(computeWeapon(bag2, ITEMS, w2.uid, BASE_PLAYER)!.elements).toEqual(['ice']);
    add(bag2, 's_ice', 1, 0);
    expect(computeWeapon(bag2, ITEMS, w2.uid, BASE_PLAYER)!.elements).toEqual(['ice']);
  });

  it('returns null for non-weapons, stash items and unknown uids', () => {
    const bag = createBag();
    const s = add(bag, 's_power', 0, 0);
    const g = add(bag, 'g_lid', 1, 0);
    const st = addToStash(bag, 'w_basic', 1)!;
    expect(computeWeapon(bag, ITEMS, s.uid, BASE_PLAYER)).toBeNull();
    expect(computeWeapon(bag, ITEMS, g.uid, BASE_PLAYER)).toBeNull();
    expect(computeWeapon(bag, ITEMS, st.uid, BASE_PLAYER)).toBeNull();
    expect(computeWeapon(bag, ITEMS, 999, BASE_PLAYER)).toBeNull();
  });

  it('does not alias the data split spec', () => {
    const bag = createBag();
    const w = add(bag, 'w_fancy', 0, 0);
    const l = computeWeapon(bag, ITEMS, w.uid, BASE_PLAYER)!;
    l.split!.count = 99;
    expect(ITEMS.w_fancy.weapon!.projectile.split!.count).toBe(3);
  });
});

describe('computeLoadout', () => {
  it('lists bag weapons in reading order, skipping non-weapons and the stash', () => {
    const bag = createBag();
    const c = add(bag, 'w_ice', 0, 3);
    const b = add(bag, 'w_fancy', 2, 1);
    add(bag, 's_power', 1, 1);
    const a = add(bag, 'w_basic', 4, 0);
    add(bag, 'g_lid', 0, 0);
    addToStash(bag, 'w_basic', 1);
    const out = computeLoadout(bag, ITEMS, BASE_PLAYER);
    expect(out.map((l) => l.uid)).toEqual([a.uid, b.uid, c.uid]);
    // 버프 반영 확인 (s_power는 w_fancy 왼쪽)
    expect(out[1].damage).toBeCloseTo(7 * 1.25);
    expect(computeLoadout(createBag(), ITEMS, BASE_PLAYER)).toEqual([]);
  });
});

// ── 가격 ─────────────────────────────────────────────────────

describe('itemPrice / sellPrice', () => {
  it('multiplies price by TIER_PRICE_MUL', () => {
    const d = def('x', 'stone', 1, 1, { price: 7 });
    for (const t of [1, 2, 3] as Tier[]) expect(itemPrice(d, t)).toBe(7 * TIER_PRICE_MUL[t]);
  });

  it('sells for floor(price × SELL_RATIO), at least 1', () => {
    const d = def('x', 'stone', 1, 1, { price: 5 });
    for (const t of [1, 2, 3] as Tier[]) {
      expect(sellPrice(d, t)).toBe(Math.max(1, Math.floor(5 * TIER_PRICE_MUL[t] * SELL_RATIO)));
    }
    expect(sellPrice(d, 1)).toBe(2); // 2.5 → 2
    expect(sellPrice(def('y', 'stone', 1, 1, { price: 1 }), 1)).toBe(1); // 0.5 → 0 → 1
    expect(sellPrice(def('z', 'stone', 1, 1, { price: 0 }), 3)).toBe(1);
  });
});
