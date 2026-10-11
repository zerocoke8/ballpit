// 둥근 패널 + 테두리 + 살짝 깔린 그림자. 원점은 좌상단.
import { Container, Graphics } from 'pixi.js';
import { UI_COLORS } from '../config';

export interface PanelOptions {
  color?: number;
  /** 테두리 색. null이면 테두리 없음 */
  border?: number | null;
  borderWidth?: number;
  radius?: number;
  alpha?: number;
  /** 아래 그림자 (기본 true) */
  shadow?: boolean;
}

export class Panel extends Container {
  private readonly g = new Graphics();
  private readonly opts: Required<Omit<PanelOptions, 'border'>> & { border: number | null };
  private pw: number;
  private ph: number;

  constructor(w: number, h: number, opts: PanelOptions = {}) {
    super();
    this.pw = w;
    this.ph = h;
    this.opts = {
      color: opts.color ?? UI_COLORS.panel,
      border: opts.border === undefined ? UI_COLORS.panelBorder : opts.border,
      borderWidth: opts.borderWidth ?? 4,
      radius: opts.radius ?? 24,
      alpha: opts.alpha ?? 1,
      shadow: opts.shadow ?? true,
    };
    this.addChild(this.g);
    this.redraw();
  }

  get panelWidth(): number {
    return this.pw;
  }

  get panelHeight(): number {
    return this.ph;
  }

  resize(w: number, h: number): void {
    if (w === this.pw && h === this.ph) return;
    this.pw = w;
    this.ph = h;
    this.redraw();
  }

  private redraw(): void {
    const { color, border, borderWidth, radius, alpha, shadow } = this.opts;
    const w = this.pw;
    const h = this.ph;
    const r = Math.min(radius, w / 2, h / 2);
    const g = this.g;
    g.clear();
    if (shadow) g.roundRect(0, 6, w, h, r).fill({ color: 0x000000, alpha: 0.28 * alpha });
    g.roundRect(0, 0, w, h, r).fill({ color, alpha });
    if (border !== null && borderWidth > 0) {
      const bw = borderWidth;
      g.roundRect(bw / 2, bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2)).stroke({ width: bw, color: border, alpha });
    }
  }
}
