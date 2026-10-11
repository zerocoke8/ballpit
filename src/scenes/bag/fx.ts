// 가방/상점 공용 연출: 반짝이 폭발, 흔들기, 포물선 비행. 연출용 변화는 별도 Rng (시뮬레이션과 무관).
import { Container, Graphics } from 'pixi.js';
import { delay, killTweensOf, tween } from '../../core/tween';
import { Rng, randomSeed } from '../../logic/rng';
import { sparkle } from './itemSprite';

const fxRng = new Rng(randomSeed());

/** 큰 영역 반짝이도 별 하나는 이 크기까지만 */
const MAX_STAR_R = 26;
const BURST_COLORS = [0xffe14a, 0xffffff, 0xff8af0, 0x7cf5ff];

/** 중심에서 사방으로 튀는 반짝이 + 퍼지는 고리 */
export function sparkleBurst(parent: Container, x: number, y: number, size: number, count = 14, colors = BURST_COLORS): void {
  const ring = new Graphics().circle(0, 0, size * 0.5).stroke({ width: 6, color: 0xffffff, alpha: 0.9 });
  ring.position.set(x, y);
  ring.scale.set(0.3);
  parent.addChild(ring);
  void Promise.all([tween(ring.scale, { x: 2.2, y: 2.2 }, 0.45, 'outQuad'), tween(ring, { alpha: 0 }, 0.45, 'inQuad')]).then(() => {
    if (!ring.destroyed) ring.destroy();
  });

  for (let i = 0; i < count; i++) {
    const g = new Graphics();
    sparkle(g, 0, 0, Math.min(MAX_STAR_R, size * (0.12 + fxRng.next() * 0.1)), colors[i % colors.length]);
    g.position.set(x, y);
    g.rotation = fxRng.next() * Math.PI;
    parent.addChild(g);
    const ang = (i / count) * Math.PI * 2 + fxRng.next() * 0.4;
    const dist = size * (0.8 + fxRng.next() * 0.7);
    const dur = 0.45 + fxRng.next() * 0.25;
    void Promise.all([
      tween(g, { x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, rotation: g.rotation + 2 }, dur, 'outQuad'),
      delay(dur * 0.4).then(() => tween(g, { alpha: 0 }, dur * 0.6, 'inQuad')),
    ]).then(() => {
      if (!g.destroyed) g.destroy();
    });
  }
}

/** 좌우로 흔들고 baseX로 복귀 */
export async function shake(target: Container, baseX: number, amp = 10): Promise<void> {
  killTweensOf(target);
  target.x = baseX;
  const seq = [amp, -amp * 0.8, amp * 0.6, -amp * 0.4, amp * 0.2, 0];
  for (const dx of seq) {
    if (target.destroyed) return;
    await tween(target, { x: baseX + dx }, 0.045, 'linear');
  }
}

/** 통통 튀는 등장 (scale 기준값 base) */
export function pop(target: Container, from = 1.25, base = 1, duration = 0.35): Promise<void> {
  killTweensOf(target.scale);
  target.scale.set(from * base);
  return tween(target.scale, { x: base, y: base }, duration, 'outBack');
}

/** a → b 포물선 비행 (높이 arc). 비행 중 축소 */
export async function flyArc(
  obj: Container,
  to: { x: number; y: number },
  duration: number,
  arc = 120,
  endScale = 0.6,
): Promise<void> {
  const from = { x: obj.x, y: obj.y };
  const s0 = obj.scale.x;
  const state = { p: 0 };
  obj.onRender = () => {
    const p = state.p;
    obj.x = from.x + (to.x - from.x) * p;
    obj.y = from.y + (to.y - from.y) * p - Math.sin(p * Math.PI) * arc;
    const s = s0 + (endScale - s0) * p;
    obj.scale.set(s);
  };
  await tween(state, { p: 1 }, duration, 'inOutSine');
  if (!obj.destroyed) obj.onRender = null;
}
