// 효과음 진입점: 전역 AudioManager 하나 + settings 연결 + 디버그 훅(window.__sfx).
// 씬 코드는 sfx.play('id') / sfx.playAt('id', pan, rate, volume)만 쓴다. initAudio() 전이나 브라우저가 아니면 아무것도 안 한다.
import { onSettingsChange, settings } from '../core/settings';
import type { SfxId } from '../data/sfxMap';
import { AudioManager, type AudioDebugStats, type AudioEnv, type ClipInfo, type PlayOptions } from './AudioManager';

export { AudioManager, volumeCurve } from './AudioManager';
export type { AudioDebugStats, AudioEnv, ClipInfo, PlayOptions } from './AudioManager';

export interface SfxDebugHandle {
  stats(): AudioDebugStats | null;
  clips(): ClipInfo[];
  resetStats(): void;
  /** 로드가 끝날 때까지 (끝났으면 바로) */
  loaded(): Promise<void>;
  play(id: SfxId, opts?: PlayOptions): void;
}

declare global {
  interface Window {
    __sfx?: SfxDebugHandle;
  }
}

let manager: AudioManager | null = null;

/** 어디서든 부르는 재생 창구 (초기화 전엔 아무것도 안 함) */
export const sfx = {
  play(id: SfxId, opts?: PlayOptions): void {
    manager?.play(id, opts);
  },
  playAt(id: SfxId, pan = 0, rate = 1, volume = 1): void {
    manager?.playAt(id, pan, rate, volume);
  },
  /** 그 소리를 마지막으로 낸 뒤 지난 시간(초) — 같은 소리가 겹치지 않게 (예: 패배 징글) */
  sinceLastPlay(id: SfxId): number {
    return manager ? manager.sinceLastPlay(id) : Infinity;
  },
};

/** 브라우저에서 한 번: 매니저를 만들고 settings를 연결하고 백그라운드 로드를 예약한다 */
export function initAudio(): AudioManager | null {
  if (manager) return manager;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;

  const env: AudioEnv = {
    createContext: () => {
      try {
        return new AC({ latencyHint: 'interactive' });
      } catch {
        try {
          return new AC();
        } catch {
          return null;
        }
      }
    },
    createDecoder: (sampleRate) => {
      // 옛 사파리(14.1 전)는 접두사 판만 있다. 없으면 null → 재생 컨텍스트로 디코드(제스처 전에 만들어져 경고가 뜰 수 있음)
      const OAC: typeof OfflineAudioContext | undefined =
        typeof OfflineAudioContext === 'function'
          ? OfflineAudioContext
          : (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      try {
        return OAC ? new OAC(1, 1, sampleRate) : null;
      } catch {
        return null;
      }
    },
    fetch: (url) => fetch(url),
    now: () => performance.now() / 1000,
    schedule: (fn, ms) => {
      setTimeout(fn, ms);
    },
    userActivationActive: () => {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
      return ua ? ua.isActive : true;
    },
    // 지금 처리 중인 DOM 이벤트 (첫 탭의 버튼 소리가 잠금 해제 리스너보다 먼저 올 때 그 탭으로 잠금 해제)
    currentEvent: () => (window as Window & { event?: Event }).event,
    window,
    document,
  };

  const m = new AudioManager({ baseUrl: `${import.meta.env.BASE_URL}sfx/`, env });
  m.setVolume(settings.muted, settings.sfxVolume);
  onSettingsChange((s) => m.setVolume(s.muted, s.sfxVolume));
  m.install();
  manager = m;

  window.__sfx = {
    stats: () => manager?.stats() ?? null,
    clips: () => manager?.clips() ?? [],
    resetStats: () => manager?.resetStats(),
    loaded: () => manager?.load() ?? Promise.resolve(),
    play: (id, opts) => manager?.play(id, opts),
  };
  return m;
}
