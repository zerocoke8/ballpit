import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SAVE_KEY,
  SAVE_VERSION,
  SHOP_REROLL_BASE,
  SHOP_SLOTS,
  STAGE_CLEAR_HEAL_RATIO,
} from '../src/config';
import { GAME_DATA } from '../src/data/index';
import { addNewToBag, addToStash } from '../src/logic/bag';
import { Rng } from '../src/logic/rng';
import {
  clearRun,
  combatSeed,
  completeStage,
  currentStage,
  isRunComplete,
  loadRun,
  newRun,
  rewardKill,
  rollDropItem,
  runCharacter,
  runLoadout,
  runPlayerStats,
  saveRun,
} from '../src/logic/run';
import { sellPrice } from '../src/logic/stats';
import type { RunState, ShopSlot } from '../src/types';

const data = GAME_DATA;
const CHARACTER_IDS = ['penguin', 'capybara', 'cat'] as const;

function makeRun(characterId = 'penguin', seed = 1234): RunState {
  return newRun(data, characterId, seed);
}

function fillStash(run: RunState): void {
  while (addToStash(run.bag, 's_power', 1)) {
    // 가득 찰 때까지
  }
}

/** 보관함을 가득 채우지 않는 범위에서 아이템 드롭이 확실한 적 */
const SURE_DROP = 'boss_robot';

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

describe('newRun', () => {
  it.each(CHARACTER_IDS)('%s: 시작 아이템 배치, hp = maxHp, 초기 상태', (id) => {
    const run = makeRun(id);
    const character = data.characters[id];

    expect(run.version).toBe(SAVE_VERSION);
    expect(run.characterId).toBe(id);
    expect(runCharacter(data, run)).toBe(character);
    expect(run.stageIndex).toBe(0);
    expect(run.resumeAt).toBe('combat');
    expect(run.gold).toBe(0);
    expect(run.stats).toEqual({ kills: 0, goldEarned: 0, stagesCleared: 0 });
    expect(run.shop).toEqual({
      slots: new Array(SHOP_SLOTS).fill(null),
      rerollCost: SHOP_REROLL_BASE,
      healBought: false,
    });
    expect(run.bag.stash).toEqual([]);
    expect(run.bag.items).toHaveLength(character.startItems.length);
    for (const si of character.startItems) {
      expect(run.bag.items).toContainEqual(
        expect.objectContaining({ defId: si.defId, x: si.x, y: si.y, rot: si.rot, tier: si.tier ?? 1 }),
      );
    }
    const stats = runPlayerStats(data, run);
    expect(run.hp).toBe(stats.maxHp);
  });

  it('카피바라는 최대 HP +40%', () => {
    expect(makeRun('capybara').hp).toBe(Math.round(data.characters.capybara.baseMaxHp * 1.4));
    expect(makeRun('capybara').hp).toBe(140);
    expect(makeRun('cat').hp).toBe(data.characters.cat.baseMaxHp); // HP 패시브 없음
  });

  it('시작 무기로 loadout이 나온다', () => {
    for (const id of CHARACTER_IDS) {
      const run = makeRun(id);
      const weapons = run.bag.items.filter((it) => data.items[it.defId].kind === 'weapon');
      expect(runLoadout(data, run).map((w) => w.uid)).toHaveLength(weapons.length);
    }
    // 펭구: 얼음 속성석이 생선 옆 → 얼음 속성
    expect(runLoadout(data, makeRun('penguin'))[0].elements).toContain('ice');
  });

  it('같은 시드면 같은 런, 모르는 캐릭터는 에러', () => {
    expect(makeRun('cat', 99)).toEqual(makeRun('cat', 99));
    expect(makeRun('cat', 99).rngState).not.toBe(makeRun('cat', 100).rngState);
    expect(() => newRun(data, 'nobody', 1)).toThrow();
  });
});

describe('스테이지 조회 / 전투 시드', () => {
  it('currentStage는 stageIndex의 스테이지', () => {
    const run = makeRun();
    expect(currentStage(data, run)).toBe(data.stages[0]);
    run.stageIndex = 2;
    expect(currentStage(data, run)).toBe(data.stages[2]);
  });

  it('combatSeed는 seed·stageIndex로 결정', () => {
    const a = makeRun('penguin', 5);
    const b = makeRun('penguin', 5);
    expect(combatSeed(a)).toBe(combatSeed(b));
    const s0 = combatSeed(a);
    a.stageIndex = 1;
    expect(combatSeed(a)).not.toBe(s0);
    expect(combatSeed(makeRun('penguin', 6))).not.toBe(s0);
    expect(Number.isInteger(s0) && s0 >= 0 && s0 <= 0xffffffff).toBe(true);
    // rngState가 바뀌어도 전투 시드는 그대로
    a.stageIndex = 0;
    a.rngState = 777;
    expect(combatSeed(a)).toBe(s0);
  });
});

describe('rewardKill', () => {
  it('처치 골드 지급 + 통계', () => {
    const run = makeRun();
    const r = rewardKill(data, run, 'teddy');
    expect(r.gold).toBe(data.enemies.teddy.gold);
    expect(run.stats.kills).toBe(1);
    const dropGold = r.drop?.convertedGold ?? 0;
    expect(run.gold).toBe(r.gold + dropGold);
    expect(run.stats.goldEarned).toBe(r.gold + dropGold);
  });

  /** gold 값만 바꾼 가짜 적 (드롭 없음) */
  function withGold(gold: number): typeof data {
    const dummy = { ...data.enemies.soldier, id: 'dummy', gold, dropChance: 0 };
    return { ...data, enemies: { ...data.enemies, dummy } };
  }

  it('소수 골드: floor(g) 확정 + 소수 부분 확률로 +1 (goldMul 1)', () => {
    const d = withGold(2.3);
    const run = makeRun('cat', 5);
    const counts = new Map<number, number>();
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const g = rewardKill(d, run, 'dummy').gold;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([2, 3]);
    expect(counts.get(3)! / N).toBeCloseTo(0.3, 1);
    expect(run.stats.kills).toBe(N);
    expect(run.gold).toBe(run.stats.goldEarned);
    expect(run.gold).toBe(2 * N + counts.get(3)!);
  });

  it('정수 골드는 굴림 없이 그대로', () => {
    const run = makeRun();
    for (let i = 0; i < 50; i++) expect(rewardKill(withGold(3), run, 'dummy').gold).toBe(3);
  });

  it('0골드 처치도 있다 (처치 수는 셈)', () => {
    const run = makeRun();
    for (let i = 0; i < 20; i++) expect(rewardKill(withGold(0), run, 'dummy').gold).toBe(0);
    expect(run.gold).toBe(0);
    expect(run.stats.kills).toBe(20);
    expect(run.stats.goldEarned).toBe(0);
  });

  it('goldMul 반영 (돼지 저금통): g = def.gold × goldMul 에 같은 규칙', () => {
    const run = makeRun();
    expect(addNewToBag(run.bag, data.items, 'g_piggybank', 1, 4, 0, 0)).not.toBeNull();
    expect(runPlayerStats(data, run).goldMul).toBeCloseTo(1.25);
    // 4 × 1.25 = 5 → 항상 5
    for (let i = 0; i < 20; i++) expect(rewardKill(withGold(4), run, 'dummy').gold).toBe(5);
    // 1 × 1.25 = 1.25 → 1 또는 2, 평균 1.25
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const g = rewardKill(withGold(1), run, 'dummy').gold;
      expect(g === 1 || g === 2).toBe(true);
      sum += g;
    }
    expect(sum / N).toBeCloseTo(1.25, 1);
  });

  it('데이터의 적 처치 골드 기대값 = def.gold (병정 0.2)', () => {
    const run = makeRun('cat', 99);
    const N = 5000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += rewardKill(data, run, 'soldier').gold;
    expect(sum / N).toBeCloseTo(data.enemies.soldier.gold, 1);
  });

  it('드롭은 보관함으로 (★1, 상점 후보 중)', () => {
    const run = makeRun();
    const r = rewardKill(data, run, SURE_DROP);
    expect(r.drop).not.toBeNull();
    const drop = r.drop!;
    expect(drop.converted).toBe(false);
    expect(drop.convertedGold).toBe(0);
    expect(drop.tier).toBe(1);
    expect(run.bag.stash).toHaveLength(1);
    expect(run.bag.stash[0]).toEqual({ uid: drop.uid, defId: drop.defId, tier: 1 });
    const def = data.items[drop.defId];
    expect(def.shopWeight).toBeGreaterThan(0);
    expect(def.minStage).toBeLessThanOrEqual(run.stageIndex);
    expect(run.gold).toBe(r.gold);
  });

  it('보관함이 가득이면 판매가만큼 골드로 환전', () => {
    const run = makeRun();
    fillStash(run);
    const stashBefore = structuredClone(run.bag.stash);
    const r = rewardKill(data, run, SURE_DROP);
    const drop = r.drop!;
    expect(drop.converted).toBe(true);
    expect(drop.uid).toBeNull();
    expect(drop.convertedGold).toBe(sellPrice(data.items[drop.defId], 1));
    expect(run.bag.stash).toEqual(stashBefore);
    expect(run.gold).toBe(r.gold + drop.convertedGold);
    expect(run.stats.goldEarned).toBe(r.gold + drop.convertedGold);
  });

  it('dropChance 0이면 드롭 없음', () => {
    const noDrop = { ...data, enemies: { ...data.enemies, dummy: { ...data.enemies.soldier, id: 'dummy', dropChance: 0 } } };
    const run = makeRun();
    for (let i = 0; i < 50; i++) expect(rewardKill(noDrop, run, 'dummy').drop).toBeNull();
    expect(run.bag.stash).toHaveLength(0);
  });

  it('같은 rngState면 같은 드롭, rngState는 갱신된다', () => {
    const a = makeRun('cat', 31);
    const b = structuredClone(a);
    const seq = ['balloon', 'teddy', 'soldier', 'balloon', 'teddy', 'jack', 'teddy', 'balloon'];
    const before = a.rngState;
    const ra = seq.map((e) => rewardKill(data, a, e));
    const rb = seq.map((e) => rewardKill(data, b, e));
    expect(ra).toEqual(rb);
    expect(a).toEqual(b);
    expect(a.rngState).not.toBe(before);
  });

  it('모르는 적은 에러', () => {
    expect(() => rewardKill(data, makeRun(), 'nope')).toThrow();
  });
});

describe('rollDropItem', () => {
  it('상점 규칙: 스테이지 0은 common/rare, ★1, 후보만', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 500; i++) {
      const d = rollDropItem(data, 0, rng);
      expect(d).not.toBeNull();
      const def = data.items[d!.defId];
      expect(d!.tier).toBe(1);
      expect(['common', 'rare']).toContain(def.rarity);
      expect(def.shopWeight).toBeGreaterThan(0);
      expect(def.minStage).toBe(0);
    }
  });

  it('후반에도 ★1만', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 300; i++) expect(rollDropItem(data, 4, rng)!.tier).toBe(1);
  });
});

describe('completeStage', () => {
  it('골드·회복·진행·상점 굴림', () => {
    const run = makeRun('capybara');
    run.gold = 5;
    run.shop.rerollCost = 7;
    run.shop.healBought = true;
    const maxHp = runPlayerStats(data, run).maxHp;

    const res = completeStage(data, run, 50);

    const expectedHeal = Math.round(maxHp * STAGE_CLEAR_HEAL_RATIO);
    expect(res).toEqual({ clearGold: data.stages[0].clearGold, healed: expectedHeal, finished: false });
    expect(run.hp).toBe(50 + expectedHeal);
    expect(run.gold).toBe(5 + data.stages[0].clearGold);
    expect(run.stageIndex).toBe(1);
    expect(run.stats.stagesCleared).toBe(1);
    expect(run.resumeAt).toBe('shop');
    expect(run.shop.rerollCost).toBe(SHOP_REROLL_BASE);
    expect(run.shop.healBought).toBe(false);
    expect(run.shop.slots).toHaveLength(SHOP_SLOTS);
    expect(run.shop.slots.every((s) => s !== null)).toBe(true);
    expect(isRunComplete(data, run)).toBe(false);
  });

  it('클리어 골드에 goldMul 반영', () => {
    const run = makeRun();
    addNewToBag(run.bag, data.items, 'g_piggybank', 1, 4, 0, 0);
    const res = completeStage(data, run, 100);
    expect(res.clearGold).toBe(Math.round(data.stages[0].clearGold * 1.25));
    expect(run.gold).toBe(res.clearGold);
  });

  it('회복은 최대 HP를 넘지 않는다', () => {
    const run = makeRun('capybara');
    const res = completeStage(data, run, 130);
    expect(res.healed).toBe(10);
    expect(run.hp).toBe(140);

    const over = makeRun('capybara');
    const r2 = completeStage(data, over, 999);
    expect(r2.healed).toBe(0);
    expect(over.hp).toBe(140);
  });

  it('잠긴 칸은 유지된다', () => {
    const run = makeRun();
    const locked: ShopSlot = { defId: 'w_duck', tier: 1, price: 16, locked: true };
    run.shop.slots = [null, null, locked, null];
    completeStage(data, run, 100);
    expect(run.shop.slots[2]).toEqual({ ...locked });
    expect(run.shop.slots.filter((s) => s !== null)).toHaveLength(SHOP_SLOTS);
  });

  it('같은 상태면 같은 상점', () => {
    const a = makeRun('cat', 8);
    const b = structuredClone(a);
    completeStage(data, a, 60);
    completeStage(data, b, 60);
    expect(a).toEqual(b);
  });

  it('마지막 스테이지면 finished, 상점은 굴리지 않음', () => {
    const run = makeRun();
    run.stageIndex = data.stages.length - 1;
    const res = completeStage(data, run, 40);
    expect(res.finished).toBe(true);
    expect(res.clearGold).toBe(data.stages[data.stages.length - 1].clearGold);
    expect(run.stageIndex).toBe(data.stages.length);
    expect(isRunComplete(data, run)).toBe(true);
    expect(run.shop.slots.every((s) => s === null)).toBe(true);
    expect(run.resumeAt).toBe('combat');
    expect(run.stats.stagesCleared).toBe(1);
  });

  it('이미 끝난 런은 변경 없음', () => {
    const run = makeRun();
    run.stageIndex = data.stages.length;
    const before = structuredClone(run);
    expect(completeStage(data, run, 10)).toEqual({ clearGold: 0, healed: 0, finished: true });
    expect(run).toEqual(before);
  });

  it('5스테이지 연속 클리어', () => {
    const run = makeRun('penguin', 2024);
    let finished = false;
    for (let i = 0; i < data.stages.length; i++) {
      expect(finished).toBe(false);
      finished = completeStage(data, run, run.hp).finished;
    }
    expect(finished).toBe(true);
    expect(run.stats.stagesCleared).toBe(data.stages.length);
  });
});

describe('세이브 / 로드', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('왕복하면 같은 런', () => {
    const mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
    const run = makeRun('cat', 77);
    rewardKill(data, run, SURE_DROP);
    completeStage(data, run, 60);

    saveRun(run);
    expect(mem.getItem(SAVE_KEY)).not.toBeNull();
    expect(loadRun()).toEqual(run);

    clearRun();
    expect(mem.getItem(SAVE_KEY)).toBeNull();
    expect(loadRun()).toBeNull();
  });

  it('버전이 다르면 null', () => {
    const mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
    const run = makeRun();
    mem.setItem(SAVE_KEY, JSON.stringify({ ...run, version: SAVE_VERSION + 1 }));
    expect(loadRun()).toBeNull();
  });

  it('깨진 JSON / 모양이 틀리면 null', () => {
    const mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
    mem.setItem(SAVE_KEY, '{not json');
    expect(loadRun()).toBeNull();
    mem.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION }));
    expect(loadRun()).toBeNull();
    const run = makeRun();
    mem.setItem(SAVE_KEY, JSON.stringify({ ...run, bag: { ...run.bag, items: 'x' } }));
    expect(loadRun()).toBeNull();
    mem.setItem(SAVE_KEY, JSON.stringify(null));
    expect(loadRun()).toBeNull();
  });

  it('localStorage가 없거나 예외를 던져도 터지지 않는다', () => {
    vi.stubGlobal('localStorage', undefined);
    const run = makeRun();
    expect(() => saveRun(run)).not.toThrow();
    expect(loadRun()).toBeNull();
    expect(() => clearRun()).not.toThrow();

    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', broken);
    expect(() => saveRun(run)).not.toThrow();
    expect(loadRun()).toBeNull();
    expect(() => clearRun()).not.toThrow();
  });
});
