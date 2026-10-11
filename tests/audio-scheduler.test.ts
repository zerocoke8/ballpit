import { describe, expect, it } from 'vitest';
import { VoiceScheduler, type SchedulerDef } from '../src/audio/scheduler';

/** 결정적 난수 (테스트 재현용) */
function seq(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const def = (over: Partial<SchedulerDef> = {}): SchedulerDef => ({
  maxVoices: 4,
  minInterval: 0,
  pitchVar: 0,
  priority: 1,
  reserve: null,
  ...over,
});

function make(defs: SchedulerDef[], opts: { maxVoices?: number; rate?: number; burst?: number } = {}): VoiceScheduler {
  const s = new VoiceScheduler(defs, { maxVoices: opts.maxVoices ?? 24, rate: opts.rate ?? 1000, burst: opts.burst ?? 1000, random: seq() });
  // 모든 def에 1초짜리 변형 하나
  defs.forEach((_, i) => s.setLoaded(i, 0, 1));
  return s;
}

describe('VoiceScheduler — 기본 거절', () => {
  it('디코드 전(변형 없음)이면 거절', () => {
    const s = new VoiceScheduler([def()], { maxVoices: 4, rate: 100, burst: 100, random: seq() });
    expect(s.request(0, 0)).toBe(-1);
    expect(s.stats.rejected.notLoaded).toBe(1);
    s.setLoaded(0, 0, 0.5);
    expect(s.request(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it('음소거면 전부 거절하고, 풀면 다시 재생', () => {
    const s = make([def()]);
    s.muted = true;
    expect(s.request(0, 0)).toBe(-1);
    expect(s.stats.rejected.muted).toBe(1);
    s.muted = false;
    expect(s.request(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it('모르는 def 번호는 -1', () => {
    const s = make([def()]);
    expect(s.request(5, 0)).toBe(-1);
  });
});

describe('VoiceScheduler — id별 제한', () => {
  it('minInterval 안의 요청은 버리고, 지나면 받는다', () => {
    const s = make([def({ minInterval: 0.1 })]);
    expect(s.request(0, 1)).toBeGreaterThanOrEqual(0);
    expect(s.request(0, 1.05)).toBe(-1);
    expect(s.stats.rejected.interval).toBe(1);
    expect(s.request(0, 1.1)).toBeGreaterThanOrEqual(0);
  });

  it('maxVoices를 넘으면 같은 소리 중 가장 오래된 것을 끊는다 (동시 재생 수는 그대로)', () => {
    const s = make([def({ maxVoices: 2 })]);
    const a = s.request(0, 0);
    const b = s.request(0, 0.01);
    expect(s.activeFor(0, 0.02)).toBe(2);
    const c = s.request(0, 0.02);
    expect(c).toBe(a);
    expect(s.stolen).toBe(true);
    expect(s.activeFor(0, 0.03)).toBe(2);
    const d = s.request(0, 0.03);
    expect(d).toBe(b);
    expect(s.stats.stolen).toBe(2);
  });

  it('끝난 소리의 칸은 비어 있는 것으로 친다', () => {
    const s = make([def({ maxVoices: 1 })]);
    s.request(0, 0);
    expect(s.activeVoices(0.5)).toBe(1);
    expect(s.activeVoices(1.01)).toBe(0);
    s.request(0, 2);
    expect(s.stolen).toBe(false);
  });

  it('재생 속도 = 요청 배수 × (1 ± pitchVar), 길이는 속도만큼 짧아진다', () => {
    const s = make([def({ pitchVar: 0.1, maxVoices: 100 })], { maxVoices: 100 });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 200; i++) {
      expect(s.request(0, i, 2)).toBeGreaterThanOrEqual(0);
      expect(s.rate).toBeGreaterThanOrEqual(2 * 0.9 - 1e-9);
      expect(s.rate).toBeLessThanOrEqual(2 * 1.1 + 1e-9);
      lo = Math.min(lo, s.rate);
      hi = Math.max(hi, s.rate);
    }
    // 실제로 흔들린다
    expect(hi - lo).toBeGreaterThan(0.2);
    const s2 = make([def({ maxVoices: 4 })]);
    s2.request(0, 0, 2);
    expect(s2.rate).toBe(2);
    expect(s2.activeVoices(0.49)).toBe(1);
    expect(s2.activeVoices(0.51)).toBe(0);
  });
});

describe('VoiceScheduler — 전역 상한과 우선순위', () => {
  const FIRE = 0;
  const HIT = 1;
  const JINGLE = 5;
  const defs = [def({ priority: FIRE, maxVoices: 10 }), def({ priority: HIT, maxVoices: 10 }), def({ priority: JINGLE, maxVoices: 10 })];

  it('상한이 차면 낮은 우선순위의 가장 오래된 소리를 끊는다', () => {
    const s = make(defs, { maxVoices: 3 });
    const f1 = s.request(0, 0.0); // fire
    s.request(1, 0.1); // hit
    s.request(0, 0.2); // fire
    expect(s.activeVoices(0.3)).toBe(3);
    const j = s.request(2, 0.3); // jingle → 가장 오래된 fire
    expect(j).toBe(f1);
    expect(s.stolen).toBe(true);
    expect(s.activeVoices(0.3)).toBe(3);
  });

  it('높은 것만 재생 중이면 낮은 요청은 버린다 (cap)', () => {
    const s = make(defs, { maxVoices: 2 });
    s.request(2, 0);
    s.request(2, 0.01);
    expect(s.request(0, 0.02)).toBe(-1);
    expect(s.stats.rejected.cap).toBe(1);
    // 같은 우선순위끼리는 오래된 것을 끊는다
    expect(s.request(2, 0.03)).toBeGreaterThanOrEqual(0);
    expect(s.stolen).toBe(true);
  });

  it('많이 몰려도 동시 재생은 상한을 넘지 않는다', () => {
    const many = Array.from({ length: 12 }, (_, i) => def({ priority: i % 6, maxVoices: 4 }));
    const s = make(many, { maxVoices: 24 });
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += 0.004;
      s.request(i % 12, t);
      expect(s.activeVoices(t)).toBeLessThanOrEqual(24);
      for (let d = 0; d < 12; d++) expect(s.activeFor(d, t)).toBeLessThanOrEqual(4);
    }
  });
});

describe('VoiceScheduler — 초당 예산 (토큰 버킷)', () => {
  it('여유분(reserve)이 큰 카테고리부터 빠지고, 예산과 무관한 소리는 늘 들린다', () => {
    const fire = def({ reserve: 4, maxVoices: 100 });
    const reward = def({ reserve: 0, maxVoices: 100 });
    const ui = def({ reserve: null, maxVoices: 100 });
    const s = make([fire, reward, ui], { maxVoices: 100, rate: 10, burst: 10 });
    // 같은 시각: fire는 토큰이 5개 이상일 때만 → 6번 (10 → 4)
    let fired = 0;
    for (let i = 0; i < 20; i++) if (s.request(0, 0) >= 0) fired++;
    expect(fired).toBe(6);
    expect(s.stats.rejected.budget).toBe(14);
    // reward(여유분 0)는 남은 4개를 쓸 수 있다
    let rewards = 0;
    for (let i = 0; i < 10; i++) if (s.request(1, 0) >= 0) rewards++;
    expect(rewards).toBe(4);
    // ui(예산 무관)는 그래도 된다
    expect(s.request(2, 0)).toBeGreaterThanOrEqual(0);
    // 0.5초 뒤 5개 충전 → fire는 아직(5 < 1+4 이면 안 됨: 5 ≥ 5 → 1번)
    expect(s.request(0, 0.5)).toBeGreaterThanOrEqual(0);
    expect(s.request(0, 0.5)).toBe(-1);
  });

  it('긴 시간 동안 예산이 걸리는 소리의 초당 재생 수는 충전 속도를 넘지 않는다', () => {
    const defs = Array.from({ length: 8 }, () => def({ reserve: 1, maxVoices: 100 }));
    const s = make(defs, { maxVoices: 100, rate: 20, burst: 8 });
    let granted = 0;
    let t = 0;
    for (let i = 0; i < 10000; i++) {
      t += 0.001; // 10초 동안 1 ms마다 요청
      if (s.request(i % 8, t) >= 0) granted++;
    }
    expect(granted).toBeLessThanOrEqual(20 * 10 + 8);
    expect(granted).toBeGreaterThan(20 * 10 * 0.9);
  });
});

describe('VoiceScheduler — 변형', () => {
  it('변형이 여럿이면 같은 것을 연달아 고르지 않고 모두 쓴다', () => {
    const s = new VoiceScheduler([def({ maxVoices: 100 })], { maxVoices: 100, rate: 1e6, burst: 1e6, random: seq(7) });
    s.setLoaded(0, 0, 0.3);
    s.setLoaded(0, 1, 0.3);
    s.setLoaded(0, 2, 0.3);
    const used = new Set<number>();
    let last = -1;
    for (let i = 0; i < 300; i++) {
      expect(s.request(0, i)).toBeGreaterThanOrEqual(0);
      expect(s.variant).not.toBe(last);
      last = s.variant;
      used.add(s.variant);
    }
    expect([...used].sort()).toEqual([0, 1, 2]);
  });

  it('디코드된 변형만 고른다 (실패한 변형은 건너뜀)', () => {
    const s = new VoiceScheduler([def({ maxVoices: 100 })], { maxVoices: 100, rate: 1e6, burst: 1e6, random: seq(3) });
    s.setLoaded(0, 2, 0.4);
    for (let i = 0; i < 20; i++) {
      s.request(0, i);
      expect(s.variant).toBe(2);
    }
    s.setLoaded(0, 0, 0.4);
    const seen = new Set<number>();
    for (let i = 20; i < 60; i++) {
      s.request(0, i);
      seen.add(s.variant);
    }
    expect([...seen].sort()).toEqual([0, 2]);
    expect(s.loadedVariants(0)).toBe(2);
  });
});
