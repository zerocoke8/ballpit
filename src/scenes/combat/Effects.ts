// 필드 이펙트 (필드 좌표). 파티클은 아틀라스 한 장 + ParticleContainer 하나(드로우콜 1), 고정 크기 풀.
// - fxLayer(투사체 위·적 탄 아래): 타격 별, 반짝 파편, 원소 버스트, 처치 펑(연기·파편), 폭발, 벽 먼지, 상태이상, 번개
// - topLayer(적 탄 위): 피해 숫자(같은 적 연타는 하나로 합쳐 커짐), 골드 팝업
// - 번개: 마디마다 빛·몸통·심이 구워진 'beam' 파티클 (전용 ParticleContainer). 예전엔 Graphics 획 3겹(둥근 이음)을
//   매 프레임 다시 그려서, 측정해 보니 전투 중 JS 할당의 대부분(둥근 이음 삼각형 분할)이 여기서 나왔다.
// 매 프레임 할당 없음 (숫자 문자열 갱신 정도).
import { BitmapText, Container, Particle, ParticleContainer } from 'pixi.js';
import { ELEMENT_COLORS, UI_COLORS } from '../../config';
import { Rng } from '../../logic/rng';
import type { Element } from '../../types';
import { BEAM_TEX_H, BEAM_TEX_W, BEAM_WORLD_W, NUM_FONT, type FxAtlas, type FxFrame } from './fxTextures';
import type { StatusEmitter } from './EnemyLayer';
import {
  DAMAGE_COLOR,
  DAMAGE_MERGE_WINDOW,
  DAMAGE_NUMBER_LIFE,
  DOT_MERGE_WINDOW,
  DOT_NUMBER_SCALE,
  EXPLODE_STACK_DIST,
  EXPLODE_STACK_SCALE,
  EXPLODE_STACK_TIME,
  LIGHTNING_COLOR,
  MAX_BOLTS,
  MAX_DAMAGE_NUMBERS,
  MAX_IMPACTS_PER_FRAME,
  MAX_PARTICLES,
  MUZZLE_PUFF_THROTTLE,
  NUMBER_MIN_Y,
  PARTICLE_SOFT_CAP,
  PLAYER_DAMAGE_COLOR,
  WALL_DUST_COOLDOWN,
  WALL_DUST_PER_SEC,
  WALL_DUST_RADIUS,
} from './visual';

const NUM_SIZE = 34;
const BOLT_SEGMENTS = 7;
/** 번개 지그재그를 다시 흔드는 간격(초) — 지직거리는 느낌 */
const BOLT_REJITTER = 0.04;
const POP_FRAC_DEFAULT = 0.35;
/** 번개 마디를 양끝으로 이만큼(굵기 비율) 늘려 이웃 마디와 겹친다 — 꺾인 자리 바깥에 틈이 보이지 않게 (둥근 이음 대신) */
const BEAM_OVERLAP = 0.12;
/** 크기 곡선 */
const C_OUT = 0; // 감속하며 s0 → s1
const C_POP = 1; // popFrac 동안 튀어나오며(outBack) s0 → s1, 이후 유지
const C_LIN = 2; // 등속 s0 → s1
const C_SWELL = 3; // 0 → s0까지 금방 커졌다가 s1로 천천히 (불꽃: 피어올라 잦아듦)

const ICE_TINT = 0xffffff;
// 타격 별(fx_impact)은 흰 속 + 연노랑 테. 얼음은 tint하지 않는다 — 하늘색을 곱하면 노란 테가 연두색이 됐다
// (얼음 느낌은 얼음 조각·고리가 낸다)
const FIRE_IMPACT_TINT = 0xffc27a;
const LIGHTNING_IMPACT_TINT = 0xfff59a;
const SMOKE_TINT = 0xf4efe9;
/** 얼음 폭발(수박 빙수 등): 주황 폭발 구름 대신 연기 구름(fx_puff)을 얼음빛으로 — 얼음 무기가 불덩이로 터져 보이지 않게 */
const FROST_CLOUD_TINT = 0xd2f0ff;
const FROST_SPARK_TINT = 0xe6f8ff;
const RING_TINT = 0xfff4d6;
/** 처치 파편 모양 (가중치 = 등장 횟수). 적 탄과 같은 그림(볼트·스프링·톱니)은 작고 칙칙하게 — 날아오는 탄으로 착각하지 않게 */
const DEBRIS: readonly FxFrame[] = ['bolt', 'spring', 'sparkle', 'gear', 'sparkle', 'shard', 'shard'];
const DEBRIS_TINT = [0xc9bfb4, 0xd8b8b0, 0xffffff, 0xd2c6a8, 0xffffff, 0xffe9b8, 0xfff6e0];

interface Fx {
  p: Particle;
  frameW: number;
  t: number;
  life: number;
  delay: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  drag: number;
  grav: number;
  vr: number;
  s0: number;
  s1: number;
  /** 세로/가로 비 (늘이기) */
  aspect: number;
  curve: number;
  popFrac: number;
  a0: number;
  /** 수명 중 이 비율부터 알파가 0으로 */
  fadeStart: number;
  /** 회전을 속도 방향으로 맞춤 (+ rot0) */
  align: boolean;
  rot0: number;
}

interface Num {
  t: BitmapText;
  active: boolean;
  enemyId: number;
  sum: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  pop: number;
  scale: number;
  lastAdd: number;
  /** 화상 틱만 모인 작은 숫자 (직접 타격이 합쳐지면 보통 크기로) */
  small: boolean;
}

interface Bolt {
  active: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  age: number;
  life: number;
  width: number;
  jitter: number;
  amp: number;
  offs: Float32Array;
}

export class Effects implements StatusEmitter {
  private readonly pc: ParticleContainer<Particle>;
  /** 번개 마디 (MAX_BOLTS × BOLT_SEGMENTS개 미리 만듦) */
  private readonly boltPc: ParticleContainer<Particle>;
  private readonly beams: Particle[] = [];
  private readonly numLayer = new Container();
  private readonly pool: Fx[] = [];
  private readonly active: Fx[] = [];
  private readonly nums: Num[] = [];
  private nextNum = 0;
  private readonly numByEnemy = new Map<number, Num>();
  private readonly bolts: Bolt[] = [];
  private readonly rng: Rng;
  private clock = 0;
  /** 숫자가 올라갈 수 있는 가장 위 (필드 y). 보스전에는 보스 체력 바 아래로 */
  private numTop = NUMBER_MIN_Y;
  private impactsThisFrame = 0;
  private lastMuzzle = -1;
  private lastFeetDust = -1;
  /** 최근 벽 먼지 (x, y, 시각) 링 */
  private readonly dustX = new Float32Array(8);
  private readonly dustY = new Float32Array(8);
  private readonly dustT = new Float32Array(8).fill(-10);
  private dustI = 0;
  private dustBudget = WALL_DUST_PER_SEC * 0.25;
  /** 최근 폭발 구름 (x, y, 반경, 시각) 링 — 겹쳐 터지는 폭발은 작게 */
  private readonly boomX = new Float32Array(8);
  private readonly boomY = new Float32Array(8);
  private readonly boomR = new Float32Array(8);
  private readonly boomT = new Float32Array(8).fill(-10);
  private boomI = 0;

  /**
   * @param dmgNorm 피해 → 크기 환산 배수 (스테이지 HP 배수의 역수: 후반 스테이지의 큰 숫자도 같은 느낌의 크기로)
   */
  constructor(
    private readonly atlas: FxAtlas,
    seed: number,
    fxParent: Container,
    topParent: Container,
    private readonly dmgNorm = 1,
  ) {
    this.rng = new Rng(seed);
    this.pc = new ParticleContainer<Particle>({
      texture: atlas.impact,
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
    });
    this.pc.eventMode = 'none';
    this.boltPc = new ParticleContainer<Particle>({
      texture: atlas.beam,
      // 모두 동적: 정적 속성은 particleChildren을 직접 바꾸면 올라가지 않는다 (_childrenDirty)
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
    });
    this.boltPc.eventMode = 'none';
    this.numLayer.eventMode = 'none';
    this.numLayer.interactiveChildren = false;
    fxParent.addChild(this.pc, this.boltPc);
    for (let i = 0; i < MAX_BOLTS * BOLT_SEGMENTS; i++) {
      this.beams.push(new Particle({ texture: atlas.beam, anchorX: 0, anchorY: 0.5 }));
    }
    topParent.addChild(this.numLayer);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        p: new Particle({ texture: atlas.impact, anchorX: 0.5, anchorY: 0.5 }),
        frameW: 1,
        t: 0,
        life: 1,
        delay: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        drag: 0,
        grav: 0,
        vr: 0,
        s0: 1,
        s1: 1,
        aspect: 1,
        curve: C_OUT,
        popFrac: POP_FRAC_DEFAULT,
        a0: 1,
        fadeStart: 0.5,
        align: false,
        rot0: 0,
      });
    }
    // 숫자 풀도 미리 만든다 (전투 중 첫 타격들에서 생성 비용이 몰리지 않게)
    for (let i = 0; i < MAX_DAMAGE_NUMBERS; i++) {
      const t = new BitmapText({ text: '0', style: { fontFamily: NUM_FONT, fontSize: NUM_SIZE } });
      t.anchor.set(0.5);
      t.visible = false;
      this.numLayer.addChild(t);
      this.nums.push({ t, active: false, enemyId: -1, sum: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, pop: 0, scale: 1, lastAdd: 0, small: false });
    }
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({
        active: false,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        age: 0,
        life: 0.2,
        width: 1,
        jitter: 0,
        amp: 16,
        offs: new Float32Array(BOLT_SEGMENTS - 1),
      });
    }
  }

  // ── 피해 숫자 ───────────────────────────────────────────────

  /**
   * 적 피해 숫자. 같은 적이 DAMAGE_MERGE_WINDOW 안에 또 맞으면 그 숫자에 더해 다시 튄다.
   * dot = 화상 틱: 더 긴 창(DOT_MERGE_WINDOW)으로 합치고, 혼자면 작은 숫자 — 다시 튀지도 않는다
   */
  damageNumber(enemyId: number, x: number, y: number, amount: number, element: Element | null, dot = false): void {
    if (!(amount > 0)) return;
    const color = element ? ELEMENT_COLORS[element] : DAMAGE_COLOR;
    const prev = this.numByEnemy.get(enemyId);
    const window = dot ? DOT_MERGE_WINDOW : DAMAGE_MERGE_WINDOW;
    if (prev && prev.active && prev.enemyId === enemyId && this.clock - prev.lastAdd <= window) {
      prev.sum += amount;
      prev.t.text = String(prev.sum);
      prev.lastAdd = this.clock;
      if (!dot) {
        prev.small = false;
        prev.t.tint = color;
        prev.pop = 0;
        // 합쳐질수록 살짝 위로 다시 튀어오름
        prev.vy = Math.min(prev.vy, -90);
      }
      prev.scale = this.numScale(prev.sum) * (prev.small ? DOT_NUMBER_SCALE : 1);
      prev.life = Math.max(prev.life, prev.age + DAMAGE_NUMBER_LIFE * 0.85);
      return;
    }
    // 옆 칸 적의 숫자와 겹치지 않게 위아래로도 살짝 흩는다
    const n = this.number(
      x + this.rng.range(-14, 14),
      y - 10 - this.rng.range(0, 18),
      String(amount),
      color,
      this.numScale(amount) * (dot ? DOT_NUMBER_SCALE : 1),
      this.rng.range(-55, 55),
      dot ? this.rng.range(-150, -110) : this.rng.range(-230, -170),
    );
    n.enemyId = enemyId;
    n.sum = amount;
    n.lastAdd = this.clock;
    n.small = dot;
    this.numByEnemy.set(enemyId, n);
  }

  playerDamage(x: number, y: number, amount: number): void {
    this.number(x, y - 54, `-${amount}`, PLAYER_DAMAGE_COLOR, 1.35, 0, -200);
  }

  /** 처치 골드 "+N": 피해 숫자(노랑)와 붙지 않게 한 칸 위·오른쪽으로 비켜서 뜬다 */
  goldPopup(x: number, y: number, amount: number): void {
    this.number(x + 18, y - 52, `+${amount}`, UI_COLORS.gold, 0.8, this.rng.range(10, 40), -150);
  }

  /** 숫자가 올라갈 수 있는 가장 위(필드 y) — 보스 체력 바가 보이면 그 아래로 (CombatScene) */
  setNumberTop(y: number): void {
    this.numTop = Math.max(NUMBER_MIN_Y, y);
  }

  // ── 타격 ────────────────────────────────────────────────────

  /**
   * 직접 타격: 피해에 비례한 별 터짐 + 맞은 면 바깥(공이 온 쪽, (nx, ny))으로 튀는 반짝 2~4개 + 원소 버스트.
   */
  impact(x: number, y: number, damage: number, element: Element | null, nx: number, ny: number): void {
    const rel = damage * this.dmgNorm;
    const size = clamp(38 + 17 * Math.log2(1 + rel / 10), 40, 118);
    const big = this.impactsThisFrame < MAX_IMPACTS_PER_FRAME;
    if (big) {
      this.impactsThisFrame++;
      const tint = element === 'fire' ? FIRE_IMPACT_TINT : element === 'lightning' ? LIGHTNING_IMPACT_TINT : 0xffffff;
      const f = this.spawn('impact', x + nx * 4, y + ny * 4, size * 0.4, size, 0.15, tint);
      if (f) {
        f.curve = C_POP;
        f.popFrac = 0.4;
        f.fadeStart = 0.45;
        f.p.rotation = this.rng.range(0, Math.PI * 2);
      }
    }
    // 반짝 파편: 맞은 면 바깥쪽 반원으로
    const base = Math.atan2(ny, nx);
    const n = 2 + Math.min(2, Math.floor(rel / 25)) + (this.rng.chance(0.5) ? 1 : 0);
    const frame: FxFrame = element === 'ice' ? 'ice' : element === 'fire' ? 'flame' : 'sparkle';
    for (let i = 0; i < Math.min(4, n); i++) {
      if (!this.roomFor(true)) break;
      const a = base + this.rng.range(-1.15, 1.15);
      const sp = this.rng.range(230, 420);
      const sz = frame === 'sparkle' ? this.rng.range(15, 22) : this.rng.range(16, 22);
      const f = this.spawn(frame, x, y, sz, sz * 0.5, this.rng.range(0.24, 0.32), 0xffffff);
      if (!f) break;
      f.vx = Math.cos(a) * sp;
      f.vy = Math.sin(a) * sp;
      f.drag = 7;
      f.grav = frame === 'flame' ? -240 : 260;
      f.vr = frame === 'flame' ? 0 : this.rng.range(-12, 12);
      f.fadeStart = 0.45;
      if (frame === 'ice') f.p.rotation = a + Math.PI / 2;
    }
    if (element) this.elementBurst(x, y, element, nx, ny, rel);
  }

  /** 원소 타격 추가 연출: 불 = 작은 불길이 솟음 / 얼음 = 얼음 조각이 박힘 / 번개 = 짧은 지직 + 섬광 */
  private elementBurst(x: number, y: number, element: Element, nx: number, ny: number, rel: number): void {
    if (!this.roomFor(true)) return;
    if (element === 'fire') {
      for (let i = 0; i < 2; i++) {
        const f = this.spawn('flame', x + this.rng.range(-12, 12) + nx * 6, y + ny * 6, 34, 16, this.rng.range(0.32, 0.42), 0xffffff);
        if (!f) return;
        f.curve = C_SWELL;
        f.vy = this.rng.range(-150, -100);
        f.vx = this.rng.range(-30, 30);
        f.drag = 2;
        f.fadeStart = 0.5;
        f.p.rotation = this.rng.range(-0.25, 0.25);
      }
      const glow = this.spawn('soft', x, y, 30, 74, 0.2, ELEMENT_COLORS.fire);
      if (glow) glow.a0 = 0.55;
    } else if (element === 'ice') {
      const base = Math.atan2(ny, nx);
      for (let i = 0; i < 3; i++) {
        const a = base + (i - 1) * 0.75 + this.rng.range(-0.2, 0.2);
        const f = this.spawn('ice', x + Math.cos(a) * 6, y + Math.sin(a) * 6, 12, 30, 0.4, ICE_TINT);
        if (!f) return;
        f.curve = C_POP;
        f.popFrac = 0.3;
        f.vx = Math.cos(a) * 70;
        f.vy = Math.sin(a) * 70;
        f.drag = 9;
        f.p.rotation = a + Math.PI / 2;
        f.fadeStart = 0.55;
      }
      const ring = this.spawn('ring', x, y, 16, 64, 0.22, ELEMENT_COLORS.ice);
      if (ring) ring.a0 = 0.8;
    } else {
      // 번개: 맞은 자리에서 짧은 지그재그 2~3갈래 + 밝은 섬광
      const n = rel > 30 ? 3 : 2;
      const base = Math.atan2(ny, nx);
      for (let i = 0; i < n; i++) {
        const a = base + this.rng.range(-1.4, 1.4);
        const len = this.rng.range(30, 52);
        this.bolt(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, 0.14, 0.7, 9);
      }
      const glow = this.spawn('soft', x, y, 34, 86, 0.16, LIGHTNING_COLOR);
      if (glow) glow.a0 = 0.8;
      const s = this.spawn('sparkle', x, y, 18, 36, 0.16, 0xffffff);
      if (s) {
        s.curve = C_POP;
        s.vr = 9;
      }
    }
  }

  /** 연쇄로 맞은 적: 노란 섬광 + 반짝 */
  chainHit(x: number, y: number): void {
    const glow = this.spawn('soft', x, y, 40, 96, 0.2, LIGHTNING_COLOR);
    if (glow) glow.a0 = 0.75;
    const s = this.spawn('sparkle', x, y, 20, 44, 0.2, 0xffffff);
    if (s) {
      s.curve = C_POP;
      s.vr = 10;
      s.p.rotation = this.rng.range(0, Math.PI);
    }
  }

  /** 폭발에 휘말린 적: 작은 별 + 먼지 */
  splashHit(x: number, y: number, damage: number): void {
    if (this.impactsThisFrame >= MAX_IMPACTS_PER_FRAME) return;
    this.impactsThisFrame++;
    const rel = damage * this.dmgNorm;
    const size = clamp(30 + 12 * Math.log2(1 + rel / 10), 32, 80);
    const f = this.spawn('impact', x + this.rng.range(-10, 10), y + this.rng.range(-10, 10), size * 0.4, size, 0.14, 0xffe3b0);
    if (f) {
      f.curve = C_POP;
      f.fadeStart = 0.4;
      f.p.rotation = this.rng.range(0, Math.PI * 2);
    }
  }

  /** 화상 틱: 작은 불씨 */
  burnTick(x: number, y: number): void {
    if (!this.roomFor(false)) return;
    const f = this.spawn('flame', x + this.rng.range(-14, 14), y + this.rng.range(-8, 8), 30, 12, 0.36, 0xffffff);
    if (f) {
      f.curve = C_SWELL;
      f.vy = -120;
      f.fadeStart = 0.45;
    }
  }

  // ── 상태이상 (EnemyLayer가 간격마다 부른다) ─────────────────

  /** 불타는 적: 작은 불꽃이 위로 피어오름 */
  burnEmit(x: number, y: number, w: number, h: number): void {
    if (!this.roomFor(false)) return;
    const f = this.spawn('flame', x + this.rng.range(-0.34, 0.34) * w, y + this.rng.range(-0.15, 0.3) * h, this.rng.range(20, 28), 8, this.rng.range(0.42, 0.55), 0xffffff);
    if (!f) return;
    f.curve = C_SWELL;
    f.vy = this.rng.range(-115, -75);
    f.vx = this.rng.range(-14, 14);
    f.fadeStart = 0.5;
    f.p.rotation = this.rng.range(-0.2, 0.2);
  }

  /** 얼어붙은 적: 테두리에 얼음 조각이 반짝 돋았다가 사라짐 */
  frostEmit(x: number, y: number, w: number, h: number): void {
    if (!this.roomFor(false)) return;
    // 테두리(주로 아래·옆) 위의 한 점
    const side = this.rng.int(0, 3);
    let px: number;
    let py: number;
    let rot: number;
    if (side <= 1) {
      px = x + this.rng.range(-0.45, 0.45) * w;
      py = y + h * 0.42;
      rot = this.rng.range(-0.35, 0.35);
    } else {
      const s = side === 2 ? -1 : 1;
      px = x + s * w * 0.44;
      py = y + this.rng.range(-0.1, 0.4) * h;
      rot = s * (Math.PI / 2) + this.rng.range(-0.3, 0.3);
    }
    const f = this.spawn('ice', px, py, 8, this.rng.range(20, 26), 0.6, ICE_TINT);
    if (f) {
      f.curve = C_POP;
      f.popFrac = 0.25;
      f.fadeStart = 0.6;
      f.p.rotation = rot;
    }
    const s = this.spawn('star', x + this.rng.range(-0.4, 0.4) * w, y + this.rng.range(-0.4, 0.3) * h, 4, 18, 0.36, 0xe6f8ff);
    if (s) {
      s.curve = C_POP;
      s.popFrac = 0.4;
      s.vr = 4;
    }
  }

  // ── 폭발 / 번개 / 분열 ──────────────────────────────────────

  /** element = 폭발이 옮기는 속성(sim 'explode' 이벤트) — 얼음이면 서리 폭발(frostBlast) */
  explosion(x: number, y: number, radius: number, element: Element | null = null): void {
    // 방금 근처에서 터진 구름이 있으면 작게, 연기 없이 (같은 대상에 폭발이 겹쳐도 대상이 계속 가려지지 않게)
    let stacked = false;
    for (let i = 0; i < this.boomT.length; i++) {
      if (this.clock - this.boomT[i] > EXPLODE_STACK_TIME) continue;
      const lim = Math.max(radius, this.boomR[i]) * EXPLODE_STACK_DIST;
      const dx = this.boomX[i] - x;
      const dy = this.boomY[i] - y;
      if (dx * dx + dy * dy < lim * lim) {
        stacked = true;
        break;
      }
    }
    if (!stacked) {
      this.boomI = (this.boomI + 1) % this.boomT.length;
      this.boomX[this.boomI] = x;
      this.boomY[this.boomI] = y;
      this.boomR[this.boomI] = radius;
      this.boomT[this.boomI] = this.clock;
    }
    const d = radius * 2 * (stacked ? EXPLODE_STACK_SCALE : 1);
    if (element === 'ice') {
      this.frostBlast(x, y, radius, d, stacked);
      return;
    }
    const boom = this.spawn('boom', x, y, d * 0.35, d * 0.95, stacked ? 0.3 : 0.42, 0xffffff);
    if (boom) {
      boom.curve = C_POP;
      boom.popFrac = 0.28;
      boom.fadeStart = 0.5;
      boom.p.rotation = this.rng.range(-0.3, 0.3);
      boom.vr = this.rng.range(-0.8, 0.8);
    }
    const ring = this.spawn('ring', x, y, d * 0.3, d * 1.15, 0.3, RING_TINT);
    if (ring) {
      ring.a0 = stacked ? 0.6 : 0.9;
      ring.fadeStart = 0.3;
    }
    if (stacked) {
      this.debris(x, y, 2, radius * 0.3, 0.8);
      return;
    }
    const glow = this.spawn('soft', x, y, d * 0.5, d * 1.2, 0.2, 0xffd27a);
    if (glow) glow.a0 = 0.5;
    // 연기: 폭발 구름이 옅어질 때쯤 작게 피어올라 위로 (구름 위에 바로 겹치면 주황 위 회색 얼룩으로 탁해 보였다)
    for (let i = 0; i < 3; i++) {
      if (!this.roomFor(false)) break;
      const a = this.rng.range(0, Math.PI * 2);
      const f = this.spawn('puff', x + Math.cos(a) * radius * 0.4, y + Math.sin(a) * radius * 0.4, radius * 0.35, radius * 0.75, 0.5, SMOKE_TINT);
      if (!f) break;
      f.delay = 0.16;
      f.vx = Math.cos(a) * 60;
      f.vy = Math.sin(a) * 40 - 60;
      f.drag = 2.5;
      f.a0 = 0.7;
      f.fadeStart = 0.3;
      f.p.rotation = this.rng.range(-0.4, 0.4);
    }
    this.debris(x, y, 4, radius * 0.4, 1);
  }

  /** 얼음 폭발: 얼음빛 구름이 팡 + 얼음 결정이 사방으로 박히듯 튀어나감 + 하늘색 충격파·반짝 눈송이 (연기·파편 없음) */
  private frostBlast(x: number, y: number, radius: number, d: number, stacked: boolean): void {
    const cloud = this.spawn('puff', x, y, d * 0.35, d * 0.9, stacked ? 0.3 : 0.45, FROST_CLOUD_TINT);
    if (cloud) {
      cloud.curve = C_POP;
      cloud.popFrac = 0.28;
      cloud.fadeStart = 0.45;
      cloud.a0 = 0.95;
      cloud.p.rotation = this.rng.range(-0.3, 0.3);
    }
    const ring = this.spawn('ring', x, y, d * 0.3, d * 1.15, 0.32, ELEMENT_COLORS.ice);
    if (ring) {
      ring.a0 = stacked ? 0.6 : 0.9;
      ring.fadeStart = 0.3;
    }
    if (stacked) return;
    const glow = this.spawn('soft', x, y, d * 0.5, d * 1.2, 0.22, ELEMENT_COLORS.ice);
    if (glow) glow.a0 = 0.55;
    const n = 7;
    for (let i = 0; i < n; i++) {
      if (!this.roomFor(true)) break;
      const a = (i / n) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const f = this.spawn('ice', x + Math.cos(a) * radius * 0.25, y + Math.sin(a) * radius * 0.25, radius * 0.15, radius * 0.42, this.rng.range(0.45, 0.6), 0xffffff);
      if (!f) break;
      f.curve = C_POP;
      f.popFrac = 0.3;
      f.vx = Math.cos(a) * radius * 2.4;
      f.vy = Math.sin(a) * radius * 2.4;
      f.drag = 7;
      // 그림의 위쪽(결정 끝)이 바깥(a)을 향하게
      f.p.rotation = a + Math.PI / 2;
      f.fadeStart = 0.55;
    }
    for (let i = 0; i < 3; i++) {
      if (!this.roomFor(false)) break;
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(0.2, 0.6) * radius;
      const f = this.spawn('star', x + Math.cos(a) * r, y + Math.sin(a) * r, 6, 24, 0.4, FROST_SPARK_TINT);
      if (!f) break;
      f.curve = C_POP;
      f.popFrac = 0.4;
      f.vr = 5;
      f.delay = 0.05 * i;
    }
  }

  chain(x1: number, y1: number, x2: number, y2: number): void {
    this.bolt(x1, y1, x2, y2, 0.22, 1, 18);
    const glow = this.spawn('soft', x2, y2, 36, 80, 0.2, LIGHTNING_COLOR);
    if (glow) glow.a0 = 0.7;
  }

  splitPuff(x: number, y: number, count: number): void {
    const n = Math.min(5, Math.max(2, count));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
      const f = this.spawn('puff', x, y, 14, 34, 0.3, 0xffffff);
      if (!f) return;
      f.vx = Math.cos(a) * 120;
      f.vy = Math.sin(a) * 120;
      f.drag = 7;
      f.a0 = 0.85;
    }
    const s = this.spawn('sparkle', x, y, 18, 38, 0.18, 0xffffff);
    if (s) s.curve = C_POP;
  }

  /**
   * 공중에서 사라진 투사체(수명 상한 PROJECTILE_MAX_AGE / 분열 자식 SPLIT_CHILD_MAX_AGE, 반사 횟수 소진): 작은 연기 '퐁'
   * — 툭 꺼지지 않게. 장식이라 풀이 차 있으면 건너뛴다
   */
  fizzle(x: number, y: number, size: number): void {
    if (!this.roomFor(false)) return;
    const s = Math.max(18, size);
    const f = this.spawn('puff', x, y, s * 0.6, s * 1.5, 0.3, 0xffffff);
    if (f) {
      f.curve = C_POP;
      f.popFrac = 0.3;
      f.a0 = 0.8;
      f.fadeStart = 0.3;
      f.vy = -25;
      f.p.rotation = this.rng.range(-0.5, 0.5);
    }
    const k = this.spawn('sparkle', x, y, s * 0.4, s * 0.9, 0.14, 0xffffff);
    if (k) {
      k.curve = C_POP;
      k.p.rotation = this.rng.range(0, Math.PI);
    }
  }

  // ── 처치 ────────────────────────────────────────────────────

  /**
   * 처치 '펑': 적이 부풀었다가(EnemyLayer) delay 뒤 연기 구름 + 파편 + 충격파.
   * tier 0 = 일반, 1 = 엘리트(곰인형: 폭발 구름 + 큰 버스트), 2 = 보스(연쇄 폭발).
   */
  killBurst(x: number, y: number, size: number, tier: 0 | 1 | 2, delay: number): void {
    const s = Math.max(48, size);
    // 번쩍 + 연기
    const flash = this.spawn('impact', x, y, s * 0.5, s * 1.05, 0.14, 0xffffff);
    if (flash) {
      flash.delay = delay;
      flash.curve = C_POP;
      flash.fadeStart = 0.35;
      flash.p.rotation = this.rng.range(0, Math.PI * 2);
    }
    const puff = this.spawn('puff', x, y, s * 0.55, s * 1.25, 0.42, SMOKE_TINT);
    if (puff) {
      puff.delay = delay;
      puff.curve = C_POP;
      puff.popFrac = 0.3;
      puff.fadeStart = 0.4;
      puff.vy = -30;
      puff.p.rotation = this.rng.range(-0.3, 0.3);
    }
    const small = tier === 0 ? 3 : 5;
    for (let i = 0; i < small; i++) {
      if (!this.roomFor(false)) break;
      const a = (i / small) * Math.PI * 2 + this.rng.range(-0.4, 0.4);
      const f = this.spawn('puff', x + Math.cos(a) * s * 0.2, y + Math.sin(a) * s * 0.2, s * 0.25, s * 0.55, 0.45, SMOKE_TINT);
      if (!f) break;
      f.delay = delay;
      f.vx = Math.cos(a) * s * 2.2;
      f.vy = Math.sin(a) * s * 1.6 - 20;
      f.drag = 6;
      f.fadeStart = 0.35;
      f.a0 = 0.9;
    }
    const ring = this.spawn('ring', x, y, s * 0.35, s * (tier === 0 ? 1.35 : 1.8), 0.24, 0xffffff);
    if (ring) {
      ring.delay = delay;
      ring.a0 = 0.75;
    }
    this.debris(x, y, tier === 0 ? 5 : tier === 1 ? 9 : 12, s * 0.25, tier === 0 ? 1 : 1.35, delay);

    if (tier >= 1) {
      const booms = tier === 2 ? 4 : 1;
      for (let i = 0; i < booms; i++) {
        const ox = i === 0 ? 0 : this.rng.range(-0.35, 0.35) * s;
        const oy = i === 0 ? 0 : this.rng.range(-0.3, 0.3) * s;
        const bs = (i === 0 ? 1.25 : 0.75) * s;
        const b = this.spawn('boom', x + ox, y + oy, bs * 0.35, bs, 0.5, 0xffffff);
        if (!b) break;
        b.delay = delay + i * 0.11;
        b.curve = C_POP;
        b.popFrac = 0.25;
        b.fadeStart = 0.5;
        b.p.rotation = this.rng.range(-0.4, 0.4);
        const r2 = this.spawn('ring', x + ox, y + oy, bs * 0.3, bs * 1.4, 0.3, RING_TINT);
        if (r2) {
          r2.delay = b.delay;
          r2.a0 = 0.85;
        }
      }
    }
  }

  /** 파편: 볼트·스프링·반짝이 위·옆으로 튀었다가 중력으로 떨어지며 돌고 사라짐 */
  private debris(x: number, y: number, n: number, spread: number, power: number, delay = 0): void {
    for (let i = 0; i < n; i++) {
      if (!this.roomFor(false)) return;
      const k = this.rng.int(0, DEBRIS.length - 1);
      const a = -Math.PI / 2 + this.rng.range(-1.35, 1.35);
      const sp = this.rng.range(220, 430) * power;
      const sz = this.rng.range(13, 19) * (power > 1 ? 1.15 : 1);
      const f = this.spawn(DEBRIS[k], x + Math.cos(a) * spread * 0.3, y + Math.sin(a) * spread * 0.3, sz, sz * 0.85, this.rng.range(0.55, 0.75), DEBRIS_TINT[k]);
      if (!f) return;
      f.delay = delay;
      f.vx = Math.cos(a) * sp;
      f.vy = Math.sin(a) * sp;
      f.grav = 1250;
      f.drag = 0.6;
      f.vr = this.rng.range(-14, 14);
      f.p.rotation = this.rng.range(0, Math.PI * 2);
      f.fadeStart = 0.55;
    }
  }

  // ── 발사 / 벽 ───────────────────────────────────────────────

  /** 총구 연기 (스로틀): 발사점에서 조준 방향으로 퍼지는 작은 구름 */
  muzzle(x: number, y: number, angle: number): void {
    if (this.clock - this.lastMuzzle < MUZZLE_PUFF_THROTTLE) return;
    this.lastMuzzle = this.clock;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const f = this.spawn('puff', x + c * 26, y + s * 26, 22, 50, 0.3, 0xffffff);
    if (f) {
      f.curve = C_POP;
      f.popFrac = 0.35;
      f.vx = c * 170;
      f.vy = s * 170;
      f.drag = 7;
      f.a0 = 0.9;
      f.fadeStart = 0.35;
      f.p.rotation = this.rng.range(-0.5, 0.5);
    }
    const k = this.spawn('sparkle', x + c * 20, y + s * 20, 14, 30, 0.12, 0xffffff);
    if (k) {
      k.curve = C_POP;
      k.p.rotation = this.rng.range(0, Math.PI);
    }
    // 발밑 흙먼지 (양옆으로, 더 드물게)
    if (this.clock - this.lastFeetDust < 0.28) return;
    this.lastFeetDust = this.clock;
    for (let side = -1; side <= 1; side += 2) {
      const g = this.spawn('dust', x + side * 20, y + 64, 16, 34, 0.3, 0xffffff);
      if (!g) return;
      g.vx = side * 90;
      g.vy = -20;
      g.drag = 6;
      g.a0 = 0.85;
      g.fadeStart = 0.35;
    }
  }

  /**
   * 벽 반사 먼지 + 반짝 (x, y = 벽 위 접점). 같은 자리 WALL_DUST_COOLDOWN 안 반복·초당 상한으로 스로틀
   * — 이벤트에 투사체 id가 없어서 '자리'로 투사체당 스로틀을 흉내 낸다.
   */
  wallBounce(x: number, y: number, fieldW: number): void {
    if (this.dustBudget < 1) return;
    for (let i = 0; i < this.dustT.length; i++) {
      if (this.clock - this.dustT[i] > WALL_DUST_COOLDOWN) continue;
      const dx = this.dustX[i] - x;
      const dy = this.dustY[i] - y;
      if (dx * dx + dy * dy < WALL_DUST_RADIUS * WALL_DUST_RADIUS) return;
    }
    if (!this.roomFor(false)) return;
    this.dustBudget -= 1;
    this.dustI = (this.dustI + 1) % this.dustT.length;
    this.dustX[this.dustI] = x;
    this.dustY[this.dustI] = y;
    this.dustT[this.dustI] = this.clock;
    // 벽 안쪽 법선
    let nx = 0;
    let ny = 1;
    if (x <= 0.5) {
      nx = 1;
      ny = 0;
    } else if (x >= fieldW - 0.5) {
      nx = -1;
      ny = 0;
    }
    // 먼지 그림은 아래가 바닥(위로 피어오름) → 위쪽(-y)이 벽 안쪽(n)을 보게 회전
    const rot = Math.atan2(ny, nx) + Math.PI / 2;
    const f = this.spawn('dust', x + nx * 10, y + ny * 10, 22, 46, 0.32, 0xffffff);
    if (f) {
      f.vx = nx * 40;
      f.vy = ny * 40;
      f.drag = 5;
      f.fadeStart = 0.35;
      f.p.rotation = rot;
    }
    const s = this.spawn('sparkle', x + nx * 6, y + ny * 6, 12, 26, 0.14, 0xffffff);
    if (s) {
      s.curve = C_POP;
      s.p.rotation = this.rng.range(0, Math.PI);
    }
  }

  /** 승리 연출용 색종이 펑 */
  confetti(x: number, y: number): void {
    const colors = [0xff6b9a, 0xffd23f, 0x5ee07a, 0x6fd8ff, 0xb46cff];
    for (let i = 0; i < 16; i++) {
      const frame: FxFrame = i % 3 === 0 ? 'star' : 'shard';
      const sz = frame === 'star' ? this.rng.range(30, 38) : this.rng.range(26, 34);
      const f = this.spawn(frame, x, y, sz, sz * 0.8, this.rng.range(0.9, 1.3), colors[i % colors.length]);
      if (!f) return;
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(180, 440);
      f.vx = Math.cos(a) * sp;
      f.vy = Math.sin(a) * sp - 200;
      f.grav = 560;
      f.drag = 1.5;
      f.vr = this.rng.range(-10, 10);
      f.curve = C_LIN;
      f.fadeStart = 0.6;
    }
  }

  // ── 매 프레임 ───────────────────────────────────────────────

  update(dt: number): void {
    this.clock += dt;
    this.impactsThisFrame = 0;
    this.dustBudget = Math.min(WALL_DUST_PER_SEC * 0.25, this.dustBudget + WALL_DUST_PER_SEC * dt);

    // 파티클 (생성 순서 유지 — 늦게 생긴 것이 위)
    const act = this.active;
    // 보이는 목록은 칸에 덮어쓰고 끝에서 길이만 맞춘다 — length = 0 후 push는 매 프레임 배열 저장소를 다시 키워 할당이 생긴다
    const vis = this.pc.particleChildren;
    let nv = 0;
    let w = 0;
    for (let i = 0; i < act.length; i++) {
      const f = act[i];
      if (f.delay > 0) {
        f.delay -= dt;
        act[w++] = f;
        continue;
      }
      f.t += dt;
      if (f.t >= f.life) {
        this.pool.push(f);
        continue;
      }
      act[w++] = f;
      const k = f.t / f.life;
      if (f.drag > 0) {
        const d = Math.max(0, 1 - f.drag * dt);
        f.vx *= d;
        f.vy *= d;
      }
      f.vy += f.grav * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      const p = f.p;
      p.x = f.x;
      p.y = f.y;
      let e: number;
      if (f.curve === C_POP) {
        const q = Math.min(1, k / f.popFrac);
        e = outBack(q);
      } else if (f.curve === C_LIN) e = k;
      else if (f.curve === C_SWELL) e = k < 0.2 ? 1 - (1 - k / 0.2) * (1 - k / 0.2) : 1 + (k - 0.2) / 0.8;
      else e = 1 - (1 - k) * (1 - k);
      let size: number;
      if (f.curve === C_SWELL) {
        // 0 → s0까지 빠르게 커졌다가 s1로 줄어듦 (e: 0..1 성장, 1..2 수축)
        size = e <= 1 ? f.s0 * e : f.s0 + (f.s1 - f.s0) * (e - 1);
      } else size = f.s0 + (f.s1 - f.s0) * e;
      const sc = size / f.frameW;
      p.scaleX = sc;
      p.scaleY = sc * f.aspect;
      if (f.align) p.rotation = Math.atan2(f.vy, f.vx) + f.rot0;
      else if (f.vr !== 0) p.rotation += f.vr * dt;
      const a = f.a0 * (k < f.fadeStart ? 1 : 1 - (k - f.fadeStart) / (1 - f.fadeStart));
      p.alpha = a < 0 ? 0 : a;
      vis[nv++] = p;
    }
    act.length = w;
    vis.length = nv;

    // 숫자
    for (let i = 0; i < this.nums.length; i++) {
      const n = this.nums[i];
      if (!n.active) continue;
      n.age += dt;
      n.pop += dt;
      if (n.age >= n.life) {
        n.active = false;
        n.t.visible = false;
        if (this.numByEnemy.get(n.enemyId) === n) this.numByEnemy.delete(n.enemyId);
        continue;
      }
      const k = n.age / n.life;
      const d = Math.max(0, 1 - 2.2 * dt);
      n.vx *= d;
      n.vy = n.vy * d + 420 * dt;
      if (n.vy > 40) n.vy = 40;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      if (n.y < this.numTop) {
        n.y = this.numTop;
        if (n.vy < 0) n.vy = 0;
      }
      // 1.6배에서 outBack으로 1배
      const q = Math.min(1, n.pop / 0.2);
      const pop = 1.6 - 0.6 * outBack(q);
      n.t.position.set(n.x, n.y);
      n.t.scale.set(n.scale * pop);
      n.t.alpha = k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38;
    }

    // 번개
    const beams = this.boltPc.particleChildren;
    let nb = 0;
    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i];
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.life) {
        b.active = false;
        continue;
      }
      b.jitter -= dt;
      if (b.jitter <= 0) {
        b.jitter = BOLT_REJITTER;
        for (let i = 0; i < b.offs.length; i++) b.offs[i] = this.rng.range(-b.amp, b.amp);
      }
      nb = this.placeBolt(b, beams, nb);
    }
    beams.length = nb;
  }

  /**
   * 인트로 동안 화면 밖(필드 훨씬 위)에서 연출을 한 번씩 돌린다 — 첫 타격·폭발·번개·처치 프레임에 코드 준비(JIT)와
   * 아틀라스 첫 업로드 비용이 몰리지 않게 (측정: 첫 번개 프레임 13 ms, 첫 폭발 7 ms @ CPU 4배 감속).
   * 연출용 RNG만 쓰므로 게임 결과와 무관.
   */
  prewarm(): void {
    const x = 300;
    const y = -1400;
    this.impact(x, y, 12, null, 0, 1);
    this.impact(x, y, 12, 'fire', 1, 0);
    this.impact(x, y, 12, 'ice', -1, 0);
    this.impact(x, y, 12, 'lightning', 0, -1);
    this.splashHit(x, y, 12);
    this.burnTick(x, y);
    this.burnEmit(x, y, 80, 80);
    this.frostEmit(x, y, 80, 80);
    this.chain(x, y, x + 90, y);
    this.chainHit(x, y);
    this.explosion(x, y, 70);
    // 떨어진 자리에서 (겹친 폭발로 줄여 그리지 않고 서리 폭발 전체를 한 번 돌게)
    this.explosion(x + 400, y, 70, 'ice');
    this.killBurst(x, y, 80, 1, 0);
    this.splitPuff(x, y, 3);
    this.fizzle(x, y, 24);
    this.update(0);
  }

  /** 디버그/측정용: 지금 살아있는 파티클 수 */
  get particleCount(): number {
    return this.active.length;
  }

  // ── 내부 ────────────────────────────────────────────────────

  private numScale(amount: number): number {
    const rel = amount * this.dmgNorm;
    return clamp(0.8 + 0.2 * Math.log2(1 + rel / 12), 0.8, 1.3);
  }

  private number(x: number, y: number, text: string, color: number, scale: number, vx: number, vy: number): Num {
    // 링 버퍼: 가장 오래된 것을 재사용 (풀은 생성자에서 다 만들어 둠)
    const n = this.nums[this.nextNum];
    this.nextNum = (this.nextNum + 1) % MAX_DAMAGE_NUMBERS;
    if (this.numByEnemy.get(n.enemyId) === n) this.numByEnemy.delete(n.enemyId);
    if (n.t.text !== text) n.t.text = text;
    if (y < this.numTop) y = this.numTop;
    n.active = true;
    n.enemyId = -1;
    n.small = false;
    n.x = x;
    n.y = y;
    n.vx = vx;
    n.vy = vy;
    n.age = 0;
    n.pop = 0;
    n.life = DAMAGE_NUMBER_LIFE;
    n.scale = scale;
    n.t.tint = color;
    n.t.visible = true;
    n.t.alpha = 1;
    n.t.position.set(x, y);
    n.t.scale.set(scale * 1.6);
    // 최신 숫자가 위에 오도록
    this.numLayer.addChild(n.t);
    return n;
  }

  /** 장식용 파티클을 더 띄워도 되는가 (essential = 타격 반짝처럼 중요한 것은 거의 꽉 찰 때까지 허용) */
  private roomFor(essential: boolean): boolean {
    const used = this.active.length / MAX_PARTICLES;
    return used < (essential ? 0.95 : PARTICLE_SOFT_CAP);
  }

  /** size0 → size1 (px, 프레임 폭 기준), 수명(초), tint. 풀이 비면 null */
  private spawn(frame: FxFrame, x: number, y: number, size0: number, size1: number, life: number, tint: number): Fx | null {
    const f = this.pool.pop();
    if (!f) return null;
    const t = this.atlas[frame];
    const p = f.p;
    if (p.texture !== t) p.texture = t;
    f.frameW = Math.max(1, t.width);
    f.t = 0;
    f.life = life;
    f.delay = 0;
    f.x = x;
    f.y = y;
    f.vx = 0;
    f.vy = 0;
    f.drag = 0;
    f.grav = 0;
    f.vr = 0;
    f.s0 = size0;
    f.s1 = size1;
    f.aspect = 1;
    f.curve = C_OUT;
    f.popFrac = POP_FRAC_DEFAULT;
    f.a0 = 1;
    f.fadeStart = 0.5;
    f.align = false;
    f.rot0 = 0;
    p.x = x;
    p.y = y;
    p.rotation = 0;
    p.tint = tint;
    p.alpha = 1;
    p.scaleX = p.scaleY = size0 / f.frameW;
    this.active.push(f);
    return f;
  }

  private bolt(x1: number, y1: number, x2: number, y2: number, life: number, width: number, amp: number): void {
    let slot: Bolt | null = null;
    let oldest: Bolt | null = null;
    for (const b of this.bolts) {
      if (!b.active) {
        slot = b;
        break;
      }
      if (!oldest || b.age / b.life > oldest.age / oldest.life) oldest = b;
    }
    const b = slot ?? oldest!;
    b.active = true;
    b.x1 = x1;
    b.y1 = y1;
    b.x2 = x2;
    b.y2 = y2;
    b.age = 0;
    b.life = life;
    b.width = width;
    b.amp = amp;
    b.jitter = 0;
  }

  /**
   * 번개 하나를 마디 파티클로 놓는다 (out[n..]). 마디 = 지그재그 꼭짓점 사이, 단면 텍스처가 빛·몸통·심을 한 장에 담는다.
   * 반환: 다음 빈 칸.
   */
  private placeBolt(b: Bolt, out: Particle[], n: number): number {
    const k = b.age / b.life;
    const alpha = k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5;
    const dx = b.x2 - b.x1;
    const dy = b.y2 - b.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const amp = Math.min(1, len / 60);
    const thick = BEAM_WORLD_W * b.width;
    const sy = thick / BEAM_TEX_H;
    const ext = thick * BEAM_OVERLAP;
    let ax = b.x1;
    let ay = b.y1;
    for (let i = 1; i <= BOLT_SEGMENTS; i++) {
      let bx: number;
      let by: number;
      if (i < BOLT_SEGMENTS) {
        const f = i / BOLT_SEGMENTS;
        const o = b.offs[i - 1] * amp;
        bx = b.x1 + dx * f + nx * o;
        by = b.y1 + dy * f + ny * o;
      } else {
        bx = b.x2;
        by = b.y2;
      }
      const sx = bx - ax;
      const syy = by - ay;
      const sl = Math.sqrt(sx * sx + syy * syy);
      if (sl > 0.01 && n < this.beams.length) {
        const ux = sx / sl;
        const uy = syy / sl;
        const p = this.beams[n];
        p.x = ax - ux * ext;
        p.y = ay - uy * ext;
        p.rotation = Math.atan2(syy, sx);
        p.scaleX = (sl + ext * 2) / BEAM_TEX_W;
        p.scaleY = sy;
        p.alpha = alpha;
        out[n++] = p;
      }
      ax = bx;
      ay = by;
    }
    return n;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 0..1 → 살짝 넘쳤다가 1 */
function outBack(k: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  const m = k - 1;
  return 1 + c3 * m * m * m + c1 * m * m;
}
