// 가방 화면 (전투 일시정지 오버레이 · 상점 공용). 계약은 docs/ARCHITECTURE.md의 BagView.
// 위에서부터: 툴팁 패널 → 가방 격자(+오른쪽 보관함) → 버튼 줄(회전 · 합성 · [상점] 판매 칸).
// run.bag은 logic/bag.ts 함수(와 판매는 shop.sellItem)로만 바꾸고, 바꿀 때마다 opts.onChange()를 부른다.
import { Container, Graphics, Rectangle, Text, type DestroyOptions, type FederatedPointerEvent } from 'pixi.js';
import { sfx } from '../../audio';
import { UI_COLORS } from '../../config';
import { Keyboard } from '../../core/keyboard';
import { delay, killTweensOf, tween } from '../../core/tween';
import { T } from '../../i18n/ko';
import {
  applyMerge,
  canPlace,
  findByUid,
  findFreeSpot,
  findMerges,
  footprint,
  getOccupant,
  itemSockets,
  mergesFor,
  moveItem,
  moveToStash,
  neighbors,
  placeFromStash,
} from '../../logic/bag';
import { runPlayerStats } from '../../logic/run';
import { sellItem } from '../../logic/shop';
import { computeLoadout, sellPrice, stoneBuffsFor } from '../../logic/stats';
import { shade } from '../../render/color';
import type { BagState, Element, GameData, MergeOption, Rot, RunState, Tier } from '../../types';
import { Button, Toast, textStyle } from '../../ui';
import { pop, shake, sparkleBurst } from './fx';
import { ItemView, SlotItemView } from './itemSprite';
import { BUTTONS_H, MARGIN, TOOLTIP_H, computeBagMetrics, inStashArea, stashIndexAt, stashSlotPos, type BagMetrics } from './layout';
import { BagOverlay, MERGE_RECIPE_COLOR, MERGE_TIER_COLOR, type Connector, type RectLike, type SocketMarker } from './overlay';
import { SellZone } from './sellZone';
import { TooltipPanel } from './tooltip';
import { buildEmptyTooltip, buildItemTooltip } from './tooltipModel';

export interface BagViewOptions {
  mode: 'combat' | 'shop';
  data: GameData;
  run: RunState;
  width: number;
  onChange?: () => void;
  sellZone?: boolean;
  /** 사용자가 가방 안에서 선택을 바꿨을 때 (상점 카드 선택 해제용) */
  onSelect?: (uid: number | null) => void;
}

/** 이만큼(CSS px) 움직이면 탭이 아니라 드래그 */
const DRAG_THRESHOLD_CSS = 8;
/** 터치 드래그 시 고스트를 손가락 위로 띄우는 거리 (CSS px) */
const TOUCH_LIFT_CSS = 70;
/** 고스트 아래쪽 끝과 손가락 사이 최소 거리 (CSS px) */
const TOUCH_CLEARANCE_CSS = 18;
const DOUBLE_TAP_MS = 320;
const SELL_CONFIRM_SEC = 2.5;
const CONTEXT_SUPPRESS_MS = 800;
const BTN_GAP = 12;
/** 드래그 고스트 투명도 (아래 칸 미리보기가 비치게) */
const GHOST_ALPHA = 0.82;

type Where = 'bag' | 'stash';

interface Hit {
  where: Where;
  uid: number;
}

interface Press {
  pointerId: number;
  touch: boolean;
  gx: number;
  gy: number;
  hit: Hit | null;
  buttons: number;
}

interface DragState {
  pointerId: number;
  uid: number;
  from: Where;
  defId: string;
  tier: Tier;
  rot: Rot;
  touch: boolean;
  ghost: ItemView;
  /** 마우스: 포인터 → 고스트 좌상단 오프셋 */
  grabDX: number;
  grabDY: number;
  pointer: { x: number; y: number };
  zone: 'grid' | 'stash' | 'sell' | 'none';
  tx: number;
  ty: number;
  valid: boolean;
  /** 원래 자리 (복귀 트윈용, 중심 좌표와 배율) */
  homeX: number;
  homeY: number;
  homeScale: number;
  key: string;
  /** 고스트 목표 중심 (들어 올리는 동안 home → 목표로 보간) */
  gx: number;
  gy: number;
  lift: { t: number };
}

export class BagView extends Container {
  readonly opts: BagViewOptions;
  private m: BagMetrics;
  private merges: MergeOption[] = [];
  private selectedUid: number | null = null;
  private preview: { defId: string; tier: Tier } | null = null;

  // 층 (아래 → 위)
  private readonly inputLayer = new Container();
  private readonly tooltip: TooltipPanel;
  private readonly frameG = new Graphics();
  private readonly stashLabel: Text;
  private readonly stashLayer = new Container();
  private readonly itemsLayer = new Container();
  private readonly overlay = new BagOverlay();
  private readonly previewG = new Graphics();
  private readonly buttonsLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly ghostLayer = new Container();

  private readonly rotateBtn: Button;
  private readonly mergeBtn: Button;
  private readonly sellZone: SellZone | null = null;
  private mergeBtnBase = { x: 0, y: 0 };

  private readonly views = new Map<number, ItemView>();
  private readonly stashViews = new Map<number, SlotItemView>();
  private elementsByUid = new Map<number, Element[]>();

  private press: Press | null = null;
  private drag: DragState | null = null;
  private lastTap: { uid: number; time: number } | null = null;
  private sellConfirmUid: number | null = null;
  private sellConfirmToken = 0;
  private suppressContextUntil = 0;
  private readonly keyboard = new Keyboard();
  private disposed = false;

  constructor(opts: BagViewOptions) {
    super();
    this.opts = opts;
    const bag = opts.run.bag;
    this.m = computeBagMetrics(opts.width, bag.cols, bag.rows, bag.stashCapacity);

    this.inputLayer.eventMode = 'static';
    this.inputLayer.on('pointerdown', this.onPointerDown);
    this.inputLayer.on('globalpointermove', this.onPointerMove);
    this.inputLayer.on('pointerup', this.onPointerUp);
    this.inputLayer.on('pointerupoutside', this.onPointerUp);
    this.inputLayer.on('pointercancel', this.onPointerCancel);

    this.tooltip = new TooltipPanel(opts.width - MARGIN * 2, TOOLTIP_H);
    this.tooltip.position.set(MARGIN, 0);

    this.stashLabel = new Text({ text: '', style: textStyle('small', { fontSize: 21, fill: UI_COLORS.textDim }) });
    this.stashLabel.anchor.set(0.5, 0);

    for (const l of [this.frameG, this.stashLayer, this.itemsLayer, this.previewG, this.fxLayer, this.ghostLayer]) {
      l.eventMode = 'none';
    }

    this.rotateBtn = new Button({
      label: T.bag.rotate,
      width: 200,
      height: BUTTONS_H - 6,
      color: UI_COLORS.accent,
      fontSize: 30,
      sound: null,
      onTap: () => this.rotateSelected(),
    });
    this.mergeBtn = new Button({
      label: T.bag.merge,
      width: 200,
      height: BUTTONS_H - 6,
      color: 0xf0a020,
      fontSize: 30,
      sound: null,
      onTap: () => this.mergeSelected(),
    });
    this.buttonsLayer.addChild(this.rotateBtn, this.mergeBtn);
    if (opts.mode === 'shop' && opts.sellZone) {
      this.sellZone = new SellZone(260, BUTTONS_H - 6, () => this.onSellTap());
      this.buttonsLayer.addChild(this.sellZone);
    }
    // 합성 버튼이 켜져 있으면 살살 들썩인다
    this.mergeBtn.onRender = () => {
      if (!this.mergeBtn.isEnabled) {
        if (this.mergeBtn.y !== this.mergeBtnBase.y) this.mergeBtn.y = this.mergeBtnBase.y;
        return;
      }
      const t = performance.now() / 1000;
      this.mergeBtn.y = this.mergeBtnBase.y - Math.abs(Math.sin(t * 4)) * 4;
    };

    this.addChild(
      this.inputLayer,
      this.tooltip,
      this.frameG,
      this.stashLabel,
      this.stashLayer,
      this.itemsLayer,
      this.overlay,
      this.previewG,
      this.buttonsLayer,
      this.fxLayer,
      this.ghostLayer,
    );

    this.keyboard.onPress('Escape', () => {
      if (this.drag && this.isShown()) {
        this.press = null;
        this.cancelDrag(true);
      }
    });
    this.keyboard.onPress('KeyR', () => {
      if (!this.isShown()) return;
      if (this.drag) this.rotateDrag();
      else this.rotateSelected();
    });
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    window.addEventListener('contextmenu', this.onContextMenu, true);

    this.rebuild();
  }

  /** 레이아웃 계산용 (툴팁 + 격자 + 버튼) */
  get contentHeight(): number {
    return this.m.contentHeight;
  }

  /** 외부에서 가방/보관함이 바뀌었을 때 (구매 등) */
  refresh(): void {
    if (this.disposed) return;
    if (this.drag) this.cancelDrag(false);
    this.rebuild();
  }

  /** 가방/보관함 아이템 선택 (없으면 선택 해제) */
  selectUid(uid: number | null): void {
    if (this.disposed) return;
    this.select(uid !== null && findByUid(this.opts.run.bag, uid) ? uid : null, false);
  }

  /** 상점 카드 미리보기: 가방 선택을 풀고 툴팁에 이 아이템을 보여준다 */
  showTooltipFor(defId: string, tier: Tier): void {
    if (this.disposed || !this.opts.data.items[defId]) return;
    this.selectedUid = null;
    this.preview = { defId, tier };
    this.resetSellConfirm();
    this.updateSelectionVisuals(true);
  }

  /** 미리보기 해제 (선택도 없으면 빈 툴팁) */
  clearPreview(): void {
    if (this.disposed || !this.preview) return;
    this.preview = null;
    this.updateSelectionVisuals(true);
  }

  get selected(): number | null {
    return this.selectedUid;
  }

  /** 아이템을 끌고 있는 중 (호스트가 Esc·닫기 키를 드래그 취소에 양보할 때) */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** 보관함 index번 칸 중심 (BagView 로컬 좌표) — 구매 아이콘 비행 목적지 */
  stashSlotCenter(index: number): { x: number; y: number } {
    const i = Math.max(0, Math.min(index, this.opts.run.bag.stashCapacity - 1));
    const p = stashSlotPos(this.m, i);
    return { x: p.x + this.m.stashSlot / 2, y: p.y + this.m.stashSlot / 2 };
  }

  /** 보관함 칸 크기 (로컬 px) */
  get stashSlotSize(): number {
    return this.m.stashSlot;
  }

  /** 구매 아이콘이 날아가는 동안 보관함 칸을 비워 둘 때 */
  setItemVisible(uid: number, visible: boolean): void {
    const v = this.views.get(uid) ?? this.stashViews.get(uid);
    if (v) v.visible = visible;
  }

  /** 가방 확장 등: 격자 전체에 반짝이 */
  celebrateGrid(): void {
    const m = this.m;
    sparkleBurst(this.fxLayer, m.gridX + m.gridW / 2, m.gridY + m.gridH / 2, Math.max(m.gridW, m.gridH) * 0.6, 20);
  }

  /** uid 아이템을 통통 튀게 (구매 직후 등) */
  bounce(uid: number): void {
    const v = this.views.get(uid) ?? this.stashViews.get(uid);
    if (v) void pop(v, 1.3);
  }

  override destroy(options?: DestroyOptions): void {
    if (!this.disposed) {
      this.disposed = true;
      this.keyboard.dispose();
      window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
      window.removeEventListener('contextmenu', this.onContextMenu, true);
      this.inputLayer.removeAllListeners();
      this.mergeBtn.onRender = null;
      killTweensOf(this.mergeBtn);
      for (const v of this.views.values()) {
        killTweensOf(v);
        killTweensOf(v.scale);
      }
      for (const v of this.stashViews.values()) {
        killTweensOf(v);
        killTweensOf(v.scale);
      }
      if (this.drag) {
        killTweensOf(this.drag.lift);
        killTweensOf(this.drag.ghost);
        killTweensOf(this.drag.ghost.scale);
      }
      this.drag = null;
      this.press = null;
    }
    super.destroy(options);
  }

  // ───────────────────────────────────────────────────────────
  // 빌드
  // ───────────────────────────────────────────────────────────

  private get bag(): BagState {
    return this.opts.run.bag;
  }

  private rebuild(): void {
    const { data } = this.opts;
    const bag = this.bag;
    this.m = computeBagMetrics(this.opts.width, bag.cols, bag.rows, bag.stashCapacity);
    const m = this.m;
    this.merges = findMerges(bag, data);
    this.overlay.setCell(m.cell);
    this.inputLayer.hitArea = new Rectangle(0, 0, this.opts.width, m.contentHeight);

    const loadout = computeLoadout(bag, data.items, runPlayerStats(data, this.opts.run));
    this.elementsByUid = new Map(loadout.map((w) => [w.uid, w.elements]));

    this.drawFrames();
    this.buildItems();
    this.buildStash();
    this.layoutButtons();

    if (this.selectedUid !== null && !findByUid(bag, this.selectedUid)) this.selectedUid = null;
    this.updateSelectionVisuals(false);
  }

  private drawFrames(): void {
    const m = this.m;
    const g = this.frameG;
    g.clear();
    // 가방 틀
    const pad = 8;
    g.roundRect(m.gridX - pad, m.gridY - pad + 5, m.gridW + pad * 2, m.gridH + pad * 2, 20).fill({ color: 0x000000, alpha: 0.28 });
    g.roundRect(m.gridX - pad, m.gridY - pad, m.gridW + pad * 2, m.gridH + pad * 2, 20)
      .fill(0x4a3466)
      .stroke({ width: 4, color: UI_COLORS.panelBorder });
    const ci = Math.max(2, m.cell * 0.04);
    for (let y = 0; y < this.bag.rows; y++) {
      for (let x = 0; x < this.bag.cols; x++) {
        const cx = m.gridX + x * m.cell + ci;
        const cy = m.gridY + y * m.cell + ci;
        const s = m.cell - ci * 2;
        g.roundRect(cx, cy, s, s, m.cell * 0.18).fill(0x231733);
        g.roundRect(cx, cy + s * 0.55, s, s * 0.45, m.cell * 0.18).fill({ color: 0x2c1e40, alpha: 0.8 });
      }
    }
    // 보관함 틀
    g.roundRect(m.stashX - pad, m.stashY - pad + 5, m.stashW + pad * 2, m.stashH + pad * 2, 18).fill({ color: 0x000000, alpha: 0.28 });
    g.roundRect(m.stashX - pad, m.stashY - pad, m.stashW + pad * 2, m.stashH + pad * 2, 18)
      .fill(shade(UI_COLORS.panel, 0.85))
      .stroke({ width: 3, color: shade(UI_COLORS.panelBorder, 0.8) });
    for (let i = 0; i < this.bag.stashCapacity; i++) {
      const p = stashSlotPos(m, i);
      g.roundRect(p.x, p.y, m.stashSlot, m.stashSlot, m.stashSlot * 0.2)
        .fill(0x1d1329)
        .stroke({ width: 2, color: 0x3a2a50 });
    }
    const n = this.bag.stash.length;
    const cap = this.bag.stashCapacity;
    this.stashLabel.text = T.bag.stashCount(n, cap);
    this.stashLabel.style.fill = n >= cap ? UI_COLORS.bad : UI_COLORS.textDim;
    this.stashLabel.position.set(m.stashX + m.stashW / 2, m.stashY);
  }

  private buildItems(): void {
    const { data } = this.opts;
    const m = this.m;
    for (const c of this.itemsLayer.removeChildren()) c.destroy({ children: true });
    this.views.clear();
    for (const it of this.bag.items) {
      const def = data.items[it.defId];
      if (!def) continue;
      const v = new ItemView(def, it.tier, it.rot, m.cell, { elements: this.elementsByUid.get(it.uid) });
      v.position.set(m.gridX + it.x * m.cell + v.fw / 2, m.gridY + it.y * m.cell + v.fh / 2);
      if (this.drag?.uid === it.uid) v.alpha = 0.3;
      this.itemsLayer.addChild(v);
      this.views.set(it.uid, v);
    }
  }

  private buildStash(): void {
    const { data } = this.opts;
    const m = this.m;
    for (const c of this.stashLayer.removeChildren()) c.destroy({ children: true });
    this.stashViews.clear();
    this.bag.stash.forEach((s, i) => {
      const def = data.items[s.defId];
      if (!def) return;
      const sizeLabel = def.w * def.h > 1 ? T.bag.sizeBadge(def.w, def.h) : null;
      const v = new SlotItemView(def, s.tier, m.stashSlot, sizeLabel);
      const p = stashSlotPos(m, i);
      v.position.set(p.x + m.stashSlot / 2, p.y + m.stashSlot / 2);
      this.stashLayer.addChild(v);
      this.stashViews.set(s.uid, v);
    });
  }

  private layoutButtons(): void {
    const m = this.m;
    const y = m.buttonsY + 2;
    const inner = this.opts.width - MARGIN * 2;
    if (this.sellZone) {
      const bw = Math.floor((inner - BTN_GAP * 2) * 0.3);
      this.rotateBtn.position.set(MARGIN, y);
      this.mergeBtn.position.set(MARGIN + bw + BTN_GAP, y);
      this.sellZone.position.set(MARGIN + (bw + BTN_GAP) * 2, y);
    } else {
      const bw = 200;
      const total = bw * 2 + BTN_GAP * 2;
      const x0 = (this.opts.width - total) / 2;
      this.rotateBtn.position.set(x0, y);
      this.mergeBtn.position.set(x0 + bw + BTN_GAP * 2, y);
    }
    this.mergeBtnBase = { x: this.mergeBtn.x, y: this.mergeBtn.y };
  }

  // ───────────────────────────────────────────────────────────
  // 선택 / 툴팁 / 표시층
  // ───────────────────────────────────────────────────────────

  private select(uid: number | null, fromUser: boolean): void {
    const changed = uid !== this.selectedUid || this.preview !== null;
    this.selectedUid = uid;
    this.preview = null;
    if (changed) this.resetSellConfirm();
    this.updateSelectionVisuals(changed);
    if (uid !== null && changed) this.bounce(uid);
    if (fromUser && uid !== null && changed) sfx.playAt('ui_tap', 0, 1.08, 0.7);
    if (fromUser) this.opts.onSelect?.(uid);
  }

  private updateSelectionVisuals(animateTooltip: boolean): void {
    const { data, run } = this.opts;
    const bag = this.bag;
    const drag = this.drag;
    const uid = drag ? drag.uid : this.selectedUid;
    const found = uid !== null ? findByUid(bag, uid) : null;

    // 툴팁
    if (found) {
      const model = buildItemTooltip(
        data,
        run,
        { defId: found.item.defId, tier: found.item.tier, uid: found.item.uid, where: found.where },
        this.merges,
      );
      this.tooltip.show(model ?? buildEmptyTooltip(), animateTooltip);
    } else if (this.preview) {
      const model = buildItemTooltip(data, run, { ...this.preview, uid: null, where: 'preview' }, this.merges);
      this.tooltip.show(model ?? buildEmptyTooltip(), animateTooltip);
    } else {
      this.tooltip.show(buildEmptyTooltip(), animateTooltip);
    }

    // 표시층 (드래그 중에는 updateDragOverlay가 담당)
    if (!drag) {
      this.overlay.setConnectors(this.connectorsFor(bag, this.merges));
      if (found?.where === 'bag') {
        this.overlay.setSelection(this.itemRect(bag, found.item.uid));
        this.overlay.setSockets(this.socketMarkers(bag, found.item.defId, found.item.uid));
        this.overlay.setOutlines(this.buffPartners(bag, found.item.uid));
      } else if (found?.where === 'stash') {
        this.overlay.setSelection(this.stashRect(found.item.uid));
        this.overlay.setSockets(this.socketMarkers(bag, found.item.defId, null));
        this.overlay.setOutlines([]);
      } else if (this.preview) {
        this.overlay.setSelection(null);
        this.overlay.setSockets(this.socketMarkers(bag, this.preview.defId, null));
        this.overlay.setOutlines([]);
      } else {
        this.overlay.setSelection(null);
        this.overlay.setSockets([]);
        this.overlay.setOutlines([]);
      }
    }
    this.updateButtons();
  }

  private updateButtons(): void {
    const sel = this.drag ? null : this.selectedUid;
    const found = sel !== null ? findByUid(this.bag, sel) : null;
    this.rotateBtn.setEnabled(found?.where === 'bag');
    const opts = sel !== null && found?.where === 'bag' ? mergesFor(this.merges, sel) : [];
    this.mergeBtn.setEnabled(opts.length > 0);
    this.mergeBtn.setLabel(opts.length === 0 ? T.bag.merge : opts[0].kind === 'recipe' ? T.bag.mergeRecipe : T.bag.mergeTier);
    this.mergeBtn.setColor(opts.length > 0 && opts[0].kind === 'recipe' ? 0xd04fd0 : 0xf0a020);
    this.updateSellZone();
  }

  private updateSellZone(): void {
    const z = this.sellZone;
    if (!z) return;
    const { data } = this.opts;
    const drag = this.drag;
    if (drag) {
      const def = data.items[drag.defId];
      const price = def ? sellPrice(def, drag.tier) : null;
      z.set(drag.zone === 'sell' ? 'hover' : 'armed', price);
      return;
    }
    const found = this.selectedUid !== null ? findByUid(this.bag, this.selectedUid) : null;
    if (!found) {
      z.set('idle', null);
      return;
    }
    const def = data.items[found.item.defId];
    const price = def ? sellPrice(def, found.item.tier) : null;
    z.set(this.sellConfirmUid === found.item.uid ? 'confirm' : 'selected', price);
  }

  private itemRect(bag: BagState, uid: number): RectLike | null {
    const it = bag.items.find((i) => i.uid === uid);
    const def = it ? this.opts.data.items[it.defId] : undefined;
    if (!it || !def) return null;
    const f = footprint(def, it.rot);
    const m = this.m;
    return { x: m.gridX + it.x * m.cell, y: m.gridY + it.y * m.cell, w: f.w * m.cell, h: f.h * m.cell };
  }

  private stashRect(uid: number): RectLike | null {
    const idx = this.bag.stash.findIndex((s) => s.uid === uid);
    if (idx < 0) return null;
    const p = stashSlotPos(this.m, idx);
    return { x: p.x, y: p.y, w: this.m.stashSlot, h: this.m.stashSlot };
  }

  private itemCenter(bag: BagState, uid: number): { x: number; y: number } | null {
    const r = this.itemRect(bag, uid);
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  }

  private connectorsFor(bag: BagState, merges: MergeOption[], previewUid?: number): Connector[] {
    const out: Connector[] = [];
    for (const o of merges) {
      if (previewUid !== undefined && o.anchorUid !== previewUid && o.consumedUid !== previewUid) continue;
      const a = this.itemCenter(bag, o.anchorUid);
      const b = this.itemCenter(bag, o.consumedUid);
      if (!a || !b) continue;
      out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, kind: o.kind, preview: previewUid !== undefined });
    }
    return out;
  }

  /** 버프 관계: 강화석이면 맞닿은 무기, 무기면 버프를 주는 강화석 */
  private buffPartners(bag: BagState, uid: number): RectLike[] {
    const { data } = this.opts;
    const self = bag.items.find((i) => i.uid === uid);
    const def = self ? data.items[self.defId] : undefined;
    if (!self || !def) return [];
    let uids: number[] = [];
    if (def.kind === 'stone') {
      uids = neighbors(bag, data.items, uid)
        .filter((n) => data.items[n.defId]?.kind === 'weapon')
        .map((n) => n.uid);
    } else if (def.kind === 'weapon') {
      uids = stoneBuffsFor(bag, data.items, uid).sourceUids;
    }
    return uids.map((u) => this.itemRect(bag, u)).filter((r): r is RectLike => r !== null);
  }

  /**
   * ◇ 소켓 표시. defId가 레시피 base면 (가방 안의) 자기 소켓, 재료면 자기를 받는 base들의 소켓.
   * uid는 bag 안의 그 아이템 (보관함/미리보기면 null).
   */
  private socketMarkers(bag: BagState, defId: string, uid: number | null): SocketMarker[] {
    const { data } = this.opts;
    const items = data.items;
    const m = this.m;
    const byCell = new Map<string, SocketMarker>();
    const add = (x: number, y: number, mk: Omit<SocketMarker, 'cx' | 'cy'>): void => {
      if (x < 0 || y < 0 || x >= bag.cols || y >= bag.rows) return;
      const key = `${x},${y}`;
      const prev = byCell.get(key);
      if (prev && (prev.satisfied || !mk.satisfied)) return;
      byCell.set(key, { cx: m.gridX + (x + 0.5) * m.cell, cy: m.gridY + (y + 0.5) * m.cell, ...mk });
    };

    const asBase = data.recipes.filter((r) => r.base === defId);
    const self = uid !== null ? bag.items.find((i) => i.uid === uid) : undefined;
    if (self && asBase.length > 0) {
      const ingIds = [...new Set(asBase.map((r) => r.ingredient))];
      const icons = ingIds.map((id) => items[id]?.icon).filter((k): k is string => !!k);
      for (const s of itemSockets(self, items[defId])) {
        if (s.x < 0 || s.y < 0 || s.x >= bag.cols || s.y >= bag.rows) continue;
        const occ = getOccupant(bag, items, s.x, s.y);
        const satisfied = !!occ && occ.uid !== self.uid && ingIds.includes(occ.defId);
        add(s.x, s.y, { satisfied, ghostIcons: icons, occupied: !!occ && !satisfied });
      }
    }

    const asIng = data.recipes.filter((r) => r.ingredient === defId);
    if (asIng.length > 0) {
      const baseIds = new Set(asIng.map((r) => r.base));
      const icon = items[defId]?.icon;
      for (const base of bag.items) {
        if (!baseIds.has(base.defId) || base.uid === uid) continue;
        const bdef = items[base.defId];
        if (!bdef) continue;
        for (const s of itemSockets(base, bdef)) {
          if (s.x < 0 || s.y < 0 || s.x >= bag.cols || s.y >= bag.rows) continue;
          const occ = getOccupant(bag, items, s.x, s.y);
          const satisfied = !!occ && uid !== null && occ.uid === uid;
          add(s.x, s.y, { satisfied, ghostIcons: icon ? [icon] : [], occupied: !!occ && !satisfied });
        }
      }
    }
    return [...byCell.values()];
  }

  // ───────────────────────────────────────────────────────────
  // 입력
  // ───────────────────────────────────────────────────────────

  /** 화면에 보이는 중인지 (숨겨진 일시정지 오버레이에서 키 입력 무시) */
  private isShown(): boolean {
    for (let c: Container | null = this; c; c = c.parent) {
      if (!c.visible) return false;
    }
    return true;
  }

  private cssScale(): number {
    return Math.abs(this.worldTransform.a) || 1;
  }

  private hitAt(x: number, y: number): Hit | null {
    const m = this.m;
    const bag = this.bag;
    const gx = Math.floor((x - m.gridX) / m.cell);
    const gy = Math.floor((y - m.gridY) / m.cell);
    if (gx >= 0 && gy >= 0 && gx < bag.cols && gy < bag.rows) {
      const occ = getOccupant(bag, this.opts.data.items, gx, gy);
      return occ ? { where: 'bag', uid: occ.uid } : null;
    }
    const si = stashIndexAt(m, x, y, bag.stashCapacity);
    if (si >= 0 && si < bag.stash.length) return { where: 'stash', uid: bag.stash[si].uid };
    return null;
  }

  /** 격자/보관함 영역 안을 눌렀는지 (빈 칸 탭 = 선택 해제) */
  private inBagArea(x: number, y: number): boolean {
    const m = this.m;
    const inGrid = x >= m.gridX && x < m.gridX + m.gridW && y >= m.gridY && y < m.gridY + m.gridH;
    return inGrid || inStashArea(m, x, y, 0);
  }

  private readonly onPointerDown = (e: FederatedPointerEvent): void => {
    if (this.disposed) return;
    const local = e.getLocalPosition(this);
    if (this.drag) {
      // 같은 포인터가 다시 눌렸다 = 놓는 이벤트를 놓쳤다 → 원래 자리로 돌리고 새로 시작
      if (e.pointerId !== this.drag.pointerId) return; // 다른 손가락은 무시 (두 번째 손가락 회전은 window 리스너)
      this.press = null;
      this.cancelDrag(true);
    } else if (this.press && this.press.pointerId !== e.pointerId) {
      return;
    }
    const touch = e.pointerType !== 'mouse';
    if (!touch && e.button === 2) {
      // 오른쪽 클릭 = 그 자리 회전
      this.suppressContextUntil = performance.now() + CONTEXT_SUPPRESS_MS;
      const hit = this.hitAt(local.x, local.y);
      if (hit?.where === 'bag') {
        this.select(hit.uid, true);
        this.rotateInPlace(hit.uid);
      }
      return;
    }
    if (!touch && e.button !== 0) return;
    this.press = { pointerId: e.pointerId, touch, gx: e.global.x, gy: e.global.y, hit: this.hitAt(local.x, local.y), buttons: e.buttons };
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    const press = this.press;
    if (this.disposed || !press || e.pointerId !== press.pointerId) return;
    const local = e.getLocalPosition(this);
    if (this.drag) {
      // 왼쪽 버튼을 누른 채 오른쪽 버튼을 누르면 pointerdown 대신 pointermove(buttons 변화)가 온다
      if (!press.touch && e.buttons & 2 && !(press.buttons & 2)) {
        this.suppressContextUntil = performance.now() + CONTEXT_SUPPRESS_MS;
        this.rotateDrag();
      }
      press.buttons = e.buttons;
      this.moveDrag(local.x, local.y);
      return;
    }
    press.buttons = e.buttons;
    const dist = Math.hypot(e.global.x - press.gx, e.global.y - press.gy);
    if (press.hit && dist >= DRAG_THRESHOLD_CSS) this.beginDrag(press, local.x, local.y);
  };

  private readonly onPointerUp = (e: FederatedPointerEvent): void => {
    const press = this.press;
    if (this.disposed || !press || e.pointerId !== press.pointerId) return;
    this.press = null;
    if (this.drag) {
      this.drop();
      return;
    }
    const local = e.getLocalPosition(this);
    this.handleTap(press.hit, local.x, local.y);
  };

  private readonly onPointerCancel = (e: FederatedPointerEvent): void => {
    if (!this.press || e.pointerId !== this.press.pointerId) return;
    this.press = null;
    if (this.drag) this.cancelDrag(true);
  };

  /** 드래그 중 두 번째 손가락 탭 = 회전 (화면 어디든) */
  private readonly onWindowPointerDown = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId === drag.pointerId || e.pointerType === 'mouse') return;
    this.rotateDrag();
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.drag || performance.now() < this.suppressContextUntil) e.preventDefault();
  };

  private handleTap(hit: Hit | null, x: number, y: number): void {
    const now = performance.now();
    if (!hit) {
      this.lastTap = null;
      if (this.inBagArea(x, y) && (this.selectedUid !== null || this.preview)) this.select(null, true);
      return;
    }
    const last = this.lastTap;
    if (last && last.uid === hit.uid && now - last.time < DOUBLE_TAP_MS) {
      this.lastTap = null;
      if (hit.where === 'bag') this.rotateInPlace(hit.uid);
      else this.autoPlace(hit.uid);
      return;
    }
    this.lastTap = { uid: hit.uid, time: now };
    this.select(hit.uid, true);
  }

  // ───────────────────────────────────────────────────────────
  // 드래그
  // ───────────────────────────────────────────────────────────

  private beginDrag(press: Press, x: number, y: number): void {
    const hit = press.hit;
    if (!hit) return;
    const { data } = this.opts;
    const found = findByUid(this.bag, hit.uid);
    if (!found) return;
    const def = data.items[found.item.defId];
    if (!def) return;
    const m = this.m;
    const rot: Rot = found.where === 'bag' ? found.item.rot : 0;
    const ghost = new ItemView(def, found.item.tier, rot, m.cell, { elements: this.elementsByUid.get(hit.uid) });

    let homeX: number;
    let homeY: number;
    let homeScale = 1;
    let grabDX: number;
    let grabDY: number;
    if (found.where === 'bag') {
      const v = this.views.get(hit.uid);
      homeX = v?.x ?? x;
      homeY = v?.y ?? y;
      grabDX = x - (homeX - ghost.fw / 2);
      grabDY = y - (homeY - ghost.fh / 2);
      if (v) v.alpha = 0.3;
    } else {
      const v = this.stashViews.get(hit.uid);
      homeX = v?.x ?? x;
      homeY = v?.y ?? y;
      homeScale = m.stashSlot / Math.max(ghost.fw, ghost.fh);
      grabDX = ghost.fw / 2;
      grabDY = ghost.fh / 2;
      if (v) v.alpha = 0.3;
    }

    this.selectedUid = hit.uid;
    this.preview = null;
    this.lastTap = null;
    this.resetSellConfirm();
    this.drag = {
      pointerId: press.pointerId,
      uid: hit.uid,
      from: found.where,
      defId: def.id,
      tier: found.item.tier,
      rot,
      touch: press.touch,
      ghost,
      grabDX,
      grabDY,
      pointer: { x, y },
      zone: 'none',
      tx: 0,
      ty: 0,
      valid: false,
      homeX,
      homeY,
      homeScale,
      key: '',
      gx: homeX,
      gy: homeY,
      lift: { t: 0 },
    };
    tween(this.drag.lift, { t: 1 }, 0.12, 'outQuad');
    sfx.play('item_pick');
    this.attachGhost(ghost);
    ghost.position.set(homeX, homeY);
    ghost.scale.set(homeScale);
    ghost.alpha = GHOST_ALPHA;
    this.ghostLayer.addChild(ghost);
    tween(ghost.scale, { x: 1.06, y: 1.06 }, 0.14, 'outBack');
    this.overlay.setSelection(null);
    this.opts.onSelect?.(hit.uid);
    this.updateSelectionVisuals(true);
    this.moveDrag(x, y);
  }

  /** 고스트가 매 프레임 목표 위치를 따라가게 (들어 올리는 동안은 원래 자리에서 보간) */
  private attachGhost(ghost: ItemView): void {
    ghost.onRender = () => {
      const d = this.drag;
      if (!d || d.ghost !== ghost) return;
      const k = d.lift.t;
      ghost.position.set(d.homeX + (d.gx - d.homeX) * k, d.homeY + (d.gy - d.homeY) * k);
    };
  }

  /** 고스트 좌상단 (로컬) */
  private ghostTopLeft(d: DragState): { x: number; y: number } {
    const g = d.ghost;
    if (d.touch) {
      const k = this.cssScale();
      const lift = Math.max(TOUCH_LIFT_CSS / k, g.fh / 2 + TOUCH_CLEARANCE_CSS / k);
      return { x: d.pointer.x - g.fw / 2, y: d.pointer.y - lift - g.fh / 2 };
    }
    return { x: d.pointer.x - d.grabDX, y: d.pointer.y - d.grabDY };
  }

  private moveDrag(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const m = this.m;
    d.pointer = { x, y };
    const tl = this.ghostTopLeft(d);
    const cx = tl.x + d.ghost.fw / 2;
    const cy = tl.y + d.ghost.fh / 2;
    d.gx = cx;
    d.gy = cy;
    if (d.lift.t >= 1) d.ghost.position.set(cx, cy);

    // 영역 판정: 고스트 중심 우선, 판매 칸은 손가락 위치도 인정
    const sz = this.sellZone;
    const overSell = (px: number, py: number): boolean => !!sz && sz.containsLocal(px - sz.x, py - sz.y);
    const inGridPadded =
      cx >= m.gridX - m.cell * 0.5 && cx <= m.gridX + m.gridW + m.cell * 0.5 && cy >= m.gridY - m.cell * 0.5 && cy <= m.gridY + m.gridH + m.cell * 0.5;
    let zone: DragState['zone'] = 'none';
    if (overSell(cx, cy) || overSell(x, y)) zone = 'sell';
    else if (inStashArea(m, cx, cy)) zone = 'stash';
    else if (inGridPadded) zone = 'grid';
    else if (inStashArea(m, x, y)) zone = 'stash';

    let tx = 0;
    let ty = 0;
    let valid = false;
    if (zone === 'grid') {
      tx = Math.round((tl.x - m.gridX) / m.cell);
      ty = Math.round((tl.y - m.gridY) / m.cell);
      valid = canPlace(this.bag, this.opts.data.items, d.defId, tx, ty, d.rot, d.from === 'bag' ? d.uid : undefined);
    }
    d.zone = zone;
    d.tx = tx;
    d.ty = ty;
    d.valid = valid;

    const key = `${zone}:${tx}:${ty}:${d.rot}`;
    if (key !== d.key) {
      d.key = key;
      this.updateDragOverlay();
    }
  }

  /** 드래그 목표가 바뀔 때: 칸 미리보기 + 가상 배치로 합성/소켓/버프 미리보기 */
  private updateDragOverlay(): void {
    const d = this.drag;
    if (!d) return;
    const { data } = this.opts;
    const m = this.m;
    const g = this.previewG;
    g.clear();
    this.updateSellZone();

    const def = data.items[d.defId];
    if (!def) return;

    // 가상 가방: 놓을 수 있으면 그 자리에 둔 상태, 아니면 빼 둔 상태
    const sim: BagState = structuredClone(this.bag);
    let placed = false;
    if (d.zone === 'grid' && d.valid) {
      placed = d.from === 'bag' ? moveItem(sim, data.items, d.uid, d.tx, d.ty, d.rot) : placeFromStash(sim, data.items, d.uid, d.tx, d.ty, d.rot);
    } else if (d.from === 'bag') {
      sim.items = sim.items.filter((i) => i.uid !== d.uid);
    }

    if (d.zone === 'stash') {
      // 보관함으로 넣기: 자리가 있으면 초록, 가득이면 빨강 (보관함 → 보관함은 그대로)
      const full = d.from === 'bag' && this.bag.stash.length >= this.bag.stashCapacity;
      const color = d.from === 'stash' ? UI_COLORS.panelBorder : full ? UI_COLORS.bad : UI_COLORS.good;
      g.roundRect(m.stashX - 8, m.stashY - 8, m.stashW + 16, m.stashH + 16, 18)
        .fill({ color, alpha: 0.18 })
        .stroke({ width: 5, color, alpha: 0.95 });
    }

    if (d.zone === 'grid') {
      const f = footprint(def, d.rot);
      const color = d.valid ? UI_COLORS.good : UI_COLORS.bad;
      for (let yy = 0; yy < f.h; yy++) {
        for (let xx = 0; xx < f.w; xx++) {
          const cx = d.tx + xx;
          const cy = d.ty + yy;
          const inside = cx >= 0 && cy >= 0 && cx < this.bag.cols && cy < this.bag.rows;
          if (!inside) continue;
          const px = m.gridX + cx * m.cell + 3;
          const py = m.gridY + cy * m.cell + 3;
          g.roundRect(px - 2, py - 2, m.cell - 2, m.cell - 2, m.cell * 0.2)
            .fill({ color, alpha: 0.42 })
            .stroke({ width: 5, color, alpha: 1 });
        }
      }
    }

    if (placed) {
      const merges = findMerges(sim, data);
      this.overlay.setConnectors(this.connectorsFor(sim, merges, d.uid));
      this.overlay.setOutlines(this.buffPartners(sim, d.uid));
      this.overlay.setSockets(this.socketMarkers(sim, d.defId, d.uid));
    } else {
      // 이 아이템이 빠진 가방의 합성 + (재료면) 넣을 수 있는 소켓 안내
      this.overlay.setConnectors(this.connectorsFor(sim, findMerges(sim, data)));
      this.overlay.setOutlines([]);
      this.overlay.setSockets(this.socketMarkers(sim, d.defId, null));
    }
  }

  private rotateDrag(): void {
    const d = this.drag;
    if (!d) return;
    const { data } = this.opts;
    const def = data.items[d.defId];
    if (!def) return;
    const old = d.ghost;
    const nextRot = ((d.rot + 1) % 4) as Rot;
    const ghost = new ItemView(def, d.tier, nextRot, this.m.cell, { elements: this.elementsByUid.get(d.uid) });
    ghost.position.copyFrom(old.position);
    ghost.scale.set(1.06);
    ghost.alpha = GHOST_ALPHA;
    killTweensOf(old.scale);
    old.destroy({ children: true });
    this.ghostLayer.addChild(ghost);
    this.attachGhost(ghost);
    // 아이콘이 90° 돌아가는 연출
    const target = ghost.iconHolder.rotation;
    ghost.iconHolder.rotation = target - Math.PI / 2;
    tween(ghost.iconHolder, { rotation: target }, 0.14, 'outBack');
    d.ghost = ghost;
    d.rot = nextRot;
    sfx.play('item_rotate');
    // 마우스는 고스트 중심을 잡은 것으로
    d.grabDX = ghost.fw / 2;
    d.grabDY = ghost.fh / 2;
    d.key = '';
    this.moveDrag(d.pointer.x, d.pointer.y);
  }

  private drop(): void {
    const d = this.drag;
    if (!d) return;
    const { data, run } = this.opts;
    const bag = this.bag;

    if (d.zone === 'sell' && this.sellZone) {
      const gold = sellItem(data, run, d.uid);
      if (gold > 0) {
        const z = this.sellZone;
        this.finishDrag();
        this.afterSell(gold, z.x + z.zw / 2, z.y + z.zh / 2, d.ghost);
        return;
      }
      sfx.play('ui_error');
      this.snapBack();
      return;
    }

    if (d.zone === 'stash') {
      if (d.from === 'bag') {
        if (moveToStash(bag, d.uid)) {
          this.finishDrag(d.ghost);
          this.afterMutation();
          this.bounce(d.uid);
          sfx.play('item_place');
          return;
        }
        sfx.play('ui_error');
        Toast.show(this, T.bag.stashFull, { y: this.toastY(), color: UI_COLORS.bad });
      }
      this.snapBack();
      return;
    }

    if (d.zone === 'grid' && d.valid) {
      const ok =
        d.from === 'bag'
          ? moveItem(bag, data.items, d.uid, d.tx, d.ty, d.rot)
          : placeFromStash(bag, data.items, d.uid, d.tx, d.ty, d.rot);
      if (ok) {
        this.finishDrag(d.ghost);
        this.afterMutation();
        this.landSquash(d.uid);
        sfx.play('item_place');
        return;
      }
    }

    if (d.zone === 'grid') {
      sfx.play('ui_error');
      Toast.show(this, T.bag.cannotPlace, { y: this.toastY(), color: UI_COLORS.bad });
    }
    this.snapBack();
  }

  /** 드래그 상태 정리 (고스트는 넘겨받으면 바로 제거) */
  private finishDrag(ghostToDestroy?: ItemView): void {
    const d = this.drag;
    this.drag = null;
    this.previewG.clear();
    if (d) {
      killTweensOf(d.lift);
      d.ghost.onRender = null;
    }
    if (ghostToDestroy && !ghostToDestroy.destroyed) {
      killTweensOf(ghostToDestroy.scale);
      killTweensOf(ghostToDestroy.iconHolder);
      ghostToDestroy.destroy({ children: true });
    }
    if (d) {
      const v = this.views.get(d.uid) ?? this.stashViews.get(d.uid);
      if (v) v.alpha = 1;
    }
  }

  /** 제자리로 날아가 돌아오기 */
  private snapBack(): void {
    const d = this.drag;
    if (!d) return;
    const ghost = d.ghost;
    const uid = d.uid;
    this.finishDrag();
    const v = this.views.get(uid) ?? this.stashViews.get(uid);
    if (v) v.alpha = 0.3;
    killTweensOf(ghost.scale);
    void Promise.all([
      tween(ghost, { x: d.homeX, y: d.homeY }, 0.18, 'outQuad'),
      tween(ghost.scale, { x: d.homeScale, y: d.homeScale }, 0.18, 'outQuad'),
    ]).then(() => {
      if (!ghost.destroyed) ghost.destroy({ children: true });
      const view = this.views.get(uid) ?? this.stashViews.get(uid);
      if (view && !view.destroyed) view.alpha = 1;
    });
    this.updateSelectionVisuals(false);
  }

  private cancelDrag(animate: boolean): void {
    if (!this.drag) return;
    if (animate) {
      this.snapBack();
      return;
    }
    const ghost = this.drag.ghost;
    this.finishDrag(ghost);
  }

  private landSquash(uid: number): void {
    const v = this.views.get(uid);
    if (!v) return;
    killTweensOf(v.scale);
    v.scale.set(1.12, 0.9);
    tween(v.scale, { x: 1, y: 1 }, 0.25, 'outBack');
  }

  // ───────────────────────────────────────────────────────────
  // 동작 (회전 / 합성 / 판매 / 자동 배치)
  // ───────────────────────────────────────────────────────────

  private afterMutation(): void {
    this.rebuild();
    this.opts.onChange?.();
  }

  private toastY(): number {
    return this.m.gridY + this.m.gridH / 2;
  }

  private rotateSelected(): void {
    const uid = this.selectedUid;
    if (uid === null) return;
    const found = findByUid(this.bag, uid);
    if (found?.where === 'bag') this.rotateInPlace(uid, true);
  }

  /**
   * 같은 자리에서 회전. nudge면(회전 버튼·R키) 안 맞을 때 가까운 자리도 찾는다.
   * 더블탭·오른쪽 클릭은 제자리만. 둘 다 실패하면 흔들기 + 알림.
   */
  private rotateInPlace(uid: number, nudge = false): void {
    const { data } = this.opts;
    const bag = this.bag;
    const it = bag.items.find((i) => i.uid === uid);
    const def = it ? data.items[it.defId] : undefined;
    if (!it || !def) return;
    const nextRot = ((it.rot + 1) % 4) as Rot;
    const f0 = footprint(def, it.rot);
    const f1 = footprint(def, nextRot);
    // 회전 전 중심과 가장 가까운 자리부터
    const ocx = it.x + f0.w / 2;
    const ocy = it.y + f0.h / 2;
    const cands: { x: number; y: number; d: number }[] = [];
    const reach = nudge ? 2 : 0;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = it.x + dx;
        const y = it.y + dy;
        const same = dx === 0 && dy === 0;
        const d = same ? -1 : Math.hypot(x + f1.w / 2 - ocx, y + f1.h / 2 - ocy) + (Math.abs(dx) + Math.abs(dy)) * 0.01;
        cands.push({ x, y, d });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    const spot = cands.find((c) => canPlace(bag, data.items, it.defId, c.x, c.y, nextRot, uid));
    if (!spot || !moveItem(bag, data.items, uid, spot.x, spot.y, nextRot)) {
      const v = this.views.get(uid);
      if (v) void shake(v, v.x);
      sfx.play('ui_error');
      Toast.show(this, T.bag.cannotRotate, { y: this.toastY(), color: UI_COLORS.bad });
      return;
    }
    sfx.play('item_rotate');
    this.selectedUid = uid;
    this.afterMutation();
    const v = this.views.get(uid);
    if (v) {
      const target = v.iconHolder.rotation;
      v.iconHolder.rotation = target - Math.PI / 2;
      tween(v.iconHolder, { rotation: target }, 0.2, 'outBack');
      void pop(v, 1.1);
    }
  }

  /** 보관함 아이템 더블탭: 가방 빈자리에 자동 배치 */
  private autoPlace(uid: number): void {
    const { data } = this.opts;
    const bag = this.bag;
    const s = bag.stash.find((i) => i.uid === uid);
    if (!s) return;
    const spot = findFreeSpot(bag, data.items, s.defId);
    if (!spot || !placeFromStash(bag, data.items, uid, spot.x, spot.y, spot.rot)) {
      const v = this.stashViews.get(uid);
      if (v) void shake(v, v.x);
      sfx.play('ui_error');
      Toast.show(this, T.bag.noFreeSpot, { y: this.toastY(), color: UI_COLORS.bad });
      return;
    }
    this.selectedUid = uid;
    this.afterMutation();
    this.landSquash(uid);
    sfx.play('item_place');
  }

  private mergeSelected(): void {
    const uid = this.selectedUid;
    if (uid === null || this.drag) return;
    const { data } = this.opts;
    const opt = mergesFor(this.merges, uid)[0];
    if (!opt) return;
    const result = applyMerge(this.bag, data, opt, uid);
    if (!result) {
      this.rebuild();
      return;
    }
    this.selectedUid = result.uid;
    this.afterMutation();
    this.celebrate(result.uid, opt);
  }

  private celebrate(uid: number, opt: MergeOption): void {
    const { data } = this.opts;
    const v = this.views.get(uid);
    const c = this.itemCenter(this.bag, uid);
    if (v) {
      killTweensOf(v.scale);
      v.scale.set(1.6);
      tween(v.scale, { x: 1, y: 1 }, 0.7, 'outElastic');
    }
    if (c) {
      const size = v ? Math.max(v.fw, v.fh) : this.m.cell;
      const colors = opt.kind === 'tier' ? [MERGE_TIER_COLOR, 0xffffff, 0xffb02e] : [MERGE_RECIPE_COLOR, 0xffffff, 0x7cf5ff, MERGE_TIER_COLOR];
      sparkleBurst(this.fxLayer, c.x, c.y, size, 18, colors);
    }
    sfx.play(opt.kind === 'tier' ? 'merge_tier' : 'merge_evolve');
    const name = data.items[opt.resultDefId]?.name ?? '';
    const text = opt.kind === 'tier' ? T.bag.tierUp(opt.resultTier) : T.bag.evolvedToast(name);
    Toast.show(this, text, { y: this.toastY(), color: opt.kind === 'tier' ? 0xc98a10 : 0xa03ca8 });
  }

  private resetSellConfirm(): void {
    this.sellConfirmUid = null;
    this.sellConfirmToken++;
  }

  private onSellTap(): void {
    if (this.drag) return;
    const uid = this.selectedUid;
    if (uid === null || !findByUid(this.bag, uid)) {
      Toast.show(this, T.bag.sellZone, { y: this.toastY() });
      return;
    }
    if (this.sellConfirmUid !== uid) {
      sfx.play('ui_tap');
      this.sellConfirmUid = uid;
      const token = ++this.sellConfirmToken;
      this.updateSellZone();
      void delay(SELL_CONFIRM_SEC).then(() => {
        if (this.disposed || token !== this.sellConfirmToken) return;
        this.sellConfirmUid = null;
        this.updateSellZone();
      });
      return;
    }
    const { data, run } = this.opts;
    const v = this.views.get(uid) ?? this.stashViews.get(uid);
    const from = v ? { x: v.x, y: v.y } : null;
    const gold = sellItem(data, run, uid);
    this.resetSellConfirm();
    if (gold <= 0) return;
    const z = this.sellZone!;
    // 판매된 아이템 그림을 판매 칸으로 날린다
    let flyer: ItemView | undefined;
    if (from && v instanceof ItemView) {
      flyer = new ItemView(v.def, v.tier, v.rot, this.m.cell);
      flyer.position.set(from.x, from.y);
      this.ghostLayer.addChild(flyer);
    }
    this.afterSell(gold, z.x + z.zw / 2, z.y + z.zh / 2, flyer);
  }

  private afterSell(gold: number, zx: number, zy: number, flyer?: ItemView): void {
    this.selectedUid = null;
    this.afterMutation();
    if (flyer && !flyer.destroyed) {
      killTweensOf(flyer.scale);
      void Promise.all([
        tween(flyer, { x: zx, y: zy, alpha: 0.2 }, 0.22, 'inQuad'),
        tween(flyer.scale, { x: 0.2, y: 0.2 }, 0.22, 'inQuad'),
      ]).then(() => {
        if (!flyer.destroyed) flyer.destroy({ children: true });
      });
    }
    sfx.play('ui_sell');
    sparkleBurst(this.fxLayer, zx, zy, 90, 12, [UI_COLORS.gold, 0xffffff, 0xffe14a]);
    Toast.show(this, T.bag.soldToast(gold), { y: this.toastY(), color: 0xc98a10 });
  }
}
