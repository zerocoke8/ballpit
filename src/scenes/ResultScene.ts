// 결과: 승리(색종이 + 신난 초상화) / 패배(축 처진 초상화) + 통계 + 다시 하기 / 타이틀로.
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { sfx } from '../audio';
import { UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { Keyboard } from '../core/keyboard';
import { Scene } from '../core/scene';
import { killTweensOf, tween } from '../core/tween';
import { game, type RunResult } from '../game';
import { T } from '../i18n/ko';
import { tex } from '../render/assets';
import { Button, OUTLINE_COLOR, Panel, textStyle } from '../ui';
import { ConfettiLayer, CountUp, SunBurst, centeredButton, coverSprite, drawStar } from './menuFx';

/** 전투에서 패배 징글이 울린 지 이보다(초) 오래면 결과 화면에서 다시 울린다 */
const DEFEAT_JINGLE_GAP = 5;
const WIN_TITLE_COLOR = 0xffd23f;
const LOSE_TITLE_COLOR = 0x9fb3d9;
const LOSE_TINT = 0xaab4cc;
const LOSE_DIM_ALPHA = 0.84;
const LOSE_DIM_COLOR = 0x141a2e;
const PORTRAIT_SIZE = 300;
const PANEL_W = 600;
const ROW_H = 76;
const ROW_PAD = 20;
const BTN_W = 460;
const BTN_H = 112;
const SUB_BTN_H = 92;
const RETRY_COLOR = 0x4cc96b;
const CONFETTI_INTERVAL = 0.45;
const TEAR_COLOR = 0x6fd8ff;
const CLOUD_COLOR = 0x8a93b0;
const RAIN_DROPS = 6;
const WIN_DIM = 0.7;
const CLOUD_SPACE = 100;

interface StatRow {
  body: Container;
  count: CountUp;
}

export class ResultScene extends Scene {
  readonly sceneName = 'ResultScene';

  private readonly bg = new Sprite(tex('bg_title'));
  private readonly dim = new Graphics();
  private readonly burst: SunBurst | null;
  private readonly confetti = new ConfettiLayer();
  private readonly titleHolder = new Container();
  private readonly title: Text;
  private readonly desc: Text;
  private readonly portraitHolder = new Container();
  /** 회전·찌그러짐 담당 (초상화 + 눈물) */
  private readonly portraitBody = new Container();
  private readonly portrait: Sprite;
  private readonly portraitW: number;
  private readonly portraitH: number;
  private readonly shadow = new Graphics();
  private readonly tear = new Graphics();
  private readonly cloud = new Container();
  private readonly rain: { g: Graphics; x: number; phase: number }[] = [];
  private readonly panel: Panel;
  private readonly rows: StatRow[] = [];
  private readonly retryHolder: Container;
  private readonly titleBtnHolder: Container;
  /** onEnter에서 만든다 (진입 전에 다른 goto로 버려진 씬이 window 키 리스너를 남기지 않게) */
  private keyboard: Keyboard | null = null;
  private readonly panelH: number;
  private vp: Viewport | null = null;
  private clock = 0;
  private confettiTimer = 0;
  private leaving = false;

  constructor(readonly result: RunResult) {
    super();
    const won = result.won;
    const data = game.data;
    const character = data.characters[result.characterId] ?? Object.values(data.characters)[0];
    const totalStages = data.stages.length;
    const reached = Math.max(1, Math.min(totalStages, result.stageIndex + 1));

    this.dim.eventMode = 'none';
    this.burst = won ? new SunBurst(620, 0xfff1a8, 16) : null;
    this.addChild(this.bg, this.dim);
    if (this.burst) this.addChild(this.burst);

    // 제목
    this.title = new Text({
      text: won ? T.menu.victory : T.menu.defeat,
      style: textStyle('title', { fontSize: 124, fill: won ? WIN_TITLE_COLOR : LOSE_TITLE_COLOR }),
    });
    this.title.anchor.set(0.5);
    this.titleHolder.addChild(this.title);
    if (won) {
      for (const side of [-1, 1]) {
        const star = drawStar(new Graphics(), 34, WIN_TITLE_COLOR);
        star.position.set(side * (this.title.width / 2 + 50), -10);
        star.rotation = side * 0.25;
        this.titleHolder.addChild(star);
      }
    }
    this.desc = new Text({
      text: won ? T.menu.victoryDesc : T.menu.defeatDesc,
      style: textStyle('body', { fontSize: 30, fill: UI_COLORS.text, align: 'center' }),
    });
    this.desc.anchor.set(0.5, 0);
    this.addChild(this.titleHolder, this.desc);

    // 초상화
    this.portrait = new Sprite(tex(character?.portrait ?? 'portrait_penguin'));
    this.portrait.anchor.set(0.5, 1);
    const ps = PORTRAIT_SIZE / Math.max(1, this.portrait.texture.width, this.portrait.texture.height);
    this.portrait.scale.set(ps);
    this.portraitW = this.portrait.texture.width * ps;
    this.portraitH = this.portrait.texture.height * ps;
    this.shadow.ellipse(0, 0, PORTRAIT_SIZE * 0.36, 20).fill({ color: 0x000000, alpha: 0.3 });
    this.portraitBody.addChild(this.portrait);
    this.portraitHolder.addChild(this.shadow, this.portraitBody);
    if (!won) {
      this.portrait.tint = LOSE_TINT;
      this.tear.poly([0, -16, 9, 0, 0, 0, -9, 0]).fill(TEAR_COLOR).circle(0, 0, 9).fill(TEAR_COLOR);
      this.portraitBody.addChild(this.tear);
      this.buildCloud();
      this.portraitHolder.addChild(this.cloud);
    }
    this.addChild(this.portraitHolder);

    // 통계
    const rows: { label: string; value: number; fmt: (n: number) => string; color: number }[] = [
      { label: T.menu.reachedStageLabel, value: reached, fmt: (n) => T.menu.stageOf(n, totalStages), color: UI_COLORS.text },
      { label: T.menu.killsCount, value: result.stats.kills, fmt: (n) => String(n), color: UI_COLORS.text },
      { label: T.menu.goldEarned, value: result.stats.goldEarned, fmt: (n) => String(n), color: UI_COLORS.gold },
      {
        label: T.menu.stagesCleared,
        value: result.stats.stagesCleared,
        fmt: (n) => T.menu.stageOf(n, totalStages),
        color: UI_COLORS.good,
      },
    ];
    this.panelH = ROW_PAD * 2 + ROW_H * rows.length;
    this.panel = new Panel(PANEL_W, this.panelH, { radius: 30 });
    rows.forEach((r, i) => {
      const body = new Container();
      body.y = ROW_PAD + i * ROW_H;
      const pad = 34;
      if (i > 0) body.addChild(new Graphics().rect(pad, 0, PANEL_W - pad * 2, 2).fill({ color: UI_COLORS.panelBorder, alpha: 0.5 }));
      const label = new Text({ text: r.label, style: textStyle('body', { fontSize: 30 }) });
      label.anchor.set(0, 0.5);
      label.position.set(pad, ROW_H / 2);
      const value = new Text({ text: '', style: textStyle('number', { fontSize: 40, fill: r.color }) });
      value.anchor.set(1, 0.5);
      value.position.set(PANEL_W - pad, ROW_H / 2);
      body.addChild(label, value);
      this.panel.addChild(body);
      this.rows.push({ body, count: new CountUp(value, Math.max(0, Math.round(r.value)), r.fmt) });
    });
    this.addChild(this.panel);

    const retry = new Button({ label: T.menu.retry, width: BTN_W, height: BTN_H, color: RETRY_COLOR, fontSize: 46, onTap: () => this.retry() });
    const toTitle = new Button({
      label: T.menu.toTitle,
      width: BTN_W,
      height: SUB_BTN_H,
      color: UI_COLORS.panelBorder,
      fontSize: 36,
      sound: 'ui_back',
      onTap: () => this.toTitle(),
    });
    this.retryHolder = centeredButton(retry, BTN_W, BTN_H);
    this.titleBtnHolder = centeredButton(toTitle, BTN_W, SUB_BTN_H);
    this.addChild(this.retryHolder, this.titleBtnHolder);
    // 색종이는 배경 위, 통계·버튼 아래 (글자 가독성)
    this.addChildAt(this.confetti, this.getChildIndex(this.panel));
  }

  override onEnter(): void {
    const kb = (this.keyboard = new Keyboard());
    kb.onPress('Enter', () => this.retry());
    kb.onPress('Space', () => this.retry());
    kb.onPress('Escape', () => this.toTitle());
    // 승리 = 축하 팡파르. 패배 = 패배 징글 — 방금 전투 화면에서 울렸으면(패배 직후 넘어옴) 다시 울리지 않는다
    if (this.result.won) sfx.play('victory_run');
    else if (sfx.sinceLastPlay('defeat') > DEFEAT_JINGLE_GAP) sfx.play('defeat');
    void this.playIntro();
  }

  override onExit(): void {
    this.keyboard?.dispose();
    this.keyboard = null;
    killTweensOf(this.titleHolder.scale);
    killTweensOf(this.desc);
    killTweensOf(this.portraitHolder);
    killTweensOf(this.panel);
    for (const r of this.rows) {
      killTweensOf(r.body);
      killTweensOf(r.count);
    }
    killTweensOf(this.retryHolder.scale);
    killTweensOf(this.titleBtnHolder.scale);
  }

  layout(vp: Viewport): void {
    this.vp = vp;
    const w = vp.width;
    const h = vp.height;
    coverSprite(this.bg, w, h);
    const won = this.result.won;
    this.dim.clear().rect(0, 0, w, h).fill({ color: won ? UI_COLORS.bg : LOSE_DIM_COLOR, alpha: won ? WIN_DIM : LOSE_DIM_ALPHA });
    this.confetti.setBottom(h);

    const top = vp.safeTop;
    const bottom = h - vp.safeBottom;
    const subY = bottom - 36 - SUB_BTN_H / 2;
    const retryY = subY - SUB_BTN_H / 2 - 18 - BTN_H / 2;
    // 위에서부터: 제목 · 설명 · 초상화 · 통계 — 남는 공간은 간격으로
    const titleH = 150;
    const descH = 50;
    // 패배 시 머리 위 먹구름 자리
    const cloudH = won ? 0 : CLOUD_SPACE;
    const avail = retryY - BTN_H / 2 - 30 - top;
    const fixedH = titleH + descH + this.panelH;
    const fullPortraitH = PORTRAIT_SIZE + 30 + cloudH;
    // 화면이 짧으면 초상화(+구름)를 줄여서 맞춘다
    const k = Math.max(0.6, Math.min(1, (avail - fixedH) / fullPortraitH));
    this.portraitHolder.scale.set(k);
    const portraitH = fullPortraitH * k;
    const free = Math.max(0, avail - fixedH - portraitH);
    const gap = Math.min(60, free / 5);

    let y = top + gap + titleH / 2 + 20;
    this.titleHolder.position.set(w / 2, y);
    this.burst?.position.set(w / 2, y + titleH / 2 + descH + gap + portraitH / 2);
    y += titleH / 2;
    this.desc.position.set(w / 2, y);
    y += descH + gap;
    this.portraitHolder.position.set(w / 2, y + portraitH - 20 * k);
    y += portraitH + gap;
    this.panel.position.set((w - PANEL_W) / 2, y);

    this.retryHolder.position.set(w / 2, retryY);
    this.titleBtnHolder.position.set(w / 2, subY);
  }

  override update(dt: number): void {
    this.clock += dt;
    this.burst?.update(dt);
    this.confetti.update(dt);
    for (const r of this.rows) r.count.sync();

    const body = this.portraitBody;
    const t = this.clock;
    if (this.result.won) {
      // 통통 점프 + 착지 찌그러짐
      const phase = (t * 1.7) % 1;
      const jump = Math.sin(phase * Math.PI);
      body.y = -jump * 46;
      const land = phase < 0.12 ? 1 - phase / 0.12 : phase > 0.92 ? (phase - 0.92) / 0.08 : 0;
      body.scale.set(1 + land * 0.1, 1 - land * 0.12);
      body.rotation = Math.sin(t * 3.4) * 0.06;
      this.shadow.scale.set(1 - jump * 0.3);
      // 색종이 계속 뿌리기
      this.confettiTimer -= dt;
      if (this.confettiTimer <= 0 && this.vp) {
        this.confettiTimer = CONFETTI_INTERVAL;
        this.confetti.rain(this.vp.width, 0, 6);
      }
    } else {
      // 축 처져서 한숨 (느리게 가라앉았다 올라옴) + 눈물 방울 + 머리 위 먹구름
      const sigh = (Math.sin(t * 1.3) + 1) / 2;
      body.rotation = -0.1 + Math.sin(t * 0.7) * 0.03;
      body.scale.set(1.04 + sigh * 0.03, 0.9 - sigh * 0.04);
      body.y = sigh * 6;
      const tearPhase = (t * 0.55) % 1;
      this.tear.position.set(-this.portraitW * 0.19, -this.portraitH * 0.56 + tearPhase * this.portraitH * 0.14);
      this.tear.alpha = tearPhase < 0.7 ? 1 : 1 - (tearPhase - 0.7) / 0.3;
      this.tear.scale.set(0.6 + Math.min(1, tearPhase * 3) * 0.4);
      this.cloud.y = -this.portraitH - 46 + Math.sin(t * 1.1) * 5;
      for (const d of this.rain) {
        const f = (t * 1.4 + d.phase) % 1;
        d.g.position.set(d.x - f * 8, 30 + f * 80);
        d.g.alpha = f < 0.8 ? 0.9 : 0.9 * (1 - (f - 0.8) / 0.2);
      }
    }
  }

  // ───────────────────────────────────────────────────────────

  private buildCloud(): void {
    for (let i = 0; i < RAIN_DROPS; i++) {
      const g = new Graphics().roundRect(-3, -12, 6, 24, 3).fill(TEAR_COLOR);
      g.rotation = 0.1;
      this.rain.push({ g, x: -70 + (140 / (RAIN_DROPS - 1)) * i, phase: (i * 0.37) % 1 });
      this.cloud.addChild(g);
    }
    const puff = new Graphics();
    for (const [x, y, r] of [
      [-62, 8, 34],
      [-22, -14, 44],
      [30, -8, 40],
      [66, 10, 30],
    ] as const) {
      puff.circle(x, y, r);
    }
    puff.roundRect(-90, 4, 180, 40, 20);
    puff.fill(CLOUD_COLOR).stroke({ width: 5, color: OUTLINE_COLOR });
    // 겹친 원 안쪽 선을 덮는 한 번 더 칠하기
    for (const [x, y, r] of [
      [-62, 8, 31],
      [-22, -14, 41],
      [30, -8, 37],
      [66, 10, 27],
    ] as const) {
      puff.circle(x, y, r);
    }
    puff.roundRect(-87, 7, 174, 34, 17).fill(CLOUD_COLOR);
    this.cloud.addChild(puff);
  }

  private async playIntro(): Promise<void> {
    const won = this.result.won;
    this.titleHolder.scale.set(0);
    this.desc.alpha = 0;
    this.portraitHolder.alpha = 0;
    this.panel.alpha = 0;
    for (const r of this.rows) r.body.alpha = 0;
    this.retryHolder.scale.set(0);
    this.titleBtnHolder.scale.set(0);

    await tween(this.titleHolder.scale, { x: 1, y: 1 }, won ? 0.6 : 0.8, won ? 'outElastic' : 'outBack');
    if (this.destroyed) return;
    if (won && this.vp) {
      this.confetti.burst(this.vp.width * 0.25, this.titleHolder.y + 40, 40, 1200);
      this.confetti.burst(this.vp.width * 0.75, this.titleHolder.y + 40, 40, 1200);
    }
    void tween(this.desc, { alpha: 1 }, 0.3);
    // 버튼은 일찍 띄운다 (통계가 올라가는 동안에도 바로 누를 수 있게)
    void tween(this.retryHolder.scale, { x: 1, y: 1 }, 0.4, 'outBack');
    void tween(this.titleBtnHolder.scale, { x: 0 }, 0.08).then(() => tween(this.titleBtnHolder.scale, { x: 1, y: 1 }, 0.4, 'outBack'));
    await tween(this.portraitHolder, { alpha: 1 }, 0.3);
    if (this.destroyed) return;
    void tween(this.panel, { alpha: 1 }, 0.2);
    for (const r of this.rows) {
      void tween(r.body, { alpha: 1 }, 0.2);
      await r.count.play(0.4);
      if (this.destroyed) return;
    }
  }

  private retry(): void {
    if (this.leaving) return;
    this.leaving = true;
    game.toCharacterSelect();
  }

  private toTitle(): void {
    if (this.leaving) return;
    this.leaving = true;
    game.toTitle();
  }
}

