// 상점 판매 칸: 아이템을 끌어다 놓거나, 선택 후 두 번 눌러(확인) 판매. 판매가를 보여준다.
import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import { UI_COLORS } from '../../config';
import { killTweensOf, tween } from '../../core/tween';
import { lighten, mixColor, shade } from '../../render/color';
import { tex } from '../../render/assets';
import { T } from '../../i18n/ko';
import { textStyle } from '../../ui';

export type SellZoneState = 'idle' | 'selected' | 'confirm' | 'armed' | 'hover';

const BASE_COLOR = 0xc0563f;
const CONFIRM_COLOR = 0xff8a2b;
const HOVER_COLOR = 0xff5a3c;

export class SellZone extends Container {
  private readonly g = new Graphics();
  private readonly face = new Container();
  private readonly coin: Sprite;
  private readonly title: Text;
  private readonly priceText: Text;
  private state: SellZoneState = 'idle';
  private price: number | null = null;

  constructor(
    readonly zw: number,
    readonly zh: number,
    private readonly onTap: () => void,
  ) {
    super();
    this.face.pivot.set(zw / 2, zh / 2);
    this.face.position.set(zw / 2, zh / 2);
    this.coin = new Sprite(tex('ui_coin'));
    this.coin.anchor.set(0.5);
    const cs = 34 / Math.max(1, this.coin.texture.width, this.coin.texture.height);
    this.coin.scale.set(cs);
    this.title = new Text({ text: T.bag.sell, style: textStyle('button', { fontSize: 26 }) });
    this.title.anchor.set(0.5);
    this.priceText = new Text({ text: '', style: textStyle('number', { fontSize: 30, fill: UI_COLORS.gold }) });
    this.priceText.anchor.set(0, 0.5);
    this.face.addChild(this.g, this.coin, this.title, this.priceText);
    this.addChild(this.face);

    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(0, 0, zw, zh);
    this.on('pointertap', () => this.onTap());
    this.redraw();
  }

  /** 판매 대상 가격 (null = 없음) 과 상태 */
  set(state: SellZoneState, price: number | null): void {
    const changed = state !== this.state || price !== this.price;
    const wasHover = this.state === 'hover';
    this.state = state;
    this.price = price;
    if (!changed) return;
    this.redraw();
    if (state === 'hover' && !wasHover) {
      killTweensOf(this.face.scale);
      tween(this.face.scale, { x: 1.06, y: 1.06 }, 0.12, 'outBack');
    } else if (state !== 'hover' && wasHover) {
      killTweensOf(this.face.scale);
      tween(this.face.scale, { x: 1, y: 1 }, 0.12, 'outQuad');
    }
  }

  /** 로컬 좌표가 판매 칸 안인지 (드롭 판정, 살짝 넉넉하게) */
  containsLocal(x: number, y: number, pad = 6): boolean {
    return x >= -pad && x <= this.zw + pad && y >= -pad && y <= this.zh + pad;
  }

  private redraw(): void {
    const { zw: w, zh: h } = this;
    const st = this.state;
    const color =
      st === 'hover' ? HOVER_COLOR : st === 'confirm' ? CONFIRM_COLOR : st === 'idle' ? shade(BASE_COLOR, 0.55) : BASE_COLOR;
    const r = Math.min(h * 0.32, 26);
    const g = this.g;
    g.clear();
    g.roundRect(0, 0, w, h, r).fill(shade(color, 0.4));
    g.roundRect(3, 3, w - 6, h - 6, r - 3).fill(shade(color, 0.7));
    g.roundRect(3, 3, w - 6, h - 12, r - 3).fill(color);
    if (st === 'armed' || st === 'hover') {
      // 점선 테두리로 "놓는 곳" 표시
      const dash = 14;
      const inset = 9;
      for (let x = inset + 6; x < w - inset - 6; x += dash * 2) {
        g.rect(x, inset, Math.min(dash, w - inset - 6 - x), 3).rect(x, h - inset - 9, Math.min(dash, w - inset - 6 - x), 3);
      }
      g.fill({ color: 0xffffff, alpha: 0.7 });
    } else {
      g.roundRect(3 + r * 0.45, 7, w - 6 - r * 0.9, (h - 12) * 0.28, 8).fill(mixColor(color, lighten(color, 0.7), 0.3));
    }

    const cy = (h - 6) / 2;
    const p = this.price;
    const fitTitle = (maxW: number): void => {
      this.title.scale.set(1);
      if (this.title.width > maxW) this.title.scale.set(maxW / this.title.width);
    };
    if (p === null) {
      this.title.text = st === 'armed' || st === 'hover' ? T.bag.sell : T.bag.sellZone;
      this.title.style.fontSize = st === 'idle' ? 21 : 26;
      this.title.alpha = st === 'idle' ? 0.85 : 1;
      fitTitle(w - 24);
      this.title.position.set(w / 2, cy);
      this.coin.visible = false;
      this.priceText.visible = false;
    } else {
      this.title.text =
        st === 'confirm' ? T.bag.sellConfirm : st === 'hover' ? T.bag.sellDrop(p) : T.bag.sell;
      this.title.style.fontSize = st === 'confirm' || st === 'hover' ? 22 : 26;
      this.title.alpha = 1;
      this.coin.visible = st !== 'hover';
      this.priceText.visible = st !== 'hover';
      this.priceText.text = T.bag.sellPrice(p);
      fitTitle(st === 'hover' ? w - 24 : w - 24 - 50 - this.priceText.width);
      if (st === 'hover') {
        this.title.position.set(w / 2, cy);
      } else {
        // [제목]  (코인)+n
        const gap = 10;
        const total = this.title.width + gap + 34 + 6 + this.priceText.width;
        let x = w / 2 - total / 2;
        this.title.position.set(x + this.title.width / 2, cy);
        x += this.title.width + gap;
        this.coin.position.set(x + 17, cy);
        x += 34 + 6;
        this.priceText.position.set(x, cy);
      }
    }
  }
}
