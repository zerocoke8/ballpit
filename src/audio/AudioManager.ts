// 효과음 엔진 (Web Audio API, 외부 라이브러리 없음). 계약은 docs/ARCHITECTURE.md의 'audio/'.
//
// - 클립 목록: public/sfx/manifest.json ({ id: [파일, ...] }). 없거나 비었거나 깨졌으면 조용히 아무 소리도 내지 않는다.
// - 로드: 부팅 뒤 백그라운드에서 fetch + decodeAudioData (OfflineAudioContext로 — 사용자 제스처 전에도 됨, 한 클립씩 쉬어 가며).
//   디코드 때 모노로 섞고(메모리 절반) 앞뒤 무음을 자르고 피크를 -3 dBFS로 맞춘 뒤(빽빽한 소리는 단기 음량 -12 dBFS까지 더 줄임)
//   id별 볼륨을 곱해 둔다 (process.ts).
// - 재생 컨텍스트(AudioContext)는 첫 사용자 제스처(pointerup/pointerdown(마우스)/touchend/keydown)에서 만들고 resume.
//   제스처 이벤트 안에서 온 재생 요청도 잠금을 푼다(PixiJS 버튼 소리가 우리 리스너보다 먼저 온다 — 첫 탭 소리).
//   iOS의 'interrupted'(전화·앱 전환) 뒤에도 제스처마다 다시 resume (끝나지 않은 resume이 있어도).
//   탭이 숨으면 재생 중인 소리를 끊고 suspend, 다시 보이면 resume.
// - play(id): 판정은 VoiceScheduler(scheduler.ts) — id별 최소 간격·동시 재생 상한, 초당 예산, 전역 상한(우선순위),
//   변형 무작위(연속 회피), 음높이 무작위. 재생 한 번에 Web Audio 노드(소스 + 게인 [+ 패너]) 말고는 할당하지 않는다.
// - 마스터 볼륨: settings(muted, sfxVolume)를 따르고 onSettingsChange로 바로 반영. 마스터 뒤에 리미터(컴프레서).
import { CATEGORY_PRIORITY, CATEGORY_RESERVE, SFX_DEFS, SFX_OVERRIDES, type SfxCategory, type SfxDef, type SfxId } from '../data/sfxMap';
import { perfMark, perfNow } from '../debug/perfOverlay';
import { downmix, processMono } from './process';
import { VoiceScheduler, type SchedulerStats } from './scheduler';

export interface PlayOptions {
  /** 0..1 추가 볼륨 (기본 1) */
  volume?: number;
  /** 재생 속도 배수 (기본 1, 음높이도 같이 바뀜) */
  rate?: number;
  /** 좌우 -1..1 (기본 0) */
  pan?: number;
}

/** 브라우저 의존 부분 (테스트에서 가짜로 바꾼다) */
export interface AudioEnv {
  /** 재생용 AudioContext 만들기 (실패하면 null) */
  createContext(): AudioContext | null;
  /** 디코드 전용 컨텍스트 (사용자 제스처 없이도 되는 OfflineAudioContext). 없으면 재생 컨텍스트로 디코드 */
  createDecoder(sampleRate: number): BaseAudioContext | null;
  fetch(url: string): Promise<Response>;
  /** 초 단위 단조 시계 */
  now(): number;
  /** fn을 ms 뒤에 (백그라운드 로딩을 쉬어 가며) */
  schedule(fn: () => void, ms: number): void;
  /** 사용자 활성화가 지금 유효한가 (모르면 true) — 제스처가 아닌 이벤트에서 컨텍스트를 만들어 경고가 뜨지 않게 */
  userActivationActive(): boolean;
  /**
   * 지금 처리 중인 DOM 이벤트 (브라우저의 window.event, 없으면 undefined). 재생 요청이 제스처 이벤트 안에서 왔는지 알려고 —
   * PixiJS가 window 캡처 pointerup을 우리보다 먼저 등록해서 첫 탭의 버튼 소리가 잠금 해제 리스너보다 먼저 온다.
   */
  currentEvent?(): Event | undefined;
  /** 리스너 대상 (없으면 자동 잠금 해제·가시성 처리 없음) */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  document: (Pick<Document, 'addEventListener' | 'removeEventListener'> & { readonly hidden: boolean }) | null;
}

export interface AudioManagerOptions {
  /** manifest.json과 클립 파일이 있는 폴더 URL (끝에 /) */
  baseUrl: string;
  env: AudioEnv;
  defs?: readonly SfxDef[];
  /** 전역 동시 재생 상한 */
  maxVoices?: number;
  /** 초당 재생 예산 (토큰/초, 최대 저장량) */
  playsPerSecond?: number;
  burst?: number;
  /** 부팅 후 로드 시작까지(ms) / 클립 사이 쉬는 시간(ms) / 동시 fetch 수 */
  loadDelayMs?: number;
  loadGapMs?: number;
  fetchConcurrency?: number;
  /** 디코드 표본율 (폰 하드웨어 대부분이 48k — 재생 때 리샘플링이 없게) */
  decodeSampleRate?: number;
  random?: () => number;
}

export interface ClipInfo {
  id: string;
  file: string;
  variant: number;
  /** 다듬은 뒤 길이(초) */
  duration: number;
  trimmedLead: number;
  trimmedTail: number;
  sourcePeakDb: number;
  peakDb: number;
  /** 단기 음량(50 ms RMS 최대, 볼륨 포함) dBFS */
  loudnessDb: number;
  silent: boolean;
}

export interface AudioDebugStats {
  state: string;
  unlocked: boolean;
  muted: boolean;
  masterGain: number;
  manifest: 'pending' | 'missing' | 'empty' | 'ok';
  clipsListed: number;
  clipsDecoded: number;
  clipsFailed: number;
  /** 디코드는 됐지만 소리가 없는 클립 (등록하지 않음 — 그 id의 다른 변형만 쓴다) */
  clipsSilent: number;
  loading: boolean;
  plays: number;
  playsById: Record<string, number>;
  /** 최근 1초 재생 수 / 지금까지 1초 창 최대 */
  playsLastSecond: number;
  peakPlaysPerSecond: number;
  activeVoices: number;
  peakVoices: number;
  scheduler: SchedulerStats;
  unknownIds: number;
}

/** 볼륨 슬라이더 값(0..1) → 게인. 귀는 로그로 듣기 때문에 제곱 곡선 */
export function volumeCurve(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return c * c;
}

const DEFAULT_MAX_VOICES = 24;
/** 초당 재생 예산 (UI·징글·중요한 소리는 예산과 무관) — 무거운 전투에서도 초당 약 25번 안 */
const DEFAULT_PLAYS_PER_SECOND = 18;
const DEFAULT_BURST = 8;
const MAX_VARIANTS = 8;
const STEAL_FADE_SEC = 0.012;
/**
 * 제스처 안에서 resume을 부른 뒤 이 시간(초) 동안은 컨텍스트가 아직 'running'이 아니어도 재생을 예약한다 (첫 탭 소리 —
 * 안드로이드는 오디오 장치가 켜질 때까지 수십~수백 ms). 그 뒤에도 안 풀렸으면(iOS 'interrupted' 등) 쌓지 않고 버린다
 * — 멈춘 컨텍스트에 예약된 소리는 풀리는 순간 한꺼번에 터진다.
 */
const RESUME_GRACE_SEC = 0.3;
/** 로드 순서: 메뉴에서 먼저 쓰는 것부터 */
const LOAD_ORDER: readonly SfxCategory[] = ['ui', 'jingle', 'reward', 'hit', 'fire', 'enemy'];
/** 재생 수 측정 창 (최근 재생 시각 링 버퍼) */
const RATE_RING = 128;

interface Clip {
  def: number;
  variant: number;
  file: string;
}

export class AudioManager {
  readonly defs: readonly SfxDef[];
  private readonly env: AudioEnv;
  private readonly opts: Required<Omit<AudioManagerOptions, 'env' | 'defs' | 'random'>>;
  private readonly index = new Map<string, number>();
  private readonly sched: VoiceScheduler;
  /** def → 변형 → 버퍼 */
  private readonly buffers: (AudioBuffer | null)[][];
  private readonly clipInfo: ClipInfo[] = [];

  private ctx: AudioContext | null = null;
  private decoder: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private contextFailed = false;
  /** 제스처 안에서 마지막으로 resume을 부른 시각 (env.now, RESUME_GRACE_SEC 참고) */
  private gestureResumeAt = -Infinity;
  private unlocked = false;
  private installed = false;
  private hiddenSuspended = false;
  private masterGain = 1;

  // 칸별 재생 중인 노드 (스케줄러 칸과 같은 번호)
  private readonly slotSrc: (AudioBufferSourceNode | null)[];
  private readonly slotGain: (GainNode | null)[];
  private readonly slotPan: (StereoPannerNode | null)[];

  // 로딩
  private manifestState: AudioDebugStats['manifest'] = 'pending';
  private clipsListed = 0;
  private clipsDecoded = 0;
  private clipsFailed = 0;
  private clipsSilent = 0;
  private loadingPromise: Promise<void> | null = null;
  private loading = false;
  private disposed = false;

  // 통계
  private plays = 0;
  private unknownIds = 0;
  private readonly playsByDef: Int32Array;
  private readonly recent = new Float64Array(RATE_RING).fill(-Infinity);
  private recentHead = 0;
  private peakRate = 0;
  private peakVoices = 0;

  constructor(options: AudioManagerOptions) {
    this.env = options.env;
    this.defs = options.defs ?? SFX_DEFS;
    this.opts = {
      baseUrl: options.baseUrl,
      maxVoices: options.maxVoices ?? DEFAULT_MAX_VOICES,
      playsPerSecond: options.playsPerSecond ?? DEFAULT_PLAYS_PER_SECOND,
      burst: options.burst ?? DEFAULT_BURST,
      loadDelayMs: options.loadDelayMs ?? 700,
      loadGapMs: options.loadGapMs ?? 12,
      fetchConcurrency: options.fetchConcurrency ?? 3,
      decodeSampleRate: options.decodeSampleRate ?? 48000,
    };
    this.defs.forEach((d, i) => this.index.set(d.id, i));
    this.sched = new VoiceScheduler(
      this.defs.map((d) => {
        const o = SFX_OVERRIDES[d.id];
        return {
          maxVoices: d.maxVoices,
          minInterval: d.minInterval,
          pitchVar: d.pitchVar,
          priority: o?.priority ?? CATEGORY_PRIORITY[d.category] ?? 0,
          // null(예산과 무관)을 0으로 바꾸지 않게 ?? 를 쓰지 않는다
          reserve: o && o.reserve !== undefined ? o.reserve : d.category in CATEGORY_RESERVE ? CATEGORY_RESERVE[d.category] : 0,
        };
      }),
      { maxVoices: this.opts.maxVoices, rate: this.opts.playsPerSecond, burst: this.opts.burst, random: options.random ?? Math.random },
      MAX_VARIANTS,
    );
    this.buffers = this.defs.map(() => []);
    this.playsByDef = new Int32Array(this.defs.length);
    const cap = this.sched.maxVoices;
    this.slotSrc = new Array<AudioBufferSourceNode | null>(cap).fill(null);
    this.slotGain = new Array<GainNode | null>(cap).fill(null);
    this.slotPan = new Array<StereoPannerNode | null>(cap).fill(null);
  }

  // ── 수명 ─────────────────────────────────────────────────

  /** 제스처 잠금 해제·가시성 리스너 등록 + 백그라운드 로드 예약. 여러 번 불러도 한 번 */
  install(): void {
    if (this.installed || this.disposed) return;
    this.installed = true;
    const w = this.env.window;
    if (w) {
      for (const type of GESTURES) w.addEventListener(type, this.onGesture, { capture: true, passive: true });
    }
    this.env.document?.addEventListener('visibilitychange', this.onVisibility);
    this.env.schedule(() => void this.load(), this.opts.loadDelayMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const w = this.env.window;
    if (w) for (const type of GESTURES) w.removeEventListener(type, this.onGesture, { capture: true });
    this.env.document?.removeEventListener('visibilitychange', this.onVisibility);
    for (let i = 0; i < this.slotSrc.length; i++) this.releaseSlot(i, false);
    void this.ctx?.close?.().catch(() => undefined);
    this.ctx = null;
  }

  /** 음소거 / 볼륨(0..1). settings 연결은 audio/index.ts가 한다 */
  setVolume(muted: boolean, volume: number): void {
    const g = muted ? 0 : volumeCurve(volume);
    this.masterGain = g;
    this.sched.muted = g <= 0;
    const m = this.master;
    const ctx = this.ctx;
    if (m && ctx) {
      // 부드럽게 (딸깍 방지)
      try {
        m.gain.cancelScheduledValues(ctx.currentTime);
        m.gain.setTargetAtTime(g, ctx.currentTime, 0.015);
      } catch {
        m.gain.value = g;
      }
    }
  }

  // ── 로드 ─────────────────────────────────────────────────

  /** manifest를 읽고 모든 클립을 디코드 (한 번만). 실패는 조용히 — 소리가 없을 뿐 게임은 그대로 */
  load(): Promise<void> {
    this.loadingPromise ??= this.doLoad();
    return this.loadingPromise;
  }

  private async doLoad(): Promise<void> {
    if (this.disposed) return;
    this.loading = true;
    try {
      const manifest = await this.fetchManifest();
      const clips: Clip[] = [];
      for (const cat of LOAD_ORDER) {
        this.defs.forEach((d, def) => {
          if (d.category !== cat) return;
          const files = manifest[d.id];
          if (!Array.isArray(files)) return;
          files.slice(0, MAX_VARIANTS).forEach((file, variant) => {
            if (typeof file === 'string' && file.length > 0) clips.push({ def, variant, file });
          });
        });
      }
      this.clipsListed = clips.length;
      if (this.manifestState === 'ok' && clips.length === 0) this.manifestState = 'empty';
      if (clips.length === 0) return;

      // fetch는 몇 개씩 앞서 받아 두고, 디코드·다듬기는 하나씩 쉬어 가며 (메인 스레드를 오래 잡지 않게)
      const pending: Promise<ArrayBuffer | null>[] = [];
      let next = 0;
      const pump = (): void => {
        while (next < clips.length && pending.length < this.opts.fetchConcurrency) pending.push(this.fetchClip(clips[next++].file));
      };
      pump();
      for (let i = 0; i < clips.length; i++) {
        const bytes = await pending.shift()!;
        pump();
        if (this.disposed) return;
        if (bytes) await this.decodeClip(clips[i], bytes);
        else this.clipsFailed++;
        await this.pause(this.opts.loadGapMs);
      }
    } finally {
      this.loading = false;
    }
  }

  private async fetchManifest(): Promise<Record<string, unknown>> {
    try {
      const res = await this.env.fetch(`${this.opts.baseUrl}manifest.json`);
      if (!res.ok) {
        this.manifestState = 'missing';
        return {};
      }
      const text = await res.text();
      // 개발 서버는 없는 파일에 index.html을 200으로 준다 → JSON이 아니면 없는 것으로
      const json: unknown = JSON.parse(text);
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        this.manifestState = 'missing';
        return {};
      }
      this.manifestState = Object.keys(json).length === 0 ? 'empty' : 'ok';
      return json as Record<string, unknown>;
    } catch {
      this.manifestState = 'missing';
      return {};
    }
  }

  private async fetchClip(file: string): Promise<ArrayBuffer | null> {
    try {
      const res = await this.env.fetch(`${this.opts.baseUrl}${file}`);
      if (!res.ok) return null;
      return await res.arrayBuffer();
    } catch {
      return null;
    }
  }

  private async decodeClip(clip: Clip, bytes: ArrayBuffer): Promise<void> {
    const decoder = this.ensureDecoder();
    if (!decoder) {
      this.clipsFailed++;
      return;
    }
    const d = this.defs[clip.def];
    try {
      const decoded = await decodeAudio(decoder, bytes);
      // 여기부터는 메인 스레드에서 한 번에 (모노 섞기·다듬기·버퍼 복사) — 성능 오버레이(?perf) 태그 'sfxDecode'
      const t0 = perfNow();
      const channels: Float32Array[] = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
      const sr = decoded.sampleRate;
      const mono = channels.length === 1 ? channels[0] : downmix(channels);
      const res = processMono(mono, { sampleRate: sr, volume: d.volume });
      if (res.silent) {
        // 생성 결과가 무음인 경우가 있다 (실제로 한 번) — 고르면 아무 소리도 안 나므로 등록하지 않는다
        this.clipsSilent++;
        perfMark('sfxDecode', t0);
        console.warn(`[audio] ${clip.file}: 소리가 없는 클립 — 건너뜀 (node tools/gen-sfx.mjs --only ${d.id} --force 로 다시 생성)`);
        return;
      }
      const out = decoder.createBuffer(1, res.data.length, sr);
      out.getChannelData(0).set(res.data);
      this.buffers[clip.def][clip.variant] = out;
      this.sched.setLoaded(clip.def, clip.variant, out.duration);
      this.clipsDecoded++;
      perfMark('sfxDecode', t0);
      this.clipInfo.push({
        id: d.id,
        file: clip.file,
        variant: clip.variant,
        duration: out.duration,
        trimmedLead: res.trimmedLead,
        trimmedTail: res.trimmedTail,
        sourcePeakDb: res.sourcePeakDb,
        peakDb: res.peakDb,
        loudnessDb: res.loudnessDb,
        silent: res.silent,
      });
    } catch (err) {
      this.clipsFailed++;
      console.warn(`[audio] ${clip.file} 디코드 실패 — 이 소리는 나지 않음`, err);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => this.env.schedule(resolve, ms));
  }

  private ensureDecoder(): BaseAudioContext | null {
    if (this.decoder) return this.decoder;
    this.decoder = this.env.createDecoder(this.opts.decodeSampleRate) ?? this.ensureContext();
    return this.decoder;
  }

  // ── 컨텍스트 / 잠금 해제 ─────────────────────────────────

  private ensureContext(): AudioContext | null {
    if (this.ctx || this.contextFailed || this.disposed) return this.ctx;
    const ctx = this.env.createContext();
    if (!ctx) {
      this.contextFailed = true;
      return null;
    }
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    // 여러 소리가 겹쳐도 찢어지지 않게 (거의 리미터)
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    limiter.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.masterGain;
    master.connect(limiter);
    this.master = master;
    return ctx;
  }

  /** 제스처 안에서: 컨텍스트 만들기 + resume (+ iOS용 무음 한 표본) */
  private readonly onGesture = (e: Event): void => {
    if (this.disposed) return;
    if (this.ctx?.state === 'running' && !this.hiddenSuspended) return;
    // 터치의 pointerdown은 사용자 활성화가 아니다 — 그때 만들면 'not allowed to start' 경고. pointerup/touchend를 기다린다
    if (e.type === 'pointerdown' && (e as PointerEvent).pointerType !== 'mouse') return;
    if (!this.env.userActivationActive()) return;
    if (this.env.document?.hidden) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.hiddenSuspended = false;
    if (ctx.state !== 'running') {
      // 제스처마다 다시 부른다 — 앞의 resume이 끝나지 않았어도 (아래 resume 참고)
      this.gestureResumeAt = this.env.now();
      this.resume(ctx);
    }
    if (!this.unlocked) {
      this.unlocked = true;
      // iOS(옛 사파리)는 제스처 안에서 실제로 무언가를 재생해야 풀린다
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        // 무시
      }
    }
  };

  /**
   * resume 요청. 진행 중인 resume이 있어도 막지 않는다 — WebKit은 시작할 수 없는 동안(제스처 밖, 전화·앱 전환의 'interrupted')
   * resume()의 프로미스를 끝내지 않고 붙잡아 두기 때문에, '진행 중이면 건너뛰기'로 막으면 그 뒤 제스처의 resume이 영영 불리지 않는다.
   */
  private resume(ctx: AudioContext): void {
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      // 닫힌 컨텍스트 등
    }
  }

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.env.document?.hidden) {
      // 재생 중이던 소리는 끊는다 — 그대로 두면 suspend된 채 남았다가 몇 분 뒤 돌아왔을 때 이어서 나고,
      // 스케줄러는 끝난 줄 알고 그 칸을 다시 쓰면서 소리를 뚝 끊는다(딸깍)
      this.stopAll();
      this.hiddenSuspended = true;
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    } else if (this.hiddenSuspended || ctx.state !== 'running') {
      this.hiddenSuspended = false;
      // 제스처 없이도 되는 브라우저가 대부분 (iOS는 안 되면 다음 탭의 onGesture가 다시 한다)
      if (this.unlocked) this.resume(ctx);
    }
  };

  // ── 재생 ─────────────────────────────────────────────────

  /** 효과음 재생. 모르는 id·아직 디코드 전·음소거·제한에 걸림 → 아무것도 안 함 */
  play(id: SfxId, opts?: PlayOptions): void {
    if (opts) this.playAt(id, opts.pan ?? 0, opts.rate ?? 1, opts.volume ?? 1);
    else this.playAt(id, 0, 1, 1);
  }

  /** play와 같지만 옵션 객체 없이 (전투처럼 자주 부르는 곳) */
  playAt(id: SfxId, pan = 0, rate = 1, volume = 1): void {
    const def = this.index.get(id);
    if (def === undefined) {
      this.unknownIds++;
      return;
    }
    // 첫 탭: PixiJS의 pointerup(→ 버튼 소리)이 우리 잠금 해제 리스너보다 먼저 온다 → 제스처 이벤트 안이면 여기서 잠금 해제
    if (!this.ctx && this.installed) {
      const ev = this.env.currentEvent?.();
      if (ev && ev.isTrusted !== false && (GESTURES as readonly string[]).includes(ev.type)) this.onGesture(ev);
    }
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.hiddenSuspended || volume <= 0) return;
    const now = this.env.now();
    // 잠금 해제 전·숨김 중·'interrupted'엔 쌓아 두지 않는다 (풀리는 순간 한꺼번에 터지지 않게). 방금 제스처로 resume을 불렀으면 잠깐 허용
    if (ctx.state !== 'running' && now - this.gestureResumeAt > RESUME_GRACE_SEC) return;
    const slot = this.sched.request(def, now, rate);
    if (slot < 0) return;
    const buffer = this.buffers[def][this.sched.variant];
    if (!buffer) {
      this.sched.release(slot);
      return;
    }
    this.releaseSlot(slot, this.sched.stolen);

    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.sched.rate;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, volume);
    src.connect(g);
    let p: StereoPannerNode | null = null;
    const pv = pan > 1 ? 1 : pan < -1 ? -1 : pan;
    if (pv !== 0 && typeof ctx.createStereoPanner === 'function') {
      p = ctx.createStereoPanner();
      p.pan.value = pv;
      g.connect(p);
      p.connect(master);
    } else {
      g.connect(master);
    }
    src.start(t);
    this.slotSrc[slot] = src;
    this.slotGain[slot] = g;
    this.slotPan[slot] = p;

    // 통계 (할당 없음)
    this.plays++;
    this.playsByDef[def]++;
    this.recent[this.recentHead] = now;
    this.recentHead = (this.recentHead + 1) % RATE_RING;
    const rate1s = this.countRecent(now);
    if (rate1s > this.peakRate) this.peakRate = rate1s;
    const active = this.sched.activeVoices(now);
    if (active > this.peakVoices) this.peakVoices = active;
  }

  /** 그 id를 마지막으로 재생하고 지난 시간(초). 재생한 적 없으면 Infinity */
  sinceLastPlay(id: SfxId): number {
    const def = this.index.get(id);
    if (def === undefined) return Infinity;
    return this.env.now() - this.sched.lastPlayed(def);
  }

  /** 디코드가 끝난 id인가 */
  isLoaded(id: SfxId): boolean {
    const def = this.index.get(id);
    return def !== undefined && this.sched.loadedVariants(def) > 0;
  }

  /** 재생 중인 소리를 모두 멈추고 칸을 비운다 (탭이 숨을 때) */
  private stopAll(): void {
    for (let i = 0; i < this.slotSrc.length; i++) {
      try {
        this.slotSrc[i]?.stop();
      } catch {
        // 이미 멈춘 노드
      }
      this.releaseSlot(i, false);
    }
    this.sched.clear();
  }

  /** 칸의 이전 노드 정리: 아직 재생 중이면(뺏김) 짧게 줄이며 멈춤, 끝났으면 연결만 끊는다 */
  private releaseSlot(slot: number, playing: boolean): void {
    const src = this.slotSrc[slot];
    const g = this.slotGain[slot];
    const p = this.slotPan[slot];
    this.slotSrc[slot] = null;
    this.slotGain[slot] = null;
    this.slotPan[slot] = null;
    if (!src) return;
    const ctx = this.ctx;
    try {
      if (playing && ctx && g) {
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + STEAL_FADE_SEC);
        src.stop(t + STEAL_FADE_SEC + 0.005);
      } else {
        src.disconnect();
        g?.disconnect();
        p?.disconnect();
      }
    } catch {
      // 이미 멈춘 노드
    }
  }

  private countRecent(now: number): number {
    let n = 0;
    for (let i = 0; i < RATE_RING; i++) if (now - this.recent[i] < 1) n++;
    return n;
  }

  // ── 디버그 ───────────────────────────────────────────────

  stats(): AudioDebugStats {
    const now = this.env.now();
    const byId: Record<string, number> = {};
    this.defs.forEach((d, i) => {
      if (this.playsByDef[i] > 0) byId[d.id] = this.playsByDef[i];
    });
    const s = this.sched.stats;
    return {
      state: this.ctx?.state ?? 'none',
      unlocked: this.unlocked,
      muted: this.sched.muted,
      masterGain: this.masterGain,
      manifest: this.manifestState,
      clipsListed: this.clipsListed,
      clipsDecoded: this.clipsDecoded,
      clipsFailed: this.clipsFailed,
      clipsSilent: this.clipsSilent,
      loading: this.loading,
      plays: this.plays,
      playsById: byId,
      playsLastSecond: this.countRecent(now),
      peakPlaysPerSecond: this.peakRate,
      activeVoices: this.sched.activeVoices(now),
      peakVoices: this.peakVoices,
      scheduler: { granted: s.granted, stolen: s.stolen, rejected: { ...s.rejected } },
      unknownIds: this.unknownIds,
    };
  }

  /** 디코드한 클립들의 길이·잘라낸 무음·피크 (측정용) */
  clips(): ClipInfo[] {
    return this.clipInfo.map((c) => ({ ...c }));
  }

  /** 측정 구간을 새로 시작 (재생 수·최대치만, 판정 상태는 그대로) */
  resetStats(): void {
    this.plays = 0;
    this.playsByDef.fill(0);
    this.recent.fill(-Infinity);
    this.peakRate = 0;
    this.peakVoices = 0;
    const s = this.sched.stats;
    s.granted = 0;
    s.stolen = 0;
    for (const k of Object.keys(s.rejected) as (keyof typeof s.rejected)[]) s.rejected[k] = 0;
    this.unknownIds = 0;
  }
}

const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;


/** decodeAudioData (프로미스 / 옛 사파리 콜백 둘 다) */
function decodeAudio(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}
