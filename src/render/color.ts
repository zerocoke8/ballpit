// 0xRRGGBB 색 계산 도우미.

/** '#RRGGBB' 또는 'RRGGBB' → 0xRRGGBB (잘못된 값이면 fallback) */
export function parseHex(s: string, fallback = 0xff00ff): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  return m ? parseInt(m[1], 16) : fallback;
}

/** a → b 선형 보간 (t = 0..1) */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const r = Math.round(ar + (((b >> 16) & 0xff) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 0xff) - ag) * t);
  const bl = Math.round(ab + ((b & 0xff) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** 밝기 배수 (f < 1 어둡게) */
export function shade(color: number, f: number): number {
  return f <= 1 ? mixColor(0x000000, color, f) : mixColor(color, 0xffffff, Math.min(1, f - 1));
}

export function lighten(color: number, t: number): number {
  return mixColor(color, 0xffffff, t);
}
