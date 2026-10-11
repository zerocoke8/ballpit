// sim.ts 할당 줄이기의 안전장치:
//  - 할당 없는 접촉/반사 계산(circleRectContactInto, bounceVelocityInto)이 physics.ts의 원래 함수와 비트 단위로 같은지
//  - 모든 투사체(발사 + 분열 자식)가 같은 필드 순서(= 같은 숨은 클래스)를 쓰는지 — 갈라지면 메가모픽 쓰기로
//    p.x 갱신마다 숫자 상자가 할당되던 문제(시뮬레이션 할당의 ~95%)가 돌아온다
import { describe, expect, it } from 'vitest';
import { MIN_VERTICAL_RATIO, SIM_DT } from '../src/config';
import { GAME_DATA } from '../src/data';
import { addNewToBag, createBag } from '../src/logic/bag';
import { circleRectContact, enforceMinVertical, reflect, type Contact, type Velocity } from '../src/logic/combat/physics';
import { CombatSim, bounceVelocityInto, circleRectContactInto } from '../src/logic/combat/sim';
import { combatSeed, currentStage, newRun, runLoadout, runPlayerStats } from '../src/logic/run';
import { Rng } from '../src/logic/rng';

/** 할당 줄이기 전 sim.ts의 bounceVelocity 그대로 */
function bounceVelocityOriginal(vx: number, vy: number, nx: number, ny: number): Velocity {
  const r = reflect(vx, vy, nx, ny);
  const v = enforceMinVertical(r.vx, r.vy, MIN_VERTICAL_RATIO);
  if (v.vx * nx + v.vy * ny < 0) v.vy = -v.vy;
  return v;
}

describe('allocation-free physics helpers match physics.ts exactly', () => {
  it('circleRectContactInto === circleRectContact (outside, inside, edges, misses)', () => {
    const rng = new Rng(12345);
    const out: Contact = { nx: 0, ny: 0, depth: 0 };
    let hits = 0;
    let insides = 0;
    for (let i = 0; i < 20000; i++) {
      const rx = rng.range(0, 600);
      const ry = rng.range(-200, 800);
      const rw = rng.range(10, 200);
      const rh = rng.range(10, 200);
      const r = rng.range(2, 40);
      // 사각형 근처·안쪽·경계 위를 고루
      let cx = rng.range(rx - 60, rx + rw + 60);
      let cy = rng.range(ry - 60, ry + rh + 60);
      if (i % 7 === 0) cx = rx; // 경계 위
      if (i % 11 === 0) cy = ry + rh;
      const expected = circleRectContact(cx, cy, r, rx, ry, rw, rh);
      out.nx = out.ny = out.depth = -99;
      const got = circleRectContactInto(out, cx, cy, r, rx, ry, rw, rh);
      expect(got).toBe(expected !== null);
      if (expected) {
        hits++;
        if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) insides++;
        expect(Object.is(out.nx, expected.nx) && Object.is(out.ny, expected.ny) && Object.is(out.depth, expected.depth)).toBe(true);
      } else {
        // 안 겹치면 out을 건드리지 않는다
        expect(out.depth).toBe(-99);
      }
    }
    expect(hits).toBeGreaterThan(1000);
    expect(insides).toBeGreaterThan(100);
  });

  it('bounceVelocityInto === reflect → enforceMinVertical → flip', () => {
    const rng = new Rng(777);
    const out: Velocity = { vx: 0, vy: 0 };
    const normals = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let i = 0; i < 20000; i++) {
      const vx = rng.range(-1500, 1500) * (i % 13 === 0 ? 0 : 1);
      const vy = rng.range(-1500, 1500) * (i % 17 === 0 ? 0.001 : 1);
      let nx: number;
      let ny: number;
      if (i % 3 === 0) {
        const n = normals[i % 4];
        nx = n[0];
        ny = n[1];
      } else {
        const a = rng.range(-Math.PI, Math.PI);
        nx = Math.cos(a);
        ny = Math.sin(a);
      }
      const e = bounceVelocityOriginal(vx, vy, nx, ny);
      const g = bounceVelocityInto(out, vx, vy, nx, ny);
      expect(g).toBe(out);
      expect(Object.is(g.vx, e.vx) && Object.is(g.vy, e.vy)).toBe(true);
    }
  });
});

describe('projectile objects share one shape', () => {
  it('launched and split projectiles have identical key order through a long stress fight', () => {
    const data = GAME_DATA;
    const run = newRun(data, 'cat', 99);
    run.bag = createBag(7, 6);
    // 분열(엄마 오리)·관통(양말·메탄)·폭발·번개·연사(거울) — 선택 필드가 붙는 경로를 다 지나게
    const layout: [string, number, number][] = [
      ['w_sock_gatling', 0, 0], ['s_mirror', 1, 0], ['w_yuzu_molotov', 2, 0], ['w_static_hairball', 4, 0],
      ['w_mama_duck', 4, 2], ['w_methane_bomb', 5, 2], ['w_melon_bingsu', 2, 2], ['w_tuna_missile', 5, 3],
    ];
    for (const [id, x, y] of layout) addNewToBag(run.bag, data.items, id, 1, x, y, 0);
    run.stageIndex = 4;
    const ps = runPlayerStats(data, run);
    const sim = new CombatSim({
      stage: currentStage(data, run),
      stageIndex: 4,
      enemies: data.enemies,
      loadout: runLoadout(data, run),
      player: { ...ps, maxHp: 1e6 },
      hp: 1e6,
      seed: combatSeed(run),
    });
    const shapes = new Set<string>();
    let splitChildren = 0;
    let withPassing = 0;
    for (let i = 0; i < 2400 && sim.status === 'running'; i++) {
      sim.step(SIM_DT, { targetX: 336 + 250 * Math.sin(i / 29), targetY: 840, aimAngle: -Math.PI / 2 + 1.1 * Math.sin(i / 41) });
      sim.drainEvents();
      for (const p of sim.projectiles) {
        shapes.add(Object.keys(p).join(','));
        const q = p as unknown as { maxAge?: number; passing?: number[] };
        if (q.maxAge !== undefined && q.maxAge < 6) splitChildren++;
        if (q.passing && q.passing.length > 0) withPassing++;
      }
    }
    expect(splitChildren).toBeGreaterThan(0);
    expect(withPassing).toBeGreaterThan(0);
    expect([...shapes].join(' | ')).toBe([...shapes][0]);
  });
});
