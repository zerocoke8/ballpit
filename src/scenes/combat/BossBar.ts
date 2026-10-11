// 필드 상단 보스 체력 바 (이름 + 큰 게이지). 필드 좌표, 원점은 필드 좌상단.
import { Container, Graphics, Text } from 'pixi.js';
import { FIELD_W, UI_COLORS } from '../../config';
import { textStyle } from '../../ui';
import { FastBar } from './FastBar';

const BAR_W = 440;
const BAR_H = 20;
const TOP = 6;

export class BossBar extends Container {
  /** 보스는 거의 매 프레임 맞는다 → 다시 그리지 않는 게이지 (FastBar 참고) */
  private readonly bar = new FastBar(BAR_W, BAR_H, UI_COLORS.hp);
  private readonly nameText: Text;
  private shown = -1;
  private fade = 0;
  private hiding = false;

  constructor(name: string) {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    const x = (FIELD_W - BAR_W) / 2;
    const bg = new Graphics()
      .roundRect(x - 12, TOP - 2, BAR_W + 24, BAR_H + 34, 14)
      .fill({ color: 0x1a0a14, alpha: 0.5 })
      .stroke({ width: 2, color: 0x7a0f1e, alpha: 0.7 });
    this.nameText = new Text({ text: name, style: textStyle('heading', { fontSize: 20, fill: 0xffe14a, stroke: { color: 0x2a0a10, width: 5, join: 'round' } }) });
    this.nameText.anchor.set(0.5, 0);
    this.nameText.position.set(FIELD_W / 2, TOP - 1);
    this.bar.position.set(x, TOP + 26);
    this.addChild(bg, this.nameText, this.bar);
    this.visible = false;
  }

  show(): void {
    this.visible = true;
    this.hiding = false;
    this.fade = 0;
  }

  hide(): void {
    this.hiding = true;
  }

  setHp(hp: number, maxHp: number): void {
    const cur = hp > 0 ? Math.ceil(hp) : 0;
    if (cur === this.shown) return;
    const first = this.shown < 0;
    this.shown = cur;
    this.bar.setValue(maxHp > 0 ? cur / maxHp : 0, !first);
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.bar.update(dt);
    if (this.hiding) {
      this.fade = Math.max(0, this.fade - dt * 2.5);
      if (this.fade <= 0) this.visible = false;
    } else {
      this.fade = Math.min(1, this.fade + dt * 4);
    }
    this.alpha = this.fade;
    this.y = (1 - this.fade) * -30;
  }
}
