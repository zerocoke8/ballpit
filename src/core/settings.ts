// 플레이어 설정(효과음, 그래픽 품질). localStorage에 저장하며, 실패해도 기본값으로 동작한다.
import { SETTINGS_KEY } from '../config';

export type Quality = 'high' | 'low';

export interface Settings {
  /** 효과음 끔 */
  muted: boolean;
  /** 효과음 볼륨 0..1 */
  sfxVolume: number;
  /** high = 해상도 min(dpr, 2), low = 해상도 낮춤 + 이펙트 예산 축소 */
  quality: Quality;
}

const DEFAULTS: Settings = { muted: false, sfxVolume: 0.8, quality: 'high' };

export const settings: Settings = load();

type Listener = (s: Readonly<Settings>) => void;
const listeners = new Set<Listener>();

/** 값을 바꾸고 저장한 뒤 구독자에게 알린다 */
export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, sanitize({ ...settings, ...patch }));
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장 실패(사생활 보호 모드 등)는 무시
  }
  for (const cb of listeners) cb(settings);
}

/** 해제 함수 반환 */
export function onSettingsChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function load(): Settings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULTS };
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? sanitize({ ...DEFAULTS, ...JSON.parse(raw) }) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitize(s: Settings): Settings {
  const vol = Number(s.sfxVolume);
  return {
    muted: s.muted === true,
    sfxVolume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : DEFAULTS.sfxVolume,
    quality: s.quality === 'low' ? 'low' : 'high',
  };
}
