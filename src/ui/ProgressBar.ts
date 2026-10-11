// 둥근 게이지. 값이 줄면 밝은 잔상이 늦게 따라온다. 원점은 좌상단.
import { Container, Graphics } from 'pixi.js';
import { UI_COLORS } from '../config';
import { killTweensOf, tween } from '../core/tween';
import { lighten, mixColor, shade } from '../render/color';

const PAD = 3;

export class ProgressBar extends Container {
  private readonly g = new Graphics();
  private readonly bw: number;
  private readonly bh: number;
  private color: number;
  private readonly bgColor: number;
  /** 트윈 대상 (shown = 본 게이지, trail = 잔상) */
  private readonly anim = { shown: 1, trail: 1 };
  private drawn = { shown: -1, trail: -1 };
  private target = 1;

  constructor(w: number, h: number, color: number, bg: number = shade(UI_COLORS.panel, 0.7)) {
    super();
    this.bw = w;
    this.bh = h;
    this.color = color;
    this.bgColor = bg;
    this.addChild(this.g);
    this.redraw();
    // 트윈이 값을 바꾸면 그리기 직전에 다시 그린다
    this.onRender = () => {
      if (this.anim.shown !== this.drawn.shown || this.anim.trail !== this.drawn.trail) this.redraw();
    };
  }

  get value(): number {
    return this.target;
  }

  setValue(v: number, animate = true): void {
    const next = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    this.target = next;
    killTweensOf(this.anim);
    if (!animate) {
      this.anim.shown = next;
      this.anim.trail = next;
      this.redraw();
      return;
    }
    if (next < this.anim.shown) {
      tween(this.anim, { shown: next }, 0.15, 'outQuad');
      // 잔상은 잠깐 머물렀다가 따라온다
      const trailFrom = Math.max(this.anim.trail, this.anim.shown);
      this.anim.trail = trailFrom;
      tween(this.anim, { trail: trailFrom }, 0.25, 'linear').then(() => tween(this.anim, { trail: next }, 0.35, 'inOutSine'));
    } else {
      this.anim.trail = next;
      tween(this.anim, { shown: next }, 0.3, 'outQuad');
    }
  }

  setColor(color: number): void {
    this.color = color;
    this.redraw();
  }

  private redraw(): void {
    const { shown, trail } = this.anim;
    this.drawn = { shown, trail };
    const w = this.bw;
    const h = this.bh;
    const r = h / 2;
    const g = this.g;
    g.clear();
    g.roundRect(0, 0, w, h, r).fill(shade(this.bgColor, 0.6));
    g.roundRect(PAD, PAD, w - PAD * 2, h - PAD * 2, r - PAD).fill(this.bgColor);
    const innerW = w - PAD * 2;
    const innerH = h - PAD * 2;
    const ir = innerH / 2;
    if (trail > shown) {
      const tw = innerW * trail;
      // 반투명 채우기는 삼각형 경계가 비쳐 보여서 불투명 색으로 섞어 쓴다
      g.roundRect(PAD, PAD, tw, innerH, Math.min(ir, tw / 2)).fill(lighten(this.bgColor, 0.78));
    }
    const fw = innerW * shown;
    if (fw > 0.5) {
      g.roundRect(PAD, PAD, fw, innerH, Math.min(ir, fw / 2)).fill(this.color);
      // 위쪽 광택
      const gh = innerH * 0.35;
      if (fw > ir) {
        g.roundRect(PAD + ir * 0.5, PAD + innerH * 0.12, fw - ir, gh, gh / 2).fill(
          mixColor(this.color, lighten(this.color, 0.6), 0.45),
        );
      }
    }
  }
}
