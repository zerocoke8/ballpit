// CombatSim 수동 조준 (CombatInput.aimAngle): 조준 방향 발사(지터 없음), clamp, 부채꼴·연사, 이동 중 유지,
// 보이는 적이 없으면 대기, null/생략 = 기존 자동조준, 결정성. 조준 가이드 경로(traceAim)가 실제 투사체와 맞는지.
import { describe, expect, it } from 'vitest';
import { AIM_MIN_DEG, FIELD_H, FIELD_W, MIN_VERTICAL_RATIO, PLAYER_START_Y, SIM_DT } from '../src/config';
import { clampAim, CombatSim, FIRE_OFFSET_Y, traceAim, type AimTrace } from '../src/logic/combat/sim';
import type { CombatEvent, CombatInput, EnemyDef, EnemyEntity, PlayerStats, ProjectileEntity, StageDef, WeaponLoadout } from '../src/types';

const AIM_MIN = (AIM_MIN_DEG * Math.PI) / 180;
const PX = FIELD_W / 2;
/** 시작 위치의 발사점 y (sim: 시작 y = PLAYER_START_Y) */
const FIRE_Y = PLAYER_START_Y - FIRE_OFFSET_Y;
const JITTER_DEG = 2 + 1e-9;

function enemyDef(id: string, o: Partial<EnemyDef> = {}): EnemyDef {
  return { id, name: id, sprite: `enemy_${id}`, w: 1, h: 1, hp: 100000, gold: 1, dropChance: 0, ...o };
}

const ENEMIES: Record<string, EnemyDef> = { dummy: enemyDef('dummy') };
const LEGEND: Record<string, string> = { d: 'dummy' };
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

function makeSim(rows: string[], loadout: WeaponLoadout[], seed = 11): CombatSim {
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
  return new CombatSim({ stage, stageIndex: 0, enemies: ENEMIES, loadout, player: PLAYER, hp: PLAYER.maxHp, seed });
}

function aimInput(aimAngle: number | null | undefined, targetX: number | null = null): CombatInput {
  return { targetX, targetY: null, aimAngle };
}

function tick(sim: CombatSim, input: CombatInput): CombatEvent[] {
  sim.step(SIM_DT, input);
  return sim.drainEvents();
}

function fires(ev: CombatEvent[]): Extract<CombatEvent, { type: 'fire' }>[] {
  return ev.filter((e): e is Extract<CombatEvent, { type: 'fire' }> => e.type === 'fire');
}

/** 첫 발사가 나는 스텝까지 진행하고 그때 새로 생긴 투사체들 반환 */
function firstVolley(sim: CombatSim, input: CombatInput, max = 120): ProjectileEntity[] {
  for (let i = 0; i < max; i++) {
    const before = new Set(sim.projectiles.map((p) => p.id));
    if (fires(tick(sim, input)).length > 0) return sim.projectiles.filter((p) => !before.has(p.id));
  }
  throw new Error('no fire');
}

function angleOf(p: { vx: number; vy: number }): number {
  return Math.atan2(p.vy, p.vx);
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** 방금 쏜 투사체의 발사 x (첫 스텝에 v·dt만큼 움직인 상태) */
function originX(p: ProjectileEntity): number {
  return p.x - p.vx * SIM_DT;
}

/** 보이는 적 1마리(필드 위쪽, 경로를 막지 않는 오른쪽 위 구석)를 둔 sim */
function simWithVisibleEnemy(loadout: WeaponLoadout[], col = 7, y = 20): CombatSim {
  const rows = ['........'.slice(0, col) + 'd' + '........'.slice(col + 1)];
  const sim = makeSim(rows, loadout);
  sim.enemies[0].y = y;
  return sim;
}

// ── clamp ──────────────────────────────────────────────────────

describe('clampAim', () => {
  it('keeps angles inside the upper half-circle unchanged', () => {
    for (const a of [-Math.PI / 2, -1, -2.5, -AIM_MIN, AIM_MIN - Math.PI]) expect(clampAim(a)).toBeCloseTo(a, 12);
  });

  it('clamps down-right / exactly-right to -AIM_MIN', () => {
    expect(clampAim(0.6)).toBeCloseTo(-AIM_MIN, 12);
    expect(clampAim(0)).toBeCloseTo(-AIM_MIN, 12);
    expect(clampAim(-AIM_MIN / 2)).toBeCloseTo(-AIM_MIN, 12);
    expect(clampAim(Math.PI / 2 - 0.01)).toBeCloseTo(-AIM_MIN, 12);
  });

  it('clamps down-left / exactly-left to -(π - AIM_MIN)', () => {
    expect(clampAim(2.2)).toBeCloseTo(AIM_MIN - Math.PI, 12);
    expect(clampAim(Math.PI)).toBeCloseTo(AIM_MIN - Math.PI, 12);
    expect(clampAim(-Math.PI)).toBeCloseTo(AIM_MIN - Math.PI, 12);
    expect(clampAim(-Math.PI + AIM_MIN / 2)).toBeCloseTo(AIM_MIN - Math.PI, 12);
  });

  it('wraps full turns and maps non-finite input to straight up', () => {
    expect(clampAim(-1 + 2 * Math.PI)).toBeCloseTo(-1, 9);
    expect(clampAim(-1 - 4 * Math.PI)).toBeCloseTo(-1, 9);
    expect(clampAim(Number.NaN)).toBeCloseTo(-Math.PI / 2, 12);
    expect(clampAim(Number.POSITIVE_INFINITY)).toBeCloseTo(-Math.PI / 2, 12);
  });
});

// ── 발사 ───────────────────────────────────────────────────────

describe('CombatSim manual aim (aimAngle)', () => {
  it('projectiles leave exactly along the aim angle (no jitter), from the muzzle', () => {
    for (const a of [-Math.PI / 2, -1, -2.4, -0.3, -2.9]) {
      const sim = simWithVisibleEnemy([weapon()]);
      const shots = firstVolley(sim, aimInput(a));
      expect(shots).toHaveLength(1);
      expect(angleOf(shots[0])).toBeCloseTo(a, 9);
      expect(originX(shots[0])).toBeCloseTo(PX, 6);
      expect(shots[0].y - shots[0].vy * SIM_DT).toBeCloseTo(FIRE_Y, 6);
    }
  });

  it('clamps aim inside the sim: down-left, down-right and exactly horizontal', () => {
    const cases: [number, number][] = [
      [2.0, AIM_MIN - Math.PI], // 왼쪽 아래
      [Math.PI, AIM_MIN - Math.PI], // 정확히 왼쪽
      [0.5, -AIM_MIN], // 오른쪽 아래
      [0, -AIM_MIN], // 정확히 오른쪽
      [Math.PI / 2, -AIM_MIN], // 바로 아래 → 오른쪽 끝 (cos ≥ 0)
    ];
    for (const [input, expected] of cases) {
      const sim = simWithVisibleEnemy([weapon()]);
      const shots = firstVolley(sim, aimInput(input));
      expect(angleOf(shots[0]), `aim ${input}`).toBeCloseTo(expected, 9);
      expect(shots[0].vy).toBeLessThan(0);
    }
  });

  it('fans are centred on the aim angle', () => {
    const a = -1.2;
    const sim = simWithVisibleEnemy([weapon({ count: 5, spreadDeg: 40 })]);
    const shots = firstVolley(sim, aimInput(a));
    expect(shots).toHaveLength(5);
    const angles = shots.map(angleOf).sort((x, y) => x - y);
    const step = (40 / 4) * (Math.PI / 180);
    angles.forEach((ang, k) => expect(ang).toBeCloseTo(a - 2 * step + k * step, 9));
    const mean = angles.reduce((s, x) => s + x, 0) / angles.length;
    expect(mean).toBeCloseTo(a, 9);
  });

  it('low fans fold outer pellets onto the horizontal limit instead of firing them downward', () => {
    // 5발 50° 부채꼴을 오른쪽 끝(-AIM_MIN)으로: 아래로 갈 두 발은 -AIM_MIN으로 접히고 나머지는 그대로
    const step = (50 / 4) * (Math.PI / 180);
    for (const [a, side] of [[-AIM_MIN, 1], [AIM_MIN - Math.PI, -1]] as const) {
      const sim = simWithVisibleEnemy([weapon({ count: 5, spreadDeg: 50 })], side > 0 ? 0 : 7);
      const shots = firstVolley(sim, aimInput(a));
      expect(shots).toHaveLength(5);
      for (const p of shots) expect(p.vy).toBeLessThan(0);
      const angles = shots.map(angleOf).sort((x, y) => x - y);
      const want = [a - 2 * step, a - step, a, a + step, a + 2 * step].map(clampAim).sort((x, y) => x - y);
      angles.forEach((ang, k) => expect(ang).toBeCloseTo(want[k], 9));
      // 가운데 발은 조준각 그대로
      expect(angles.filter((x) => Math.abs(x - a) < 1e-9).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('burst shots (count > 1, spread 0) use the aim angle current at each release', () => {
    const sim = simWithVisibleEnemy([weapon({ count: 3 })]);
    const first = firstVolley(sim, aimInput(-1.0));
    expect(first).toHaveLength(1);
    expect(angleOf(first[0])).toBeCloseTo(-1.0, 9);

    const want = [-2.0, -1.5];
    const got: number[] = [];
    let aim = want[0];
    for (let i = 0; i < 30 && got.length < 2; i++) {
      const before = new Set(sim.projectiles.map((p) => p.id));
      if (fires(tick(sim, aimInput(aim))).length > 0) {
        const fresh = sim.projectiles.filter((p) => !before.has(p.id));
        expect(fresh).toHaveLength(1);
        got.push(angleOf(fresh[0]));
        aim = want[1];
      }
    }
    expect(got).toHaveLength(2);
    expect(got[0]).toBeCloseTo(want[0], 9);
    expect(got[1]).toBeCloseTo(want[1], 9);
  });

  it('keeps the same direction while the player moves (origin changes, angle does not)', () => {
    const a = -2.1;
    const sim = simWithVisibleEnemy([weapon({ cooldown: 0.15 })]);
    const shots: ProjectileEntity[] = [];
    for (let i = 0; i < 90; i++) {
      const before = new Set(sim.projectiles.map((p) => p.id));
      tick(sim, aimInput(a, 80));
      for (const p of sim.projectiles) if (!before.has(p.id)) shots.push({ ...p });
    }
    expect(shots.length).toBeGreaterThanOrEqual(5);
    for (const p of shots) expect(angleOf(p)).toBeCloseTo(a, 9);
    const xs = shots.map(originX);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
    // 플레이어가 실제로 움직였다
    expect(sim.player.x).toBeLessThan(PX - 150);
  });

  it('holds fire (timer waits at 0) while no enemy is visible, then fires along the aim', () => {
    const sim = makeSim(['...d....'], [weapon({ cooldown: 0.3 })]);
    // descentSpeed 0 → 적은 화면 위(y+h ≤ 0)에 머문다
    expect(sim.enemies[0].y + sim.enemies[0].h).toBeLessThanOrEqual(0);
    for (let i = 0; i < 90; i++) expect(fires(tick(sim, aimInput(-1.3)))).toHaveLength(0);
    expect(sim.weapons[0].timer).toBe(0);
    sim.enemies[0].y = 200;
    const ev = tick(sim, aimInput(-1.3));
    expect(fires(ev)).toHaveLength(1);
    expect(angleOf(sim.projectiles[0])).toBeCloseTo(-1.3, 9);
  });

  it('null / undefined / NaN aim keeps the legacy auto-aim (target the lowest visible enemy)', () => {
    for (const aim of [null, undefined, Number.NaN]) {
      const sim = makeSim(['.d....d.'], [weapon()]);
      const [left, right] = sim.enemies;
      left.y = 400;
      right.y = 200;
      const shots = firstVolley(sim, aimInput(aim));
      const want = Math.atan2(left.y + left.h / 2 - FIRE_Y, left.x + left.w / 2 - PX);
      expect(Math.abs(deg(angleOf(shots[0])) - deg(want))).toBeLessThanOrEqual(JITTER_DEG);
    }
  });

  it('an input without aimAngle behaves exactly like aimAngle: null (backward compatible, deterministic)', () => {
    const run = (input: CombatInput): string => {
      const sim = makeSim(['dd.dd.dd', '.d.dd.d.'], [weapon({ cooldown: 0.2, count: 3, spreadDeg: 20 }), weapon({ uid: 2, cooldown: 0.35, count: 2 })], 99);
      for (const e of sim.enemies) e.y += 300;
      for (let i = 0; i < 240; i++) sim.step(SIM_DT, input);
      return JSON.stringify(sim.projectiles.map((p) => [p.x, p.y, p.vx, p.vy]));
    };
    expect(run({ targetX: null, targetY: null })).toBe(run({ targetX: null, targetY: null, aimAngle: null }));
  });

  it('is deterministic with manual aim (same seed + same aim sequence → same state)', () => {
    const run = (): string => {
      const sim = makeSim(['dd.dd.dd', '.d.dd.d.'], [weapon({ cooldown: 0.2, count: 3, spreadDeg: 20 }), weapon({ uid: 2, cooldown: 0.35, count: 2 })], 5);
      for (const e of sim.enemies) e.y += 300;
      for (let i = 0; i < 300; i++) sim.step(SIM_DT, aimInput(-Math.PI / 2 + Math.sin(i / 20) * 1.2, 200 + (i % 80) * 4));
      return JSON.stringify({
        p: sim.projectiles.map((p) => [p.x, p.y, p.vx, p.vy]),
        e: sim.enemies.map((e) => [e.id, e.hp]),
        pl: [sim.player.x, sim.player.y],
      });
    };
    expect(run()).toBe(run());
  });
});

// ── 조준 가이드 경로 ──────────────────────────────────────────

describe('traceAim (aim guide path)', () => {
  const out = new Float64Array(16);
  const res: AimTrace = { points: 0, hitId: -1 };
  const NONE: EnemyEntity[] = [];

  function segLen(i: number): number {
    return Math.hypot(out[2 * i + 2] - out[2 * i], out[2 * i + 3] - out[2 * i + 1]);
  }

  it('goes straight to the top wall and reflects, capped by maxLen', () => {
    traceAim(PX, FIRE_Y, -Math.PI / 2, 10, NONE, 1000, 2, out, res);
    expect(res.points).toBe(3);
    expect(res.hitId).toBe(-1);
    expect(out[2]).toBeCloseTo(PX, 9);
    expect(out[3]).toBeCloseTo(10, 9); // 상단 벽 = y r
    expect(segLen(0) + segLen(1)).toBeCloseTo(1000, 6);
    expect(out[5]).toBeGreaterThan(out[3]); // 되돌아 내려감
  });

  it('stops at the first enemy it would touch (enemy box grown by r)', () => {
    const sim = makeSim(['...d....', '...d....'], [weapon()]);
    const [low, high] = sim.enemies;
    low.y = 300;
    high.y = 200;
    traceAim(low.x + low.w / 2, FIRE_Y, -Math.PI / 2, 10, sim.enemies, 2000, 3, out, res);
    expect(res.hitId).toBe(low.id);
    expect(res.points).toBe(2);
    expect(out[3]).toBeCloseTo(low.y + low.h + 10, 9);
  });

  it('ignores enemies above the field (not visible) and dead ones', () => {
    const sim = makeSim(['...d....'], [weapon()]);
    const e = sim.enemies[0];
    traceAim(e.x + e.w / 2, FIRE_Y, -Math.PI / 2, 10, sim.enemies, 900, 1, out, res);
    expect(res.hitId).toBe(-1);
    e.y = 300;
    e.alive = false;
    traceAim(e.x + e.w / 2, FIRE_Y, -Math.PI / 2, 10, sim.enemies, 900, 1, out, res);
    expect(res.hitId).toBe(-1);
  });

  it('applies the same minimum-vertical correction as the sim after a wall bounce', () => {
    traceAim(PX, FIRE_Y, -AIM_MIN, 10, NONE, 2000, 2, out, res);
    expect(res.points).toBe(3);
    expect(out[2]).toBeCloseTo(FIELD_W - 10, 9);
    const dx = out[4] - out[2];
    const dy = out[5] - out[3];
    expect(dx).toBeLessThan(0);
    expect(Math.abs(dy) / Math.hypot(dx, dy)).toBeGreaterThanOrEqual(MIN_VERTICAL_RATIO - 1e-9);
  });

  it('ends where the path leaves through the open bottom', () => {
    // 상단 벽 근처에서 아래로 반사된 뒤 바닥으로 빠져나간다
    traceAim(PX, 40, -Math.PI / 2 + 0.05, 10, NONE, 5000, 3, out, res);
    expect(res.points).toBe(3);
    expect(out[5]).toBeCloseTo(FIELD_H + 10, 6);
  });

  it('treats enemy corners as rounded like the real collision: a ball that clears a corner is not a hit', () => {
    // 오른쪽 위 45°로 날아가는 공이 적의 오른쪽 아래 모서리를 r < 거리 < r√2 로 스쳐 지나간다:
    // r만큼 넓힌 '사각형'에는 걸리지만 실제 충돌(원-사각형 = 둥근 모서리)에는 닿지 않는다
    const r = 10;
    const a = -Math.PI / 4;
    const sim = simWithVisibleEnemy([weapon({ radius: r, speed: 600 })], 0, 300);
    const e = sim.enemies[0];
    const dirX = Math.cos(a);
    const dirY = Math.sin(a);
    const L = 260;
    const d = 1.2 * r;
    const cx = PX + dirX * L - (d * Math.SQRT2) / 2;
    const cy = FIRE_Y + dirY * L - (d * Math.SQRT2) / 2;
    e.x = cx - e.w;
    e.y = cy - e.h;
    traceAim(PX, FIRE_Y, a, r, sim.enemies, 400, 1, out, res);
    expect(res.hitId).toBe(-1);
    // 실제 투사체도 닿지 않는다 (가이드가 거짓말하지 않는지)
    let hit = false;
    let wall = false;
    for (let i = 0; i < 120 && !wall; i++) {
      for (const ev of tick(sim, aimInput(a))) {
        if (ev.type === 'hit') hit = true;
        if (ev.type === 'bounce' && ev.wall) wall = true;
      }
    }
    expect(wall).toBe(true);
    expect(hit).toBe(false);
    // 같은 경로를 모서리 쪽으로 r보다 가깝게 옮기면 가이드도 실제도 닿는다
    const d2 = 0.6 * r;
    e.x = PX + dirX * L - (d2 * Math.SQRT2) / 2 - e.w;
    e.y = FIRE_Y + dirY * L - (d2 * Math.SQRT2) / 2 - e.h;
    traceAim(PX, FIRE_Y, a, r, sim.enemies, 400, 1, out, res);
    expect(res.hitId).toBe(e.id);
  });

  it('matches the real projectile: wall bounce point and outgoing direction', () => {
    const a = -2.6; // 왼쪽 위로 비스듬히 → 왼쪽 벽에서 반사
    const r = 8;
    const sim = simWithVisibleEnemy([weapon({ radius: r, speed: 600 })]);
    const shots = firstVolley(sim, aimInput(a));
    const p = shots[0];
    traceAim(PX, FIRE_Y, a, r, sim.enemies, 3000, 2, out, res);
    expect(res.points).toBe(3);
    // 실제 투사체가 벽에 닿을 때까지
    let bounce: Extract<CombatEvent, { type: 'bounce' }> | undefined;
    for (let i = 0; i < 120 && !bounce; i++) {
      bounce = tick(sim, aimInput(a)).find((e): e is Extract<CombatEvent, { type: 'bounce' }> => e.type === 'bounce' && e.wall);
    }
    expect(bounce).toBeDefined();
    expect(bounce!.x).toBe(0);
    expect(out[2]).toBeCloseTo(r, 9);
    // 서브스텝 한 칸(≤ 0.8r) 이내로 같은 높이에서 반사
    expect(Math.abs(bounce!.y - out[3])).toBeLessThanOrEqual(r);
    const guideOut = Math.atan2(out[5] - out[3], out[4] - out[2]);
    expect(angleOf(p)).toBeCloseTo(guideOut, 9);
  });
});
