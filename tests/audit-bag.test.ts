// 가방/스탯 모듈 감사 테스트.
// 구현과 독립적으로 유도한 참조 구현(닫힌 형태 회전식, 칸 격자 기반 인접/점유, 정수 산술 내림)과
// 시드 고정 무작위 가방(실제 GAME_DATA)으로 차분 비교한다.

import { describe, expect, it } from 'vitest';
import {
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  BAG_START_COLS,
  BAG_START_ROWS,
  COOLDOWN_FLOOR_MUL,
  MAX_TIER,
  SELL_RATIO,
  STASH_CAPACITY,
  TIER_COOLDOWN_MUL,
  TIER_DAMAGE_MUL,
  TIER_EFFECT_MUL,
  TIER_PRICE_MUL,
} from '../src/config';
import { GAME_DATA } from '../src/data';
import {
  addNewToBag,
  addToStash,
  applyMerge,
  areAdjacent,
  bagItemsInOrder,
  canPlace,
  createBag,
  expandBag,
  findFreeSpot,
  findMerges,
  footprint,
  getOccupant,
  itemCells,
  itemSockets,
  moveItem,
  moveToStash,
  neighbors,
  placeFromStash,
  removeByUid,
  rotateLocalCell,
} from '../src/logic/bag';
import { Rng } from '../src/logic/rng';
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
  Cell,
  CharacterDef,
  Element,
  ItemDef,
  MergeOption,
  PlayerStats,
  RecipeDef,
  Rot,
  Tier,
  WeaponLoadout,
} from '../src/types';

const ITEMS = GAME_DATA.items;
const RECIPES = GAME_DATA.recipes;
const DATA = { items: ITEMS, recipes: RECIPES };
const IDS = Object.keys(ITEMS);
const ROTS: readonly Rot[] = [0, 1, 2, 3];
const TIERS: readonly Tier[] = [1, 2, 3];
const ELEMENT_ORDER: readonly Element[] = ['fire', 'ice', 'lightning'];
const RECIPE_PARTS = [...new Set(RECIPES.flatMap((r) => [r.base, r.ingredient]))];

const key = (x: number, y: number): string => `${x},${y}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── 참조 기하 (닫힌 형태) ─────────────────────────────────────

/** 시계방향(화면 y-아래) rot회: 1회 = (h-1-y, x), 2회 = 180°, 3회 = 반시계 1회 */
function refRot(c: Cell, w: number, h: number, rot: Rot): Cell {
  switch (rot) {
    case 0:
      return { x: c.x, y: c.y };
    case 1:
      return { x: h - 1 - c.y, y: c.x };
    case 2:
      return { x: w - 1 - c.x, y: h - 1 - c.y };
    case 3:
      return { x: c.y, y: w - 1 - c.x };
  }
}

/** 방향 벡터를 화면 기준 시계방향으로 rot회 */
function rotDir(d: Cell, rot: number): Cell {
  let { x, y } = d;
  for (let i = 0; i < rot; i++) [x, y] = [-y, x];
  return { x: x + 0, y: y + 0 }; // -0 제거
}

/** 회전 전 로컬 칸 전부를 회전시켜 놓은 절대 좌표 (footprint 교환 공식과 독립) */
function refCells(it: { x: number; y: number; rot: Rot }, def: ItemDef): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < def.h; y++) {
    for (let x = 0; x < def.w; x++) {
      const r = refRot({ x, y }, def.w, def.h, it.rot);
      out.push({ x: it.x + r.x, y: it.y + r.y });
    }
  }
  return out;
}

function refSockets(it: BagItem, def: ItemDef): Cell[] {
  return (def.sockets ?? []).map((s) => {
    const r = refRot(s, def.w, def.h, it.rot);
    return { x: it.x + r.x, y: it.y + r.y };
  });
}

function refGrid(bag: BagState, items: Record<string, ItemDef>, ignoreUid?: number): Map<string, BagItem> {
  const g = new Map<string, BagItem>();
  for (const it of bag.items) {
    if (it.uid === ignoreUid) continue;
    for (const c of refCells(it, items[it.defId])) g.set(key(c.x, c.y), it);
  }
  return g;
}

function refCanPlace(
  bag: BagState,
  items: Record<string, ItemDef>,
  defId: string,
  x: number,
  y: number,
  rot: number,
  ignoreUid?: number,
): boolean {
  const def = items[defId];
  if (!def || !ROTS.includes(rot as Rot) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const g = refGrid(bag, items, ignoreUid);
  return refCells({ x, y, rot: rot as Rot }, def).every(
    (c) => c.x >= 0 && c.y >= 0 && c.x < bag.cols && c.y < bag.rows && !g.has(key(c.x, c.y)),
  );
}

function refAdjacent(a: BagItem, aDef: ItemDef, b: BagItem, bDef: ItemDef): boolean {
  if (a.uid === b.uid) return false;
  const bs = new Set(refCells(b, bDef).map((c) => key(c.x, c.y)));
  return refCells(a, aDef).some(
    (c) => bs.has(key(c.x + 1, c.y)) || bs.has(key(c.x - 1, c.y)) || bs.has(key(c.x, c.y + 1)) || bs.has(key(c.x, c.y - 1)),
  );
}

const readingOrder = (a: BagItem, b: BagItem): number => a.y - b.y || a.x - b.x;

// ── 참조 합성 ────────────────────────────────────────────────

function refFindMerges(bag: BagState, items: Record<string, ItemDef>, recipes: RecipeDef[]): MergeOption[] {
  const g = refGrid(bag, items);
  const found = new Map<string, MergeOption>();
  for (const base of bag.items) {
    const def = items[base.defId];
    for (const s of refSockets(base, def)) {
      if (s.x < 0 || s.y < 0 || s.x >= bag.cols || s.y >= bag.rows) continue;
      const occ = g.get(key(s.x, s.y));
      if (!occ || occ.uid === base.uid) continue;
      for (const r of recipes) {
        const res = items[r.result];
        if (r.base !== base.defId || r.ingredient !== occ.defId || !res || res.w !== def.w || res.h !== def.h) continue;
        const k = `recipe:${base.uid}:${occ.uid}`;
        if (found.has(k)) continue;
        found.set(k, {
          kind: 'recipe',
          anchorUid: base.uid,
          consumedUid: occ.uid,
          resultDefId: r.result,
          resultTier: base.tier,
          recipeId: r.id,
        });
      }
    }
  }
  for (const a of bag.items) {
    for (const b of bag.items) {
      if (a.uid >= b.uid || a.defId !== b.defId || a.tier !== b.tier || a.tier >= MAX_TIER) continue;
      if (!refAdjacent(a, items[a.defId], b, items[b.defId])) continue;
      found.set(`tier:${a.uid}:${b.uid}`, {
        kind: 'tier',
        anchorUid: a.uid,
        consumedUid: b.uid,
        resultDefId: a.defId,
        resultTier: (a.tier + 1) as Tier,
      });
    }
  }
  const rank = (o: MergeOption): number => (o.kind === 'recipe' ? 0 : 1);
  return [...found.values()].sort((p, q) => rank(p) - rank(q) || p.anchorUid - q.anchorUid || p.consumedUid - q.consumedUid);
}

// ── 참조 스탯 ────────────────────────────────────────────────

function refPlayerRaw(ch: CharacterDef, bag: BagState): PlayerStats {
  let hp = 0;
  let ms = 0;
  let regen = 0;
  let gold = 0;
  let dmg = 0;
  for (const it of bag.items) {
    const d = ITEMS[it.defId];
    if (d.kind !== 'gear' || !d.gear) continue;
    const m = TIER_EFFECT_MUL[it.tier];
    hp += (d.gear.maxHpAdd ?? 0) * m;
    ms += (d.gear.moveSpeedMul ?? 0) * m;
    regen += (d.gear.regenPerSec ?? 0) * m;
    gold += (d.gear.goldMul ?? 0) * m;
    dmg += (d.gear.damageMul ?? 0) * m;
  }
  const p = ch.passive;
  return {
    maxHp: (ch.baseMaxHp + hp) * (1 + (p.maxHpMul ?? 0)), // 반올림 전
    moveSpeed: ch.baseMoveSpeed * (1 + (p.moveSpeedMul ?? 0) + ms),
    regenPerSec: regen,
    goldMul: 1 + (p.goldMul ?? 0) + gold,
    damageMul: 1 + (p.damageMul ?? 0) + dmg,
    cooldownMul: 1 + (p.cooldownMul ?? 0),
  };
}

function refWeapon(bag: BagState, uid: number, player: PlayerStats): WeaponLoadout | null {
  const it = bag.items.find((i) => i.uid === uid);
  if (!it) return null;
  const def = ITEMS[it.defId];
  if (def.kind !== 'weapon' || !def.weapon) return null;
  let dmgB = 0;
  let cdB = 0;
  // ★배수를 10배 정수로 다뤄 내림을 정확히 계산 (1, 1.6, 2.2 → 10, 16, 22)
  let count10 = 0;
  let pierce10 = 0;
  const els = new Set<Element>(def.weapon.element ? [def.weapon.element] : []);
  for (const nb of bag.items) {
    const nd = ITEMS[nb.defId];
    if (nd.kind !== 'stone' || !nd.stone || !refAdjacent(it, def, nb, nd)) continue;
    const m = TIER_EFFECT_MUL[nb.tier];
    const m10 = Math.round(m * 10);
    dmgB += (nd.stone.damageMul ?? 0) * m;
    cdB += (nd.stone.cooldownMul ?? 0) * m;
    count10 += (nd.stone.projectileCountAdd ?? 0) * m10;
    pierce10 += (nd.stone.pierceAdd ?? 0) * m10;
    if (nd.stone.element) els.add(nd.stone.element);
  }
  const p = def.weapon.projectile;
  return {
    uid,
    defId: it.defId,
    tier: it.tier,
    cooldown: def.weapon.cooldown * TIER_COOLDOWN_MUL[it.tier] * Math.max(COOLDOWN_FLOOR_MUL, (1 + cdB) * player.cooldownMul),
    damage: p.damage * TIER_DAMAGE_MUL[it.tier] * (1 + dmgB) * player.damageMul,
    count: p.count + Math.floor(count10 / 10),
    spreadDeg: p.spreadDeg,
    speed: p.speed,
    radius: p.radius,
    pierce: p.pierce + Math.floor(pierce10 / 10),
    maxBounces: p.maxBounces,
    elements: ELEMENT_ORDER.filter((e) => els.has(e)),
    explodeRadius: p.explodeRadius ?? 0,
    split: p.split ?? null,
    sprite: p.sprite,
    spin: p.spin ?? false,
  };
}

function expectWeaponClose(got: WeaponLoadout | null, want: WeaponLoadout | null): void {
  if (want === null) {
    expect(got).toBeNull();
    return;
  }
  expect(got).not.toBeNull();
  const { damage, cooldown, ...rest } = got!;
  const { damage: wd, cooldown: wc, ...wantRest } = want;
  expect(rest).toEqual(wantRest);
  expect(damage).toBeCloseTo(wd, 9);
  expect(cooldown).toBeCloseTo(wc, 9);
  expect(Number.isFinite(damage) && Number.isFinite(cooldown)).toBe(true);
  expect(cooldown).toBeGreaterThan(0);
  expect(Number.isInteger(got!.count) && Number.isInteger(got!.pierce)).toBe(true);
}

// ── 무작위 가방 ──────────────────────────────────────────────

function randomTier(rng: Rng): Tier {
  return rng.chance(0.55) ? 1 : rng.pick(TIERS);
}

function randomBag(seed: number): BagState {
  const rng = new Rng(seed);
  const bag = createBag(rng.int(BAG_START_COLS, BAG_MAX_COLS), rng.int(BAG_START_ROWS, BAG_MAX_ROWS), rng.int(0, STASH_CAPACITY));
  // 합성 쌍이 자주 생기도록 종류를 좁힌 풀 + 레시피 재료
  const pool = Array.from({ length: rng.int(2, 6) }, () => rng.pick(IDS));
  const attempts = rng.int(0, 45);
  for (let i = 0; i < attempts; i++) {
    const defId = rng.chance(0.35) ? rng.pick(RECIPE_PARTS) : rng.pick(pool);
    addNewToBag(bag, ITEMS, defId, randomTier(rng), rng.int(0, bag.cols - 1), rng.int(0, bag.rows - 1), rng.pick(ROTS));
  }
  const stashN = rng.int(0, bag.stashCapacity);
  for (let i = 0; i < stashN; i++) addToStash(bag, rng.pick(IDS), randomTier(rng));
  return bag;
}

function shuffled<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** uid 고유, uid < nextUid, 보관함 용량, 범위 안, 겹침 없음, 칸 집합이 회전 공식과 일치 */
function expectConsistent(bag: BagState): void {
  const uids = [...bag.items.map((i) => i.uid), ...bag.stash.map((s) => s.uid)];
  expect(new Set(uids).size).toBe(uids.length);
  for (const u of uids) expect(u).toBeLessThan(bag.nextUid);
  expect(bag.stash.length).toBeLessThanOrEqual(bag.stashCapacity);
  const seen = new Set<string>();
  for (const it of bag.items) {
    expect(ROTS).toContain(it.rot);
    expect(TIERS).toContain(it.tier);
    for (const c of refCells(it, ITEMS[it.defId])) {
      expect(c.x >= 0 && c.y >= 0 && c.x < bag.cols && c.y < bag.rows).toBe(true);
      expect(seen.has(key(c.x, c.y))).toBe(false);
      seen.add(key(c.x, c.y));
    }
  }
}

const SEEDS = Array.from({ length: 400 }, (_, i) => 0x9e3779b1 ^ (i * 7919));

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ═════════════════════════════════════════════════════════════
// 기하
// ═════════════════════════════════════════════════════════════

describe('audit: rotation & sockets', () => {
  const SHAPES: [number, number][] = [[1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [2, 2], [3, 2], [2, 3]];

  it('rotateLocalCell equals the closed-form rotation for in-frame and out-of-frame cells', () => {
    for (const [w, h] of SHAPES) {
      for (const rot of ROTS) {
        for (let y = -2; y <= h + 1; y++) {
          for (let x = -2; x <= w + 1; x++) {
            expect(rotateLocalCell({ x, y }, w, h, rot)).toEqual(refRot({ x, y }, w, h, rot));
          }
        }
      }
    }
  });

  it('rotateLocalCell does not mutate its input cell', () => {
    const c = Object.freeze({ x: 2, y: 0 });
    expect(() => rotateLocalCell(c, 2, 1, 3)).not.toThrow();
    expect(c).toEqual({ x: 2, y: 0 });
  });

  it('itemCells equals the rotated local footprint (top-left anchored) for every rot', () => {
    for (const [w, h] of SHAPES) {
      const d = { ...ITEMS.w_hairball, id: 'tmp', w, h };
      for (const rot of ROTS) {
        const it: BagItem = { uid: 1, defId: 'tmp', tier: 1, x: 3, y: 4, rot };
        const got = itemCells(it, d).map((c) => key(c.x, c.y)).sort();
        const want = refCells(it, d).map((c) => key(c.x, c.y)).sort();
        expect(got).toEqual(want);
        const fp = footprint(d, rot);
        expect(Math.min(...itemCells(it, d).map((c) => c.x))).toBe(3);
        expect(Math.min(...itemCells(it, d).map((c) => c.y))).toBe(4);
        expect(got).toHaveLength(fp.w * fp.h);
      }
    }
  });

  it('a full ring of sockets rotates onto the ring of the rotated footprint, keeping each outward direction (synthetic shapes)', () => {
    for (const [w, h] of SHAPES) {
      const ring: Cell[] = [];
      for (let x = 0; x < w; x++) ring.push({ x, y: -1 }, { x, y: h });
      for (let y = 0; y < h; y++) ring.push({ x: -1, y }, { x: w, y });
      const d: ItemDef = { ...ITEMS.w_hairball, id: 'ring', w, h, sockets: ring };
      for (const rot of ROTS) {
        const it: BagItem = { uid: 1, defId: 'ring', tier: 1, x: 5, y: 5, rot };
        const cells = itemCells(it, d);
        const cellSet = new Set(cells.map((c) => key(c.x, c.y)));
        const socks = itemSockets(it, d);
        // 회전 후 footprint의 둘레와 같은 집합
        const fp = footprint(d, rot);
        const wantRing = new Set<string>();
        for (let x = 0; x < fp.w; x++) wantRing.add(key(5 + x, 4)).add(key(5 + x, 5 + fp.h));
        for (let y = 0; y < fp.h; y++) wantRing.add(key(4, 5 + y)).add(key(5 + fp.w, 5 + y));
        expect(new Set(socks.map((s) => key(s.x, s.y)))).toEqual(wantRing);
        // 소켓마다: 원래 붙어 있던 칸과 방향이 같이 회전
        ring.forEach((s, i) => {
          const dir = s.y === -1 ? { x: 0, y: -1 } : s.y === h ? { x: 0, y: 1 } : s.x === -1 ? { x: -1, y: 0 } : { x: 1, y: 0 };
          const owner = { x: s.x - dir.x, y: s.y - dir.y };
          const ownerAbs = { x: 5 + refRot(owner, w, h, rot).x, y: 5 + refRot(owner, w, h, rot).y };
          expect(cellSet.has(key(ownerAbs.x, ownerAbs.y))).toBe(true);
          expect({ x: socks[i].x - ownerAbs.x, y: socks[i].y - ownerAbs.y }).toEqual(rotDir(dir, rot));
          expect(cellSet.has(key(socks[i].x, socks[i].y))).toBe(false);
        });
      }
    }
  });

  it('real item sockets stay outside and edge-adjacent for all 4 rotations, matching the closed form', () => {
    let checked = 0;
    for (const d of Object.values(ITEMS)) {
      if (!d.sockets) continue;
      for (const rot of ROTS) {
        const it: BagItem = { uid: 1, defId: d.id, tier: 1, x: 4, y: 4, rot };
        const cells = new Set(itemCells(it, d).map((c) => key(c.x, c.y)));
        const socks = itemSockets(it, d);
        expect(socks).toEqual(refSockets(it, d));
        for (const s of socks) {
          expect(cells.has(key(s.x, s.y))).toBe(false);
          const touching = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => cells.has(key(s.x + dx, s.y + dy)));
          expect(touching.length).toBeGreaterThan(0);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('concrete non-square sockets: duck (1×2, socket right of bottom cell) in all 4 rotations', () => {
    const duck = ITEMS.w_duck;
    const at = (rot: Rot): Cell[] => itemSockets({ uid: 1, defId: 'w_duck', tier: 1, x: 2, y: 2, rot }, duck);
    // rot0: 세로 (2,2),(2,3) → 아래 칸 오른쪽 (3,3)
    expect(at(0)).toEqual([{ x: 3, y: 3 }]);
    // rot1(시계): 가로 (2,2),(3,2), 원래 아래 칸이 왼쪽 → 그 칸의 '오른쪽'이 '아래'로 → (2,3)
    expect(at(1)).toEqual([{ x: 2, y: 3 }]);
    // rot2: 세로, 원래 아래 칸이 위 → '오른쪽'이 '왼쪽'으로 → (1,2)
    expect(at(2)).toEqual([{ x: 1, y: 2 }]);
    // rot3(반시계): 가로, 원래 아래 칸이 오른쪽 → '오른쪽'이 '위'로 → (3,1)
    expect(at(3)).toEqual([{ x: 3, y: 1 }]);
  });
});

// ═════════════════════════════════════════════════════════════
// 점유 / 배치 / 인접 (무작위 차분)
// ═════════════════════════════════════════════════════════════

describe('audit: occupancy, placement and adjacency vs. cell-grid reference', () => {
  it('random bags stay consistent; getOccupant matches the grid on and around the bag', () => {
    for (const seed of SEEDS) {
      const bag = randomBag(seed);
      expectConsistent(bag);
      const g = refGrid(bag, ITEMS);
      for (let y = -1; y <= bag.rows; y++) {
        for (let x = -1; x <= bag.cols; x++) {
          expect(getOccupant(bag, ITEMS, x, y)).toBe(g.get(key(x, y)) ?? null);
        }
      }
    }
  });

  it('canPlace agrees with the reference for every def, cell and rotation (with and without ignoreUid)', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const bag = randomBag(seed);
      const rng = new Rng(seed + 1);
      const ignore = bag.items.length ? rng.pick(bag.items).uid : undefined;
      for (const defId of IDS) {
        for (const rot of ROTS) {
          for (let y = -1; y <= bag.rows; y++) {
            for (let x = -1; x <= bag.cols; x++) {
              expect(canPlace(bag, ITEMS, defId, x, y, rot)).toBe(refCanPlace(bag, ITEMS, defId, x, y, rot));
              expect(canPlace(bag, ITEMS, defId, x, y, rot, ignore)).toBe(refCanPlace(bag, ITEMS, defId, x, y, rot, ignore));
            }
          }
        }
      }
    }
  });

  it('findFreeSpot returns the first rot-0 row-major spot, then rot 1, else null', () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const bag = randomBag(seed);
      for (const defId of IDS) {
        let want: { x: number; y: number; rot: Rot } | null = null;
        outer: for (const rot of [0, 1] as const) {
          for (let y = 0; y < bag.rows; y++) {
            for (let x = 0; x < bag.cols; x++) {
              if (refCanPlace(bag, ITEMS, defId, x, y, rot)) {
                want = { x, y, rot };
                break outer;
              }
            }
          }
        }
        expect(findFreeSpot(bag, ITEMS, defId)).toEqual(want);
      }
    }
  });

  it('areAdjacent matches cell-level edge sharing for random multi-cell, rotated pairs (symmetric)', () => {
    const shapes: ItemDef[] = [[1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [2, 2], [3, 2], [2, 3]].map(([w, h], i) => ({
      ...ITEMS.w_hairball,
      id: `s${i}`,
      w,
      h,
    }));
    const rng = new Rng(12345);
    let adjacentSeen = 0;
    let diagonalSeen = 0;
    for (let n = 0; n < 20000; n++) {
      const ad = rng.pick(shapes);
      const bd = rng.pick(shapes);
      const a: BagItem = { uid: 1, defId: ad.id, tier: 1, x: rng.int(0, 6), y: rng.int(0, 6), rot: rng.pick(ROTS) };
      const b: BagItem = { uid: 2, defId: bd.id, tier: 1, x: rng.int(0, 6), y: rng.int(0, 6), rot: rng.pick(ROTS) };
      const as = new Set(refCells(a, ad).map((c) => key(c.x, c.y)));
      if (refCells(b, bd).some((c) => as.has(key(c.x, c.y)))) continue; // 겹침은 가방에서 불가능
      const want = refAdjacent(a, ad, b, bd);
      expect(areAdjacent(a, ad, b, bd)).toBe(want);
      expect(areAdjacent(b, bd, a, ad)).toBe(want);
      if (want) adjacentSeen++;
      else {
        // 대각선만 맞닿은 경우가 실제로 섞여 있는지
        const diag = refCells(a, ad).some((c) =>
          [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dx, dy]) => refCells(b, bd).some((d) => d.x === c.x + dx && d.y === c.y + dy)),
        );
        if (diag) diagonalSeen++;
      }
    }
    expect(adjacentSeen).toBeGreaterThan(1000);
    expect(diagonalSeen).toBeGreaterThan(100);
  });

  it('neighbors equals the brute-force edge neighbours in reading order', () => {
    for (const seed of SEEDS) {
      const bag = randomBag(seed);
      for (const it of bag.items) {
        const want = bag.items
          .filter((o) => refAdjacent(it, ITEMS[it.defId], o, ITEMS[o.defId]))
          .sort(readingOrder);
        expect(neighbors(bag, ITEMS, it.uid)).toEqual(want);
      }
      for (const s of bag.stash) expect(neighbors(bag, ITEMS, s.uid)).toEqual([]);
    }
  });

  it('bagItemsInOrder is (y, x) order, a fresh array, independent of items[] order', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const bag = randomBag(seed);
      const order = bagItemsInOrder(bag);
      expect(order).not.toBe(bag.items);
      expect(order).toEqual([...bag.items].sort(readingOrder));
      const permuted = { ...bag, items: shuffled(bag.items, new Rng(seed)) };
      expect(bagItemsInOrder(permuted).map((i) => i.uid)).toEqual(order.map((i) => i.uid));
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 변경 함수: 무작위 연산 퍼징 (실패 시 상태 불변, 성공 시 사후조건)
// ═════════════════════════════════════════════════════════════

describe('audit: mutation fuzz', () => {
  it('every op agrees with the reference predicate; failures leave the bag untouched', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const rng = new Rng(seed);
      const bag = randomBag(seed);
      const anyUid = (): number => {
        const all = [...bag.items.map((i) => i.uid), ...bag.stash.map((s) => s.uid)];
        return all.length && rng.chance(0.85) ? rng.pick(all) : rng.int(-1, bag.nextUid + 2);
      };
      const coord = (max: number): number => (rng.chance(0.08) ? rng.pick([-1, 0.5, max, NaN]) : rng.int(0, max - 1));
      const rot = (): Rot => (rng.chance(0.05) ? (rng.pick([4, -1, 1.5]) as Rot) : rng.pick(ROTS));

      for (let step = 0; step < 150; step++) {
        const before = clone(bag);
        const op = rng.int(0, 7);
        let ok: boolean;
        if (op === 0) {
          const defId = rng.pick(IDS);
          const tier = randomTier(rng);
          const res = addToStash(bag, defId, tier);
          ok = res !== null;
          expect(ok).toBe(before.stash.length < before.stashCapacity);
          if (res) {
            expect(res).toEqual({ uid: before.nextUid, defId, tier });
            expect(bag.stash[bag.stash.length - 1]).toBe(res);
            expect(bag.nextUid).toBe(before.nextUid + 1);
          }
        } else if (op === 1) {
          const defId = rng.chance(0.03) ? 'nope' : rng.pick(IDS);
          const [x, y, r, t] = [coord(bag.cols), coord(bag.rows), rot(), randomTier(rng)];
          const res = addNewToBag(bag, ITEMS, defId, t, x, y, r);
          ok = res !== null;
          expect(ok).toBe(refCanPlace(before, ITEMS, defId, x, y, r));
          if (res) expect(res).toEqual({ uid: before.nextUid, defId, tier: t, x, y, rot: r });
        } else if (op === 2) {
          const uid = anyUid();
          const [x, y, r] = [coord(bag.cols), coord(bag.rows), rot()];
          ok = placeFromStash(bag, ITEMS, uid, x, y, r);
          const s = before.stash.find((i) => i.uid === uid);
          expect(ok).toBe(!!s && refCanPlace(before, ITEMS, s.defId, x, y, r));
          if (ok) {
            expect(bag.items[bag.items.length - 1]).toEqual({ ...s, x, y, rot: r });
            expect(bag.stash.map((i) => i.uid)).toEqual(before.stash.filter((i) => i.uid !== uid).map((i) => i.uid));
          }
        } else if (op === 3) {
          const uid = anyUid();
          const [x, y, r] = [coord(bag.cols), coord(bag.rows), rot()];
          ok = moveItem(bag, ITEMS, uid, x, y, r);
          const it = before.items.find((i) => i.uid === uid);
          expect(ok).toBe(!!it && refCanPlace(before, ITEMS, it.defId, x, y, r, uid));
          if (ok) expect(bag.items.find((i) => i.uid === uid)).toEqual({ ...it, x, y, rot: r });
        } else if (op === 4) {
          const uid = anyUid();
          ok = moveToStash(bag, uid);
          const it = before.items.find((i) => i.uid === uid);
          expect(ok).toBe(!!it && before.stash.length < before.stashCapacity);
          if (ok) expect(bag.stash[bag.stash.length - 1]).toEqual({ uid, defId: it!.defId, tier: it!.tier });
        } else if (op === 5) {
          const uid = anyUid();
          const res = removeByUid(bag, uid);
          ok = res !== null;
          const was = before.items.find((i) => i.uid === uid) ?? before.stash.find((i) => i.uid === uid) ?? null;
          expect(res).toEqual(was);
        } else if (op === 6) {
          const dir = rng.chance(0.5) ? 'col' : 'row';
          ok = expandBag(bag, dir);
          expect(ok).toBe(dir === 'col' ? before.cols < BAG_MAX_COLS : before.rows < BAG_MAX_ROWS);
          if (ok) expect(bag.items).toEqual(before.items);
        } else {
          const opts = findMerges(bag, DATA);
          if (opts.length === 0) {
            ok = false;
          } else {
            const o = rng.pick(opts);
            ok = applyMerge(bag, DATA, o, rng.chance(0.5) ? o.consumedUid : undefined) !== null;
            expect(ok).toBe(true);
          }
        }
        if (!ok) expect(bag).toEqual(before);
        expect(bag.nextUid).toBeGreaterThanOrEqual(before.nextUid);
        expectConsistent(bag);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 합성
// ═════════════════════════════════════════════════════════════

describe('audit: findMerges / applyMerge', () => {
  it('findMerges equals the brute-force reference on random bags and never mutates the bag', () => {
    let recipes = 0;
    let tiers = 0;
    let sharedAnchor = 0;
    for (const seed of SEEDS) {
      const bag = randomBag(seed);
      const before = clone(bag);
      const got = findMerges(bag, DATA);
      expect(got).toEqual(refFindMerges(bag, ITEMS, RECIPES));
      expect(bag).toEqual(before);
      recipes += got.filter((o) => o.kind === 'recipe').length;
      tiers += got.filter((o) => o.kind === 'tier').length;
      const anchors = got.map((o) => o.anchorUid);
      if (new Set(anchors).size < anchors.length) sharedAnchor++;
    }
    // 퍼징이 의미 있으려면 두 종류가 모두 충분히 나와야 한다
    expect(recipes).toBeGreaterThan(30);
    expect(tiers).toBeGreaterThan(200);
    expect(sharedAnchor).toBeGreaterThan(10);
  });

  it('findMerges is independent of the order of bag.items', () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const bag = randomBag(seed);
      const permuted = { ...bag, items: shuffled(bag.items, new Rng(~seed)) };
      expect(findMerges(permuted, DATA)).toEqual(findMerges(bag, DATA));
    }
  });

  it('applyMerge performs every current option exactly as specified (with each override variant)', () => {
    let applied = 0;
    for (const seed of SEEDS.slice(0, 200)) {
      const bag = randomBag(seed);
      for (const opt of findMerges(bag, DATA)) {
        const outsider = bag.items.find((i) => i.uid !== opt.anchorUid && i.uid !== opt.consumedUid)?.uid;
        for (const override of [undefined, opt.anchorUid, opt.consumedUid, outsider, 99999]) {
          const b = clone(bag);
          const res = applyMerge(b, DATA, clone(opt), override);
          expect(res).not.toBeNull();
          applied++;
          const keepUid = opt.kind === 'tier' && override === opt.consumedUid ? opt.consumedUid : opt.anchorUid;
          const dropUid = keepUid === opt.anchorUid ? opt.consumedUid : opt.anchorUid;
          const orig = bag.items.find((i) => i.uid === keepUid)!;
          expect(res).toEqual(
            opt.kind === 'tier'
              ? { ...orig, tier: orig.tier + 1 }
              : { ...orig, defId: opt.resultDefId },
          );
          expect(b.items.includes(res!)).toBe(true);
          expect(b.items.find((i) => i.uid === dropUid)).toBeUndefined();
          // 나머지는 그대로, 순서도 그대로
          expect(b.items.filter((i) => i.uid !== keepUid)).toEqual(bag.items.filter((i) => i.uid !== keepUid && i.uid !== dropUid));
          expect(b.stash).toEqual(bag.stash);
          expect([b.cols, b.rows, b.stashCapacity, b.nextUid]).toEqual([bag.cols, bag.rows, bag.stashCapacity, bag.nextUid]);
          expectConsistent(b);
          // 재적용은 거부, 상태 불변
          const after = clone(b);
          expect(applyMerge(b, DATA, opt, override)).toBeNull();
          expect(b).toEqual(after);
        }
      }
    }
    expect(applied).toBeGreaterThan(500);
  });

  it('applyMerge rejects forged/stale options without touching the bag', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const rng = new Rng(seed);
      const bag = randomBag(seed);
      const current = findMerges(bag, DATA);
      const uids = bag.items.map((i) => i.uid);
      if (uids.length < 2) continue;
      for (let n = 0; n < 15; n++) {
        const forged: MergeOption = {
          kind: rng.chance(0.5) ? 'tier' : 'recipe',
          anchorUid: rng.pick(uids),
          consumedUid: rng.pick(uids),
          resultDefId: rng.pick(IDS),
          resultTier: rng.pick(TIERS),
          ...(rng.chance(0.5) ? { recipeId: rng.pick(RECIPES).id } : {}),
        };
        const isCurrent = current.some((o) => JSON.stringify(o) === JSON.stringify(forged));
        const before = clone(bag);
        const res = applyMerge(bag, DATA, forged, rng.pick(uids));
        if (!isCurrent) {
          expect(res).toBeNull();
          expect(bag).toEqual(before);
        } else {
          break; // 우연히 유효한 옵션이 나오면 이 가방은 건너뛴다
        }
      }
    }
  });

  it('a stale ★2 option is rejected after both items were upgraded elsewhere (no surprise ★3)', () => {
    const bag = createBag();
    const a = addNewToBag(bag, ITEMS, 'w_yuzu', 1, 0, 0, 0)!;
    const b = addNewToBag(bag, ITEMS, 'w_yuzu', 1, 1, 0, 0)!;
    const c = addNewToBag(bag, ITEMS, 'w_yuzu', 1, 0, 1, 0)!;
    const d = addNewToBag(bag, ITEMS, 'w_yuzu', 1, 1, 1, 0)!;
    const pick = (x: number, y: number): MergeOption => findMerges(bag, DATA).find((o) => o.anchorUid === x && o.consumedUid === y)!;
    const stale = pick(a.uid, b.uid);
    expect(stale.resultTier).toBe(2);
    expect(applyMerge(bag, DATA, pick(a.uid, c.uid))).not.toBeNull();
    expect(applyMerge(bag, DATA, pick(b.uid, d.uid))).not.toBeNull();
    expect(findMerges(bag, DATA)).toEqual([{ ...stale, resultTier: 3 }]);
    const before = clone(bag);
    expect(applyMerge(bag, DATA, stale)).toBeNull();
    expect(bag).toEqual(before);
  });

  it('a recipe option is matched by recipeId too, not only by uids and result', () => {
    const recipes: RecipeDef[] = [
      { id: 'r_first', base: 'w_yuzu', ingredient: 's_fire', result: 'w_yuzu_molotov' },
      { id: 'r_dup', base: 'w_yuzu', ingredient: 's_fire', result: 'w_yuzu_molotov' },
    ];
    const bag = createBag();
    addNewToBag(bag, ITEMS, 'w_yuzu', 1, 0, 0, 0);
    addNewToBag(bag, ITEMS, 's_fire', 1, 0, 1, 0);
    const [opt] = findMerges(bag, { items: ITEMS, recipes });
    expect(opt.recipeId).toBe('r_first');
    const before = clone(bag);
    expect(applyMerge(bag, { items: ITEMS, recipes }, { ...opt, recipeId: 'r_dup' })).toBeNull();
    expect(bag).toEqual(before);
  });

  it('tier merge at MAX_TIER is never offered, recipe keeps a ★3 base at ★3', () => {
    const bag = createBag();
    addNewToBag(bag, ITEMS, 'w_yuzu', 3, 0, 0, 0);
    addNewToBag(bag, ITEMS, 'w_yuzu', 3, 1, 0, 0);
    expect(findMerges(bag, DATA)).toEqual([]);
    const base = addNewToBag(bag, ITEMS, 'w_yuzu', 3, 3, 0, 0)!; // 소켓 (0,1) → (3,1)
    const fire = addNewToBag(bag, ITEMS, 's_fire', 3, 3, 1, 0)!;
    const [opt] = findMerges(bag, DATA);
    expect(opt).toMatchObject({ kind: 'recipe', anchorUid: base.uid, consumedUid: fire.uid, resultTier: 3 });
    expect(applyMerge(bag, DATA, opt)).toEqual({ ...base, defId: 'w_yuzu_molotov', tier: 3 });
  });

  it('starting kits: capybara can ★merge at once, penguin needs to move the ice stone onto the socket', () => {
    const kit = (id: string): BagState => {
      const bag = createBag();
      for (const s of GAME_DATA.characters[id].startItems) {
        expect(addNewToBag(bag, ITEMS, s.defId, s.tier ?? 1, s.x, s.y, s.rot)).not.toBeNull();
      }
      return bag;
    };
    expect(findMerges(kit('capybara'), DATA).map((o) => o.kind)).toEqual(['tier']);
    expect(findMerges(kit('cat'), DATA)).toEqual([]);
    const pen = kit('penguin');
    expect(findMerges(pen, DATA)).toEqual([]);
    const ice = pen.items.find((i) => i.defId === 's_ice')!;
    expect(moveItem(pen, ITEMS, ice.uid, 3, 1, 0)).toBe(true); // 생선 (1..2,1) 오른쪽 끝 옆
    expect(findMerges(pen, DATA).map((o) => o.recipeId)).toEqual(['r_tuna_missile']);
  });

  // ── 버그 재현: 레시피 결과가 base와 크기가 다르면(데이터 오류) 제자리 진화가 겹침/범위 밖을 만든다 ──
  it('never offers a recipe whose result footprint differs from the base (would corrupt the bag)', () => {
    const items: Record<string, ItemDef> = {
      ...ITEMS,
      w_small: { ...ITEMS.w_hairball, id: 'w_small', w: 1, h: 1, sockets: [{ x: 1, y: 0 }] },
      w_huge: { ...ITEMS.w_hairball, id: 'w_huge', w: 2, h: 2, sockets: undefined, shopWeight: 0 },
    };
    const recipes: RecipeDef[] = [{ id: 'r_bad', base: 'w_small', ingredient: 's_fire', result: 'w_huge' }];
    const bag = createBag();
    const base = addNewToBag(bag, items, 'w_small', 1, 0, 0, 0)!;
    addNewToBag(bag, items, 's_fire', 1, 1, 0, 0);
    const blocker = addNewToBag(bag, items, 'g_sneakers', 1, 0, 1, 0)!; // 2×2로 커지면 덮이는 칸
    const data = { items, recipes };
    const before = clone(bag);
    const opts = findMerges(bag, data);
    expect(opts).toEqual([]);
    // 옵션을 위조해서 넣어도 상태는 그대로
    const forged: MergeOption = { kind: 'recipe', anchorUid: base.uid, consumedUid: before.items[1].uid, resultDefId: 'w_huge', resultTier: 1, recipeId: 'r_bad' };
    expect(applyMerge(bag, data, forged)).toBeNull();
    expect(bag).toEqual(before);
    expect(getOccupant(bag, items, 0, 1)).toBe(bag.items.find((i) => i.uid === blocker.uid));
  });

  it('findMerges stays fast on a packed max-size bag', () => {
    const bag = createBag(BAG_MAX_COLS, BAG_MAX_ROWS);
    for (let y = 0; y < BAG_MAX_ROWS; y++) {
      for (let x = 0; x < BAG_MAX_COLS; x++) addNewToBag(bag, ITEMS, (x + y) % 3 ? 'w_hairball' : 's_lightning', 1, x, y, 0);
    }
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 200; i++) n += findMerges(bag, DATA).length;
    const ms = performance.now() - t0;
    expect(n).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });
});

// ═════════════════════════════════════════════════════════════
// 스탯
// ═════════════════════════════════════════════════════════════

const CHARS = Object.values(GAME_DATA.characters);

function randomCharacter(rng: Rng): CharacterDef {
  const base = rng.pick(CHARS);
  if (rng.chance(0.5)) return base;
  return {
    ...base,
    passive: {
      cooldownMul: rng.chance(0.5) ? -rng.pick([0.1, 0.3, 0.5, 0.7]) : undefined,
      maxHpMul: rng.chance(0.5) ? rng.pick([0.1, 0.2, 0.4]) : undefined,
      moveSpeedMul: rng.chance(0.5) ? rng.pick([0.1, 0.2]) : undefined,
      damageMul: rng.chance(0.5) ? rng.pick([0.05, 0.3]) : undefined,
      goldMul: rng.chance(0.5) ? 0.25 : undefined,
    },
  };
}

describe('audit: stats vs. documented formulas', () => {
  it('scaledStone / scaledGear index TIER_EFFECT_MUL by tier and keep element (frozen inputs)', () => {
    for (const d of Object.values(ITEMS)) {
      for (const t of TIERS) {
        if (d.stone) {
          const s = scaledStone(deepFreeze(clone(d.stone)), t);
          for (const [k, v] of Object.entries(d.stone)) {
            if (typeof v === 'number') expect((s as Record<string, number>)[k]).toBeCloseTo(v * TIER_EFFECT_MUL[t], 12);
            else expect((s as Record<string, unknown>)[k]).toBe(v);
          }
          expect(Object.keys(s).sort()).toEqual(Object.keys(d.stone).sort());
        }
        if (d.gear) {
          const g = scaledGear(deepFreeze(clone(d.gear)), t);
          for (const [k, v] of Object.entries(d.gear)) expect((g as Record<string, number>)[k]).toBeCloseTo((v as number) * TIER_EFFECT_MUL[t], 12);
        }
      }
    }
  });

  it('computePlayerStats matches the formula; stash gear is ignored', () => {
    for (const seed of SEEDS) {
      const rng = new Rng(seed);
      const bag = randomBag(seed);
      const ch = randomCharacter(rng);
      const got = computePlayerStats(ch, bag, ITEMS);
      const raw = refPlayerRaw(ch, bag);
      expect(Number.isInteger(got.maxHp)).toBe(true);
      expect(Math.abs(got.maxHp - raw.maxHp)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(got.moveSpeed).toBeCloseTo(raw.moveSpeed, 9);
      expect(got.regenPerSec).toBeCloseTo(raw.regenPerSec, 9);
      expect(got.goldMul).toBeCloseTo(raw.goldMul, 9);
      expect(got.damageMul).toBeCloseTo(raw.damageMul, 9);
      expect(got.cooldownMul).toBeCloseTo(raw.cooldownMul, 12);
      for (const v of Object.values(got)) expect(Number.isFinite(v)).toBe(true);
      // 보관함은 아무리 바뀌어도 영향 없음
      const swapped = { ...bag, stash: [{ uid: 777, defId: 'g_potlid', tier: 3 as Tier }, { uid: 778, defId: 'g_piggybank', tier: 3 as Tier }] };
      expect(computePlayerStats(ch, swapped, ITEMS)).toEqual(got);
      // 가방 배열 순서와 무관 (정확히 같은 값)
      const permuted = { ...bag, items: shuffled(bag.items, rng) };
      expect(computePlayerStats(ch, permuted, ITEMS)).toEqual(got);
    }
  });

  it('moving gear bag → stash removes exactly its contribution; moving it back restores the stats', () => {
    const ch = GAME_DATA.characters.capybara;
    const bag = createBag(5, 4, 8);
    const lid = addNewToBag(bag, ITEMS, 'g_potlid', 2, 0, 0, 1)!; // 1×2 → rot1 가로
    addNewToBag(bag, ITEMS, 'g_sneakers', 3, 2, 0, 0);
    const full = computePlayerStats(ch, bag, ITEMS);
    expect(full.maxHp).toBe(Math.round((100 + 25 * TIER_EFFECT_MUL[2]) * 1.4));
    expect(moveToStash(bag, lid.uid)).toBe(true);
    const without = computePlayerStats(ch, bag, ITEMS);
    expect(without.maxHp).toBe(140);
    expect(without.moveSpeed).toBe(full.moveSpeed);
    expect(placeFromStash(bag, ITEMS, lid.uid, 0, 3, 3)).toBe(true);
    expect(computePlayerStats(ch, bag, ITEMS)).toEqual(full);
  });

  it('computeWeapon / stoneBuffsFor / computeLoadout match the formulas on random bags', () => {
    let floored = 0;
    let clamped = 0;
    for (const seed of SEEDS) {
      const rng = new Rng(seed);
      const bag = randomBag(seed);
      const ch = randomCharacter(rng);
      const player = deepFreeze(computePlayerStats(ch, bag, ITEMS));
      const snapshot = clone(bag);
      for (const it of bag.items) {
        const want = refWeapon(bag, it.uid, player);
        expectWeaponClose(computeWeapon(bag, ITEMS, it.uid, player), want);
        const b = stoneBuffsFor(bag, ITEMS, it.uid);
        const stones = neighbors(bag, ITEMS, it.uid).filter((n) => ITEMS[n.defId].kind === 'stone');
        expect(b.sourceUids).toEqual(stones.map((s) => s.uid));
        if (want) {
          if (stones.some((s) => s.tier > 1 && (ITEMS[s.defId].stone?.projectileCountAdd || ITEMS[s.defId].stone?.pierceAdd))) floored++;
          if ((1 + b.cooldownMul) * player.cooldownMul < COOLDOWN_FLOOR_MUL) clamped++;
        }
      }
      for (const s of bag.stash) expect(computeWeapon(bag, ITEMS, s.uid, player)).toBeNull();
      const loadout = computeLoadout(bag, ITEMS, player);
      const wantUids = [...bag.items].sort(readingOrder).filter((i) => ITEMS[i.defId].kind === 'weapon').map((i) => i.uid);
      expect(loadout.map((l) => l.uid)).toEqual(wantUids);
      expect(bag).toEqual(snapshot);
      // 배열 순서와 무관 (정확히 같은 값)
      const permuted = { ...bag, items: shuffled(bag.items, rng) };
      expect(computeLoadout(permuted, ITEMS, player)).toEqual(loadout);
    }
    expect(floored).toBeGreaterThan(20);
    expect(clamped).toBeGreaterThan(0);
  });

  it('cooldown floor: exact boundary cases with real stones and the cat passive', () => {
    const cat = GAME_DATA.characters.cat; // cooldownMul -0.15
    const catMul = 1 + cat.passive.cooldownMul!;
    const bag = createBag();
    const w = addNewToBag(bag, ITEMS, 'w_sock', 1, 1, 1, 0)!;
    const player = computePlayerStats(cat, bag, ITEMS);
    const cd = (): number => computeWeapon(bag, ITEMS, w.uid, player)!.cooldown;
    const base = ITEMS.w_sock.weapon!.cooldown;
    const haste3 = ITEMS.s_haste.stone!.cooldownMul! * TIER_EFFECT_MUL[3]; // -0.33
    expect(cd()).toBeCloseTo(base * catMul, 12);
    addNewToBag(bag, ITEMS, 's_haste', 3, 0, 1, 0); // 0.67 × 0.85 = 0.57 (하한 위)
    expect((1 + haste3) * catMul).toBeGreaterThan(COOLDOWN_FLOOR_MUL);
    expect(cd()).toBeCloseTo(base * (1 + haste3) * catMul, 12);
    addNewToBag(bag, ITEMS, 's_haste', 3, 2, 1, 0); // 0.34 × 0.85 = 0.289 < 0.35
    expect((1 + 2 * haste3) * catMul).toBeLessThan(COOLDOWN_FLOOR_MUL);
    expect(cd()).toBeCloseTo(base * COOLDOWN_FLOOR_MUL, 12);
    addNewToBag(bag, ITEMS, 's_haste', 3, 1, 0, 0);
    addNewToBag(bag, ITEMS, 's_haste', 3, 1, 2, 0); // 1 - 1.32 < 0 → 음수여도 하한
    expect(cd()).toBeCloseTo(base * COOLDOWN_FLOOR_MUL, 12);
    expect(cd()).toBeGreaterThan(0);
  });

  it('weapon outputs never alias data (split, elements) and survive frozen data', () => {
    const items = deepFreeze(clone(ITEMS));
    const bag = createBag();
    const duck = addNewToBag(bag, items, 'w_duck', 2, 0, 0, 0)!;
    addNewToBag(bag, items, 's_fire', 1, 1, 0, 0);
    const player = deepFreeze(computePlayerStats(GAME_DATA.characters.cat, bag, items));
    const a = computeWeapon(bag, items, duck.uid, player)!;
    const b = computeWeapon(bag, items, duck.uid, player)!;
    expect(a.split).not.toBe(items.w_duck.weapon!.projectile.split);
    expect(a.split).not.toBe(b.split);
    expect(a.elements).not.toBe(b.elements);
    a.elements.push('ice');
    expect(b.elements).toEqual(['fire']);
    expect(computeLoadout(bag, items, player)).toHaveLength(1);
  });

  it('itemPrice / sellPrice follow TIER_PRICE_MUL and SELL_RATIO for all real items', () => {
    for (const d of Object.values(ITEMS)) {
      for (const t of TIERS) {
        expect(itemPrice(d, t)).toBe(d.price * TIER_PRICE_MUL[t]);
        expect(sellPrice(d, t)).toBe(Math.max(1, Math.floor(d.price * TIER_PRICE_MUL[t] * SELL_RATIO)));
        expect(Number.isInteger(sellPrice(d, t))).toBe(true);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 기본값 / 경계
// ═════════════════════════════════════════════════════════════

describe('audit: defaults and bounds', () => {
  it('createBag returns independent arrays each call', () => {
    const a = createBag();
    const b = createBag();
    expect(a.items).not.toBe(b.items);
    expect(a.stash).not.toBe(b.stash);
    expect([a.cols, a.rows, a.stashCapacity]).toEqual([BAG_START_COLS, BAG_START_ROWS, STASH_CAPACITY]);
  });

  it('expandBag refuses beyond the max without changing state, even from an oversized bag', () => {
    const bag = createBag(BAG_MAX_COLS + 1, BAG_MAX_ROWS);
    const before = clone(bag);
    expect(expandBag(bag, 'col')).toBe(false);
    expect(expandBag(bag, 'row')).toBe(false);
    expect(bag).toEqual(before);
  });
});
