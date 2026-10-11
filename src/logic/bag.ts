// 가방 격자·회전·소켓·인접·합성. 순수 로직 (PixiJS/DOM 금지).
// 변경 함수는 전달된 BagState를 직접 바꾸고 성공 여부를 반환한다. 실패하면 상태는 그대로다.

import {
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  BAG_START_COLS,
  BAG_START_ROWS,
  MAX_TIER,
  STASH_CAPACITY,
} from '../config';
import type {
  BagItem,
  BagState,
  Cell,
  ItemDef,
  MergeOption,
  RecipeDef,
  Rot,
  StashItem,
  Tier,
} from '../types';

type ItemMap = Record<string, ItemDef>;

export interface MergeData {
  items: ItemMap;
  recipes: RecipeDef[];
}

export type FoundItem = { where: 'bag'; item: BagItem } | { where: 'stash'; item: StashItem };

function requireDef(items: ItemMap, defId: string): ItemDef {
  const def = items[defId];
  if (!def) throw new Error(`bag: unknown item def '${defId}'`);
  return def;
}

function isRot(rot: number): rot is Rot {
  return rot === 0 || rot === 1 || rot === 2 || rot === 3;
}

// ── 생성 / 기하 ──────────────────────────────────────────────

export function createBag(
  cols: number = BAG_START_COLS,
  rows: number = BAG_START_ROWS,
  stashCapacity: number = STASH_CAPACITY,
): BagState {
  return { cols, rows, items: [], stash: [], stashCapacity, nextUid: 1 };
}

export function footprint(def: ItemDef, rot: Rot): { w: number; h: number } {
  return rot % 2 === 1 ? { w: def.h, h: def.w } : { w: def.w, h: def.h };
}

export function rotateLocalCell(c: Cell, w: number, h: number, rot: Rot): Cell {
  let { x, y } = c;
  let cw = w;
  let ch = h;
  for (let i = 0; i < rot; i++) {
    // 시계방향 90°: (x, y) → (h-1-y, x), 프레임은 h×w가 된다
    const nx = ch - 1 - y;
    const ny = x;
    x = nx;
    y = ny;
    const t = cw;
    cw = ch;
    ch = t;
  }
  return { x, y };
}

export function itemCells(item: BagItem, def: ItemDef): Cell[] {
  const { w, h } = footprint(def, item.rot);
  const cells: Cell[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) cells.push({ x: item.x + dx, y: item.y + dy });
  }
  return cells;
}

export function itemSockets(item: BagItem, def: ItemDef): Cell[] {
  if (!def.sockets) return [];
  return def.sockets.map((s) => {
    const c = rotateLocalCell(s, def.w, def.h, item.rot);
    return { x: item.x + c.x, y: item.y + c.y };
  });
}

function covers(item: BagItem, def: ItemDef, x: number, y: number): boolean {
  const { w, h } = footprint(def, item.rot);
  return x >= item.x && x < item.x + w && y >= item.y && y < item.y + h;
}

export function getOccupant(bag: BagState, items: ItemMap, x: number, y: number): BagItem | null {
  for (const it of bag.items) {
    if (covers(it, requireDef(items, it.defId), x, y)) return it;
  }
  return null;
}

// ── 배치 검사 ────────────────────────────────────────────────

export function canPlace(
  bag: BagState,
  items: ItemMap,
  defId: string,
  x: number,
  y: number,
  rot: Rot,
  ignoreUid?: number,
): boolean {
  const def = items[defId];
  if (!def || !isRot(rot) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const { w, h } = footprint(def, rot);
  if (x < 0 || y < 0 || x + w > bag.cols || y + h > bag.rows) return false;
  for (const it of bag.items) {
    if (it.uid === ignoreUid) continue;
    const o = footprint(requireDef(items, it.defId), it.rot);
    const overlap = x < it.x + o.w && it.x < x + w && y < it.y + o.h && it.y < y + h;
    if (overlap) return false;
  }
  return true;
}

export function findFreeSpot(
  bag: BagState,
  items: ItemMap,
  defId: string,
): { x: number; y: number; rot: Rot } | null {
  if (!items[defId]) return null;
  for (const rot of [0, 1] as const) {
    for (let y = 0; y < bag.rows; y++) {
      for (let x = 0; x < bag.cols; x++) {
        if (canPlace(bag, items, defId, x, y, rot)) return { x, y, rot };
      }
    }
  }
  return null;
}

// ── 추가 / 이동 / 제거 ───────────────────────────────────────

export function addToStash(bag: BagState, defId: string, tier: Tier): StashItem | null {
  if (bag.stash.length >= bag.stashCapacity) return null;
  const item: StashItem = { uid: bag.nextUid++, defId, tier };
  bag.stash.push(item);
  return item;
}

export function addNewToBag(
  bag: BagState,
  items: ItemMap,
  defId: string,
  tier: Tier,
  x: number,
  y: number,
  rot: Rot,
): BagItem | null {
  if (!canPlace(bag, items, defId, x, y, rot)) return null;
  const item: BagItem = { uid: bag.nextUid++, defId, tier, x, y, rot };
  bag.items.push(item);
  return item;
}

export function placeFromStash(
  bag: BagState,
  items: ItemMap,
  uid: number,
  x: number,
  y: number,
  rot: Rot,
): boolean {
  const idx = bag.stash.findIndex((s) => s.uid === uid);
  if (idx < 0) return false;
  const s = bag.stash[idx];
  if (!canPlace(bag, items, s.defId, x, y, rot)) return false;
  bag.stash.splice(idx, 1);
  bag.items.push({ uid: s.uid, defId: s.defId, tier: s.tier, x, y, rot });
  return true;
}

export function moveItem(
  bag: BagState,
  items: ItemMap,
  uid: number,
  x: number,
  y: number,
  rot: Rot,
): boolean {
  const item = bag.items.find((it) => it.uid === uid);
  if (!item) return false;
  if (!canPlace(bag, items, item.defId, x, y, rot, uid)) return false;
  item.x = x;
  item.y = y;
  item.rot = rot;
  return true;
}

export function moveToStash(bag: BagState, uid: number): boolean {
  const idx = bag.items.findIndex((it) => it.uid === uid);
  if (idx < 0 || bag.stash.length >= bag.stashCapacity) return false;
  const [it] = bag.items.splice(idx, 1);
  bag.stash.push({ uid: it.uid, defId: it.defId, tier: it.tier });
  return true;
}

export function removeByUid(bag: BagState, uid: number): BagItem | StashItem | null {
  const bi = bag.items.findIndex((it) => it.uid === uid);
  if (bi >= 0) return bag.items.splice(bi, 1)[0];
  const si = bag.stash.findIndex((s) => s.uid === uid);
  if (si >= 0) return bag.stash.splice(si, 1)[0];
  return null;
}

export function findByUid(bag: BagState, uid: number): FoundItem | null {
  const item = bag.items.find((it) => it.uid === uid);
  if (item) return { where: 'bag', item };
  const s = bag.stash.find((it) => it.uid === uid);
  if (s) return { where: 'stash', item: s };
  return null;
}

// ── 인접 ─────────────────────────────────────────────────────

export function areAdjacent(a: BagItem, aDef: ItemDef, b: BagItem, bDef: ItemDef): boolean {
  if (a.uid === b.uid) return false;
  const fa = footprint(aDef, a.rot);
  const fb = footprint(bDef, b.rot);
  const rowsOverlap = a.y < b.y + fb.h && b.y < a.y + fa.h;
  const colsOverlap = a.x < b.x + fb.w && b.x < a.x + fa.w;
  const touchX = a.x + fa.w === b.x || b.x + fb.w === a.x;
  const touchY = a.y + fa.h === b.y || b.y + fb.h === a.y;
  return (touchX && rowsOverlap) || (touchY && colsOverlap);
}

/** uid 아이템과 변으로 맞닿은 가방 아이템들 (읽기 순서) */
export function neighbors(bag: BagState, items: ItemMap, uid: number): BagItem[] {
  const self = bag.items.find((it) => it.uid === uid);
  if (!self) return [];
  const selfDef = requireDef(items, self.defId);
  return bagItemsInOrder(bag).filter((other) =>
    areAdjacent(self, selfDef, other, requireDef(items, other.defId)),
  );
}

// ── 합성 ─────────────────────────────────────────────────────

export function findMerges(bag: BagState, data: MergeData): MergeOption[] {
  const out: MergeOption[] = [];
  const seen = new Set<string>();
  const push = (opt: MergeOption): void => {
    const key = `${opt.kind}:${opt.anchorUid}:${opt.consumedUid}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(opt);
  };

  // 레시피: base 무기의 (가방 범위 안) 소켓 칸을 ingredient가 차지
  for (const base of bag.items) {
    const candidates = data.recipes.filter((r) => r.base === base.defId);
    if (candidates.length === 0) continue;
    const baseDef = requireDef(data.items, base.defId);
    // 결과는 base 자리에서 그대로 진화하므로 크기가 다르면(데이터 오류) 겹침이 생긴다 → 제외
    const recipes = candidates.filter((r) => {
      const res = data.items[r.result];
      return res !== undefined && res.w === baseDef.w && res.h === baseDef.h;
    });
    if (recipes.length === 0) continue;
    for (const s of itemSockets(base, baseDef)) {
      if (s.x < 0 || s.y < 0 || s.x >= bag.cols || s.y >= bag.rows) continue;
      const occ = getOccupant(bag, data.items, s.x, s.y);
      if (!occ || occ.uid === base.uid) continue;
      for (const r of recipes) {
        if (r.ingredient !== occ.defId) continue;
        push({
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

  // ★합성: 같은 defId·tier, tier < MAX_TIER, 변 인접
  const list = bag.items;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.tier >= MAX_TIER) continue;
    const aDef = requireDef(data.items, a.defId);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b.defId !== a.defId || b.tier !== a.tier) continue;
      if (!areAdjacent(a, aDef, b, aDef)) continue;
      push({
        kind: 'tier',
        anchorUid: Math.min(a.uid, b.uid),
        consumedUid: Math.max(a.uid, b.uid),
        resultDefId: a.defId,
        resultTier: (a.tier + 1) as Tier,
      });
    }
  }

  const kindOrder = (k: MergeOption['kind']): number => (k === 'recipe' ? 0 : 1);
  return out.sort(
    (p, q) =>
      kindOrder(p.kind) - kindOrder(q.kind) ||
      p.anchorUid - q.anchorUid ||
      p.consumedUid - q.consumedUid,
  );
}

export function mergesFor(options: MergeOption[], uid: number): MergeOption[] {
  return options.filter((o) => o.anchorUid === uid || o.consumedUid === uid);
}

function sameOption(a: MergeOption, b: MergeOption): boolean {
  return (
    a.kind === b.kind &&
    a.anchorUid === b.anchorUid &&
    a.consumedUid === b.consumedUid &&
    a.resultDefId === b.resultDefId &&
    a.resultTier === b.resultTier &&
    a.recipeId === b.recipeId
  );
}

/**
 * 옵션이 지금도 유효할 때만 합성한다. 결과 아이템(가방 안 객체)을 반환, 실패 시 null.
 * anchorOverrideUid는 ★합성에서 쌍 중 하나일 때만 쓰이고, 그 외에는 무시된다.
 */
export function applyMerge(
  bag: BagState,
  data: MergeData,
  option: MergeOption,
  anchorOverrideUid?: number,
): BagItem | null {
  const current = findMerges(bag, data).find((o) => sameOption(o, option));
  if (!current) return null;

  let keepUid = current.anchorUid;
  let dropUid = current.consumedUid;
  if (current.kind === 'tier' && anchorOverrideUid === current.consumedUid) {
    keepUid = current.consumedUid;
    dropUid = current.anchorUid;
  }

  const keep = bag.items.find((it) => it.uid === keepUid);
  const dropIdx = bag.items.findIndex((it) => it.uid === dropUid);
  if (!keep || dropIdx < 0) return null;

  bag.items.splice(dropIdx, 1);
  if (current.kind === 'tier') {
    keep.tier = current.resultTier;
  } else {
    keep.defId = current.resultDefId;
  }
  return keep;
}

// ── 확장 / 순서 ──────────────────────────────────────────────

export function expandBag(bag: BagState, dir: 'col' | 'row'): boolean {
  if (dir === 'col') {
    if (bag.cols >= BAG_MAX_COLS) return false;
    bag.cols++;
    return true;
  }
  if (bag.rows >= BAG_MAX_ROWS) return false;
  bag.rows++;
  return true;
}

export function bagItemsInOrder(bag: BagState): BagItem[] {
  return [...bag.items].sort((a, b) => a.y - b.y || a.x - b.x || a.uid - b.uid);
}
