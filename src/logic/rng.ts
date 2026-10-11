// 시드 RNG (mulberry32). 상태가 number 하나라 RunState에 그대로 직렬화된다.

export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 실수 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [min, max] 정수 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** weights와 같은 길이의 items 중 가중치로 하나. 모든 가중치가 0이면 null */
  weighted<T>(items: readonly T[], weights: readonly number[]): T | null {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return null;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }
}

/** 시드 없는 곳(새 런 시작)에서만 사용 */
export function randomSeed(): number {
  return (Date.now() ^ (performance.now() * 1000)) >>> 0;
}
