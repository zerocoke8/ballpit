// 전투 화면용 둥근 게이지 — ui/ProgressBar와 같은 모양·움직임(값이 줄면 밝은 잔상이 잠깐 머물렀다 따라옴)이지만
// 값이 바뀔 때 Graphics를 다시 그리지 않는다: 바탕은 한 번 그리고, 잔상·채움·광택은 알약 모양 텍스처의
// NineSliceSprite 폭만 바꾼다(정점 16개 갱신). 트윈 대신 update(dt)로 직접 움직인다 (할당 없음).
// 측정: 보스전에서 ProgressBar(보스 체력)가 매 프레임 roundRect를 다시 삼각형 분할 — JS 할당의 약 14%,
// 웨이브 중엔 HUD 처치 진행 바가 프레임의 39%에서 다시 그려졌다.
import { CanvasSource, Container, Graphics, NineSliceSprite, Texture } from 'pixi.js';
import { UI_COLORS } from '../../config';
import { lighten, mixColor, shade } from '../../render/color';

const PAD = 3;
/** ProgressBar와 같은 시간·이징 */
const DROP_TIME = 0.15;
const RISE_TIME = 0.3;
const TRAIL_HOLD = 0.25;
const TRAIL_TIME = 0.35;
/** 알약 텍스처 해상도 (폰 dpr 2 기준으로 선명하게) */
const PILL_RES = 2;

const pillCache = new Map<number, Texture>();

/** 높이 h(논리 px)의 흰 알약: 폭 = h + 2 (가운데 2px이 늘어나는 부분), 양끝 반원 */
function pillTexture(h: number): Texture {
  const key = Math.round(h * 100);
  const hit = pillCache.get(key);
  if (hit && !hit.destroyed) return hit;
  const w = h + 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * PILL_RES);
  canvas.height = Math.ceil(h * PILL_RES);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = (h * PILL_RES) / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.arc(canvas.width - r, r, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }
  const t = new Texture({ source: new CanvasSource({ resource: canvas, resolution: PILL_RES }) });
  pillCache.set(key, t);
  return t;
}

function pill(h: number, color: number): NineSliceSprite {
  const s = new NineSliceSprite({ texture: pillTexture(h), leftWidth: h / 2, rightWidth: h / 2, topHeight: 0, bottomHeight: 0 });
  s.tint = color;
  s.height = h;
  return s;
}

function outQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function inOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export class FastBar extends Container {
  private readonly innerW: number;
  private readonly innerH: number;
  private readonly ir: number;
  private readonly trailS: NineSliceSprite;
  private readonly fillS: NineSliceSprite;
  private readonly gloss: NineSliceSprite;
  private target = 1;
  private shown = 1;
  private trail = 1;
  // 채움 애니메이션: shownFrom → target, shownT / shownDur
  private shownFrom = 1;
  private shownT = 0;
  private shownDur = 0;
  // 잔상: trailHold 동안 머문 뒤 trailFrom → target (trailT / TRAIL_TIME)
  private trailHold = 0;
  private trailFrom = 1;
  private trailT = -1;
  private drawnShown = -1;
  private drawnTrail = -1;

  constructor(w: number, h: number, color: number, bg: number = shade(UI_COLORS.panel, 0.7)) {
    super();
    this.innerW = w - PAD * 2;
    this.innerH = h - PAD * 2;
    this.ir = this.innerH / 2;
    const r = h / 2;
    const base = new Graphics()
      .roundRect(0, 0, w, h, r)
      .fill(shade(bg, 0.6))
      .roundRect(PAD, PAD, w - PAD * 2, h - PAD * 2, r - PAD)
      .fill(bg);
    // 반투명 대신 불투명하게 섞은 색 (ProgressBar와 같은 색)
    this.trailS = pill(this.innerH, lighten(bg, 0.78));
    this.fillS = pill(this.innerH, color);
    const gh = this.innerH * 0.35;
    this.gloss = pill(gh, mixColor(color, lighten(color, 0.6), 0.45));
    this.trailS.position.set(PAD, PAD);
    this.fillS.position.set(PAD, PAD);
    this.gloss.position.set(PAD + this.ir * 0.5, PAD + this.innerH * 0.12);
    this.addChild(base, this.trailS, this.fillS, this.gloss);
    this.apply();
  }

  get value(): number {
    return this.target;
  }

  setValue(v: number, animate = true): void {
    const next = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    this.target = next;
    if (!animate) {
      this.shown = this.trail = next;
      this.shownDur = 0;
      this.trailT = -1;
      this.trailHold = 0;
      this.apply();
      return;
    }
    this.shownFrom = this.shown;
    this.shownT = 0;
    if (next < this.shown) {
      this.shownDur = DROP_TIME;
      // 잔상은 잠깐 머물렀다가 따라온다
      this.trail = Math.max(this.trail, this.shown);
      this.trailFrom = this.trail;
      this.trailHold = TRAIL_HOLD;
      this.trailT = 0;
    } else {
      this.shownDur = RISE_TIME;
      this.trail = next;
      this.trailT = -1;
      this.trailHold = 0;
    }
  }

  update(dt: number): void {
    if (this.shownDur > 0) {
      this.shownT += dt;
      const k = Math.min(1, this.shownT / this.shownDur);
      this.shown = this.shownFrom + (this.target - this.shownFrom) * outQuad(k);
      if (k >= 1) this.shownDur = 0;
    }
    if (this.trailT >= 0) {
      if (this.trailHold > 0) this.trailHold -= dt;
      else {
        this.trailT += dt;
        const k = Math.min(1, this.trailT / TRAIL_TIME);
        this.trail = this.trailFrom + (this.target - this.trailFrom) * inOutSine(k);
        if (k >= 1) this.trailT = -1;
      }
    }
    this.apply();
  }

  private apply(): void {
    const shown = this.shown;
    const trail = this.trail;
    if (shown === this.drawnShown && trail === this.drawnTrail) return;
    this.drawnShown = shown;
    this.drawnTrail = trail;
    const iw = this.innerW;
    const tw = iw * trail;
    this.trailS.visible = trail > shown && tw > 0.5;
    if (this.trailS.visible) this.trailS.width = tw;
    const fw = iw * shown;
    this.fillS.visible = fw > 0.5;
    if (this.fillS.visible) this.fillS.width = fw;
    this.gloss.visible = fw > this.ir;
    if (this.gloss.visible) this.gloss.width = fw - this.ir;
  }
}
