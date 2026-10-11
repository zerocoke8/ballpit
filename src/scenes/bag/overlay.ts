// 가방 위 표시층: 합성 반짝이 연결선, ◇ 소켓 표시, 버프 테두리, 선택 테두리. onRender로 깜빡인다.
import { Container, Graphics, type DestroyOptions } from 'pixi.js';
import { UI_COLORS } from '../../config';
import { diamond, fitSprite, sparkle } from './itemSprite';

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Connector {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: 'tier' | 'recipe';
  /** 드래그 중 미리보기 (조금 더 밝게) */
  preview?: boolean;
}

export interface SocketMarker {
  /** 칸 중심 */
  cx: number;
  cy: number;
  satisfied: boolean;
  /** 비어 있을 때 흐리게 보여줄 재료 아이콘 키 */
  ghostIcons: string[];
  /** 다른 아이템이 차지 중 (고스트 아이콘 생략) */
  occupied: boolean;
}

export const MERGE_TIER_COLOR = 0xffe14a;
export const MERGE_RECIPE_COLOR = 0xff8af0;
const SOCKET_ON = 0x7cf5ff;
const SELECT_COLOR = 0xffffff;

export class BagOverlay extends Container {
  private readonly ghosts = new Container();
  private readonly g = new Graphics();
  private cell = 84;
  private connectors: Connector[] = [];
  private sockets: SocketMarker[] = [];
  private outlines: RectLike[] = [];
  private selection: RectLike | null = null;

  constructor() {
    super();
    this.eventMode = 'none';
    this.addChild(this.ghosts, this.g);
    this.onRender = () => this.draw();
  }

  setCell(cell: number): void {
    this.cell = cell;
  }

  setConnectors(list: Connector[]): void {
    this.connectors = list;
  }

  setOutlines(list: RectLike[]): void {
    this.outlines = list;
  }

  setSelection(rect: RectLike | null): void {
    this.selection = rect;
  }

  setSockets(list: SocketMarker[]): void {
    this.sockets = list;
    for (const c of this.ghosts.removeChildren()) c.destroy();
    const size = this.cell * 0.42;
    for (const m of list) {
      if (m.satisfied || m.occupied || m.ghostIcons.length === 0) continue;
      const n = m.ghostIcons.length;
      m.ghostIcons.forEach((key, i) => {
        const s = fitSprite(key, size / Math.sqrt(n), size / Math.sqrt(n));
        s.position.set(m.cx + (i - (n - 1) / 2) * (size / n), m.cy);
        s.alpha = 0.5;
        this.ghosts.addChild(s);
      });
    }
  }

  clearAll(): void {
    this.connectors = [];
    this.outlines = [];
    this.selection = null;
    this.setSockets([]);
  }

  override destroy(options?: DestroyOptions): void {
    this.onRender = null;
    super.destroy(options);
  }

  private draw(): void {
    const t = performance.now() / 1000;
    const g = this.g;
    const cell = this.cell;
    g.clear();

    // 버프 관계 테두리
    const pulse = 0.55 + 0.35 * Math.sin(t * 5);
    for (const r of this.outlines) {
      g.roundRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4, cell * 0.2).stroke({ width: 4, color: UI_COLORS.good, alpha: pulse });
    }

    // 선택 테두리
    const s = this.selection;
    if (s) {
      const grow = 2 + Math.sin(t * 6) * 1.5;
      g.roundRect(s.x - grow, s.y - grow, s.w + grow * 2, s.h + grow * 2, cell * 0.22).stroke({
        width: 5,
        color: SELECT_COLOR,
        alpha: 0.95,
      });
    }

    // ◇ 소켓
    const dr = cell * 0.3;
    const half = cell / 2;
    for (const m of this.sockets) {
      // 아이템이 차지한 칸은 아이콘을 가리지 않게 칸 테두리 + 모서리 배지로
      const bx = m.cx + half - cell * 0.17;
      const by = m.cy - half + cell * 0.17;
      if (m.satisfied) {
        const glow = 0.55 + 0.4 * Math.sin(t * 7);
        g.roundRect(m.cx - half + 3, m.cy - half + 3, cell - 6, cell - 6, cell * 0.2).stroke({ width: 5, color: SOCKET_ON, alpha: glow });
        diamond(g, bx, by, cell * 0.17).fill({ color: SOCKET_ON, alpha: 0.4 * glow });
        diamond(g, bx, by, cell * 0.11).fill(SOCKET_ON).stroke({ width: 2.5, color: 0xffffff });
      } else if (m.occupied) {
        diamond(g, bx, by, cell * 0.1).fill({ color: 0x000000, alpha: 0.4 }).stroke({ width: 2.5, color: 0xffffff, alpha: 0.7 });
      } else {
        const a = 0.45 + 0.15 * Math.sin(t * 3);
        diamond(g, m.cx, m.cy, dr * 1.15).fill({ color: 0x000000, alpha: 0.18 }).stroke({ width: 3, color: 0xffffff, alpha: a });
      }
    }

    // 합성 반짝이 연결선
    for (const c of this.connectors) {
      const color = c.kind === 'tier' ? MERGE_TIER_COLOR : MERGE_RECIPE_COLOR;
      const base = c.preview ? 0.9 : 0.7;
      const a = base + (1 - base) * Math.sin(t * 6);
      g.moveTo(c.ax, c.ay).lineTo(c.bx, c.by).stroke({ width: 12, color, alpha: 0.22 * a, cap: 'round' });
      g.moveTo(c.ax, c.ay).lineTo(c.bx, c.by).stroke({ width: 4, color, alpha: 0.85 * a, cap: 'round' });
      // 선을 따라 흐르는 작은 반짝이
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.8 + i / 3) % 1;
        const x = c.ax + (c.bx - c.ax) * p;
        const y = c.ay + (c.by - c.ay) * p;
        sparkle(g, x, y, cell * 0.08 * (0.6 + 0.4 * Math.sin(p * Math.PI)), 0xffffff, 0.9);
      }
      // 가운데 큰 반짝이
      const mx = (c.ax + c.bx) / 2;
      const my = (c.ay + c.by) / 2;
      const sr = cell * (0.2 + 0.06 * Math.sin(t * 8));
      sparkle(g, mx, my, sr * 1.25, color, 0.55);
      sparkle(g, mx, my, sr, 0xffffff, 0.95);
    }
  }
}
