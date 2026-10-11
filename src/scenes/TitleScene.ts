// 타이틀: 배경 아트 + 통통 튀는 로고 + 새 게임 / 이어하기 (+ 새 게임 확인 창).
import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import { version as APP_VERSION } from '../../package.json';
import { UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { Keyboard } from '../core/keyboard';
import { Scene } from '../core/scene';
import { killTweensOf, tween } from '../core/tween';
import { game } from '../game';
import { T } from '../i18n/ko';
import { tex } from '../render/assets';
import { shade } from '../render/color';
import { Button, Panel, textStyle } from '../ui';
import { centeredButton } from './menuFx';
import { SettingsDialog } from './settingsUi';

/** 배경 아트(bg_title) 원본 좌표계 기준 배치 — 위쪽 장난감과 아래쪽 동물 사이 빈 공간 */
const ART_W = 720;
const ART_H = 1560;
const LOGO_LINE1_Y = 515;
const LOGO_LINE2_Y = 640;
const SUBTITLE_Y = 758;
const BUTTONS_TOP_Y = 820;
const BUTTON_GAP = 22;

const LOGO_OUTLINE = 0x4a2c22;
const LOGO_LINE1_FILL = 0xfff4e0;
const LOGO_FILLS = [0xff9f1c, 0xffd23f, 0x4cc9f0, 0xff6f91, 0x7bd389];
const LOGO_LINE1_SIZE = 92;
const LOGO_LINE2_SIZE = 150;
const LETTER_KERN = -6;

const BTN_W = 440;
const BTN_H = 112;
const COLOR_PRIMARY = 0x4cc96b;
const COLOR_SECONDARY = 0xff9f1c;
const SUBTITLE_BG = 0x6b4430;
const VERSION_COLOR = 0x6b4430;
const SETTINGS_W = 150;
const SETTINGS_H = 72;
const SETTINGS_MARGIN = 18;

interface Letter {
  /** layout이 위치를 정하는 바깥 컨테이너 */
  holder: Container;
  /** 애니메이션(출렁임/등장) 담당 */
  text: Text;
  phase: number;
}

/** 가운데 기준으로 스케일되는 버튼 묶음 */
export class TitleScene extends Scene {
  readonly sceneName = 'TitleScene';

  private readonly bg = new Sprite(tex('bg_title'));
  private readonly logo = new Container();
  private readonly letters: Letter[] = [];
  private readonly subtitle = new Container();
  private readonly versionText: Text;
  private readonly buttons: { holder: Container; primary: boolean }[] = [];
  private readonly hasSave: boolean;
  /** onEnter에서 만든다 (진입 전에 다른 goto로 버려진 씬이 window 키 리스너를 남기지 않게) */
  private keyboard: Keyboard | null = null;
  private dialog: ConfirmDialog | null = null;
  private readonly settingsBtn: Button;
  private settingsDialog: SettingsDialog | null = null;
  private clock = 0;
  private introDone = false;
  private leaving = false;
  private vp: Viewport | null = null;

  constructor() {
    super();
    this.hasSave = game.hasSave();
    this.bg.anchor.set(0.5, 0);
    this.addChild(this.bg, this.logo, this.subtitle);

    this.buildLogo();
    this.buildSubtitle();

    if (this.hasSave) {
      this.addButton(T.menu.continueRun, COLOR_PRIMARY, true, () => this.continueRun());
      this.addButton(T.menu.newRun, COLOR_SECONDARY, false, () => this.requestNewRun());
    } else {
      this.addButton(T.menu.newRun, COLOR_PRIMARY, true, () => this.startNewRun());
    }

    this.versionText = new Text({
      text: T.menu.version(APP_VERSION),
      style: textStyle('small', { fontSize: 20, fill: VERSION_COLOR }),
    });
    this.versionText.anchor.set(0.5, 1);
    this.versionText.alpha = 0.75;
    this.addChild(this.versionText);

    // 오른쪽 위: 설정 (효과음 · 볼륨 · 그래픽 품질)
    this.settingsBtn = new Button({
      label: T.menu.settings.button,
      width: SETTINGS_W,
      height: SETTINGS_H,
      color: SUBTITLE_BG,
      fontSize: 30,
      onTap: () => this.openSettings(),
    });
    this.addChild(this.settingsBtn);
  }

  override onEnter(): void {
    const kb = (this.keyboard = new Keyboard());
    kb.onPress('Enter', () => this.onConfirmKey());
    kb.onPress('Space', () => this.onConfirmKey());
    kb.onPress('Escape', () => {
      if (this.settingsDialog) this.settingsDialog.cancel();
      else this.dialog?.cancel();
    });
    void this.playIntro();
  }

  override onExit(): void {
    this.keyboard?.dispose();
    this.keyboard = null;
    for (const l of this.letters) {
      killTweensOf(l.text);
      killTweensOf(l.text.scale);
    }
    for (const b of this.buttons) killTweensOf(b.holder.scale);
    killTweensOf(this.subtitle);
    killTweensOf(this.subtitle.scale);
    this.dialog?.dispose();
    this.settingsDialog?.dispose();
    this.settingsDialog = null;
  }

  layout(vp: Viewport): void {
    this.vp = vp;
    const w = vp.width;
    // 배경 cover 맞춤 (가로 가운데, 세로 가운데)
    const s = Math.max(w / ART_W, vp.height / ART_H);
    this.bg.scale.set(s);
    const offY = (vp.height - ART_H * s) / 2;
    this.bg.position.set(w / 2, offY);
    const artY = (y: number): number => offY + y * s;

    // 로고/부제/버튼은 세이프 영역 아래로만
    const minTop = vp.safeTop + 40;
    const logoShift = Math.max(0, minTop - (artY(LOGO_LINE1_Y) - LOGO_LINE1_SIZE / 2));
    this.logo.position.set(w / 2, logoShift);
    this.layoutLetters(artY(LOGO_LINE1_Y), artY(LOGO_LINE2_Y));
    this.subtitle.position.set(w / 2, artY(SUBTITLE_Y) + logoShift);

    let y = artY(BUTTONS_TOP_Y) + logoShift + BTN_H / 2;
    if (this.buttons.length === 1) y += BTN_H / 2;
    for (const b of this.buttons) {
      b.holder.position.set(w / 2, y);
      y += BTN_H + BUTTON_GAP;
    }

    this.versionText.position.set(w / 2, vp.height - vp.safeBottom - 14);
    this.settingsBtn.position.set(w - SETTINGS_MARGIN - SETTINGS_W, vp.safeTop + SETTINGS_MARGIN);
    this.dialog?.layout(vp);
    this.settingsDialog?.layout(vp);
  }

  override update(dt: number): void {
    this.clock += dt;
    if (!this.introDone) return;
    // 글자마다 위상을 달리한 출렁임
    for (const l of this.letters) {
      const t = this.clock * 3.2 + l.phase;
      l.text.y = Math.sin(t) * 7;
      l.text.rotation = Math.sin(t * 0.5) * 0.045;
    }
    // 주 버튼은 살짝 숨쉬기
    const primary = this.buttons.find((b) => b.primary);
    if (primary && !this.dialog) {
      const k = 1 + Math.sin(this.clock * 3.4) * 0.025;
      primary.holder.scale.set(k);
    }
  }

  // ───────────────────────────────────────────────────────────

  private buildLogo(): void {
    const words = T.menu.gameTitle.split(' ');
    const lines = words.length > 1 ? [words[0], words.slice(1).join(' ')] : [words[0]];
    let colorIndex = 0;
    lines.forEach((line, lineIndex) => {
      const big = lineIndex === lines.length - 1;
      const size = big ? LOGO_LINE2_SIZE : LOGO_LINE1_SIZE;
      for (const ch of [...line]) {
        if (ch === ' ') continue;
        const fill = big ? LOGO_FILLS[colorIndex++ % LOGO_FILLS.length] : LOGO_LINE1_FILL;
        const text = new Text({
          text: ch,
          style: textStyle('title', {
            fontSize: size,
            fill,
            stroke: { color: LOGO_OUTLINE, width: big ? 18 : 13, join: 'round' },
            dropShadow: { color: LOGO_OUTLINE, alpha: 1, blur: 0, distance: big ? 10 : 7, angle: Math.PI / 2 },
            letterSpacing: 0,
          }),
        });
        text.anchor.set(0.5);
        const holder = new Container();
        holder.addChild(text);
        holder.label = `line${lineIndex}`;
        this.logo.addChild(holder);
        this.letters.push({ holder, text, phase: this.letters.length * 0.7 });
      }
    });
  }

  private layoutLetters(line1Y: number, line2Y: number): void {
    const byLine = new Map<string, Letter[]>();
    for (const l of this.letters) {
      const key = l.holder.label;
      const arr = byLine.get(key) ?? [];
      arr.push(l);
      byLine.set(key, arr);
    }
    const lineKeys = [...byLine.keys()];
    lineKeys.forEach((key, i) => {
      const list = byLine.get(key) ?? [];
      const widths = list.map((l) => l.text.width / Math.max(0.001, Math.abs(l.text.scale.x)));
      const total = widths.reduce((a, b) => a + b, 0) + LETTER_KERN * (list.length - 1);
      let x = -total / 2;
      const y = lineKeys.length > 1 && i === 0 ? line1Y : line2Y;
      list.forEach((l, j) => {
        l.holder.position.set(x + widths[j] / 2, y);
        x += widths[j] + LETTER_KERN;
      });
    });
  }

  private buildSubtitle(): void {
    const label = new Text({
      text: T.menu.subtitle,
      style: textStyle('heading', { fontSize: 34, fill: 0xfff4e0, stroke: { color: shade(SUBTITLE_BG, 0.6), width: 4 } }),
    });
    label.anchor.set(0.5);
    const w = label.width + 64;
    const h = label.height + 22;
    const pill = new Graphics()
      .roundRect(-w / 2, -h / 2 + 5, w, h, h / 2)
      .fill({ color: 0x000000, alpha: 0.18 })
      .roundRect(-w / 2, -h / 2, w, h, h / 2)
      .fill({ color: SUBTITLE_BG, alpha: 0.92 })
      .stroke({ width: 4, color: shade(SUBTITLE_BG, 0.6) });
    this.subtitle.addChild(pill, label);
  }

  private addButton(label: string, color: number, primary: boolean, onTap: () => void): void {
    const btn = new Button({ label, width: BTN_W, height: BTN_H, color, fontSize: 44, onTap });
    const holder = centeredButton(btn, BTN_W, BTN_H);
    this.addChild(holder);
    this.buttons.push({ holder, primary });
  }

  private async playIntro(): Promise<void> {
    // 글자는 위에서 통통 떨어지고, 부제·버튼은 차례로 팡
    this.letters.forEach((l, i) => {
      l.text.y = -260;
      l.text.alpha = 0;
      l.text.scale.set(0.6);
      const d = 0.06 * i;
      void tween(l.text, { y: -260 }, d).then(() => {
        void tween(l.text, { y: 0, alpha: 1 }, 0.55, 'outBack');
        void tween(l.text.scale, { x: 1, y: 1 }, 0.6, 'outElastic');
      });
    });
    this.subtitle.alpha = 0;
    this.subtitle.scale.set(0.4);
    for (const b of this.buttons) b.holder.scale.set(0);

    const lettersEnd = 0.06 * this.letters.length + 0.35;
    await tween(this.subtitle, { alpha: 0 }, lettersEnd);
    if (this.destroyed) return;
    void tween(this.subtitle, { alpha: 1 }, 0.2);
    await tween(this.subtitle.scale, { x: 1, y: 1 }, 0.35, 'outBack');
    if (this.destroyed) return;
    for (let i = 0; i < this.buttons.length; i++) {
      const h = this.buttons[i].holder;
      await tween(h.scale, { x: 0 }, i === 0 ? 0 : 0.08);
      if (this.destroyed) return;
      void tween(h.scale, { x: 1, y: 1 }, 0.45, 'outBack');
    }
    await tween(this.subtitle, { alpha: 1 }, 0.45);
    if (this.destroyed) return;
    this.introDone = true;
  }

  private onConfirmKey(): void {
    if (this.settingsDialog) return;
    if (this.dialog) {
      this.dialog.confirm();
      return;
    }
    if (this.hasSave) this.continueRun();
    else this.startNewRun();
  }

  private continueRun(): void {
    if (this.leaving || this.dialog || this.settingsDialog) return;
    this.leaving = true;
    game.continueRun();
  }

  private startNewRun(): void {
    if (this.leaving) return;
    this.leaving = true;
    game.toCharacterSelect();
  }

  private requestNewRun(): void {
    if (this.leaving || this.dialog || this.settingsDialog) return;
    const dialog = new ConfirmDialog(T.menu.confirmNewRun, {
      onYes: () => {
        this.closeDialog();
        this.startNewRun();
      },
      onNo: () => this.closeDialog(),
    });
    this.dialog = dialog;
    this.addChild(dialog);
    if (this.vp) dialog.layout(this.vp);
    dialog.open();
  }

  private openSettings(): void {
    if (this.leaving || this.dialog || this.settingsDialog) return;
    const d = new SettingsDialog(() => this.closeSettings());
    this.settingsDialog = d;
    this.addChild(d);
    if (this.vp) d.layout(this.vp);
    d.open();
  }

  private closeSettings(): void {
    const d = this.settingsDialog;
    this.settingsDialog = null;
    if (d) void d.close();
  }

  private closeDialog(): void {
    const d = this.dialog;
    this.dialog = null;
    if (d) void d.close();
  }
}

/** 화면을 어둡게 덮는 예/아니오 확인 창. 바깥을 누르면 아니오 */
class ConfirmDialog extends Container {
  private readonly dim = new Graphics();
  private readonly box = new Container();
  private readonly panel: Panel;
  private readonly message: Text;
  private readonly yes: Button;
  private readonly no: Button;
  private readonly handlers: { onYes: () => void; onNo: () => void };
  private closing = false;

  private static readonly W = 580;
  private static readonly PAD = 36;
  private static readonly BTN_W = 236;
  private static readonly BTN_H = 96;

  constructor(text: string, handlers: { onYes: () => void; onNo: () => void }) {
    super();
    this.handlers = handlers;
    const { W, PAD, BTN_W: bw, BTN_H: bh } = ConfirmDialog;

    this.dim.eventMode = 'static';
    this.dim.on('pointertap', () => this.cancel());
    this.addChild(this.dim, this.box);

    this.message = new Text({
      text,
      style: textStyle('body', { fontSize: 32, lineHeight: 46, align: 'center', wordWrap: true, wordWrapWidth: W - PAD * 2 }),
    });
    this.message.anchor.set(0.5, 0);
    const h = PAD + this.message.height + 36 + bh + PAD;
    this.panel = new Panel(W, h, { color: UI_COLORS.panel, border: UI_COLORS.panelBorder, radius: 32 });
    this.panel.position.set(-W / 2, -h / 2);
    // 패널을 눌러도 바깥 탭(취소)으로 새지 않게
    this.panel.eventMode = 'static';
    this.panel.hitArea = new Rectangle(0, 0, W, h);
    this.message.position.set(0, -h / 2 + PAD);

    this.no = new Button({ label: T.common.no, width: bw, height: bh, color: UI_COLORS.panelBorder, sound: 'ui_back', onTap: () => this.cancel() });
    this.yes = new Button({ label: T.common.yes, width: bw, height: bh, color: UI_COLORS.bad, onTap: () => this.confirm() });
    const by = h / 2 - PAD - bh;
    this.no.position.set(-bw - 12, by);
    this.yes.position.set(12, by);
    this.box.addChild(this.panel, this.message, this.no, this.yes);
  }

  layout(vp: Viewport): void {
    this.dim.clear().rect(0, 0, vp.width, vp.height).fill({ color: 0x000000, alpha: 0.55 });
    this.dim.hitArea = new Rectangle(0, 0, vp.width, vp.height);
    this.box.position.set(vp.width / 2, vp.height * 0.48);
  }

  open(): void {
    this.dim.alpha = 0;
    this.box.scale.set(0.6);
    this.box.alpha = 0;
    void tween(this.dim, { alpha: 1 }, 0.15);
    void tween(this.box, { alpha: 1 }, 0.12);
    void tween(this.box.scale, { x: 1, y: 1 }, 0.3, 'outBack');
  }

  confirm(): void {
    if (this.closing) return;
    this.handlers.onYes();
  }

  cancel(): void {
    if (this.closing) return;
    this.handlers.onNo();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.eventMode = 'none';
    killTweensOf(this.box.scale);
    void tween(this.dim, { alpha: 0 }, 0.14);
    await tween(this.box.scale, { x: 0.7, y: 0.7 }, 0.14, 'inQuad');
    this.dispose();
  }

  dispose(): void {
    killTweensOf(this.dim);
    killTweensOf(this.box);
    killTweensOf(this.box.scale);
    if (!this.destroyed) {
      this.removeFromParent();
      this.destroy({ children: true });
    }
  }
}
