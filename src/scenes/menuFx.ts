// 메뉴 화면(타이틀·캐릭터 선택·스테이지 클리어·결과) 공용 연출과 도우미:
// 색종이, 후광, 리본, 별, 카운트업, 가운데 기준 버튼 묶음, cover 맞춤, 아이템 칩.
import { Container, Graphics, GraphicsContext, Sprite, Text, type DestroyOptions } from 'pixi.js';
import { RARITY_COLORS, UI_COLORS } from '../config';
import { killTweensOf, tween } from '../core/tween';
import { game } from '../game';
import { T } from '../i18n/ko';
import { Rng, randomSeed } from '../logic/rng';
import { tex } from '../render/assets';
import { lighten, shade } from '../render/color';
import type { Tier } from '../types';
import { Button, OUTLINE_COLOR, textStyle } from '../ui';

// ─────────────────────────────────────────────────────────────
// 공용 연출
// ─────────────────────────────────────────────────────────────

export const CONFETTI_COLORS = [0xff6f91, 0xffc93c, 0x5ee07a, 0x6fd8ff, 0xb46cff, 0xff9f1c] as const;
const CONFETTI_GRAVITY = 1500;
const CONFETTI_DRAG = 1.6;

interface ConfettiPiece {
  g: Graphics;
  vx: number;
  vy: number;
  spin: number;
  flip: number;
  flipSpeed: number;
  life: number;
}

/** 색종이 파티클. 화면 연출 전용(시뮬레이션과 무관)이라 시드는 아무거나 */
export class ConfettiLayer extends Container {
  private readonly pieces: ConfettiPiece[] = [];
  private readonly rng = new Rng(randomSeed());
  private readonly shapes: GraphicsContext[];
  private bottom = 2000;

  constructor() {
    super();
    this.eventMode = 'none';
    this.shapes = [
      new GraphicsContext().rect(-9, -5, 18, 10).fill(0xffffff),
      new GraphicsContext().circle(0, 0, 6).fill(0xffffff),
      new GraphicsContext().star(0, 0, 5, 10, 5).fill(0xffffff),
    ];
  }

  /** 이 y(로컬)보다 아래로 떨어진 조각은 제거 */
  setBottom(y: number): void {
    this.bottom = y;
  }

  /** (x, y)에서 위쪽 부채꼴로 터뜨림 */
  burst(x: number, y: number, count: number, power = 1100): void {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + r.range(-1.05, 1.05);
      const sp = power * r.range(0.45, 1);
      this.spawn(x + r.range(-20, 20), y + r.range(-10, 10), Math.cos(ang) * sp, Math.sin(ang) * sp);
    }
  }

  /** 화면 위에서 흩뿌리기 */
  rain(width: number, top: number, count: number): void {
    const r = this.rng;
    for (let i = 0; i < count; i++) this.spawn(r.range(0, width), top - r.range(0, 120), r.range(-60, 60), r.range(80, 260));
  }

  get count(): number {
    return this.pieces.length;
  }

  update(dt: number): void {
    const drag = Math.max(0, 1 - CONFETTI_DRAG * dt);
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.life += dt;
      p.vy += CONFETTI_GRAVITY * dt * 0.35;
      p.vx *= drag;
      p.vy = Math.min(p.vy * drag + CONFETTI_GRAVITY * dt * 0.65, 520);
      p.g.x += p.vx * dt + Math.sin(p.life * 5 + p.flip) * 40 * dt;
      p.g.y += p.vy * dt;
      p.g.rotation += p.spin * dt;
      p.g.scale.y = Math.cos(p.life * p.flipSpeed + p.flip);
      if (p.g.y > this.bottom + 40 || p.life > 7) {
        p.g.destroy();
        this.pieces.splice(i, 1);
      }
    }
  }

  override destroy(options?: DestroyOptions): void {
    super.destroy(options);
    for (const s of this.shapes) s.destroy();
    this.pieces.length = 0;
  }

  private spawn(x: number, y: number, vx: number, vy: number): void {
    const r = this.rng;
    const g = new Graphics(r.pick(this.shapes));
    g.tint = r.pick(CONFETTI_COLORS);
    g.position.set(x, y);
    g.rotation = r.range(0, Math.PI * 2);
    const s = r.range(0.7, 1.25);
    g.scale.set(s);
    this.addChild(g);
    this.pieces.push({ g, vx, vy, spin: r.range(-8, 8), flip: r.range(0, 6), flipSpeed: r.range(6, 12), life: 0 });
  }
}

/** 천천히 도는 후광(빛살) */
export class SunBurst extends Container {
  private readonly rays = new Graphics();
  private readonly glow = new Graphics();
  speed = 0.25;

  constructor(radius: number, color: number, rays = 14) {
    super();
    this.eventMode = 'none';
    const half = Math.PI / rays / 2;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      this.rays.poly([0, 0, Math.cos(a - half) * radius, Math.sin(a - half) * radius, Math.cos(a + half) * radius, Math.sin(a + half) * radius]);
    }
    this.rays.fill({ color, alpha: 0.18 });
    for (let i = 0; i < 4; i++) this.glow.circle(0, 0, radius * (0.18 + i * 0.1)).fill({ color, alpha: 0.08 });
    this.addChild(this.rays, this.glow);
  }

  update(dt: number): void {
    this.rays.rotation += this.speed * dt;
  }
}

/** 양 끝이 접힌 리본 배너 (원점 = 가운데) */
export function drawRibbon(g: Graphics, w: number, h: number, color: number): Graphics {
  const dark = shade(color, 0.62);
  const tailW = Math.round(h * 0.75);
  const drop = Math.round(h * 0.22);
  const hw = w / 2;
  const hh = h / 2;
  const notch = tailW * 0.45;
  // 꼬리(뒤) + 접힌 그림자
  g.poly([-hw + 16, -hh + drop, -hw - tailW, -hh + drop, -hw - tailW + notch, drop / 2, -hw - tailW, hh + drop, -hw + 16, hh + drop])
    .fill(dark)
    .stroke({ width: 5, color: OUTLINE_COLOR, join: 'round' });
  g.poly([hw - 16, -hh + drop, hw + tailW, -hh + drop, hw + tailW - notch, drop / 2, hw + tailW, hh + drop, hw - 16, hh + drop])
    .fill(dark)
    .stroke({ width: 5, color: OUTLINE_COLOR, join: 'round' });
  g.poly([-hw, hh, -hw + 16, hh + drop, -hw + 16, hh]).fill(shade(color, 0.4));
  g.poly([hw, hh, hw - 16, hh + drop, hw - 16, hh]).fill(shade(color, 0.4));
  // 본체
  g.roundRect(-hw, -hh, w, h, 14).fill(color).stroke({ width: 5, color: OUTLINE_COLOR });
  g.roundRect(-hw + 14, -hh + 9, w - 28, h * 0.22, h * 0.11).fill(lighten(color, 0.35));
  return g;
}

/** 별 하나 (원점 = 가운데) */
export function drawStar(g: Graphics, r: number, color: number): Graphics {
  g.star(0, 5, 5, r, r * 0.5).fill(shade(color, 0.55));
  g.star(0, 0, 5, r, r * 0.5).fill(color).stroke({ width: 5, color: OUTLINE_COLOR, join: 'round' });
  g.star(-r * 0.12, -r * 0.14, 5, r * 0.42, r * 0.21).fill(lighten(color, 0.55));
  return g;
}

/** 0부터 목표값까지 올라가는 숫자. scene.update에서 sync() 호출 */
export class CountUp {
  value = 0;
  private shown = Number.NaN;

  constructor(
    readonly text: Text,
    readonly target: number,
    private readonly format: (n: number) => string,
  ) {
    this.sync();
  }

  play(duration: number): Promise<void> {
    if (this.target === 0) {
      this.value = 0;
      this.sync();
      return tween(this, { value: 0 }, Math.min(0.15, duration));
    }
    return tween(this, { value: this.target }, duration, 'outQuad');
  }

  finish(): void {
    killTweensOf(this);
    this.value = this.target;
    this.sync();
  }

  /** 표시 숫자를 맞춘다. 숫자가 바뀌었으면 true (카운트업 '틱' 소리용) */
  sync(): boolean {
    const n = Math.round(this.value);
    if (n === this.shown || this.text.destroyed) return false;
    this.shown = n;
    this.text.text = this.format(n);
    return true;
  }

  /** 0..1 진행도 (목표가 0이면 1) */
  get progress(): number {
    return this.target > 0 ? Math.min(1, this.value / this.target) : 1;
  }
}

/** 가운데 기준으로 스케일되는 버튼 묶음 */
export function centeredButton(btn: Button, w: number, h: number): Container {
  const holder = new Container();
  btn.position.set(-w / 2, -h / 2);
  holder.addChild(btn);
  return holder;
}

/** 텍스처를 영역에 cover로 맞춤 (가운데 정렬) */
export function coverSprite(sprite: Sprite, w: number, h: number): void {
  const t = sprite.texture;
  const s = Math.max(w / Math.max(1, t.width), h / Math.max(1, t.height));
  sprite.anchor.set(0.5);
  sprite.scale.set(s);
  sprite.position.set(w / 2, h / 2);
}

/** 아이템 아이콘 칩: 희귀도 테두리 사각 슬롯 + 아이콘 + ★ (원점 = 좌상단, size × size) */
export function itemChip(defId: string, tier: Tier, size: number, count = 1): Container {
  const def = game.data.items[defId];
  const c = new Container();
  const rarity = def ? RARITY_COLORS[def.rarity] : UI_COLORS.panelBorder;
  const bg = new Graphics()
    .roundRect(0, 4, size, size, size * 0.22)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(0, 0, size, size, size * 0.22)
    .fill(UI_COLORS.panelLight)
    .stroke({ width: 4, color: rarity });
  c.addChild(bg);
  if (def) {
    const icon = new Sprite(tex(def.icon));
    icon.anchor.set(0.5);
    const box = size * 0.74;
    icon.scale.set(box / Math.max(1, icon.texture.width, icon.texture.height));
    icon.position.set(size / 2, size / 2);
    c.addChild(icon);
  }
  if (tier > 1) {
    const stars = new Text({
      text: T.common.tier(tier),
      style: textStyle('number', { fontSize: Math.round(size * 0.24), fill: UI_COLORS.gold, stroke: { color: OUTLINE_COLOR, width: 4 } }),
    });
    stars.anchor.set(1, 1);
    stars.position.set(size - 4, size - 2);
    c.addChild(stars);
  }
  if (count > 1) {
    const label = new Text({
      text: T.menu.times(count),
      style: textStyle('number', { fontSize: Math.round(size * 0.26), stroke: { color: OUTLINE_COLOR, width: 4 } }),
    });
    const bw = Math.max(label.width + 16, size * 0.38);
    const bh = label.height + 2;
    const badge = new Graphics()
      .roundRect(0, 0, bw, bh, bh / 2)
      .fill(UI_COLORS.accent)
      .stroke({ width: 3, color: OUTLINE_COLOR });
    badge.position.set(size - bw + 8, -8);
    label.anchor.set(0.5);
    label.position.set(badge.x + bw / 2, badge.y + bh / 2);
    c.addChild(badge, label);
  }
  return c;
}

