// 플레이어 캐릭터: 그림자 + ActorSprite. 이동 중 'move', 멈추면 'idle', 발사 시 'attack' 팝(스로틀),
// 피격 시 'hit', 무적 동안 깜빡임. 좌표는 필드 좌표.
// 발사 반동: 캐릭터를 감싼 상자에 조준 반대쪽으로 살짝 밀림 + 납작 → 쭉 → 출렁 (애니메이션 상태와 겹쳐도 됨).
import { Container, Sprite, type Texture } from 'pixi.js';
import { ActorSprite } from '../../render/actor';
import type { PlayerEntity } from '../../types';
import {
  FACE_DEADZONE,
  FACE_TURN_RATE,
  PLAYER_ATTACK_THROTTLE,
  PLAYER_BLINK_HZ,
  PLAYER_DISPLAY,
  PLAYER_MOVE_EPS,
  PLAYER_RECOIL_THROTTLE,
} from './visual';

/** 멈춘 뒤 이 시간 동안은 'move'를 유지 (프레임마다 깜빡이며 상태가 바뀌지 않게) */
const MOVE_HOLD = 0.08;
/** 반동 길이(초), 밀림(px), 스쿼시 양 */
const RECOIL_TIME = 0.2;
const RECOIL_PX = 6;
const RECOIL_SQUASH = 0.11;

export class PlayerView extends Container {
  readonly actor: ActorSprite;
  private readonly shadow: Sprite;
  /** 반동 상자 (발밑 기준으로 납작해지게 원점을 발밑에) */
  private readonly recoilBox = new Container();
  private lastX = NaN;
  private lastY = NaN;
  private moveHold = 0;
  private attackCd = 0;
  private recoilCd = 0;
  private recoilT = RECOIL_TIME;
  private recoilDx = 0;
  private recoilDy = 0;
  private dead = false;
  private clock = 0;
  /** 바라보는 쪽 (그림 원본은 오른쪽을 봄 = 1). 조준 쪽으로 돌아선다 */
  private facing: 1 | -1 = 1;

  constructor(spriteKey: string, shadowTex: Texture) {
    super();
    this.eventMode = 'none';
    this.shadow = new Sprite(shadowTex);
    this.shadow.anchor.set(0.5);
    this.shadow.scale.set((PLAYER_DISPLAY * 0.8) / shadowTex.width);
    this.shadow.position.set(0, PLAYER_DISPLAY * 0.42);
    this.actor = new ActorSprite(spriteKey, PLAYER_DISPLAY);
    // 상자 원점 = 발밑 (액터 원점은 몸 중심)
    const feet = PLAYER_DISPLAY * 0.45;
    this.recoilBox.position.set(0, feet);
    this.actor.position.set(0, -feet);
    this.recoilBox.addChild(this.actor);
    this.addChild(this.shadow, this.recoilBox);
  }

  sync(pl: PlayerEntity, dt: number, simRunning: boolean): void {
    this.clock += dt;
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this.recoilCd > 0) this.recoilCd -= dt;
    const moved = Number.isFinite(this.lastX) && Math.hypot(pl.x - this.lastX, pl.y - this.lastY) > PLAYER_MOVE_EPS;
    this.lastX = pl.x;
    this.lastY = pl.y;
    this.position.set(pl.x, pl.y);

    if (!this.dead) {
      if (moved) this.moveHold = MOVE_HOLD;
      else if (this.moveHold > 0) this.moveHold -= dt;
      const want = this.moveHold > 0 ? 'move' : 'idle';
      const s = this.actor.state;
      if ((s === 'idle' || s === 'move') && s !== want) void this.actor.play(want);
      // 무적 시간 깜빡임
      const blink = simRunning && pl.invuln > 0 && Math.floor(this.clock * PLAYER_BLINK_HZ * 2) % 2 === 0;
      this.actor.alpha = blink ? 0.35 : 1;
    }
    // 좌우 돌아서기: scale.x를 ±1 쪽으로 빠르게 (0을 지나며 납작해졌다 펴지는 느낌)
    const sx = this.actor.scale.x;
    if (sx !== this.facing) {
      const step = FACE_TURN_RATE * dt;
      this.actor.scale.x = Math.abs(this.facing - sx) <= step ? this.facing : sx + Math.sign(this.facing - sx) * step;
    }
    this.updateRecoil(dt);
    this.actor.update(dt);
  }

  /** 조준 방향의 cos: 오른쪽(+)이면 오른쪽, 왼쪽(-)이면 왼쪽을 본다. 거의 수직이면 그대로 */
  faceAim(cosAim: number): void {
    if (this.dead) return;
    if (cosAim > FACE_DEADZONE) this.facing = 1;
    else if (cosAim < -FACE_DEADZONE) this.facing = -1;
  }

  /** 발사: 반동(조준 반대쪽으로 톡 + 납작 → 쭉) + 'attack' 팝 (각각 스로틀) */
  onFire(aimAngle: number): void {
    if (this.dead) return;
    if (this.recoilCd <= 0) {
      this.recoilCd = PLAYER_RECOIL_THROTTLE;
      this.recoilT = 0;
      this.recoilDx = -Math.cos(aimAngle);
      this.recoilDy = -Math.sin(aimAngle);
    }
    if (this.attackCd > 0) return;
    const s = this.actor.state;
    if (s !== 'idle' && s !== 'move') return;
    this.attackCd = PLAYER_ATTACK_THROTTLE;
    void this.actor.play('attack');
  }

  onHit(): void {
    if (this.dead) return;
    void this.actor.play('hit');
  }

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.actor.alpha = 1;
    this.shadow.visible = false;
    this.recoilT = RECOIL_TIME;
    this.recoilBox.scale.set(1);
    this.recoilBox.position.set(0, PLAYER_DISPLAY * 0.45);
    void this.actor.play('die');
  }

  private updateRecoil(dt: number): void {
    const box = this.recoilBox;
    const feet = PLAYER_DISPLAY * 0.45;
    if (this.recoilT >= RECOIL_TIME) {
      if (box.scale.x !== 1 || box.scale.y !== 1) box.scale.set(1);
      if (box.x !== 0 || box.y !== feet) box.position.set(0, feet);
      return;
    }
    this.recoilT = Math.min(RECOIL_TIME, this.recoilT + dt);
    const k = this.recoilT / RECOIL_TIME;
    // 0 → 0.25: 납작(쏘는 순간 웅크림), 0.25 → 0.55: 쭉, 이후 감쇠 출렁
    let sq: number;
    if (k < 0.25) sq = k / 0.25;
    else if (k < 0.55) sq = 1 - 1.7 * ((k - 0.25) / 0.3);
    else sq = -0.7 * Math.cos(((k - 0.55) / 0.45) * Math.PI * 1.5) * (1 - (k - 0.55) / 0.45);
    const a = RECOIL_SQUASH * sq;
    box.scale.set(1 + a * 0.8, 1 - a);
    const push = RECOIL_PX * Math.sin(Math.min(1, k / 0.6) * Math.PI);
    box.position.set(this.recoilDx * push, feet + this.recoilDy * push * 0.6);
  }
}
