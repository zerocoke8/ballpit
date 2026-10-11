// 필드 테두리(나무 벽 좌·우·상단), 하단 바 배경, 방어선(빨간 점선 + 위험 시 맥동 글로우).
// 화면(씬) 좌표. 필드 밖으로 나간 스프라이트를 덮도록 필드 위에 그린다.
import { Container, Graphics } from 'pixi.js';
import { DESIGN_W, FIELD_H, FIELD_W, FIELD_X } from '../../config';
import { BAR_BG, DEFENSE_RED, WALL_TOP_H, WOOD, WOOD_DARK, WOOD_LIGHT } from './visual';

const GLOW_H = 90;
const DASH = 22;
const GAP = 12;
const LINE_W = 6;

export class FrameView extends Container {
  private readonly walls = new Graphics();
  private readonly bar = new Graphics();
  private readonly glow = new Graphics();
  private readonly line = new Graphics();
  private danger = 0;
  private clock = 0;

  constructor() {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    this.addChild(this.bar, this.glow, this.walls, this.line);
    this.glow.alpha = 0;
  }

  /** fieldY: 필드 위쪽 화면 y, height: 화면 논리 높이 */
  layout(fieldY: number, height: number): void {
    const top = fieldY - WALL_TOP_H;
    const bottom = fieldY + FIELD_H;
    const rightX = FIELD_X + FIELD_W;
    const g = this.walls;
    g.clear();
    // 좌·우 벽
    for (const x of [0, rightX]) {
      g.rect(x, top, FIELD_X, bottom - top).fill(WOOD);
      for (let y = fieldY + 90; y < bottom; y += 150) g.rect(x, y, FIELD_X, 3);
      g.fill({ color: WOOD_DARK, alpha: 0.35 });
    }
    g.rect(FIELD_X - 4, top, 4, bottom - top).fill({ color: WOOD_DARK, alpha: 0.6 });
    g.rect(rightX, top, 4, bottom - top).fill({ color: WOOD_DARK, alpha: 0.6 });
    g.rect(2, top, 5, bottom - top).fill({ color: WOOD_LIGHT, alpha: 0.7 });
    g.rect(rightX + 6, top, 5, bottom - top).fill({ color: WOOD_LIGHT, alpha: 0.7 });
    // 상단 벽
    g.rect(0, top, DESIGN_W, WALL_TOP_H).fill(WOOD);
    g.rect(0, top, DESIGN_W, 4).fill({ color: WOOD_LIGHT, alpha: 0.8 });
    g.rect(FIELD_X - 4, fieldY - 4, FIELD_W + 8, 4).fill({ color: WOOD_DARK, alpha: 0.7 });
    g.rect(0, top - 3, DESIGN_W, 3).fill({ color: WOOD_DARK, alpha: 0.8 });

    // 하단 바 배경 (방어선 아래 ~ 화면 끝)
    const b = this.bar;
    b.clear();
    b.rect(0, bottom, DESIGN_W, Math.max(0, height - bottom) + 4).fill(BAR_BG);
    b.rect(0, bottom, DESIGN_W, 10).fill({ color: 0x000000, alpha: 0.25 });

    // 방어선 위 위험 글로우 (아래로 갈수록 진함)
    const gl = this.glow;
    gl.clear();
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const h = (GLOW_H * (i + 1)) / steps;
      gl.rect(FIELD_X, bottom - h, FIELD_W, h).fill({ color: DEFENSE_RED, alpha: 0.07 });
    }

    // 빨간 점선 방어선
    const l = this.line;
    l.clear();
    l.rect(0, bottom - LINE_W / 2 - 2, DESIGN_W, LINE_W + 4).fill({ color: 0x3a0d14, alpha: 0.85 });
    for (let x = 4; x < DESIGN_W; x += DASH + GAP) l.rect(x, bottom - LINE_W / 2, Math.min(DASH, DESIGN_W - x), LINE_W);
    l.fill(DEFENSE_RED);
  }

  /** 0..1 — 가장 아래 적이 방어선에 얼마나 가까운지 */
  setDanger(v: number): void {
    this.danger = v;
  }

  update(dt: number): void {
    this.clock += dt;
    const d = this.danger;
    if (d <= 0) {
      this.glow.alpha = 0;
      this.line.alpha = 0.85;
      this.line.tint = 0xffffff;
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * (6 + d * 8));
    this.glow.alpha = d * (0.45 + 0.55 * pulse);
    this.line.alpha = 0.85 + 0.15 * pulse;
    this.line.tint = pulse > 0.5 ? 0xffffff : 0xffb0b0;
  }
}
