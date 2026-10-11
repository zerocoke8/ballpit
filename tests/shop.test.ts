import { describe, expect, it } from 'vitest';
import {
  BAG_EXPAND_COSTS,
  BAG_MAX_COLS,
  BAG_MAX_ROWS,
  HEAL_COST,
  SHOP_REROLL_BASE,
  SHOP_SLOTS,
} from '../src/config';
import { GAME_DATA } from '../src/data/index';
import { addNewToBag, addToStash, findByUid } from '../src/logic/bag';
import { newRun, runPlayerStats } from '../src/logic/run';
import {
  bagExpandCost,
  buyBagExpand,
  buyHeal,
  buySlot,
  canBuyHeal,
  rerollShop,
  rollItemDef,
  rollShop,
  sellItem,
  shopCandidates,
  toggleLock,
} from '../src/logic/shop';
import { Rng } from '../src/logic/rng';
import { itemPrice, sellPrice } from '../src/logic/stats';
import type { RunState, ShopSlot } from '../src/types';

const data = GAME_DATA;

function makeRun(characterId = 'penguin', seed = 1234): RunState {
  return newRun(data, characterId, seed);
}

function fillStash(run: RunState): void {
  while (addToStash(run.bag, 's_power', 1)) {
    // 가득 찰 때까지
  }
}

/** stageIndex에서 rollShop을 n번 굴려 나온 모든 칸 */
function sampleShop(stageIndex: number, n: number, seed = 7): ShopSlot[] {
  const run = makeRun('penguin', seed);
  run.stageIndex = stageIndex;
  const out: ShopSlot[] = [];
  for (let i = 0; i < n; i++) {
    rollShop(data, run);
    for (const s of run.shop.slots) if (s) out.push(s);
  }
  return out;
}

const slot = (defId: string, locked = false): ShopSlot => ({
  defId,
  tier: 1,
  price: itemPrice(data.items[defId], 1),
  locked,
});

describe('rollShop', () => {
  it('빈 상점을 SHOP_SLOTS칸 모두 채우고 가격은 itemPrice', () => {
    const run = makeRun();
    rollShop(data, run);
    expect(run.shop.slots).toHaveLength(SHOP_SLOTS);
    for (const s of run.shop.slots) {
      expect(s).not.toBeNull();
      const def = data.items[s!.defId];
      expect(s!.price).toBe(itemPrice(def, s!.tier));
      expect(s!.locked).toBe(false);
    }
  });

  it('rngState를 갱신하고, 같은 rngState면 같은 결과', () => {
    const a = makeRun();
    const b = structuredClone(a);
    const before = a.rngState;
    rollShop(data, a);
    rollShop(data, b);
    expect(a.rngState).not.toBe(before);
    expect(a.rngState).toBe(b.rngState);
    expect(a.shop.slots).toEqual(b.shop.slots);
  });

  it('스테이지별로 minStage·shopWeight 조건을 지킨다', () => {
    for (let stage = 0; stage < data.stages.length; stage++) {
      const slots = sampleShop(stage, 200, 100 + stage);
      expect(slots.length).toBe(200 * SHOP_SLOTS);
      for (const s of slots) {
        const def = data.items[s.defId];
        expect(def.shopWeight, `${s.defId} @${stage}`).toBeGreaterThan(0);
        expect(def.minStage, `${s.defId} @${stage}`).toBeLessThanOrEqual(stage);
      }
    }
  });

  it('shopWeight 0 아이템(진화 무기)은 절대 안 나온다', () => {
    const zero = Object.values(data.items)
      .filter((d) => d.shopWeight === 0)
      .map((d) => d.id);
    expect(zero.length).toBeGreaterThan(0);
    const seen = new Set(sampleShop(4, 500).map((s) => s.defId));
    for (const id of zero) expect(seen.has(id)).toBe(false);
  });

  it('스테이지 0에서는 epic/legendary가 안 나오고 ★1만', () => {
    const slots = sampleShop(0, 500);
    for (const s of slots) {
      expect(['common', 'rare']).toContain(data.items[s.defId].rarity);
      expect(s.tier).toBe(1);
    }
    const rarities = new Set(slots.map((s) => data.items[s.defId].rarity));
    expect(rarities).toEqual(new Set(['common', 'rare']));
  });

  it('스테이지 3 미만은 ★1만, 3 이상에서는 가끔 ★2 (가격 반영)', () => {
    for (const stage of [0, 1, 2]) {
      expect(sampleShop(stage, 300).every((s) => s.tier === 1)).toBe(true);
    }
    const late = sampleShop(4, 300);
    const t2 = late.filter((s) => s.tier === 2);
    expect(t2.length).toBeGreaterThan(0);
    expect(t2.length).toBeLessThan(late.length * 0.25);
    expect(late.every((s) => s.tier === 1 || s.tier === 2)).toBe(true);
    for (const s of t2) expect(s.price).toBe(itemPrice(data.items[s.defId], 2));
  });

  it('후반 스테이지에서는 epic도 나온다', () => {
    const rarities = new Set(sampleShop(4, 300).map((s) => data.items[s.defId].rarity));
    expect(rarities.has('epic')).toBe(true);
  });

  it('잠긴 칸은 유지(잠금도 유지), 나머지·빈 칸은 새로 굴린다', () => {
    const run = makeRun();
    const locked = slot('w_duck', true);
    run.shop.slots = [null, slot('w_fish'), locked, null];
    rollShop(data, run);
    expect(run.shop.slots[2]).toEqual({ ...locked });
    expect(run.shop.slots[2]!.locked).toBe(true);
    for (const i of [0, 1, 3]) {
      expect(run.shop.slots[i]).not.toBeNull();
      expect(run.shop.slots[i]!.locked).toBe(false);
    }
  });

  it('keepLocked=false면 잠긴 칸도 새로 굴린다', () => {
    const run = makeRun();
    run.shop.slots = new Array(SHOP_SLOTS).fill(null).map(() => slot('w_duck', true));
    rollShop(data, run, false);
    for (const s of run.shop.slots) {
      expect(s).not.toBeNull();
      expect(s!.locked).toBe(false);
    }
  });

  it('rollItemDef: 후보 안에서만 고른다', () => {
    const rng = new Rng(42);
    for (let stage = 0; stage < 6; stage++) {
      const ids = new Set(shopCandidates(data, stage).map((d) => d.id));
      for (let i = 0; i < 100; i++) {
        const def = rollItemDef(data, stage, rng);
        expect(def).not.toBeNull();
        expect(ids.has(def!.id)).toBe(true);
      }
    }
  });
});

describe('rerollShop', () => {
  it('골드를 차감하고 비용이 1씩 오른다, 모자라면 실패', () => {
    const run = makeRun();
    rollShop(data, run);
    run.gold = 10;
    expect(run.shop.rerollCost).toBe(SHOP_REROLL_BASE);

    expect(rerollShop(data, run)).toBe(true);
    expect(run.gold).toBe(10 - SHOP_REROLL_BASE);
    expect(run.shop.rerollCost).toBe(SHOP_REROLL_BASE + 1);

    expect(rerollShop(data, run)).toBe(true);
    expect(run.gold).toBe(10 - SHOP_REROLL_BASE - (SHOP_REROLL_BASE + 1));
    expect(run.shop.rerollCost).toBe(SHOP_REROLL_BASE + 2);

    run.gold = run.shop.rerollCost - 1;
    const before = structuredClone(run);
    expect(rerollShop(data, run)).toBe(false);
    expect(run).toEqual(before);
  });

  it('잠긴 칸은 새로고침에도 유지', () => {
    const run = makeRun();
    rollShop(data, run);
    toggleLock(run, 1);
    const kept = { ...run.shop.slots[1]! };
    run.gold = 100;
    for (let i = 0; i < 5; i++) expect(rerollShop(data, run)).toBe(true);
    expect(run.shop.slots[1]).toEqual(kept);
  });
});

describe('buySlot', () => {
  it('골드를 내고 보관함에 넣은 뒤 칸을 비운다', () => {
    const run = makeRun();
    run.shop.slots = [slot('w_duck'), null, null, null];
    run.shop.slots[0]!.tier = 2;
    run.shop.slots[0]!.price = itemPrice(data.items.w_duck, 2);
    const price = run.shop.slots[0]!.price;
    run.gold = price + 3;

    expect(buySlot(data, run, 0)).toBe(true);
    expect(run.gold).toBe(3);
    expect(run.shop.slots[0]).toBeNull();
    expect(run.bag.stash).toHaveLength(1);
    expect(run.bag.stash[0]).toMatchObject({ defId: 'w_duck', tier: 2 });
  });

  it('골드 부족 / 빈 칸 / 범위 밖이면 실패하고 상태 불변', () => {
    const run = makeRun();
    run.shop.slots = [slot('w_duck'), null, null, null];
    run.gold = run.shop.slots[0]!.price - 1;
    const before = structuredClone(run);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(buySlot(data, run, 1)).toBe(false);
    expect(buySlot(data, run, 99)).toBe(false);
    expect(buySlot(data, run, -1)).toBe(false);
    expect(run).toEqual(before);
  });

  it('보관함이 가득이면 실패하고 골드·칸 유지', () => {
    const run = makeRun();
    fillStash(run);
    run.shop.slots = [slot('w_fish'), null, null, null];
    run.gold = 100;
    const before = structuredClone(run);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(run).toEqual(before);
  });

  it('잠긴 칸도 살 수 있다', () => {
    const run = makeRun();
    run.shop.slots = [slot('s_fire', true), null, null, null];
    run.gold = 50;
    expect(buySlot(data, run, 0)).toBe(true);
    expect(run.shop.slots[0]).toBeNull();
  });
});

describe('toggleLock', () => {
  it('잠금을 켜고 끈다, 빈 칸은 무시', () => {
    const run = makeRun();
    run.shop.slots = [slot('w_fish'), null, null, null];
    toggleLock(run, 0);
    expect(run.shop.slots[0]!.locked).toBe(true);
    toggleLock(run, 0);
    expect(run.shop.slots[0]!.locked).toBe(false);
    toggleLock(run, 1);
    toggleLock(run, 99);
    expect(run.shop.slots[1]).toBeNull();
  });
});

describe('sellItem', () => {
  it('가방에서 팔면 제거하고 sellPrice(★ 반영) 지급', () => {
    const run = makeRun('penguin');
    const fish = run.bag.items.find((it) => it.defId === 'w_fish')!;
    const def = data.items.w_fish;
    for (const tier of [1, 2, 3] as const) {
      const r = structuredClone(run);
      const it = r.bag.items.find((x) => x.uid === fish.uid)!;
      it.tier = tier;
      const got = sellItem(data, r, fish.uid);
      expect(got).toBe(sellPrice(def, tier));
      expect(r.gold).toBe(got);
      expect(findByUid(r.bag, fish.uid)).toBeNull();
    }
    expect(sellPrice(def, 1)).toBe(5);
    expect(sellPrice(def, 2)).toBe(10);
    expect(sellPrice(def, 3)).toBe(20);
  });

  it('보관함에서도 판다', () => {
    const run = makeRun();
    const s = addToStash(run.bag, 's_power', 2)!;
    run.gold = 3;
    const got = sellItem(data, run, s.uid);
    expect(got).toBe(sellPrice(data.items.s_power, 2));
    expect(run.gold).toBe(3 + got);
    expect(run.bag.stash).toHaveLength(0);
  });

  it('없는 uid는 0, 상태 불변', () => {
    const run = makeRun();
    const before = structuredClone(run);
    expect(sellItem(data, run, 9999)).toBe(0);
    expect(run).toEqual(before);
  });
});

describe('가방 확장', () => {
  it('확장 횟수에 따라 비용이 오르고 7×6에서 멈춘다', () => {
    const run = makeRun();
    run.gold = 1000;
    let spent = 0;

    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[0]);
    expect(buyBagExpand(run, 'col')).toBe(true);
    spent += BAG_EXPAND_COSTS[0];
    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[1]);
    expect(buyBagExpand(run, 'col')).toBe(true);
    spent += BAG_EXPAND_COSTS[1];
    expect(run.bag.cols).toBe(BAG_MAX_COLS);

    // 열은 최대 → 실패, 골드 그대로
    expect(buyBagExpand(run, 'col')).toBe(false);
    expect(run.gold).toBe(1000 - spent);

    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[2]);
    expect(buyBagExpand(run, 'row')).toBe(true);
    spent += BAG_EXPAND_COSTS[2];
    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[3]);
    expect(buyBagExpand(run, 'row')).toBe(true);
    spent += BAG_EXPAND_COSTS[3];

    expect(run.bag.cols).toBe(BAG_MAX_COLS);
    expect(run.bag.rows).toBe(BAG_MAX_ROWS);
    expect(run.gold).toBe(1000 - spent);
    expect(bagExpandCost(run)).toBeNull();
    expect(buyBagExpand(run, 'row')).toBe(false);
    expect(buyBagExpand(run, 'col')).toBe(false);
    expect(run.gold).toBe(1000 - spent);
  });

  it('행/열 순서와 무관하게 횟수로 비용 결정', () => {
    const run = makeRun();
    run.gold = 1000;
    expect(buyBagExpand(run, 'row')).toBe(true);
    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[1]);
    expect(buyBagExpand(run, 'col')).toBe(true);
    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[2]);
  });

  it('골드가 모자라면 확장 안 함', () => {
    const run = makeRun();
    run.gold = BAG_EXPAND_COSTS[0] - 1;
    const before = structuredClone(run);
    expect(buyBagExpand(run, 'col')).toBe(false);
    expect(run).toEqual(before);
  });
});

describe('회복 구매', () => {
  it('HP 50% 회복, 스테이지당 1회', () => {
    const run = makeRun('capybara');
    const maxHp = runPlayerStats(data, run).maxHp;
    expect(maxHp).toBe(140);
    run.hp = 30;
    run.gold = HEAL_COST * 3;
    expect(canBuyHeal(data, run)).toBe(true);
    expect(buyHeal(data, run)).toBe(true);
    expect(run.hp).toBe(30 + 70);
    expect(run.gold).toBe(HEAL_COST * 2);
    expect(run.shop.healBought).toBe(true);
    expect(canBuyHeal(data, run)).toBe(false);
    expect(buyHeal(data, run)).toBe(false);
    expect(run.hp).toBe(100);
  });

  it('최대 HP를 넘지 않는다', () => {
    const run = makeRun('capybara');
    run.hp = 120;
    run.gold = HEAL_COST;
    expect(buyHeal(data, run)).toBe(true);
    expect(run.hp).toBe(140);
    expect(run.gold).toBe(0);
  });

  it('HP가 가득이거나 골드가 모자라면 불가', () => {
    const full = makeRun();
    full.gold = 100;
    expect(canBuyHeal(data, full)).toBe(false);
    expect(buyHeal(data, full)).toBe(false);
    expect(full.gold).toBe(100);

    const poor = makeRun();
    poor.hp = 10;
    poor.gold = HEAL_COST - 1;
    expect(canBuyHeal(data, poor)).toBe(false);
    expect(buyHeal(data, poor)).toBe(false);
    expect(poor.hp).toBe(10);
  });

  it('장비로 늘어난 최대 HP 기준', () => {
    const run = makeRun('cat'); // HP 패시브 없는 캐릭터
    expect(addNewToBag(run.bag, data.items, 'g_potlid', 1, 4, 0, 0)).not.toBeNull();
    const maxHp = runPlayerStats(data, run).maxHp;
    expect(maxHp).toBe(125);
    expect(run.hp).toBe(100);
    run.gold = HEAL_COST;
    expect(canBuyHeal(data, run)).toBe(true);
    expect(buyHeal(data, run)).toBe(true);
    expect(run.hp).toBe(125);
  });
});
