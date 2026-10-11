// 선택 아이템 정보 패널 (고정 높이). 내용이 넘치면 우선순위 낮은 줄부터 뺀다.
import { Container, Graphics, Text, type DestroyOptions } from 'pixi.js';
import { RARITY_COLORS, UI_COLORS } from '../../config';
import { FONT_FAMILY } from '../../core/fonts';
import { killTweensOf, tween } from '../../core/tween';
import { shade } from '../../render/color';
import { OUTLINE_COLOR, Panel, textStyle } from '../../ui';
import { drawStars, fitSprite, rarityFill } from './itemSprite';
import type { LineTone, StatChip, TooltipLine, TooltipModel } from './tooltipModel';

const PAD = 14;
const ICON_BOX = 100;
const CHIP_H = 30;
const CHIP_GAP = 6;
const LINE_FONT = 21;
const LINE_GAP = 4;
const NAME_FONT = 32;

const MERGE_COLOR = 0xffe14a;
const ITEM_TAG_COLOR = 0xffd23f;

const TONE_COLORS: Record<LineTone, number> = {
  normal: UI_COLORS.text,
  dim: UI_COLORS.textDim,
  good: UI_COLORS.good,
  merge: MERGE_COLOR,
  hint: 0x9fd8ff,
  warn: 0xffb35a,
};

function lineText(text: string, tone: LineTone, wrapW: number): Text {
  return new Text({
    text,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: tone === 'merge' ? LINE_FONT + 2 : LINE_FONT,
      lineHeight: (tone === 'merge' ? LINE_FONT + 2 : LINE_FONT) + 6,
      fill: TONE_COLORS[tone],
      wordWrap: true,
      breakWords: true,
      wordWrapWidth: wrapW,
      stroke: tone === 'merge' ? { color: OUTLINE_COLOR, width: 4, join: 'round' } : undefined,
      tagStyles: { item: { fill: tone === 'merge' ? 0xffffff : ITEM_TAG_COLOR } },
    },
  });
}

export class TooltipPanel extends Container {
  private readonly panel: Panel;
  private readonly content = new Container();
  private readonly maskG = new Graphics();
  private readonly pw: number;
  private readonly ph: number;

  constructor(width: number, height: number) {
    super();
    this.pw = width;
    this.ph = height;
    this.panel = new Panel(width, height, { radius: 22, color: UI_COLORS.panel, border: UI_COLORS.panelBorder });
    this.maskG.roundRect(4, 4, width - 8, height - 8, 18).fill(0xffffff);
    this.content.mask = this.maskG;
    this.addChild(this.panel, this.maskG, this.content);
    this.eventMode = 'none';
  }

  show(model: TooltipModel, animate = true): void {
    for (const c of this.content.removeChildren()) c.destroy({ children: true });
    if (model.type === 'empty') this.buildEmpty(model.title, model.lines);
    else this.buildItem(model);
    if (animate) {
      killTweensOf(this.content);
      this.content.alpha = 0.35;
      tween(this.content, { alpha: 1 }, 0.14, 'outQuad');
    }
  }

  override destroy(options?: DestroyOptions): void {
    killTweensOf(this.content);
    super.destroy(options);
  }

  // ───────────────────────────────────────────────────────────

  private iconBox(color: number, fill: number, iconKey: string): Container {
    const box = new Container();
    const g = new Graphics()
      .roundRect(0, 3, ICON_BOX, ICON_BOX, 18)
      .fill({ color: 0x000000, alpha: 0.25 })
      .roundRect(0, 0, ICON_BOX, ICON_BOX, 18)
      .fill(fill)
      .roundRect(2, 2, ICON_BOX - 4, ICON_BOX - 4, 16)
      .stroke({ width: 4, color });
    box.addChild(g);
    const inner = ICON_BOX - 20;
    const icon = fitSprite(iconKey, inner, inner);
    icon.position.set(ICON_BOX / 2, ICON_BOX / 2);
    box.addChild(icon);
    box.pivot.set(ICON_BOX / 2, ICON_BOX / 2);
    box.position.set(PAD + ICON_BOX / 2, PAD + ICON_BOX / 2);
    return box;
  }

  private labelChip(text: string, color: number, y: number): Container {
    const c = new Container();
    const t = new Text({ text, style: textStyle('small', { fontSize: 19, fill: 0xffffff, stroke: { color: shade(color, 0.35), width: 4, join: 'round' } }) });
    t.anchor.set(0.5);
    const w = ICON_BOX;
    const g = new Graphics().roundRect(0, 0, w, 28, 14).fill(shade(color, 0.75)).stroke({ width: 2, color });
    t.position.set(w / 2, 14);
    if (t.width > w - 10) t.scale.set((w - 10) / t.width);
    c.addChild(g, t);
    c.position.set(PAD, y);
    return c;
  }

  private buildItem(model: Extract<TooltipModel, { type: 'item' }>): void {
    const { def } = model;
    const rc = RARITY_COLORS[def.rarity];
    const box = this.iconBox(rc, rarityFill(def.rarity), def.icon);
    this.content.addChild(box);
    killTweensOf(box.scale);
    box.scale.set(0.85);
    tween(box.scale, { x: 1, y: 1 }, 0.25, 'outBack');

    this.content.addChild(this.labelChip(model.kindLabel, UI_COLORS.accent, PAD + ICON_BOX + 10));
    this.content.addChild(this.labelChip(model.rarityLabel, rc, PAD + ICON_BOX + 10 + 34));

    const x0 = PAD + ICON_BOX + 16;
    const cw = this.pw - x0 - PAD;
    let y = PAD - 4;

    // 이름 + ★
    const name = new Text({
      text: def.name,
      style: textStyle('heading', { fontSize: NAME_FONT, fill: rc, align: 'left', stroke: { color: OUTLINE_COLOR, width: 6, join: 'round' } }),
    });
    name.position.set(x0, y);
    const starR = 11;
    const starsW = model.tier * starR * 1.7 + 8;
    if (name.width > cw - starsW) name.scale.set((cw - starsW) / name.width);
    this.content.addChild(name);
    const stars = new Graphics();
    drawStars(stars, x0 + name.width + 10 + starR, y + name.height / 2, model.tier, starR);
    this.content.addChild(stars);
    y += Math.max(name.height, 40) + 2;

    // 스탯 칩
    if (model.stats.length > 0) y = this.flowChips(model.stats, x0, y, cw) + 8;

    this.addLines(model.lines, x0, y, cw);
  }

  private buildEmpty(title: string, lines: TooltipLine[]): void {
    const box = this.iconBox(UI_COLORS.panelBorder, UI_COLORS.panelLight, 'ui_bag');
    this.content.addChild(box);
    const x0 = PAD + ICON_BOX + 16;
    const cw = this.pw - x0 - PAD;
    const t = new Text({ text: title, style: textStyle('heading', { fontSize: NAME_FONT, align: 'left' }) });
    t.position.set(x0, PAD - 4);
    this.content.addChild(t);
    this.addLines(lines, x0, PAD - 4 + 46, cw);
  }

  /** 칩을 줄바꿈하며 배치하고 마지막 줄 바닥 y 반환 */
  private flowChips(chips: StatChip[], x0: number, y0: number, cw: number): number {
    let x = x0;
    let y = y0;
    for (const chip of chips) {
      const c = this.statChip(chip);
      if (x > x0 && x + c.width > x0 + cw) {
        x = x0;
        y += CHIP_H + CHIP_GAP;
      }
      c.position.set(x, y);
      this.content.addChild(c);
      x += c.width + CHIP_GAP;
    }
    return y + CHIP_H;
  }

  private statChip(chip: StatChip): Container {
    const c = new Container();
    const valueColor = chip.boosted ? UI_COLORS.good : 0xffffff;
    const text = chip.value
      ? `<l>${chip.label}</l> <v>${chip.value}</v>`
      : `<v>${chip.label}</v>`;
    const colored = chip.color !== undefined;
    const t = new Text({
      text,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 20,
        fill: 0xffffff,
        stroke: colored ? { color: shade(chip.color!, 0.35), width: 4, join: 'round' } : undefined,
        tagStyles: {
          l: { fill: colored ? 0xffffff : UI_COLORS.textDim },
          v: { fill: colored ? 0xffffff : chip.value ? valueColor : chip.boosted ? UI_COLORS.good : 0xffffff },
        },
      },
    });
    const w = Math.ceil(t.width) + 20;
    const bg = new Graphics();
    if (colored) bg.roundRect(0, 0, w, CHIP_H, CHIP_H / 2).fill(shade(chip.color!, 0.8)).stroke({ width: 2, color: chip.color! });
    else bg.roundRect(0, 0, w, CHIP_H, CHIP_H / 2).fill(shade(UI_COLORS.panelLight, 0.8)).stroke({ width: 2, color: UI_COLORS.panelBorder });
    t.anchor.set(0, 0.5);
    t.position.set(10, CHIP_H / 2);
    c.addChild(bg, t);
    return c;
  }

  /** 우선순위 낮은 줄부터 빼서 패널 안에 맞춘다 (표시 순서는 그대로) */
  private addLines(lines: TooltipLine[], x0: number, y0: number, cw: number): void {
    const bottom = this.ph - PAD + 2;
    const built = lines.map((l) => ({ line: l, text: lineText(l.text, l.tone, l.tone === 'merge' ? cw - 20 : cw) }));
    const heightOf = (list: typeof built): number =>
      list.reduce((h, b) => h + b.text.height + (b.line.tone === 'merge' ? 8 : 0) + LINE_GAP, 0);
    let kept = [...built];
    while (kept.length > 1 && y0 + heightOf(kept) > bottom) {
      let minIdx = 0;
      for (let i = 1; i < kept.length; i++) if (kept[i].line.priority < kept[minIdx].line.priority) minIdx = i;
      kept[minIdx].text.destroy();
      kept = kept.filter((_, i) => i !== minIdx);
    }
    let y = y0;
    for (const b of kept) {
      if (b.line.tone === 'merge') {
        const h = b.text.height + 8;
        const pill = new Graphics()
          .roundRect(x0 - 4, y, Math.min(cw + 4, b.text.width + 28), h, h / 2)
          .fill(shade(UI_COLORS.accent, 0.9))
          .stroke({ width: 3, color: MERGE_COLOR });
        this.content.addChild(pill);
        b.text.position.set(x0 + 10, y + 4);
        y += h + LINE_GAP;
      } else {
        b.text.position.set(x0, y);
        y += b.text.height + LINE_GAP;
      }
      this.content.addChild(b.text);
    }
  }
}
