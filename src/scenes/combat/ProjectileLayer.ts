// 투사체 / 적 탄 스프라이트 풀. 엔티티 id → 스프라이트, 매 프레임 stamp로 사라진 것을 회수한다.
// 꼬리: 투사체마다 최근 위치 링 버퍼 → 길이를 고정 길이 마디 TRAIL_SEGMENTS개로 다시 나눠, 마디마다 가늘어지는
// 띠 파티클 하나(굵기·알파가 TRAIL_TAPER 배씩 → 이어 붙인 자리가 끊기지 않음). ParticleContainer 한 개 = 드로우콜 1.
import { Container, Particle, ParticleContainer, Sprite, type Texture } from 'pixi.js';
import { ELEMENT_COLORS, FIELD_H } from '../../config';
import { tex } from '../../render/assets';
import type { Element, EnemyShotEntity, ProjectileEntity } from '../../types';
import { TRAIL_TEX_H, TRAIL_TEX_W } from './fxTextures';
import {
  ENEMY_SHOT_GLOW,
  PROJ_VISUAL_SCALE,
  SHOT_GLOW_SCALE,
  SHOT_TRAIL_ALPHA,
  SHOT_TRAIL_LEN,
  SHOT_VISUAL_SCALE,
  SPIN_SPEED,
  SPINNING_SHOTS,
  SPRITE_FACING,
  TRAIL_ALPHA,
  TRAIL_COLOR,
  TRAIL_FALL_ALPHA,
  TRAIL_FALL_RATE,
  TRAIL_HISTORY,
  TRAIL_LEN_MAX,
  TRAIL_LEN_MIN,
  TRAIL_LEN_PER_RADIUS,
  TRAIL_SEGMENTS,
  TRAIL_TAPER,
  TRAIL_WIDTH,
  WOBBLE_ANGLE,
  WOBBLE_HZ,
} from './visual';

interface View {
  body: Sprite;
  glow: Sprite | null;
  stamp: number;
  /** 지금 맡은 엔티티 id (회수할 때 맵에서 지우는 키) */
  id: number;
  /** 회전 모드: 'spin' | 'face' | 'upright' */
  mode: 0 | 1 | 2;
  facing: number;
  spinDir: number;
  phase: number;
  /** 최근 위치 링 버퍼 [x0,y0,x1,y1,...], hi = 가장 최근 칸, hn = 채워진 칸 수 */
  hist: Float32Array;
  hi: number;
  hn: number;
  /** 꼬리 마디 파티클 (뷰와 함께 재사용) */
  segs: Particle[];
  trailLen: number;
  trailW: number;
  trailA: number;
  /** 꼬리 알파 배수 (내려가는 투사체는 TRAIL_FALL_ALPHA 쪽으로) */
  fall: number;
  trailColor: number;
  /** 충돌 반경 (사라질 때 연기 크기) */
  radius: number;
}

const SPIN = 0;
const FACE = 1;
const UPRIGHT = 2;
/** 원소 투사체 꼬리 (색이 진해서 흰 꼬리보다 알파는 낮게 — 불꽃 토스터 주황 꼬리가 화면을 덮지 않게) */
const ELEMENT_TRAIL_ALPHA = 0.62;
const SHOT_TRAIL_COLOR = 0xff5a4a;
const SHOT_TRAIL_WIDTH = 0.95;
/**
 * 회수할 때 마지막으로 본 위치가 필드 바닥에서 이보다 위면 '공중에서 사라짐'(수명 상한·반사 소진)으로 보고 onVanish.
 * 바닥으로 빠지는 공은 마지막 프레임에 바닥 근처(빠른 공은 한 프레임 15 px 남짓 + 반경)라 여기에 안 걸린다
 */
const VANISH_BOTTOM_MARGIN = 48;

function facingOf(sprite: string): { mode: 1 | 2; facing: number } {
  const f = SPRITE_FACING[sprite];
  if (f === null) return { mode: UPRIGHT, facing: 0 };
  return { mode: FACE, facing: f ?? 0 };
}

function fitScale(t: Texture, size: number): number {
  return size / Math.max(1, t.width, t.height);
}

function makeTrailContainer(texture: Texture): ParticleContainer<Particle> {
  const pc = new ParticleContainer<Particle>({
    texture,
    dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
  });
  pc.eventMode = 'none';
  return pc;
}

export class ProjectileLayer {
  private readonly projMap = new Map<number, View>();
  private readonly shotMap = new Map<number, View>();
  private readonly freeProj: View[] = [];
  private readonly freeShot: View[] = [];
  /**
   * 지금 맡고 있는 뷰들 (회수 검사용). 매 프레임 Map을 for-of로 돌면 반복자 결과 객체가 할당돼서
   * (측정: 전투 중 할당 상위 — ProjectileLayer.sync + 반복자 next) 배열로 따로 들고 칸으로 돈다
   */
  private readonly liveProj: View[] = [];
  private readonly liveShot: View[] = [];
  private readonly projTrails: ParticleContainer<Particle>;
  private readonly shotTrails: ParticleContainer<Particle>;
  private readonly shotGlows = new Container();
  private readonly shotBodies = new Container();
  private stamp = 0;
  private clock = 0;

  /**
   * @param projLayer 플레이어 투사체 부모
   * @param trailLayer 플레이어 투사체 꼬리 부모 (적 아래)
   * @param shotLayer 적 탄 부모 (꼬리 → 글로우 → 본체 순서로 자식을 붙인다)
   * @param onVanish 플레이어 투사체가 바닥으로 빠지지 않고 필드 안에서 사라졌을 때 (마지막 위치, 충돌 반경)
   */
  constructor(
    private readonly projLayer: Container,
    trailLayer: Container,
    shotLayer: Container,
    private readonly glowTex: Texture,
    private readonly trailTex: Texture,
    private readonly onVanish: ((x: number, y: number, radius: number) => void) | null = null,
  ) {
    this.projTrails = makeTrailContainer(trailTex);
    this.shotTrails = makeTrailContainer(trailTex);
    trailLayer.addChild(this.projTrails);
    shotLayer.addChild(this.shotTrails, this.shotGlows, this.shotBodies);
  }

  sync(projectiles: readonly ProjectileEntity[], shots: readonly EnemyShotEntity[], dt: number): void {
    const stamp = ++this.stamp;
    this.clock += dt;
    const clock = this.clock;
    // 꼬리 목록은 칸에 덮어쓰고 끝에서 길이만 맞춘다 (length = 0 후 push는 매 프레임 배열 저장소를 다시 키운다)
    const trails = this.projTrails.particleChildren;
    let nt = 0;

    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      let v = this.projMap.get(p.id);
      if (!v) {
        v = this.acquireProj(p);
        this.projMap.set(p.id, v);
        this.liveProj.push(v);
      }
      v.stamp = stamp;
      v.id = p.id;
      const b = v.body;
      b.position.set(p.x, p.y);
      if (v.mode === SPIN) b.rotation += SPIN_SPEED * v.spinDir * dt;
      else if (v.mode === FACE) b.rotation = Math.atan2(p.vy, p.vx) - v.facing;
      else b.rotation = Math.sin((clock + v.phase) * WOBBLE_HZ * Math.PI * 2) * WOBBLE_ANGLE;
      // 공격하러 올라가는 공은 꼬리가 진하고, 반사돼 내려오는 공은 옅게 (부드럽게 바뀜)
      const fallTo = p.vy > 0 ? TRAIL_FALL_ALPHA : 1;
      const fstep = TRAIL_FALL_RATE * dt;
      v.fall = v.fall < fallTo ? Math.min(fallTo, v.fall + fstep) : Math.max(fallTo, v.fall - fstep);
      record(v, p.x, p.y);
      nt = buildTrail(v, trails, nt);
    }
    trails.length = nt;
    const liveP = this.liveProj;
    let w = 0;
    for (let i = 0; i < liveP.length; i++) {
      const v = liveP[i];
      if (v.stamp === stamp) {
        liveP[w++] = v;
        continue;
      }
      this.projMap.delete(v.id);
      v.body.visible = false;
      this.freeProj.push(v);
      if (this.onVanish && v.hn > 0) {
        const ly = v.hist[v.hi * 2 + 1];
        if (ly < FIELD_H - VANISH_BOTTOM_MARGIN) this.onVanish(v.hist[v.hi * 2], ly, v.radius);
      }
    }
    liveP.length = w;

    const shotTrails = this.shotTrails.particleChildren;
    let ns = 0;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      let v = this.shotMap.get(s.id);
      if (!v) {
        v = this.acquireShot(s.sprite, s.radius, s.vx, s.id);
        this.shotMap.set(s.id, v);
        this.liveShot.push(v);
      }
      v.stamp = stamp;
      v.id = s.id;
      v.body.position.set(s.x, s.y);
      const g = v.glow!;
      g.position.set(s.x, s.y);
      g.alpha = 0.55 + 0.25 * Math.sin((clock + v.phase) * 14);
      if (v.mode === SPIN) v.body.rotation += SPIN_SPEED * v.spinDir * dt;
      else if (v.mode === FACE) v.body.rotation = Math.atan2(s.vy, s.vx) - v.facing;
      else v.body.rotation = Math.sin((clock + v.phase) * WOBBLE_HZ * Math.PI * 2) * WOBBLE_ANGLE;
      record(v, s.x, s.y);
      ns = buildTrail(v, shotTrails, ns);
    }
    shotTrails.length = ns;
    const liveS = this.liveShot;
    w = 0;
    for (let i = 0; i < liveS.length; i++) {
      const v = liveS[i];
      if (v.stamp === stamp) {
        liveS[w++] = v;
        continue;
      }
      this.shotMap.delete(v.id);
      v.body.visible = false;
      v.glow!.visible = false;
      this.freeShot.push(v);
    }
    liveS.length = w;
  }

  /**
   * 뷰 풀을 미리 채운다 (인트로 동안) — 첫 발사 프레임에 스프라이트·꼬리 파티클 생성이 몰리지 않게
   * (측정: 첫 발사 프레임 22 ms @ CPU 4배 감속, 뷰 15개 생성 + 텍스처 첫 업로드)
   */
  prewarm(projViews: number, shotViews: number): void {
    while (this.freeProj.length + this.projMap.size < projViews) this.freeProj.push(this.makeProjView());
    while (this.freeShot.length + this.shotMap.size < shotViews) this.freeShot.push(this.makeShotView());
  }

  private makeProjView(): View {
    const body = new Sprite();
    body.anchor.set(0.5);
    body.visible = false;
    this.projLayer.addChild(body);
    return this.newView(body, null);
  }

  private makeShotView(): View {
    const glow = new Sprite(this.glowTex);
    glow.anchor.set(0.5);
    glow.tint = ENEMY_SHOT_GLOW;
    glow.visible = false;
    const body = new Sprite();
    body.anchor.set(0.5);
    body.visible = false;
    this.shotGlows.addChild(glow);
    this.shotBodies.addChild(body);
    return this.newView(body, glow);
  }

  private newView(body: Sprite, glow: Sprite | null): View {
    const segs: Particle[] = [];
    for (let k = 0; k < TRAIL_SEGMENTS; k++) {
      segs.push(new Particle({ texture: this.trailTex, anchorX: 0, anchorY: 0.5 }));
    }
    return {
      body,
      glow,
      stamp: 0,
      id: -1,
      mode: SPIN,
      facing: 0,
      spinDir: 1,
      phase: 0,
      hist: new Float32Array(TRAIL_HISTORY * 2),
      hi: 0,
      hn: 0,
      segs,
      trailLen: 0,
      trailW: 0,
      trailA: 0,
      fall: 1,
      trailColor: 0xffffff,
      radius: 0,
    };
  }

  private acquireProj(p: ProjectileEntity): View {
    const v = this.freeProj.pop() ?? this.makeProjView();
    const t = tex(p.sprite);
    v.body.texture = t;
    v.body.scale.set(fitScale(t, p.radius * 2 * PROJ_VISUAL_SCALE));
    v.body.visible = true;
    v.body.rotation = 0;
    if (p.spin) {
      v.mode = SPIN;
      v.facing = 0;
    } else {
      const f = facingOf(p.sprite);
      v.mode = f.mode;
      v.facing = f.facing;
    }
    v.spinDir = p.vx < 0 ? -1 : 1;
    v.phase = (p.id % 17) / 17;
    v.radius = p.radius;
    v.hn = 0;
    v.trailLen = Math.max(TRAIL_LEN_MIN, Math.min(TRAIL_LEN_MAX, p.radius * TRAIL_LEN_PER_RADIUS));
    v.trailW = p.radius * 2 * TRAIL_WIDTH;
    const el: Element | undefined = p.elements[0];
    v.trailColor = el ? ELEMENT_COLORS[el] : TRAIL_COLOR;
    v.trailA = el ? ELEMENT_TRAIL_ALPHA : TRAIL_ALPHA;
    v.fall = p.vy > 0 ? TRAIL_FALL_ALPHA : 1;
    for (const s of v.segs) s.tint = v.trailColor;
    return v;
  }

  private acquireShot(sprite: string, radius: number, vx: number, id: number): View {
    const v = this.freeShot.pop() ?? this.makeShotView();
    const t = tex(sprite);
    v.body.texture = t;
    v.body.scale.set(fitScale(t, radius * 2 * SHOT_VISUAL_SCALE));
    v.body.visible = true;
    v.body.rotation = 0;
    const g = v.glow!;
    g.scale.set(fitScale(this.glowTex, radius * 2 * SHOT_GLOW_SCALE));
    g.visible = true;
    if (SPINNING_SHOTS.has(sprite)) {
      v.mode = SPIN;
      v.facing = 0;
    } else {
      const f = facingOf(sprite);
      v.mode = f.mode;
      v.facing = f.facing;
    }
    v.spinDir = vx < 0 ? -1 : 1;
    v.phase = (id % 13) / 13;
    v.hn = 0;
    v.trailLen = SHOT_TRAIL_LEN;
    v.trailW = radius * 2 * SHOT_TRAIL_WIDTH;
    v.trailColor = SHOT_TRAIL_COLOR;
    v.trailA = SHOT_TRAIL_ALPHA;
    v.fall = 1;
    for (const s of v.segs) s.tint = SHOT_TRAIL_COLOR;
    return v;
  }
}

/** 현재 위치를 링 버퍼에 넣는다 (거의 안 움직였으면 가장 최근 칸만 갱신) */
function record(v: View, x: number, y: number): void {
  const h = v.hist;
  if (v.hn > 0) {
    const lx = h[v.hi * 2];
    const ly = h[v.hi * 2 + 1];
    if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < 1) return;
  }
  v.hi = (v.hi + 1) % TRAIL_HISTORY;
  h[v.hi * 2] = x;
  h[v.hi * 2 + 1] = y;
  if (v.hn < TRAIL_HISTORY) v.hn++;
}

/**
 * 머리(현재 위치)에서 기록을 거슬러 가며 길이 trailLen/TRAIL_SEGMENTS인 마디를 잘라 파티클로 놓는다.
 * 마디 k의 머리 굵기·알파 = 기준 × TRAIL_TAPER^k, 텍스처가 마디 안에서 같은 비율로 가늘어져 이음매가 맞는다.
 * out[n..]에 덮어쓰고 다음 빈 칸을 반환.
 */
function buildTrail(v: View, out: Particle[], n: number): number {
  if (v.hn < 2) return n;
  const h = v.hist;
  const segLen = v.trailLen / TRAIL_SEGMENTS;
  let idx = v.hi;
  let cx = h[idx * 2];
  let cy = h[idx * 2 + 1];
  let left = v.hn - 1; // 아직 안 쓴 기록 칸 수
  idx = (idx - 1 + TRAIL_HISTORY) % TRAIL_HISTORY;
  let w = v.trailW;
  let a = v.trailA * v.fall;
  for (let k = 0; k < TRAIL_SEGMENTS && left > 0; k++) {
    const sx = cx;
    const sy = cy;
    let need = segLen;
    while (need > 0 && left > 0) {
      const hx = h[idx * 2];
      const hy = h[idx * 2 + 1];
      const dx = hx - cx;
      const dy = hy - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= need) {
        cx += (dx * need) / d;
        cy += (dy * need) / d;
        need = 0;
      } else {
        need -= d;
        cx = hx;
        cy = hy;
        idx = (idx - 1 + TRAIL_HISTORY) % TRAIL_HISTORY;
        left--;
      }
    }
    const lx = cx - sx;
    const ly = cy - sy;
    const len = Math.sqrt(lx * lx + ly * ly);
    if (len < 0.5) break;
    const s = v.segs[k];
    s.x = sx;
    s.y = sy;
    s.rotation = Math.atan2(ly, lx);
    // 마디 사이 틈이 보이지 않게 아주 살짝 겹친다
    s.scaleX = (len + 0.8) / TRAIL_TEX_W;
    s.scaleY = w / TRAIL_TEX_H;
    s.alpha = a;
    out[n++] = s;
    w *= TRAIL_TAPER;
    a *= TRAIL_TAPER;
  }
  return n;
}
