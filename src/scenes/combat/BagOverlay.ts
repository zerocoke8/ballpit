// 전투 일시정지 가방 오버레이: 어둡게 덮기(입력 차단) + BagView + "계속하기" 버튼.
// BagView는 문서화된 계약만 사용: constructor(opts), refresh(), contentHeight, destroy().
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { DESIGN_W, UI_COLORS } from '../../config';
import type { Viewport } from '../../core/app';
import { T } from '../../i18n/ko';
import type { GameData, RunState } from '../../types';
import { Button, textStyle } from '../../ui';
import { BagView } from '../bag/BagView';
import { SoundToggle } from '../settingsUi';

const BTN_W = 380;
const BTN_H = 100;
const PAD = 14;
const LABEL_H = 36;
/** '계속하기' 오른쪽 스피커 버튼 */
const SOUND_BTN = 64;
const SOUND_GAP = 26;

export interface BagOverlayOptions {
  data: GameData;
  run: RunState;
  onChange: () => void;
  onClose: () => void;
}

export class BagOverlay extends Container {
  private readonly dim = new Graphics();
  private readonly caption: Text;
  private readonly view: BagView;
  private readonly button: Button;
  private readonly soundToggle = new SoundToggle(SOUND_BTN);
  private vp: Viewport | null = null;
  private top = 0;
  private t = 0;

  constructor(opts: BagOverlayOptions) {
    super();
    this.dim.eventMode = 'static';
    this.caption = new Text({ text: T.combat.bagPaused, style: textStyle('small', { fontSize: 22 }) });
    this.caption.anchor.set(0.5, 0);
    this.view = new BagView({
      mode: 'combat',
      data: opts.data,
      run: opts.run,
      width: DESIGN_W,
      onChange: () => {
        opts.onChange();
        this.relayout();
      },
    });
    this.button = new Button({
      label: T.combat.resume,
      width: BTN_W,
      height: BTN_H,
      color: UI_COLORS.good,
      // 닫는 소리(bag_close)는 전투 씬이 낸다
      sound: null,
      onTap: () => opts.onClose(),
    });
    this.addChild(this.dim, this.caption, this.view, this.button, this.soundToggle);
    this.alpha = 0;
  }

  /** top: HUD 아래 끝 (화면 y) */
  layout(vp: Viewport, top: number): void {
    this.vp = vp;
    this.top = top;
    this.dim.clear().rect(0, 0, vp.width, vp.height).fill({ color: 0x0b0612, alpha: 0.78 });
    this.dim.hitArea = new Rectangle(0, 0, vp.width, vp.height);
    this.relayout();
  }

  refresh(): void {
    this.view.refresh();
    this.relayout();
  }

  /** 가방 안에서 아이템을 끌고 있는 중 (이때 Esc는 드래그 취소만 해야 한다) */
  get busy(): boolean {
    return this.view.isDragging;
  }

  update(dt: number): void {
    this.t += dt;
    this.alpha = Math.min(1, this.t / 0.15);
  }

  private relayout(): void {
    const vp = this.vp;
    if (!vp || this.destroyed) return;
    const btnY = vp.height - vp.safeBottom - BTN_H - 28;
    this.button.position.set((DESIGN_W - BTN_W) / 2, btnY);
    this.soundToggle.position.set((DESIGN_W + BTN_W) / 2 + SOUND_GAP, btnY + (BTN_H - SOUND_BTN) / 2 - 3);
    this.caption.position.set(DESIGN_W / 2, this.top + PAD);
    const viewTop = this.top + PAD + LABEL_H;
    const avail = Math.max(100, btnY - 20 - viewTop);
    const h = this.view.contentHeight;
    const s = h > avail ? avail / h : 1;
    this.view.scale.set(s);
    this.view.position.set((DESIGN_W - DESIGN_W * s) / 2, viewTop + (h > 0 && h * s < avail ? Math.min(40, (avail - h * s) / 2) : 0));
  }
}
