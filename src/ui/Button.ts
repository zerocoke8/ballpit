// 통통한 캐주얼 버튼: 진한 아랫단 + 윗면 + 광택. 원점은 좌상단 (width × height 영역).
import { Container, Graphics, Rectangle, Sprite, Text, type FederatedPointerEvent } from 'pixi.js';
import { sfx } from '../audio';
import { UI_COLORS } from '../config';
import { killTweensOf, tween } from '../core/tween';
import { lighten, mixColor, shade } from '../render/color';
import type { SfxId } from '../data/sfxMap';
import { tex } from '../render/assets';
import { textStyle } from './text';

export interface ButtonOptions {
  label: string;
  width: number;
  height: number;
  color?: number;
  /** 에셋 키 */
  icon?: string;
  fontSize?: number;
  /** 눌렀을 때 효과음 (기본 'ui_tap', 뒤로 가기는 'ui_back'). 동작이 따로 소리를 내면 null */
  sound?: SfxId | null;
  onTap: () => void;
}

const DISABLED_COLOR = 0x8a8396;
const PRESS_SCALE = 0.94;
const BORDER = 3;

export class Button extends Container {
  private readonly bw: number;
  private readonly bh: number;
  private color: number;
  private readonly onTap: () => void;
  private readonly sound: SfxId | null;
  private readonly face: Container;
  private readonly bg: Graphics;
  private readonly labelText: Text;
  private readonly iconSprite: Sprite | null;
  private readonly depth: number;
  private enabled = true;
  private pressed = false;

  constructor(opts: ButtonOptions) {
    super();
    this.bw = opts.width;
    this.bh = opts.height;
    this.color = opts.color ?? UI_COLORS.accent;
    this.onTap = opts.onTap;
    this.sound = opts.sound === undefined ? 'ui_tap' : opts.sound;
    this.depth = Math.max(4, Math.round(opts.height * 0.1));

    // 누름 스케일이 가운데를 기준으로 되도록 내용물을 face에 담는다
    this.face = new Container();
    this.face.pivot.set(this.bw / 2, this.bh / 2);
    this.face.position.set(this.bw / 2, this.bh / 2);
    this.addChild(this.face);

    this.bg = new Graphics();
    this.face.addChild(this.bg);

    const fontSize = opts.fontSize ?? Math.round(Math.min(40, opts.height * 0.42));
    this.labelText = new Text({
      text: opts.label,
      style: textStyle('button', { fontSize, stroke: { color: shade(this.color, 0.4), width: 5, join: 'round' } }),
    });
    this.labelText.anchor.set(0.5);
    this.face.addChild(this.labelText);

    if (opts.icon) {
      this.iconSprite = new Sprite(tex(opts.icon));
      this.iconSprite.anchor.set(0.5);
      this.face.addChild(this.iconSprite);
    } else {
      this.iconSprite = null;
    }

    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(0, 0, this.bw, this.bh);
    this.on('pointerdown', this.handleDown);
    this.on('pointerup', this.handleUp);
    this.on('pointerupoutside', this.handleUp);
    this.on('pointerleave', this.handleUp);
    this.on('pointertap', this.handleTap);

    this.redraw();
    this.layoutContent();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    this.cursor = v ? 'pointer' : 'default';
    if (!v) this.release();
    this.redraw();
  }

  setLabel(s: string): void {
    if (this.labelText.text === s) return;
    this.labelText.text = s;
    this.layoutContent();
  }

  setColor(color: number): void {
    this.color = color;
    this.labelText.style.stroke = { color: shade(color, 0.4), width: 5, join: 'round' };
    this.redraw();
  }

  private redraw(): void {
    const w = this.bw;
    const h = this.bh;
    const d = this.depth;
    const b = BORDER;
    const base = this.enabled ? this.color : DISABLED_COLOR;
    const r = Math.min(h * 0.32, 28);
    const g = this.bg;
    g.clear();
    // 외곽선 → 아랫단(두께감) → 윗면 → 광택
    g.roundRect(0, 0, w, h, r).fill(shade(base, 0.38));
    g.roundRect(b, b, w - 2 * b, h - 2 * b, r - b).fill(shade(base, 0.68));
    g.roundRect(b, b, w - 2 * b, h - 2 * b - d, r - b).fill(base);
    // 광택은 항상 윗면 위에 있으므로 반투명 대신 미리 섞은 불투명 색 (반투명 알약 모양은 이음매가 비친다)
    g.roundRect(b + r * 0.45, b + 4, w - 2 * b - r * 0.9, (h - d) * 0.3, (h - d) * 0.15).fill(
      mixColor(base, lighten(base, 0.7), 0.35),
    );
    this.labelText.alpha = this.enabled ? 1 : 0.75;
    if (this.iconSprite) this.iconSprite.alpha = this.enabled ? 1 : 0.6;
  }

  private layoutContent(): void {
    const faceH = this.bh - this.depth - BORDER;
    const cy = BORDER + (faceH - BORDER) / 2;
    const pad = Math.max(12, this.bh * 0.22);
    const iconSize = this.iconSprite ? faceH * 0.62 : 0;
    const gap = this.iconSprite ? 10 : 0;

    this.labelText.scale.set(1);
    const maxLabelW = this.bw - pad * 2 - iconSize - gap;
    if (this.labelText.width > maxLabelW && maxLabelW > 0) this.labelText.scale.set(maxLabelW / this.labelText.width);
    const labelW = this.labelText.text ? this.labelText.width : 0;
    const total = iconSize + (labelW > 0 ? gap + labelW : 0);
    let x = this.bw / 2 - total / 2;

    if (this.iconSprite) {
      const t = this.iconSprite.texture;
      this.iconSprite.scale.set(iconSize / Math.max(1, t.width, t.height));
      this.iconSprite.position.set(x + iconSize / 2, cy);
      x += iconSize + gap;
    }
    this.labelText.position.set(x + labelW / 2, cy);
  }

  private readonly handleDown = (_e: FederatedPointerEvent): void => {
    if (!this.enabled) return;
    this.pressed = true;
    killTweensOf(this.face.scale);
    tween(this.face.scale, { x: PRESS_SCALE, y: PRESS_SCALE }, 0.06, 'outQuad');
  };

  private readonly handleUp = (): void => {
    this.release();
  };

  private release(): void {
    if (!this.pressed) return;
    this.pressed = false;
    killTweensOf(this.face.scale);
    tween(this.face.scale, { x: 1, y: 1 }, 0.16, 'outBack');
  }

  private readonly handleTap = (): void => {
    if (!this.enabled) return;
    if (this.sound) sfx.play(this.sound);
    this.onTap();
  };
}
