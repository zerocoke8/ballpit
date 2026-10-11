// 처치 위치 → HUD로 날아가는 코인 / 드롭 아이템 아이콘 (씬 좌표). 풀링 + 상한.
import { Container, Sprite } from 'pixi.js';
import { Rng } from '../../logic/rng';
import { tex } from '../../render/assets';
import { MAX_COIN_FLYERS } from './visual';

const COIN_SIZE = 38;
const ITEM_SIZE = 86;

interface Flyer {
  s: Sprite;
  active: boolean;
  kind: 'coin' | 'item';
  amount: number;
  t: number;
  life: number;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  s0: number;
  s1: number;
}

export interface FlyerTargets {
  onCoinArrive(amount: number): void;
  onItemArrive(): void;
}

export class Flyers extends Container {
  private readonly coins: Flyer[] = [];
  private readonly items: Flyer[] = [];
  private readonly rng = new Rng(0x5eed);

  constructor(private readonly targets: FlyerTargets) {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
  }

  /** 상한을 넘으면 즉시 도착 처리 */
  coin(x: number, y: number, toX: number, toY: number, amount: number): void {
    let f: Flyer | undefined;
    for (const c of this.coins) {
      if (!c.active) {
        f = c;
        break;
      }
    }
    if (!f) {
      if (this.coins.length >= MAX_COIN_FLYERS) {
        this.targets.onCoinArrive(amount);
        return;
      }
      f = this.make('coin', 'ui_coin');
      this.coins.push(f);
    }
    const scale = COIN_SIZE / Math.max(1, f.s.texture.width, f.s.texture.height);
    this.launch(f, x, y, toX, toY, this.rng.range(0.55, 0.75), scale, scale * 0.75);
    f.amount = amount;
  }

  item(iconKey: string, x: number, y: number, toX: number, toY: number): void {
    let f = this.items.find((it) => !it.active);
    if (!f) {
      f = this.make('item', iconKey);
      this.items.push(f);
    }
    f.s.texture = tex(iconKey);
    const scale = ITEM_SIZE / Math.max(1, f.s.texture.width, f.s.texture.height);
    this.launch(f, x, y, toX, toY, 0.85, scale * 1.3, scale * 0.45);
  }

  /** 날아가는 중인 코인 골드 합 */
  pendingGold(): number {
    let n = 0;
    for (let i = 0; i < this.coins.length; i++) if (this.coins[i].active) n += this.coins[i].amount;
    return n;
  }

  update(dt: number): void {
    // 매 프레임: 칸으로 돈다 (for-of 반복자 할당 없이)
    for (let i = 0; i < this.coins.length; i++) if (this.coins[i].active) this.step(this.coins[i], dt);
    for (let i = 0; i < this.items.length; i++) if (this.items[i].active) this.step(this.items[i], dt);
  }

  private step(f: Flyer, dt: number): void {
    f.t += dt;
    const k = Math.min(1, f.t / f.life);
    // 처음엔 살짝 튀어오르고 점점 빨라지며 빨려 들어감
    const e = k * k * (1.6 - 0.6 * k);
    const u = 1 - e;
    f.s.position.set(
      u * u * f.x0 + 2 * u * e * f.cx + e * e * f.x1,
      u * u * f.y0 + 2 * u * e * f.cy + e * e * f.y1,
    );
    const pop = k < 0.15 ? 1 + 0.35 * (k / 0.15) : 1.35 - 0.35 * Math.min(1, (k - 0.15) / 0.2);
    f.s.scale.set((f.s0 + (f.s1 - f.s0) * e) * pop);
    f.s.rotation = f.kind === 'item' ? Math.sin(f.t * 14) * 0.2 * (1 - k) : 0;
    if (k >= 1) {
      f.active = false;
      f.s.visible = false;
      if (f.kind === 'coin') this.targets.onCoinArrive(f.amount);
      else this.targets.onItemArrive();
    }
  }

  private make(kind: Flyer['kind'], key: string): Flyer {
    const s = new Sprite(tex(key));
    s.anchor.set(0.5);
    s.visible = false;
    this.addChild(s);
    return { s, active: false, kind, amount: 0, t: 0, life: 1, x0: 0, y0: 0, cx: 0, cy: 0, x1: 0, y1: 0, s0: 1, s1: 1 };
  }

  private launch(f: Flyer, x: number, y: number, toX: number, toY: number, life: number, s0: number, s1: number): void {
    f.active = true;
    f.t = 0;
    f.life = life;
    f.x0 = x;
    f.y0 = y;
    f.x1 = toX;
    f.y1 = toY;
    // 제어점: 출발점 옆·위로 튀어오르는 호
    f.cx = x + this.rng.range(-110, 110);
    f.cy = Math.max(toY + 30, y - this.rng.range(80, 190));
    f.s0 = s0;
    f.s1 = s1;
    f.s.visible = true;
    f.s.position.set(x, y);
    f.s.scale.set(s0);
    this.addChild(f.s);
  }
}
