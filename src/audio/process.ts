// 디코드한 효과음 다듬기 (순수 함수 — Web Audio 없음, 단위 테스트 대상).
// 모노로 섞기(메모리 절반) → 앞뒤 무음 자르기 → 피크를 목표 레벨로 맞추고(빽빽한 소리는 단기 음량 상한까지 더 줄임)
// id별 볼륨 곱하기 → 앞뒤를 짧게 페이드.

/** 무음 판정 문턱 (-50 dBFS) */
export const SILENCE_DB = -50;
/** 뒤 무음 문턱: 피크 기준 이만큼(dB) 아래 — 조용하게 나온 소리의 잔향은 남긴다 (절대 문턱과 둘 중 낮은 쪽) */
export const TAIL_REL_DB = -45;
/** 피크 정규화 목표 (-3 dBFS) */
export const TARGET_PEAK_DB = -3;
/**
 * 단기 음량 상한 (피크 정규화 뒤 50 ms RMS 최대, dBFS). 같은 피크라도 빽빽한 소리(웅웅·쉬익)는 훨씬 크게 들린다 —
 * 생성된 클립은 같은 프롬프트의 변형끼리도 8 dB 넘게 차이가 나서(hit_toy) 이 이상이면 더 줄여 맞춘다.
 */
export const LOUDNESS_CEIL_DB = -12;
/** 단기 음량 창(초) */
export const LOUDNESS_WINDOW_SEC = 0.05;
/** 자른 앞부분 직전 여유(초) — 소리의 첫 어택이 잘리지 않게 */
export const LEAD_PAD_SEC = 0.004;
/** 뒤 무음을 자른 뒤 남기는 여유(초) + 끝 페이드 길이(초) */
export const TAIL_PAD_SEC = 0.02;
export const TAIL_FADE_SEC = 0.012;
/** 앞 페이드 인(초) — 자른 지점의 딸깍 소리 방지 */
export const HEAD_FADE_SEC = 0.002;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return g > 0 ? 20 * Math.log10(g) : -Infinity;
}

/** 채널들을 평균해 모노로 (채널이 하나면 복사) */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  const n = channels.length;
  if (n === 0) return new Float32Array(0);
  const len = channels[0].length;
  const out = new Float32Array(len);
  if (n === 1) {
    out.set(channels[0]);
    return out;
  }
  const inv = 1 / n;
  for (let c = 0; c < n; c++) {
    const ch = channels[c];
    const m = Math.min(len, ch.length);
    for (let i = 0; i < m; i++) out[i] += ch[i] * inv;
  }
  return out;
}

export function peakOf(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > p) p = a;
  }
  return p;
}

/** 문턱(진폭)을 처음 / 마지막으로 넘는 표본 [first, last]. 전부 무음이면 null. 뒤쪽 문턱을 따로 줄 수 있다 */
export function audibleRange(data: Float32Array, threshold: number, tailThreshold = threshold): { first: number; last: number } | null {
  let first = -1;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  let last = first;
  for (let i = data.length - 1; i > first; i--) {
    if (Math.abs(data[i]) > tailThreshold) {
      last = i;
      break;
    }
  }
  return { first, last };
}

export interface ProcessResult {
  data: Float32Array;
  /** 잘라낸 앞 무음(초) */
  trimmedLead: number;
  /** 잘라낸 뒤 무음(초) */
  trimmedTail: number;
  /** 원본(모노) 피크 dBFS */
  sourcePeakDb: number;
  /** 결과 피크 dBFS (= 목표 + 볼륨, 빽빽한 소리는 더 낮음) */
  peakDb: number;
  /** 결과 단기 음량(50 ms RMS 최대) dBFS — 볼륨까지 곱한 값 */
  loudnessDb: number;
  /** 소리가 하나도 없었다 (결과는 짧은 무음) */
  silent: boolean;
}

export interface ProcessOptions {
  sampleRate: number;
  /** 정규화 후 곱하는 볼륨 0..1 */
  volume: number;
  silenceDb?: number;
  targetPeakDb?: number;
  loudnessCeilDb?: number;
}

/** 단기 음량: 창 크기 RMS의 최대 (창보다 짧으면 전체 RMS) */
export function shortTermLoudness(data: Float32Array, sampleRate: number, windowSec = LOUDNESS_WINDOW_SEC): number {
  const win = Math.max(1, Math.round(windowSec * sampleRate));
  if (data.length <= win) {
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i] * data[i];
    return data.length > 0 ? Math.sqrt(s / data.length) : 0;
  }
  let sum = 0;
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
    if (i >= win) sum -= data[i - win] * data[i - win];
    if (i >= win - 1 && sum > max) max = sum;
  }
  return Math.sqrt(Math.max(0, max) / win);
}

/**
 * 모노 표본 → 앞뒤 무음 자르기 + 피크 정규화 × volume + 앞뒤 짧은 페이드. 입력은 바꾸지 않는다.
 * 무음뿐이면 길이 1의 무음을 돌려준다(재생해도 아무 소리 없음).
 */
export function processMono(mono: Float32Array, opts: ProcessOptions): ProcessResult {
  const sr = opts.sampleRate;
  const silence = dbToGain(opts.silenceDb ?? SILENCE_DB);
  const sourcePeak = peakOf(mono);
  // 앞: 절대 문턱(-50 dBFS). 뒤: 피크 기준 TAIL_REL_DB와 절대 문턱 중 낮은 쪽
  const range = audibleRange(mono, silence, Math.min(silence, sourcePeak * dbToGain(TAIL_REL_DB)));
  if (!range || sourcePeak <= 0) {
    return {
      data: new Float32Array(1),
      trimmedLead: mono.length / sr,
      trimmedTail: 0,
      sourcePeakDb: -Infinity,
      peakDb: -Infinity,
      loudnessDb: -Infinity,
      silent: true,
    };
  }
  const start = Math.max(0, range.first - Math.round(LEAD_PAD_SEC * sr));
  const end = Math.min(mono.length, range.last + 1 + Math.round(TAIL_PAD_SEC * sr));
  const out = mono.slice(start, end);
  const volume = Math.max(0, Math.min(1, opts.volume));
  let gain = dbToGain(opts.targetPeakDb ?? TARGET_PEAK_DB) / sourcePeak;
  // 빽빽한 소리: 피크를 맞춘 뒤의 단기 음량이 상한을 넘으면 그만큼 더 줄인다
  const loud = shortTermLoudness(out, sr) * gain;
  const ceil = dbToGain(opts.loudnessCeilDb ?? LOUDNESS_CEIL_DB);
  if (loud > ceil) gain *= ceil / loud;
  gain *= volume;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  // 앞뒤 페이드 (자른 자리에서 딸깍 소리가 나지 않게). 앞은 실제로 잘랐을 때만 — 원래 0부터 시작하는 소리의 어택은 그대로
  const headN = start > 0 ? Math.min(out.length, Math.round(HEAD_FADE_SEC * sr)) : 0;
  for (let i = 0; i < headN; i++) out[i] *= i / headN;
  const tailN = Math.min(out.length, Math.round(TAIL_FADE_SEC * sr));
  for (let i = 0; i < tailN; i++) out[out.length - 1 - i] *= i / tailN;
  return {
    data: out,
    trimmedLead: start / sr,
    trimmedTail: (mono.length - end) / sr,
    sourcePeakDb: gainToDb(sourcePeak),
    peakDb: gainToDb(peakOf(out)),
    loudnessDb: gainToDb(shortTermLoudness(out, sr)),
    silent: false,
  };
}
