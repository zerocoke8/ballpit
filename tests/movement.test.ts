// 플레이어 이동 모델 (logic/combat/movement.ts): 목표를 향해 '걷기' — 가속, 최고 속도, 도착 감속(지나치지 않음), 벽 안 어디든.
import { describe, expect, it } from 'vitest';
import {
  FIELD_W,
  PLAYER_ACCEL_TIME,
  PLAYER_ARRIVE_BRAKE,
  PLAYER_MAX_X,
  PLAYER_MAX_Y,
  PLAYER_MIN_X,
  PLAYER_MIN_Y,
  PLAYER_START_Y,
  SIM_DT,
} from '../src/config';
import { GAME_DATA } from '../src/data';
import { stepPlayerMotion, type Mover } from '../src/logic/combat/movement';
import { Rng } from '../src/logic/rng';

const V = 420;
const ACCEL = V / PLAYER_ACCEL_TIME;

function mover(x = FIELD_W / 2, y = PLAYER_START_Y, vx = 0, vy = 0): Mover {
  return { x, y, vx, vy };
}

/** 목표가 고정일 때 도착(목표 위 + 속도 0)까지 스텝을 돌리며 기록 */
function walk(m: Mover, tx: number, ty: number, speed = V, maxSteps = 600) {
  const sx = m.x;
  const sy = m.y;
  const len = Math.hypot(tx - sx, ty - sy);
  const ux = (tx - sx) / len;
  const uy = (ty - sy) / len;
  let maxSpeed = 0;
  let maxAlong = -Infinity;
  let maxAccel = 0;
  let reversals = 0;
  let steps = 0;
  let pvx = m.vx;
  let pvy = m.vy;
  let prevAlong = 0;
  for (; steps < maxSteps; steps++) {
    if (m.x === tx && m.y === ty && m.vx === 0 && m.vy === 0) break;
    stepPlayerMotion(m, tx, ty, true, speed, SIM_DT);
    maxSpeed = Math.max(maxSpeed, Math.hypot(m.vx, m.vy));
    const along = (m.x - sx) * ux + (m.y - sy) * uy;
    maxAlong = Math.max(maxAlong, along);
    if (along < prevAlong - 1e-9) reversals++;
    prevAlong = along;
    // 속도 변화(스냅 제외 — 마지막 스텝은 목표에 서며 0이 된다)
    if (!(m.vx === 0 && m.vy === 0)) maxAccel = Math.max(maxAccel, Math.hypot(m.vx - pvx, m.vy - pvy) / SIM_DT);
    pvx = m.vx;
    pvy = m.vy;
  }
  return { steps, time: steps * SIM_DT, maxSpeed, overshoot: maxAlong - len, maxAccel, reversals };
}

describe('player movement: walk toward the target', () => {
  it('accelerates by moveSpeed / PLAYER_ACCEL_TIME and reaches top speed in about PLAYER_ACCEL_TIME', () => {
    const m = mover();
    stepPlayerMotion(m, PLAYER_MIN_X, m.y, true, V, SIM_DT);
    expect(-m.vx).toBeCloseTo(ACCEL * SIM_DT, 9);
    expect(m.vy).toBe(0);
    let t = SIM_DT;
    while (-m.vx < V - 1e-9) {
      stepPlayerMotion(m, PLAYER_MIN_X, m.y, true, V, SIM_DT);
      t += SIM_DT;
    }
    expect(t).toBeLessThanOrEqual(PLAYER_ACCEL_TIME + SIM_DT + 1e-9);
    expect(t).toBeGreaterThanOrEqual(PLAYER_ACCEL_TIME - SIM_DT);
  });

  it('never exceeds moveSpeed, and crossing the field takes about width / speed', () => {
    const m = mover(PLAYER_MIN_X, PLAYER_START_Y);
    const r = walk(m, PLAYER_MAX_X, PLAYER_START_Y);
    expect(r.maxSpeed).toBeLessThanOrEqual(V + 1e-9);
    expect(r.maxSpeed).toBeCloseTo(V, 9);
    const ideal = (PLAYER_MAX_X - PLAYER_MIN_X) / V;
    // 가속·감속 몫(약 PLAYER_ACCEL_TIME)만 더 걸린다 — 604 px / 420 = 1.44초 → 약 1.5초
    expect(r.time).toBeGreaterThan(ideal);
    expect(r.time).toBeLessThan(ideal + 2 * PLAYER_ACCEL_TIME);
    expect(m).toMatchObject({ x: PLAYER_MAX_X, y: PLAYER_START_Y, vx: 0, vy: 0 });
  });

  it('arrives exactly on the target without overshooting or wobbling, from any distance and direction', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 200; i++) {
      const d = i < 20 ? [0.3, 1, 2, 5, 10, 15, 20, 24, 30, 40, 60, 100, 150, 200, 300, 400, 500, 550, 600, 604][i] : rng.range(0.5, 600);
      const a = rng.range(0, Math.PI * 2);
      const sx = rng.range(PLAYER_MIN_X, PLAYER_MAX_X);
      const sy = rng.range(PLAYER_MIN_Y, PLAYER_MAX_Y);
      const tx = Math.min(PLAYER_MAX_X, Math.max(PLAYER_MIN_X, sx + Math.cos(a) * d));
      const ty = Math.min(PLAYER_MAX_Y, Math.max(PLAYER_MIN_Y, sy + Math.sin(a) * d));
      if (Math.hypot(tx - sx, ty - sy) < 0.1) continue;
      const m = mover(sx, sy);
      const r = walk(m, tx, ty);
      expect(r.steps, `d ${d}`).toBeLessThan(600);
      expect(m).toMatchObject({ x: tx, y: ty, vx: 0, vy: 0 });
      expect(r.overshoot, `overshoot d ${d}`).toBeLessThanOrEqual(1e-9);
      expect(r.reversals, `reversals d ${d}`).toBe(0);
      expect(r.maxSpeed).toBeLessThanOrEqual(V + 1e-9);
      // 가속·감속도 가속도 상한 안 (스냅 스텝 제외)
      expect(r.maxAccel).toBeLessThanOrEqual(ACCEL * (1 + 1e-9));
    }
  });

  it('slows down only near the target (within about the braking distance)', () => {
    const m = mover(PLAYER_MIN_X, PLAYER_START_Y);
    const tx = PLAYER_MAX_X;
    const brake = (V * V) / (2 * ACCEL * PLAYER_ARRIVE_BRAKE); // 약 26 px
    let slowedAt = Infinity;
    let reachedTop = false;
    for (let i = 0; i < 300 && !(m.x === tx && m.vx === 0); i++) {
      stepPlayerMotion(m, tx, m.y, true, V, SIM_DT);
      if (m.vx >= V - 1e-9) reachedTop = true;
      if (reachedTop && m.vx < V - 1e-9 && slowedAt === Infinity) slowedAt = tx - m.x;
    }
    expect(reachedTop).toBe(true);
    expect(slowedAt).toBeLessThanOrEqual(brake + V * SIM_DT);
    expect(slowedAt).toBeGreaterThan(brake * 0.5);
    expect(brake).toBeGreaterThan(15);
    expect(brake).toBeLessThan(32);
  });

  it('lags behind a fast-moving target and catches up; follows a slow one closely — no jitter', () => {
    for (const [u, maxLagLo, maxLagHi] of [
      [120, 0, 3],
      [300, 2, 15],
      [1500, 300, 1200],
    ] as const) {
      const m = mover(PLAYER_MIN_X, PLAYER_START_Y);
      let tx = PLAYER_MIN_X;
      let lag = 0;
      let backwards = 0;
      let i = 0;
      for (; i < 600; i++) {
        if (tx < PLAYER_MAX_X) tx = Math.min(PLAYER_MAX_X, tx + u * SIM_DT);
        const before = m.x;
        stepPlayerMotion(m, tx, m.y, true, V, SIM_DT);
        if (m.x < before - 1e-9) backwards++;
        lag = Math.max(lag, tx - m.x);
        if (tx === PLAYER_MAX_X && m.x === tx && m.vx === 0) break;
      }
      expect(backwards, `u ${u}`).toBe(0);
      expect(lag, `u ${u}`).toBeGreaterThanOrEqual(maxLagLo);
      expect(lag, `u ${u}`).toBeLessThanOrEqual(maxLagHi);
      expect(m.x, `u ${u} catches up`).toBe(PLAYER_MAX_X);
      // 손가락이 끝에 닿은 뒤 따라잡기까지: 남은 거리를 최고 속도로 + 감속 몫
      const fingerDone = (PLAYER_MAX_X - PLAYER_MIN_X) / u;
      const catchUp = i * SIM_DT - fingerDone;
      if (u > V) expect(catchUp).toBeLessThan((PLAYER_MAX_X - PLAYER_MIN_X) / V - fingerDone + 2 * PLAYER_ACCEL_TIME + SIM_DT);
    }
  });

  it('with no target it brakes to a stop at the same acceleration', () => {
    const m = mover(300, 500, V, 0);
    let t = 0;
    while (m.vx > 0 && t < 1) {
      stepPlayerMotion(m, 0, 0, false, V, SIM_DT);
      t += SIM_DT;
    }
    expect(m.vx).toBe(0);
    expect(t).toBeGreaterThan(PLAYER_ACCEL_TIME - SIM_DT / 2);
    expect(t).toBeLessThanOrEqual(PLAYER_ACCEL_TIME + SIM_DT + 1e-9);
    // 미끄러진 거리 ≈ v × PLAYER_ACCEL_TIME / 2 (21 px, 고정 스텝 합으로는 17.5 px)
    expect(m.x - 300).toBeGreaterThan(12);
    expect(m.x - 300).toBeLessThan(24);
    const x = m.x;
    stepPlayerMotion(m, 0, 0, false, V, SIM_DT);
    expect(m.x).toBe(x);
  });

  it('turning around: momentum carries it a little past, then it walks back and stops on the target', () => {
    const m = mover(300, 500, V, 0);
    const r = walk(m, 200, 500);
    expect(m).toMatchObject({ x: 200, y: 500, vx: 0, vy: 0 });
    // 반대쪽으로 미끄러진 거리는 감속 거리 정도
    expect(r.time).toBeLessThan(0.6);
  });
});

describe('player movement: bounds (free inside the field walls)', () => {
  it('clamps the target into the field and can reach every corner, including the very top', () => {
    const corners: [number, number, number, number][] = [
      [-500, -500, PLAYER_MIN_X, PLAYER_MIN_Y],
      [5000, -500, PLAYER_MAX_X, PLAYER_MIN_Y],
      [-500, 5000, PLAYER_MIN_X, PLAYER_MAX_Y],
      [5000, 5000, PLAYER_MAX_X, PLAYER_MAX_Y],
    ];
    for (const [tx, ty, ex, ey] of corners) {
      const m = mover();
      for (let i = 0; i < 400; i++) stepPlayerMotion(m, tx, ty, true, V, SIM_DT);
      expect(m).toMatchObject({ x: ex, y: ey, vx: 0, vy: 0 });
    }
    expect(PLAYER_MIN_Y).toBeLessThan(60);
  });

  it('momentum never carries the player outside the walls (and the wall eats that velocity)', () => {
    const rng = new Rng(11);
    const m = mover();
    for (let i = 0; i < 6000; i++) {
      // 벽 쪽 목표로 갑자기 바뀌는 입력 — 관성이 벽 밖으로 밀어도 안쪽에 남아야 한다
      const tx = i % 37 === 0 ? rng.pick([-200, PLAYER_MIN_X, PLAYER_MAX_X, FIELD_W + 200]) : undefined;
      const ty = i % 53 === 0 ? rng.pick([-200, PLAYER_MIN_Y, PLAYER_MAX_Y, 2000]) : undefined;
      const target = { x: tx ?? m.x + rng.range(-300, 300), y: ty ?? m.y + rng.range(-300, 300) };
      stepPlayerMotion(m, target.x, target.y, i % 7 !== 0, V, SIM_DT);
      expect(m.x).toBeGreaterThanOrEqual(PLAYER_MIN_X);
      expect(m.x).toBeLessThanOrEqual(PLAYER_MAX_X);
      expect(m.y).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
      expect(m.y).toBeLessThanOrEqual(PLAYER_MAX_Y);
      expect(Math.hypot(m.vx, m.vy)).toBeLessThanOrEqual(V + 1e-6);
      if (m.x === PLAYER_MIN_X) expect(m.vx).toBeGreaterThanOrEqual(0);
      if (m.x === PLAYER_MAX_X) expect(m.vx).toBeLessThanOrEqual(0);
    }
  });

  it('moveSpeed 0 (or invalid) stands still', () => {
    for (const sp of [0, -5, NaN]) {
      const m = mover(300, 500, 100, 50);
      stepPlayerMotion(m, 100, 100, true, sp, SIM_DT);
      expect(m).toMatchObject({ x: 300, y: 500, vx: 0, vy: 0 });
    }
  });
});

describe('player movement: determinism and game data', () => {
  it('same start + same target sequence → bit-identical path', () => {
    const go = (): string => {
      const rng = new Rng(3);
      const m = mover();
      const out: number[] = [];
      for (let i = 0; i < 2000; i++) {
        const has = i % 90 > 5;
        stepPlayerMotion(m, rng.range(-50, FIELD_W + 50), rng.range(-50, 1000), has, 420 + (i % 3) * 40, SIM_DT);
        out.push(m.x, m.y, m.vx, m.vy);
      }
      return out.join(',');
    };
    expect(go()).toBe(go());
  });

  it('characters walk at 380~460 px/s base; penguin +20% and sneakers stay relative bonuses', () => {
    const chars = GAME_DATA.characters;
    for (const c of Object.values(chars)) {
      expect(c.baseMoveSpeed).toBeGreaterThanOrEqual(380);
      expect(c.baseMoveSpeed).toBeLessThanOrEqual(460);
    }
    expect(chars.penguin.passive.moveSpeedMul).toBeCloseTo(0.2, 9);
    expect(GAME_DATA.items.g_sneakers.gear?.moveSpeedMul).toBeCloseTo(0.2, 9);
  });
});
