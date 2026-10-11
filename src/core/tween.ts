// 앱 ticker로 구동되는 간단한 트윈. createApp이 bindTweenTicker(app.ticker)를 호출한다.
import { Ticker } from 'pixi.js';

export type Ease = 'linear' | 'outQuad' | 'inQuad' | 'outBack' | 'outElastic' | 'inOutSine';

const EASES: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inQuad: (t) => t * t,
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

/** 0..1 진행도에 이징 적용 */
export function ease(kind: Ease, t: number): number {
  return EASES[kind](Math.min(1, Math.max(0, t)));
}

interface Tween {
  target: object;
  keys: string[];
  from: number[];
  to: number[];
  duration: number;
  elapsed: number;
  ease: (t: number) => number;
  started: boolean;
  dead: boolean;
  resolve: () => void;
}

const MAX_DT = 0.1;
let tweens: Tween[] = [];
let boundTicker: Ticker | null = null;

function onTick(ticker: Ticker): void {
  updateTweens(Math.min(ticker.deltaMS / 1000, MAX_DT));
}

/** 트윈을 구동할 ticker 지정 (createApp에서 호출). 지정 전에 tween()을 쓰면 Ticker.shared 사용 */
export function bindTweenTicker(ticker: Ticker): void {
  if (boundTicker === ticker) return;
  boundTicker?.remove(onTick);
  boundTicker = ticker;
  ticker.add(onTick);
}

function ensureTicker(): void {
  if (!boundTicker) bindTweenTicker(Ticker.shared);
}

/**
 * 파괴된 Container(또는 그 scale/position 같은 ObservablePoint)면 true. null/undefined도 true —
 * pixi v8에서 파괴된 Container의 `scale`은 null을 돌려주므로 `.then(() => tween(c.scale, …))`처럼
 * 이어 건 트윈이 그 사이 파괴된 대상을 받을 수 있다(예전엔 여기서 매 프레임 throw → 씬 갱신이 멈췄다).
 */
function isDestroyed(target: object | null | undefined): boolean {
  if (target == null) return true;
  const t = target as { destroyed?: boolean; _observer?: { destroyed?: boolean } };
  return t.destroyed === true || t._observer?.destroyed === true;
}

/** 수동 구동(테스트 등). 보통은 ticker가 호출한다. dt는 초 */
export function updateTweens(dt: number): void {
  if (tweens.length === 0) return;
  const list = tweens.slice();
  let anyDead = false;
  for (const tw of list) {
    if (tw.dead) {
      anyDead = true;
      continue;
    }
    if (isDestroyed(tw.target)) {
      tw.dead = anyDead = true;
      continue;
    }
    const obj = tw.target as Record<string, unknown>;
    if (!tw.started) {
      // 시작 값은 첫 갱신 때 읽는다 (같은 프레임에 연달아 건 트윈이 자연스럽게 이어지도록)
      tw.started = true;
      tw.from = tw.keys.map((k) => Number(obj[k]) || 0);
    }
    tw.elapsed += dt;
    const p = tw.duration <= 0 ? 1 : Math.min(1, tw.elapsed / tw.duration);
    const e = tw.ease(p);
    try {
      for (let i = 0; i < tw.keys.length; i++) {
        obj[tw.keys[i]] = tw.from[i] + (tw.to[i] - tw.from[i]) * e;
      }
    } catch {
      tw.dead = anyDead = true;
      continue;
    }
    if (p >= 1) {
      tw.dead = anyDead = true;
      tw.resolve();
    }
  }
  if (anyDead) tweens = tweens.filter((tw) => !tw.dead);
}

function push(target: object, to: Record<string, number>, duration: number, easeKind: Ease): Promise<void> {
  ensureTicker();
  // 이미 파괴된 대상(또는 null)은 등록하지 않는다 — 파괴된 대상의 트윈처럼 resolve되지 않는 Promise
  if (isDestroyed(target)) return new Promise<void>(() => {});
  return new Promise<void>((resolve) => {
    const keys = Object.keys(to);
    tweens.push({
      target,
      keys,
      from: [],
      to: keys.map((k) => to[k]),
      duration: Math.max(0, duration),
      elapsed: 0,
      ease: EASES[easeKind] ?? EASES.linear,
      started: false,
      dead: false,
      resolve,
    });
  });
}

/**
 * target의 숫자 속성들을 duration(초) 동안 to 값으로 보간.
 * 중첩 속성은 target을 직접 넘긴다: tween(sprite.scale, { x: 1.2, y: 1.2 }, 0.1)
 * killTweensOf로 중단되거나 target이 파괴되면 Promise는 resolve되지 않는다.
 */
export function tween(
  target: object,
  to: Record<string, number>,
  duration: number,
  easeKind: Ease = 'outQuad',
): Promise<void> {
  return push(target, to, duration, easeKind);
}

const delayTarget = {};

/** ticker 시간 기준 대기 (최대 0.1초/프레임으로 clamp되므로 탭이 백그라운드면 멈춤) */
export function delay(seconds: number): Promise<void> {
  return push(delayTarget, {}, seconds, 'linear');
}

export function killTweensOf(target: object): void {
  for (const tw of tweens) if (tw.target === target) tw.dead = true;
}
