import { describe, expect, it } from 'vitest';
import {
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  BAG_START_COLS,
  BAG_START_ROWS,
  STASH_CAPACITY,
} from '../src/config';
import {
  addNewToBag,
  addToStash,
  applyMerge,
  areAdjacent,
  bagItemsInOrder,
  canPlace,
  createBag,
  expandBag,
  findByUid,
  findFreeSpot,
  findMerges,
  footprint,
  getOccupant,
  itemCells,
  itemSockets,
  mergesFor,
  moveItem,
  moveToStash,
  neighbors,
  placeFromStash,
  removeByUid,
  rotateLocalCell,
} from '../src/logic/bag';
import type { BagItem, BagState, Cell, ItemDef, MergeOption, RecipeDef, Rot } from '../src/types';

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
    price: 5,
    shopWeight: 1,
    minStage: 0,
    ...extra,
  };
}

const weapon = { cooldown: 1, projectile: { sprite: 'p', radius: 8, speed: 600, damage: 10, count: 1, spreadDeg: 0, pierce: 0, maxBounces: 0 } };

const ITEMS: Record<string, ItemDef> = {
  hair: def('hair', 'weapon', 1, 1, { weapon, sockets: [{ x: 1, y: 0 }] }),
  // 2×1: 오른쪽 끝 옆, 왼쪽 칸 아래
  fish: def('fish', 'weapon', 2, 1, { weapon, sockets: [{ x: 2, y: 0 }, { x: 0, y: 1 }] }),
  // 2×1: 아래 두 칸 모두 소켓 (2칸짜리 재료가 둘 다 덮는 경우)
  long: def('long', 'weapon', 2, 1, { weapon, sockets: [{ x: 0, y: 1 }, { x: 1, y: 1 }] }),
  toaster: def('toaster', 'weapon', 2, 2, { weapon }),
  fish_ice: def('fish_ice', 'weapon', 2, 1, { weapon, shopWeight: 0 }),
  hair_fire: def('hair_fire', 'weapon', 1, 1, { weapon, shopWeight: 0 }),
  long_plus: def('long_plus', 'weapon', 2, 1, { weapon, shopWeight: 0 }),
  s_ice: def('s_ice', 'stone', 1, 1, { stone: { element: 'ice' } }),
  s_fire: def('s_fire', 'stone', 1, 1, { stone: { element: 'fire' } }),
  bar: def('bar', 'stone', 2, 1, { stone: { damageMul: 0.1 } }),
  lid: def('lid', 'gear', 1, 2, { gear: { maxHpAdd: 25 } }),
};

const RECIPES: RecipeDef[] = [
  { id: 'r_fish_ice', base: 'fish', ingredient: 's_ice', result: 'fish_ice' },
  { id: 'r_hair_fire', base: 'hair', ingredient: 's_fire', result: 'hair_fire' },
  { id: 'r_long_bar', base: 'long', ingredient: 'bar', result: 'long_plus' },
];

const DATA = { items: ITEMS, recipes: RECIPES };

function add(bag: BagState, defId: string, x: number, y: number, rot: Rot = 0, tier: 1 | 2 | 3 = 1): BagItem {
  const it = addNewToBag(bag, ITEMS, defId, tier, x, y, rot);
  if (!it) throw new Error(`fixture: cannot place ${defId} at ${x},${y} rot ${rot}`);
  return it;
}

function snapshot(bag: BagState): BagState {
  return JSON.parse(JSON.stringify(bag)) as BagState;
}

/** uid 고유, nextUid보다 작음, 범위 안, 겹침 없음 */
function expectConsistent(bag: BagState): void {
  const uids = [...bag.items.map((i) => i.uid), ...bag.stash.map((s) => s.uid)];
  expect(new Set(uids).size).toBe(uids.length);
  for (const u of uids) expect(u).toBeLessThan(bag.nextUid);
  expect(bag.stash.length).toBeLessThanOrEqual(bag.stashCapacity);
  const seen = new Set<string>();
  for (const it of bag.items) {
    for (const c of itemCells(it, ITEMS[it.defId])) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(bag.cols);
      expect(c.y).toBeLessThan(bag.rows);
      const key = `${c.x},${c.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  }
}

const sortCells = (cells: Cell[]): Cell[] => [...cells].sort((a, b) => a.y - b.y || a.x - b.x);

// ── 생성 / 기하 ──────────────────────────────────────────────

describe('createBag', () => {
  it('uses config defaults', () => {
    const bag = createBag();
    expect(bag).toEqual({
      cols: BAG_START_COLS,
      rows: BAG_START_ROWS,
      items: [],
      stash: [],
      stashCapacity: STASH_CAPACITY,
      nextUid: bag.nextUid,
    });
    expect(Number.isInteger(bag.nextUid)).toBe(true);
  });

  it('accepts explicit size and stash capacity', () => {
    const bag = createBag(3, 2, 1);
    expect([bag.cols, bag.rows, bag.stashCapacity]).toEqual([3, 2, 1]);
  });
});

describe('footprint', () => {
  it('swaps w/h on odd rotations only', () => {
    const fish = ITEMS.fish;
    expect(footprint(fish, 0)).toEqual({ w: 2, h: 1 });
    expect(footprint(fish, 1)).toEqual({ w: 1, h: 2 });
    expect(footprint(fish, 2)).toEqual({ w: 2, h: 1 });
    expect(footprint(fish, 3)).toEqual({ w: 1, h: 2 });
    expect(footprint(ITEMS.toaster, 1)).toEqual({ w: 2, h: 2 });
  });
});

describe('rotateLocalCell', () => {
  it('rotates cells inside a 2×1 frame clockwise', () => {
    // 왼쪽 칸: 위 → 오른쪽 → 아래
    expect(rotateLocalCell({ x: 0, y: 0 }, 2, 1, 0)).toEqual({ x: 0, y: 0 });
    expect(rotateLocalCell({ x: 0, y: 0 }, 2, 1, 1)).toEqual({ x: 0, y: 0 });
    expect(rotateLocalCell({ x: 0, y: 0 }, 2, 1, 2)).toEqual({ x: 1, y: 0 });
    expect(rotateLocalCell({ x: 0, y: 0 }, 2, 1, 3)).toEqual({ x: 0, y: 1 });
    expect(rotateLocalCell({ x: 1, y: 0 }, 2, 1, 1)).toEqual({ x: 0, y: 1 });
  });

  it('rotates sockets outside the footprint (right → bottom → left → top)', () => {
    const right = { x: 2, y: 0 };
    expect(rotateLocalCell(right, 2, 1, 0)).toEqual({ x: 2, y: 0 });
    expect(rotateLocalCell(right, 2, 1, 1)).toEqual({ x: 0, y: 2 });
    expect(rotateLocalCell(right, 2, 1, 2)).toEqual({ x: -1, y: 0 });
    expect(rotateLocalCell(right, 2, 1, 3)).toEqual({ x: 0, y: -1 });

    const belowLeft = { x: 0, y: 1 };
    expect(rotateLocalCell(belowLeft, 2, 1, 1)).toEqual({ x: -1, y: 0 });
    expect(rotateLocalCell(belowLeft, 2, 1, 2)).toEqual({ x: 1, y: -1 });
    expect(rotateLocalCell(belowLeft, 2, 1, 3)).toEqual({ x: 1, y: 1 });
  });

  it('handles a non-square 3×2 frame', () => {
    const topRight = { x: 2, y: 0 };
    expect(rotateLocalCell(topRight, 3, 2, 1)).toEqual({ x: 1, y: 2 });
    expect(rotateLocalCell(topRight, 3, 2, 2)).toEqual({ x: 0, y: 1 });
    expect(rotateLocalCell(topRight, 3, 2, 3)).toEqual({ x: 0, y: 0 });
  });

  it('maps a footprint bijectively onto the rotated footprint', () => {
    for (const [w, h] of [[1, 1], [2, 1], [1, 3], [3, 2], [2, 2]]) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        const fw = rot % 2 ? h : w;
        const fh = rot % 2 ? w : h;
        const out = new Set<string>();
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const c = rotateLocalCell({ x, y }, w, h, rot);
            expect(c.x >= 0 && c.x < fw && c.y >= 0 && c.y < fh).toBe(true);
            out.add(`${c.x},${c.y}`);
          }
        }
        expect(out.size).toBe(w * h);
      }
    }
  });

  it('composes: rot a then rot b equals rot (a+b) mod 4', () => {
    const c = { x: 3, y: -1 };
    const w = 3;
    const h = 2;
    for (const a of [0, 1, 2, 3] as Rot[]) {
      for (const b of [0, 1, 2, 3] as Rot[]) {
        const first = rotateLocalCell(c, w, h, a);
        const fw = a % 2 ? h : w;
        const fh = a % 2 ? w : h;
        expect(rotateLocalCell(first, fw, fh, b)).toEqual(rotateLocalCell(c, w, h, ((a + b) % 4) as Rot));
      }
    }
  });
});

describe('itemCells / itemSockets', () => {
  it('returns absolute cells of the rotated footprint', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 1, 2, 1);
    expect(sortCells(itemCells(f, ITEMS.fish))).toEqual([
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ]);
    const t = add(bag, 'toaster', 3, 0, 3);
    expect(sortCells(itemCells(t, ITEMS.toaster))).toEqual([
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
  });

  it('returns absolute rotated sockets', () => {
    const item: BagItem = { uid: 1, defId: 'fish', tier: 1, x: 1, y: 1, rot: 0 };
    expect(itemSockets(item, ITEMS.fish)).toEqual([
      { x: 3, y: 1 },
      { x: 1, y: 2 },
    ]);
    item.rot = 1; // 세로: 위 (1,1), 아래 (1,2)
    expect(itemSockets(item, ITEMS.fish)).toEqual([
      { x: 1, y: 3 },
      { x: 0, y: 1 },
    ]);
    item.rot = 3; // 세로: 오른쪽 끝 소켓이 위로
    expect(itemSockets(item, ITEMS.fish)).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 2 },
    ]);
  });

  it('does not filter sockets by bag bounds', () => {
    const item: BagItem = { uid: 1, defId: 'fish', tier: 1, x: 0, y: 0, rot: 2 };
    expect(itemSockets(item, ITEMS.fish)).toEqual([
      { x: -1, y: 0 },
      { x: 1, y: -1 },
    ]);
  });

  it('returns [] for items without sockets', () => {
    const item: BagItem = { uid: 1, defId: 'toaster', tier: 1, x: 0, y: 0, rot: 0 };
    expect(itemSockets(item, ITEMS.toaster)).toEqual([]);
  });
});

describe('getOccupant', () => {
  it('finds the item covering any of its cells', () => {
    const bag = createBag();
    const t = add(bag, 'toaster', 1, 1);
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) expect(getOccupant(bag, ITEMS, x, y)).toBe(t);
    expect(getOccupant(bag, ITEMS, 0, 0)).toBeNull();
    expect(getOccupant(bag, ITEMS, 3, 1)).toBeNull();
    expect(getOccupant(bag, ITEMS, -1, 1)).toBeNull();
  });
});

// ── 배치 ─────────────────────────────────────────────────────

describe('canPlace', () => {
  it('checks bounds with the rotated footprint', () => {
    const bag = createBag(5, 4);
    expect(canPlace(bag, ITEMS, 'fish', 3, 0, 0)).toBe(true);
    expect(canPlace(bag, ITEMS, 'fish', 4, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'fish', 4, 0, 1)).toBe(true);
    expect(canPlace(bag, ITEMS, 'fish', 0, 3, 1)).toBe(false);
    expect(canPlace(bag, ITEMS, 'fish', 0, 3, 2)).toBe(true);
    expect(canPlace(bag, ITEMS, 'hair', -1, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'hair', 0, -1, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'hair', 4, 3, 0)).toBe(true);
    expect(canPlace(bag, ITEMS, 'hair', 5, 3, 0)).toBe(false);
  });

  it('rejects overlaps, honoring ignoreUid', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 0, 0);
    expect(canPlace(bag, ITEMS, 'hair', 0, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'hair', 1, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'hair', 2, 0, 0)).toBe(true);
    expect(canPlace(bag, ITEMS, 'toaster', 1, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'fish', 1, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'fish', 1, 0, 0, f.uid)).toBe(true);
    expect(canPlace(bag, ITEMS, 'fish', 1, 0, 0, 999)).toBe(false);
  });

  it('rejects unknown defs and non-integer positions', () => {
    const bag = createBag();
    expect(canPlace(bag, ITEMS, 'nope', 0, 0, 0)).toBe(false);
    expect(canPlace(bag, ITEMS, 'hair', 0.5, 0, 0)).toBe(false);
  });
});

describe('findFreeSpot', () => {
  it('returns the first row-major spot at rot 0', () => {
    const bag = createBag(3, 2);
    expect(findFreeSpot(bag, ITEMS, 'hair')).toEqual({ x: 0, y: 0, rot: 0 });
    add(bag, 'hair', 0, 0);
    expect(findFreeSpot(bag, ITEMS, 'hair')).toEqual({ x: 1, y: 0, rot: 0 });
    add(bag, 'hair', 2, 0);
    // (1,0)이 비어 있지만 2×1은 (1,0)-(2,0) 불가 → 다음 행
    expect(findFreeSpot(bag, ITEMS, 'fish')).toEqual({ x: 0, y: 1, rot: 0 });
  });

  it('falls back to rot 1 when rot 0 does not fit', () => {
    const bag = createBag(2, 2);
    add(bag, 'hair', 1, 0);
    add(bag, 'hair', 1, 1);
    expect(findFreeSpot(bag, ITEMS, 'fish')).toEqual({ x: 0, y: 0, rot: 1 });
  });

  it('returns null when nothing fits or def is unknown', () => {
    const bag = createBag(2, 2);
    add(bag, 'hair', 0, 0);
    add(bag, 'hair', 1, 1);
    expect(findFreeSpot(bag, ITEMS, 'fish')).toBeNull();
    expect(findFreeSpot(bag, ITEMS, 'hair')).toEqual({ x: 1, y: 0, rot: 0 });
    expect(findFreeSpot(createBag(), ITEMS, 'nope')).toBeNull();
  });
});

// ── 추가 / 이동 / 제거 ───────────────────────────────────────

describe('stash', () => {
  it('respects stash capacity and assigns increasing uids', () => {
    const bag = createBag(5, 4, 2);
    const a = addToStash(bag, 'hair', 1);
    const b = addToStash(bag, 'fish', 2);
    expect(a && b).toBeTruthy();
    expect(b!.uid).toBeGreaterThan(a!.uid);
    expect(bag.stash).toEqual([a, b]);
    const before = snapshot(bag);
    expect(addToStash(bag, 'hair', 1)).toBeNull();
    expect(bag).toEqual(before);
  });
});

describe('addNewToBag', () => {
  it('adds with a fresh uid when placeable, else null without changes', () => {
    const bag = createBag();
    const a = add(bag, 'fish', 0, 0, 0, 2);
    expect(a).toMatchObject({ defId: 'fish', tier: 2, x: 0, y: 0, rot: 0 });
    expect(bag.items).toEqual([a]);
    const before = snapshot(bag);
    expect(addNewToBag(bag, ITEMS, 'hair', 1, 1, 0, 0)).toBeNull();
    expect(bag).toEqual(before);
    const b = add(bag, 'hair', 2, 0);
    expect(b.uid).toBeGreaterThan(a.uid);
  });
});

describe('placeFromStash / moveItem / moveToStash / removeByUid', () => {
  it('round-trips an item between stash and bag preserving identity', () => {
    const bag = createBag();
    const s = addToStash(bag, 'fish', 2)!;
    const nextUid = bag.nextUid;

    expect(placeFromStash(bag, ITEMS, s.uid, 1, 1, 1)).toBe(true);
    expect(bag.stash).toEqual([]);
    expect(bag.items).toEqual([{ uid: s.uid, defId: 'fish', tier: 2, x: 1, y: 1, rot: 1 }]);
    expectConsistent(bag);

    expect(moveItem(bag, ITEMS, s.uid, 3, 3, 0)).toBe(true);
    expect(findByUid(bag, s.uid)).toEqual({
      where: 'bag',
      item: { uid: s.uid, defId: 'fish', tier: 2, x: 3, y: 3, rot: 0 },
    });

    expect(moveToStash(bag, s.uid)).toBe(true);
    expect(bag.items).toEqual([]);
    expect(bag.stash).toEqual([{ uid: s.uid, defId: 'fish', tier: 2 }]);
    expect(findByUid(bag, s.uid)?.where).toBe('stash');

    expect(placeFromStash(bag, ITEMS, s.uid, 0, 0, 2)).toBe(true);
    expect(removeByUid(bag, s.uid)).toEqual({ uid: s.uid, defId: 'fish', tier: 2, x: 0, y: 0, rot: 2 });
    expect(bag.items).toEqual([]);
    expect(bag.stash).toEqual([]);
    expect(findByUid(bag, s.uid)).toBeNull();
    expect(bag.nextUid).toBe(nextUid);
  });

  it('placeFromStash fails without changes on bad spot or unknown uid', () => {
    const bag = createBag();
    add(bag, 'toaster', 0, 0);
    const s = addToStash(bag, 'fish', 1)!;
    const before = snapshot(bag);
    expect(placeFromStash(bag, ITEMS, s.uid, 1, 1, 0)).toBe(false); // 겹침
    expect(placeFromStash(bag, ITEMS, s.uid, 4, 0, 0)).toBe(false); // 범위 밖
    expect(placeFromStash(bag, ITEMS, 999, 3, 3, 0)).toBe(false);
    expect(placeFromStash(bag, ITEMS, bag.items[0].uid, 3, 3, 0)).toBe(false); // 가방 아이템
    expect(bag).toEqual(before);
  });

  it('moveItem can rotate in place and rejects overlaps / out of bounds / stash uids', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 0, 0);
    add(bag, 'hair', 0, 2);
    const s = addToStash(bag, 'hair', 1)!;
    expect(moveItem(bag, ITEMS, f.uid, 0, 0, 1)).toBe(true);
    expect(f).toMatchObject({ x: 0, y: 0, rot: 1 });
    const before = snapshot(bag);
    expect(moveItem(bag, ITEMS, f.uid, 0, 1, 1)).toBe(false); // (0,2) 겹침
    expect(moveItem(bag, ITEMS, f.uid, 0, 3, 1)).toBe(false); // 아래로 넘침
    expect(moveItem(bag, ITEMS, s.uid, 4, 0, 0)).toBe(false);
    expect(moveItem(bag, ITEMS, 999, 4, 0, 0)).toBe(false);
    expect(bag).toEqual(before);
    expectConsistent(bag);
  });

  it('moveToStash fails when stash is full or uid is not in bag', () => {
    const bag = createBag(5, 4, 1);
    const a = add(bag, 'hair', 0, 0);
    const s = addToStash(bag, 'hair', 1)!;
    const before = snapshot(bag);
    expect(moveToStash(bag, a.uid)).toBe(false);
    expect(moveToStash(bag, s.uid)).toBe(false);
    expect(moveToStash(bag, 999)).toBe(false);
    expect(bag).toEqual(before);
  });

  it('removeByUid removes from stash and returns null for unknown uid', () => {
    const bag = createBag();
    const s = addToStash(bag, 'hair', 3)!;
    expect(removeByUid(bag, 999)).toBeNull();
    expect(removeByUid(bag, s.uid)).toEqual({ uid: s.uid, defId: 'hair', tier: 3 });
    expect(bag.stash).toEqual([]);
  });

  it('keeps a consistent state through a mixed sequence', () => {
    const bag = createBag(5, 4, 3);
    const a = add(bag, 'toaster', 0, 0);
    const b = add(bag, 'fish', 2, 0);
    const c = addToStash(bag, 'lid', 1)!;
    expectConsistent(bag);
    expect(moveToStash(bag, a.uid)).toBe(true);
    expect(placeFromStash(bag, ITEMS, c.uid, 0, 0, 0)).toBe(true);
    expect(moveItem(bag, ITEMS, b.uid, 3, 1, 1)).toBe(true);
    expect(placeFromStash(bag, ITEMS, a.uid, 1, 0, 0)).toBe(true);
    expectConsistent(bag);
    expect(bag.items.map((i) => i.uid).sort()).toEqual([a.uid, b.uid, c.uid].sort());
    expect(bag.stash).toEqual([]);
  });
});

// ── 인접 ─────────────────────────────────────────────────────

describe('areAdjacent', () => {
  const at = (uid: number, defId: string, x: number, y: number, rot: Rot = 0): BagItem => ({ uid, defId, tier: 1, x, y, rot });
  const adj = (a: BagItem, b: BagItem): boolean => {
    const ab = areAdjacent(a, ITEMS[a.defId], b, ITEMS[b.defId]);
    expect(areAdjacent(b, ITEMS[b.defId], a, ITEMS[a.defId])).toBe(ab); // 대칭
    return ab;
  };

  it('edge-sharing 1×1 items are adjacent, diagonals and gaps are not', () => {
    const a = at(1, 'hair', 1, 1);
    expect(adj(a, at(2, 'hair', 2, 1))).toBe(true);
    expect(adj(a, at(2, 'hair', 0, 1))).toBe(true);
    expect(adj(a, at(2, 'hair', 1, 0))).toBe(true);
    expect(adj(a, at(2, 'hair', 1, 2))).toBe(true);
    expect(adj(a, at(2, 'hair', 2, 2))).toBe(false);
    expect(adj(a, at(2, 'hair', 0, 0))).toBe(false);
    expect(adj(a, at(2, 'hair', 3, 1))).toBe(false);
  });

  it('works with multi-cell and rotated items', () => {
    const v = at(1, 'fish', 0, 0, 1); // (0,0),(0,1)
    expect(adj(v, at(2, 'hair', 1, 1))).toBe(true);
    expect(adj(v, at(2, 'hair', 0, 2))).toBe(true);
    expect(adj(v, at(2, 'hair', 1, 2))).toBe(false);

    const t = at(3, 'toaster', 1, 1); // x1-2, y1-2
    expect(adj(t, at(4, 'fish', 0, 0))).toBe(true); // (1,0)이 (1,1) 위
    expect(adj(t, at(4, 'fish', 3, 0))).toBe(false); // (3,0)은 (2,1)과 대각
    expect(adj(t, at(4, 'fish', 3, 2, 1))).toBe(true); // (3,2),(3,3) 오른쪽
    expect(adj(t, at(4, 'fish', 1, 3))).toBe(true); // 아래
    expect(adj(t, at(4, 'fish', 3, 3))).toBe(false); // 대각
  });

  it('an item is not adjacent to itself', () => {
    const a = at(1, 'hair', 0, 0);
    expect(areAdjacent(a, ITEMS.hair, a, ITEMS.hair)).toBe(false);
  });
});

describe('neighbors', () => {
  it('returns edge neighbors in reading order', () => {
    const bag = createBag();
    const center = add(bag, 'hair', 2, 1);
    const right = add(bag, 'hair', 3, 1);
    const below = add(bag, 'fish', 1, 2);
    add(bag, 'hair', 1, 0); // 대각
    const above = add(bag, 'hair', 2, 0);
    expect(neighbors(bag, ITEMS, center.uid)).toEqual([above, right, below]);
    expect(neighbors(bag, ITEMS, 999)).toEqual([]);
  });
});

// ── 합성 ─────────────────────────────────────────────────────

describe('findMerges — tier', () => {
  it('offers one option per adjacent same-def same-tier pair, anchor = smaller uid', () => {
    const bag = createBag();
    const a = add(bag, 'hair', 0, 0);
    const b = add(bag, 'hair', 1, 0);
    expect(findMerges(bag, DATA)).toEqual([
      { kind: 'tier', anchorUid: a.uid, consumedUid: b.uid, resultDefId: 'hair', resultTier: 2 },
    ]);
  });

  it('ignores diagonal, different tier, different def, and max tier pairs', () => {
    const bag = createBag();
    add(bag, 'hair', 0, 0);
    add(bag, 'hair', 1, 1); // 대각
    add(bag, 'hair', 2, 1, 0, 2); // 티어 다름
    add(bag, 'hair_fire', 3, 1); // def 다름
    add(bag, 'hair', 0, 3, 0, 3);
    add(bag, 'hair', 1, 3, 0, 3); // ★3 쌍
    expect(findMerges(bag, DATA)).toEqual([]);
  });

  it('pairs tier 2 items into tier 3 and detects multi-cell adjacency', () => {
    const bag = createBag();
    const a = add(bag, 'fish', 0, 0, 0, 2);
    const b = add(bag, 'fish', 1, 1, 2, 2); // (1,1),(2,1) — (1,0) 아래
    expect(findMerges(bag, DATA)).toEqual([
      { kind: 'tier', anchorUid: a.uid, consumedUid: b.uid, resultDefId: 'fish', resultTier: 3 },
    ]);
  });

  it('a chain of three yields two pairs', () => {
    const bag = createBag();
    const a = add(bag, 'hair', 0, 0);
    const b = add(bag, 'hair', 1, 0);
    const c = add(bag, 'hair', 2, 0);
    const opts = findMerges(bag, DATA);
    expect(opts.map((o) => [o.anchorUid, o.consumedUid])).toEqual([
      [a.uid, b.uid],
      [b.uid, c.uid],
    ]);
  });

  it('anchor is the smaller uid even when bag order differs', () => {
    const bag = createBag();
    const s1 = addToStash(bag, 'hair', 1)!;
    const s2 = addToStash(bag, 'hair', 1)!;
    const p = add(bag, 'fish', 0, 2);
    const q = add(bag, 'fish', 2, 2);
    placeFromStash(bag, ITEMS, s2.uid, 0, 0, 0);
    placeFromStash(bag, ITEMS, s1.uid, 1, 0, 0);
    const opts = findMerges(bag, DATA);
    expect(opts).toEqual([
      { kind: 'tier', anchorUid: s1.uid, consumedUid: s2.uid, resultDefId: 'hair', resultTier: 2 },
      { kind: 'tier', anchorUid: p.uid, consumedUid: q.uid, resultDefId: 'fish', resultTier: 2 },
    ]);
  });
});

describe('findMerges — recipe', () => {
  it('detects an ingredient on each socket, tier follows the base', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 0, 0, 0, 2);
    const ice = add(bag, 's_ice', 2, 0);
    expect(findMerges(bag, DATA)).toEqual([
      {
        kind: 'recipe',
        anchorUid: f.uid,
        consumedUid: ice.uid,
        resultDefId: 'fish_ice',
        resultTier: 2,
        recipeId: 'r_fish_ice',
      },
    ]);
    moveItem(bag, ITEMS, ice.uid, 0, 1, 0); // 두 번째 소켓 (왼쪽 칸 아래)
    expect(findMerges(bag, DATA).map((o) => o.consumedUid)).toEqual([ice.uid]);
  });

  it('requires the ingredient to sit on a socket, not just adjacent', () => {
    const bag = createBag();
    add(bag, 'fish', 1, 1);
    const ice = add(bag, 's_ice', 1, 0); // 위: 소켓 아님
    expect(findMerges(bag, DATA)).toEqual([]);
    moveItem(bag, ITEMS, ice.uid, 2, 2, 0); // 오른쪽 칸 아래: 소켓 아님
    expect(findMerges(bag, DATA)).toEqual([]);
    moveItem(bag, ITEMS, ice.uid, 0, 1, 0); // 왼쪽: 소켓 아님
    expect(findMerges(bag, DATA)).toEqual([]);
  });

  it('ignores wrong ingredients and ingredients in the stash', () => {
    const bag = createBag();
    add(bag, 'fish', 0, 0);
    add(bag, 's_fire', 2, 0);
    addToStash(bag, 's_ice', 1);
    expect(findMerges(bag, DATA)).toEqual([]);
  });

  it('uses rotated sockets', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 1, 1, 3); // 세로 (1,1),(1,2); 소켓 (1,0) 위, (2,2) 오른쪽 아래칸 옆
    const ice = add(bag, 's_ice', 1, 0);
    expect(mergesFor(findMerges(bag, DATA), f.uid).map((o) => o.kind)).toEqual(['recipe']);
    moveItem(bag, ITEMS, ice.uid, 3, 1, 0); // 원래(rot0) 소켓 위치에 해당하지 않는 곳
    expect(findMerges(bag, DATA)).toEqual([]);
    moveItem(bag, ITEMS, ice.uid, 2, 2, 0);
    expect(findMerges(bag, DATA).map((o) => o.consumedUid)).toEqual([ice.uid]);

    moveItem(bag, ITEMS, f.uid, 1, 1, 1); // rot1: 소켓 (1,3) 아래, (0,1) 왼쪽
    expect(findMerges(bag, DATA)).toEqual([]);
    moveItem(bag, ITEMS, ice.uid, 0, 1, 0);
    expect(findMerges(bag, DATA).map((o) => o.consumedUid)).toEqual([ice.uid]);
  });

  it('ignores sockets that fall outside the bag', () => {
    const bag = createBag();
    add(bag, 'fish', 3, 3); // 소켓 (5,3), (3,4) 모두 범위 밖
    add(bag, 's_ice', 2, 3);
    expect(findMerges(bag, DATA)).toEqual([]);
  });

  it('an ingredient covering two sockets yields a single option', () => {
    const bag = createBag();
    const base = add(bag, 'long', 0, 0);
    const bar = add(bag, 'bar', 0, 1);
    expect(findMerges(bag, DATA)).toEqual([
      {
        kind: 'recipe',
        anchorUid: base.uid,
        consumedUid: bar.uid,
        resultDefId: 'long_plus',
        resultTier: 1,
        recipeId: 'r_long_bar',
      },
    ]);
  });

  it('orders recipes first, then by anchor uid', () => {
    const bag = createBag();
    const h1 = add(bag, 'hair', 0, 3);
    const h2 = add(bag, 'hair', 1, 3);
    const f2 = add(bag, 'fish', 0, 0);
    const ice2 = add(bag, 's_ice', 2, 0);
    const f1 = add(bag, 'fish', 3, 1, 1); // 세로 (3,1),(3,2); 소켓 (3,3) 아래
    const ice1 = add(bag, 's_ice', 3, 3);
    const opts = findMerges(bag, DATA);
    expect(opts.map((o) => [o.kind, o.anchorUid, o.consumedUid])).toEqual([
      ['recipe', f2.uid, ice2.uid],
      ['recipe', f1.uid, ice1.uid],
      ['tier', h1.uid, h2.uid],
    ]);
    // 키 중복 없음
    const keys = opts.map((o) => `${o.kind}:${o.anchorUid}:${o.consumedUid}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('can offer both a tier merge and a recipe for the same base', () => {
    const bag = createBag();
    const h1 = add(bag, 'hair', 0, 0);
    const h2 = add(bag, 'hair', 0, 1);
    const fire = add(bag, 's_fire', 1, 0); // h1 오른쪽 소켓
    const opts = findMerges(bag, DATA);
    expect(opts.map((o) => [o.kind, o.anchorUid, o.consumedUid])).toEqual([
      ['recipe', h1.uid, fire.uid],
      ['tier', h1.uid, h2.uid],
    ]);
    expect(mergesFor(opts, h2.uid)).toEqual([opts[1]]);
    expect(mergesFor(opts, h1.uid)).toEqual(opts);
    expect(mergesFor(opts, fire.uid)).toEqual([opts[0]]);
    expect(mergesFor(opts, 999)).toEqual([]);
  });
});

describe('applyMerge', () => {
  it('tier merge keeps the anchor uid/pos/rot, bumps tier, removes the other', () => {
    const bag = createBag();
    const a = add(bag, 'fish', 0, 0, 2);
    const b = add(bag, 'fish', 0, 1, 0);
    const nextUid = bag.nextUid;
    const [opt] = findMerges(bag, DATA);
    const res = applyMerge(bag, DATA, opt);
    expect(res).toEqual({ uid: a.uid, defId: 'fish', tier: 2, x: 0, y: 0, rot: 2 });
    expect(bag.items).toEqual([res]);
    expect(findByUid(bag, b.uid)).toBeNull();
    expect(bag.nextUid).toBe(nextUid);
    expectConsistent(bag);
  });

  it('anchor override keeps the other item of the pair', () => {
    const bag = createBag();
    const a = add(bag, 'fish', 0, 0);
    const b = add(bag, 'fish', 2, 0, 1);
    const [opt] = findMerges(bag, DATA);
    const res = applyMerge(bag, DATA, opt, b.uid);
    expect(res).toEqual({ uid: b.uid, defId: 'fish', tier: 2, x: 2, y: 0, rot: 1 });
    expect(findByUid(bag, a.uid)).toBeNull();
    expect(bag.items).toHaveLength(1);
  });

  it('an override outside the pair is ignored', () => {
    const bag = createBag();
    const a = add(bag, 'hair', 0, 0);
    add(bag, 'hair', 1, 0);
    const other = add(bag, 'toaster', 3, 2);
    const [opt] = findMerges(bag, DATA);
    expect(applyMerge(bag, DATA, opt, other.uid)?.uid).toBe(a.uid);
  });

  it('recipe keeps base uid/pos/rot/tier, changes defId, removes the ingredient', () => {
    const bag = createBag();
    const f = add(bag, 'fish', 1, 1, 1, 3); // 세로; 소켓 (1,3)
    const ice = add(bag, 's_ice', 1, 3);
    const [opt] = findMerges(bag, DATA);
    expect(opt.kind).toBe('recipe');
    const res = applyMerge(bag, DATA, opt, ice.uid); // 레시피는 override 무시
    expect(res).toEqual({ uid: f.uid, defId: 'fish_ice', tier: 3, x: 1, y: 1, rot: 1 });
    expect(bag.items).toEqual([res]);
    expect(findByUid(bag, ice.uid)).toBeNull();
    expectConsistent(bag);
  });

  it('rejects stale options without changing state', () => {
    const bag = createBag();
    const a = add(bag, 'hair', 0, 0);
    const b = add(bag, 'hair', 1, 0);
    const [opt] = findMerges(bag, DATA);
    moveItem(bag, ITEMS, b.uid, 3, 3, 0);
    const before = snapshot(bag);
    expect(applyMerge(bag, DATA, opt)).toBeNull();
    expect(bag).toEqual(before);

    moveItem(bag, ITEMS, b.uid, 0, 1, 0);
    expect(applyMerge(bag, DATA, opt)?.uid).toBe(a.uid);
    // 같은 옵션 두 번째 적용은 실패
    const after = snapshot(bag);
    expect(applyMerge(bag, DATA, opt)).toBeNull();
    expect(bag).toEqual(after);
  });

  it('rejects options whose details do not match the current ones', () => {
    const bag = createBag();
    add(bag, 'hair', 0, 0);
    add(bag, 'hair', 1, 0);
    const [opt] = findMerges(bag, DATA);
    const before = snapshot(bag);
    const forged: MergeOption[] = [
      { ...opt, resultTier: 3 },
      { ...opt, resultDefId: 'hair_fire' },
      { ...opt, kind: 'recipe' },
      { ...opt, anchorUid: opt.consumedUid, consumedUid: opt.anchorUid },
    ];
    for (const f of forged) expect(applyMerge(bag, DATA, f)).toBeNull();
    expect(bag).toEqual(before);
  });

  it('rejects a recipe once the ingredient left the socket', () => {
    const bag = createBag();
    add(bag, 'fish', 0, 0);
    const ice = add(bag, 's_ice', 2, 0);
    const [opt] = findMerges(bag, DATA);
    expect(moveToStash(bag, ice.uid)).toBe(true);
    const before = snapshot(bag);
    expect(applyMerge(bag, DATA, opt)).toBeNull();
    expect(bag).toEqual(before);
  });
});

// ── 확장 / 순서 ──────────────────────────────────────────────

describe('expandBag', () => {
  it('grows columns and rows up to the max', () => {
    const bag = createBag();
    for (let c = BAG_START_COLS; c < BAG_MAX_COLS; c++) expect(expandBag(bag, 'col')).toBe(true);
    expect(bag.cols).toBe(BAG_MAX_COLS);
    expect(expandBag(bag, 'col')).toBe(false);
    expect(bag.cols).toBe(BAG_MAX_COLS);

    for (let r = BAG_START_ROWS; r < BAG_MAX_ROWS; r++) expect(expandBag(bag, 'row')).toBe(true);
    expect(bag.rows).toBe(BAG_MAX_ROWS);
    expect(expandBag(bag, 'row')).toBe(false);
    expect(bag.rows).toBe(BAG_MAX_ROWS);
  });

  it('keeps existing items in place and opens new cells right/down', () => {
    const bag = createBag();
    const a = add(bag, 'hair', 0, 0);
    expect(canPlace(bag, ITEMS, 'hair', BAG_START_COLS, 0, 0)).toBe(false);
    expandBag(bag, 'col');
    expandBag(bag, 'row');
    expect(a).toMatchObject({ x: 0, y: 0 });
    expect(canPlace(bag, ITEMS, 'hair', BAG_START_COLS, 0, 0)).toBe(true);
    expect(canPlace(bag, ITEMS, 'hair', 0, BAG_START_ROWS, 0)).toBe(true);
  });
});

describe('bagItemsInOrder', () => {
  it('sorts by y then x without mutating the bag', () => {
    const bag = createBag();
    const c = add(bag, 'hair', 0, 2);
    const b = add(bag, 'hair', 3, 0);
    const a = add(bag, 'fish', 0, 0);
    const d = add(bag, 'toaster', 1, 1);
    expect(bagItemsInOrder(bag)).toEqual([a, b, d, c]);
    expect(bag.items).toEqual([c, b, a, d]);
  });
});
