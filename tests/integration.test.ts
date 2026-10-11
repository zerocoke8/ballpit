// 모듈 사이 이음매 검사: 에셋 manifest ↔ assets.json ↔ 데이터, i18n 모양, run ↔ bag ↔ sim 흐름.
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifestJson from '../public/assets/manifest.json';
import { SAVE_KEY, SIM_DT } from '../src/config';
import { ASSET_MAP, ASSETS, GAME_DATA } from '../src/data/index';
import { T } from '../src/i18n/ko/index';
import { addNewToBag, addToStash, findFreeSpot, moveToStash, placeFromStash } from '../src/logic/bag';
import { CombatSim } from '../src/logic/combat/sim';
import {
  clampRunHp,
  combatSeed,
  completeStage,
  currentStage,
  isRunValid,
  loadRun,
  newRun,
  rewardKill,
  runLoadout,
  runPlayerStats,
  saveRun,
} from '../src/logic/run';
import { sellItem } from '../src/logic/shop';
import type { AnimState, AssetManifest, ItemKind, Rarity, RunState } from '../src/types';

const data = GAME_DATA;

// public/assets 아래 실제 파일 목록 (내용은 불러오지 않음)
const PUBLIC_FILES = new Set(
  Object.keys(import.meta.glob('../public/assets/**/*')).map((p) => p.replace('../public/assets/', '')),
);
const ANIM_STATES: readonly AnimState[] = ['idle', 'move', 'attack', 'hit', 'die'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

describe('에셋 manifest ↔ assets.json', () => {
  const manifest = manifestJson as unknown;

  it('AssetManifest 모양이다 (images, anims)', () => {
    expect(isRecord(manifest)).toBe(true);
    const m = manifest as Record<string, unknown>;
    expect(isRecord(m.images)).toBe(true);
    expect(isRecord(m.anims)).toBe(true);
    for (const [k, v] of Object.entries(m.images as Record<string, unknown>)) {
      expect(typeof v === 'string' && v.length > 0, `images.${k}`).toBe(true);
    }
  });

  it('images의 키는 모두 assets.json에 있고 PNG 파일이 존재한다', () => {
    const { images } = manifestJson as AssetManifest;
    for (const [key, rel] of Object.entries(images)) {
      expect(ASSET_MAP[key], `manifest images.${key} 미등록 키`).toBeDefined();
      expect(rel.endsWith('.png'), `${key}: ${rel}`).toBe(true);
      expect(PUBLIC_FILES.has(rel), `${key}: public/assets/${rel} 없음`).toBe(true);
    }
  });

  it('anims(Seedance 스프라이트시트)는 등록된 키·선언된 상태만, 시트 파일이 존재한다', () => {
    const anims = (manifestJson as { anims: Record<string, unknown> }).anims;
    for (const [key, states] of Object.entries(anims)) {
      const def = ASSET_MAP[key];
      expect(def, `manifest anims.${key} 미등록 키`).toBeDefined();
      expect(isRecord(states), `anims.${key}`).toBe(true);
      for (const [state, spec] of Object.entries(states as Record<string, unknown>)) {
        const ctx = `anims.${key}.${state}`;
        expect(ANIM_STATES.includes(state as AnimState), `${ctx}: 모르는 상태`).toBe(true);
        expect(def.anims ?? [], `${ctx}: assets.json anims에 선언 안 됨`).toContain(state);
        expect(isRecord(spec), ctx).toBe(true);
        const s = spec as Record<string, unknown>;
        expect(typeof s.sheet === 'string' && s.sheet.endsWith('.json'), `${ctx}.sheet`).toBe(true);
        expect(PUBLIC_FILES.has(s.sheet as string), `${ctx}: public/assets/${String(s.sheet)} 없음`).toBe(true);
        expect(typeof s.fps === 'number' && s.fps > 0, `${ctx}.fps`).toBe(true);
        expect(typeof s.loop, `${ctx}.loop`).toBe('boolean');
      }
    }
  });

  it('캐릭터·적 스프라이트는 애니메이션 상태를 선언한다 (idle/hit/die 필수)', () => {
    const sprites = [
      ...Object.values(data.characters).map((c) => c.sprite),
      ...Object.values(data.enemies).map((e) => e.sprite),
    ];
    for (const key of sprites) {
      const states = ASSET_MAP[key]?.anims ?? [];
      for (const s of ['idle', 'hit', 'die'] as const) expect(states, `${key}.anims`).toContain(s);
    }
    // 애니메이션은 캐릭터/적에만
    for (const a of ASSETS) {
      if (a.anims?.length) expect(['character', 'enemy'], a.key).toContain(a.category);
    }
  });
});

describe('i18n', () => {
  it('T는 영역 5개를 모은다', () => {
    expect(Object.keys(T).sort()).toEqual(['bag', 'combat', 'common', 'menu', 'shop']);
  });

  it('공용 이름표가 데이터의 모든 등급·속성·종류를 덮는다', () => {
    const rarities = new Set<Rarity>(Object.values(data.items).map((d) => d.rarity));
    const kinds = new Set<ItemKind>(Object.values(data.items).map((d) => d.kind));
    for (const r of rarities) expect(T.common.rarity[r], r).toBeTruthy();
    for (const k of kinds) expect(T.common.kind[k], k).toBeTruthy();
    for (const e of ['fire', 'ice', 'lightning'] as const) expect(T.common.element[e], e).toBeTruthy();
  });
});

// ── run ↔ bag ↔ sim ────────────────────────────────────────

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isRunValid / loadRun(data)', () => {
  it('새 런은 유효하다', () => {
    for (const id of Object.keys(data.characters)) expect(isRunValid(data, newRun(data, id, 1))).toBe(true);
  });

  it('없는 아이템·캐릭터 id, 겹침, 범위 밖, 끝난 런을 거른다', () => {
    const cases: [string, (r: RunState) => void][] = [
      ['unknown character', (r) => (r.characterId = 'dog')],
      ['unknown bag item', (r) => (r.bag.items[0].defId = 'w_removed')],
      ['unknown stash item', (r) => r.bag.stash.push({ uid: r.bag.nextUid++, defId: 's_removed', tier: 1 })],
      ['unknown shop item', (r) => (r.shop.slots[0] = { defId: 'x', tier: 1, price: 1, locked: false })],
      ['overlap', (r) => ((r.bag.items[1].x = r.bag.items[0].x), (r.bag.items[1].y = r.bag.items[0].y))],
      ['out of bounds', (r) => (r.bag.items[0].x = r.bag.cols - 1)], // 펭구 생선 2×1
      ['finished run', (r) => (r.stageIndex = data.stages.length)],
    ];
    for (const [name, mutate] of cases) {
      const run = newRun(data, 'penguin', 3);
      mutate(run);
      expect(isRunValid(data, run), name).toBe(false);
    }
  });

  it('loadRun(data)는 데이터와 맞지 않는 세이브를 null로, loadRun()은 모양만 본다', () => {
    const mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
    const run = newRun(data, 'cat', 9);
    saveRun(run);
    expect(loadRun(data)).toEqual(run);

    run.bag.items[0].defId = 'w_renamed';
    saveRun(run);
    expect(loadRun()).not.toBeNull();
    expect(loadRun(data)).toBeNull();
    expect(mem.getItem(SAVE_KEY)).not.toBeNull(); // 지우는 건 호출 측 결정
  });
});

describe('clampRunHp', () => {
  it('냄비 뚜껑을 팔면 hp가 새 maxHp로 내려가고, 늘어날 때는 그대로', () => {
    const run = newRun(data, 'cat', 5); // HP 패시브 없는 캐릭터
    const spot = findFreeSpot(run.bag, data.items, 'g_potlid')!;
    const lid = addNewToBag(run.bag, data.items, 'g_potlid', 1, spot.x, spot.y, spot.rot)!;
    run.hp = runPlayerStats(data, run).maxHp; // 125
    expect(run.hp).toBe(125);

    sellItem(data, run, lid.uid);
    expect(run.hp).toBe(125); // 판매 자체는 hp를 건드리지 않는다 (계약)
    clampRunHp(data, run);
    expect(run.hp).toBe(100);

    addNewToBag(run.bag, data.items, 'g_potlid', 1, spot.x, spot.y, spot.rot);
    clampRunHp(data, run);
    expect(run.hp).toBe(100);
  });
});

describe('한 스테이지 흐름 (run → sim → 보상 → 클리어 → 상점 → 세이브)', () => {
  /** 테스트용 단순 조작: 바닥 가운데에 서 있기 */
  const HOLD = { targetX: 336, targetY: 880 };

  it('카피바라 st1을 시작 무기로 끝까지 진행한다', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    const run = newRun(data, 'capybara', 42);
    const sim = new CombatSim({
      stage: currentStage(data, run),
      stageIndex: run.stageIndex,
      enemies: data.enemies,
      loadout: runLoadout(data, run),
      player: runPlayerStats(data, run),
      hp: run.hp,
      seed: combatSeed(run),
    });
    expect(sim.weapons).toHaveLength(2);

    let kills = 0;
    let goldFromKills = 0;
    let paused = false;
    for (let i = 0; i < 60 * 300 && sim.status === 'running'; i++) {
      sim.step(SIM_DT, HOLD);
      for (const ev of sim.drainEvents()) {
        if (ev.type !== 'kill') continue;
        kills++;
        goldFromKills += rewardKill(data, run, ev.defId).gold;
      }
      // 전투 중 가방 일시정지: 유자 하나를 보관함에 넣었다가 다시 꺼낸다
      if (!paused && sim.time > 10) {
        paused = true;
        const uid = run.bag.items[0].uid;
        expect(moveToStash(run.bag, uid)).toBe(true);
        sim.setLoadout(runLoadout(data, run), runPlayerStats(data, run));
        expect(sim.weapons.map((w) => w.uid)).not.toContain(uid);
        expect(run.bag.stash.map((s) => s.uid)).toContain(uid); // 처치 드롭이 먼저 들어와 있을 수 있다
        // 보관함 → 가방 (원래 자리)
        expect(placeFromStash(run.bag, data.items, uid, 1, 1, 0)).toBe(true);
        expect(isRunValid(data, run)).toBe(true);
        sim.setLoadout(runLoadout(data, run), runPlayerStats(data, run));
        expect(sim.weapons).toHaveLength(2);
      }
    }

    expect(sim.status).toBe('won');
    expect(kills).toBe(sim.totalEnemies);
    expect(run.stats.kills).toBe(kills);
    expect(run.gold).toBeGreaterThanOrEqual(goldFromKills);

    const before = run.gold;
    const res = completeStage(data, run, sim.player.hp);
    expect(res.finished).toBe(false);
    expect(run.gold).toBe(before + res.clearGold);
    expect(run.stageIndex).toBe(1);
    expect(run.resumeAt).toBe('shop');
    expect(run.shop.slots.every((s) => s !== null)).toBe(true);
    expect(run.hp).toBeLessThanOrEqual(runPlayerStats(data, run).maxHp);

    saveRun(run);
    const loaded = loadRun(data);
    expect(loaded).toEqual(run);
    // 이어하기 후에도 다음 전투를 바로 만들 수 있다
    const next = new CombatSim({
      stage: currentStage(data, loaded!),
      stageIndex: loaded!.stageIndex,
      enemies: data.enemies,
      loadout: runLoadout(data, loaded!),
      player: runPlayerStats(data, loaded!),
      hp: loaded!.hp,
      seed: combatSeed(loaded!),
    });
    expect(next.totalEnemies).toBeGreaterThan(0);
  });

  it('드롭으로 보관함에 들어온 아이템도 유효한 런으로 남는다', () => {
    const run = newRun(data, 'penguin', 8);
    for (let i = 0; i < 30; i++) rewardKill(data, run, 'boss_robot'); // 드롭 확률 1
    expect(run.bag.stash.length).toBeGreaterThan(0);
    expect(isRunValid(data, run)).toBe(true);
    expect(addToStash(run.bag, 's_power', 1)).toBeNull(); // 가득 참 → 이후 드롭은 환전
  });
});
