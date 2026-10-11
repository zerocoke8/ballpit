// 가방 아이템 그림: 희귀도 배경 + 테두리 + (회전된) 아이콘 + ★. 상점 카드·보관함·드래그 고스트가 함께 쓴다.
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { ELEMENT_COLORS, RARITY_COLORS, UI_COLORS } from '../../config';
import { FONT_FAMILY } from '../../core/fonts';
import { mixColor, shade } from '../../render/color';
import { tex } from '../../render/assets';
import type { Element, ItemDef, Rarity, Rot, Tier } from '../../types';
import { OUTLINE_COLOR } from '../../ui';

export const STAR_COLOR = 0xffd23f;
export const STAR_OUTLINE = 0x6b3d00;

/** 희귀도 색을 어두운 패널 색에 섞은 배경 */
export function rarityFill(rarity: Rarity): number {
  return mixColor(UI_COLORS.panelLight, RARITY_COLORS[rarity], 0.32);
}

export function rarityColor(rarity: Rarity): number {
  return RARITY_COLORS[rarity];
}

/** 텍스처를 maxW × maxH 안에 비율 유지로 맞춘 스프라이트 (앵커 중심) */
export function fitSprite(key: string, maxW: number, maxH: number): Sprite {
  const s = new Sprite(tex(key));
  s.anchor.set(0.5);
  const t = s.texture;
  const k = Math.min(maxW / Math.max(1, t.width), maxH / Math.max(1, t.height));
  s.scale.set(k);
  return s;
}

/** 외곽선 있는 ★ count개 (x, y = 첫 별 중심) */
export function drawStars(g: Graphics, x: number, y: number, count: number, r: number): void {
  const step = r * 1.7;
  for (let i = 0; i < count; i++) {
    g.star(x + i * step, y, 5, r, r * 0.48, 0).fill(STAR_COLOR).stroke({ width: Math.max(1.5, r * 0.28), color: STAR_OUTLINE });
  }
}

/** 마름모 경로 */
export function diamond(g: Graphics, cx: number, cy: number, r: number): Graphics {
  return g.poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]);
}

/** 반짝이 (4갈래 별) */
export function sparkle(g: Graphics, cx: number, cy: number, r: number, color: number, alpha = 1): void {
  g.star(cx, cy, 4, r, r * 0.32, 0).fill({ color, alpha });
}

export interface ItemViewOptions {
  /** 무기에 붙은 속성 (오른쪽 아래 점으로 표시) */
  elements?: readonly Element[];
  /** 배경/테두리 없이 아이콘만 */
  iconOnly?: boolean;
}

/**
 * 가방 칸 크기 기준 아이템 그림. 원점(pivot)은 회전 후 footprint의 중심이라
 * position = footprint 중심으로 두고 scale 트윈으로 통통 튀게 할 수 있다.
 */
export class ItemView extends Container {
  readonly fw: number;
  readonly fh: number;
  readonly iconHolder = new Container();
  private readonly bg = new Graphics();
  private readonly deco = new Graphics();

  constructor(
    readonly def: ItemDef,
    readonly tier: Tier,
    readonly rot: Rot,
    readonly cell: number,
    opts: ItemViewOptions = {},
  ) {
    super();
    const odd = rot % 2 === 1;
    const fwCells = odd ? def.h : def.w;
    const fhCells = odd ? def.w : def.h;
    this.fw = fwCells * cell;
    this.fh = fhCells * cell;
    this.pivot.set(this.fw / 2, this.fh / 2);
    this.eventMode = 'none';

    const inset = Math.max(2, Math.round(cell * 0.04));
    const r = Math.max(8, cell * 0.2);
    const color = RARITY_COLORS[def.rarity];
    if (!opts.iconOnly) {
      const w = this.fw - inset * 2;
      const h = this.fh - inset * 2;
      const bw = Math.max(2.5, cell * 0.045);
      this.bg
        .roundRect(inset, inset + 3, w, h, r)
        .fill({ color: 0x000000, alpha: 0.25 })
        .roundRect(inset, inset, w, h, r)
        .fill(rarityFill(def.rarity))
        .roundRect(inset + bw / 2, inset + bw / 2, w - bw, h - bw, r - bw / 2)
        .stroke({ width: bw, color });
      // 윗면 광택
      this.bg
        .roundRect(inset + r * 0.6, inset + bw + 2, w - r * 1.2, Math.min(h * 0.16, 14), 6)
        .fill({ color: mixColor(rarityFill(def.rarity), 0xffffff, 0.25), alpha: 0.6 });
      this.addChild(this.bg);
    }

    // 아이콘: 회전 전 footprint 안에 맞춘 뒤 중심 기준으로 회전
    const pad = opts.iconOnly ? 0 : Math.max(6, cell * 0.12);
    const icon = fitSprite(def.icon, def.w * cell - pad * 2, def.h * cell - pad * 2);
    this.iconHolder.addChild(icon);
    this.iconHolder.position.set(this.fw / 2, this.fh / 2);
    this.iconHolder.rotation = (rot * Math.PI) / 2;
    this.addChild(this.iconHolder);

    if (!opts.iconOnly) {
      const sr = Math.max(5.5, cell * 0.085);
      drawStars(this.deco, inset + sr + 4, inset + sr + 4, tier, sr);
      const els = opts.elements ?? [];
      const dr = Math.max(5, cell * 0.075);
      els.forEach((el, i) => {
        const cx = this.fw - inset - dr - 5 - i * (dr * 2 + 3);
        const cy = this.fh - inset - dr - 5;
        this.deco.circle(cx, cy, dr).fill(ELEMENT_COLORS[el]).stroke({ width: 2, color: shade(ELEMENT_COLORS[el], 0.4) });
      });
      this.addChild(this.deco);
    }
  }
}

/**
 * 보관함 칸(정사각형 size)에 맞춘 아이템: 희귀도 배경 + 맞춘 아이콘 + ★ + 크기 배지("2×1").
 * pivot = 중심.
 */
export class SlotItemView extends Container {
  constructor(
    readonly def: ItemDef,
    readonly tier: Tier,
    readonly size: number,
    sizeLabel: string | null,
  ) {
    super();
    this.pivot.set(size / 2, size / 2);
    this.eventMode = 'none';
    const color = RARITY_COLORS[def.rarity];
    const r = Math.max(8, size * 0.2);
    const bw = 3;
    const g = new Graphics()
      .roundRect(1, 3, size - 2, size - 2, r)
      .fill({ color: 0x000000, alpha: 0.25 })
      .roundRect(1, 1, size - 2, size - 2, r)
      .fill(rarityFill(def.rarity))
      .roundRect(1 + bw / 2, 1 + bw / 2, size - 2 - bw, size - 2 - bw, r - bw / 2)
      .stroke({ width: bw, color });
    this.addChild(g);
    // 아트는 대부분 정사각형에 가까워서 칸 모양과 상관없이 정사각형 안에 맞춘다
    const inner = size - 16;
    const icon = fitSprite(def.icon, inner, inner);
    icon.position.set(size / 2, size / 2);
    this.addChild(icon);
    const deco = new Graphics();
    const sr = Math.max(5, size * 0.08);
    drawStars(deco, sr + 5, sr + 5, tier, sr);
    this.addChild(deco);
    if (sizeLabel) {
      const t = badgeText(sizeLabel, Math.max(13, Math.round(size * 0.2)), 0xffffff);
      t.anchor.set(1, 1);
      t.position.set(size - 4, size - 2);
      this.addChild(t);
    }
  }
}

/** 작은 라벨 텍스트 (외곽선) */
export function badgeText(text: string, size: number, color: number = UI_COLORS.text): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: size,
      fill: color,
      stroke: { color: OUTLINE_COLOR, width: Math.max(3, size * 0.22), join: 'round' },
    },
  });
  return t;
}
