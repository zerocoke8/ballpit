// 전투 HUD (폭 720 × HUD_H, 원점 좌상단): 하트 + HP 바 + "hp/max", 골드, 스테이지 이름, 처치 진행 바, 가방 버튼.
// 값은 바뀔 때만 다시 그린다. 애니메이션은 update(dt)에서 직접 (트윈 없음).
// 자주 바뀌는 숫자(HP·골드·보관함 배지)는 비트맵 폰트(NUM_FONT): 일반 Text는 바뀔 때마다 캔버스로 다시
// 그려서 저사양 폰에서 한 번에 수 ms가 든다 (재생 틱·코인 도착마다). CombatScene이 ensureNumberFont()를 먼저 부른다.
import { BitmapText, Container, Graphics, Rectangle, Sprite, Text, type Texture } from 'pixi.js';
import { DESIGN_W, HUD_H, UI_COLORS } from '../../config';
import { T } from '../../i18n/ko';
import { shade } from '../../render/color';
import { tex } from '../../render/assets';
import { textStyle } from '../../ui';
import { FastBar } from './FastBar';
import { NUM_FONT } from './fxTextures';
import { HUD_BG, WALL_TOP_H } from './visual';

const BAG_SIZE = 78;
const HP_BAR_W = 232;
const HP_BAR_H = 30;
const CENTER_X = 452;
const CENTER_W = 290;
const COIN_SIZE = 34;
const GOLD_POP_TIME = 0.25;

/** 코인 아이콘 + 비트맵 숫자 (ui/iconWithCount와 같은 모양·팝). 원점 좌상단, 아이콘은 COIN_SIZE 정사각형 */
class GoldCounter extends Container {
  private readonly icon: Sprite;
  private readonly valueText: BitmapText;
  private readonly baseScale: number;
  private shown = -1;
  private popT = 0;

  constructor() {
    super();
    this.icon = new Sprite(tex('ui_coin'));
    this.icon.anchor.set(0.5);
    this.baseScale = COIN_SIZE / Math.max(1, this.icon.texture.width, this.icon.texture.height);
    this.icon.scale.set(this.baseScale);
    this.icon.position.set(COIN_SIZE / 2, COIN_SIZE / 2);
    this.valueText = new BitmapText({ text: '0', style: { fontFamily: NUM_FONT, fontSize: Math.round(COIN_SIZE * 0.72) } });
    this.valueText.anchor.set(0, 0.5);
    this.valueText.position.set(COIN_SIZE + Math.max(6, COIN_SIZE * 0.15), COIN_SIZE / 2);
    this.addChild(this.icon, this.valueText);
  }

  setCount(n: number): void {
    if (n === this.shown) return;
    if (n > this.shown && this.shown >= 0) this.popT = GOLD_POP_TIME;
    this.shown = n;
    this.valueText.text = String(n);
  }

  update(dt: number): void {
    if (this.popT <= 0) return;
    this.popT = Math.max(0, this.popT - dt);
    // 1.25배에서 살짝 넘치며 제자리로 (outBack)
    const p = 1 - this.popT / GOLD_POP_TIME;
    const back = 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
    this.icon.scale.set(this.baseScale * (1.25 - 0.25 * back));
  }
}

class BagButton extends Container {
  private readonly face = new Container();
  private readonly glow: Sprite;
  private readonly badge = new Container();
  private readonly badgeText: BitmapText;
  private alert = false;
  private clock = 0;
  private bumpT = 0;
  private pressed = false;
  private count = -1;

  constructor(glowTex: Texture, onTap: () => void) {
    super();
    const r = BAG_SIZE / 2;
    this.glow = new Sprite(glowTex);
    this.glow.anchor.set(0.5);
    this.glow.tint = UI_COLORS.gold;
    this.glow.scale.set((BAG_SIZE * 1.9) / glowTex.width);
    this.glow.alpha = 0;

    const base = UI_COLORS.accent;
    const bg = new Graphics()
      .roundRect(-r, -r, BAG_SIZE, BAG_SIZE, 26)
      .fill(shade(base, 0.38))
      .roundRect(-r + 3, -r + 3, BAG_SIZE - 6, BAG_SIZE - 6, 23)
      .fill(shade(base, 0.68))
      .roundRect(-r + 3, -r + 3, BAG_SIZE - 6, BAG_SIZE - 14, 23)
      .fill(base);
    const icon = new Sprite(tex('ui_bag'));
    icon.anchor.set(0.5);
    icon.scale.set((BAG_SIZE * 0.78) / Math.max(1, icon.texture.width, icon.texture.height));
    icon.position.set(0, -3);
    this.face.addChild(bg, icon);

    const bc = new Graphics().circle(0, 0, 17).fill(UI_COLORS.bad).stroke({ width: 3, color: 0xffffff });
    this.badgeText = new BitmapText({ text: '0', style: { fontFamily: NUM_FONT, fontSize: 20 } });
    this.badgeText.anchor.set(0.5);
    this.badge.addChild(bc, this.badgeText);
    // 화면 위 여백이 없는 기기에서도 잘리지 않게 버튼 안쪽 모서리에
    this.badge.position.set(r - 8, -r + 14);
    this.badge.visible = false;

    this.addChild(this.glow, this.face, this.badge);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(-r - 6, -r - 6, BAG_SIZE + 12, BAG_SIZE + 12);
    this.on('pointerdown', () => {
      this.pressed = true;
    });
    const release = (): void => {
      this.pressed = false;
    };
    this.on('pointerup', release);
    this.on('pointerupoutside', release);
    this.on('pointerleave', release);
    this.on('pointertap', () => onTap());
  }

  setCount(n: number): void {
    if (n === this.count) return;
    if (n > this.count && this.count >= 0) this.bump();
    this.count = n;
    this.badge.visible = n > 0;
    this.badgeText.text = String(n);
  }

  setAlert(on: boolean): void {
    this.alert = on;
  }

  bump(): void {
    this.bumpT = 0.3;
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.bumpT > 0) this.bumpT = Math.max(0, this.bumpT - dt);
    const wave = Math.sin(this.clock * 7);
    let s = this.pressed ? 0.9 : 1;
    if (this.alert) s *= 1 + 0.06 * (0.5 + 0.5 * wave);
    if (this.bumpT > 0) s *= 1 + 0.3 * (this.bumpT / 0.3);
    this.face.scale.set(s);
    this.face.rotation = this.alert ? wave * 0.06 : 0;
    this.glow.alpha = this.alert ? 0.45 + 0.35 * wave : 0;
    this.badge.scale.set(this.bumpT > 0 ? 1 + 0.5 * (this.bumpT / 0.3) : 1);
  }
}

export class Hud extends Container {
  private readonly bg = new Graphics();
  private readonly heart: Sprite;
  // 게이지는 다시 그리지 않는 FastBar (처치마다 진행 바가 움직이는 동안 매 프레임 다시 그리던 것을 없앰)
  private readonly hpBar = new FastBar(HP_BAR_W, HP_BAR_H, UI_COLORS.hp);
  private readonly hpText: BitmapText;
  private readonly gold = new GoldCounter();
  private readonly stageLabel: Text;
  private readonly stageName: Text;
  private readonly progress = new FastBar(CENTER_W - 10, 16, UI_COLORS.good);
  private readonly bag: BagButton;
  private shownHp = -1;
  private shownMax = -1;
  private shownProgress = -1;
  private heartPop = 0;

  constructor(glowTex: Texture, onBag: () => void) {
    super();
    this.addChild(this.bg);

    this.heart = new Sprite(tex('ui_heart'));
    this.heart.anchor.set(0.5);
    this.heart.position.set(36, 28);
    this.heart.scale.set(50 / Math.max(1, this.heart.texture.width, this.heart.texture.height));
    this.hpBar.position.set(60, 13);
    this.hpText = new BitmapText({ text: '', style: { fontFamily: NUM_FONT, fontSize: 22 } });
    this.hpText.anchor.set(0.5);
    this.hpText.position.set(60 + HP_BAR_W / 2, 13 + HP_BAR_H / 2);

    this.gold.position.set(19, 50);

    this.stageLabel = new Text({ text: '', style: textStyle('small', { fontSize: 20 }) });
    this.stageLabel.anchor.set(0.5, 0);
    this.stageLabel.position.set(CENTER_X, 2);
    this.stageName = new Text({ text: '', style: textStyle('heading', { fontSize: 30 }) });
    this.stageName.anchor.set(0.5, 0);
    this.stageName.position.set(CENTER_X, 22);
    this.progress.position.set(CENTER_X - (CENTER_W - 10) / 2, 64);

    this.bag = new BagButton(glowTex, onBag);
    this.bag.position.set(DESIGN_W - 16 - BAG_SIZE / 2, (HUD_H - WALL_TOP_H) / 2);

    this.addChild(this.heart, this.hpBar, this.hpText, this.gold, this.stageLabel, this.stageName, this.progress, this.bag);
    for (const c of [this.heart, this.hpBar, this.hpText, this.gold, this.stageLabel, this.stageName, this.progress]) {
      c.eventMode = 'none';
    }
    this.setTopExtend(0);
  }

  /** 노치/위 여백까지 배경을 늘린다 (HUD 원점 위로 px만큼) */
  setTopExtend(px: number): void {
    const g = this.bg;
    g.clear();
    // 아래 WALL_TOP_H는 비워 둔다 (필드 상단 나무 벽이 보이도록)
    g.rect(0, -px - 2, DESIGN_W, px + HUD_H - WALL_TOP_H + 2).fill(HUD_BG);
    g.rect(0, HUD_H - WALL_TOP_H - 4, DESIGN_W, 4).fill({ color: 0x000000, alpha: 0.25 });
    // 배경 클릭이 아래(입력 받는 바탕)로 통과하도록
    g.eventMode = 'none';
  }

  setStage(stageNumber: number, name: string): void {
    this.stageLabel.text = T.combat.stage(stageNumber);
    this.stageName.text = name;
    this.stageName.scale.set(1);
    if (this.stageName.width > CENTER_W) this.stageName.scale.set(CENTER_W / this.stageName.width);
  }

  setHp(hp: number, maxHp: number): void {
    const cur = hp > 0 ? Math.ceil(hp) : 0;
    if (cur === this.shownHp && maxHp === this.shownMax) return;
    const dropped = cur < this.shownHp;
    const first = this.shownHp < 0;
    this.shownHp = cur;
    this.shownMax = maxHp;
    this.hpText.text = T.combat.hp(cur, maxHp);
    this.hpBar.setValue(maxHp > 0 ? cur / maxHp : 0, dropped && !first);
    if (dropped && !first) this.heartPop = 0.3;
  }

  setGold(n: number): void {
    this.gold.setCount(n);
  }

  setProgress(v: number): void {
    if (Math.abs(v - this.shownProgress) < 0.0005) return;
    const first = this.shownProgress < 0;
    this.shownProgress = v;
    this.progress.setValue(v, !first);
  }

  setStash(count: number): void {
    this.bag.setCount(count);
  }

  setBagAlert(on: boolean): void {
    this.bag.setAlert(on);
  }

  bumpBag(): void {
    this.bag.bump();
  }

  /** HUD 좌표: 골드 코인 아이콘 중심 */
  goldTarget(): { x: number; y: number } {
    return { x: this.gold.x + COIN_SIZE / 2, y: this.gold.y + COIN_SIZE / 2 };
  }

  /** HUD 좌표: 가방 버튼 중심 */
  bagTarget(): { x: number; y: number } {
    return { x: this.bag.x, y: this.bag.y };
  }

  update(dt: number): void {
    this.bag.update(dt);
    this.gold.update(dt);
    this.hpBar.update(dt);
    this.progress.update(dt);
    if (this.heartPop > 0) {
      this.heartPop = Math.max(0, this.heartPop - dt);
      const base = 50 / Math.max(1, this.heart.texture.width, this.heart.texture.height);
      this.heart.scale.set(base * (1 + 0.35 * (this.heartPop / 0.3)));
    }
  }
}
