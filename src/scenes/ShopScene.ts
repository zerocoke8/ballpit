// 상점: 상단 바(다음 스테이지 · 골드 · HP) → 가방(BagView, 판매 칸) → 상점 카드 4칸 → 행동 버튼.
// 상점·가방 행동마다 clampRunHp → saveRun → 화면 갱신 (되돌리기/새로고침 정찰 악용 방지).
import { Container, Graphics, Rectangle, Sprite, Text, type FederatedPointerEvent } from 'pixi.js';
import { sfx } from '../audio';
import { BAG_MAX_COLS, BAG_MAX_ROWS, HEAL_COST, RARITY_COLORS, UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { Scene } from '../core/scene';
import { killTweensOf, tween } from '../core/tween';
import { game } from '../game';
import { T } from '../i18n/ko';
import { clampRunHp, runPlayerStats, saveRun } from '../logic/run';
import { bagExpandCost, buyBagExpand, buyHeal, buySlot, canBuyHeal, rerollShop, toggleLock } from '../logic/shop';
import { lighten, mixColor, shade } from '../render/color';
import { tex } from '../render/assets';
import type { GameData, ItemDef, RunState, ShopSlot } from '../types';
import { Button, OUTLINE_COLOR, Panel, Toast, iconWithCount, textStyle, type IconWithCount } from '../ui';
import { BagView } from './bag/BagView';
import { flyArc, pop, shake, sparkleBurst } from './bag/fx';
import { drawStars, fitSprite, rarityFill } from './bag/itemSprite';
import { SoundToggle } from './settingsUi';

const MARGIN = 16;
const TOP_H = 76;
const CARD_H = 206;
const CARD_GAP = 12;
const ACTION_H = 72;
const ACTION_GAP = 10;
/** 행동 버튼 위로 튀어나온 가격 배지 여유 */
const BADGE_OVERHANG = 16;
const NEXT_W = 214;
/** 새로고침 · 확장 · 회복 버튼 폭 */
const ACT_W = Math.floor((720 - MARGIN * 2 - NEXT_W - ACTION_GAP * 3) / 3);
const BUY_COLOR = 0x3fbf5f;
/** 카드 위 '상점' 머리말 높이 */
const HEADER_H = 40;
/** 키 큰 화면에서만 보이는 캐릭터 안내 말풍선 높이 */
const GREETER_H = 132;
/** 상단 바 오른쪽 끝 스피커 버튼 크기 */
const SOUND_BTN = 52;

// ─────────────────────────────────────────────────────────────
// 작은 위젯
// ─────────────────────────────────────────────────────────────

/** 코인 + 숫자 알약 (버튼 위 가격표) */
class CostBadge extends Container {
  private readonly g = new Graphics();
  private readonly coin: Sprite;
  private readonly valueText: Text;

  constructor() {
    super();
    this.coin = fitSprite('ui_coin', 26, 26);
    this.valueText = new Text({ text: '', style: textStyle('number', { fontSize: 24 }) });
    this.valueText.anchor.set(0, 0.5);
    this.addChild(this.g, this.coin, this.valueText);
    this.eventMode = 'none';
  }

  /** text = 표시할 값 (null이면 숨김). 원점 = 배지 중심 */
  set(text: string | null, affordable: boolean, withCoin = true): void {
    this.visible = text !== null;
    if (text === null) return;
    this.valueText.text = text;
    this.valueText.style.fill = affordable ? UI_COLORS.gold : UI_COLORS.bad;
    this.coin.visible = withCoin;
    const coinW = withCoin ? 26 + 4 : 0;
    const w = coinW + this.valueText.width + 22;
    const h = 34;
    this.g.clear().roundRect(-w / 2, -h / 2, w, h, h / 2).fill(0x1d1329).stroke({ width: 3, color: affordable ? UI_COLORS.gold : UI_COLORS.bad });
    let x = -w / 2 + 11;
    if (withCoin) {
      this.coin.position.set(x + 13, 0);
      x += coinW;
    }
    this.valueText.position.set(x, 1);
  }
}

/** 하트 + "현재/최대" */
class HpCounter extends Container {
  private readonly icon: Sprite;
  private readonly valueText: Text;
  private readonly base: number;

  constructor(size: number) {
    super();
    this.icon = fitSprite('ui_heart', size, size);
    this.base = this.icon.scale.x;
    this.icon.position.set(size / 2, size / 2);
    this.valueText = new Text({ text: '', style: textStyle('number', { fontSize: Math.round(size * 0.72) }) });
    this.valueText.anchor.set(0, 0.5);
    this.valueText.position.set(size + 8, size / 2);
    this.addChild(this.icon, this.valueText);
  }

  set(hp: number, maxHp: number, bump: boolean): void {
    this.valueText.text = T.shop.hpValue(hp, maxHp);
    if (bump) {
      killTweensOf(this.icon.scale);
      this.icon.scale.set(this.base * 1.35);
      tween(this.icon.scale, { x: this.base, y: this.base }, 0.3, 'outBack');
    }
  }
}

/** '상점' 머리말 + 안내 (카드 바로 위) */
class ShopHeader extends Container {
  constructor() {
    super();
    const title = new Text({ text: T.shop.header, style: textStyle('heading', { fontSize: 30, align: 'left' }) });
    title.anchor.set(0, 0.5);
    title.position.set(MARGIN + 6, HEADER_H / 2);
    const hint = new Text({ text: T.shop.headerHint, style: textStyle('small', { fontSize: 20 }) });
    hint.anchor.set(1, 0.5);
    hint.position.set(720 - MARGIN - 6, HEADER_H / 2 + 2);
    const line = new Graphics()
      .roundRect(MARGIN + 18 + title.width, HEADER_H / 2, 720 - MARGIN * 2 - title.width - hint.width - 48, 3, 1.5)
      .fill({ color: UI_COLORS.panelBorder, alpha: 0.7 });
    this.addChild(line, title, hint);
    this.eventMode = 'none';
  }
}

/** 캐릭터 초상화 + 말풍선 팁. 누르면 다음 팁 */
class Greeter extends Container {
  private readonly portrait: Container;
  private readonly bubble = new Graphics();
  private readonly tipText: Text;
  private tipIndex: number;

  constructor(portraitKey: string, startTip: number) {
    super();
    const ph = GREETER_H - 6;
    const sprite = fitSprite(portraitKey, ph * 0.9, ph);
    this.portrait = new Container();
    this.portrait.addChild(sprite);
    this.portrait.position.set(MARGIN + 56, GREETER_H / 2);
    this.tipText = new Text({
      text: '',
      style: textStyle('body', { fontSize: 24, lineHeight: 32, fill: 0x3a2350, wordWrap: true, breakWords: true, wordWrapWidth: 480 }),
    });
    this.tipText.anchor.set(0, 0.5);
    this.addChild(this.bubble, this.portrait, this.tipText);
    this.tipIndex = startTip % T.shop.tips.length;
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(0, 0, 720, GREETER_H);
    this.on('pointertap', () => {
      sfx.playAt('ui_tap', 0, 1, 0.7);
      this.next();
    });
    this.showTip(false);
    // 살랑살랑
    this.portrait.onRender = () => {
      const t = performance.now() / 1000;
      this.portrait.rotation = Math.sin(t * 2) * 0.04;
      this.portrait.y = GREETER_H / 2 - Math.abs(Math.sin(t * 2)) * 3;
    };
  }

  next(): void {
    this.tipIndex = (this.tipIndex + 1) % T.shop.tips.length;
    this.showTip(true);
  }

  private showTip(animate: boolean): void {
    this.tipText.text = T.shop.tips[this.tipIndex];
    const bx = MARGIN + 124;
    const bw = 720 - MARGIN - bx;
    const bh = Math.max(84, this.tipText.height + 30);
    const by = (GREETER_H - bh) / 2;
    const g = this.bubble;
    g.clear();
    g.roundRect(bx, by + 5, bw, bh, 26).fill({ color: 0x000000, alpha: 0.25 });
    g.poly([bx + 4, GREETER_H / 2 - 14, bx - 18, GREETER_H / 2 + 4, bx + 4, GREETER_H / 2 + 10]).fill(0xfff6e6);
    g.roundRect(bx, by, bw, bh, 26).fill(0xfff6e6).stroke({ width: 4, color: 0xd9b88f });
    this.tipText.position.set(bx + 24, GREETER_H / 2);
    if (this.tipText.width > bw - 40) this.tipText.scale.set((bw - 40) / this.tipText.width);
    else this.tipText.scale.set(1);
    if (animate) {
      killTweensOf(this.portrait.scale);
      void pop(this.portrait, 1.12);
    }
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.portrait.onRender = null;
    killTweensOf(this.portrait.scale);
    super.destroy(options);
  }
}

interface CardCallbacks {
  onSelect(index: number): void;
  onLock(index: number): void;
  onBuy(index: number): void;
}

/** 상점 카드: 아이콘 · 이름 · 가격(선택 시 구매 버튼) · ★ 배지 · 자물쇠 */
class ShopCard extends Container {
  readonly face = new Container();
  private readonly bg = new Graphics();
  private readonly content = new Container();
  private readonly lockG = new Graphics();
  private readonly buyG = new Graphics();
  private readonly buyFace = new Container();
  private readonly iconHolder = new Container();
  private slot: ShopSlot | null = null;
  private selected = false;
  private affordable = true;
  private readonly lockRect: Rectangle;
  private readonly buyRect: Rectangle;
  private priceText: Text | null = null;

  constructor(
    readonly index: number,
    readonly cw: number,
    readonly ch: number,
    private readonly cb: CardCallbacks,
  ) {
    super();
    this.face.pivot.set(cw / 2, ch / 2);
    this.face.position.set(cw / 2, ch / 2);
    this.face.addChild(this.bg, this.iconHolder, this.content, this.buyFace, this.lockG);
    this.addChild(this.face);
    this.lockRect = new Rectangle(cw - 50, 0, 50, 50);
    this.buyRect = new Rectangle(8, ch - 56, cw - 16, 50);
    this.buyFace.pivot.set(cw / 2, ch - 31);
    this.buyFace.position.set(cw / 2, ch - 31);
    this.buyFace.addChild(this.buyG);

    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(0, 0, cw, ch);
    this.on('pointerdown', this.onDown);
    this.on('pointerup', this.onUp);
    this.on('pointerupoutside', this.onUp);
    this.on('pointertap', this.onTap);
  }

  /** 아이콘의 중심 (이 카드 로컬) */
  iconCenter(): { x: number; y: number } {
    return { x: this.cw / 2, y: 56 };
  }

  set(slot: ShopSlot | null, def: ItemDef | undefined, selected: boolean, affordable: boolean): void {
    this.slot = slot && def ? slot : null;
    this.selected = selected && !!this.slot;
    this.affordable = affordable;
    for (const c of this.content.removeChildren()) c.destroy({ children: true });
    for (const c of this.iconHolder.removeChildren()) c.destroy({ children: true });
    for (const c of this.buyFace.removeChildren()) if (c !== this.buyG) c.destroy({ children: true });
    this.priceText = null;
    this.buyG.clear();
    this.lockG.clear();
    this.redrawBg(def);
    this.face.y = this.ch / 2 + (this.selected ? -8 : 0);
    if (!this.slot || !def) {
      const t = new Text({ text: T.shop.soldOut, style: textStyle('heading', { fontSize: 28, fill: UI_COLORS.textDim }) });
      t.anchor.set(0.5);
      t.position.set(this.cw / 2, this.ch / 2);
      t.alpha = 0.7;
      this.content.addChild(t);
      return;
    }
    const s = this.slot;

    // 아이콘
    const glow = new Graphics().circle(this.cw / 2, 56, 44).fill({ color: RARITY_COLORS[def.rarity], alpha: 0.22 });
    this.iconHolder.addChild(glow);
    const icon = fitSprite(def.icon, 86, 86);
    icon.position.set(this.cw / 2, 56);
    this.iconHolder.addChild(icon);

    // ★2 이상 배지
    if (s.tier >= 2) {
      const sg = new Graphics();
      sg.roundRect(8, 8, 18 + s.tier * 17, 30, 15).fill(0x1d1329).stroke({ width: 2, color: 0xffd23f });
      drawStars(sg, 8 + 17, 23, s.tier, 9);
      this.content.addChild(sg);
    }

    // 이름 (최대 2줄)
    const name = new Text({
      text: def.name,
      style: textStyle('body', {
        fontSize: 22,
        lineHeight: 26,
        fill: lighten(RARITY_COLORS[def.rarity], 0.35),
        align: 'center',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: this.cw - 16,
        stroke: { color: OUTLINE_COLOR, width: 4, join: 'round' },
      }),
    });
    name.anchor.set(0.5, 0);
    name.position.set(this.cw / 2, 104);
    if (name.height > 56) name.scale.set(56 / name.height);
    this.content.addChild(name);

    // 아래: 가격 또는 구매 버튼
    const cy = this.ch - 31;
    if (this.selected) {
      const bw = this.cw - 16;
      const bh = 50;
      const x0 = 8;
      const y0 = cy - bh / 2;
      const color = affordable ? BUY_COLOR : 0x8a8396;
      this.buyG
        .roundRect(x0, y0, bw, bh, 18)
        .fill(shade(color, 0.4))
        .roundRect(x0 + 3, y0 + 3, bw - 6, bh - 6, 15)
        .fill(shade(color, 0.7))
        .roundRect(x0 + 3, y0 + 3, bw - 6, bh - 11, 15)
        .fill(color)
        .roundRect(x0 + 12, y0 + 7, bw - 24, 10, 5)
        .fill(mixColor(color, lighten(color, 0.7), 0.35));
      const label = new Text({ text: T.shop.buyButton, style: textStyle('button', { fontSize: 24, stroke: { color: shade(color, 0.35), width: 4, join: 'round' } }) });
      label.anchor.set(0, 0.5);
      const coin = fitSprite('ui_coin', 24, 24);
      const price = new Text({ text: T.shop.price(s.price), style: textStyle('number', { fontSize: 24, fill: affordable ? 0xffffff : UI_COLORS.bad }) });
      price.anchor.set(0, 0.5);
      const total = label.width + 8 + 24 + 4 + price.width;
      let x = this.cw / 2 - total / 2;
      label.position.set(x, cy - 3);
      x += label.width + 8;
      coin.position.set(x + 12, cy - 3);
      x += 28;
      price.position.set(x, cy - 2);
      this.buyFace.addChild(label, coin, price);
      this.priceText = price;
    } else {
      const coin = fitSprite('ui_coin', 30, 30);
      const price = new Text({ text: T.shop.price(s.price), style: textStyle('number', { fontSize: 30, fill: affordable ? UI_COLORS.gold : UI_COLORS.bad }) });
      price.anchor.set(0, 0.5);
      const total = 30 + 6 + price.width;
      coin.position.set(this.cw / 2 - total / 2 + 15, cy);
      price.position.set(this.cw / 2 - total / 2 + 36, cy + 1);
      this.content.addChild(coin, price);
      this.priceText = price;
    }

    this.drawLock(s.locked);
  }

  /** 실패 연출: 흔들기 + 가격 빨갛게 깜빡 */
  fail(): void {
    void shake(this.face, this.cw / 2, 12);
    const p = this.priceText;
    if (p) {
      const prev = p.style.fill;
      p.style.fill = UI_COLORS.bad;
      killTweensOf(p.scale);
      p.scale.set(1.3);
      void tween(p.scale, { x: 1, y: 1 }, 0.3, 'outBack').then(() => {
        if (!p.destroyed && this.affordable) p.style.fill = prev;
      });
    }
  }

  /** 새로고침 등장 연출 (지연 후 뒤집히듯) */
  flipIn(delaySec: number): void {
    killTweensOf(this.face.scale);
    this.face.scale.set(0, 1);
    void tween(this.face.scale, { x: 0, y: 1 }, delaySec, 'linear').then(() => tween(this.face.scale, { x: 1, y: 1 }, 0.28, 'outBack'));
  }

  private redrawBg(def: ItemDef | undefined): void {
    const g = this.bg;
    const w = this.cw;
    const h = this.ch;
    g.clear();
    if (!this.slot || !def) {
      g.roundRect(0, 0, w, h, 20).fill({ color: 0x1d1329, alpha: 0.7 });
      // 점선 테두리
      const dash = 12;
      for (let x = 16; x < w - 16; x += dash * 2) g.rect(x, 2, Math.min(dash, w - 16 - x), 3).rect(x, h - 5, Math.min(dash, w - 16 - x), 3);
      for (let y = 16; y < h - 16; y += dash * 2) g.rect(2, y, 3, Math.min(dash, h - 16 - y)).rect(w - 5, y, 3, Math.min(dash, h - 16 - y));
      g.fill({ color: UI_COLORS.panelBorder, alpha: 0.8 });
      return;
    }
    const rc = RARITY_COLORS[def.rarity];
    const locked = this.slot.locked;
    g.roundRect(0, 6, w, h, 20).fill({ color: 0x000000, alpha: 0.3 });
    if (this.selected) g.roundRect(-5, -5, w + 10, h + 10, 24).fill({ color: 0xffffff, alpha: 0.9 });
    g.roundRect(0, 0, w, h, 20).fill(mixColor(UI_COLORS.panel, rarityFill(def.rarity), 0.6));
    g.roundRect(2.5, 2.5, w - 5, h - 5, 18).stroke({ width: 5, color: locked ? 0xffd23f : rc });
    g.roundRect(14, 8, w - 28, 12, 6).fill({ color: 0xffffff, alpha: 0.08 });
  }

  private drawLock(locked: boolean): void {
    const g = this.lockG;
    const cx = this.cw - 26;
    const cy = 26;
    g.clear();
    g.circle(cx, cy, 19).fill({ color: locked ? 0x6b4a00 : 0x1d1329, alpha: locked ? 1 : 0.75 }).stroke({ width: 2, color: locked ? 0xffd23f : UI_COLORS.panelBorder });
    const bodyColor = locked ? 0xffd23f : 0x9a8fb0;
    // 고리 (잠기면 닫힘, 풀리면 한쪽이 들림)
    const sx = cx - 6;
    const top = cy - 12;
    if (locked) {
      g.moveTo(sx, cy - 1).lineTo(sx, top + 5).arc(cx, top + 5, 6, Math.PI, 0).lineTo(cx + 6, cy - 1);
    } else {
      g.moveTo(sx, cy - 1).lineTo(sx, top + 2).arc(cx, top + 2, 6, Math.PI, 0).lineTo(cx + 6, top + 4);
    }
    g.stroke({ width: 3.5, color: bodyColor, cap: 'round' });
    g.roundRect(cx - 10, cy - 2, 20, 15, 4).fill(bodyColor).stroke({ width: 2, color: shade(bodyColor, 0.45) });
    g.circle(cx, cy + 5, 2.4).fill(shade(bodyColor, 0.35));
  }

  private readonly onDown = (): void => {
    if (!this.slot) return;
    killTweensOf(this.face.scale);
    tween(this.face.scale, { x: 0.96, y: 0.96 }, 0.06, 'outQuad');
  };

  private readonly onUp = (): void => {
    if (!this.slot) return;
    killTweensOf(this.face.scale);
    tween(this.face.scale, { x: 1, y: 1 }, 0.16, 'outBack');
  };

  private readonly onTap = (e: FederatedPointerEvent): void => {
    if (!this.slot) return;
    const p = e.getLocalPosition(this);
    if (this.lockRect.contains(p.x, p.y)) {
      this.cb.onLock(this.index);
      return;
    }
    if (this.selected && this.buyRect.contains(p.x, p.y)) {
      killTweensOf(this.buyFace.scale);
      this.buyFace.scale.set(0.92);
      tween(this.buyFace.scale, { x: 1, y: 1 }, 0.2, 'outBack');
      this.cb.onBuy(this.index);
      return;
    }
    this.cb.onSelect(this.index);
  };
}

// ─────────────────────────────────────────────────────────────
// 씬
// ─────────────────────────────────────────────────────────────

export class ShopScene extends Scene {
  readonly sceneName = 'ShopScene';
  private readonly data: GameData;
  private readonly run: RunState | null;
  private readonly bgG = new Graphics();
  private readonly bgSprite = new Sprite(tex('bg_toyroom'));
  private readonly topPanel = new Panel(720 - MARGIN * 2, TOP_H, { radius: 22 });
  private readonly stageLabel = new Text({ text: '', style: textStyle('heading', { fontSize: 30, align: 'left' }) });
  private readonly goldCounter: IconWithCount;
  private readonly hpCounter = new HpCounter(38);
  private readonly soundToggle = new SoundToggle(SOUND_BTN);
  private bagView: BagView | null = null;
  private readonly cards: ShopCard[] = [];
  private readonly cardsLayer = new Container();
  private readonly rerollBtn: Button;
  private readonly expandBtn: Button;
  private readonly healBtn: Button;
  private readonly nextBtn: Button;
  private readonly rerollBadge = new CostBadge();
  private readonly expandBadge = new CostBadge();
  private readonly healBadge = new CostBadge();
  private readonly fxLayer = new Container();
  private readonly header = new ShopHeader();
  private readonly greeter: Greeter;
  private popup: Container | null = null;
  private selectedCard = -1;
  private vp: Viewport | null = null;
  private cardsY = 0;
  private lastHp = -1;

  constructor() {
    super();
    this.data = game.data;
    this.run = game.run;

    this.bgSprite.alpha = 0.16;
    this.addChild(this.bgG, this.bgSprite);

    const character = this.run ? this.data.characters[this.run.characterId] : undefined;
    this.greeter = new Greeter(character?.portrait ?? 'ui_bag', this.run?.stageIndex ?? 0);
    this.addChild(this.greeter, this.header);

    this.goldCounter = iconWithCount('ui_coin', 40);
    this.addChild(this.topPanel, this.stageLabel, this.goldCounter, this.hpCounter, this.soundToggle);

    const actW = ACT_W;
    this.rerollBtn = new Button({ label: T.shop.reroll, width: actW, height: ACTION_H, color: UI_COLORS.accent, fontSize: 26, sound: null, onTap: () => this.onReroll() });
    this.expandBtn = new Button({ label: T.shop.expandBag, width: actW, height: ACTION_H, color: 0x3f8fd8, fontSize: 26, onTap: () => this.openExpandPopup() });
    this.healBtn = new Button({ label: T.shop.heal, width: actW, height: ACTION_H, color: 0xe0506e, fontSize: 26, sound: null, onTap: () => this.onHeal() });
    this.nextBtn = new Button({ label: T.shop.nextStageButton, width: NEXT_W, height: ACTION_H, color: BUY_COLOR, fontSize: 28, onTap: () => this.onNext() });
    this.addChild(this.rerollBtn, this.expandBtn, this.healBtn, this.nextBtn, this.rerollBadge, this.expandBadge, this.healBadge);

    const cardW = Math.floor((720 - MARGIN * 2 - CARD_GAP * 3) / 4);
    const cb: CardCallbacks = {
      onSelect: (i) => this.onCardSelect(i),
      onLock: (i) => this.onCardLock(i),
      onBuy: (i) => this.onCardBuy(i),
    };
    const slots = this.run?.shop.slots.length ?? 0;
    for (let i = 0; i < slots; i++) {
      const card = new ShopCard(i, cardW, CARD_H, cb);
      this.cards.push(card);
      this.cardsLayer.addChild(card);
    }
    this.addChild(this.cardsLayer);

    if (this.run) {
      this.bagView = new BagView({
        mode: 'shop',
        data: this.data,
        run: this.run,
        width: 720,
        sellZone: true,
        onChange: () => this.afterAction(false),
        onSelect: () => this.deselectCard(),
      });
      // 드래그 고스트가 카드 위로 지나가도 보이게 가방을 위에 둔다
      this.addChild(this.bagView);
    }
    this.addChild(this.fxLayer);
  }

  override onEnter(): void {
    if (!this.run) {
      game.toTitle();
      return;
    }
    this.refreshAll();
  }

  override onExit(): void {
    for (const c of this.cards) {
      killTweensOf(c.face);
      killTweensOf(c.face.scale);
    }
    this.closePopup();
  }

  override layout(vp: Viewport): void {
    this.vp = vp;
    const w = vp.width;
    this.bgG.clear().rect(0, 0, w, vp.height).fill(UI_COLORS.bg);
    const t = this.bgSprite.texture;
    const k = Math.max(w / Math.max(1, t.width), vp.height / Math.max(1, t.height));
    this.bgSprite.scale.set(k);
    this.bgSprite.position.set((w - t.width * k) / 2, (vp.height - t.height * k) / 2);

    // 상단 바
    const top = vp.safeTop + 8;
    this.topPanel.position.set(MARGIN, top);
    this.stageLabel.anchor.set(0, 0.5);
    this.stageLabel.position.set(MARGIN + 20, top + TOP_H / 2);
    this.layoutTopRight(top);

    // 아래부터: 행동 버튼 → 카드
    const bottom = vp.height - vp.safeBottom - 10;
    const actY = bottom - ACTION_H;
    const actW = ACT_W;
    let x = MARGIN;
    for (const b of [this.rerollBtn, this.expandBtn, this.healBtn]) {
      b.position.set(x, actY);
      x += actW + ACTION_GAP;
    }
    this.nextBtn.position.set(720 - MARGIN - NEXT_W, actY);
    const badgeY = actY - 4;
    this.rerollBadge.position.set(this.rerollBtn.x + actW / 2, badgeY);
    this.expandBadge.position.set(this.expandBtn.x + actW / 2, badgeY);
    this.healBadge.position.set(this.healBtn.x + actW / 2, badgeY);

    this.cardsY = actY - BADGE_OVERHANG - 12 - CARD_H;
    const cardW = this.cards[0]?.cw ?? 0;
    this.cards.forEach((c, i) => c.position.set(MARGIN + i * (cardW + CARD_GAP), this.cardsY));

    // 가운데: [안내 말풍선] → 가방 → [상점 머리말] → 카드. 남는 공간은 틈에 고르게 나눈다
    const bagH = this.bagView?.contentHeight ?? 0;
    const areaTop = top + TOP_H + 8;
    const space = this.cardsY - 10 - areaTop;
    let free = space - bagH;
    const showHeader = free >= HEADER_H + 12;
    if (showHeader) free -= HEADER_H;
    const showGreeter = free >= GREETER_H + 30;
    if (showGreeter) free -= GREETER_H;
    const gaps = showGreeter ? 3 : 2;
    const gap = Math.max(0, free / gaps);
    let y = areaTop + gap;
    this.greeter.visible = showGreeter;
    if (showGreeter) {
      this.greeter.position.set(0, Math.round(y));
      y += GREETER_H + gap;
    }
    this.bagView?.position.set(0, Math.round(y));
    this.header.visible = showHeader;
    this.header.position.set(0, Math.round(this.cardsY - HEADER_H - 2));
  }

  // ───────────────────────────────────────────────────────────
  // 갱신
  // ───────────────────────────────────────────────────────────

  /** 외부(디버그 훅 등)에서 런 상태를 바꿨을 때 전체 갱신 */
  refresh(): void {
    if (!this.run || this.destroyed) return;
    this.bagView?.refresh();
    this.refreshAll();
  }

  private layoutTopRight(top: number): void {
    const cy = top + TOP_H / 2;
    const toggleX = 720 - MARGIN - 12 - SOUND_BTN;
    this.soundToggle.position.set(toggleX, cy - SOUND_BTN / 2);
    const right = toggleX - 18;
    const hpW = this.hpCounter.width;
    this.hpCounter.position.set(right - hpW, cy - 19);
    const goldW = this.goldCounter.width;
    this.goldCounter.position.set(right - hpW - 28 - goldW, cy - 20);
  }

  private refreshAll(): void {
    this.refreshTopBar();
    this.refreshCards();
    this.refreshButtons();
    if (this.vp) this.layout(this.vp);
  }

  private refreshTopBar(): void {
    const run = this.run;
    if (!run) return;
    const maxHp = runPlayerStats(this.data, run).maxHp;
    this.stageLabel.text = T.shop.nextStageLabel(run.stageIndex + 1, this.data.stages.length);
    this.goldCounter.setCount(run.gold);
    const hp = Math.ceil(run.hp);
    this.hpCounter.set(run.hp, maxHp, this.lastHp >= 0 && hp > this.lastHp);
    this.lastHp = hp;
    if (this.vp) this.layoutTopRight(this.vp.safeTop + 8);
  }

  private refreshCards(): void {
    const run = this.run;
    if (!run) return;
    if (this.selectedCard >= 0 && !run.shop.slots[this.selectedCard]) this.selectedCard = -1;
    this.cards.forEach((card, i) => {
      const slot = run.shop.slots[i] ?? null;
      const def = slot ? this.data.items[slot.defId] : undefined;
      card.set(slot, def, i === this.selectedCard, !!slot && run.gold >= slot.price);
    });
  }

  private refreshButtons(): void {
    const run = this.run;
    if (!run) return;
    const rerollable = run.shop.slots.some((s) => s !== null && !s.locked);
    const rc = run.shop.rerollCost;
    this.rerollBtn.setEnabled(rerollable && run.gold >= rc);
    this.rerollBadge.set(String(rc), run.gold >= rc);

    const ec = bagExpandCost(run);
    this.expandBtn.setEnabled(ec !== null && run.gold >= ec);
    this.expandBtn.setLabel(ec === null ? T.shop.maxExpanded : T.shop.expandBag);
    this.expandBadge.set(ec === null ? null : String(ec), ec !== null && run.gold >= ec);

    const maxHp = runPlayerStats(this.data, run).maxHp;
    const healOk = canBuyHeal(this.data, run) && maxHp - run.hp >= 1;
    this.healBtn.setEnabled(healOk);
    this.healBtn.setLabel(run.shop.healBought ? T.shop.healDone : T.shop.heal);
    this.healBadge.set(run.shop.healBought ? null : String(HEAL_COST), run.gold >= HEAL_COST);
  }

  /** 모든 상점·가방 행동 후: HP 보정 → 저장 → 화면 갱신 */
  private afterAction(bagChanged: boolean): void {
    const run = this.run;
    if (!run) return;
    clampRunHp(this.data, run);
    saveRun(run);
    if (bagChanged) this.bagView?.refresh();
    this.refreshTopBar();
    this.refreshCards();
    this.refreshButtons();
    if (bagChanged && this.vp) this.layout(this.vp);
  }

  private toast(text: string, color?: number): void {
    Toast.show(this, text, { y: this.cardsY - 40, color });
  }

  // ───────────────────────────────────────────────────────────
  // 카드
  // ───────────────────────────────────────────────────────────

  private onCardSelect(i: number): void {
    const run = this.run;
    const slot = run?.shop.slots[i];
    if (!run || !slot) return;
    this.closePopup();
    sfx.play('ui_tap');
    if (this.selectedCard === i) {
      // 다시 누르면 미리보기만 다시 띄움
      this.bagView?.showTooltipFor(slot.defId, slot.tier);
      return;
    }
    this.selectedCard = i;
    this.bagView?.showTooltipFor(slot.defId, slot.tier);
    this.refreshCards();
    void pop(this.cards[i].face, 1.06);
  }

  private deselectCard(): void {
    if (this.selectedCard < 0) return;
    this.selectedCard = -1;
    this.refreshCards();
  }

  private onCardLock(i: number): void {
    const run = this.run;
    const slot = run?.shop.slots[i];
    if (!run || !slot) return;
    toggleLock(run, i);
    sfx.play('ui_lock');
    this.afterAction(false);
    void pop(this.cards[i].face, 1.05);
    if (slot.locked) this.toast(T.shop.locked, 0x8a6a10);
  }

  private onCardBuy(i: number): void {
    const run = this.run;
    const bv = this.bagView;
    const slot = run?.shop.slots[i];
    if (!run || !bv || !slot) return;
    let reason: string | null = null;
    if (run.gold < slot.price) reason = T.shop.notEnoughGold;
    else if (run.bag.stash.length >= run.bag.stashCapacity) reason = T.shop.stashFull;
    const stashIndex = run.bag.stash.length;
    if (reason !== null || !buySlot(this.data, run, i)) {
      this.cards[i].fail();
      sfx.play('ui_error');
      this.toast(reason ?? T.shop.notEnoughGold, UI_COLORS.bad);
      return;
    }
    sfx.play('ui_purchase');
    const bought = run.bag.stash[run.bag.stash.length - 1];
    const card = this.cards[i];
    const iconKey = this.data.items[slot.defId]?.icon;

    this.selectedCard = -1;
    this.afterAction(true);
    if (bought) {
      bv.selectUid(bought.uid);
      bv.setItemVisible(bought.uid, false);
    }

    // 아이콘이 카드에서 보관함 칸으로 날아간다
    if (iconKey) {
      const from = this.toLocal(card.toGlobal(card.iconCenter()));
      const to = this.toLocal(bv.toGlobal(bv.stashSlotCenter(stashIndex)));
      const flyer = fitSprite(iconKey, 86, 86);
      flyer.position.set(from.x, from.y);
      this.fxLayer.addChild(flyer);
      const endScale = (bv.stashSlotSize * 0.8) / 86 * flyer.scale.x;
      void flyArc(flyer, to, 0.45, 140, endScale).then(() => {
        if (!flyer.destroyed) flyer.destroy();
        if (this.destroyed) return;
        if (bought) {
          bv.setItemVisible(bought.uid, true);
          bv.bounce(bought.uid);
        }
        sparkleBurst(this.fxLayer, to.x, to.y, 60, 10);
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  // 행동 버튼
  // ───────────────────────────────────────────────────────────

  private onReroll(): void {
    const run = this.run;
    if (!run) return;
    this.closePopup();
    if (!run.shop.slots.some((s) => s !== null && !s.locked)) {
      sfx.play('ui_error');
      this.toast(T.shop.rerollNothing, UI_COLORS.bad);
      return;
    }
    if (!rerollShop(this.data, run)) {
      sfx.play('ui_error');
      this.toast(T.shop.notEnoughGold, UI_COLORS.bad);
      return;
    }
    sfx.play('ui_reroll');
    this.selectedCard = -1;
    this.bagView?.clearPreview();
    this.afterAction(false);
    this.cards.forEach((c, i) => {
      if (!run.shop.slots[i]?.locked) c.flipIn(i * 0.05);
    });
  }

  private openExpandPopup(): void {
    const run = this.run;
    if (!run || !this.vp) return;
    if (this.popup) {
      this.closePopup();
      return;
    }
    const cost = bagExpandCost(run);
    if (cost === null || run.gold < cost) return;

    const popup = new Container();
    // 바깥을 누르면 닫힘
    const blocker = new Graphics().rect(0, 0, 720, this.vp.height).fill({ color: 0x000000, alpha: 0.35 });
    blocker.eventMode = 'static';
    blocker.on('pointertap', () => this.closePopup());
    popup.addChild(blocker);

    const pw = 440;
    const ph = 200;
    const px = Math.round((720 - pw) / 2);
    const py = Math.round(this.expandBtn.y - ph - 26);
    const panel = new Panel(pw, ph, { radius: 26, color: UI_COLORS.panel, border: 0x3f8fd8 });
    panel.position.set(px, py);
    panel.eventMode = 'static';
    popup.addChild(panel);
    const title = new Text({ text: T.shop.expandTitle, style: textStyle('heading', { fontSize: 28 }) });
    title.anchor.set(0.5, 0);
    title.position.set(px + pw / 2, py + 16);
    popup.addChild(title);

    const bw = (pw - 48 - 16) / 2;
    const mk = (dir: 'col' | 'row', i: number): void => {
      const atMax = dir === 'col' ? run.bag.cols >= BAG_MAX_COLS : run.bag.rows >= BAG_MAX_ROWS;
      const b = new Button({
        label: dir === 'col' ? T.shop.expandCol : T.shop.expandRow,
        width: bw,
        height: 74,
        color: 0x3f8fd8,
        fontSize: 28,
        sound: null,
        onTap: () => this.onExpand(dir),
      });
      b.setEnabled(!atMax);
      b.position.set(px + 24 + i * (bw + 16), py + 64);
      popup.addChild(b);
      const sub = new Text({
        text: atMax ? T.shop.maxExpanded : dir === 'col' ? T.shop.expandColSub(run.bag.cols + 1) : T.shop.expandRowSub(run.bag.rows + 1),
        style: textStyle('small', { fontSize: 20 }),
      });
      sub.anchor.set(0.5, 0);
      sub.position.set(b.x + bw / 2, py + 64 + 80);
      popup.addChild(sub);
    };
    mk('col', 0);
    mk('row', 1);
    this.addChild(popup);
    this.popup = popup;
    popup.alpha = 0;
    tween(popup, { alpha: 1 }, 0.12, 'outQuad');
  }

  private closePopup(): void {
    const p = this.popup;
    if (!p) return;
    this.popup = null;
    killTweensOf(p);
    p.destroy({ children: true });
  }

  private onExpand(dir: 'col' | 'row'): void {
    const run = this.run;
    if (!run) return;
    this.closePopup();
    if (!buyBagExpand(run, dir)) {
      sfx.play('ui_error');
      this.toast(T.shop.notEnoughGold, UI_COLORS.bad);
      return;
    }
    sfx.play('bag_expand');
    this.afterAction(true);
    this.toast(T.shop.expanded, 0x2f6fb0);
    this.bagView?.celebrateGrid();
  }

  private onHeal(): void {
    const run = this.run;
    if (!run) return;
    this.closePopup();
    const before = run.hp;
    if (!buyHeal(this.data, run)) {
      sfx.play('ui_error');
      this.toast(run.shop.healBought ? T.shop.healBought : T.shop.fullHp, UI_COLORS.bad);
      return;
    }
    sfx.play('heal');
    this.afterAction(false);
    this.toast(T.shop.healed(Math.round(run.hp - before)), 0xb03050);
    const c = this.hpCounter;
    sparkleBurst(this.fxLayer, c.x + 19, c.y + 19, 50, 10, [UI_COLORS.hp, 0xffffff, 0xffb3c1]);
  }

  private onNext(): void {
    this.closePopup();
    const run = this.run;
    if (!run) return;
    clampRunHp(this.data, run);
    saveRun(run);
    game.toCombat();
  }
}
