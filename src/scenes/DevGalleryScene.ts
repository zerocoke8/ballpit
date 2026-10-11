// 임시 개발 갤러리: 모든 에셋 텍스처, ActorSprite 코드 애니메이션, 공용 위젯 확인용.
import { Container, Graphics, Rectangle, Sprite, Text, type FederatedPointerEvent } from 'pixi.js';
import { DESIGN_W, UI_COLORS } from '../config';
import type { Viewport } from '../core/app';
import { Scene } from '../core/scene';
import { T } from '../i18n/ko';
import { ActorSprite } from '../render/actor';
import { assetDefs, hasArt, tex } from '../render/assets';
import type { AnimState } from '../types';
import { Button, ProgressBar, Toast, iconWithCount, textStyle, type IconWithCount } from '../ui';

const MARGIN = 16;
const GRID_COLS = 8;
const LABEL_H = 18;
const ACTOR_KEYS = ['char_penguin', 'char_cat', 'enemy_teddy'] as const;
const ACTOR_CYCLE: readonly AnimState[] = ['idle', 'move', 'attack', 'hit'];
const BAR_VALUES = [0.85, 0.35, 1, 0.6, 0.12, 0.92, 0.5];

export class DevGalleryScene extends Scene {
  readonly sceneName = 'DevGalleryScene';
  private readonly bg = new Sprite(tex('bg_title'));
  private readonly title = new Text({ text: T.common.dev.galleryTitle, style: textStyle('heading') });
  private readonly info = new Text({ text: '', style: textStyle('small', { fontSize: 20, lineHeight: 26 }) });
  private readonly actors: ActorSprite[] = [];
  private readonly actorLabels: Text[] = [];
  private readonly toastButton: Button;
  private readonly disabledButton: Button;
  private readonly coins: IconWithCount;
  private readonly bar = new ProgressBar(DESIGN_W - MARGIN * 2, 34, UI_COLORS.hp);
  private readonly gridMask = new Graphics();
  private readonly grid = new Container();
  private gridTop = 0;
  private gridViewH = 0;
  private scrollY = 0;
  private dragFrom: { y: number; scroll: number } | null = null;
  private vp: Viewport | null = null;
  private cycleTimer = 0;
  private cycleIndex = 0;
  private barIndex = 0;
  private coinCount = 0;

  constructor() {
    super();
    this.bg.alpha = 0.45;
    this.title.anchor.set(0.5, 0);
    this.addChild(this.bg, this.title, this.info);

    for (const key of ACTOR_KEYS) {
      const actor = new ActorSprite(key, key.startsWith('enemy_') ? 150 : 130);
      const label = new Text({ text: '', style: textStyle('small', { fontSize: 20, align: 'center' }) });
      label.anchor.set(0.5, 0);
      this.actors.push(actor);
      this.actorLabels.push(label);
      this.addChild(actor, label);
    }

    this.toastButton = new Button({
      label: T.common.dev.toastButton,
      width: 300,
      height: 84,
      icon: 'ui_bag',
      onTap: () => this.showToast(),
    });
    this.disabledButton = new Button({ label: T.common.dev.disabled, width: 200, height: 84, color: UI_COLORS.good, onTap: () => {} });
    this.disabledButton.setEnabled(false);
    this.coins = iconWithCount('ui_coin', 48);
    this.addChild(this.toastButton, this.disabledButton, this.coins, this.bar);

    this.buildGrid();
    this.grid.mask = this.gridMask;
    this.addChild(this.gridMask, this.grid);

    this.grid.eventMode = 'static';
    this.grid.hitArea = new Rectangle(0, 0, DESIGN_W, this.contentHeight());
    this.grid.on('pointerdown', this.onDragStart);
    this.grid.on('globalpointermove', this.onDragMove);
    this.grid.on('pointerup', this.onDragEnd);
    this.grid.on('pointerupoutside', this.onDragEnd);
  }

  override onEnter(): void {
    this.bar.setValue(BAR_VALUES[0], false);
  }

  override onExit(): void {
    this.grid.removeAllListeners();
  }

  override layout(vp: Viewport): void {
    this.vp = vp;
    const w = vp.width;
    const top = vp.safeTop + 16;

    this.bg.width = w;
    this.bg.height = vp.height;
    this.title.position.set(w / 2, top);
    this.info.position.set(MARGIN, top + 58);
    this.updateInfo();

    const actorY = top + 210;
    ACTOR_KEYS.forEach((_, i) => {
      const x = (w / (ACTOR_KEYS.length + 1)) * (i + 1);
      this.actors[i].position.set(x, actorY);
      this.actorLabels[i].position.set(x, actorY + 82);
    });

    const controlsY = actorY + 140;
    this.toastButton.position.set(MARGIN, controlsY);
    this.disabledButton.position.set(MARGIN + 316, controlsY);
    this.coins.position.set(w - MARGIN - 150, controlsY + 18);
    this.bar.position.set(MARGIN, controlsY + 104);

    this.gridTop = controlsY + 156;
    this.gridViewH = Math.max(120, vp.height - vp.safeBottom - this.gridTop - 8);
    this.gridMask.clear().rect(0, this.gridTop, w, this.gridViewH).fill(0xffffff);
    this.setScroll(this.scrollY);
  }

  override update(dt: number): void {
    for (const a of this.actors) a.update(dt);
    this.cycleTimer += dt;
    if (this.cycleTimer >= 1) {
      this.cycleTimer -= 1;
      this.cycleIndex = (this.cycleIndex + 1) % ACTOR_CYCLE.length;
      for (const a of this.actors) void a.play(ACTOR_CYCLE[this.cycleIndex]);
      this.barIndex = (this.barIndex + 1) % BAR_VALUES.length;
      this.bar.setValue(BAR_VALUES[this.barIndex]);
    }
    ACTOR_KEYS.forEach((key, i) => {
      const text = `${key}\n${T.common.dev.actorState(this.actors[i].state)}`;
      if (this.actorLabels[i].text !== text) this.actorLabels[i].text = text;
    });
  }

  private showToast(): void {
    this.coinCount += 5;
    this.coins.setCount(this.coinCount);
    Toast.show(this, T.common.dev.toastText, { y: this.vp ? this.vp.height * 0.45 : 600 });
  }

  private updateInfo(): void {
    const vp = this.vp;
    if (!vp) return;
    const defs = assetDefs();
    const art = defs.filter((d) => hasArt(d.key)).length;
    const dpr = window.devicePixelRatio || 1;
    this.info.text =
      `viewport ${vp.width}×${vp.height.toFixed(1)}  safe ${vp.safeTop.toFixed(0)}/${vp.safeBottom.toFixed(0)}  ` +
      `window ${window.innerWidth}×${window.innerHeight} @${dpr}x\n` +
      `${T.common.dev.assets(art, defs.length)}   ${T.common.dev.legend}`;
  }

  private buildGrid(): void {
    const cellW = (DESIGN_W - MARGIN * 2) / GRID_COLS;
    const pad = 5;
    const box = cellW - pad * 2;
    assetDefs().forEach((def, i) => {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cell = new Container();
      cell.position.set(MARGIN + col * cellW, row * (cellW + LABEL_H));

      const real = hasArt(def.key);
      const frame = new Graphics()
        .roundRect(pad / 2, pad / 2, cellW - pad, cellW - pad, 12)
        .fill({ color: UI_COLORS.panel, alpha: 0.9 })
        .stroke({ width: 2, color: real ? UI_COLORS.good : UI_COLORS.panelBorder });
      cell.addChild(frame);

      const sprite = new Sprite(tex(def.key));
      sprite.anchor.set(0.5);
      sprite.scale.set(box / Math.max(1, sprite.texture.width, sprite.texture.height));
      sprite.position.set(cellW / 2, cellW / 2);
      cell.addChild(sprite);

      const dot = new Graphics().circle(cellW - 12, 12, 5);
      if (real) dot.fill(UI_COLORS.good);
      else dot.stroke({ width: 2, color: UI_COLORS.textDim });
      cell.addChild(dot);

      const label = new Text({ text: def.key, style: textStyle('small', { fontSize: 13, fill: UI_COLORS.text }) });
      label.anchor.set(0.5, 0);
      if (label.width > cellW - 2) label.scale.set((cellW - 2) / label.width);
      label.position.set(cellW / 2, cellW - 1);
      cell.addChild(label);

      this.grid.addChild(cell);
    });
  }

  private contentHeight(): number {
    return Math.ceil(assetDefs().length / GRID_COLS) * ((DESIGN_W - MARGIN * 2) / GRID_COLS + LABEL_H);
  }

  private setScroll(y: number): void {
    const maxScroll = Math.max(0, this.contentHeight() - this.gridViewH);
    this.scrollY = Math.max(0, Math.min(maxScroll, y));
    this.grid.y = this.gridTop - this.scrollY;
  }

  private readonly onDragStart = (e: FederatedPointerEvent): void => {
    this.dragFrom = { y: e.global.y, scroll: this.scrollY };
  };

  private readonly onDragMove = (e: FederatedPointerEvent): void => {
    if (!this.dragFrom) return;
    const scale = this.worldTransform.d || 1;
    this.setScroll(this.dragFrom.scroll - (e.global.y - this.dragFrom.y) / scale);
  };

  private readonly onDragEnd = (): void => {
    this.dragFrom = null;
  };
}
