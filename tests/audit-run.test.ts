// run/shop 모듈 감사 테스트.
// 앞쪽 describe들은 발견한 결함을 재현한다(수정 전 실패). 뒤쪽은 명세 경계값·불변식 회귀 테스트.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAG_EXPAND_COSTS,
  HEAL_COST,
  SAVE_KEY,
  SHOP_SLOTS,
  STAGE_CLEAR_HEAL_RATIO,
} from '../src/config';
import { GAME_DATA } from '../src/data/index';
import {
  addNewToBag,
  addToStash,
  applyMerge,
  findFreeSpot,
  findMerges,
  placeFromStash,
} from '../src/logic/bag';
import { Rng } from '../src/logic/rng';
import {
  completeStage,
  isRunComplete,
  loadRun,
  newRun,
  rewardKill,
  runPlayerStats,
  saveRun,
} from '../src/logic/run';
import {
  bagExpandCost,
  buyBagExpand,
  buyHeal,
  buySlot,
  canBuyHeal,
  rerollShop,
  sellItem,
  toggleLock,
} from '../src/logic/shop';
import type { RunState, ShopSlot, Tier } from '../src/types';

const data = GAME_DATA;
const CHARACTER_IDS = ['penguin', 'capybara', 'cat'] as const;
const ENEMY_IDS = Object.keys(data.enemies);
/** dropChance 1 — 드롭이 확실한 적 */
const SURE_DROP = 'boss_robot';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let mem: MemoryStorage;
beforeEach(() => {
  mem = new MemoryStorage();
  vi.stubGlobal('localStorage', mem);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRun(characterId = 'cat', seed = 77): RunState {
  return newRun(data, characterId, seed);
}

/** 보관함 1칸 + 상점이 굴려진, 첫 상점 시점의 현실적인 런 */
function shopRun(): RunState {
  const run = makeRun();
  rewardKill(data, run, SURE_DROP);
  completeStage(data, run, 60);
  return run;
}

function fillStash(run: RunState): void {
  while (addToStash(run.bag, 's_power', 1)) {
    // 가득 찰 때까지
  }
}

// ─────────────────────────────────────────────────────────────
// 결함 1: loadRun이 얕은 모양 검사만 해서 깨진 세이브를 통과시킨다
// ─────────────────────────────────────────────────────────────

type Mutate = (r: any) => void;

const CORRUPT: [string, Mutate][] = [
  ['stageIndex 소수 → currentStage가 undefined', (r) => (r.stageIndex = 1.5)],
  ['stageIndex 음수', (r) => (r.stageIndex = -1)],
  ['gold 음수', (r) => (r.gold = -5)],
  ['hp 음수', (r) => (r.hp = -1)],
  ['bag.items에 null → runPlayerStats TypeError', (r) => (r.bag.items = [null])],
  ['가방 아이템 tier 4 → 무기 데미지 NaN', (r) => (r.bag.items[0].tier = 4)],
  ['가방 아이템 rot 5', (r) => (r.bag.items[0].rot = 5)],
  ['가방 아이템 x 소수', (r) => (r.bag.items[0].x = 0.5)],
  ['가방 아이템 좌표가 가방 밖', (r) => (r.bag.items[0].x = r.bag.cols)],
  ['가방 아이템 uid 없음', (r) => delete r.bag.items[0].uid],
  ['가방 아이템 defId 숫자', (r) => (r.bag.items[0].defId = 3)],
  ['보관함에 null → sellItem TypeError', (r) => (r.bag.stash = [null])],
  ['보관함 아이템 tier 0', (r) => (r.bag.stash[0].tier = 0)],
  ['가방·보관함 uid 중복', (r) => (r.bag.stash[0].uid = r.bag.items[0].uid)],
  ['nextUid가 기존 uid 이하 → 다음 추가가 uid 중복', (r) => (r.bag.nextUid = 1)],
  ['보관함이 용량 초과', (r) => (r.bag.stashCapacity = 0)],
  ['cols 0', (r) => (r.bag.cols = 0)],
  ['cols 거대 → 가방 렌더 폭주', (r) => (r.bag.cols = 1e6)],
  ['rows 소수', (r) => (r.bag.rows = 4.5)],
  ['shop.slots 길이 틀림', (r) => (r.shop.slots = [null])],
  ['shop.slots에 숫자 → toggleLock TypeError', (r) => (r.shop.slots = [1, 2, 3, 4])],
  ['상점 가격 음수 → 사면 골드 증가', (r) => (r.shop.slots[0].price = -50)],
  ['상점 tier 9', (r) => (r.shop.slots[0].tier = 9)],
  ['상점 locked 누락', (r) => delete r.shop.slots[0].locked],
  ['rerollCost 음수 → 새로고침하면 골드 증가', (r) => (r.shop.rerollCost = -3)],
];

describe('감사: loadRun은 깨진 세이브를 null로 거부한다', () => {
  it('기준 세이브 자체는 정상 로드된다 (아래 케이스의 전제)', () => {
    const base = shopRun();
    expect(base.bag.stash.length).toBeGreaterThan(0);
    expect(base.shop.slots[0]).not.toBeNull();
    saveRun(base);
    expect(loadRun()).toEqual(base);
  });

  it.each(CORRUPT)('%s', (_label, mutate) => {
    const raw = structuredClone(shopRun());
    mutate(raw);
    mem.setItem(SAVE_KEY, JSON.stringify(raw));
    expect(loadRun()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 결함 2: completeStage(NaN)이 hp를 NaN으로 만들고, 세이브하면 JSON null → 세이브 유실
// ─────────────────────────────────────────────────────────────

describe('감사: completeStage의 비유한 hp 입력', () => {
  it('NaN이면 전투 전 hp를 기준으로 처리하고 세이브가 살아남는다', () => {
    const run = makeRun('capybara');
    run.hp = 70;
    const maxHp = runPlayerStats(data, run).maxHp;
    const res = completeStage(data, run, NaN);
    const heal = Math.round(maxHp * STAGE_CLEAR_HEAL_RATIO);
    expect(res.healed).toBe(heal);
    expect(run.hp).toBe(70 + heal);
    saveRun(run);
    expect(loadRun()).toEqual(run);
  });

  it('±Infinity는 [0, maxHp]로 clamp (회귀)', () => {
    const hi = makeRun('capybara');
    completeStage(data, hi, Infinity);
    expect(hi.hp).toBe(140);
    const lo = makeRun('capybara');
    const res = completeStage(data, lo, -Infinity);
    expect(lo.hp).toBe(res.healed);
    expect(res.healed).toBe(Math.round(140 * STAGE_CLEAR_HEAL_RATIO));
  });
});

// ─────────────────────────────────────────────────────────────
// 결함 3: 골드 비교가 `gold < cost`라 NaN 골드·음수 비용이 검사를 통과한다
// ─────────────────────────────────────────────────────────────

describe('감사: 구매 가드는 NaN 골드와 음수 비용을 막는다', () => {
  it('골드가 NaN이면 어떤 구매도 실패하고 상태 불변', () => {
    const run = shopRun();
    run.hp = 10;
    run.gold = NaN;
    const before = structuredClone(run);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(rerollShop(data, run)).toBe(false);
    expect(buyBagExpand(run, 'col')).toBe(false);
    expect(canBuyHeal(data, run)).toBe(false);
    expect(buyHeal(data, run)).toBe(false);
    expect(run).toEqual(before);
  });

  it('음수 비용(새로고침·상점 가격)으로 골드가 생기지 않는다', () => {
    const run = shopRun();
    run.gold = 0;
    run.shop.rerollCost = -3;
    run.shop.slots[0] = { ...run.shop.slots[0]!, price: -50 };
    const before = structuredClone(run);
    expect(rerollShop(data, run)).toBe(false);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(run).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────
// 결함 4: goldMul 곱의 부동소수 오차로 경계가 내림된다
//   (클리어 골드 반올림: 61.4999… → 61 / 처치 골드 floor: 43.9999… → 43 + 확률 굴림)
// ─────────────────────────────────────────────────────────────

function runWithPiggybanks(tiers: Tier[]): RunState {
  const run = makeRun('cat');
  tiers.forEach((t, x) => expect(addNewToBag(run.bag, data.items, 'g_piggybank', t, x, 0, 0)).not.toBeNull());
  return run;
}

describe('감사: 골드 배수 반올림 경계', () => {
  it('처치 골드: 저금통 ★1×3·★2×3 (×2.95) × 20골드 = 59 — 곱이 58.999…여도 굴림 없이 항상 59', () => {
    const gold20 = { ...data, enemies: { ...data.enemies, dummy: { ...data.enemies.boss_robot, id: 'dummy', gold: 20, dropChance: 0 } } };
    const run = makeRun('cat');
    // 고양이 시작 아이템은 (1,1)·(2,1). 저금통 6개를 이 순서로 (goldMul 합산 순서가 오차를 만든다)
    const spots: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1]];
    ([1, 1, 1, 2, 2, 2] as Tier[]).forEach((t, i) => {
      expect(addNewToBag(run.bag, data.items, 'g_piggybank', t, spots[i][0], spots[i][1], 0)).not.toBeNull();
    });
    const goldMul = runPlayerStats(data, run).goldMul;
    expect(goldMul).toBeCloseTo(2.95);
    expect(20 * goldMul).toBeLessThan(59); // 이 테스트가 노리는 부동소수 경계가 실제로 생긴다
    for (let i = 0; i < 200; i++) expect(rewardKill(gold20, run, 'dummy').gold).toBe(59);
  });

  it('클리어 골드: 저금통 ★1·★1·★2·★2 (×2.3) × 25 = 57.5 → 58', () => {
    const run = runWithPiggybanks([1, 1, 2, 2]);
    run.stageIndex = 2;
    // 실제 스테이지 클리어 골드는 밸런스 조정으로 바뀌므로 .5 경계가 생기는 25골드 스테이지를 따로 둔다
    const clear25 = { ...data, stages: data.stages.map((st, i) => (i === 2 ? { ...st, clearGold: 25 } : st)) };
    expect(completeStage(clear25, run, run.hp).clearGold).toBe(58);
  });
});

// ─────────────────────────────────────────────────────────────
// 회귀: 경제 경계값 (골드 정확히 같음 / 1 모자람)
// ─────────────────────────────────────────────────────────────

describe('감사: 골드가 비용과 정확히 같으면 성공해 0이 되고, 1 모자라면 상태 불변', () => {
  it('buySlot', () => {
    const run = shopRun();
    const price = run.shop.slots[0]!.price;
    run.gold = price - 1;
    const before = structuredClone(run);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(run).toEqual(before);
    run.gold = price;
    expect(buySlot(data, run, 0)).toBe(true);
    expect(run.gold).toBe(0);
  });

  it('rerollShop', () => {
    const run = shopRun();
    const cost = run.shop.rerollCost;
    run.gold = cost - 1;
    const before = structuredClone(run);
    expect(rerollShop(data, run)).toBe(false);
    expect(run).toEqual(before);
    run.gold = cost;
    expect(rerollShop(data, run)).toBe(true);
    expect(run.gold).toBe(0);
    expect(rerollShop(data, run)).toBe(false);
    expect(run.gold).toBe(0);
  });

  it('buyBagExpand', () => {
    const run = shopRun();
    run.gold = BAG_EXPAND_COSTS[0] - 1;
    const before = structuredClone(run);
    expect(buyBagExpand(run, 'row')).toBe(false);
    expect(run).toEqual(before);
    run.gold = BAG_EXPAND_COSTS[0];
    expect(buyBagExpand(run, 'row')).toBe(true);
    expect(run.gold).toBe(0);
    expect(bagExpandCost(run)).toBe(BAG_EXPAND_COSTS[1]);
  });

  it('buyHeal', () => {
    const run = shopRun();
    run.hp = 1;
    run.gold = HEAL_COST - 1;
    expect(buyHeal(data, run)).toBe(false);
    expect(run.hp).toBe(1);
    run.gold = HEAL_COST;
    expect(buyHeal(data, run)).toBe(true);
    expect(run.gold).toBe(0);
  });

  it('보관함이 가득이면 골드가 충분해도 구매 실패, 팔아서 비우면 성공', () => {
    const run = shopRun();
    fillStash(run);
    const price = run.shop.slots[0]!.price;
    run.gold = price;
    const before = structuredClone(run);
    expect(buySlot(data, run, 0)).toBe(false);
    expect(run).toEqual(before);
    const got = sellItem(data, run, run.bag.stash[0].uid);
    expect(got).toBeGreaterThan(0);
    expect(buySlot(data, run, 0)).toBe(true);
    expect(run.gold).toBe(got);
    expect(run.bag.stash).toHaveLength(run.bag.stashCapacity);
  });
});

// ─────────────────────────────────────────────────────────────
// 회귀: RNG 상태 기록 (쓰는 경로는 갱신, 안 쓰는 경로는 그대로)
// ─────────────────────────────────────────────────────────────

describe('감사: rngState 기록', () => {
  it('rewardKill은 드롭 여부·환전 여부와 무관하게 매번 갱신', () => {
    const run = makeRun();
    for (const id of ENEMY_IDS) {
      const before = run.rngState;
      rewardKill(data, run, id);
      expect(run.rngState, id).not.toBe(before);
    }
    fillStash(run);
    const before = run.rngState;
    expect(rewardKill(data, run, SURE_DROP).drop?.converted).toBe(true);
    expect(run.rngState).not.toBe(before);
  });

  it('연속 새로고침은 서로 다른 상태를 거친다 (옛 상태 재사용 없음)', () => {
    const run = shopRun();
    run.gold = 1000;
    const states = new Set<number>([run.rngState]);
    for (let i = 0; i < 20; i++) {
      expect(rerollShop(data, run)).toBe(true);
      states.add(run.rngState);
    }
    expect(states.size).toBe(21);
  });

  it('RNG를 쓰지 않는 행동은 rngState를 바꾸지 않는다', () => {
    const run = shopRun();
    run.hp = 10;
    run.gold = 1000;
    const rng = run.rngState;
    toggleLock(run, 0);
    buySlot(data, run, 1);
    sellItem(data, run, run.bag.stash[0].uid);
    buyBagExpand(run, 'col');
    buyHeal(data, run);
    run.gold = 0;
    rerollShop(data, run); // 실패
    expect(run.rngState).toBe(rng);
  });

  it('마지막 스테이지 클리어는 상점을 굴리지 않아 rngState·상점·잠금 그대로', () => {
    const run = shopRun();
    toggleLock(run, 2);
    run.stageIndex = data.stages.length - 1;
    const rng = run.rngState;
    const shop = structuredClone(run.shop);
    const res = completeStage(data, run, 50);
    expect(res.finished).toBe(true);
    expect(run.rngState).toBe(rng);
    expect(run.shop).toEqual(shop);
    expect(isRunComplete(data, run)).toBe(true);
    // 끝난 런에 다시 호출해도 무변경
    const after = structuredClone(run);
    expect(completeStage(data, run, 10)).toEqual({ clearGold: 0, healed: 0, finished: true });
    expect(run).toEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────
// 회귀: 무작위 세션 불변식 + 세이브 왕복 + 결정성
// ─────────────────────────────────────────────────────────────

function shopOp(run: RunState, r: Rng): void {
  switch (r.int(0, 8)) {
    case 0:
      rerollShop(data, run);
      break;
    case 1:
      buySlot(data, run, r.int(-1, SHOP_SLOTS));
      break;
    case 2:
      toggleLock(run, r.int(0, SHOP_SLOTS - 1));
      break;
    case 3: {
      const all = [...run.bag.items, ...run.bag.stash];
      if (all.length > 0) sellItem(data, run, r.pick(all).uid);
      break;
    }
    case 4:
      buyBagExpand(run, r.chance(0.5) ? 'col' : 'row');
      break;
    case 5:
      buyHeal(data, run);
      break;
    case 6: {
      // 보관함 → 가방 (bag.ts 연동)
      if (run.bag.stash.length === 0) break;
      const s = r.pick(run.bag.stash);
      const spot = findFreeSpot(run.bag, data.items, s.defId);
      if (spot) placeFromStash(run.bag, data.items, s.uid, spot.x, spot.y, spot.rot);
      break;
    }
    case 7: {
      const opts = findMerges(run.bag, data);
      if (opts.length > 0) applyMerge(run.bag, data, r.pick(opts));
      break;
    }
    default:
      run.gold += r.int(0, 30);
  }
}

function expectInvariants(run: RunState): void {
  expect(Number.isInteger(run.gold) && run.gold >= 0, `gold ${run.gold}`).toBe(true);
  expect(Number.isFinite(run.hp) && run.hp >= 0, `hp ${run.hp}`).toBe(true);
  expect(run.shop.slots).toHaveLength(SHOP_SLOTS);
  const uids = [...run.bag.items, ...run.bag.stash].map((i) => i.uid);
  expect(new Set(uids).size).toBe(uids.length);
  for (const u of uids) expect(u).toBeLessThan(run.bag.nextUid);
  expect(run.bag.stash.length).toBeLessThanOrEqual(run.bag.stashCapacity);
}

/** 스테이지 클리어 → 상점 행동을 끝까지 반복. reload면 상점마다 세이브 → 로드한 객체로 계속 */
function randomSession(seed: number, reload: boolean): RunState {
  const r = new Rng(seed);
  let run = newRun(data, r.pick(CHARACTER_IDS), r.int(0, 0xffffffff));
  while (!isRunComplete(data, run)) {
    const kills = r.int(5, 40);
    for (let i = 0; i < kills; i++) rewardKill(data, run, r.pick(ENEMY_IDS));
    const maxHp = runPlayerStats(data, run).maxHp;
    const res = completeStage(data, run, r.range(0, maxHp));
    expect(run.hp).toBeLessThanOrEqual(maxHp);
    expectInvariants(run);
    if (res.finished) break;

    saveRun(run);
    const loaded = loadRun();
    expect(loaded).toEqual(run);
    if (reload) run = loaded!;

    const ops = r.int(0, 30);
    for (let i = 0; i < ops; i++) {
      shopOp(run, r);
      expectInvariants(run);
    }
    saveRun(run);
    expect(loadRun()).toEqual(run);
  }
  return run;
}

describe('감사: 무작위 세션', () => {
  it('불변식 유지, 정상 상태는 항상 세이브 왕복, 로드해서 이어가도 같은 결과', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const a = randomSession(seed, false);
      const b = randomSession(seed, true);
      expect(b).toEqual(a);
      expect(a.stats.stagesCleared).toBe(data.stages.length);
    }
  });
});

// 회귀: 잠금은 스테이지를 넘어 유지
describe('감사: 잠금 칸', () => {
  it('잠긴 칸은 스테이지를 넘어 유지되고, 산 칸만 다시 채워진다', () => {
    const run = shopRun();
    run.gold = 1000;
    toggleLock(run, 1);
    const locked: ShopSlot = { ...run.shop.slots[1]! };
    expect(buySlot(data, run, 0)).toBe(true);
    completeStage(data, run, run.hp);
    expect(run.shop.slots[1]).toEqual(locked);
    expect(run.shop.slots[0]).not.toBeNull();
    expect(run.shop.slots.filter((s) => s?.locked)).toHaveLength(1);
  });
});
