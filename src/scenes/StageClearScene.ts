// 스테이지 클리어: 리본 배너 + 별 팡팡 + 색종이, 처치/골드/보너스/회복 카운트업, 드롭 아이템 칩.
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { sfx } from '../audio';
import { UI_COLORS } from '../config';
import { COUNT_TICK_INTERVAL, COUNT_TICK_VOLUME } from '../data/sfxMap';
import type { Viewport } from '../core/app';
import { Keyboard } from '../core/keyboard';
import { Scene } from '../core/scene';
import { killTweensOf, tween } from '../core/tween';
import { game, type StageSummary } from '../game';
import { T } from '../i18n/ko';
import { tex } from '../render/assets';
import { Button, OUTLINE_COLOR, Panel, textStyle } from '../ui';
import { ConfettiLayer, CountUp, SunBurst, centeredButton, coverSprite, drawRibbon, drawStar, itemChip } from './menuFx';

// ─────────────────────────────────────────────────────────────
// 씬
// ─────────────────────────────────────────────────────────────

const PANEL_W = 620;
const ROW_H = 84;
const ROW_PAD = 22;
const CHIP = 96;
const CHIP_GAP = 14;
const CHIPS_PER_ROW = 5;
const BTN_W = 460;
const BTN_H = 116;
const BANNER_W = 520;
const BANNER_H = 112;
const BANNER_COLOR = 0xff9f1c;
const STAR_COLOR = 0xffd23f;
const ENDING_COLOR = 0xb46cff;
const BURST_COLOR = 0xffd98a;

interface StatRow {
  root: Container;
  body: Container;
  value: Text;
  count: CountUp;
}

export class StageClearScene extends Scene {
  readonly sceneName = 'StageClearScene';

  private readonly bg = new Sprite(tex('bg_toyroom'));
  private readonly dim = new Graphics();
  private readonly burst = new SunBurst(620, BURST_COLOR);
  private readonly confetti = new ConfettiLayer();
  private readonly header = new Container();
  private readonly bannerBody = new Container();
  private readonly stars: Container[] = [];
  private readonly panel: Panel;
  private readonly rows: StatRow[] = [];
  private readonly dropsBlock = new Container();
  private readonly dropChips: Container[] = [];
  private readonly totalText: Text;
  private readonly buttonHolder: Container;
  private readonly button: Button;
  /** onEnter에서 만든다 (진입 전에 다른 goto로 버려진 씬이 window 키 리스너를 남기지 않게) */
  private keyboard: Keyboard | null = null;
  private readonly tapCatcher = new Graphics();
  private readonly panelH: number;
  private readonly dropsH: number;
  private vp: Viewport | null = null;
  private leaving = false;
  private introDone = false;
  private clock = 0;
  /** 카운트업 틱 소리: 마지막 틱 시각 / 건너뛰기로 한 번에 채웠으면 틱 없음 */
  private lastTick = -Infinity;
  private skipped = false;

  constructor(readonly summary: StageSummary) {
    super();
    this.dim.eventMode = 'none';
    this.tapCatcher.eventMode = 'static';
    this.tapCatcher.on('pointertap', () => this.skipIntro());
    this.addChild(this.bg, this.dim, this.tapCatcher, this.burst, this.header);

    // 배너 + 별 3개
    const ribbon = drawRibbon(new Graphics(), BANNER_W, BANNER_H, BANNER_COLOR);
    const title = new Text({
      text: T.menu.stageClearN(summary.stageIndex + 1),
      style: textStyle('title', { fontSize: 58, stroke: { color: OUTLINE_COLOR, width: 9, join: 'round' }, dropShadow: false }),
    });
    title.anchor.set(0.5);
    if (title.width > BANNER_W - 30) title.scale.set((BANNER_W - 30) / title.width);
    this.bannerBody.addChild(ribbon, title);
    this.header.addChild(this.bannerBody);
    for (let i = 0; i < 3; i++) {
      const star = new Container();
      star.addChild(drawStar(new Graphics(), i === 1 ? 62 : 48, STAR_COLOR));
      star.position.set((i - 1) * 132, i === 1 ? -126 : -100);
      star.rotation = (i - 1) * 0.22;
      this.stars.push(star);
      this.header.addChild(star);
    }

    // 통계 줄
    // 마지막 스테이지(런 끝)는 클리어 보너스가 데이터상 0이고 회복도 의미가 없으므로 0이면 줄을 뺀다
    const showClearGold = !summary.finished || summary.clearGold > 0;
    const showHealed = !summary.finished || summary.healed > 0;
    const rowCount = 2 + (showClearGold ? 1 : 0) + (showHealed ? 1 : 0);
    const rowsH = ROW_PAD * 2 + ROW_H * rowCount;
    this.dropsH = this.buildDrops();
    this.panelH = rowsH + this.dropsH;
    this.panel = new Panel(PANEL_W, this.panelH, { radius: 30 });
    this.addChild(this.panel);
    this.addRow('enemy_soldier', T.menu.kills, summary.kills, (n) => String(n), UI_COLORS.text);
    this.addRow('ui_coin', T.menu.goldEarned, summary.goldEarned, T.menu.plus, UI_COLORS.gold);
    if (showClearGold) this.addRow('ui_coin', T.menu.clearGold, summary.clearGold, T.menu.plus, UI_COLORS.gold, true);
    if (showHealed) this.addRow('ui_heart', T.menu.healed, summary.healed, T.menu.plus, UI_COLORS.hp);
    this.rows.forEach((r, i) => r.root.position.set(0, ROW_PAD + i * ROW_H));
    this.dropsBlock.position.set(0, rowsH);
    this.panel.addChild(...this.rows.map((r) => r.root), this.dropsBlock);

    this.totalText = new Text({
      text: game.run ? T.menu.totalGold(game.run.gold) : '',
      style: textStyle('number', { fontSize: 30, fill: UI_COLORS.gold }),
    });
    this.totalText.anchor.set(0.5);
    this.addChild(this.totalText);

    const finished = summary.finished;
    this.button = new Button({
      label: finished ? T.menu.viewEnding : T.menu.toShop,
      width: BTN_W,
      height: BTN_H,
      color: finished ? ENDING_COLOR : UI_COLORS.good,
      fontSize: 44,
      onTap: () => this.proceed(),
    });
    this.buttonHolder = centeredButton(this.button, BTN_W, BTN_H);
    this.addChild(this.buttonHolder, this.confetti);
  }

  override onEnter(): void {
    const kb = (this.keyboard = new Keyboard());
    kb.onPress('Enter', () => this.proceed());
    kb.onPress('Space', () => this.proceed());
    void this.playIntro();
  }

  override onExit(): void {
    this.keyboard?.dispose();
    this.keyboard = null;
    this.killAllTweens();
  }

  layout(vp: Viewport): void {
    this.vp = vp;
    const w = vp.width;
    const h = vp.height;
    coverSprite(this.bg, w, h);
    this.dim.clear().rect(0, 0, w, h).fill({ color: UI_COLORS.bg, alpha: 0.72 });
    this.tapCatcher.clear().rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.001 });
    this.confetti.setBottom(h);

    const top = vp.safeTop + 20;
    const bottom = h - vp.safeBottom;
    const btnY = bottom - 40 - BTN_H / 2;
    // 배너(별 포함) · 패널 · 보유 골드 묶음을 버튼 위 공간 가운데에
    const headerAbove = 200; // 배너 중심 위로 별까지
    const headerBelow = 84; // 배너 중심 아래로 리본 꼬리까지
    const totalH = 50;
    const avail = btnY - BTN_H / 2 - 24 - top;
    const content = headerAbove + headerBelow + this.panelH + totalH;
    const gap = Math.max(20, Math.min(56, (avail - content) / 4));
    const blockH = content + gap * 2;
    const start = top + Math.max(0, (avail - blockH) / 2);
    const headerY = start + headerAbove;
    this.header.position.set(w / 2, headerY);
    this.burst.position.set(w / 2, headerY - 40);
    const panelTop = headerY + headerBelow + gap;
    this.panel.position.set((w - PANEL_W) / 2, panelTop);
    this.totalText.position.set(w / 2, panelTop + this.panelH + gap + totalH / 2 - 10);
    this.buttonHolder.position.set(w / 2, btnY);
  }

  override update(dt: number): void {
    this.clock += dt;
    this.burst.update(dt);
    this.confetti.update(dt);
    for (const r of this.rows) {
      // 숫자가 올라가는 동안 작은 동전 '틱' (간격 제한, 끝으로 갈수록 음이 오름)
      if (r.count.sync() && this.clock - this.lastTick >= COUNT_TICK_INTERVAL && !this.skipped) {
        this.lastTick = this.clock;
        sfx.playAt('coin', 0, 0.9 + 0.35 * r.count.progress, COUNT_TICK_VOLUME);
      }
    }
    if (this.introDone) {
      const k = 1 + Math.sin(this.clock * 3.4) * 0.025;
      this.buttonHolder.scale.set(k);
    }
  }

  // ───────────────────────────────────────────────────────────

  private addRow(icon: string, label: string, value: number, fmt: (n: number) => string, color: number, bonus = false): void {
    const root = new Container();
    const body = new Container();
    root.addChild(body);
    const pad = 34;
    if (this.rows.length > 0) {
      body.addChild(new Graphics().rect(pad, 0, PANEL_W - pad * 2, 2).fill({ color: UI_COLORS.panelBorder, alpha: 0.5 }));
    }
    const sprite = new Sprite(tex(icon));
    sprite.anchor.set(0.5);
    const iconSize = 54;
    sprite.scale.set(iconSize / Math.max(1, sprite.texture.width, sprite.texture.height));
    sprite.position.set(pad + iconSize / 2, ROW_H / 2);
    body.addChild(sprite);
    if (bonus) {
      const star = drawStar(new Graphics(), 14, STAR_COLOR);
      star.position.set(pad + iconSize - 4, ROW_H / 2 + 18);
      body.addChild(star);
    }
    const text = new Text({ text: label, style: textStyle('body', { fontSize: 32 }) });
    text.anchor.set(0, 0.5);
    text.position.set(pad + iconSize + 22, ROW_H / 2);
    const valueText = new Text({ text: '0', style: textStyle('number', { fontSize: 42, fill: color }) });
    valueText.anchor.set(1, 0.5);
    valueText.position.set(PANEL_W - pad, ROW_H / 2);
    body.addChild(text, valueText);
    this.rows.push({ root, body, value: valueText, count: new CountUp(valueText, Math.max(0, Math.round(value)), fmt) });
  }

  /** 드롭 칩 블록을 만들고 높이 반환 */
  private buildDrops(): number {
    const pad = 34;
    const label = new Text({ text: T.menu.drops, style: textStyle('small', { fontSize: 24 }) });
    label.position.set(pad, 6);
    const sep = new Graphics().rect(pad, 0, PANEL_W - pad * 2, 2).fill({ color: UI_COLORS.panelBorder, alpha: 0.5 });
    this.dropsBlock.addChild(sep, label);
    const chipsTop = 46;
    const drops = this.summary.drops;
    if (drops.length === 0) {
      const none = new Text({ text: T.menu.noDrops, style: textStyle('body', { fontSize: 28, fill: UI_COLORS.textDim }) });
      none.anchor.set(0.5, 0);
      none.position.set(PANEL_W / 2, chipsTop);
      this.dropsBlock.addChild(none);
      return chipsTop + 40 + 26;
    }
    const perRow = Math.min(CHIPS_PER_ROW, drops.length);
    const rowsN = Math.ceil(drops.length / CHIPS_PER_ROW);
    drops.forEach((d, i) => {
      const col = i % CHIPS_PER_ROW;
      const row = Math.floor(i / CHIPS_PER_ROW);
      const inRow = row === rowsN - 1 ? drops.length - row * CHIPS_PER_ROW : perRow;
      const rowW = inRow * CHIP + (inRow - 1) * CHIP_GAP;
      const holder = new Container();
      const chip = itemChip(d.defId, d.tier, CHIP);
      chip.position.set(-CHIP / 2, -CHIP / 2);
      holder.addChild(chip);
      holder.position.set((PANEL_W - rowW) / 2 + col * (CHIP + CHIP_GAP) + CHIP / 2, chipsTop + row * (CHIP + CHIP_GAP) + CHIP / 2);
      this.dropChips.push(holder);
      this.dropsBlock.addChild(holder);
    });
    return chipsTop + rowsN * CHIP + (rowsN - 1) * CHIP_GAP + 28;
  }

  private alive(): boolean {
    return !this.destroyed && !this.leaving;
  }

  private async playIntro(): Promise<void> {
    // 초기 상태
    this.bannerBody.scale.set(0);
    for (const s of this.stars) s.scale.set(0);
    this.burst.alpha = 0;
    this.panel.alpha = 0;
    for (const r of this.rows) {
      r.body.alpha = 0;
      r.body.x = 60;
    }
    for (const c of this.dropChips) c.scale.set(0);
    this.totalText.alpha = 0;
    this.buttonHolder.scale.set(0);

    // 배너 쾅 + 색종이
    void tween(this.burst, { alpha: 1 }, 0.4);
    await tween(this.bannerBody.scale, { x: 1, y: 1 }, 0.45, 'outBack');
    if (!this.alive()) return;
    const vpw = this.vp?.width ?? 720;
    this.confetti.burst(vpw / 2, this.header.y, 70);
    for (let i = 0; i < this.stars.length; i++) {
      void tween(this.stars[i].scale, { x: 1, y: 1 }, 0.4, 'outElastic');
      await tween(this.stars[i], { alpha: 1 }, 0.12);
      if (!this.alive()) return;
    }
    void tween(this.panel, { alpha: 1 }, 0.2);

    // 줄마다 슥 들어와서 숫자 카운트업
    for (const r of this.rows) {
      void tween(r.body, { alpha: 1, x: 0 }, 0.22, 'outQuad');
      await r.count.play(0.5);
      if (!this.alive()) return;
      r.value.scale.set(1.35);
      void tween(r.value.scale, { x: 1, y: 1 }, 0.25, 'outBack');
    }
    for (const c of this.dropChips) {
      await tween(c.scale, { x: 1, y: 1 }, 0.16, 'outBack');
      if (!this.alive()) return;
    }
    void tween(this.totalText, { alpha: 1 }, 0.25);
    await tween(this.buttonHolder.scale, { x: 1, y: 1 }, 0.4, 'outBack');
    if (!this.alive()) return;
    this.introDone = true;
  }

  /** 화면을 누르면 연출을 건너뛰고 바로 결과 표시 */
  private skipIntro(): void {
    if (this.introDone || this.leaving) return;
    this.skipped = true;
    this.killAllTweens();
    this.bannerBody.scale.set(1);
    for (const s of this.stars) {
      s.scale.set(1);
      s.alpha = 1;
    }
    this.burst.alpha = 1;
    this.panel.alpha = 1;
    for (const r of this.rows) {
      r.body.alpha = 1;
      r.body.x = 0;
      r.value.scale.set(1);
      r.count.finish();
    }
    for (const c of this.dropChips) c.scale.set(1);
    this.totalText.alpha = 1;
    this.buttonHolder.scale.set(1);
    this.introDone = true;
  }

  private killAllTweens(): void {
    killTweensOf(this.bannerBody.scale);
    for (const s of this.stars) {
      killTweensOf(s);
      killTweensOf(s.scale);
    }
    killTweensOf(this.burst);
    killTweensOf(this.panel);
    for (const r of this.rows) {
      killTweensOf(r.body);
      killTweensOf(r.value.scale);
      killTweensOf(r.count);
    }
    for (const c of this.dropChips) killTweensOf(c.scale);
    killTweensOf(this.totalText);
    killTweensOf(this.buttonHolder.scale);
  }

  private proceed(): void {
    if (this.leaving) return;
    const run = game.run;
    this.leaving = true;
    if (!run) {
      game.toTitle();
      return;
    }
    if (this.summary.finished) {
      game.toResult({
        won: true,
        stageIndex: this.summary.stageIndex,
        characterId: run.characterId,
        stats: { ...run.stats },
      });
    } else {
      game.toShop();
    }
  }
}
