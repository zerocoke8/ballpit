// 캐릭터 선택: 초상화 카드 3장 + 선택한 캐릭터 상세(소개·패시브·스탯·시작 아이템·팁) + 시작/뒤로.
import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import { sfx } from '../audio';
import { UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { Keyboard } from '../core/keyboard';
import { Scene } from '../core/scene';
import { killTweensOf, tween } from '../core/tween';
import { game } from '../game';
import { T } from '../i18n/ko';
import { newRun, runPlayerStats } from '../logic/run';
import { tex } from '../render/assets';
import { shade } from '../render/color';
import type { CharacterDef, GameData, Tier } from '../types';
import { Button, OUTLINE_COLOR, Panel, ProgressBar, textStyle } from '../ui';
import { centeredButton, coverSprite, itemChip } from './menuFx';

const CARD_W = 204;
const CARD_H = 264;
const CARD_GAP = 20;
const CARD_SELECTED_SCALE = 1.06;
const CARD_IDLE_SCALE = 0.92;
const PORTRAIT_SIZE = 178;
const GLOW_COLOR = 0xffd23f;

const PANEL_W = 664;
const PANEL_PAD = 30;
const SECTION_GAP_MIN = 16;
const SECTION_GAP_MAX = 44;
const BAR_W = 250;
const BAR_H = 26;
const ITEM_CHIP = 96;
const ITEM_COL_W = 156;

const BTN_H = 112;
const START_W = 400;
const BACK_W = 200;
const START_COLOR = 0x4cc96b;

interface Card {
  holder: Container;
  body: Container;
  glow: Graphics;
  portrait: Sprite;
  portraitBaseScale: number;
}

interface Details {
  root: Container;
  sections: Container[];
  heights: number[];
  bars: { bar: ProgressBar; value: number }[];
}

interface CharStats {
  maxHp: number;
  moveSpeed: number;
}

/** 시작 아이템 조합에서 데이터로 팁 문구 고르기: 레시피 짝 → 같은 아이템 둘 → 강화석 */
function teaserFor(c: CharacterDef, data: GameData): string | null {
  const ids = c.startItems.map((s) => s.defId);
  for (const r of data.recipes) {
    if (ids.includes(r.base) && ids.includes(r.ingredient)) {
      const ing = data.items[r.ingredient];
      const base = data.items[r.base];
      if (ing && base) return T.menu.recipeTeaser(ing.name, base.name);
    }
  }
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup && data.items[dup]) return T.menu.tierTeaser(data.items[dup].name);
  const stone = ids.map((id) => data.items[id]).find((d) => d?.kind === 'stone');
  if (stone) return T.menu.stoneTeaser(stone.name);
  return null;
}

function statsFor(data: GameData, id: string): CharStats {
  // 표시용으로만 만드는 임시 런 (저장하지 않음)
  const p = runPlayerStats(data, newRun(data, id, 0));
  return { maxHp: p.maxHp, moveSpeed: Math.round(p.moveSpeed) };
}

export class CharacterSelectScene extends Scene {
  readonly sceneName = 'CharacterSelectScene';

  private readonly chars: CharacterDef[];
  private readonly bg = new Sprite(tex('bg_title'));
  private readonly dim = new Graphics();
  private readonly header: Text;
  private readonly cards: Card[] = [];
  private readonly cardRow = new Container();
  private readonly panel: Panel;
  private readonly details: Details[] = [];
  private readonly startHolder: Container;
  private readonly backHolder: Container;
  /** onEnter에서 만든다 (진입 전에 다른 goto로 버려진 씬이 window 키 리스너를 남기지 않게) */
  private keyboard: Keyboard | null = null;
  private selected = 0;
  private clock = 0;
  private hopTime = 1;
  private leaving = false;
  private panelH = 0;

  constructor() {
    super();
    const data = game.data;
    this.chars = Object.values(data.characters);
    const stats = this.chars.map((c) => statsFor(data, c.id));
    const maxHp = Math.max(1, ...stats.map((s) => s.maxHp));
    const maxSpeed = Math.max(1, ...stats.map((s) => s.moveSpeed));

    this.dim.eventMode = 'none';
    this.header = new Text({ text: T.menu.selectCharacter, style: textStyle('title', { fontSize: 64 }) });
    this.header.anchor.set(0.5, 0);
    this.addChild(this.bg, this.dim, this.header, this.cardRow);

    this.chars.forEach((c, i) => this.cards.push(this.buildCard(c, i)));

    this.panel = new Panel(PANEL_W, 600, { radius: 32 });
    this.addChild(this.panel);
    this.chars.forEach((c, i) => {
      const d = this.buildDetails(c, stats[i], maxHp, maxSpeed);
      d.root.visible = false;
      this.details.push(d);
      this.panel.addChild(d.root);
    });

    const back = new Button({
      label: T.common.back,
      width: BACK_W,
      height: BTN_H,
      color: UI_COLORS.panelBorder,
      fontSize: 38,
      sound: 'ui_back',
      onTap: () => this.goBack(),
    });
    const start = new Button({
      label: T.menu.startRun,
      width: START_W,
      height: BTN_H,
      color: START_COLOR,
      fontSize: 48,
      onTap: () => this.start(),
    });
    this.backHolder = centeredButton(back, BACK_W, BTN_H);
    this.startHolder = centeredButton(start, START_W, BTN_H);
    this.addChild(this.backHolder, this.startHolder);
  }

  override onEnter(): void {
    const kb = (this.keyboard = new Keyboard());
    kb.onPress('ArrowLeft', () => this.select(this.selected - 1));
    kb.onPress('KeyA', () => this.select(this.selected - 1));
    kb.onPress('ArrowRight', () => this.select(this.selected + 1));
    kb.onPress('KeyD', () => this.select(this.selected + 1));
    kb.onPress('Enter', () => this.start());
    kb.onPress('Space', () => this.start());
    kb.onPress('Escape', () => this.goBack());
    this.select(0, true);
    // 카드가 차례로 팡
    this.cards.forEach((c, i) => {
      c.holder.scale.set(0);
      void tween(c.holder.scale, { x: 0 }, 0.07 * i).then(() => tween(c.holder.scale, { x: 1, y: 1 }, 0.4, 'outBack'));
    });
    this.panel.alpha = 0;
    void tween(this.panel, { alpha: 1 }, 0.3);
    this.startHolder.scale.set(0);
    void tween(this.startHolder.scale, { x: 0 }, 0.25).then(() => tween(this.startHolder.scale, { x: 1, y: 1 }, 0.4, 'outBack'));
  }

  override onExit(): void {
    this.keyboard?.dispose();
    this.keyboard = null;
    for (const c of this.cards) {
      killTweensOf(c.holder.scale);
      killTweensOf(c.body);
      killTweensOf(c.body.scale);
    }
    for (const d of this.details) killTweensOf(d.root);
    killTweensOf(this.panel);
    killTweensOf(this.startHolder.scale);
  }

  layout(vp: Viewport): void {
    const w = vp.width;
    const h = vp.height;
    coverSprite(this.bg, w, h);
    this.dim.clear().rect(0, 0, w, h).fill({ color: UI_COLORS.bg, alpha: 0.8 });

    const top = vp.safeTop + 26;
    const headerBottom = top + this.header.height;
    const btnY = h - vp.safeBottom - 34 - BTN_H / 2;
    const contentTop = headerBottom + 18;
    const contentBottom = btnY - BTN_H / 2 - 26;
    const avail = contentBottom - contentTop;

    const cardsH = CARD_H * CARD_SELECTED_SCALE;
    const detailsMin = Math.max(...this.details.map((d) => this.detailsMinHeight(d)));
    const extra = Math.max(0, avail - cardsH - detailsMin - 24);
    // 남는 공간: 카드 위·아래 여백에 조금, 나머지는 패널 안 섹션 간격으로 (상한 이상은 패널을 키우지 않음)
    const gapAbove = Math.min(40, extra * 0.15);
    const gapBelow = 24 + Math.min(36, extra * 0.15);
    const maxPanelExtra = (SECTION_GAP_MAX - SECTION_GAP_MIN) * 4;
    const panelExtra = Math.min(maxPanelExtra, Math.max(0, extra - gapAbove - (gapBelow - 24)));
    this.panelH = detailsMin + panelExtra;
    const usedH = gapAbove + cardsH + gapBelow + this.panelH;
    const offset = Math.max(0, (avail - usedH) / 2);

    this.header.position.set(w / 2, top + offset * 0.4);
    const cardsCenterY = contentTop + offset + gapAbove + cardsH / 2;
    const rowW = this.cards.length * CARD_W + (this.cards.length - 1) * CARD_GAP;
    this.cards.forEach((c, i) => c.holder.position.set((w - rowW) / 2 + i * (CARD_W + CARD_GAP) + CARD_W / 2, cardsCenterY));

    this.panel.resize(PANEL_W, this.panelH);
    this.panel.position.set((w - PANEL_W) / 2, cardsCenterY + cardsH / 2 + gapBelow);
    for (const d of this.details) this.layoutDetails(d, this.panelH);

    this.backHolder.position.set(w / 2 - (START_W + 20) / 2, btnY);
    this.startHolder.position.set(w / 2 + (BACK_W + 20) / 2, btnY);
  }

  override update(dt: number): void {
    this.clock += dt;
    this.hopTime += dt;
    this.cards.forEach((c, i) => {
      const s = c.portraitBaseScale;
      if (i === this.selected) {
        // 선택된 친구는 신나게 통통
        const hop = this.hopTime < 0.5 ? Math.sin((this.hopTime / 0.5) * Math.PI) * 28 : 0;
        const w = this.clock * 5.5;
        const bounce = Math.abs(Math.sin(w)) * 7;
        c.portrait.y = CARD_H / 2 - 66 - hop - bounce;
        const squash = 1 - Math.max(0, Math.cos(w * 2)) * 0.03;
        c.portrait.scale.set(s * (2 - squash), s * squash);
      } else {
        c.portrait.y = CARD_H / 2 - 66 + Math.sin(this.clock * 1.6 + i) * 2;
        c.portrait.scale.set(s);
      }
    });
    const g = 0.6 + Math.sin(this.clock * 4) * 0.25;
    for (let i = 0; i < this.cards.length; i++) this.cards[i].glow.alpha = i === this.selected ? g : 0;
  }

  // ───────────────────────────────────────────────────────────

  private buildCard(c: CharacterDef, index: number): Card {
    const holder = new Container();
    const body = new Container();
    holder.addChild(body);

    const glow = new Graphics();
    for (let i = 3; i >= 1; i--) {
      const o = i * 5;
      glow
        .roundRect(-CARD_W / 2 - o, -CARD_H / 2 - o, CARD_W + o * 2, CARD_H + o * 2, 30 + o)
        .stroke({ width: 5, color: GLOW_COLOR, alpha: 0.5 / i });
    }
    glow.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 30).stroke({ width: 7, color: GLOW_COLOR });
    glow.alpha = 0;

    const panel = new Panel(CARD_W, CARD_H, { color: UI_COLORS.panelLight, radius: 30 });
    panel.position.set(-CARD_W / 2, -CARD_H / 2);
    // 초상화 뒤 둥근 무대
    const stage = new Graphics()
      .ellipse(0, CARD_H / 2 - 70, CARD_W * 0.36, 16)
      .fill({ color: 0x000000, alpha: 0.25 });

    const portrait = new Sprite(tex(c.portrait));
    portrait.anchor.set(0.5, 1);
    const baseScale = PORTRAIT_SIZE / Math.max(1, portrait.texture.width, portrait.texture.height);
    portrait.scale.set(baseScale);
    portrait.y = CARD_H / 2 - 66;

    const name = new Text({ text: c.name, style: textStyle('heading', { fontSize: 38 }) });
    name.anchor.set(0.5, 0.5);
    name.y = CARD_H / 2 - 34;

    body.addChild(glow, panel, stage, portrait, name);
    holder.eventMode = 'static';
    holder.cursor = 'pointer';
    holder.hitArea = new Rectangle(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H);
    holder.on('pointertap', () => this.select(index));
    this.cardRow.addChild(holder);
    return { holder, body, glow, portrait, portraitBaseScale: baseScale };
  }

  private buildDetails(c: CharacterDef, stats: CharStats, maxHp: number, maxSpeed: number): Details {
    const root = new Container();
    const sections: Container[] = [];
    const bars: Details['bars'] = [];
    const innerW = PANEL_W - PANEL_PAD * 2;

    // 1) 이름 + 소개
    const intro = new Container();
    const name = new Text({ text: c.name, style: textStyle('heading', { fontSize: 46, fill: UI_COLORS.gold }) });
    const desc = new Text({
      text: c.desc,
      style: textStyle('body', { fontSize: 27, lineHeight: 38, wordWrap: true, wordWrapWidth: innerW, breakWords: true }),
    });
    desc.y = name.height + 4;
    intro.addChild(name, desc);
    sections.push(intro);

    // 2) 패시브
    const passive = new Container();
    const chipText = new Text({ text: T.menu.passive, style: textStyle('small', { fontSize: 24, fill: UI_COLORS.text }) });
    const chipW = chipText.width + 30;
    const chipH = 42;
    const chip = new Graphics()
      .roundRect(0, 0, chipW, chipH, chipH / 2)
      .fill(UI_COLORS.accent)
      .stroke({ width: 3, color: shade(UI_COLORS.accent, 0.55) });
    chipText.anchor.set(0.5);
    chipText.position.set(chipW / 2, chipH / 2);
    const passiveText = new Text({
      text: c.passiveDesc,
      style: textStyle('heading', { fontSize: 36, fill: UI_COLORS.good, stroke: { color: OUTLINE_COLOR, width: 6, join: 'round' } }),
    });
    passiveText.anchor.set(0, 0.5);
    passiveText.position.set(chipW + 16, chipH / 2);
    passive.addChild(chip, chipText, passiveText);
    sections.push(passive);

    // 3) 스탯 막대
    const statBlock = new Container();
    const rows: { icon: string; label: string; value: number; max: number; color: number }[] = [
      { icon: 'ui_heart', label: T.menu.maxHp, value: stats.maxHp, max: maxHp, color: UI_COLORS.hp },
      { icon: 'item_g_sneakers', label: T.menu.moveSpeed, value: stats.moveSpeed, max: maxSpeed, color: 0x4cc9f0 },
    ];
    rows.forEach((r, i) => {
      const y = i * 54;
      const icon = new Sprite(tex(r.icon));
      icon.anchor.set(0.5);
      icon.scale.set(42 / Math.max(1, icon.texture.width, icon.texture.height));
      icon.position.set(21, y + 22);
      const label = new Text({ text: r.label, style: textStyle('body', { fontSize: 26 }) });
      label.anchor.set(0, 0.5);
      label.position.set(54, y + 22);
      const bar = new ProgressBar(BAR_W, BAR_H, r.color);
      bar.position.set(innerW - BAR_W - 92, y + 22 - BAR_H / 2);
      bar.setValue(r.value / r.max, false);
      const value = new Text({ text: String(r.value), style: textStyle('number', { fontSize: 32 }) });
      value.anchor.set(1, 0.5);
      value.position.set(innerW, y + 22);
      statBlock.addChild(icon, label, bar, value);
      bars.push({ bar, value: r.value / r.max });
    });
    sections.push(statBlock);

    // 4) 시작 아이템 (+ 팁)
    const items = new Container();
    const itemsLabel = new Text({ text: T.menu.startItems, style: textStyle('small', { fontSize: 24 }) });
    items.addChild(itemsLabel);
    const groups = new Map<string, { defId: string; tier: Tier; count: number }>();
    for (const s of c.startItems) {
      const tier = s.tier ?? 1;
      const key = `${s.defId}:${tier}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { defId: s.defId, tier, count: 1 });
    }
    let x = 0;
    const chipsTop = itemsLabel.height + 10;
    let itemsBottom = chipsTop;
    for (const g of groups.values()) {
      const def = game.data.items[g.defId];
      const col = new Container();
      const chipC = itemChip(g.defId, g.tier, ITEM_CHIP, g.count);
      chipC.position.set((ITEM_COL_W - ITEM_CHIP) / 2, 0);
      const nm = new Text({
        text: def?.name ?? g.defId,
        style: textStyle('small', { fontSize: 22, fill: UI_COLORS.text, align: 'center', wordWrap: true, wordWrapWidth: ITEM_COL_W, breakWords: true }),
      });
      nm.anchor.set(0.5, 0);
      nm.position.set(ITEM_COL_W / 2, ITEM_CHIP + 8);
      col.addChild(chipC, nm);
      col.position.set(x, chipsTop);
      items.addChild(col);
      itemsBottom = Math.max(itemsBottom, chipsTop + ITEM_CHIP + 8 + nm.height);
      x += ITEM_COL_W + 8;
    }
    const teaser = teaserFor(c, game.data);
    if (teaser) {
      const bubbleX = x + 4;
      const bubbleW = innerW - bubbleX;
      const text = new Text({
        text: teaser,
        style: textStyle('body', { fontSize: 23, lineHeight: 31, fill: 0xfff1c9, wordWrap: true, wordWrapWidth: bubbleW - 34, breakWords: true }),
      });
      const bubbleH = Math.max(ITEM_CHIP, text.height + 28);
      const bubble = new Graphics()
        // 말꼬리 (아이템 쪽)
        .poly([0, chipsTop + 34, 16, chipsTop + 24, 16, chipsTop + 48])
        .fill(UI_COLORS.panelLight)
        .roundRect(14, chipsTop, bubbleW - 14, bubbleH, 20)
        .fill(UI_COLORS.panelLight)
        .stroke({ width: 3, color: UI_COLORS.gold, alpha: 0.8 });
      bubble.x = bubbleX - 14;
      text.position.set(bubbleX + 14, chipsTop + (bubbleH - text.height) / 2);
      items.addChild(bubble, text);
      itemsBottom = Math.max(itemsBottom, chipsTop + bubbleH);
    }
    // 높이 계산을 위해 실제 아래 끝 표시 (보이지 않는 사각형)
    items.addChild(new Graphics().rect(0, itemsBottom - 1, 1, 1).fill({ color: 0x000000, alpha: 0 }));
    sections.push(items);

    root.addChild(...sections);
    const heights = sections.map((s) => s.getLocalBounds().maxY);
    return { root, sections, heights, bars };
  }

  private detailsMinHeight(d: Details): number {
    return PANEL_PAD * 2 + d.heights.reduce((a, b) => a + b, 0) + SECTION_GAP_MIN * (d.sections.length - 1);
  }

  private layoutDetails(d: Details, panelH: number): void {
    const content = d.heights.reduce((a, b) => a + b, 0);
    const n = d.sections.length;
    const gap = Math.max(SECTION_GAP_MIN, Math.min(SECTION_GAP_MAX, (panelH - PANEL_PAD * 2 - content) / Math.max(1, n - 1)));
    const used = content + gap * (n - 1);
    let y = PANEL_PAD + Math.max(0, (panelH - PANEL_PAD * 2 - used) / 2);
    d.sections.forEach((s, i) => {
      s.position.set(PANEL_PAD, y);
      y += d.heights[i] + gap;
    });
  }

  private select(index: number, instant = false): void {
    if (this.leaving) return;
    const n = this.cards.length;
    const next = ((index % n) + n) % n;
    const changed = next !== this.selected || instant;
    // 카드 고르기 소리 (진입 때의 첫 선택은 조용히). 같은 카드를 다시 눌러도 통통 튀므로 소리도 낸다
    if (!instant) sfx.play('ui_tap');
    this.selected = next;
    this.cards.forEach((c, i) => {
      const sel = i === next;
      killTweensOf(c.body.scale);
      killTweensOf(c.body);
      const target = sel ? CARD_SELECTED_SCALE : CARD_IDLE_SCALE;
      if (instant) {
        c.body.scale.set(target);
        c.body.alpha = sel ? 1 : 0.6;
      } else {
        if (sel) c.body.scale.set(target * 0.9);
        void tween(c.body.scale, { x: target, y: target }, sel ? 0.35 : 0.2, sel ? 'outBack' : 'outQuad');
        void tween(c.body, { alpha: sel ? 1 : 0.6 }, 0.2);
      }
    });
    if (!changed) {
      this.hopTime = 0;
      return;
    }
    this.hopTime = 0;
    this.details.forEach((d, i) => {
      killTweensOf(d.root);
      d.root.visible = i === next;
    });
    const d = this.details[next];
    d.root.alpha = 0;
    d.root.x = 24;
    void tween(d.root, { alpha: 1, x: 0 }, 0.22, 'outQuad');
    for (const b of d.bars) {
      b.bar.setValue(0, false);
      b.bar.setValue(b.value, true);
    }
  }

  private start(): void {
    if (this.leaving) return;
    const c = this.chars[this.selected];
    if (!c) return;
    this.leaving = true;
    game.startRun(c.id);
  }

  private goBack(): void {
    if (this.leaving) return;
    this.leaving = true;
    game.toTitle();
  }
}
