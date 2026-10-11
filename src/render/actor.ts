// 캐릭터/적 스프라이트. 프레임 애니메이션(manifest anims)이 있으면 프레임을 넘기고,
// 없으면 정적 스프라이트에 코드 애니메이션(출렁임/기울임/스쿼시/플래시)을 입힌다.
// 원점 = 보이는 모습의 중심. 스쿼시·기울임은 발밑 기준.
import { ColorMatrixFilter, Container, Sprite, Texture, type DestroyOptions } from 'pixi.js';
import type { AnimState } from '../types';
import { animFrames, tex, type AnimFrames } from './assets';

/** 프레임이 없을 때 코드 애니메이션 길이(초) */
const CODE_DURATION: Record<AnimState, number> = { idle: 0, move: 0, attack: 0.32, hit: 0.3, die: 0.5 };
const HIT_FLASH_TIME = 0.12;
/** 프레임 die 재생 후 페이드 아웃 시간 */
const FRAME_DIE_FADE = 0.25;
const ONE_SHOT: ReadonlySet<AnimState> = new Set(['attack', 'hit', 'die']);

/** 흰색으로 덮는 행렬. filter.alpha로 세기 조절 */
const WHITE_MATRIX = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0];

let instanceSeq = 0;

export class ActorSprite extends Container {
  readonly baseSprite: Sprite;
  private readonly body: Container;
  private readonly key: string;
  private readonly displaySize: number;
  /** 액터마다 idle 위상을 달리해 무리가 똑같이 움직이지 않게 */
  private readonly phase: number;

  private animState: AnimState = 'idle';
  private loopState: AnimState = 'idle';
  private stateTime = 0;
  private clock = 0;
  private frames: AnimFrames | null = null;
  /** 현재 상태가 프레임 애니메이션 자체인지 (false면 코드 애니메이션 적용) */
  private framesOwnState = false;
  private frameIndex = -1;
  /** 크기 맞춤 기준 (정적 텍스처 또는 프레임 묶음) — 바뀔 때만 다시 맞춘다 */
  private fitSource: Texture | AnimFrames | null = null;
  /** 발밑 y (원점 = 보이는 모습의 중심) */
  private feetY = 0;
  private flashTime = 0;
  private flashFilter: ColorMatrixFilter | null = null;
  private flashOn = false;
  private pendingResolve: (() => void) | null = null;
  private dying = false;

  constructor(key: string, displaySize: number) {
    super();
    this.key = key;
    this.displaySize = displaySize;
    this.phase = ((instanceSeq++ * 0.618034) % 1) * Math.PI * 2;
    this.body = new Container();
    this.baseSprite = new Sprite(tex(key));
    this.baseSprite.anchor.set(0.5, 1);
    this.body.addChild(this.baseSprite);
    this.addChild(this.body);
    this.play('idle');
  }

  get state(): AnimState {
    return this.animState;
  }

  /**
   * 상태 재생. attack/hit은 끝나면 직전 반복 상태(idle/move)로 돌아간다.
   * 반환 Promise: 일회성(attack/hit/die)은 끝날 때(또는 다른 play로 끊길 때), 반복 상태는 즉시 resolve.
   * die 이후의 play는 무시된다.
   */
  play(state: AnimState): Promise<void> {
    if (this.dying || this.destroyed) return Promise.resolve();
    this.settlePending();
    this.animState = state;
    this.stateTime = 0;
    if (state === 'idle' || state === 'move') this.loopState = state;
    if (state === 'die') this.dying = true;

    const own = animFrames(this.key, state);
    if (own && own.frames.length > 0) {
      this.frames = own;
      this.framesOwnState = true;
    } else {
      // 이 상태의 프레임이 없으면 idle 프레임(있다면) 위에 코드 애니메이션
      const idle = state === 'die' ? null : animFrames(this.key, 'idle');
      this.frames = idle && idle.frames.length > 0 ? idle : null;
      this.framesOwnState = false;
      if (!this.frames && state !== 'die') this.setTexture(tex(this.key));
    }
    this.frameIndex = -1;
    if (state === 'hit') this.flashTime = HIT_FLASH_TIME;
    this.applyPose(0);

    if (!ONE_SHOT.has(state)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** 상태이상 표시용 색 (0xffffff = 원래 색) */
  setTint(color: number): void {
    this.baseSprite.tint = color;
  }

  update(dt: number): void {
    if (this.destroyed) return;
    this.clock += dt;
    this.stateTime += dt;
    if (this.flashTime > 0) this.flashTime = Math.max(0, this.flashTime - dt);
    this.applyPose(dt);

    if (!ONE_SHOT.has(this.animState)) return;
    const duration = this.oneShotDuration();
    if (this.stateTime < duration) return;
    if (this.animState === 'die') {
      this.alpha = 0;
      this.settlePending();
      return;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.play(this.loopState);
    resolve?.();
  }

  override destroy(options?: DestroyOptions): void {
    this.settlePending();
    if (this.flashOn) this.baseSprite.filters = null;
    this.flashFilter?.destroy();
    this.flashFilter = null;
    super.destroy(options);
  }

  // ───────────────────────────────────────────────────────────

  private settlePending(): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }

  private oneShotDuration(): number {
    if (this.framesOwnState && this.frames) {
      const len = this.frames.frames.length / this.frames.fps;
      return this.animState === 'die' ? len + FRAME_DIE_FADE : len;
    }
    return CODE_DURATION[this.animState];
  }

  private setTexture(t: Texture, source: Texture | AnimFrames = t): void {
    if (this.baseSprite.texture !== t) this.baseSprite.texture = t;
    if (this.fitSource === source) return;
    this.fitSource = source;
    const ref = source instanceof Texture ? source : source.frames[0];
    const w = Math.max(1, ref.width);
    const h = Math.max(1, ref.height);
    const scale = this.displaySize / Math.max(w, h);
    this.baseSprite.scale.set(scale);
    // 발밑(앵커 0.5,1)을 보이는 높이의 절반만큼 내려 원점이 중심이 되게
    this.feetY = (h * scale) / 2;
  }

  private stepFrames(): void {
    const fa = this.frames;
    if (!fa) return;
    const n = fa.frames.length;
    // 빌려 쓰는 idle 프레임은 상태가 바뀌어도 끊기지 않게 전체 시계로 돌린다
    let idx = Math.floor((this.framesOwnState ? this.stateTime : this.clock) * fa.fps);
    const oneShotOwn = this.framesOwnState && ONE_SHOT.has(this.animState);
    idx = oneShotOwn || !fa.loop ? Math.min(idx, n - 1) : idx % n;
    if (idx === this.frameIndex) return;
    this.frameIndex = idx;
    this.setTexture(fa.frames[idx], fa);
  }

  private applyPose(_dt: number): void {
    this.stepFrames();
    const b = this.body;
    const s = this.displaySize;
    const t = this.stateTime;
    let x = 0;
    let y = this.feetY;
    let sx = 1;
    let sy = 1;
    let rot = 0;
    let alpha = 1;

    if (!this.framesOwnState) {
      switch (this.animState) {
        case 'idle': {
          const w = this.clock * Math.PI * 2 * 0.8 + this.phase;
          y -= Math.max(0, Math.sin(w)) * s * 0.025;
          sy = 1 + Math.sin(w * 2) * 0.03;
          sx = 1 - Math.sin(w * 2) * 0.02;
          break;
        }
        case 'move': {
          const w = t * Math.PI * 2 * 3.2;
          rot = Math.sin(w) * 0.13;
          y -= Math.abs(Math.sin(w)) * s * 0.045;
          sy = 1 + Math.abs(Math.sin(w)) * 0.04;
          sx = 1 - Math.abs(Math.sin(w)) * 0.03;
          break;
        }
        case 'attack': {
          // 웅크림 → 쭉 늘어나며 튀어오름 → 출렁이며 복귀
          const p = t / CODE_DURATION.attack;
          if (p < 0.25) {
            const k = p / 0.25;
            sx = 1 + 0.18 * k;
            sy = 1 - 0.2 * k;
          } else if (p < 0.55) {
            const k = (p - 0.25) / 0.3;
            sx = 1.18 - 0.3 * k;
            sy = 0.8 + 0.42 * k;
            y -= Math.sin(k * Math.PI * 0.5) * s * 0.08;
          } else {
            const k = Math.min(1, (p - 0.55) / 0.45);
            const wob = Math.cos(k * Math.PI * 2.5) * (1 - k);
            sx = 1 - 0.12 * wob;
            sy = 1 + 0.22 * wob;
            y -= (1 - k) * s * 0.08;
          }
          break;
        }
        case 'hit': {
          const p = Math.min(1, t / CODE_DURATION.hit);
          const decay = 1 - p;
          x = Math.sin(t * 70) * s * 0.06 * decay;
          sx = 1 + 0.1 * decay;
          sy = 1 - 0.1 * decay;
          break;
        }
        case 'die': {
          const p = Math.min(1, t / CODE_DURATION.die);
          const k = 1 - (1 - p) * (1 - p);
          sx = 1 + 0.45 * k;
          sy = 1 - 0.8 * k;
          alpha = p < 0.3 ? 1 : 1 - (p - 0.3) / 0.7;
          break;
        }
      }
    } else if (this.animState === 'die' && this.frames) {
      const len = this.frames.frames.length / this.frames.fps;
      alpha = t <= len ? 1 : Math.max(0, 1 - (t - len) / FRAME_DIE_FADE);
    }

    b.position.set(x, y);
    b.scale.set(sx, sy);
    b.rotation = rot;
    this.body.alpha = alpha;
    this.updateFlash();
  }

  private updateFlash(): void {
    if (this.flashTime <= 0) {
      if (this.flashOn) {
        this.baseSprite.filters = null;
        this.flashOn = false;
      }
      return;
    }
    if (!this.flashFilter) {
      this.flashFilter = new ColorMatrixFilter({ resolution: 'inherit' });
      this.flashFilter.matrix = WHITE_MATRIX as ColorMatrixFilter['matrix'];
    }
    this.flashFilter.alpha = Math.min(1, (this.flashTime / HIT_FLASH_TIME) * 1.2) * 0.85;
    if (!this.flashOn) {
      this.baseSprite.filters = [this.flashFilter];
      this.flashOn = true;
    }
  }
}
