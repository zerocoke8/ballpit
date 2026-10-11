import { describe, expect, it } from 'vitest';
import { circleCircle, circleRectContact, enforceMinVertical, reflect } from '../src/logic/combat/physics';

describe('circleRectContact', () => {
  // 사각형 (0,0)-(100,100)
  it('returns null when separated or exactly touching', () => {
    expect(circleRectContact(-20, 50, 10, 0, 0, 100, 100)).toBeNull();
    expect(circleRectContact(-10, 50, 10, 0, 0, 100, 100)).toBeNull();
    expect(circleRectContact(120, 120, 10, 0, 0, 100, 100)).toBeNull();
  });

  it('pushes out of each face along its outward normal', () => {
    const left = circleRectContact(-4, 50, 10, 0, 0, 100, 100)!;
    expect(left).toEqual({ nx: -1, ny: 0, depth: 6 });
    const right = circleRectContact(105, 30, 10, 0, 0, 100, 100)!;
    expect(right).toEqual({ nx: 1, ny: 0, depth: 5 });
    const top = circleRectContact(50, -2, 10, 0, 0, 100, 100)!;
    expect(top).toEqual({ nx: 0, ny: -1, depth: 8 });
    const bottom = circleRectContact(50, 107, 10, 0, 0, 100, 100)!;
    expect(bottom).toEqual({ nx: 0, ny: 1, depth: 3 });
  });

  it('uses a diagonal normal at corners', () => {
    const c = circleRectContact(-3, 103, 10, 0, 0, 100, 100)!;
    expect(c.nx).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(c.ny).toBeCloseTo(Math.SQRT1_2, 9);
    expect(c.depth).toBeCloseTo(10 - Math.hypot(3, 3), 9);
  });

  it('uses the minimum-penetration axis when the center is inside', () => {
    const nearBottom = circleRectContact(50, 95, 10, 0, 0, 100, 100)!;
    expect(nearBottom).toEqual({ nx: 0, ny: 1, depth: 15 });
    const nearLeft = circleRectContact(2, 40, 10, 0, 0, 100, 100)!;
    expect(nearLeft).toEqual({ nx: -1, ny: 0, depth: 12 });
    const nearRight = circleRectContact(97, 60, 10, 0, 0, 100, 100)!;
    expect(nearRight).toEqual({ nx: 1, ny: 0, depth: 13 });
    const nearTop = circleRectContact(40, 1, 10, 0, 0, 100, 100)!;
    expect(nearTop).toEqual({ nx: 0, ny: -1, depth: 11 });
  });

  it('treats a center exactly on the edge as inside', () => {
    const c = circleRectContact(0, 50, 10, 0, 0, 100, 100)!;
    expect(c).toEqual({ nx: -1, ny: 0, depth: 10 });
  });

  it('always returns a unit normal and positive depth', () => {
    for (let i = 0; i < 200; i++) {
      const cx = -15 + (i * 37) % 130;
      const cy = -15 + (i * 53) % 130;
      const c = circleRectContact(cx, cy, 12, 0, 0, 100, 100);
      if (!c) continue;
      expect(Math.hypot(c.nx, c.ny)).toBeCloseTo(1, 9);
      expect(c.depth).toBeGreaterThan(0);
    }
  });
});

describe('reflect', () => {
  it('reflects only when moving into the normal', () => {
    expect(reflect(3, -4, 0, 1)).toEqual({ vx: 3, vy: 4 });
    expect(reflect(-5, 2, 1, 0)).toEqual({ vx: 5, vy: 2 });
    expect(reflect(3, 4, 0, 1)).toEqual({ vx: 3, vy: 4 });
    expect(reflect(3, 0, 0, 1)).toEqual({ vx: 3, vy: 0 });
  });

  it('reflects off a diagonal normal', () => {
    const n = Math.SQRT1_2;
    const v = reflect(10, -10, -n, n);
    expect(v.vx).toBeCloseTo(-10, 9);
    expect(v.vy).toBeCloseTo(10, 9);
  });
});

describe('enforceMinVertical', () => {
  it('leaves already-steep velocities untouched', () => {
    expect(enforceMinVertical(3, -4, 0.22)).toEqual({ vx: 3, vy: -4 });
  });

  it('raises |vy| to ratio × speed, keeping speed and signs', () => {
    const v = enforceMinVertical(-100, 5, 0.22);
    const speed = Math.hypot(-100, 5);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(speed, 9);
    expect(v.vy).toBeCloseTo(0.22 * speed, 9);
    expect(v.vx).toBeLessThan(0);

    const up = enforceMinVertical(100, -1, 0.3);
    expect(up.vy).toBeCloseTo(-0.3 * Math.hypot(100, -1), 9);
    expect(up.vx).toBeGreaterThan(0);
  });

  it('sends a perfectly horizontal velocity upward', () => {
    const v = enforceMinVertical(200, 0, 0.22);
    expect(v.vy).toBeCloseTo(-44, 9);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(200, 9);
  });

  it('handles a zero vector', () => {
    expect(enforceMinVertical(0, 0, 0.22)).toEqual({ vx: 0, vy: 0 });
  });
});

describe('circleCircle', () => {
  it('detects overlap but not separation or exact touching', () => {
    expect(circleCircle(0, 0, 5, 8, 0, 5)).toBe(true);
    expect(circleCircle(0, 0, 5, 10, 0, 5)).toBe(false);
    expect(circleCircle(0, 0, 5, 20, 20, 5)).toBe(false);
  });
});
