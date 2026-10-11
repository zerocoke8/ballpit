// 전투 모듈 감사(audit) 회귀 테스트. 각 describe는 감사에서 찾은 버그 하나를 재현한다.
import { describe, expect, it } from 'vitest';
import { CHILL_DURATION, ENEMY_INSET, MAX_SUBSTEPS, SIM_DT } from '../src/config';
import { GAME_DATA } from '../src/data';
import { CombatSim } from '../src/logic/combat/sim';
import type {
  CombatEvent,
  CombatInput,
  EnemyAttack,
  EnemyDef,
  PlayerStats,
  ProjectileEntity,
  StageDef,
  WeaponLoadout,
} from '../src/types';

const IDLE: CombatInput = { targetX: null, targetY: null };

function enemyDef(id: string, o: Partial<EnemyDef> = {}): EnemyDef {
  return { id, name: id, sprite: `enemy_${id}`, w: 1, h: 1, hp: 1e6, gold: 1, dropChance: 0, ...o };
}

function attack(o: Partial<EnemyAttack> = {}): EnemyAttack {
  return {
    kind: 'straight',
    interval: 0.5,
    jitter: 0,
    projSpeed: 300,
    damage: 1,
    count: 1,
    spreadDeg: 0,
    sprite: 'shot_test',
    radius: 8,
    ...o,
  };
}

const ENEMIES: Record<string, EnemyDef> = {
  dummy: enemyDef('dummy'),
  gun: enemyDef('gun', { attack: attack({ interval: 0.5 }) }),
  slowgun: enemyDef('slowgun', { attack: attack({ interval: 2.6 }) }),
};
const LEGEND: Record<string, string> = { d: 'dummy', g: 'gun', s: 'slowgun' };
const PLAYER: PlayerStats = { maxHp: 100, moveSpeed: 300, regenPerSec: 0, goldMul: 1, damageMul: 1, cooldownMul: 1 };

function weapon(o: Partial<WeaponLoadout> = {}): WeaponLoadout {
  return {
    uid: 1,
    defId: 'w_test',
    tier: 1,
    cooldown: 0.5,
    damage: 10,
    count: 1,
    spreadDeg: 0,
    speed: 900,
    radius: 13,
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

function makeSim(rows: string[], loadout: WeaponLoadout[] = []): CombatSim {
  const stage: StageDef = {
    id: 'audit',
    name: 'audit',
    descentSpeed: 0,
    hpMul: 1,
    dmgMul: 1,
    clearGold: 0,
    rows,
    legend: LEGEND,
    background: 'bg_test',
  };
  return new CombatSim({ stage, stageIndex: 0, enemies: ENEMIES, loadout, player: PLAYER, hp: 100, seed: 3 });
}

let nextId = 2_000_000;
function shoot(sim: CombatSim, o: Partial<ProjectileEntity> & Pick<ProjectileEntity, 'x' | 'y' | 'vx' | 'vy'>): ProjectileEntity {
  const p: ProjectileEntity = {
    id: nextId++,
    weaponUid: 0,
    radius: 8,
    damage: 10,
    pierceLeft: 0,
    bouncesLeft: Infinity,
    elements: [],
    explodeRadius: 0,
    split: null,
    sprite: 'proj_test',
    spin: false,
    age: 0,
    alive: true,
    ...o,
  };
  sim.projectiles.push(p);
  return p;
}

/** 이벤트가 난 스텝 번호(1부터) 목록 */
function eventSteps(sim: CombatSim, steps: number, match: (e: CombatEvent) => boolean): number[] {
  const out: number[] = [];
  for (let i = 1; i <= steps; i++) {
    sim.step(SIM_DT, IDLE);
    if (sim.drainEvents().some(match)) out.push(i);
  }
  return out;
}

function gaps(xs: number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]);
}

/** 화면 위에 대기 → 전투가 끝나지 않게 */
const PARKED = '.......d';

// ── 1. 타이머 부동소수 누적 오차로 한 스텝 늦게 발동 ─────────────────
// 0.5 - 30×(1/60)이 정확히 0이 아니라 +ε로 남아 `timer > 0` 판정에 걸린다.
// 데이터의 쿨타임(0.3, 0.55, 1.6 …)과 적 공격 간격은 전부 SIM_DT의 정수배라 매 주기 한 스텝씩 손해.

describe('audit: timers expire on the exact step', () => {
  it('weapon cooldowns that are multiples of SIM_DT fire every cooldown/SIM_DT steps', () => {
    for (const cooldown of [0.3, 0.5, 0.55, 1.6]) {
      const sim = makeSim(['...d....', PARKED], [weapon({ cooldown })]);
      sim.enemies[0].y = 300;
      const fires = eventSteps(sim, 600, (e) => e.type === 'fire');
      const period = Math.round(cooldown / SIM_DT);
      expect(fires[0], `cooldown ${cooldown} first shot`).toBe(Math.round(Math.min(cooldown, 0.5) / SIM_DT));
      expect(new Set(gaps(fires)), `cooldown ${cooldown}`).toEqual(new Set([period]));
    }
  });

  it('enemy attack intervals that are multiples of SIM_DT fire every interval/SIM_DT steps', () => {
    for (const [ch, interval] of [
      ['g', 0.5],
      ['s', 2.6],
    ] as const) {
      const sim = makeSim([`...${ch}....`, PARKED]);
      sim.enemies[0].y = 300;
      const shots = eventSteps(sim, 700, (e) => e.type === 'enemyShoot');
      const period = Math.round(interval / SIM_DT);
      expect(shots[0], `interval ${interval} first shot`).toBe(period);
      expect(new Set(gaps(shots)), `interval ${interval}`).toEqual(new Set([period]));
    }
  });

  it('chill lasts exactly CHILL_DURATION', () => {
    const sim = makeSim(['...d....', PARKED]);
    const e = sim.enemies[0];
    e.y = 300;
    const p = shoot(sim, { x: 294, y: 420, vx: 0, vy: -600, elements: ['ice'], bouncesLeft: 0 });
    while (p.alive) sim.step(SIM_DT, IDLE);
    expect(e.chillTime).toBe(CHILL_DURATION);
    let steps = 0;
    while (e.chillTime > 0 && steps < 1000) {
      sim.step(SIM_DT, IDLE);
      steps++;
    }
    expect(steps).toBe(Math.round(CHILL_DURATION / SIM_DT));
  });
});

// ── 2. 천장에 걸친(부분적으로 보이는) 적을 맞힐 수 없음 ───────────────
// 서브스텝에서 벽 반사를 먼저 하므로, 아래 끝이 천장 근처인 적에게 아래에서 날아온 투사체가
// 같은 서브스텝에 천장도 넘으면 천장에 먼저 반사되고 적 접촉은 "멀어지는 중"으로 무시된다.
// 그런데 자동조준은 바로 그 적(y+h > 0)을 노린다.

describe('audit: partially visible enemies under the top wall', () => {
  it('a shot from below damages an enemy whose bottom edge is just inside the field', () => {
    for (const bottom of [2, 5]) {
      for (const [radius, speed] of [
        [8, 600],
        [13, 600],
        [13, 1000],
      ]) {
        const sim = makeSim(['...d....', PARKED]);
        const e = sim.enemies[0];
        e.y = bottom - e.h;
        const p = shoot(sim, { x: 294, y: 400, vx: 0, vy: -speed, radius });
        const ev: CombatEvent[] = [];
        for (let i = 0; i < 60; i++) {
          sim.step(SIM_DT, IDLE);
          ev.push(...sim.drainEvents());
        }
        const label = `bottom ${bottom} r ${radius} speed ${speed}`;
        expect(ev.filter((x) => x.type === 'hit'), label).toHaveLength(1);
        expect(ev.filter((x) => x.type === 'bounce' && x.wall), label).toHaveLength(0);
        expect(p.vy, label).toBeGreaterThan(0);
        expect(p.y - p.radius, label).toBeGreaterThanOrEqual(bottom);
      }
    }
  });

  it('auto-aim at the only (barely visible) enemy actually damages it', () => {
    const sim = makeSim(['...d....', PARKED], [weapon({ cooldown: 0.3 })]);
    const e = sim.enemies[0];
    e.y = 2 - e.h;
    for (let i = 0; i < 180; i++) sim.step(SIM_DT, IDLE);
    expect(e.hp).toBeLessThan(e.maxHp);
  });

  it('a piercing shot through such an enemy still bounces off the top wall and stays in the field', () => {
    const sim = makeSim(['...d....', PARKED]);
    const e = sim.enemies[0];
    e.y = 5 - e.h;
    const p = shoot(sim, { x: 294, y: 300, vx: 0, vy: -900, radius: 8, pierceLeft: 1 });
    const ev: CombatEvent[] = [];
    for (let i = 0; i < 40; i++) {
      sim.step(SIM_DT, IDLE);
      ev.push(...sim.drainEvents());
      if (p.alive) expect(p.y).toBeGreaterThanOrEqual(p.radius);
    }
    expect(ev.filter((x) => x.type === 'hit' && x.enemyId === e.id).length).toBeGreaterThanOrEqual(1);
    expect(ev.filter((x) => x.type === 'bounce' && x.wall)).toHaveLength(1);
    expect(p.vy).toBeGreaterThan(0);
  });

  it('a shot squeezed between the top wall and an enemy top face still uses the wall', () => {
    const sim = makeSim(['...d....', PARKED]);
    const e = sim.enemies[0];
    e.y = 40; // 위쪽 틈 40px, 지름 26
    const p = shoot(sim, { x: 200, y: 20, vx: 600, vy: -300, radius: 13 });
    const ev: CombatEvent[] = [];
    for (let i = 0; i < 30; i++) {
      sim.step(SIM_DT, IDLE);
      ev.push(...sim.drainEvents());
      expect(p.y).toBeGreaterThanOrEqual(p.radius);
      if (p.x >= e.x && p.x <= e.x + e.w) expect(p.y + p.radius).toBeLessThanOrEqual(e.y + 1e-6);
    }
    expect(ev.filter((x) => x.type === 'bounce' && x.wall).length).toBeGreaterThan(0);
    expect(ev.filter((x) => x.type === 'hit' && x.enemyId === e.id).length).toBeGreaterThan(0);
  });
});

// ── 3. setLoadout: 뺐다가 다시 넣은 무기의 쿨타임이 0.5초로 초기화 ───────
// 가방을 두 번 열어(보관함으로 뺐다가 다시 넣기) 3초 쿨 무기를 0.5초마다 쏘게 할 수 있다.
// 같은 uid는 같은 아이템이므로 남은 쿨타임을 이어서 쓴다.

describe('audit: setLoadout remembers weapons that were taken out and put back', () => {
  it('a re-added uid resumes its remaining cooldown instead of the new-weapon delay', () => {
    const melon = weapon({ uid: 7, cooldown: 3 });
    const sim = makeSim(['...d....', PARKED], [melon]);
    sim.enemies[0].y = 300;
    expect(eventSteps(sim, 40, (e) => e.type === 'fire')).toHaveLength(1);
    const remaining = sim.weapons[0].timer;
    expect(remaining).toBeGreaterThan(2.5);

    sim.setLoadout([], PLAYER);
    sim.step(SIM_DT, IDLE);
    sim.drainEvents();
    sim.setLoadout([melon], PLAYER);
    expect(sim.weapons[0].timer).toBeCloseTo(remaining - SIM_DT, 9);
    expect(eventSteps(sim, 90, (e) => e.type === 'fire')).toEqual([]);
  });

  it('a re-added uid is never slower than its (possibly shorter) new cooldown, and brand-new uids still get the short delay', () => {
    const sim = makeSim(['...d....', PARKED], [weapon({ uid: 1, cooldown: 3 })]);
    sim.enemies[0].y = 300;
    expect(eventSteps(sim, 31, (e) => e.type === 'fire')).toHaveLength(1);
    sim.setLoadout([], PLAYER);
    sim.setLoadout([weapon({ uid: 1, cooldown: 1 }), weapon({ uid: 2, cooldown: 3 })], PLAYER);
    expect(sim.weapons[0]).toMatchObject({ uid: 1, cooldown: 1 });
    expect(sim.weapons[0].timer).toBeCloseTo(1, 9);
    expect(sim.weapons[1]).toMatchObject({ uid: 2, timer: 0.5, cooldown: 3 });
  });
});

// ── 가드: 연쇄·폭발·화상이 같은 적을 겹쳐 죽여도 처치 이벤트는 한 번 ─────
// (감사 중 버그는 없었음 — 처치 보상(골드) 중복 방지 회귀 테스트)

describe('audit guard: one kill event per enemy', () => {
  it('lightning + explosion + burn on a weak cluster', () => {
    const enemies: Record<string, EnemyDef> = { ...ENEMIES, weak: enemyDef('weak', { hp: 12 }) };
    const stage: StageDef = {
      id: 'audit',
      name: 'audit',
      descentSpeed: 0,
      hpMul: 1,
      dmgMul: 1,
      clearGold: 0,
      rows: ['..www...', '..www...', '..www...'],
      legend: { w: 'weak' },
      background: 'bg_test',
    };
    const sim = new CombatSim({ stage, stageIndex: 0, enemies, loadout: [], player: PLAYER, hp: 100, seed: 9 });
    for (const e of sim.enemies) e.y += 500;
    const killed = new Map<number, number>();
    const hitAfterKill: number[] = [];
    for (let i = 0; i < 1200 && sim.status === 'running'; i++) {
      // 5 피해: 직격 1발로는 안 죽고 연쇄(2.5)·폭발(2.5)·화상이 같은 적들을 겹쳐 친다
      if (i % 20 === 0) {
        for (const x of [230, 294, 358]) {
          shoot(sim, { x, y: 700, vx: 0, vy: -500, damage: 5, explodeRadius: 120, elements: ['fire', 'lightning'] });
        }
      }
      sim.step(SIM_DT, IDLE);
      for (const ev of sim.drainEvents()) {
        if (ev.type === 'kill') killed.set(ev.enemyId, (killed.get(ev.enemyId) ?? 0) + 1);
        else if (ev.type === 'hit' && killed.has(ev.enemyId)) hitAfterKill.push(ev.enemyId);
      }
    }
    expect(sim.status).toBe('won');
    expect(killed.size).toBe(9);
    expect([...killed.values()].every((n) => n === 1)).toBe(true);
    expect(sim.killedEnemies).toBe(9);
    expect(hitAfterKill).toEqual([]);
  });
});

// ── 데이터 가드: 서브스텝 상한(MAX_SUBSTEPS) 때문에 틈새로 새지 않는지 ───
// 인접한 두 적 사이 틈은 2×ENEMY_INSET. 서브스텝 이동거리가 sqrt(r² − INSET²) 이상이면
// 투사체 중심이 모서리에 닿기 전에 틈 안으로 들어가 반사 대신 끼임(ghost) 처리된다.
// 실제 무기 데이터가 이 범위 안에 있는지 확인한다(빠르고 작은 투사체를 추가하면 여기서 걸린다).

describe('audit: real projectile data stays inside the seam-safe substep envelope', () => {
  it('every weapon projectile and split child', () => {
    const specs: { id: string; speed: number; radius: number }[] = [];
    for (const item of Object.values(GAME_DATA.items)) {
      const p = item.weapon?.projectile;
      if (!p) continue;
      specs.push({ id: item.id, speed: p.speed, radius: p.radius });
      if (p.split) specs.push({ id: `${item.id}/split`, speed: p.speed, radius: p.split.radius });
    }
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      const travel = s.speed * SIM_DT;
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / (s.radius * 0.8))));
      const sub = travel / n;
      expect(s.radius, s.id).toBeGreaterThan(ENEMY_INSET);
      expect(sub, s.id).toBeLessThan(Math.sqrt(s.radius * s.radius - ENEMY_INSET * ENEMY_INSET));
    }
  });
});
