// 효과음 재생 판정 (순수 로직 — Web Audio 없음, 단위 테스트 대상).
// 재생 요청 하나마다: 음소거 → 디코드된 변형 있음 → id별 최소 간격 → 초당 예산(토큰 버킷, 카테고리별 여유분)
// → id별 동시 재생 상한(넘으면 같은 소리 중 가장 오래된 것을 끊음) → 전역 동시 재생 상한(우선순위가 같거나 낮은 것 중
// 가장 오래된 것을 끊음, 다 높으면 버림) → 변형 고르기(같은 것 연속 회피) → 재생 속도(±pitchVar).
// 요청 처리 중 할당 없음: 결과는 이 객체의 필드(variant / rate / stolen)로 돌려준다.

export interface SchedulerDef {
  maxVoices: number;
  minInterval: number;
  pitchVar: number;
  /** 클수록 중요 (전역 상한에서 낮은 것부터 밀려남) */
  priority: number;
  /** 초당 예산에서 남겨 둬야 하는 토큰 수. null = 예산과 무관 */
  reserve: number | null;
}

export interface SchedulerOptions {
  /** 전역 동시 재생 상한 */
  maxVoices: number;
  /** 초당 예산: 토큰 충전 속도(개/초)와 최대 저장량 */
  rate: number;
  burst: number;
  /** [0, 1) 난수 */
  random: () => number;
}

export type RejectReason = 'muted' | 'notLoaded' | 'interval' | 'budget' | 'cap';

export interface SchedulerStats {
  granted: number;
  stolen: number;
  rejected: Record<RejectReason, number>;
}

export class VoiceScheduler {
  /** 음소거면 모든 요청을 버린다 */
  muted = false;

  // ── 마지막 승인 결과 (request가 -1이 아닐 때만 유효) ──
  /** 고른 변형 (0부터) */
  variant = 0;
  /** 재생 속도 배수 (요청 rate × 무작위 음높이) */
  rate = 1;
  /** 이 칸에 아직 재생 중인 소리가 있었다 → 호출 쪽이 그 소리를 끊어야 한다 */
  stolen = false;

  readonly stats: SchedulerStats = {
    granted: 0,
    stolen: 0,
    rejected: { muted: 0, notLoaded: 0, interval: 0, budget: 0, cap: 0 },
  };

  private readonly defs: readonly SchedulerDef[];
  private readonly capacity: number;
  private readonly rateLimit: number;
  private readonly burst: number;
  private readonly random: () => number;

  /** 칸마다: 재생 중인 def(-1 = 빈 칸), 우선순위, 시작/끝 시각 */
  private readonly slotDef: Int32Array;
  private readonly slotPri: Float64Array;
  private readonly slotStart: Float64Array;
  private readonly slotEnd: Float64Array;
  /** def마다: 마지막 재생 시각, 마지막 변형, 디코드된 변형 길이(초, 0 = 없음) */
  private readonly lastPlay: Float64Array;
  private readonly lastVariant: Int32Array;
  private readonly durations: Float64Array[];
  private readonly loadedCount: Int32Array;
  private tokens: number;
  private tokensAt = -Infinity;

  constructor(defs: readonly SchedulerDef[], opts: SchedulerOptions, maxVariants = 8) {
    this.defs = defs;
    this.capacity = Math.max(1, Math.floor(opts.maxVoices));
    this.rateLimit = opts.rate;
    this.burst = opts.burst;
    this.tokens = opts.burst;
    this.random = opts.random;
    this.slotDef = new Int32Array(this.capacity).fill(-1);
    this.slotPri = new Float64Array(this.capacity);
    this.slotStart = new Float64Array(this.capacity);
    this.slotEnd = new Float64Array(this.capacity);
    this.lastPlay = new Float64Array(defs.length).fill(-Infinity);
    this.lastVariant = new Int32Array(defs.length).fill(-1);
    this.durations = defs.map(() => new Float64Array(maxVariants));
    this.loadedCount = new Int32Array(defs.length);
  }

  get maxVoices(): number {
    return this.capacity;
  }

  /** 디코드가 끝난 변형 등록 (길이 = 재생 속도 1일 때 초). 같은 변형을 다시 넣으면 길이만 바뀐다 */
  setLoaded(def: number, variant: number, seconds: number): void {
    const d = this.durations[def];
    if (!d || variant < 0 || variant >= d.length) return;
    if (d[variant] <= 0) this.loadedCount[def]++;
    d[variant] = Math.max(1e-3, seconds);
  }

  /** 디코드된 변형 수 */
  loadedVariants(def: number): number {
    return this.loadedCount[def] ?? 0;
  }

  /**
   * 재생 요청. 승인되면 쓸 칸(0..maxVoices-1)을 돌려주고 variant / rate / stolen을 채운다. 거절이면 -1.
   * now = 초 (단조 증가 시계), rateMul = 호출 쪽이 원하는 재생 속도 (콤보 음 올리기 등)
   */
  request(def: number, now: number, rateMul = 1): number {
    const d = this.defs[def];
    const rej = this.stats.rejected;
    if (!d) return -1;
    if (this.muted) {
      rej.muted++;
      return -1;
    }
    const loaded = this.loadedCount[def];
    if (loaded <= 0) {
      rej.notLoaded++;
      return -1;
    }
    if (now - this.lastPlay[def] < d.minInterval) {
      rej.interval++;
      return -1;
    }
    // 토큰 충전 (시계가 처음이거나 거꾸로 가면 가득)
    if (now > this.tokensAt) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.tokensAt) * this.rateLimit);
    }
    this.tokensAt = now;
    if (d.reserve !== null && this.tokens < 1 + d.reserve) {
      rej.budget++;
      return -1;
    }

    // 칸 고르기: 같은 id가 상한이면 그중 가장 오래된 것, 아니면 빈 칸, 없으면 우선순위가 같거나 낮은 것 중 가장 오래된 것
    const cap = this.capacity;
    let same = 0;
    let oldestSame = -1;
    let free = -1;
    let victim = -1;
    for (let i = 0; i < cap; i++) {
      const sd = this.slotDef[i];
      if (sd < 0 || this.slotEnd[i] <= now) {
        if (free < 0) free = i;
        continue;
      }
      if (sd === def) {
        same++;
        if (oldestSame < 0 || this.slotStart[i] < this.slotStart[oldestSame]) oldestSame = i;
      }
      if (this.slotPri[i] <= d.priority) {
        if (
          victim < 0 ||
          this.slotPri[i] < this.slotPri[victim] ||
          (this.slotPri[i] === this.slotPri[victim] && this.slotStart[i] < this.slotStart[victim])
        ) {
          victim = i;
        }
      }
    }
    let slot: number;
    if (same >= Math.max(1, d.maxVoices) && oldestSame >= 0) slot = oldestSame;
    else if (free >= 0) slot = free;
    else if (victim >= 0) slot = victim;
    else {
      rej.cap++;
      return -1;
    }
    this.stolen = this.slotDef[slot] >= 0 && this.slotEnd[slot] > now;
    if (this.stolen) this.stats.stolen++;

    // 변형: 디코드된 것 중 무작위, 직전과 같은 것은 피한다
    const durs = this.durations[def];
    const last = this.lastVariant[def];
    let pick = -1;
    if (loaded === 1) {
      for (let v = 0; v < durs.length; v++) {
        if (durs[v] > 0) {
          pick = v;
          break;
        }
      }
    } else {
      const avoid = last >= 0 && durs[last] > 0 ? 1 : 0;
      let k = Math.floor(this.random() * (loaded - avoid));
      for (let v = 0; v < durs.length; v++) {
        if (durs[v] <= 0 || (avoid && v === last)) continue;
        if (k-- === 0) {
          pick = v;
          break;
        }
      }
    }
    if (pick < 0) {
      rej.notLoaded++;
      return -1;
    }

    const jitter = d.pitchVar > 0 ? 1 + (this.random() * 2 - 1) * d.pitchVar : 1;
    const rate = Math.max(0.25, Math.min(4, rateMul * jitter));

    if (d.reserve !== null) this.tokens -= 1;
    this.lastPlay[def] = now;
    this.lastVariant[def] = pick;
    this.slotDef[slot] = def;
    this.slotPri[slot] = d.priority;
    this.slotStart[slot] = now;
    this.slotEnd[slot] = now + durs[pick] / rate;
    this.variant = pick;
    this.rate = rate;
    this.stats.granted++;
    return slot;
  }

  /** 칸을 비운다 (호출 쪽이 소리를 멈췄을 때) */
  release(slot: number): void {
    if (slot >= 0 && slot < this.capacity) this.slotDef[slot] = -1;
  }

  /** now에 재생 중인 칸 수 */
  activeVoices(now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.slotDef[i] >= 0 && this.slotEnd[i] > now) n++;
    return n;
  }

  /** now에 재생 중인 def의 칸 수 */
  activeFor(def: number, now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.slotDef[i] === def && this.slotEnd[i] > now) n++;
    return n;
  }

  /** 마지막으로 재생한 시각 (없으면 -Infinity) */
  lastPlayed(def: number): number {
    return this.lastPlay[def] ?? -Infinity;
  }

  /** 모든 칸 비우기 (컨텍스트를 새로 만들 때 등) */
  clear(): void {
    this.slotDef.fill(-1);
  }
}
