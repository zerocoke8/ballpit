// 플레이어 이동 모델 (순수 함수, 할당 없음). sim이 매 스텝 부르고, 밸런스 프로브의 이상적인 회피가 같은 함수로 앞날을 예측한다.
//
// 목표 위치(드래그한 손가락이 가리키는 자리)를 향해 '걷는다': 가속도 = maxSpeed / PLAYER_ACCEL_TIME로 최고 속도(maxSpeed)까지
// 붙고, 목표 앞에서는 브레이크(√(2 × 가속도 × PLAYER_ARRIVE_BRAKE × 남은 거리))로 감속해 지나치지 않고 멈춘다.
// 목표가 없으면 같은 가속도로 감속해 선다. 목표가 옆·뒤로 바뀌면 관성대로 살짝 미끄러지며 돌아선다.

import {
  PLAYER_ACCEL_TIME,
  PLAYER_ARRIVE_BRAKE,
  PLAYER_MAX_X,
  PLAYER_MAX_Y,
  PLAYER_MIN_X,
  PLAYER_MIN_Y,
} from '../../config';

/** 위치 + 속도 (PlayerEntity가 그대로 맞는다) */
export interface Mover {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 이동 범위로 clamp (목표 위치도 이것으로 자른다) */
export function clampPlayerX(x: number): number {
  return x < PLAYER_MIN_X ? PLAYER_MIN_X : x > PLAYER_MAX_X ? PLAYER_MAX_X : x;
}

export function clampPlayerY(y: number): number {
  return y < PLAYER_MIN_Y ? PLAYER_MIN_Y : y > PLAYER_MAX_Y ? PLAYER_MAX_Y : y;
}

/**
 * 한 스텝 이동. hasTarget이면 (tx, ty)(이동 범위로 clamp)를 향해, 아니면 멈추는 쪽으로 m의 속도·위치를 갱신한다.
 * - 원하는 속도 = 목표 방향 × min(maxSpeed, √(2·a·BRAKE·d), d / dt) — 마지막 항은 이번 스텝에 목표를 넘지 않게
 * - 실제 속도는 원하는 속도 쪽으로 스텝당 a·dt까지만 바뀐다 (가속·감속·방향 전환 모두)
 * - 이번 스텝 이동이 목표를 지나는(목표까지의 방향과 반대가 되는) 순간 목표에 딱 서고 속도 0 — 떨림 없음
 * - 이동 범위 밖으로 나가려 하면 벽에 붙이고 그 축의 속도를 없앤다
 * maxSpeed ≤ 0(또는 NaN)이면 그 자리에 선다.
 */
export function stepPlayerMotion(m: Mover, tx: number, ty: number, hasTarget: boolean, maxSpeed: number, dt: number): void {
  const speed = maxSpeed > 0 ? maxSpeed : 0;
  if (speed === 0 || !(dt > 0)) {
    m.vx = 0;
    m.vy = 0;
    return;
  }
  const accel = speed / PLAYER_ACCEL_TIME;
  let wantVx = 0;
  let wantVy = 0;
  let dx = 0;
  let dy = 0;
  let dist = 0;
  if (hasTarget) {
    dx = clampPlayerX(tx) - m.x;
    dy = clampPlayerY(ty) - m.y;
    dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1e-9) {
      let want = Math.sqrt(2 * accel * PLAYER_ARRIVE_BRAKE * dist);
      if (want > speed) want = speed;
      if (want > dist / dt) want = dist / dt;
      wantVx = (dx / dist) * want;
      wantVy = (dy / dist) * want;
    }
  }
  // 원하는 속도 쪽으로 스텝당 accel × dt까지
  const ex = wantVx - m.vx;
  const ey = wantVy - m.vy;
  const e = Math.sqrt(ex * ex + ey * ey);
  const lim = accel * dt;
  if (e <= lim) {
    m.vx = wantVx;
    m.vy = wantVy;
  } else {
    m.vx += (ex / e) * lim;
    m.vy += (ey / e) * lim;
  }
  const nx = m.x + m.vx * dt;
  const ny = m.y + m.vy * dt;
  if (dist > 1e-9) {
    // 목표를 지나는 스텝(목표를 지나는 평면을 넘음 — 한 스텝 이동 ≤ maxSpeed·dt라 목표 바로 앞에서만 생긴다):
    // 목표에 서고 멈춘다 (관성으로 넘었다가 되돌아오는 떨림 방지)
    const rx = m.x + dx - nx;
    const ry = m.y + dy - ny;
    if (rx * dx + ry * dy <= 0) {
      m.x += dx;
      m.y += dy;
      m.vx = 0;
      m.vy = 0;
      return;
    }
  }
  m.x = nx;
  m.y = ny;
  if (m.x < PLAYER_MIN_X) {
    m.x = PLAYER_MIN_X;
    if (m.vx < 0) m.vx = 0;
  } else if (m.x > PLAYER_MAX_X) {
    m.x = PLAYER_MAX_X;
    if (m.vx > 0) m.vx = 0;
  }
  if (m.y < PLAYER_MIN_Y) {
    m.y = PLAYER_MIN_Y;
    if (m.vy < 0) m.vy = 0;
  } else if (m.y > PLAYER_MAX_Y) {
    m.y = PLAYER_MAX_Y;
    if (m.vy > 0) m.vy = 0;
  }
}
