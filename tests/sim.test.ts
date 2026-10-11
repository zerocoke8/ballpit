import { describe, expect, it } from 'vitest';
import {
  BOSS_REHIT_DAMAGE_MUL,
  BOSS_REHIT_WINDOW,
  BURN_DURATION,
  CELL,
  CHAIN_RANGE,
  CHAIN_TARGETS,
  CHILL_ATTACK_RATE,
  CHILL_ATTACK_RATE_RESIST,
  CHILL_DAMAGE_TAKEN_MUL,
  CHILL_DURATION,
  DESCENT_FAST_FORWARD,
  ENEMY_INSET,
  FIELD_H,
  FIELD_W,
  MIN_VERTICAL_RATIO,
  PIERCE_REHIT_TIME,
  PLAYER_ACCEL_TIME,
  PLAYER_HIT_RADIUS,
  PLAYER_INVULN_TIME,
  PLAYER_MAX_X,
  PLAYER_MAX_Y,
  PLAYER_MIN_X,
  PLAYER_MIN_Y,
  PLAYER_START_Y,
  PROJECTILE_MAX_AGE,
  SIM_DT,
} from '../src/config';
import { CombatSim, chillResistant } from '../src/logic/combat/sim';
import { Rng } from '../src/logic/rng';
import type {
  CombatEvent,
  CombatInput,
  EnemyAttack,
  EnemyDef,
  EnemyEntity,
  PlayerStats,
  ProjectileEntity,
  StageDef,
  WeaponLoadout,
} from '../src/types';

// ── 픽스처 (src/data에 의존하지 않음) ─────────────────────────────

const IDLE: CombatInput = { targetX: null, targetY: null };

function enemyDef(id: string, o: Partial<EnemyDef> = {}): EnemyDef {
  return { id, name: id, sprite: `enemy_${id}`, w: 1, h: 1, hp: 1000, gold: 1, dropChance: 0, ...o };
}

function attack(kind: EnemyAttack['kind'], o: Partial<EnemyAttack> = {}): EnemyAttack {
  return {
    kind,
    interval: 0.5,
    jitter: 0,
    projSpeed: 300,
    damage: 5,
    count: 1,
    spreadDeg: 0,
    sprite: 'shot_test',
    radius: 8,
    ...o,
  };
}

const ENEMIES: Record<string, EnemyDef> = {
  dummy: enemyDef('dummy'),
  big: enemyDef('big', { w: 2, h: 2, hp: 5000 }),
  weak: enemyDef('weak', { hp: 1 }),
  straight: enemyDef('straight', { attack: attack('straight') }),
  aimed: enemyDef('aimed', { attack: attack('aimed') }),
  spread: enemyDef('spread', { attack: attack('spread', { count: 3, spreadDeg: 30 }) }),
  boss: enemyDef('boss', {
    w: 4,
    h: 3,
    hp: 3000,
    boss: true,
    attack: attack('spread', { count: 5, spreadDeg: 60, interval: 1.2, jitter: 0.5 }),
  }),
  jittery: enemyDef('jittery', { hp: 400, attack: attack('aimed', { interval: 0.9, jitter: 0.6 }) }),
  eliteShooter: enemyDef('eliteShooter', { w: 2, h: 2, hp: 5000, attack: attack('aimed', { interval: 0.9 }) }),
};

const LEGEND: Record<string, string> = {
  d: 'dummy',
  B: 'big',
  w: 'weak',
  s: 'straight',
  a: 'aimed',
  p: 'spread',
  X: 'boss',
  j: 'jittery',
  E: 'eliteShooter',
};

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

interface Setup {
  rows: string[];
  stage?: Partial<StageDef>;
  loadout?: WeaponLoadout[];
  player?: Partial<PlayerStats>;
  hp?: number;
  seed?: number;
}

function makeSim(s: Setup): CombatSim {
  const stage: StageDef = {
    id: 'test',
    name: 'test',
    descentSpeed: 0,
    hpMul: 1,
    dmgMul: 1,
    clearGold: 0,
    rows: s.rows,
    legend: LEGEND,
    background: 'bg_test',
    ...s.stage,
  };
  const player = { ...PLAYER, ...s.player };
  return new CombatSim({
    stage,
    stageIndex: 0,
    enemies: ENEMIES,
    loadout: s.loadout ?? [],
    player,
    hp: s.hp ?? player.maxHp,
    seed: s.seed ?? 1,
  });
}

let nextProjectileId = 1_000_000;
type ShotInit = Partial<ProjectileEntity> & Pick<ProjectileEntity, 'x' | 'y' | 'vx' | 'vy'>;

/** 테스트용 투사체를 직접 넣는다 (무기·자동조준 없이 충돌만 검증) */
function shoot(sim: CombatSim, o: ShotInit): ProjectileEntity {
  const p: ProjectileEntity = {
    id: nextProjectileId++,
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

function run(sim: CombatSim, steps: number, input: CombatInput = IDLE): CombatEvent[] {
  const out: CombatEvent[] = [];
  for (let i = 0; i < steps; i++) {
    sim.step(SIM_DT, input);
    out.push(...sim.drainEvents());
  }
  return out;
}

/** cond가 참이 될 때까지 스텝. 그동안의 이벤트 반환 */
function stepUntil(sim: CombatSim, cond: () => boolean, max = 600, input: CombatInput = IDLE): CombatEvent[] {
  const out: CombatEvent[] = [];
  for (let i = 0; i < max && !cond(); i++) {
    sim.step(SIM_DT, input);
    out.push(...sim.drainEvents());
  }
  if (!cond()) throw new Error('stepUntil: condition not reached');
  return out;
}

/** 이벤트 조건을 만족하는 스텝까지 진행 */
function stepUntilEvent(
  sim: CombatSim,
  match: (e: CombatEvent) => boolean,
  max = 600,
  input: CombatInput = IDLE,
): CombatEvent[] {
  const out: CombatEvent[] = [];
  for (let i = 0; i < max; i++) {
    sim.step(SIM_DT, input);
    const ev = sim.drainEvents();
    out.push(...ev);
    if (ev.some(match)) return out;
  }
  throw new Error('stepUntilEvent: event not seen');
}

function ofType<T extends CombatEvent['type']>(ev: CombatEvent[], type: T): Extract<CombatEvent, { type: T }>[] {
  return ev.filter((e): e is Extract<CombatEvent, { type: T }> => e.type === type);
}

function center(e: EnemyEntity): { x: number; y: number } {
  return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
}

function angleDeg(vx: number, vy: number): number {
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

function overlapsRect(p: ProjectileEntity, e: EnemyEntity): boolean {
  const qx = Math.max(e.x, Math.min(p.x, e.x + e.w));
  const qy = Math.max(e.y, Math.min(p.y, e.y + e.h));
  return (p.x - qx) ** 2 + (p.y - qy) ** 2 < p.radius ** 2;
}

/** 화면 위(보이지 않음)에 머무는 적 한 줄 → 하강 0이면 전투가 계속 'running' */
const PARKED = ['.......d'];

// 플레이어 시작 위치 / 발사 원점
const PX = FIELD_W / 2;
const PY = PLAYER_START_Y;
const FIRE_Y = PY - 30;

// ── 배치 ────────────────────────────────────────────────────────

describe('CombatSim spawn', () => {
  it('lays rows out bottom-up and anchors multi-cell enemies at their bottom-left char', () => {
    const sim = makeSim({ rows: ['d..B....', '........', '.......d'], stage: { hpMul: 1.5 } });
    expect(sim.totalEnemies).toBe(3);
    const [a, big, c] = sim.enemies;
    expect(a).toMatchObject({ defId: 'dummy', x: ENEMY_INSET, y: -CELL + ENEMY_INSET, w: 76, h: 76, hp: 1500 });
    expect(big).toMatchObject({
      defId: 'big',
      x: 3 * CELL + ENEMY_INSET,
      y: -2 * CELL + ENEMY_INSET,
      w: 2 * CELL - 2 * ENEMY_INSET,
      h: 2 * CELL - 2 * ENEMY_INSET,
      hp: 7500,
      maxHp: 7500,
    });
    expect(c).toMatchObject({ x: 7 * CELL + ENEMY_INSET, y: -3 * CELL + ENEMY_INSET });
    expect(new Set(sim.enemies.map((e) => e.id)).size).toBe(3);
    expect(sim.status).toBe('running');
    expect(sim.player).toMatchObject({ x: PX, y: PY, hp: 100, maxHp: 100, invuln: 0 });
  });

  it('rounds hp × hpMul and marks bosses', () => {
    const sim = makeSim({ rows: ['X.......'], stage: { hpMul: 0.3337 } });
    expect(sim.enemies[0]).toMatchObject({ hp: Math.round(3000 * 0.3337), boss: true, w: 4 * CELL - 8, h: 3 * CELL - 8 });
    expect(sim.enemies[0].y).toBe(-3 * CELL + ENEMY_INSET);
  });

  it('throws on a legend char without an enemy', () => {
    expect(() => makeSim({ rows: ['...?....'] })).toThrow();
  });
});

// ── 투사체 물리 ─────────────────────────────────────────────────

describe('CombatSim projectiles', () => {
  it('reflects off the side walls and the top wall', () => {
    const sim = makeSim({ rows: PARKED });
    const left = shoot(sim, { x: 40, y: 500, vx: -600, vy: -300 });
    const right = shoot(sim, { x: 630, y: 500, vx: 600, vy: -300 });
    const top = shoot(sim, { x: 200, y: 40, vx: 100, vy: -600 });
    const ev = run(sim, 10);

    expect(left.vx).toBeGreaterThan(0);
    expect(left.vy).toBeLessThan(0);
    expect(left.x).toBeGreaterThanOrEqual(left.radius);
    expect(right.vx).toBeLessThan(0);
    expect(right.x).toBeLessThanOrEqual(FIELD_W - right.radius);
    expect(top.vy).toBeGreaterThan(0);
    expect(top.y).toBeGreaterThanOrEqual(top.radius);
    for (const p of [left, right]) expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(Math.hypot(600, 300), 9);
    expect(Math.hypot(top.vx, top.vy)).toBeCloseTo(Math.hypot(100, 600), 9);

    const walls = ofType(ev, 'bounce');
    expect(walls).toHaveLength(3);
    expect(walls.every((b) => b.wall)).toBe(true);
    expect(walls.map((b) => (b.x === 0 ? 'L' : b.x === FIELD_W ? 'R' : b.y === 0 ? 'T' : '?')).sort()).toEqual([
      'L',
      'R',
      'T',
    ]);
  });

  it('enforces MIN_VERTICAL_RATIO after a bounce', () => {
    const sim = makeSim({ rows: PARKED });
    const p = shoot(sim, { x: 30, y: 500, vx: -900, vy: -5 });
    run(sim, 5);
    const speed = Math.hypot(900, 5);
    expect(p.vx).toBeGreaterThan(0);
    expect(p.vy).toBeLessThan(0);
    expect(Math.abs(p.vy) / speed).toBeGreaterThanOrEqual(MIN_VERTICAL_RATIO - 1e-9);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(speed, 9);
  });

  it('removes projectiles that leave through the open bottom', () => {
    const sim = makeSim({ rows: PARKED });
    const p = shoot(sim, { x: 300, y: 940, vx: 0, vy: 600 });
    run(sim, 2);
    expect(sim.projectiles).toContain(p);
    run(sim, 2);
    expect(p.alive).toBe(false);
    expect(sim.projectiles).not.toContain(p);
  });

  it('removes projectiles older than PROJECTILE_MAX_AGE', () => {
    const sim = makeSim({ rows: PARKED });
    const p = shoot(sim, { x: 300, y: 300, vx: 0, vy: 0 });
    run(sim, Math.floor(PROJECTILE_MAX_AGE / SIM_DT) - 2);
    expect(p.alive).toBe(true);
    run(sim, 4);
    expect(p.alive).toBe(false);
    expect(sim.projectiles).toHaveLength(0);
  });

  it('bounces off an enemy corner diagonally, hits once and ends up outside', () => {
    const sim = makeSim({ rows: ['...d....', ...PARKED] });
    const e = sim.enemies[0];
    e.y = 300; // 상자 x [256, 332], y [300, 376]
    const p = shoot(sim, { x: e.x - 40, y: e.y + e.h + 40, vx: 300, vy: -300 });
    const ev = run(sim, 30);

    expect(e.hp).toBe(990);
    expect(ofType(ev, 'hit')).toHaveLength(1);
    expect(p.vx).toBeCloseTo(-300, 3);
    expect(p.vy).toBeCloseTo(300, 3);
    expect(overlapsRect(p, e)).toBe(false);
    const bounce = ofType(ev, 'bounce');
    expect(bounce).toHaveLength(1);
    expect(bounce[0]).toMatchObject({ wall: false });
    expect(bounce[0].x).toBeCloseTo(e.x, 6);
    expect(bounce[0].y).toBeCloseTo(e.y + e.h, 6);
  });

  it('does not tunnel through a single 76px enemy at high speed', () => {
    for (const speed of [1500, 3000, 6000, 12000]) {
      for (const x of [262, 294, 326]) {
        const sim = makeSim({ rows: ['...d....', ...PARKED] });
        const e = sim.enemies[0];
        e.y = 300;
        const p = shoot(sim, { x, y: 700, vx: 0, vy: -speed, radius: 6 });
        let minY = Infinity;
        for (let i = 0; i < 30 && p.alive; i++) {
          sim.step(SIM_DT, IDLE);
          minY = Math.min(minY, p.y);
        }
        expect(e.hp, `speed ${speed} x ${x}`).toBe(990);
        expect(minY, `speed ${speed} x ${x}`).toBeGreaterThan(e.y + e.h);
        expect(p.vy).toBeGreaterThan(0);
      }
    }
  });

  it('pierces N enemies before it starts bouncing', () => {
    const sim = makeSim({ rows: ['...d....', '........', '...d....', ...['........', '.......d']] });
    const [a, c] = sim.enemies;
    a.y = 520; // [520, 596]
    c.y = 352; // [352, 428]
    const p = shoot(sim, { x: 294, y: 800, vx: 0, vy: -600, pierceLeft: 1 });
    const ev = stepUntil(sim, () => c.hp < c.maxHp);

    expect(ofType(ev, 'hit').map((h) => h.enemyId)).toEqual([a.id, c.id]);
    expect(a.hp).toBe(990);
    expect(c.hp).toBe(990);
    expect(p.pierceLeft).toBe(0);
    expect(p.vy).toBeGreaterThan(0); // C에서 반사
    expect(ofType(ev, 'bounce')).toHaveLength(1);
  });

  it('re-hits an enemy it is passing through only after PIERCE_REHIT_TIME', () => {
    const sim = makeSim({ rows: ['...B....', '........', '.......d'] });
    const big = sim.enemies[0];
    big.y = 200; // x [256, 416], y [200, 360]
    const p = shoot(sim, { x: 336, y: 400, vx: 0, vy: -120, pierceLeft: 999 });
    const times: number[] = [];
    for (let i = 0; i < 90; i++) {
      sim.step(SIM_DT, IDLE);
      for (const ev of ofType(sim.drainEvents(), 'hit')) if (ev.enemyId === big.id) times.push(sim.time);
    }
    expect(times.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(PIERCE_REHIT_TIME - 1e-6);
      expect(times[i] - times[i - 1]).toBeLessThan(PIERCE_REHIT_TIME + 2 * SIM_DT);
    }
    expect(big.hp).toBe(5000 - 10 * times.length);
    expect(p.vy).toBeLessThan(0); // 반사 없이 통과 중
    expect(p.pierceLeft).toBe(999 - times.length);
  });

  it('dies on the bounce after bouncesLeft runs out', () => {
    const sim = makeSim({ rows: PARKED });
    const p = shoot(sim, { x: 336, y: 600, vx: -1000, vy: -230, bouncesLeft: 2 });
    const ev = stepUntil(sim, () => !p.alive, 300);
    expect(ofType(ev, 'bounce')).toHaveLength(2);
    expect(p.x).toBeCloseTo(p.radius, 9); // 세 번째 벽(왼쪽)에서 소멸
    expect(p.y).toBeLessThan(FIELD_H);
    expect(sim.projectiles).toHaveLength(0);
  });

  it('still damages the enemy when the last bounce is used up on it', () => {
    const sim = makeSim({ rows: ['...d....', ...PARKED] });
    const e = sim.enemies[0];
    e.y = 300;
    const p = shoot(sim, { x: 294, y: 500, vx: 0, vy: -600, bouncesLeft: 0 });
    const ev = stepUntil(sim, () => !p.alive);
    expect(e.hp).toBe(990);
    expect(ofType(ev, 'bounce')).toHaveLength(0);
    expect(p.y).toBeGreaterThan(e.y + e.h);
  });

  it('splits into children on the first hit only', () => {
    const sim = makeSim({ rows: ['...d....', ...PARKED] });
    const e = sim.enemies[0];
    e.y = 500; // [500, 576]
    const split = { count: 3, damageMul: 0.5, sprite: 'proj_child', radius: 6 };
    const p = shoot(sim, { x: 294, y: 300, vx: 0, vy: 600, radius: 10, damage: 20, split, elements: ['fire'] });
    const first = stepUntilEvent(sim, (x) => x.type === 'split');

    const splits = ofType(first, 'split');
    expect(splits).toHaveLength(1);
    expect(splits[0].count).toBe(3);
    expect(p.split).toBeNull();
    expect(p.vy).toBeLessThan(0);
    const children = sim.projectiles.filter((q) => q !== p);
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c).toMatchObject({
        damage: 10,
        radius: 6,
        sprite: 'proj_child',
        pierceLeft: 0,
        bouncesLeft: Infinity,
        split: null,
        explodeRadius: 0,
        elements: ['fire'],
      });
      expect(c.vy).toBeLessThan(0);
      expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(600, 6);
    }
    const angles = children.map((c) => angleDeg(c.vx, c.vy)).sort((a, b) => a - b);
    expect(angles[2] - angles[0]).toBeCloseTo(60, 6);
    expect(angles[1]).toBeCloseTo(-90, 6);

    // 부모가 천장을 찍고 돌아와 다시 맞혀도 더 분열하지 않는다
    const later = run(sim, 240);
    expect(ofType(later, 'split')).toHaveLength(0);
    expect(ofType(later, 'hit').filter((h) => h.enemyId === e.id && h.damage === 20).length).toBeGreaterThan(0);
  });

  it('never gets stuck oscillating when wedged between two enemies', () => {
    const sim = makeSim({ rows: ['...d....', '...d....', ...['........', '.......d']] });
    const [a, b] = sim.enemies;
    a.y = 500; // [500, 576]
    b.y = 416; // [416, 492] — 8px 틈
    const p = shoot(sim, { x: 294, y: 496, vx: 0, vy: -600, radius: 10 });
    const ev = run(sim, 120);
    expect(ofType(ev, 'bounce').filter((x) => !x.wall).length).toBeLessThanOrEqual(2);
    expect(ofType(ev, 'hit').length).toBeLessThanOrEqual(2);
    expect(p.alive).toBe(false); // 빠져나가 바닥으로 나갔다
  });

  it('a pierce-2 shot that bounces deep in a column comes back out instead of ping-ponging', () => {
    // 한 열에 적 3개: 아래 둘(B, A)을 뚫고 C에서 반사 → A, B를 다시 지나 아래로 나와야 한다
    const sim = makeSim({ rows: ['...d....', '...d....', '...d....', ...['........', '.......d']] });
    const [b, a, c] = sim.enemies;
    b.y = 600;
    a.y = 516;
    c.y = 432;
    const p = shoot(sim, { x: 294, y: 800, vx: 0, vy: -600, pierceLeft: 2 });
    const ev = run(sim, 90);
    expect(ofType(ev, 'hit').map((h) => h.enemyId)).toEqual([b.id, a.id, c.id]);
    expect(ofType(ev, 'bounce')).toHaveLength(1);
    expect(p.alive).toBe(false);
  });
});

// ── 피해 / 속성 ─────────────────────────────────────────────────

describe('CombatSim damage and elements', () => {
  it('explosion damages other enemies within radius at 50%', () => {
    const sim = makeSim({ rows: ['..ddd..d', '.......d'] });
    const [l, m, r, far] = sim.enemies;
    for (const e of [l, m, r, far]) e.y = 300;
    const p = shoot(sim, { x: 294, y: 600, vx: 0, vy: -600, damage: 20, explodeRadius: 60, bouncesLeft: 0 });
    const ev = stepUntil(sim, () => !p.alive);
    expect(m.hp).toBe(980);
    expect(l.hp).toBe(990);
    expect(r.hp).toBe(990);
    expect(far.hp).toBe(1000);
    const ex = ofType(ev, 'explode');
    expect(ex).toHaveLength(1);
    expect(ex[0].radius).toBe(60);
    expect(ex[0].element).toBeNull();
  });

  it('explode event carries the status element of the blast (render-only)', () => {
    const sim = makeSim({ rows: ['..ddd..d', '.......d'] });
    for (const e of sim.enemies) e.y = 300;
    const p = shoot(sim, { x: 294, y: 600, vx: 0, vy: -600, damage: 20, explodeRadius: 60, bouncesLeft: 0, elements: ['lightning', 'ice'] });
    const ev = stepUntil(sim, () => !p.alive);
    const ex = ofType(ev, 'explode');
    expect(ex).toHaveLength(1);
    expect(ex[0].element).toBe('ice');
  });

  it('chain lightning hits at most CHAIN_TARGETS other enemies within CHAIN_RANGE', () => {
    const sim = makeSim({ rows: ['.ddddd..', '...d....', '.......d'] });
    const row0 = sim.enemies.slice(0, 5);
    const above = sim.enemies[5];
    for (const e of [...row0, above]) e.y += 480;
    const struck = row0[2]; // 열 3
    const p = shoot(sim, { x: 294, y: 700, vx: 0, vy: -600, damage: 10, elements: ['lightning'], bouncesLeft: 0 });
    const ev = stepUntil(sim, () => !p.alive);

    expect(struck.hp).toBe(990);
    const chains = ofType(ev, 'chain');
    expect(chains).toHaveLength(CHAIN_TARGETS);
    const others = sim.enemies.filter((e) => e !== struck && e.hp < e.maxHp);
    expect(others).toHaveLength(CHAIN_TARGETS);
    const sc = center(struck);
    for (const o of others) {
      expect(o.hp).toBe(995);
      const oc = center(o);
      expect(Math.hypot(oc.x - sc.x, oc.y - sc.y)).toBeLessThanOrEqual(CHAIN_RANGE);
    }
    expect(row0[0].hp).toBe(1000); // 168px — 범위 밖
    expect(row0[4].hp).toBe(1000);
    const hit = ofType(ev, 'hit').find((h) => h.enemyId === struck.id)!;
    expect(hit.element).toBe('lightning');
  });

  it('burn ticks for BURN_DURATION and refreshes keeping the larger dps', () => {
    const sim = makeSim({ rows: ['...d....', '.......d'] });
    const e = sim.enemies[0];
    e.y = 300;
    const fire = (damage: number): CombatEvent[] => {
      const p = shoot(sim, { x: 294, y: 420, vx: 0, vy: -600, damage, elements: ['fire'], bouncesLeft: 0 });
      return stepUntil(sim, () => !p.alive);
    };

    const ev = fire(20);
    expect(ofType(ev, 'hit')[0]).toMatchObject({ damage: 20, element: 'fire' });
    expect(e.burnDps).toBeCloseTo(5, 9);
    expect(e.burnTime).toBe(BURN_DURATION);
    const hp0 = e.hp;
    run(sim, 60);
    expect(e.hp).toBeCloseTo(hp0 - 5, 6);

    fire(8); // 2 dps < 5 → 큰 값 유지, 시간만 갱신
    expect(e.burnDps).toBeCloseTo(5, 9);
    expect(e.burnTime).toBe(BURN_DURATION);
    fire(40);
    expect(e.burnDps).toBeCloseTo(10, 9);

    const hp1 = e.hp;
    const burnEv = run(sim, Math.ceil(BURN_DURATION / SIM_DT) + 5);
    expect(e.burnTime).toBe(0);
    expect(e.burnDps).toBe(0);
    expect(hp1 - e.hp).toBeCloseTo(10 * BURN_DURATION, 4);
    const burnHits = ofType(burnEv, 'hit');
    expect(burnHits.length).toBeGreaterThan(1);
    expect(burnHits.every((h) => h.element === 'fire' && h.enemyId === e.id)).toBe(true);
    const total = burnHits.reduce((s, h) => s + h.damage, 0);
    expect(Math.abs(total - 10 * BURN_DURATION)).toBeLessThanOrEqual(1);

    const hp2 = e.hp;
    run(sim, 60);
    expect(e.hp).toBe(hp2);
  });

  it('chill slows (does not stop) a normal enemy attack timer to CHILL_ATTACK_RATE and amplifies damage taken', () => {
    const sim = makeSim({ rows: ['...s....', '.......d'] });
    const e = sim.enemies[0];
    e.y = 300;
    const p = shoot(sim, { x: 294, y: 420, vx: 0, vy: -600, damage: 10, elements: ['ice'], bouncesLeft: 0 });
    stepUntil(sim, () => !p.alive);
    expect(e.hp).toBe(990); // 얼리는 타격 자체는 증폭 없음
    expect(e.chillTime).toBe(CHILL_DURATION);

    // 냉기 중: 타이머가 CHILL_ATTACK_RATE 속도로 흐른다 (멈추지 않음)
    e.attackTimer = 10;
    const n = Math.floor((CHILL_DURATION - 0.5) / SIM_DT);
    run(sim, n);
    expect(e.chillTime).toBeGreaterThan(0);
    expect(e.attackTimer).toBeCloseTo(10 - n * SIM_DT * CHILL_ATTACK_RATE, 9);

    const q = shoot(sim, { x: 294, y: 390, vx: 0, vy: -600, damage: 10, bouncesLeft: 0 });
    const ev = stepUntil(sim, () => !q.alive);
    expect(e.hp).toBeCloseTo(990 - 10 * CHILL_DAMAGE_TAKEN_MUL, 9);
    expect(ofType(ev, 'hit')[0].damage).toBe(Math.round(10 * CHILL_DAMAGE_TAKEN_MUL));

    // 냉기가 풀리면 원래 속도
    stepUntil(sim, () => e.chillTime === 0);
    const t = e.attackTimer;
    run(sim, 30);
    expect(e.attackTimer).toBeCloseTo(t - 30 * SIM_DT, 9);
  });

  it('a chilled shooter keeps firing at interval / CHILL_ATTACK_RATE (and at interval once the chill ends)', () => {
    const sim = makeSim({ rows: ['...s....', '.......d'] });
    const e = sim.enemies[0];
    e.y = 300;
    const shotSteps = (steps: number, chilled: boolean): number[] => {
      const out: number[] = [];
      for (let i = 1; i <= steps; i++) {
        if (chilled) e.chillTime = CHILL_DURATION; // 계속 얼려 둔다
        sim.step(SIM_DT, IDLE);
        if (sim.drainEvents().some((x) => x.type === 'enemyShoot')) out.push(i);
      }
      return out;
    };
    const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]);
    const interval = ENEMIES.straight.attack!.interval;

    const chilled = shotSteps(600, true);
    expect(chilled.length).toBeGreaterThan(3);
    expect(new Set(gaps(chilled))).toEqual(new Set([Math.ceil(interval / (SIM_DT * CHILL_ATTACK_RATE) - 1e-6)]));

    e.chillTime = 0;
    const normal = shotSteps(300, false);
    expect(new Set(gaps(normal))).toEqual(new Set([Math.round(interval / SIM_DT)]));
  });

  it('elites (multi-cell, non-boss) and bosses resist chill: their timers run at CHILL_ATTACK_RATE_RESIST', () => {
    const sim = makeSim({ rows: ['X...E.s.', '........', '........', '.......d'] });
    const boss = sim.enemies.find((x) => x.defId === 'boss')!;
    const elite = sim.enemies.find((x) => x.defId === 'eliteShooter')!;
    const normal = sim.enemies.find((x) => x.defId === 'straight')!;
    for (const x of [boss, elite, normal]) {
      x.y = 300;
      x.attackTimer = 10;
    }
    const n = 90;
    for (let i = 0; i < n; i++) {
      for (const x of [boss, elite, normal]) x.chillTime = CHILL_DURATION;
      sim.step(SIM_DT, IDLE);
    }
    sim.drainEvents();
    expect(normal.attackTimer).toBeCloseTo(10 - n * SIM_DT * CHILL_ATTACK_RATE, 9);
    expect(elite.attackTimer).toBeCloseTo(10 - n * SIM_DT * CHILL_ATTACK_RATE_RESIST, 9);
    expect(boss.attackTimer).toBeCloseTo(10 - n * SIM_DT * CHILL_ATTACK_RATE_RESIST, 9);
    expect(CHILL_ATTACK_RATE).toBeGreaterThan(0);
    expect(CHILL_ATTACK_RATE).toBeLessThan(CHILL_ATTACK_RATE_RESIST);
    expect(CHILL_ATTACK_RATE_RESIST).toBeLessThan(1);
  });

  it('chillResistant: bosses and enemies bigger than one cell', () => {
    expect(chillResistant({ w: 1, h: 1 })).toBe(false);
    expect(chillResistant({ w: 1, h: 1, boss: true })).toBe(true);
    expect(chillResistant({ w: 2, h: 2 })).toBe(true);
    expect(chillResistant({ w: 2, h: 1 })).toBe(true);
    expect(chillResistant({ w: 4, h: 3, boss: true })).toBe(true);
  });

  it('chilled attack timing is deterministic: same seed + inputs → same shots and state', () => {
    const make = (): CombatSim =>
      makeSim({
        rows: ['sapjX...', '........', '........', 'E.j.s.a.', '........'],
        loadout: [weapon({ uid: 1, cooldown: 0.4, elements: ['ice'], explodeRadius: 60 }), weapon({ uid: 2, cooldown: 0.9 })],
        seed: 77,
      });
    const a = make();
    const b = make();
    for (const sim of [a, b]) for (const e of sim.enemies) e.y += 420;
    const evA: CombatEvent[] = [];
    const evB: CombatEvent[] = [];
    let chilledSteps = 0;
    for (let i = 0; i < 900; i++) {
      const input: CombatInput = { targetX: 336 + 200 * Math.sin(i / 23), targetY: 860 };
      a.step(SIM_DT, input);
      b.step(SIM_DT, input);
      evA.push(...a.drainEvents());
      evB.push(...b.drainEvents());
      if (a.enemies.some((e) => e.chillTime > 0)) chilledSteps++;
    }
    expect(chilledSteps).toBeGreaterThan(100);
    expect(ofType(evA, 'enemyShoot').length).toBeGreaterThan(0);
    expect(JSON.stringify(evA)).toBe(JSON.stringify(evB));
    expect(JSON.stringify(a.enemies)).toBe(JSON.stringify(b.enemies));
    expect(JSON.stringify(a.enemyShots)).toBe(JSON.stringify(b.enemyShots));
  });
});

// ── 보스 연타 감쇠 ──────────────────────────────────────────────

describe('CombatSim boss re-hit damper', () => {
  /** 보스(또는 큰 적) 아랫면을 아래에서 맞히는 위치로 투사체를 (다시) 보낸다 */
  const aimUp = (p: ProjectileEntity, e: EnemyEntity): void => {
    p.x = e.x + e.w / 2;
    p.y = e.y + e.h + 40;
    p.vx = 0;
    p.vy = -600;
  };
  const hitsOn = (ev: CombatEvent[], id: number): number[] =>
    ofType(ev, 'hit')
      .filter((h) => h.enemyId === id)
      .map((h) => h.damage);

  it('the same projectile re-hitting the boss within BOSS_REHIT_WINDOW deals × BOSS_REHIT_DAMAGE_MUL', () => {
    const sim = makeSim({ rows: ['X.......', '........', '........', '.......d'] });
    const boss = sim.enemies[0];
    boss.y = 300;
    boss.attackTimer = 1e9; // 보스 탄은 이 테스트와 무관
    const p = shoot(sim, { x: 0, y: 0, vx: 0, vy: 0, damage: 10 });
    const hitOnce = (): number[] => {
      aimUp(p, boss);
      const before = boss.hp;
      const ev = stepUntil(sim, () => boss.hp < before, 60);
      return hitsOn(ev, boss.id);
    };
    expect(hitOnce()).toEqual([10]);
    // 곧바로 같은 공이 또 때림 → 감쇠
    expect(hitOnce()).toEqual([Math.round(10 * BOSS_REHIT_DAMAGE_MUL)]);
    expect(boss.hp).toBeCloseTo(3000 - 10 - 10 * BOSS_REHIT_DAMAGE_MUL, 9);
    // 창이 지나면 다시 온전히
    p.vx = 0;
    p.vy = 0;
    p.x = 600;
    p.y = 800;
    run(sim, Math.ceil(BOSS_REHIT_WINDOW / SIM_DT) + 1);
    expect(hitOnce()).toEqual([10]);
    // 다른 공은 처음 때리는 것이라 온전히
    const q = shoot(sim, { x: 0, y: 0, vx: 0, vy: 0, damage: 10 });
    aimUp(q, boss);
    const before = boss.hp;
    const ev = stepUntil(sim, () => boss.hp < before, 60);
    expect(hitsOn(ev, boss.id)).toEqual([10]);
  });

  it('does not apply to non-boss enemies (rattling behind a wave keeps full damage)', () => {
    const sim = makeSim({ rows: ['B.......', '........', '.......d'] });
    const big = sim.enemies[0];
    big.y = 300;
    const p = shoot(sim, { x: 0, y: 0, vx: 0, vy: 0, damage: 10 });
    const dmg: number[] = [];
    for (let k = 0; k < 3; k++) {
      aimUp(p, big);
      const before = big.hp;
      dmg.push(...hitsOn(stepUntil(sim, () => big.hp < before, 60), big.id));
    }
    expect(dmg).toEqual([10, 10, 10]);
  });
});

// ── 무기 / 자동조준 ─────────────────────────────────────────────

describe('CombatSim weapons', () => {
  it('auto-aims at the lowest visible enemy', () => {
    const sim = makeSim({ rows: ['.d......', '......d.'], loadout: [weapon({ cooldown: 0.3 })] });
    const [low, high] = sim.enemies;
    low.y = 320;
    high.y = 236;
    const ev = stepUntilEvent(sim, (x) => x.type === 'fire');
    expect(ofType(ev, 'fire')[0]).toMatchObject({ weaponUid: 1, x: PX, y: FIRE_Y, count: 1 });
    const shot = sim.projectiles[sim.projectiles.length - 1];
    const lc = center(low);
    expect(angleDiffDeg(angleDeg(shot.vx, shot.vy), angleDeg(lc.x - PX, lc.y - FIRE_Y))).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('breaks "lowest" ties by horizontal distance to the player', () => {
    const sim = makeSim({ rows: ['d.....d.'], loadout: [weapon({ cooldown: 0.2 })] });
    const [left, right] = sim.enemies;
    left.y = 300;
    right.y = 300;
    stepUntilEvent(sim, (x) => x.type === 'fire');
    let shot = sim.projectiles[sim.projectiles.length - 1];
    let c = center(right);
    expect(angleDiffDeg(angleDeg(shot.vx, shot.vy), angleDeg(c.x - PX, c.y - FIRE_Y))).toBeLessThanOrEqual(2 + 1e-9);

    const input: CombatInput = { targetX: 60, targetY: PY };
    run(sim, 90, input);
    expect(sim.player.x).toBe(60);
    stepUntilEvent(sim, (x) => x.type === 'fire', 60, input);
    shot = sim.projectiles[sim.projectiles.length - 1];
    c = center(left);
    expect(angleDiffDeg(angleDeg(shot.vx, shot.vy), angleDeg(c.x - 60, c.y - FIRE_Y))).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('fires count shots spread over spreadDeg', () => {
    const sim = makeSim({ rows: ['...d....'], loadout: [weapon({ count: 5, spreadDeg: 40 })] });
    sim.enemies[0].y = 300;
    stepUntilEvent(sim, (x) => x.type === 'fire');
    const shots = sim.projectiles.slice(-5);
    const angles = shots.map((s) => angleDeg(s.vx, s.vy));
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThanOrEqual(40 - 4);
    expect(span).toBeLessThanOrEqual(40 + 4);
  });

  it('holds fire with the cooldown ready while no enemy is visible', () => {
    const sim = makeSim({ rows: ['...d....'], loadout: [weapon({ cooldown: 0.3 })] });
    const ev = run(sim, 120);
    expect(ofType(ev, 'fire')).toHaveLength(0);
    expect(sim.weapons[0].timer).toBe(0);
    expect(sim.projectiles).toHaveLength(0);

    sim.enemies[0].y = 300;
    sim.step(SIM_DT, IDLE);
    expect(ofType(sim.drainEvents(), 'fire')).toHaveLength(1);
    expect(sim.weapons[0].timer).toBeCloseTo(0.3, 9);
  });

  it('setLoadout keeps timers by uid, delays new weapons ≤ 0.5s and syncs max hp', () => {
    const sim = makeSim({
      rows: ['...d....'],
      loadout: [weapon({ uid: 1, cooldown: 2 }), weapon({ uid: 2, cooldown: 2 })],
      hp: 80,
    });
    run(sim, 10);
    const wa = sim.weapons[0];
    const tA = wa.timer;
    expect(tA).toBeCloseTo(0.5 - 10 * SIM_DT, 9);

    sim.setLoadout([weapon({ uid: 3, cooldown: 1 }), weapon({ uid: 1, cooldown: 3 })], { ...PLAYER, maxHp: 120 });
    expect(sim.weapons.map((w) => w.uid)).toEqual([3, 1]);
    expect(sim.weapons[1]).toBe(wa);
    expect(wa.timer).toBe(tA);
    expect(wa.cooldown).toBe(3);
    expect(sim.weapons[0]).toMatchObject({ uid: 3, timer: 0.5, cooldown: 1 });
    expect(sim.player).toMatchObject({ maxHp: 120, hp: 100 });

    sim.setLoadout([weapon({ uid: 1, cooldown: 0.1 }), weapon({ uid: 4, cooldown: 0.2 })], { ...PLAYER, maxHp: 50 });
    expect(sim.weapons[0]).toMatchObject({ uid: 1, timer: 0.1, cooldown: 0.1 });
    expect(sim.weapons[1]).toMatchObject({ uid: 4, timer: 0.2 });
    expect(sim.player).toMatchObject({ maxHp: 50, hp: 50 });
  });
});

// ── 하강 / 승패 / 플레이어 ──────────────────────────────────────

describe('CombatSim flow', () => {
  it('fast-forwards descent while nothing is visible', () => {
    const sim = makeSim({ rows: ['...d....'], stage: { descentSpeed: 30 } });
    const e = sim.enemies[0];
    const y0 = e.y;
    expect(y0 + e.h).toBeLessThanOrEqual(0);
    sim.step(SIM_DT, IDLE);
    expect(e.y - y0).toBeCloseTo(30 * DESCENT_FAST_FORWARD * SIM_DT, 9);
    e.y = 100;
    sim.step(SIM_DT, IDLE);
    expect(e.y - 100).toBeCloseTo(30 * SIM_DT, 9);
  });

  it('loses by breach when an enemy reaches the defence line', () => {
    const sim = makeSim({ rows: ['...d....', '.......d'], stage: { descentSpeed: 30 } });
    const e = sim.enemies[0];
    e.y = FIELD_H - e.h - 0.2;
    sim.step(SIM_DT, IDLE);
    expect(sim.status).toBe('lost');
    expect(sim.lostReason).toBe('breach');
    expect(sim.drainEvents()).toContainEqual({ type: 'lost', reason: 'breach' });

    const t = sim.time;
    sim.step(SIM_DT, IDLE);
    expect(sim.time).toBe(t);
    expect(sim.drainEvents()).toHaveLength(0);
  });

  it('loses by hp when the player dies', () => {
    const sim = makeSim({ rows: PARKED, hp: 5 });
    sim.enemyShots.push({ id: 9100, x: PX, y: PY - 30, vx: 0, vy: 600, radius: 8, damage: 7, sprite: 's', alive: true });
    sim.step(SIM_DT, IDLE);
    expect(sim.status).toBe('lost');
    expect(sim.lostReason).toBe('hp');
    const ev = sim.drainEvents();
    expect(ofType(ev, 'playerHit')[0]).toMatchObject({ damage: 7, source: 'shot' });
    expect(ev[ev.length - 1]).toEqual({ type: 'lost', reason: 'hp' });
  });

  it('wins when every enemy is killed', () => {
    const sim = makeSim({ rows: ['...w....'], loadout: [weapon()] });
    const target = sim.enemies[0];
    target.y = 300;
    const ev = stepUntil(sim, () => sim.status !== 'running', 300);
    expect(sim.status).toBe('won');
    expect(sim.lostReason).toBeNull();
    expect(sim.killedEnemies).toBe(1);
    expect(sim.progress()).toBe(1);
    expect(sim.enemies).toHaveLength(0);
    expect(ofType(ev, 'kill')).toEqual([
      { type: 'kill', enemyId: target.id, defId: 'weak', x: target.x + 38, y: target.y + 38, boss: false },
    ]);
    expect(ev[ev.length - 1]).toEqual({ type: 'won' });
  });

  it('touching an enemy body loses at once with reason contact — no damage, invulnerability does not protect', () => {
    const sim = makeSim({ rows: ['...d....', '.......d'] });
    const e = sim.enemies[0]; // 칸 3: 충돌 박스 x 256..332, 플레이어 중심 x 336 (피격 반경 20)
    e.y = 300;
    run(sim, 2);
    expect(sim.status).toBe('running');
    sim.player.invuln = PLAYER_INVULN_TIME; // 방금 맞아 무적이어도
    e.y = PY - e.h + 5; // 플레이어 피격 원과 겹침
    const ev = run(sim, 1);
    expect(sim.status).toBe('lost');
    expect(sim.lostReason).toBe('contact');
    expect(ev).toEqual([{ type: 'lost', reason: 'contact' }]);
    expect(sim.player.hp).toBe(100);
    // 끝난 뒤에는 아무것도 하지 않는다
    expect(run(sim, 5)).toHaveLength(0);
  });

  it('contact needs a real overlap of the hit circle and the enemy box', () => {
    const sim = makeSim({ rows: ['....d...', '.......d'] });
    const e = sim.enemies[0]; // 칸 4: 충돌 박스 x 340..412 — 플레이어(x 336, 반경 20) 바로 오른쪽, 4 px 겹침
    e.y = PY - e.h / 2;
    expect(e.x - PX).toBeLessThan(PLAYER_HIT_RADIUS);
    sim.step(SIM_DT, IDLE);
    expect(sim.lostReason).toBe('contact');

    // 피격 원이 박스에서 1 px 떨어진 자리까지는 다가가도 안전, 2 px 파고들면 패배
    const safe = makeSim({ rows: ['...d....', '.......d'] });
    const f = safe.enemies[0]; // 박스 x 256..332 — 지금은 위쪽에 두고
    f.y = 300;
    const edge = f.x + f.w + PLAYER_HIT_RADIUS;
    run(safe, 60, { targetX: edge + 1, targetY: PY });
    expect(safe.player.x).toBeCloseTo(edge + 1, 9);
    f.y = PY - f.h / 2; // 플레이어 바로 왼쪽으로
    run(safe, 30, { targetX: edge + 1, targetY: PY });
    expect(safe.status).toBe('running');
    run(safe, 60, { targetX: edge - 2, targetY: PY });
    expect(safe.lostReason).toBe('contact');
  });

  it('a descending enemy that reaches a standing player kills by contact before it breaches', () => {
    const sim = makeSim({ rows: ['...d....', '.......d'], stage: { descentSpeed: 60 } });
    const e = sim.enemies[0];
    e.y = 600;
    const ev = stepUntil(sim, () => sim.status !== 'running', 600);
    expect(sim.lostReason).toBe('contact');
    expect(e.y + e.h).toBeLessThan(FIELD_H);
    // 닿는 순간 = 적 아랫변이 플레이어 피격 원 위끝을 넘은 첫 스텝 (원과 박스 모서리 — 칸 3 박스의 오른쪽 끝 332는 원 중심 336 왼쪽)
    expect(e.y + e.h).toBeGreaterThan(PY - PLAYER_HIT_RADIUS);
    expect(e.y + e.h - 60 * SIM_DT).toBeLessThan(PY);
    expect(ev[ev.length - 1]).toEqual({ type: 'lost', reason: 'contact' });
  });

  it('walking up into an enemy in the field is a contact loss', () => {
    const sim = makeSim({ rows: ['...d....', '.......d'] });
    const e = sim.enemies[0];
    e.y = 300;
    const below: CombatInput = { targetX: e.x + e.w / 2, targetY: e.y + e.h + 100 };
    run(sim, 240, below);
    expect(sim.player.y).toBeCloseTo(e.y + e.h + 100, 9);
    expect(sim.status).toBe('running'); // 적 바로 아래까지는 안전
    run(sim, 120, { targetX: e.x + e.w / 2, targetY: e.y + e.h / 2 });
    expect(sim.status).toBe('lost');
    expect(sim.lostReason).toBe('contact');
  });

  it('an enemy killed in the same step does not count as a contact (killing the last one wins)', () => {
    const sim = makeSim({ rows: ['...w....'] });
    const e = sim.enemies[0]; // HP 1, 충돌 박스 x 256..332 — 플레이어(336, 반경 20)와 겹친다
    e.y = PY - e.h / 2;
    // 왼쪽에서 들어오는 공이 이번 스텝에 잡는다
    shoot(sim, { x: e.x - 9, y: e.y + e.h / 2, vx: 600, vy: 0 });
    const ev = run(sim, 1);
    expect(ofType(ev, 'kill')).toHaveLength(1);
    expect(sim.status).toBe('won');
    expect(sim.lostReason).toBeNull();
  });

  it('enemy shots hit once and pass through during invulnerability', () => {
    const sim = makeSim({ rows: PARKED });
    sim.enemyShots.push({ id: 9001, x: PX, y: 800, vx: 0, vy: 600, radius: 8, damage: 7, sprite: 's', alive: true });
    sim.enemyShots.push({ id: 9002, x: PX, y: 780, vx: 0, vy: 600, radius: 8, damage: 7, sprite: 's', alive: true });
    const ev = run(sim, 10);
    expect(sim.player.hp).toBe(93);
    const hits = ofType(ev, 'playerHit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ damage: 7, source: 'shot' });
    expect(sim.enemyShots.map((s) => s.id)).toEqual([9002]);
    run(sim, 20);
    expect(sim.enemyShots).toHaveLength(0); // 바닥으로 나감
  });

  it('fires aimed, straight and spread enemy volleys', () => {
    const sim = makeSim({ rows: ['a..s..p.', '.......d'], stage: { dmgMul: 2 } });
    const [aimed, straight, spread] = sim.enemies;
    for (const e of [aimed, straight, spread]) e.y = 300;
    const ev = stepUntilEvent(sim, (x) => x.type === 'enemyShoot');
    const volleys = ofType(ev, 'enemyShoot');
    expect(volleys.map((v) => v.enemyId)).toEqual([aimed.id, straight.id, spread.id]);
    expect(volleys[0]).toMatchObject({ x: aimed.x + aimed.w / 2, y: aimed.y + aimed.h });
    expect(sim.enemyShots).toHaveLength(5);
    for (const s of sim.enemyShots) {
      expect(s.damage).toBe(10);
      expect(Math.hypot(s.vx, s.vy)).toBeCloseTo(300, 9);
    }

    const [a, st, ...sp] = sim.enemyShots;
    const ao = { x: aimed.x + aimed.w / 2, y: aimed.y + aimed.h };
    expect(angleDiffDeg(angleDeg(a.vx, a.vy), angleDeg(PX - ao.x, PY - ao.y))).toBeLessThan(1e-9);
    expect(st.vx).toBeCloseTo(0, 9);
    expect(st.vy).toBeCloseTo(300, 9);
    const so = { x: spread.x + spread.w / 2, y: spread.y + spread.h };
    const base = angleDeg(PX - so.x, PY - so.y);
    expect(sp).toHaveLength(3);
    sp.forEach((s, k) => {
      expect(angleDiffDeg(angleDeg(s.vx, s.vy), base - 15 + 15 * k)).toBeLessThan(1e-9);
    });
  });

  it('enemies do not attack before their bottom passes y = 40', () => {
    const sim = makeSim({ rows: ['...s....'] });
    sim.enemies[0].y = 30 - sim.enemies[0].h;
    expect(ofType(run(sim, 120), 'enemyShoot')).toHaveLength(0);
    sim.enemies[0].y = 300;
    expect(ofType(run(sim, 60), 'enemyShoot').length).toBeGreaterThan(0);
  });

  it('walks the player toward the input target: accelerates, caps at moveSpeed, stops on the target', () => {
    const sim = makeSim({ rows: PARKED, player: { moveSpeed: 240 } });
    const accel = 240 / PLAYER_ACCEL_TIME;
    run(sim, 1, { targetX: PX, targetY: 100 });
    // 첫 스텝은 가속도 × dt 만큼만
    expect(Math.hypot(sim.player.vx, sim.player.vy)).toBeCloseTo(accel * SIM_DT, 9);
    expect(PY - sim.player.y).toBeCloseTo(accel * SIM_DT * SIM_DT, 9);
    let maxSpeed = 0;
    for (let i = 0; i < 300; i++) {
      sim.step(SIM_DT, { targetX: PX, targetY: 100 });
      maxSpeed = Math.max(maxSpeed, Math.hypot(sim.player.vx, sim.player.vy));
    }
    expect(maxSpeed).toBeCloseTo(240, 6);
    expect(sim.player).toMatchObject({ x: PX, y: 100, vx: 0, vy: 0 });
  });

  it('moves anywhere inside the field walls, including the top of the field', () => {
    const sim = makeSim({ rows: PARKED, player: { moveSpeed: 600 } });
    run(sim, 300, { targetX: -100, targetY: -100 });
    expect(sim.player).toMatchObject({ x: PLAYER_MIN_X, y: PLAYER_MIN_Y, vx: 0, vy: 0 });
    run(sim, 300, { targetX: 5000, targetY: 5000 });
    expect(sim.player).toMatchObject({ x: PLAYER_MAX_X, y: PLAYER_MAX_Y, vx: 0, vy: 0 });
    expect(PLAYER_MIN_Y).toBeLessThan(100); // 예전 이동 구역(필드 하단 260 px)보다 훨씬 위까지
  });

  it('with no target the player brakes to a stop instead of halting instantly', () => {
    const sim = makeSim({ rows: PARKED, player: { moveSpeed: 420 } });
    run(sim, 30, { targetX: PLAYER_MAX_X, targetY: PY }); // 오른쪽으로 걷는 중 (아직 도착 전)
    expect(sim.player.vx).toBeCloseTo(420, 6);
    const x0 = sim.player.x;
    run(sim, 1, IDLE);
    expect(sim.player.vx).toBeGreaterThan(0);
    run(sim, 30, IDLE);
    expect(sim.player.vx).toBe(0);
    // 최고 속도에서 같은 가속도로 감속 → 약 v × PLAYER_ACCEL_TIME / 2 = 21 px 미끄러짐
    expect(sim.player.x - x0).toBeGreaterThan(10);
    expect(sim.player.x - x0).toBeLessThan(30);
    const { x, y } = sim.player;
    run(sim, 30, IDLE);
    expect(sim.player).toMatchObject({ x, y });
  });

  it('regenerates hp up to maxHp', () => {
    const sim = makeSim({ rows: PARKED, player: { regenPerSec: 6 }, hp: 50 });
    run(sim, 60);
    expect(sim.player.hp).toBeCloseTo(56, 6);
    run(sim, 1200);
    expect(sim.player.hp).toBe(100);
  });
});

// ── 결정성 / 장시간 / 성능 ──────────────────────────────────────

const CHAOS_ROWS = [
  'djdadpdd',
  'dwddwdsd',
  'B..sd.aj',
  '..dpdwdd',
  'dsdd.Bdd',
  'wdwdp..d',
  'adsdwdpd',
  'X...djdd',
  '....dsdd',
  '....wdwd',
  'dddjdddd',
];

const CHAOS_LOADOUT: WeaponLoadout[] = [
  weapon({ uid: 1, cooldown: 0.25, speed: 900, radius: 10 }),
  weapon({ uid: 2, cooldown: 0.4, count: 3, spreadDeg: 30, speed: 700, pierce: 2, maxBounces: 6, elements: ['fire'] }),
  weapon({
    uid: 3,
    cooldown: 0.6,
    speed: 800,
    radius: 12,
    elements: ['ice'],
    split: { count: 4, damageMul: 0.4, sprite: 'proj_child', radius: 6 },
  }),
  weapon({ uid: 4, cooldown: 0.5, speed: 1300, radius: 12, damage: 25, explodeRadius: 70, elements: ['lightning'] }),
  weapon({ uid: 5, cooldown: 1.2, speed: 220, radius: 16, damage: 6, pierce: 999, elements: ['fire', 'ice', 'lightning'] }),
  weapon({ uid: 6, cooldown: 0.15, speed: 2600, radius: 6, damage: 4, maxBounces: 3 }),
];

function chaosSim(seed: number): CombatSim {
  return makeSim({
    rows: CHAOS_ROWS,
    // hpMul 0.3: 0.2면 앞 세 줄의 공격형이 화면 위 40 px(공격 시작선)에 닿기 전에 거의 다 죽어서
    // 'enemyShoot'이 시드 운에 달렸다 (이동이 가속·감속 모델로 바뀌며 seed 7에서 사라짐) — 0.3이면 시드 1~10 모두 쏜다
    stage: { descentSpeed: 6, hpMul: 0.3, dmgMul: 1.3 },
    loadout: CHAOS_LOADOUT,
    player: { maxHp: 1e6, regenPerSec: 1, moveSpeed: 400 },
    seed,
  });
}

function chaosInput(i: number): CombatInput {
  if (Math.floor(i / 100) % 7 === 3) return IDLE;
  return { targetX: 336 + 300 * Math.sin(i / 37), targetY: 820 + 90 * Math.cos(i / 53) };
}

function serialize(sim: CombatSim): string {
  return JSON.stringify({
    player: sim.player,
    enemies: sim.enemies,
    projectiles: sim.projectiles,
    shots: sim.enemyShots,
    weapons: sim.weapons,
    status: sim.status,
    lostReason: sim.lostReason,
    time: sim.time,
    killed: sim.killedEnemies,
    total: sim.totalEnemies,
  });
}

function expectFiniteFields(obj: object, label: string, allowInfinity: string[] = []): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'number') continue;
    if (allowInfinity.includes(k) && v === Infinity) continue;
    if (!Number.isFinite(v)) throw new Error(`${label}.${k} = ${v}`);
  }
}

describe('CombatSim determinism and robustness', () => {
  it('same seed + same inputs → identical state after 2000 steps', () => {
    const a = chaosSim(42);
    const b = chaosSim(42);
    const evA: CombatEvent[] = [];
    const evB: CombatEvent[] = [];
    for (let i = 0; i < 2000; i++) {
      a.step(SIM_DT, chaosInput(i));
      b.step(SIM_DT, chaosInput(i));
      evA.push(...a.drainEvents());
      evB.push(...b.drainEvents());
    }
    expect(serialize(a)).toBe(serialize(b));
    expect(JSON.stringify(evA)).toBe(JSON.stringify(evB));

    const c = chaosSim(43);
    for (let i = 0; i < 2000; i++) c.step(SIM_DT, chaosInput(i));
    expect(serialize(c)).not.toBe(serialize(a));
  });

  it('long chaotic run: no NaN, no stale projectiles, everything stays in bounds', () => {
    const sim = chaosSim(7);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      sim.step(SIM_DT, chaosInput(i));
      for (const ev of sim.drainEvents()) {
        seen.add(ev.type);
        expectFiniteFields(ev, `event ${ev.type}`);
      }
      expectFiniteFields(sim.player, 'player');
      expect(sim.player.y).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
      expect(sim.player.y).toBeLessThanOrEqual(PLAYER_MAX_Y);
      expect(sim.player.x).toBeGreaterThanOrEqual(PLAYER_MIN_X);
      expect(sim.player.x).toBeLessThanOrEqual(PLAYER_MAX_X);
      for (const p of sim.projectiles) {
        expectFiniteFields(p, `projectile ${p.id}`, ['bouncesLeft']);
        expect(p.alive).toBe(true);
        expect(p.age).toBeLessThanOrEqual(PROJECTILE_MAX_AGE);
        if (p.x < p.radius - 1e-6 || p.x > FIELD_W - p.radius + 1e-6 || p.y < p.radius - 1e-6) {
          throw new Error(`projectile ${p.id} out of field at (${p.x}, ${p.y})`);
        }
      }
      for (const e of sim.enemies) {
        expectFiniteFields(e, `enemy ${e.id}`);
        expect(e.alive).toBe(true);
      }
      for (const s of sim.enemyShots) expectFiniteFields(s, `shot ${s.id}`);
      for (const w of sim.weapons) {
        expectFiniteFields(w, `weapon ${w.uid}`);
        expect(w.timer).toBeGreaterThanOrEqual(0);
      }
      if (sim.status !== 'running') break;
    }
    expect(sim.killedEnemies).toBeGreaterThan(0);
    expect(sim.enemies.length + sim.killedEnemies).toBe(sim.totalEnemies);
    for (const t of ['fire', 'hit', 'kill', 'bounce', 'chain', 'explode', 'split', 'enemyShoot']) {
      expect(seen.has(t), t).toBe(true);
    }
  });

  it('projectiles never stay trapped inside an enemy body (dense grid stress)', () => {
    const rows = Array.from({ length: 7 }, () => 'dddddddd');
    const sim = makeSim({ rows, stage: { hpMul: 1e6 } });
    for (const e of sim.enemies) e.y += 640; // 7줄 모두 화면 안, 빈칸 없음
    const rng = new Rng(5);
    for (let i = 0; i < 200; i++) {
      const speed = rng.range(300, 1500);
      const a = rng.range(0, Math.PI * 2);
      let vx = Math.cos(a) * speed;
      let vy = Math.sin(a) * speed;
      if (Math.abs(vy) < 0.3 * speed) {
        vy = (vy < 0 ? -0.3 : 0.3) * speed;
        vx = Math.sign(vx) * Math.sqrt(speed * speed - vy * vy);
      }
      shoot(sim, {
        x: rng.range(20, FIELD_W - 20),
        y: rng.range(60, 630),
        vx,
        vy,
        radius: rng.range(4, 14),
        pierceLeft: rng.int(0, 3),
      });
    }

    // 같은 적의 몸속(중심이 사각형 안)에 연속으로 머문 최대 스텝
    const inside = new Map<number, { enemy: number; steps: number }>();
    let worst = 0;
    for (let step = 0; step < Math.ceil(PROJECTILE_MAX_AGE / SIM_DT); step++) {
      sim.step(SIM_DT, IDLE);
      sim.drainEvents();
      for (const p of sim.projectiles) {
        const e = sim.enemies.find((en) => p.x > en.x && p.x < en.x + en.w && p.y > en.y && p.y < en.y + en.h);
        if (!e) {
          inside.delete(p.id);
          continue;
        }
        const prev = inside.get(p.id);
        const steps = prev && prev.enemy === e.id ? prev.steps + 1 : 1;
        inside.set(p.id, { enemy: e.id, steps });
        worst = Math.max(worst, steps);
      }
    }
    expect(worst).toBeLessThan(90); // 1.5초
  });

  it('150 enemies + 300 projectiles step well under budget', () => {
    const rows: string[] = [];
    for (let i = 0; i < 19; i++) rows.push(i % 3 === 0 ? 'dsdadpdd' : 'dddddddd');
    rows[18] = '..dddddd';
    const sim = makeSim({ rows, stage: { hpMul: 1e6 }, player: { maxHp: 1e9 } });
    expect(sim.enemies).toHaveLength(150);
    for (const e of sim.enemies) e.y += 700; // 아래쪽 9줄이 화면 안

    const rng = new Rng(99);
    const refill = (): void => {
      while (sim.projectiles.length < 300) {
        const a = -Math.PI / 2 + rng.range(-1, 1);
        shoot(sim, {
          x: rng.range(20, FIELD_W - 20),
          y: rng.range(720, 900),
          vx: Math.cos(a) * 900,
          vy: Math.sin(a) * 900,
          damage: 1,
        });
      }
    };
    const input: CombatInput = { targetX: PX, targetY: PY };
    // 워밍업 (JIT)
    for (let i = 0; i < 60; i++) {
      refill();
      sim.step(SIM_DT, input);
      sim.drainEvents();
    }
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) {
      refill();
      sim.step(SIM_DT, input);
      sim.drainEvents();
    }
    const ms = performance.now() - t0;
    expect(sim.status).toBe('running');
    expect(sim.enemies).toHaveLength(150);
    expect(sim.projectiles.length).toBeGreaterThan(250);
    expect(ms).toBeLessThan(3000);
  });
});
