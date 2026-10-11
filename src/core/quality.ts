// 그래픽 품질 → 렌더 해상도, 첫 실행 자동 선택 기준. pixi/DOM을 import 하지 않는다 (vitest로 테스트).
import type { Quality } from './settings';

/** 품질별 최대 렌더 해상도 (devicePixelRatio 상한) */
export const QUALITY_MAX_RESOLUTION: Readonly<Record<Quality, number>> = { high: 2, low: 1.25 };

/** high = min(dpr, 2), low = min(dpr, 1.25). dpr이 이상하면 1 */
export function resolutionFor(quality: Quality, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, QUALITY_MAX_RESOLUTION[quality]);
}

export interface DeviceHints {
  hardwareConcurrency?: number;
  /** Chrome 계열만 있음 (GB, 0.25~8로 반올림된 값) */
  deviceMemory?: number;
}

/** 저사양으로 보이는 기기: 코어 4개 이하 또는 메모리 3GB 이하 (모르는 값은 판단에서 뺀다) */
export function looksWeak(hints: DeviceHints): boolean {
  const cores = hints.hardwareConcurrency;
  const mem = hints.deviceMemory;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return true;
  if (typeof mem === 'number' && mem > 0 && mem <= 3) return true;
  return false;
}
