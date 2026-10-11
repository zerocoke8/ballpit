// 하단 무기 바: loadout 무기마다 슬롯 (가방 읽기 순서). 아이콘 + 등급색 테두리 + ★ + 쿨타임 채움 + 발사 플래시.
// 8개를 넘으면 2줄. 원점 좌상단, 폭 720.
import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { DESIGN_W, RARITY_COLORS, UI_COLORS } from '../../config';
import { T } from '../../i18n/ko';
import { shade } from '../../render/color';
import { tex } from '../../render/assets';
import type { ItemDef, WeaponLoadout, WeaponRuntime } from '../../types';
import { textStyle } from '../../ui';

const SIDE = 22;
const GAP = 10;
const SLOT_MAX = 104;
const SLOT_MIN = 52;
const TOP = 22;
const PER_ROW_MAX = 8;
const BORDER = 5;
const FLASH_TIME = 0.14;
const POP_TIME = 0.16;

interface Slot {
  uid: number;
  def: ItemDef | undefined;
  tier: number;
  root: Container;
  face: Container;
  shadeSprite: Sprite;
  flash: Graphics;
  ready: Graphics;
  inner: number;
  frac: number;
  flashT: number;
  popT: number;
}

export class WeaponBar extends Container {
  private slots: Slot[] = [];
  private readonly hint: Text;
  private barH = 220;
  private hintAlpha = 1;
  private hintDismissed = false;
  private clock = 0;

  constructor() {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    this.hint = new Text({ text: T.combat.controlsHint, style: textStyle('small', { fontSize: 26 }) });
    this.hint.anchor.set(0.5);
    this.addChild(this.hint);
  }

  /** 하단 바 높이가 바뀌면 */
  setHeight(h: number): void {
    this.barH = h;
    this.layoutSlots();
  }

  rebuild(loadout: readonly WeaponLoadout[], items: Record<string, ItemDef>): void {
    // context: true — Graphics 컨텍스트(GPU 지오메트리)를 렌더러 GC까지 남기지 않게 (CombatScene.destroy 참고)
    for (const s of this.slots) s.root.destroy({ children: true, context: true });
    this.slots = [];
    for (const l of loadout) {
      const def = items[l.defId];
      const root = new Container();
      const face = new Container();
      root.addChild(face);
      this.addChild(root);
      this.slots.push({
        uid: l.uid,
        def,
        tier: l.tier,
        root,
        face,
        shadeSprite: new Sprite(Texture.WHITE),
        flash: new Graphics(),
        ready: new Graphics(),
        inner: 0,
        frac: -1,
        flashT: 0,
        popT: 0,
      });
    }
    this.layoutSlots();
  }

  /** 발사 플래시 */
  onFire(uid: number): void {
    for (const s of this.slots) {
      if (s.uid !== uid) continue;
      s.flashT = FLASH_TIME;
      s.popT = POP_TIME;
    }
  }

  /** 조작을 익히면(탭 조준 + 드래그 이동을 한 번씩) 힌트를 숨긴다 */
  dismissHint(): void {
    this.hintDismissed = true;
  }

  sync(weapons: readonly WeaponRuntime[], dt: number): void {
    this.clock += dt;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const w = weapons[i] && weapons[i].uid === s.uid ? weapons[i] : weapons.find((x) => x.uid === s.uid);
      if (w) {
        const f = w.cooldown > 0 ? Math.max(0, Math.min(1, w.timer / w.cooldown)) : 0;
        if (Math.abs(f - s.frac) > 0.004) {
          s.frac = f;
          s.shadeSprite.scale.y = (s.inner * f) / Texture.WHITE.height;
          s.shadeSprite.visible = f > 0.004;
        }
        s.ready.alpha = f <= 0.004 ? 0.55 + 0.45 * Math.sin(this.clock * 6) : 0;
      }
      if (s.flashT > 0) {
        s.flashT = Math.max(0, s.flashT - dt);
        s.flash.alpha = s.flashT / FLASH_TIME;
      } else if (s.flash.alpha !== 0) s.flash.alpha = 0;
      if (s.popT > 0) {
        s.popT = Math.max(0, s.popT - dt);
        s.face.scale.set(1 + 0.12 * (s.popT / POP_TIME));
      }
    }
    if (this.hintDismissed && this.hintAlpha > 0) {
      this.hintAlpha = Math.max(0, this.hintAlpha - dt * 2);
      this.hint.alpha = this.hintAlpha * 0.8;
      this.hint.visible = this.hintAlpha > 0;
    }
  }

  private layoutSlots(): void {
    const n = this.slots.length;
    const rows = n > PER_ROW_MAX ? 2 : 1;
    const perRow = Math.max(1, Math.ceil(n / rows));
    const availW = DESIGN_W - SIDE * 2;
    const byW = (availW - GAP * (perRow - 1)) / perRow;
    const byH = (this.barH - TOP - 70 - GAP * (rows - 1)) / rows;
    const size = Math.floor(Math.max(SLOT_MIN, Math.min(SLOT_MAX, byW, byH)));
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = row === rows - 1 ? n - perRow * (rows - 1) : perRow;
      const rowW = inRow * size + (inRow - 1) * GAP;
      const x = (DESIGN_W - rowW) / 2 + col * (size + GAP);
      const y = TOP + row * (size + GAP);
      this.drawSlot(this.slots[i], size);
      this.slots[i].root.position.set(x + size / 2, y + size / 2);
    }
    const slotsBottom = TOP + rows * size + (rows - 1) * GAP;
    this.hint.position.set(DESIGN_W / 2, Math.min(this.barH - 30, slotsBottom + (this.barH - slotsBottom) / 2));
    this.hint.visible = !this.hintDismissed && this.barH - slotsBottom > 56;
    this.hint.alpha = 0.8 * this.hintAlpha;
  }

  private drawSlot(s: Slot, size: number): void {
    const { def, tier } = s;
    const face = s.face;
    face.removeChildren().forEach((c) => {
      if (c !== s.shadeSprite && c !== s.flash && c !== s.ready) c.destroy({ children: true, context: true });
    });
    const h = size / 2;
    const rarity = def ? RARITY_COLORS[def.rarity] : RARITY_COLORS.common;
    const r = Math.round(size * 0.2);

    const bg = new Graphics()
      .roundRect(-h, -h + 4, size, size, r)
      .fill({ color: 0x000000, alpha: 0.35 })
      .roundRect(-h, -h, size, size, r)
      .fill(UI_COLORS.panelLight)
      .roundRect(-h + BORDER, -h + BORDER, size - BORDER * 2, (size - BORDER * 2) * 0.45, r - BORDER)
      .fill({ color: 0xffffff, alpha: 0.06 });
    face.addChild(bg);

    const icon = new Sprite(tex(def?.icon ?? 'ui_bag'));
    icon.anchor.set(0.5);
    const t = icon.texture;
    icon.scale.set((size * 0.7) / Math.max(1, t.width, t.height));
    icon.position.set(0, -size * 0.04);
    face.addChild(icon);

    // 쿨타임 그늘: 위에서부터 남은 비율만큼 덮는다 (흰 텍스처를 늘려 씀 → 다시 그리기 없음)
    const inner = size - BORDER * 2;
    s.inner = inner;
    const sh = s.shadeSprite;
    sh.tint = 0x0d0716;
    sh.alpha = 0.62;
    sh.position.set(-h + BORDER, -h + BORDER);
    sh.scale.x = inner / Texture.WHITE.width;
    s.frac = -1;
    face.addChild(sh);

    const stars = new Text({
      text: T.common.tier(tier),
      style: textStyle('number', {
        fontSize: Math.max(14, Math.round(size * 0.2)),
        fill: UI_COLORS.gold,
        stroke: { color: 0x3a2400, width: 4, join: 'round' },
        letterSpacing: -2,
      }),
    });
    stars.anchor.set(0.5, 1);
    stars.position.set(0, h - 2);
    face.addChild(stars);

    s.ready.clear().roundRect(-h - 3, -h - 3, size + 6, size + 6, r + 3).stroke({ width: 3, color: 0xffffff });
    s.ready.alpha = 0;

    const border = new Graphics()
      .roundRect(-h + BORDER / 2, -h + BORDER / 2, size - BORDER, size - BORDER, r - BORDER / 2)
      .stroke({ width: BORDER, color: rarity })
      .roundRect(-h, -h, size, size, r)
      .stroke({ width: 2, color: shade(rarity, 0.45) });
    face.addChild(border, s.ready);

    s.flash.clear().roundRect(-h, -h, size, size, r).fill({ color: 0xffffff, alpha: 0.45 });
    s.flash.alpha = 0;
    face.addChild(s.flash);
  }
}
