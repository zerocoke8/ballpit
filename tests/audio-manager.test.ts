// AudioManager를 가짜 Web Audio·fetch·window·document로 돌린다 (node 환경, 브라우저 없음).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager, volumeCurve, type AudioEnv } from '../src/audio/AudioManager';
import { SFX_DEFS, type SfxDef, type SfxId } from '../src/data/sfxMap';

// ── 가짜 Web Audio ──────────────────────────────────────────

class FakeParam {
  value: number;
  constructor(v = 1) {
    this.value = v;
  }
  setTargetAtTime(v: number): void {
    this.value = v;
  }
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
}

class FakeNode {
  outputs: FakeNode[] = [];
  connect<T extends FakeNode>(n: T): T {
    this.outputs.push(n);
    return n;
  }
  disconnect(): void {
    this.outputs = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakePanner extends FakeNode {
  pan = new FakeParam(0);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate = new FakeParam(1);
  startedAt = -1;
  stoppedAt = -1;
  start(t: number): void {
    this.startedAt = t;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
}

class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c];
  }
}

/** 클립 바이트 = 'SFX' + 채널 수 (+ 1이면 무음). 디코드 결과: 0.1초 무음 + 0.2초 소리(피크 0.5) + 0.2초 무음 */
const SR = 48000;
function encodeClip(channels = 2, silent = false): ArrayBuffer {
  return new Uint8Array([83, 70, 88, channels, silent ? 1 : 0]).buffer;
}

class FakeCtx {
  state: 'suspended' | 'running' | 'closed' | 'interrupted' = 'suspended';
  currentTime = 0;
  sampleRate = SR;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  panners: FakePanner[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  decodeCalls = 0;
  /** WebKit: 시작할 수 없는 동안(제스처 밖·'interrupted') resume()의 프로미스가 끝나지 않고 상태도 그대로 */
  hangResume = false;
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createStereoPanner(): FakePanner {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.hangResume) return new Promise<void>(() => {});
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    this.decodeCalls++;
    const b = new Uint8Array(bytes);
    if (b[0] !== 83 || b[1] !== 70 || b[2] !== 88) return Promise.reject(new Error('EncodingError'));
    const buf = new FakeBuffer(b[3], Math.round(0.5 * SR), SR);
    if (b[4] === 1) return Promise.resolve(buf);
    for (let c = 0; c < b[3]; c++) {
      const d = buf.getChannelData(c);
      for (let i = Math.round(0.1 * SR); i < Math.round(0.3 * SR); i++) d[i] = 0.5 * Math.sin(i / 7);
    }
    return Promise.resolve(buf);
  }
}

// ── 가짜 window / document / fetch ──────────────────────────

class FakeTarget {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, extra: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, ...extra } as unknown as Event);
  }
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

class FakeDocument extends FakeTarget {
  hidden = false;
}

type Files = Record<string, string | ArrayBuffer | number>;

function makeEnv(files: Files) {
  const win = new FakeTarget();
  const doc = new FakeDocument();
  const contexts: FakeCtx[] = [];
  const decoders: FakeCtx[] = [];
  const clock = { t: 100 };
  let activation = true;
  let current: Event | undefined;
  const env: AudioEnv = {
    createContext: () => {
      const c = new FakeCtx();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    createDecoder: () => {
      const c = new FakeCtx();
      decoders.push(c);
      return c as unknown as BaseAudioContext;
    },
    fetch: async (url: string) => {
      const key = url.replace(/^.*\/sfx\//, '');
      const body = files[key];
      if (body === undefined) return { ok: false, status: 404, text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
      if (typeof body === 'number') throw new Error('network down');
      return {
        ok: true,
        status: 200,
        text: async () => (typeof body === 'string' ? body : ''),
        arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
      } as unknown as Response;
    },
    now: () => clock.t,
    schedule: (fn) => {
      setTimeout(fn, 0);
    },
    userActivationActive: () => activation,
    currentEvent: () => current,
    window: win as unknown as Window,
    document: doc as unknown as Document,
  };
  return {
    env,
    win,
    doc,
    contexts,
    decoders,
    clock,
    setActivation: (v: boolean) => {
      activation = v;
    },
    /** 지금 처리 중인 DOM 이벤트 흉내 (window.event) */
    setCurrentEvent: (e: Record<string, unknown> | undefined) => {
      current = e as unknown as Event | undefined;
    },
  };
}

const DEFS: SfxDef[] = [
  { id: 'ui_tap', category: 'ui', duration: 0.5, influence: 0.5, variants: 1, volume: 0.5, maxVoices: 2, minInterval: 0.04, pitchVar: 0, prompt: 'x' },
  { id: 'hit_toy', category: 'hit', duration: 0.5, influence: 0.5, variants: 3, volume: 1, maxVoices: 4, minInterval: 0.035, pitchVar: 0.1, prompt: 'x' },
  { id: 'stage_clear', category: 'jingle', duration: 2, influence: 0.5, variants: 1, volume: 0.8, maxVoices: 1, minInterval: 1, pitchVar: 0, prompt: 'x' },
  { id: 'fire_fish', category: 'fire', duration: 0.5, influence: 0.5, variants: 2, volume: 0.4, maxVoices: 3, minInterval: 0.06, pitchVar: 0.08, prompt: 'x' },
  // manifest에 없는 id (디코드 안 됨)
  { id: 'combo', category: 'reward', duration: 0.5, influence: 0.5, variants: 1, volume: 0.4, maxVoices: 2, minInterval: 0.08, pitchVar: 0, prompt: 'x' },
];

const FULL_FILES: Files = {
  'manifest.json': JSON.stringify({
    ui_tap: ['ui_tap_1.mp3'],
    hit_toy: ['hit_toy_1.mp3', 'hit_toy_2.mp3', 'hit_toy_3.mp3'],
    stage_clear: ['stage_clear_1.mp3'],
    fire_fish: ['fire_fish_1.mp3', 'fire_fish_2.mp3'],
    unknown_sound: ['nope_1.mp3'],
  }),
  'ui_tap_1.mp3': encodeClip(2),
  'hit_toy_1.mp3': encodeClip(2),
  'hit_toy_2.mp3': encodeClip(1),
  'hit_toy_3.mp3': encodeClip(2),
  'stage_clear_1.mp3': encodeClip(2),
  'fire_fish_1.mp3': encodeClip(2),
  'fire_fish_2.mp3': encodeClip(2),
};

function manager(files: Files, over: Partial<ConstructorParameters<typeof AudioManager>[0]> = {}) {
  const h = makeEnv(files);
  const m = new AudioManager({ baseUrl: './sfx/', env: h.env, defs: DEFS, loadDelayMs: 0, loadGapMs: 0, random: () => 0.37, ...over });
  return { m, ...h };
}

/** 잠금 해제 제스처 (터치 pointerup) */
function unlock(h: ReturnType<typeof manager>): FakeCtx {
  h.win.emit('pointerup', { pointerType: 'touch' });
  return h.contexts[0];
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(error).not.toHaveBeenCalled();
  warn.mockRestore();
  error.mockRestore();
});

describe('AudioManager — manifest가 없거나 비어도 조용히', () => {
  it('manifest 없음(404) → 아무 소리 없이 끝, 오류 없음', async () => {
    const h = manager({});
    h.m.install();
    await h.m.load();
    const ctx = unlock(h);
    h.m.play('ui_tap');
    expect(h.m.stats().manifest).toBe('missing');
    expect(h.m.stats().clipsListed).toBe(0);
    expect(ctx.sources.filter((s) => s.buffer && s.buffer.length > 1)).toHaveLength(0);
  });

  it('개발 서버의 index.html(200) 대체 응답 → 없는 것으로', async () => {
    const h = manager({ 'manifest.json': '<!doctype html><html></html>' });
    await h.m.load();
    expect(h.m.stats().manifest).toBe('missing');
  });

  it('빈 manifest {} → empty, 재생은 아무것도 안 함', async () => {
    const h = manager({ 'manifest.json': '{}' });
    h.m.install();
    await h.m.load();
    const ctx = unlock(h);
    h.m.play('hit_toy');
    expect(h.m.stats().manifest).toBe('empty');
    expect(h.m.stats().plays).toBe(0);
    expect(ctx.gains.length).toBe(1); // 마스터만
  });

  it('소리가 없는 클립은 등록하지 않고 같은 id의 다른 변형만 쓴다 (경고 1줄)', async () => {
    const h = manager({ ...FULL_FILES, 'hit_toy_2.mp3': encodeClip(2, true) });
    h.m.install();
    await h.m.load();
    expect(h.m.stats().clipsSilent).toBe(1);
    expect(h.m.stats().clipsDecoded).toBe(6);
    expect(warn).toHaveBeenCalledTimes(1);
    const ctx = unlock(h);
    await Promise.resolve();
    for (let i = 0; i < 30; i++) {
      h.clock.t += 0.1;
      h.m.play('hit_toy');
    }
    // 무음 변형(길이 1 표본)은 한 번도 고르지 않는다
    for (const s of ctx.sources.slice(1)) expect(s.buffer!.length).toBeGreaterThan(1000);
    expect(h.m.stats().playsById.hit_toy).toBe(30);
  });

  it('네트워크 오류·깨진 클립은 그 클립만 빠진다', async () => {
    const h = manager({ ...FULL_FILES, 'hit_toy_2.mp3': 0, 'fire_fish_1.mp3': new Uint8Array([1, 2, 3]).buffer });
    await h.m.load();
    const st = h.m.stats();
    expect(st.clipsListed).toBe(7);
    expect(st.clipsDecoded).toBe(5);
    expect(st.clipsFailed).toBe(2);
    expect(h.m.isLoaded('fire_fish')).toBe(true);
  });
});

describe('AudioManager — 디코드 다듬기', () => {
  it('모노로 섞고 앞뒤 무음을 자르고 피크 -3 dBFS(빽빽한 사인파는 단기 음량 상한까지) × 볼륨', async () => {
    const h = manager(FULL_FILES);
    await h.m.load();
    const clips = h.m.clips();
    expect(clips).toHaveLength(7);
    for (const c of clips) {
      expect(c.trimmedLead).toBeGreaterThan(0.09);
      expect(c.trimmedTail).toBeGreaterThan(0.15);
      expect(c.duration).toBeLessThan(0.25);
      const vol = DEFS.find((d) => d.id === c.id)!.volume;
      // 가짜 클립은 사인파 → 단기 음량 상한(-12 dBFS)에 걸려 피크는 -9 dBFS
      expect(c.loudnessDb).toBeCloseTo(-12 + 20 * Math.log10(vol), 0);
      expect(c.peakDb).toBeCloseTo(-9 + 20 * Math.log10(vol), 0);
    }
    // 디코드는 제스처 전에도 OfflineAudioContext(디코더)로 — 재생 컨텍스트는 아직 없음
    expect(h.decoders).toHaveLength(1);
    expect(h.contexts).toHaveLength(0);
    // 로드 순서: ui → jingle → … (메뉴 소리가 먼저)
    expect(clips[0].id).toBe('ui_tap');
    expect(clips[1].id).toBe('stage_clear');
  });
});

describe('AudioManager — 잠금 해제', () => {
  it('제스처 전에는 컨텍스트도 노드도 만들지 않는다', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    h.m.play('ui_tap');
    expect(h.contexts).toHaveLength(0);
    expect(h.m.stats().plays).toBe(0);
  });

  it('터치의 pointerdown은 활성화가 아니라서 기다리고, pointerup에서 만들고 resume (+무음 한 표본)', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    h.win.emit('pointerdown', { pointerType: 'touch' });
    expect(h.contexts).toHaveLength(0);
    h.win.emit('pointerup', { pointerType: 'touch' });
    expect(h.contexts).toHaveLength(1);
    const ctx = h.contexts[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.sources).toHaveLength(1); // iOS 잠금 해제용 무음
    expect(h.m.stats().unlocked).toBe(true);
  });

  it('마우스 pointerdown·keydown은 바로 된다, 활성화가 아니면 기다린다', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    h.setActivation(false);
    h.win.emit('keydown');
    expect(h.contexts).toHaveLength(0);
    h.setActivation(true);
    h.win.emit('pointerdown', { pointerType: 'mouse' });
    expect(h.contexts).toHaveLength(1);
  });

  it("iOS 'interrupted' 뒤 다음 제스처에서 다시 resume", async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    const ctx = unlock(h);
    await Promise.resolve();
    // 전화·앱 전환은 잠금 해제 탭보다 한참 뒤 (탭 직후 잠깐은 running 전이라도 예약을 허용하므로)
    h.clock.t += 5;
    ctx.state = 'interrupted';
    h.m.play('ui_tap');
    expect(h.m.stats().plays).toBe(0);
    h.win.emit('touchend');
    expect(ctx.resumeCalls).toBe(2);
    expect(ctx.state).toBe('running');
  });

  it('첫 탭: 버튼 소리가 잠금 해제 리스너보다 먼저 와도(PixiJS가 window 캡처 pointerup을 먼저 등록) 그 탭으로 풀고 들린다', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    // 제스처 이벤트 밖(부팅 중 등)의 재생 요청은 컨텍스트를 만들지 않는다
    h.m.play('ui_tap');
    expect(h.contexts).toHaveLength(0);
    // 터치 pointerdown 안에서도 아직 아니다 (사용자 활성화가 아님)
    h.setCurrentEvent({ type: 'pointerdown', pointerType: 'touch', isTrusted: true });
    h.m.play('ui_tap');
    expect(h.contexts).toHaveLength(0);
    // pointerup 처리 중 (PixiJS → Button.handleTap → sfx.play) — 우리 리스너는 이 뒤에 온다
    h.setCurrentEvent({ type: 'pointerup', pointerType: 'touch', isTrusted: true });
    h.m.play('ui_tap');
    expect(h.contexts).toHaveLength(1);
    expect(h.m.stats().plays).toBe(1);
    expect(h.m.stats().unlocked).toBe(true);
    // 이어서 우리 리스너가 같은 이벤트를 받아도 무음 표본·컨텍스트를 또 만들지 않는다
    h.win.emit('pointerup', { pointerType: 'touch' });
    expect(h.contexts).toHaveLength(1);
    h.setCurrentEvent(undefined);
  });

  it('스크립트가 만든 가짜 이벤트(isTrusted false) 안의 재생은 잠금을 풀지 않는다', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    h.setCurrentEvent({ type: 'keydown', isTrusted: false });
    h.m.play('ui_tap');
    expect(h.contexts).toHaveLength(0);
  });

  it("끝나지 않는 resume(WebKit 'interrupted') 뒤에도 제스처마다 다시 resume하고, 그동안 소리를 쌓아 두지 않는다", async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    const ctx = unlock(h);
    await Promise.resolve();
    expect(ctx.state).toBe('running');
    // 앱 전환: 숨김 → (전화 등으로) interrupted → 돌아옴. 제스처 밖의 resume은 WebKit에서 끝나지 않는다
    h.doc.hidden = true;
    h.doc.emit('visibilitychange');
    ctx.state = 'interrupted';
    ctx.hangResume = true;
    h.doc.hidden = false;
    h.doc.emit('visibilitychange');
    const calls = ctx.resumeCalls;
    expect(calls).toBeGreaterThanOrEqual(2);
    // 안 풀린 동안의 재생 요청은 노드를 만들지 않는다 (만들면 풀리는 순간 한꺼번에 터진다)
    const before = ctx.sources.length;
    for (let i = 0; i < 5; i++) {
      h.clock.t += 0.5;
      h.m.play('ui_tap');
      h.m.play('hit_toy');
    }
    expect(ctx.sources.length).toBe(before);
    // 방해가 끝나고 사용자가 탭 → 이 제스처에서 다시 resume (앞의 resume이 아직 안 끝났어도)
    ctx.state = 'suspended';
    ctx.hangResume = false;
    h.clock.t += 1;
    h.win.emit('touchend');
    expect(ctx.resumeCalls).toBe(calls + 1);
    expect(ctx.state).toBe('running');
    h.m.play('ui_tap');
    expect(ctx.sources.length).toBe(before + 1);
  });

  it('제스처로 resume을 부른 직후 잠깐은 아직 running이 아니어도 예약하고, 그 뒤엔 버린다', async () => {
    const h = manager(FULL_FILES);
    h.m.install();
    await h.m.load();
    const ctxs = h.contexts;
    h.win.emit('pointerup', { pointerType: 'touch' });
    const ctx = ctxs[0];
    // 안드로이드: 오디오 장치가 켜지는 동안 state는 아직 suspended
    ctx.state = 'suspended';
    ctx.hangResume = true;
    const before = ctx.sources.length;
    h.m.play('ui_tap');
    expect(ctx.sources.length).toBe(before + 1);
    h.clock.t += 1;
    h.m.play('hit_toy');
    expect(ctx.sources.length).toBe(before + 1);
  });

  it('dispose하면 리스너를 모두 떼고 컨텍스트를 닫는다', () => {
    const h = manager(FULL_FILES);
    h.m.install();
    expect(h.win.count()).toBe(4);
    expect(h.doc.count()).toBe(1);
    h.m.dispose();
    expect(h.win.count()).toBe(0);
    expect(h.doc.count()).toBe(0);
  });
});

describe('AudioManager — 재생', () => {
  async function ready(over: Partial<ConstructorParameters<typeof AudioManager>[0]> = {}) {
    const h = manager(FULL_FILES, over);
    h.m.install();
    await h.m.load();
    const ctx = unlock(h);
    await Promise.resolve();
    return { ...h, ctx };
  }

  it('소스 → 게인 → (패너) → 마스터, 재생 속도·볼륨 반영', async () => {
    const h = await ready();
    const before = h.ctx.sources.length;
    h.m.play('ui_tap', { volume: 0.5 });
    const src = h.ctx.sources[before];
    expect(src.buffer?.numberOfChannels).toBe(1);
    expect(src.startedAt).toBe(0);
    const g = src.outputs[0] as FakeGain;
    expect(g.gain.value).toBe(0.5);
    expect(h.ctx.panners).toHaveLength(0);
    h.clock.t += 1;
    h.m.playAt('hit_toy', 0.3, 1.5);
    const s2 = h.ctx.sources[before + 1];
    expect(s2.playbackRate.value).toBeGreaterThan(1.5 * 0.9 - 1e-9);
    expect(s2.playbackRate.value).toBeLessThan(1.5 * 1.1 + 1e-9);
    expect(h.ctx.panners).toHaveLength(1);
    expect(h.ctx.panners[0].pan.value).toBeCloseTo(0.3);
    expect(h.m.stats().plays).toBe(2);
    expect(h.m.stats().playsById).toEqual({ ui_tap: 1, hit_toy: 1 });
  });

  it('모르는 id·디코드 안 된 id는 아무것도 안 함', async () => {
    const h = await ready();
    const before = h.ctx.sources.length;
    h.m.play('nope' as SfxId);
    h.m.play('combo');
    expect(h.ctx.sources.length).toBe(before);
    expect(h.m.stats().unknownIds).toBe(1);
    expect(h.m.stats().scheduler.rejected.notLoaded).toBe(1);
    expect(h.m.isLoaded('combo')).toBe(false);
  });

  it('minInterval·id별 동시 재생 상한 (넘으면 오래된 것을 짧게 줄이며 멈춤)', async () => {
    const h = await ready();
    const base = h.ctx.sources.length;
    h.m.play('hit_toy');
    h.m.play('hit_toy'); // 같은 시각 → minInterval로 버림
    expect(h.ctx.sources.length).toBe(base + 1);
    for (let i = 0; i < 5; i++) {
      h.clock.t += 0.04;
      h.m.play('hit_toy');
    }
    // 4개 상한: 5번째·6번째는 가장 오래된 것을 끊음
    const mine = h.ctx.sources.slice(base);
    expect(mine).toHaveLength(6);
    expect(mine[0].stoppedAt).toBeGreaterThanOrEqual(0);
    expect(mine[1].stoppedAt).toBeGreaterThanOrEqual(0);
    expect(mine[5].stoppedAt).toBe(-1);
    expect(h.m.stats().activeVoices).toBe(4);
  });

  it('전역 상한: 징글은 발사음을 밀어내고 들린다', async () => {
    const h = await ready({ maxVoices: 3 });
    for (let i = 0; i < 3; i++) {
      h.clock.t += 0.07;
      h.m.play('fire_fish');
    }
    expect(h.m.stats().activeVoices).toBe(3);
    h.m.play('stage_clear');
    expect(h.m.stats().playsById.stage_clear).toBe(1);
    expect(h.m.stats().activeVoices).toBe(3);
    expect(h.m.stats().scheduler.stolen).toBe(1);
  });

  it('음소거·볼륨: 마스터 게인이 바로 바뀌고, 음소거 중엔 노드를 만들지 않는다', async () => {
    const h = await ready();
    h.m.setVolume(false, 0.5);
    expect(h.m.stats().masterGain).toBeCloseTo(volumeCurve(0.5));
    h.m.setVolume(true, 0.5);
    expect(h.m.stats().masterGain).toBe(0);
    const before = h.ctx.sources.length;
    h.m.play('ui_tap');
    expect(h.ctx.sources.length).toBe(before);
    expect(h.m.stats().scheduler.rejected.muted).toBe(1);
    h.m.setVolume(false, 1);
    h.clock.t += 1;
    h.m.play('ui_tap');
    expect(h.ctx.sources.length).toBe(before + 1);
  });

  it('탭이 숨으면 재생 중인 소리를 끊는다 (돌아와서 이어 나거나, 칸을 다시 쓸 때 뚝 끊기지 않게)', async () => {
    const h = await ready();
    h.m.play('stage_clear');
    h.m.play('ui_tap');
    const playing = h.ctx.sources.slice(-2);
    expect(h.m.stats().activeVoices).toBe(2);
    h.doc.hidden = true;
    h.doc.emit('visibilitychange');
    for (const s of playing) {
      expect(s.stoppedAt).toBeGreaterThanOrEqual(0);
      expect(s.outputs).toHaveLength(0);
    }
    expect(h.m.stats().activeVoices).toBe(0);
  });

  it('탭이 숨으면 suspend + 재생 안 함, 다시 보이면 resume', async () => {
    const h = await ready();
    h.doc.hidden = true;
    h.doc.emit('visibilitychange');
    expect(h.ctx.suspendCalls).toBe(1);
    const before = h.ctx.sources.length;
    h.m.play('ui_tap');
    expect(h.ctx.sources.length).toBe(before);
    h.doc.hidden = false;
    h.doc.emit('visibilitychange');
    await Promise.resolve();
    expect(h.ctx.state).toBe('running');
    h.clock.t += 1;
    h.m.play('ui_tap');
    expect(h.ctx.sources.length).toBe(before + 1);
  });

  it('예산이 바닥나도 UI·징글은 들린다 (예산과 무관 = null이 0으로 바뀌지 않음)', async () => {
    const h = await ready({ playsPerSecond: 5, burst: 2 });
    // 같은 시각에 타격음·발사음을 몰아서 예산을 다 쓴다
    for (let i = 0; i < 10; i++) {
      h.clock.t += 0.05;
      h.m.play('hit_toy');
      h.m.play('fire_fish');
    }
    expect(h.m.stats().scheduler.rejected.budget).toBeGreaterThan(0);
    const before = h.m.stats().plays;
    h.m.play('stage_clear');
    h.m.play('ui_tap');
    expect(h.m.stats().plays).toBe(before + 2);
  });

  it('초당 예산: 발사음을 1 ms마다 요청해도 초당 재생 수는 예산 안', async () => {
    const h = await ready({ playsPerSecond: 20, burst: 8 });
    h.m.resetStats();
    for (let i = 0; i < 3000; i++) {
      h.clock.t += 0.001;
      h.m.play(i % 2 ? 'fire_fish' : 'hit_toy');
    }
    const st = h.m.stats();
    expect(st.peakPlaysPerSecond).toBeLessThanOrEqual(20 + 8);
    expect(st.peakVoices).toBeLessThanOrEqual(24);
    expect(st.scheduler.rejected.budget).toBeGreaterThan(0);
  });
});

describe('AudioManager — 실제 sfx.json·우선순위 데이터', () => {
  it('아이템 드롭 소리는 빠른 전투에서 콤보·동전·처치음이 예산을 다 써도 들린다', async () => {
    const ids: SfxId[] = ['combo', 'coin', 'kill_pop', 'hit_toy', 'fire_hairball', 'item_drop'];
    const files: Files = { 'manifest.json': JSON.stringify(Object.fromEntries(ids.map((id) => [id, [`${id}_1.mp3`]]))) };
    for (const id of ids) files[`${id}_1.mp3`] = encodeClip(2);
    const h = manager(files, { defs: SFX_DEFS });
    h.m.install();
    await h.m.load();
    unlock(h);
    await Promise.resolve();
    // 3배속 전투 흉내: 처치·콤보·동전·타격·발사가 쏟아져 예산(초당 18, 최대 8)이 바닥난다
    for (let i = 0; i < 400; i++) {
      h.clock.t += 0.01;
      h.m.play(ids[i % 5]);
    }
    expect(h.m.stats().scheduler.rejected.budget).toBeGreaterThan(0);
    const before = h.m.stats().playsById.item_drop ?? 0;
    h.m.play('item_drop');
    expect(h.m.stats().playsById.item_drop ?? 0).toBe(before + 1);
  });
});
