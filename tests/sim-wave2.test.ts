// CombatSim 2차 변경: 부채꼴 없는 다발 연사, 최대 HP 회복 악용 방지, 디버그 헬퍼.
import { describe, expect, it } from 'vitest';
import { FIELD_W, PLAYER_START_Y, SIM_DT } from '../src/config';
import { CombatSim } from '../src/logic/combat/sim';
import type { CombatEvent, CombatInput, EnemyDef, EnemyEntity, PlayerStats, StageDef, WeaponLoadout } from '../src/types';

const IDLE: CombatInput = { targetX: null, targetY: null };

function enemyDef(id: string, o: Partial<EnemyDef> = {}): EnemyDef {
  return { id, name: id, sprite: `enemy_${id}`, w: 1, h: 1, hp: 100000, gold: 1, dropChance: 0, ...o };
}

const ENEMIES: Record<string, EnemyDef> = {
  dummy: enemyDef('dummy'),
  weak: enemyDef('weak', { hp: 1 }),
};
const LEGEND: Record<string, string> = { d: 'dummy', w: 'weak' };
const PLAYER: PlayerStats = { maxHp: 100, moveSpeed: 300, regenPerSec: 0, goldMul: 1, damageMul: 1, cooldownMul: 1 };

function weapon(o: Partial<WeaponLoadout> = {}): WeaponLoadout {
  return {
    uid: 1,
    defId: 'w_test',
    tier: 1,
    cooldown: 5,
    damage: 1,
    count: 1,
    spreadDeg: 0,
    speed: 600,
    radius: 8,
    pierce: 0,
    maxBounces: 0,
    elements: [],
    explodeRadius: 0,
    split: null,
    sprite: 'proj_test',
    spin: false,
    ...o,
  };
}

function makeSim(rows: string[], loadout: WeaponLoadout[], o: { hp?: number; player?: Partial<PlayerStats>; seed?: number } = {}): CombatSim {
  const stage: StageDef = {
    id: 'test',
    name: 'test',
    descentSpeed: 0,
    hpMul: 1,
    dmgMul: 1,
    clearGold: 0,
    rows,
    legend: LEGEND,
    background: 'bg_test',
  };
  const player = { ...PLAYER, ...o.player };
  return new CombatSim({
    stage,
    stageIndex: 0,
    enemies: ENEMIES,
    loadout,
    player,
    hp: o.hp ?? player.maxHp,
    seed: o.seed ?? 7,
  });
}

/** 한 스텝 진행하고 그 스텝의 이벤트 반환 */
function tick(sim: CombatSim, input: CombatInput = IDLE): CombatEvent[] {
  sim.step(SIM_DT, input);
  return sim.drainEvents();
}

function fires(ev: CombatEvent[]): Extract<CombatEvent, { type: 'fire' }>[] {
  return ev.filter((e): e is Extract<CombatEvent, { type: 'fire' }> => e.type === 'fire');
}

/** 첫 'fire'가 나는 스텝까지 진행. 그 스텝 번호(1부터) 반환 */
function untilFirstFire(sim: CombatSim, max = 120): number {
  for (let i = 1; i <= max; i++) if (fires(tick(sim)).length > 0) return i;
  throw new Error('no fire');
}

function angleDeg(vx: number, vy: number): number {
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

function aimDeg(e: EnemyEntity, ox: number, oy: number): number {
  return angleDeg(e.x + e.w / 2 - ox, e.y + e.h / 2 - oy);
}

const PX = FIELD_W / 2;
const FIRE_Y = PLAYER_START_Y - 30;
const JITTER = 2 + 1e-9;

// ── 연사 ────────────────────────────────────────────────────────

describe('CombatSim burst fire (count > 1, spreadDeg 0)', () => {
  it('fires one shot now and the rest 0.07 s apart, one fire event (count 1) per shot', () => {
    const sim = makeSim(['...d....'], [weapon({ count: 3 })]);
    sim.enemies[0].y = 300;
    untilFirstFire(sim);
    expect(sim.projectiles).toHaveLength(1);

    const times: number[] = [sim.time];
    let total = 1;
    for (let i = 0; i < 60; i++) {
      const f = fires(tick(sim));
      for (const e of f) {
        expect(e.count).toBe(1);
        expect(e.weaponUid).toBe(1);
        times.push(sim.time);
      }
      total += f.length;
    }
    expect(total).toBe(3);
    expect(sim.projectiles).toHaveLength(3);
    // 고정 스텝 오차(한 스텝) 이내로 0.07초 간격
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.07 - SIM_DT - 1e-9);
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(0.07 + SIM_DT + 1e-9);
    }
    // 세 발이 모두 다른 시각에 출발 → 같은 자리에 겹치지 않음
    const ys = sim.projectiles.map((p) => p.y);
    expect(new Set(ys.map((y) => y.toFixed(3))).size).toBe(3);
  });

  it('re-aims each burst shot at the current auto-aim target', () => {
    const sim = makeSim(['.d....d.'], [weapon({ count: 2 })]);
    const [left, right] = sim.enemies;
    left.y = 300;
    right.y = 200;
    untilFirstFire(sim);
    const first = sim.projectiles[0];
    expect(Math.abs(angleDeg(first.vx, first.vy) - aimDeg(left, PX, FIRE_Y))).toBeLessThanOrEqual(JITTER);

    // 오른쪽 적이 더 아래로 → 다음 발은 오른쪽을 노린다
    right.y = 400;
    let second = null;
    for (let i = 0; i < 20 && !second; i++) if (fires(tick(sim)).length > 0) second = sim.projectiles[1];
    expect(second).not.toBeNull();
    expect(Math.abs(angleDeg(second!.vx, second!.vy) - aimDeg(right, PX, FIRE_Y))).toBeLessThanOrEqual(JITTER);
  });

  it('keeps firing in the last direction when no enemy is visible any more', () => {
    const sim = makeSim(['...d....'], [weapon({ count: 3 })]);
    const e = sim.enemies[0];
    e.y = 300;
    untilFirstFire(sim);
    const aim = aimDeg(e, PX, FIRE_Y);
    e.y = -1000; // 화면 밖으로
    for (let i = 0; i < 30; i++) tick(sim);
    expect(sim.projectiles).toHaveLength(3);
    for (const p of sim.projectiles) {
      expect(Math.abs(angleDeg(p.vx, p.vy) - aim)).toBeLessThanOrEqual(JITTER);
    }
  });

  it('releases burst shots from the player position at release time', () => {
    const sim = makeSim(['...d....'], [weapon({ count: 2, speed: 1 })]);
    sim.enemies[0].y = 300;
    untilFirstFire(sim);
    const moveTo: CombatInput = { targetX: PX - 200, targetY: null };
    let fired: Extract<CombatEvent, { type: 'fire' }> | null = null;
    for (let i = 0; i < 20 && !fired; i++) fired = fires(tick(sim, moveTo))[0] ?? null;
    expect(fired).not.toBeNull();
    expect(fired!.x).toBeLessThan(PX);
    expect(fired!.x).toBe(sim.player.x);
  });

  it('fan weapons (spreadDeg > 0) still fire all shots at once', () => {
    const sim = makeSim(['...d....'], [weapon({ count: 3, spreadDeg: 30 })]);
    sim.enemies[0].y = 300;
    untilFirstFire(sim);
    expect(sim.projectiles).toHaveLength(3);
    for (let i = 0; i < 30; i++) expect(fires(tick(sim))).toHaveLength(0);
  });

  it('single-shot weapons are unaffected', () => {
    const sim = makeSim(['...d....'], [weapon({ count: 1, cooldown: 0.3 })]);
    sim.enemies[0].y = 300;
    const at = untilFirstFire(sim);
    expect(sim.projectiles).toHaveLength(1);
    let n = 0;
    for (let i = 0; i < 17; i++) n += fires(tick(sim)).length;
    expect(n).toBe(0);
    expect(at).toBeGreaterThan(0);
  });

  it('a pending burst survives setLoadout only while its weapon uid is still equipped', () => {
    const keep = makeSim(['...d....'], [weapon({ uid: 1, count: 3 }), weapon({ uid: 2, cooldown: 99 })]);
    keep.enemies[0].y = 300;
    untilFirstFire(keep);
    const before = keep.projectiles.filter((p) => p.weaponUid === 1).length;
    keep.setLoadout([weapon({ uid: 1, count: 3 })], PLAYER);
    for (let i = 0; i < 30; i++) tick(keep);
    expect(keep.projectiles.filter((p) => p.weaponUid === 1).length - before).toBe(2);

    const drop = makeSim(['...d....'], [weapon({ uid: 1, count: 3 }), weapon({ uid: 2, cooldown: 99 })]);
    drop.enemies[0].y = 300;
    untilFirstFire(drop);
    const n0 = drop.projectiles.filter((p) => p.weaponUid === 1).length;
    drop.setLoadout([weapon({ uid: 2, cooldown: 99 })], PLAYER);
    let uid1Fires = 0;
    for (let i = 0; i < 30; i++) uid1Fires += fires(tick(drop)).filter((f) => f.weaponUid === 1).length;
    expect(uid1Fires).toBe(0);
    expect(drop.projectiles.filter((p) => p.weaponUid === 1).length).toBe(n0);
  });

  it('is deterministic: same seed + inputs → identical projectiles', () => {
    const go = (): string => {
      const sim = makeSim(['.d..d..d', 'd..d..d.'], [weapon({ count: 3, cooldown: 0.2 }), weapon({ uid: 2, count: 2, cooldown: 0.15 })], {
        seed: 42,
      });
      sim.enemies.forEach((e, i) => (e.y = 150 + (i % 3) * 60));
      for (let i = 0; i < 300; i++) sim.step(SIM_DT, { targetX: 200 + (i % 50) * 4, targetY: null });
      return JSON.stringify(sim.projectiles.map((p) => [p.id, p.x.toFixed(6), p.y.toFixed(6)]));
    };
    expect(go()).toBe(go());
  });
});

// ── 최대 HP 회복 악용 방지 ──────────────────────────────────────

describe('CombatSim max-HP gain uses the peak max HP', () => {
  it('removing and re-adding a max-HP item does not heal', () => {
    const sim = makeSim(['...d....'], [], { hp: 60 });
    expect(sim.player).toMatchObject({ hp: 60, maxHp: 100 });

    sim.setLoadout([], { ...PLAYER, maxHp: 125 }); // 냄비 뚜껑 장착: 처음 넘은 25만큼 증가
    expect(sim.player).toMatchObject({ hp: 85, maxHp: 125 });

    sim.setLoadout([], { ...PLAYER, maxHp: 100 }); // 뺌: hp 유지 (maxHp 이하)
    expect(sim.player).toMatchObject({ hp: 85, maxHp: 100 });

    sim.setLoadout([], { ...PLAYER, maxHp: 125 }); // 다시 장착: 최고치를 넘지 않으므로 회복 없음
    expect(sim.player).toMatchObject({ hp: 85, maxHp: 125 });

    sim.setLoadout([], { ...PLAYER, maxHp: 150 }); // 최고치(125)를 넘은 25만 증가
    expect(sim.player).toMatchObject({ hp: 110, maxHp: 150 });
  });

  it('clamps hp to a lowered max HP and does not re-grant it later', () => {
    const sim = makeSim(['...d....'], []);
    sim.setLoadout([], { ...PLAYER, maxHp: 70 });
    expect(sim.player).toMatchObject({ hp: 70, maxHp: 70 });
    sim.setLoadout([], { ...PLAYER, maxHp: 100 });
    expect(sim.player).toMatchObject({ hp: 70, maxHp: 100 });
  });
});

// ── 디버그 헬퍼 ────────────────────────────────────────────────

describe('CombatSim debug helpers', () => {
  it('debugKillAll kills every enemy through the kill path and wins', () => {
    const sim = makeSim(['d.d.w...', '...d....', 'w......d'], [weapon()]);
    const ids = sim.enemies.map((e) => e.id).sort((a, b) => a - b);
    sim.debugKillAll();
    const ev = sim.drainEvents();
    const kills = ev.filter((e) => e.type === 'kill').map((e) => (e as { enemyId: number }).enemyId);
    expect(kills.sort((a, b) => a - b)).toEqual(ids);
    expect(ev[ev.length - 1]).toEqual({ type: 'won' });
    expect(ev.filter((e) => e.type === 'won')).toHaveLength(1);
    expect(sim.status).toBe('won');
    expect(sim.killedEnemies).toBe(sim.totalEnemies);
    expect(sim.enemies).toHaveLength(0);
    expect(sim.progress()).toBe(1);

    sim.debugKillAll();
    expect(sim.drainEvents()).toHaveLength(0);
  });

  it('debugKillAll counts enemies already killed normally', () => {
    const sim = makeSim(['w..d....'], []);
    sim.enemies[0].y = 300;
    sim.enemies[0].hp = 0.5;
    // 정상 경로로 하나 죽이고 나머지를 디버그로
    sim.setLoadout([weapon({ cooldown: 0.1, damage: 5 })], PLAYER);
    for (let i = 0; i < 200 && sim.killedEnemies === 0; i++) tick(sim);
    expect(sim.killedEnemies).toBe(1);
    sim.drainEvents();
    sim.debugKillAll();
    const ev = sim.drainEvents();
    expect(ev.filter((e) => e.type === 'kill')).toHaveLength(1);
    expect(sim.status).toBe('won');
  });

  it('debugLose ends the fight with reason hp', () => {
    const sim = makeSim(['...d....'], [weapon()]);
    sim.debugLose();
    expect(sim.status).toBe('lost');
    expect(sim.lostReason).toBe('hp');
    expect(sim.drainEvents()).toEqual([{ type: 'lost', reason: 'hp' }]);
    sim.debugLose();
    sim.debugKillAll();
    tick(sim);
    expect(sim.drainEvents()).toHaveLength(0);
    expect(sim.status).toBe('lost');
  });
});
