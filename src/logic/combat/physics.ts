// 원-사각형 충돌·반사. 순수 함수 (PixiJS/DOM 금지).

export interface Contact {
  /** 원을 밀어낼 단위 법선 */
  nx: number;
  ny: number;
  /** 침투 깊이 (법선 방향으로 이만큼 밀면 떨어진다) */
  depth: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

/**
 * 원(cx, cy, r)과 사각형(rx, ry, rw, rh)이 겹치면 밀어낼 법선 + 깊이, 아니면 null.
 * 원 중심이 사각형 안(경계 포함)이면 최소 침투 축을 쓴다.
 */
export function circleRectContact(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): Contact | null {
  const right = rx + rw;
  const bottom = ry + rh;
  const qx = cx < rx ? rx : cx > right ? right : cx;
  const qy = cy < ry ? ry : cy > bottom ? bottom : cy;
  const dx = cx - qx;
  const dy = cy - qy;
  const d2 = dx * dx + dy * dy;

  if (d2 > 0) {
    if (d2 >= r * r) return null;
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: r - d };
  }

  // 중심이 안쪽: 가장 얕은 면으로 밀어낸다 (동률이면 위·아래 우선)
  let nx = 0;
  let ny = -1;
  let pen = cy - ry;
  const toBottom = bottom - cy;
  if (toBottom < pen) {
    ny = 1;
    pen = toBottom;
  }
  const toLeft = cx - rx;
  if (toLeft < pen) {
    nx = -1;
    ny = 0;
    pen = toLeft;
  }
  const toRight = right - cx;
  if (toRight < pen) {
    nx = 1;
    ny = 0;
    pen = toRight;
  }
  return { nx, ny, depth: pen + r };
}

/** v·n < 0 (법선 쪽으로 파고드는 중)일 때만 반사, 아니면 그대로 */
export function reflect(vx: number, vy: number, nx: number, ny: number): Velocity {
  const d = vx * nx + vy * ny;
  if (d >= 0) return { vx, vy };
  return { vx: vx - 2 * d * nx, vy: vy - 2 * d * ny };
}

/** 속력 유지, |vy| ≥ ratio × speed 보장. vy 부호 유지(0이면 위쪽 = 음수) */
export function enforceMinVertical(vx: number, vy: number, ratio: number): Velocity {
  const speed = Math.sqrt(vx * vx + vy * vy);
  const minVy = Math.min(1, Math.max(0, ratio)) * speed;
  if (Math.abs(vy) >= minVy) return { vx, vy };
  const nvy = vy > 0 ? minVy : -minVy;
  const nvx = Math.sqrt(Math.max(0, speed * speed - nvy * nvy));
  return { vx: vx < 0 ? -nvx : nvx, vy: nvy };
}

export function circleCircle(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const rr = ar + br;
  return dx * dx + dy * dy < rr * rr;
}
