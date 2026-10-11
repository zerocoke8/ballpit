// 텍스트 스타일 프리셋. 제목/숫자/버튼은 진한 외곽선으로 캐주얼하게.
import type { TextStyleOptions } from 'pixi.js';
import { UI_COLORS } from '../config';
import { FONT_FAMILY } from '../core/fonts';

export type TextKind = 'title' | 'heading' | 'body' | 'small' | 'number' | 'button';

/** 숫자·제목 외곽선 색 (배경보다 살짝 진한 보라) */
export const OUTLINE_COLOR = 0x241433;

const PRESETS: Record<TextKind, () => TextStyleOptions> = {
  title: () => ({
    fontSize: 72,
    fill: UI_COLORS.text,
    stroke: { color: OUTLINE_COLOR, width: 10, join: 'round' },
    dropShadow: { color: OUTLINE_COLOR, alpha: 0.7, blur: 0, distance: 6, angle: Math.PI / 2 },
    align: 'center',
    letterSpacing: 2,
  }),
  heading: () => ({
    fontSize: 44,
    fill: UI_COLORS.text,
    stroke: { color: OUTLINE_COLOR, width: 7, join: 'round' },
    align: 'center',
  }),
  body: () => ({
    fontSize: 28,
    fill: UI_COLORS.text,
    lineHeight: 38,
  }),
  small: () => ({
    fontSize: 22,
    fill: UI_COLORS.textDim,
    lineHeight: 30,
  }),
  number: () => ({
    fontSize: 34,
    fill: UI_COLORS.text,
    stroke: { color: OUTLINE_COLOR, width: 6, join: 'round' },
  }),
  button: () => ({
    fontSize: 34,
    fill: UI_COLORS.text,
    stroke: { color: OUTLINE_COLOR, width: 5, join: 'round' },
    align: 'center',
  }),
};

/** 프리셋 + 덮어쓰기. stroke/dropShadow 같은 중첩 값은 통째로 교체된다 */
export function textStyle(kind: TextKind, overrides?: Partial<TextStyleOptions>): TextStyleOptions {
  return { fontFamily: FONT_FAMILY, ...PRESETS[kind](), ...overrides };
}
