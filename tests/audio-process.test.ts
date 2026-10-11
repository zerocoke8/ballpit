import { describe, expect, it } from 'vitest';
import {
  audibleRange,
  dbToGain,
  downmix,
  gainToDb,
  peakOf,
  processMono,
  shortTermLoudness,
  LEAD_PAD_SEC,
  LOUDNESS_CEIL_DB,
  TARGET_PEAK_DB,
} from '../src/audio/process';

const SR = 48000;

/** lead초 무음(-60 dBFS 잡음) → body초 사인(amp) → tail초 무음 */
function clip(lead: number, body: number, tail: number, amp: number): Float32Array {
  const n = Math.round((lead + body + tail) * SR);
  const out = new Float32Array(n);
  const floor = dbToGain(-60);
  const a = Math.round(lead * SR);
  const b = a + Math.round(body * SR);
  for (let i = 0; i < n; i++) {
    if (i >= a && i < b) out[i] = amp * Math.sin((2 * Math.PI * 440 * (i - a)) / SR);
    else out[i] = (i % 2 ? 1 : -1) * floor;
  }
  return out;
}

describe('process — 기본 함수', () => {
  it('dB ↔ 게인', () => {
    expect(dbToGain(0)).toBeCloseTo(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(gainToDb(0)).toBe(-Infinity);
  });

  it('downmix: 채널 평균, 모노는 복사(원본과 다른 배열)', () => {
    const l = new Float32Array([1, 0.5, -1]);
    const r = new Float32Array([0, 0.5, 1]);
    expect([...downmix([l, r])]).toEqual([0.5, 0.5, 0]);
    const m = downmix([l]);
    expect([...m]).toEqual([1, 0.5, -1]);
    expect(m).not.toBe(l);
    expect(downmix([]).length).toBe(0);
  });

  it('audibleRange: 문턱을 처음/마지막으로 넘는 표본, 무음이면 null', () => {
    const d = new Float32Array([0, 0.001, 0.2, 0, 0.3, 0.001, 0]);
    expect(audibleRange(d, 0.01)).toEqual({ first: 2, last: 4 });
    expect(audibleRange(new Float32Array(5), 0.01)).toBeNull();
    expect(peakOf(d)).toBeCloseTo(0.3);
  });
});

describe('processMono — 무음 자르기 + 정규화', () => {
  it('앞 무음(-50 dBFS 아래)을 자르고 피크를 -3 dBFS × 볼륨으로 맞춘다', () => {
    const src = clip(0.25, 0.2, 0.3, 0.25);
    const copy = src.slice();
    // 단기 음량 상한은 따로 시험 (사인파는 빽빽해서 상한에 걸린다)
    const r = processMono(src, { sampleRate: SR, volume: 0.5, loudnessCeilDb: 0 });
    // 입력은 그대로
    expect(src).toEqual(copy);
    expect(r.silent).toBe(false);
    expect(r.trimmedLead).toBeCloseTo(0.25 - LEAD_PAD_SEC, 2);
    expect(r.trimmedTail).toBeGreaterThan(0.25);
    expect(r.data.length / SR).toBeLessThan(0.3);
    expect(r.data.length / SR).toBeGreaterThan(0.2);
    expect(r.sourcePeakDb).toBeCloseTo(gainToDb(0.25), 1);
    expect(r.peakDb).toBeCloseTo(TARGET_PEAK_DB + gainToDb(0.5), 1);
    // 양 끝은 페이드로 0
    expect(r.data[0]).toBe(0);
    expect(Math.abs(r.data[r.data.length - 1])).toBeLessThan(1e-6);
  });

  it('볼륨 1이면 피크 -3 dBFS (크게 녹음된 소리는 줄인다)', () => {
    const r = processMono(clip(0, 0.1, 0, 1), { sampleRate: SR, volume: 1, loudnessCeilDb: 0 });
    expect(r.peakDb).toBeCloseTo(-3, 1);
    expect(r.trimmedLead).toBe(0);
  });

  it('빽빽한 소리(사인파)는 단기 음량 상한까지 더 줄이고, 짧은 딸깍 소리는 피크만 맞춘다', () => {
    // 사인파: 피크 -3 dBFS면 RMS -6 dBFS → 상한 -12 dBFS로 6 dB 더 줄어든다 (볼륨은 그 뒤에 곱함)
    const dense = processMono(clip(0, 0.3, 0, 0.8), { sampleRate: SR, volume: 0.5 });
    expect(dense.loudnessDb).toBeCloseTo(LOUDNESS_CEIL_DB + gainToDb(0.5), 1);
    expect(dense.peakDb).toBeCloseTo(LOUDNESS_CEIL_DB + 3 + gainToDb(0.5), 1);
    // 빠르게 사라지는 딸깍: 단기 음량이 상한보다 낮아 피크 정규화만
    const click = new Float32Array(Math.round(0.2 * SR));
    for (let i = 0; i < click.length; i++) click[i] = 0.4 * Math.sin(i / 3) * Math.exp(-i / (SR * 0.004));
    const r = processMono(click, { sampleRate: SR, volume: 1 });
    expect(r.peakDb).toBeCloseTo(TARGET_PEAK_DB, 1);
    expect(r.loudnessDb).toBeLessThan(LOUDNESS_CEIL_DB);
  });

  it('shortTermLoudness: 창 RMS의 최대 (짧으면 전체 RMS)', () => {
    const d = new Float32Array(SR);
    for (let i = 0; i < SR * 0.05; i++) d[i] = i % 2 ? 0.5 : -0.5;
    expect(shortTermLoudness(d, SR)).toBeCloseTo(0.5, 2);
    expect(shortTermLoudness(new Float32Array([0.3, -0.3]), SR)).toBeCloseTo(0.3, 5);
    expect(shortTermLoudness(new Float32Array(0), SR)).toBe(0);
  });

  it('조용하게 나온 소리의 잔향은 피크 기준으로 남긴다', () => {
    // 피크 0.05(-26 dBFS)인 소리 뒤에 -60 dBFS 꼬리 → 피크 기준 -34 dB라 남겨야 함
    const n = Math.round(0.4 * SR);
    const d = new Float32Array(n);
    for (let i = 0; i < SR * 0.1; i++) d[i] = 0.05 * Math.sin(i / 5);
    for (let i = SR * 0.1; i < SR * 0.3; i++) d[i] = (i % 2 ? 1 : -1) * dbToGain(-60);
    const r = processMono(d, { sampleRate: SR, volume: 1 });
    expect(r.data.length / SR).toBeGreaterThan(0.28);
  });

  it('무음뿐이면 길이 1의 무음 (재생해도 소리 없음)', () => {
    const r = processMono(new Float32Array(1000), { sampleRate: SR, volume: 1 });
    expect(r.silent).toBe(true);
    expect(r.data.length).toBe(1);
    expect(r.data[0]).toBe(0);
  });
});
