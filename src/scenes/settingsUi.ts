// 설정 UI: 스피커 켜기/끄기 버튼(전투 가방 오버레이 · 상점 상단 바) + 설정 창(타이틀 — 효과음, 볼륨, 그래픽 품질).
// 값은 core/settings의 updateSettings로만 바꾼다 (저장 + 오디오·화질이 onSettingsChange로 바로 반영).
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { sfx } from '../audio';
import { UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { onSettingsChange, settings, updateSettings, type Quality } from '../core/settings';
import { killTweensOf, tween } from '../core/tween';
import { T } from '../i18n/ko';
import { shade } from '../render/color';
import { Button, Panel, textStyle } from '../ui';

/** 볼륨 단계 (설정 창). 저장값은 0..1 */
export const VOLUME_STEPS = [0.2, 0.4, 0.6, 0.8, 1] as const;

/** 저장된 볼륨과 가장 가까운 단계 (0부터) */
export function volumeStepIndex(v: number): number {
  let best = 0;
  for (let i = 1; i < VOLUME_STEPS.length; i++) {
    if (Math.abs(VOLUME_STEPS[i] - v) < Math.abs(VOLUME_STEPS[best] - v)) best = i;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// 스피커 버튼
// ─────────────────────────────────────────────────────────────

/** 동그란 스피커 버튼 (원점 = 좌상단, size × size). 누르면 효과음 켜기/끄기 */
export class SoundToggle extends Container {
  private readonly g = new Graphics();
  private readonly face = new Container();
  private readonly unsubscribe: () => void;

  constructor(private readonly size: number) {
    super();
    this.face.pivot.set(size / 2, size / 2);
    this.face.position.set(size / 2, size / 2);
    this.face.addChild(this.g);
    this.addChild(this.face);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    // 손가락이 닿기 쉽게 보이는 것보다 조금 넓게
    this.hitArea = new Rectangle(-8, -8, size + 16, size + 16);
    this.on('pointertap', this.toggle);
    this.unsubscribe = onSettingsChange(() => this.redraw());
    this.redraw();
  }

  private readonly toggle = (): void => {
    const muted = !settings.muted;
    updateSettings({ muted });
    // 켰을 때만 확인 소리 (끌 때는 이미 꺼짐)
    if (!muted) sfx.play('ui_tap');
    killTweensOf(this.face.scale);
    this.face.scale.set(0.85);
    void tween(this.face.scale, { x: 1, y: 1 }, 0.2, 'outBack');
  };

  private redraw(): void {
    const s = this.size;
    const muted = settings.muted;
    const g = this.g;
    const r = s / 2;
    g.clear();
    g.circle(r, r + 3, r).fill({ color: 0x000000, alpha: 0.3 });
    g.circle(r, r, r).fill(muted ? 0x4a3a5c : UI_COLORS.panelLight).stroke({ width: 3, color: muted ? UI_COLORS.panelBorder : 0xb9a9cf });
    const ink = muted ? 0xb9a9cf : 0xffffff;
    // 스피커: 작은 상자 + 나팔
    const cx = s * 0.4;
    const cy = r;
    const u = s / 44;
    g.poly([cx - 9 * u, cy - 5 * u, cx - 3 * u, cy - 5 * u, cx + 5 * u, cy - 11 * u, cx + 5 * u, cy + 11 * u, cx - 3 * u, cy + 5 * u, cx - 9 * u, cy + 5 * u]).fill(ink);
    if (muted) {
      const x0 = cx + 10 * u;
      g.moveTo(x0, cy - 6 * u).lineTo(x0 + 11 * u, cy + 6 * u).moveTo(x0 + 11 * u, cy - 6 * u).lineTo(x0, cy + 6 * u);
      g.stroke({ width: 3.2 * u, color: UI_COLORS.bad, cap: 'round' });
    } else {
      // 소리 물결 두 줄 (arc는 현재 점에서 이어 그리므로 시작점으로 먼저 옮긴다)
      for (const rr of [7 * u, 13 * u]) {
        const ox = cx + 6 * u;
        g.moveTo(ox + rr * Math.cos(-0.9), cy + rr * Math.sin(-0.9))
          .arc(ox, cy, rr, -0.9, 0.9)
          .stroke({ width: 2.8 * u, color: ink, cap: 'round' });
      }
    }
    this.accessibleTitle = muted ? T.menu.settings.unmuteLabel : T.menu.settings.muteLabel;
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.unsubscribe();
    killTweensOf(this.face.scale);
    super.destroy(options);
  }
}

// ─────────────────────────────────────────────────────────────
// 설정 창
// ─────────────────────────────────────────────────────────────

const W = 600;
const PAD = 36;
const ROW_H = 92;
const LABEL_W = 190;
const SEG_H = 76;
const SEL_COLOR = 0x4cc96b;
const OFF_COLOR = UI_COLORS.panelBorder;

/** 화면을 어둡게 덮는 설정 창. 바깥을 누르거나 닫기·Esc로 닫힘 */
export class SettingsDialog extends Container {
  private readonly dim = new Graphics();
  private readonly box = new Container();
  private readonly sfxOn: Button;
  private readonly sfxOff: Button;
  private readonly volDown: Button;
  private readonly volUp: Button;
  private readonly volBar = new Graphics();
  private readonly volText: Text;
  private readonly qHigh: Button;
  private readonly qLow: Button;
  private readonly unsubscribe: () => void;
  /** 볼륨 막대 폭 / 창 높이(배율 전) */
  private readonly barW: number;
  private readonly boxH: number;
  private closing = false;

  constructor(private readonly onClose: () => void) {
    super();
    this.dim.eventMode = 'static';
    this.dim.on('pointertap', () => this.cancel());
    this.addChild(this.dim, this.box);

    const title = new Text({ text: T.menu.settings.title, style: textStyle('heading', { fontSize: 42 }) });
    title.anchor.set(0.5, 0);

    const rows = 3;
    const h = PAD + 56 + 24 + rows * ROW_H + 30 + 22 + 96 + PAD;
    this.boxH = h;
    const panel = new Panel(W, h, { color: UI_COLORS.panel, border: UI_COLORS.panelBorder, radius: 32 });
    panel.position.set(-W / 2, -h / 2);
    // 패널을 눌러도 바깥 탭(닫기)으로 새지 않게
    panel.eventMode = 'static';
    panel.hitArea = new Rectangle(0, 0, W, h);
    title.position.set(0, -h / 2 + PAD);
    this.box.addChild(panel, title);

    const left = -W / 2 + PAD;
    const ctrlX = left + LABEL_W;
    const ctrlW = W / 2 - PAD - ctrlX;
    let y = -h / 2 + PAD + 56 + 24;
    const label = (text: string, rowY: number): void => {
      const t = new Text({ text, style: textStyle('body', { fontSize: 30 }) });
      t.anchor.set(0, 0.5);
      t.position.set(left, rowY + ROW_H / 2);
      this.box.addChild(t);
    };
    const segW = (ctrlW - 12) / 2;
    const seg = (text: string, x: number, rowY: number, onTap: () => void, sound: 'ui_tap' | null = 'ui_tap'): Button => {
      const b = new Button({ label: text, width: segW, height: SEG_H, color: OFF_COLOR, fontSize: 30, sound, onTap });
      b.position.set(x, rowY + (ROW_H - SEG_H) / 2);
      this.box.addChild(b);
      return b;
    };

    // 효과음 켜기 / 끄기 — 버튼 자체 소리는 없이: 켜기는 켠 뒤에 확인 소리(누르는 순간엔 아직 꺼져 있음), 끄기는 조용히
    label(T.menu.settings.sfx, y);
    this.sfxOn = seg(T.menu.settings.on, ctrlX, y, () => this.setMuted(false), null);
    this.sfxOff = seg(T.menu.settings.off, ctrlX + segW + 12, y, () => this.setMuted(true), null);
    y += ROW_H;

    // 볼륨: [−] 막대 [+]
    label(T.menu.settings.volume, y);
    const small = SEG_H;
    this.volDown = new Button({ label: '−', width: small, height: SEG_H, color: UI_COLORS.accent, fontSize: 40, sound: null, onTap: () => this.stepVolume(-1) });
    this.volUp = new Button({ label: '+', width: small, height: SEG_H, color: UI_COLORS.accent, fontSize: 40, sound: null, onTap: () => this.stepVolume(1) });
    this.volDown.position.set(ctrlX, y + (ROW_H - SEG_H) / 2);
    this.volUp.position.set(ctrlX + ctrlW - small, y + (ROW_H - SEG_H) / 2);
    const barX = ctrlX + small + 14;
    const barW = ctrlW - small * 2 - 28;
    this.volBar.position.set(barX, y + ROW_H / 2 - 4);
    this.volBar.eventMode = 'none';
    this.volText = new Text({ text: '', style: textStyle('small', { fontSize: 20, fill: UI_COLORS.textDim }) });
    this.volText.anchor.set(0.5, 0);
    this.volText.position.set(barX + barW / 2, y + ROW_H / 2 + 14);
    this.box.addChild(this.volDown, this.volUp, this.volBar, this.volText);
    this.barW = barW;
    y += ROW_H;

    // 그래픽 품질 높음 / 낮음
    label(T.menu.settings.quality, y);
    this.qHigh = seg(T.menu.settings.qualityHigh, ctrlX, y, () => this.setQuality('high'));
    this.qLow = seg(T.menu.settings.qualityLow, ctrlX + segW + 12, y, () => this.setQuality('low'));
    y += ROW_H;
    const hint = new Text({ text: T.menu.settings.qualityHint, style: textStyle('small', { fontSize: 22, fill: UI_COLORS.textDim }) });
    hint.anchor.set(1, 0);
    hint.position.set(W / 2 - PAD, y - 4);
    this.box.addChild(hint);
    y += 30 + 22;

    const closeBtn = new Button({ label: T.menu.settings.close, width: 260, height: 96, color: UI_COLORS.panelBorder, sound: 'ui_back', onTap: () => this.cancel() });
    closeBtn.position.set(-130, y);
    this.box.addChild(closeBtn);

    this.unsubscribe = onSettingsChange(() => this.sync());
    this.sync();
  }

  layout(vp: Viewport): void {
    this.dim.clear().rect(0, 0, vp.width, vp.height).fill({ color: 0x000000, alpha: 0.55 });
    this.dim.hitArea = new Rectangle(0, 0, vp.width, vp.height);
    this.box.position.set(vp.width / 2, vp.height * 0.48);
    // 아주 낮은 화면에서도 다 보이게
    const s = Math.min(1, (vp.height - vp.safeTop - vp.safeBottom - 40) / this.boxH);
    this.box.scale.set(s);
  }

  open(): void {
    this.dim.alpha = 0;
    const s = this.box.scale.x;
    this.box.scale.set(s * 0.6);
    this.box.alpha = 0;
    void tween(this.dim, { alpha: 1 }, 0.15);
    void tween(this.box, { alpha: 1 }, 0.12);
    void tween(this.box.scale, { x: s, y: s }, 0.3, 'outBack');
  }

  /** 닫기 (바깥 탭·닫기 버튼·Esc) */
  cancel(): void {
    if (this.closing) return;
    this.onClose();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.eventMode = 'none';
    killTweensOf(this.box.scale);
    const s = this.box.scale.x;
    void tween(this.dim, { alpha: 0 }, 0.14);
    await tween(this.box.scale, { x: s * 0.7, y: s * 0.7 }, 0.14, 'inQuad');
    this.dispose();
  }

  dispose(): void {
    this.unsubscribe();
    killTweensOf(this.dim);
    killTweensOf(this.box);
    killTweensOf(this.box.scale);
    if (!this.destroyed) {
      this.removeFromParent();
      this.destroy({ children: true, context: true });
    }
  }

  private setMuted(muted: boolean): void {
    updateSettings({ muted });
    if (!muted) sfx.play('ui_tap');
  }

  private stepVolume(dir: number): void {
    const i = Math.max(0, Math.min(VOLUME_STEPS.length - 1, volumeStepIndex(settings.sfxVolume) + dir));
    // 볼륨을 만지면 소리도 켠다 (꺼진 채 볼륨만 바뀌면 헷갈림)
    updateSettings({ sfxVolume: VOLUME_STEPS[i], muted: false });
    // 바뀐 크기로 미리 들려주기
    sfx.play('ui_tap');
  }

  private setQuality(q: Quality): void {
    updateSettings({ quality: q });
  }

  private sync(): void {
    if (this.destroyed) return;
    const muted = settings.muted;
    this.sfxOn.setColor(muted ? OFF_COLOR : SEL_COLOR);
    this.sfxOff.setColor(muted ? UI_COLORS.bad : OFF_COLOR);
    const step = volumeStepIndex(settings.sfxVolume);
    this.volDown.setEnabled(step > 0);
    this.volUp.setEnabled(step < VOLUME_STEPS.length - 1);
    const n = VOLUME_STEPS.length;
    const gap = 6;
    const w = (this.barW - gap * (n - 1)) / n;
    const g = this.volBar.clear();
    for (let i = 0; i < n; i++) {
      const on = i <= step;
      const color = on ? (muted ? shade(UI_COLORS.gold, 0.55) : UI_COLORS.gold) : 0x1d1329;
      g.roundRect(i * (w + gap), -12 - i * 2, w, 20 + i * 4, 5).fill(color).stroke({ width: 2, color: UI_COLORS.panelBorder });
    }
    this.volText.text = T.menu.settings.volumeStep(step + 1, n);
    const high = settings.quality === 'high';
    this.qHigh.setColor(high ? SEL_COLOR : OFF_COLOR);
    this.qLow.setColor(high ? OFF_COLOR : SEL_COLOR);
  }
}
