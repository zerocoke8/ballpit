// 조준 가이드 (필드 좌표, 렌더 전용): 발사점에서 조준 방향으로 흐르는 점선 궤적 — 좌·우·상단 벽에서 반사하고
// 처음 닿는 적에서 멈춤 — + 캐릭터 옆 조준 화살표 + 적에 닿는 끝점 표시 + 탭한 자리 고리 펄스.
// 경로는 sim의 traceAim(투사체와 같은 반사 규칙)으로 계산한다. 점은 스프라이트 풀 → 매 프레임 할당 없음.
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { traceAim, type AimTrace } from '../../logic/combat/sim';
import type { EnemyEntity } from '../../types';
import {
  AIM_ARROW_DIST,
  AIM_ARROW_LEN,
  AIM_DOT_ALPHA_FAR,
  AIM_DOT_ALPHA_NEAR,
  AIM_DOT_END_SCALE,
  AIM_DOT_FLOW,
  AIM_DOT_SIZE,
  AIM_DOT_SPACING,
  AIM_DOT_START,
  AIM_GUIDE_LEN,
  AIM_GUIDE_SEGMENTS,
  AIM_OUTLINE,
  AIM_PULSE_SIZE,
  AIM_PULSE_TIME,
  AIM_SNAP_TIME,
} from './visual';

const MAX_DOTS = Math.ceil(AIM_GUIDE_LEN / AIM_DOT_SPACING) + 1;
/** 고리 텍스처(fxTextures.ring)의 실제 지름 */
const RING_PX = 116;
const PULSE_TINT = 0xfff4c2;
const END_RADIUS = 15;

export class AimGuide extends Container {
  private readonly dotLayer = new Container();
  private readonly dots: Sprite[] = [];
  private readonly dotScale: number;
  private readonly arrow = new Graphics();
  private readonly endMark = new Graphics();
  private readonly pulse: Sprite;
  private readonly path = new Float64Array(2 * (AIM_GUIDE_SEGMENTS + 1));
  private readonly trace: AimTrace = { points: 0, hitId: -1 };
  private clock = 0;
  private pulseT = 0;
  private snapT = 0;
  private shown = 0;

  constructor(tx: { dot: Texture; ring: Texture }) {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    this.dotScale = AIM_DOT_SIZE / Math.max(1, tx.dot.width);
    for (let i = 0; i < MAX_DOTS; i++) {
      const s = new Sprite(tx.dot);
      s.anchor.set(0.5);
      s.visible = false;
      this.dotLayer.addChild(s);
      this.dots.push(s);
    }

    // 화살표: +x를 가리키는 뾰족한 화살촉 (회전으로 조준 방향에 맞춘다)
    const L = AIM_ARROW_LEN;
    this.arrow
      .poly([-L / 2, -L * 0.42, L / 2, 0, -L / 2, L * 0.42, -L * 0.22, 0])
      .fill(0xffffff)
      .stroke({ width: 4, color: AIM_OUTLINE, join: 'round' });

    // 끝점(적에 닿는 곳): 과녁 고리
    this.endMark
      .circle(0, 0, END_RADIUS + 3)
      .stroke({ width: 4, color: AIM_OUTLINE, alpha: 0.75 })
      .circle(0, 0, END_RADIUS)
      .stroke({ width: 4, color: 0xffffff })
      .circle(0, 0, 3.5)
      .fill(0xffffff);
    this.endMark.visible = false;

    this.pulse = new Sprite(tx.ring);
    this.pulse.anchor.set(0.5);
    this.pulse.tint = PULSE_TINT;
    this.pulse.visible = false;

    this.addChild(this.dotLayer, this.endMark, this.pulse, this.arrow);
  }

  /** 조준이 바뀌었을 때: 화살표를 톡 키운다 */
  snap(): void {
    this.snapT = AIM_SNAP_TIME;
  }

  /** 탭한 자리(필드 좌표)에 고리 펄스 */
  pulseAt(x: number, y: number): void {
    this.pulseT = AIM_PULSE_TIME;
    this.pulse.position.set(x, y);
    this.pulse.visible = true;
  }

  /**
   * ox, oy = 발사점(필드 좌표), angle = 조준각(clamp 끝난 값), r = 미리보기 공 반경.
   * 매 프레임 호출 (경로 계산 = 선분 ≤ AIM_GUIDE_SEGMENTS × 적 수).
   */
  update(dt: number, ox: number, oy: number, angle: number, r: number, enemies: readonly EnemyEntity[]): void {
    this.clock += dt;
    const res = traceAim(ox, oy, angle, r, enemies, AIM_GUIDE_LEN, AIM_GUIDE_SEGMENTS, this.path, this.trace);
    this.placeDots(res.points);

    const end = res.points - 1;
    const hit = res.hitId >= 0;
    this.endMark.visible = hit;
    if (hit) {
      this.endMark.position.set(this.path[2 * end], this.path[2 * end + 1]);
      this.endMark.scale.set(1 + 0.12 * Math.sin(this.clock * 8));
    }

    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.arrow.position.set(ox + c * AIM_ARROW_DIST, oy + s * AIM_ARROW_DIST);
    this.arrow.rotation = angle;
    if (this.snapT > 0) this.snapT = Math.max(0, this.snapT - dt);
    const bob = 1 + 0.06 * Math.sin(this.clock * 5);
    this.arrow.scale.set(bob * (1 + 0.45 * (this.snapT / AIM_SNAP_TIME)));

    if (this.pulseT > 0) {
      this.pulseT = Math.max(0, this.pulseT - dt);
      const f = 1 - this.pulseT / AIM_PULSE_TIME;
      const ease = 1 - (1 - f) * (1 - f);
      this.pulse.scale.set((AIM_PULSE_SIZE / RING_PX) * (0.3 + 0.7 * ease));
      this.pulse.alpha = 1 - f * f;
      this.pulse.visible = this.pulseT > 0;
    }
  }

  /** 경로(path의 points개 꼭짓점)를 따라 일정 간격으로 점을 놓는다. 점은 바깥으로 천천히 흐른다 */
  private placeDots(points: number): void {
    const p = this.path;
    const dots = this.dots;
    let total = 0;
    for (let i = 0; i + 1 < points; i++) total += Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]);

    let k = 0;
    if (points >= 2) {
      let seg = 0;
      let ax = p[0];
      let ay = p[1];
      let bx = p[2];
      let by = p[3];
      let segLen = Math.hypot(bx - ax, by - ay);
      let acc = 0;
      let d = AIM_DOT_START + ((this.clock * AIM_DOT_FLOW) % AIM_DOT_SPACING);
      while (k < MAX_DOTS && d < total) {
        while (d > acc + segLen && seg + 2 < points) {
          acc += segLen;
          seg++;
          ax = bx;
          ay = by;
          bx = p[2 * seg + 2];
          by = p[2 * seg + 3];
          segLen = Math.hypot(bx - ax, by - ay);
        }
        const t = segLen > 0 ? Math.min(1, (d - acc) / segLen) : 0;
        const dot = dots[k++];
        dot.position.set(ax + (bx - ax) * t, ay + (by - ay) * t);
        const f = d / AIM_GUIDE_LEN;
        // 시작은 서서히 나타나고 끝은 서서히 사라지게 (흐를 때 툭 튀지 않게)
        const edge = Math.min(1, (d - AIM_DOT_START) / AIM_DOT_SPACING, (total - d) / AIM_DOT_SPACING);
        dot.alpha = (AIM_DOT_ALPHA_NEAR + (AIM_DOT_ALPHA_FAR - AIM_DOT_ALPHA_NEAR) * f) * Math.max(0, edge);
        dot.scale.set(this.dotScale * (1 + (AIM_DOT_END_SCALE - 1) * f));
        dot.visible = true;
        d += AIM_DOT_SPACING;
      }
    }
    for (let i = k; i < this.shown; i++) dots[i].visible = false;
    this.shown = k;
  }
}
