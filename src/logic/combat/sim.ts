// 고정 스텝 전투 시뮬레이션. 같은 seed + 같은 입력 시퀀스 → 같은 결과.
// 필드 좌표: 좌상단 (0,0), 폭 FIELD_W, 높이 FIELD_H, y는 아래로 증가. 위·좌·우 벽, 아래는 열림.

import {
  AIM_MIN_DEG,
  BOSS_REHIT_DAMAGE_MUL,
  BOSS_REHIT_WINDOW,
  BURN_DURATION,
  BURN_RATIO,
  CELL,
  CHAIN_DAMAGE_MUL,
  CHAIN_RANGE,
  CHAIN_TARGETS,
  CHILL_ATTACK_RATE,
  CHILL_ATTACK_RATE_RESIST,
  CHILL_DAMAGE_TAKEN_MUL,
  CHILL_DURATION,
  DESCENT_FAST_FORWARD,
  ENEMY_INSET,
  EXPLODE_DAMAGE_MUL,
  FIELD_COLS,
  FIELD_H,
  FIELD_W,
  MAX_SUBSTEPS,
  MIN_VERTICAL_RATIO,
  PIERCE_REHIT_TIME,
  PLAYER_HIT_RADIUS,
  PLAYER_INVULN_TIME,
  PLAYER_START_Y,
  PROJECTILE_MAX_AGE,
  SPAWN_GAP,
  SPLIT_CHILD_MAX_AGE,
} from '../../config';
import type {
  CombatEvent,
  CombatInput,
  CombatStatus,
  Element,
  EnemyAttack,
  EnemyDef,
  EnemyEntity,
  EnemyShotEntity,
  LostReason,
  PlayerEntity,
  PlayerStats,
  ProjectileEntity,
  StageDef,
  WeaponLoadout,
  WeaponRuntime,
} from '../../types';
import { Rng } from '../rng';
import { stepPlayerMotion } from './movement';
import type { Contact, Velocity } from './physics';

export interface CombatSimOptions {
  stage: StageDef;
  stageIndex: number;
  enemies: Record<string, EnemyDef>;
  loadout: WeaponLoadout[];
  player: PlayerStats;
  hp: number;
  seed: number;
}

// ── 시뮬레이션 내부 상수 (밸런스 수치는 config.ts) ──────────────
const HIT_FLASH_TIME = 0.12;
/** 화상 피해를 hit 이벤트 하나로 묶어 보내는 간격(초) */
const BURN_EVENT_INTERVAL = 0.5;
/** 적의 아래 끝(y+h)이 이보다 내려와야 공격 타이머가 돈다 */
const ENEMY_ATTACK_MIN_BOTTOM = 40;
/** 발사 위치 = 플레이어 중심에서 이만큼 위 (조준 가이드·탭 조준도 여기를 기준으로 한다) */
export const FIRE_OFFSET_Y = 30;
/** 자동조준 발사 각도 지터(±도). 수동 조준(aimAngle)은 지터 없이 정확히 그 방향 — 조준 가이드가 거짓말하지 않게 */
const FIRE_JITTER_DEG = 2;
const SPLIT_FAN_DEG = 60;
/** 새로 장착한 무기의 첫 발사 대기 상한 */
const NEW_WEAPON_MAX_DELAY = 0.5;
const PUSH_EPS = 0.01;
const PUSH_ITERATIONS = 4;
/** 통과 중인 적 몸속에서 이만큼 반사하면 갇힌 것으로 보고 빠져나올 때까지 모든 적을 통과 */
const TRAP_BOUNCES = 4;
/** 자동조준 "가장 아래" 동률 판정 허용 오차(px) */
const AIM_TIE_EPS = 0.5;
/** 부채꼴 없는(spreadDeg 0) 다발 무기의 연사 간격(초): 한 발씩 차례로 나간다 */
const BURST_INTERVAL = 0.07;
const TIME_EPS = 1e-6;
const DEG = Math.PI / 180;
const AIM_MIN = AIM_MIN_DEG * DEG;

/** 연사 대기열: 첫 발 이후 남은 발들 */
interface PendingBurst {
  uid: number;
  /** 남은 발 수 */
  left: number;
  /** 다음 발까지 남은 시간 */
  timer: number;
  /** 마지막 발사 방향(라디안, 지터 제외). 자동조준 대상이 없을 때 이 방향으로 쏜다 */
  angle: number;
}

/** traceAim 결과 (호출 측이 한 개를 만들어 재사용) */
export interface AimTrace {
  /** out에 쓴 꼭짓점 수 (시작점 포함, ≥ 1) */
  points: number;
  /** 마지막 꼭짓점에서 닿은 적 id. 적에 닿지 않고 끝났으면 -1 */
  hitId: number;
}

interface Enemy extends EnemyEntity {
  def: EnemyDef;
  /** 냉기 중 공격 타이머 속도 (CHILL_ATTACK_RATE, 엘리트·보스는 CHILL_ATTACK_RATE_RESIST) */
  chillAttackRate: number;
  /** 브로드페이즈 중복 방문 방지 */
  stamp: number;
  /** 아직 이벤트로 보내지 않은 화상 피해 */
  burnAcc: number;
  burnTick: number;
}

interface Projectile extends ProjectileEntity {
  /** 수명 상한(초). 무기 발사 = PROJECTILE_MAX_AGE, 분열 자식 = SPLIT_CHILD_MAX_AGE. 없으면 PROJECTILE_MAX_AGE */
  maxAge?: number;
  /** 관통 타격 기록: 적 id → 마지막 타격 시각 */
  lastHit?: Map<number, number>;
  /**
   * 충돌을 무시하는 적 id (관통으로 뚫은 "터널" 또는 끼임 탈출 중).
   * 하나라도 아직 겹쳐 있으면 목록 전체를 유지하고, 모두 벗어나면 비운다.
   */
  passing?: number[];
  /** true면 빠져나올 때까지 닿는 적을 전부 passing에 넣는다 (끼임/갇힘 탈출) */
  ghost?: boolean;
  /** passing이 비지 않은 채로 적에게 반사한 횟수 */
  trapBounces?: number;
  /** 이 투사체가 마지막으로 보스를 직접 때린 시각 (보스 연타 감쇠 — BOSS_REHIT_WINDOW) */
  bossHitAt?: number;
}

/** 접촉 기록 (스텝마다 새로 만들지 않고 CombatSim이 풀로 재사용 — 매 서브스텝 할당을 없앤다) */
interface Hit extends Contact {
  e: Enemy;
}

function newHit(): Hit {
  return { e: null as unknown as Enemy, nx: 0, ny: 0, depth: 0 };
}

/** 번개 연쇄 후보 (풀 재사용) */
interface ChainPick {
  e: Enemy;
  d2: number;
}

function byDistanceThenId(a: ChainPick, b: ChainPick): number {
  return a.d2 - b.d2 || a.e.id - b.e.id;
}

export class CombatSim {
  private readonly es: Enemy[] = [];
  private readonly ps: Projectile[] = [];

  readonly player: PlayerEntity;
  /** 살아있는 적만 (죽은 적은 스텝 끝에 제거) */
  readonly enemies: EnemyEntity[] = this.es;
  readonly projectiles: ProjectileEntity[] = this.ps;
  readonly enemyShots: EnemyShotEntity[] = [];
  /** loadout 순서 */
  readonly weapons: WeaponRuntime[] = [];
  status: CombatStatus = 'running';
  lostReason: LostReason | null = null;
  time = 0;
  totalEnemies = 0;
  killedEnemies = 0;

  private readonly stage: StageDef;
  private readonly rng: Rng;
  private stats: PlayerStats;
  private loadout = new Map<number, WeaponLoadout>();
  /** 전투 중 가방에서 뺀 무기: uid → 다시 쏠 수 있는 시각 */
  private readonly benched = new Map<number, number>();
  private readonly byId = new Map<number, Enemy>();
  /** 열 버킷 (보이는 살아있는 적). 적은 수직으로만 움직이므로 매 스텝 다시 채운다 */
  private readonly columns: Enemy[][] = [];
  private events: CombatEvent[] = [];
  private nextId = 1;
  private stampSeq = 0;
  /** 진행 중인 연사 (발사 순서) */
  private bursts: PendingBurst[] = [];
  /** 이번 전투에서 도달한 최대 maxHp. 이를 넘는 증가분만 hp로 준다 (냄비 뚜껑 빼고 넣기 회복 방지) */
  private peakMaxHp: number;

  // ── 재사용 임시 객체 (결과에는 영향 없음 — 서브스텝마다 생기던 작은 객체 할당을 없앤다) ──
  /** collideEnemies의 접촉 목록 (앞에서부터 hitCount개만 유효) */
  private readonly hits: Hit[] = [];
  private hitCount = 0;
  /** 접촉 계산 임시값 / scanBlocking의 가장 깊은 접촉 */
  private readonly ct: Contact = { nx: 0, ny: 0, depth: 0 };
  private readonly block: Hit = newHit();
  /** 반사 속도 임시값 */
  private readonly vel: Velocity = { vx: 0, vy: 0 };
  /** 이번 서브스텝 시작 위치 (collideEnemies 인자 — double 인자 박싱을 피하려고 필드로 넘긴다) */
  private subX = 0.5;
  private subY = 0.5;
  /** 번개 연쇄 후보 (picks = 이번 호출의 정렬 대상, pickPool = 객체 풀) */
  private readonly picks: ChainPick[] = [];
  private readonly pickPool: ChainPick[] = [];

  constructor(opts: CombatSimOptions) {
    this.stage = opts.stage;
    this.stats = opts.player;
    this.peakMaxHp = opts.player.maxHp;
    this.rng = new Rng(opts.seed);
    for (let c = 0; c < FIELD_COLS; c++) this.columns.push([]);
    this.player = {
      x: FIELD_W / 2,
      y: PLAYER_START_Y,
      vx: 0,
      vy: 0,
      hitRadius: PLAYER_HIT_RADIUS,
      hp: Math.min(opts.hp, opts.player.maxHp),
      maxHp: opts.player.maxHp,
      invuln: 0,
    };
    this.spawnEnemies(opts.enemies);
    for (const l of opts.loadout) {
      this.loadout.set(l.uid, l);
      this.weapons.push({ uid: l.uid, timer: Math.min(l.cooldown, NEW_WEAPON_MAX_DELAY), cooldown: l.cooldown });
    }
  }

  step(dt: number, input: CombatInput): void {
    if (this.status !== 'running' || !(dt > 0)) return;
    this.time += dt;
    this.descend(dt);
    if (this.checkBreach()) {
      this.compact();
      return;
    }
    this.updatePlayer(dt, input);
    this.updateEnemies(dt);
    this.fireWeapons(dt, inputAim(input));
    this.rebuildColumns();
    this.updateProjectiles(dt);
    this.updateEnemyShots(dt);
    // 적 몸에 닿으면 즉시 패배 (이번 스텝에 죽은 적은 빼고 — 마지막 적을 잡으며 닿으면 승리)
    if (this.touchesEnemy()) this.lose('contact');
    else if (this.player.hp <= 0) this.lose('hp');
    else if (this.killedEnemies >= this.totalEnemies) this.win();
    this.compact();
  }

  setLoadout(loadout: WeaponLoadout[], player: PlayerStats): void {
    const prev = new Map<number, WeaponRuntime>();
    for (const w of this.weapons) prev.set(w.uid, w);
    this.loadout = new Map();
    this.weapons.length = 0;
    for (const l of loadout) {
      this.loadout.set(l.uid, l);
      const old = prev.get(l.uid);
      if (old) {
        prev.delete(l.uid);
        old.timer = Math.min(old.timer, l.cooldown);
        old.cooldown = l.cooldown;
        this.weapons.push(old);
        continue;
      }
      // 이번 전투에서 뺐던 무기를 다시 넣으면 남은 쿨타임을 이어서 쓴다 (빼고 넣기로 쿨 초기화 방지)
      const readyAt = this.benched.get(l.uid);
      this.benched.delete(l.uid);
      const wait = readyAt === undefined ? NEW_WEAPON_MAX_DELAY : Math.max(0, readyAt - this.time);
      this.weapons.push({ uid: l.uid, timer: Math.min(l.cooldown, wait), cooldown: l.cooldown });
    }
    for (const w of prev.values()) this.benched.set(w.uid, this.time + Math.max(0, w.timer));
    // 연사 중이던 무기를 뺐으면 남은 발은 버린다
    this.bursts = this.bursts.filter((b) => this.loadout.has(b.uid));

    // 최대 HP가 이번 전투 최고치를 넘은 만큼만 hp도 늘린다 (같은 장비를 빼고 넣어도 회복되지 않음)
    const pl = this.player;
    const gain = Math.max(0, player.maxHp - this.peakMaxHp);
    this.peakMaxHp = Math.max(this.peakMaxHp, player.maxHp);
    pl.maxHp = player.maxHp;
    pl.hp += gain;
    if (pl.hp > pl.maxHp) pl.hp = pl.maxHp;
    this.stats = player;
  }

  /** 디버그: 남은 적을 전부 정상 처치 경로로 죽인다 ('kill' 이벤트들 + 'won') */
  debugKillAll(): void {
    if (this.status !== 'running') return;
    for (const e of this.es) this.kill(e);
    if (this.killedEnemies >= this.totalEnemies) this.win();
    this.compact();
  }

  /** 디버그: 즉시 패배 (사유 'hp', 'lost' 이벤트) */
  debugLose(): void {
    this.lose('hp');
  }

  drainEvents(): CombatEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  progress(): number {
    return this.totalEnemies > 0 ? this.killedEnemies / this.totalEnemies : 1;
  }

  // ── 초기화 ──────────────────────────────────────────────────

  private spawnEnemies(defs: Record<string, EnemyDef>): void {
    const { rows, legend, hpMul } = this.stage;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let c = 0; c < FIELD_COLS && c < row.length; c++) {
        const ch = row[c];
        if (ch === '.') continue;
        const defId = legend[ch];
        const def = defId === undefined ? undefined : defs[defId];
        if (!def) {
          throw new Error(`CombatSim: stage '${this.stage.id}' row ${i} col ${c}: no enemy for '${ch}'`);
        }
        // 좌하단 문자 기준으로 오른쪽 w칸, 위로 h칸
        const top = -(i + def.h) * CELL - SPAWN_GAP;
        const hp = Math.max(1, Math.round(def.hp * hpMul));
        const atk = def.attack;
        const e: Enemy = {
          id: this.nextId++,
          defId,
          x: c * CELL + ENEMY_INSET,
          y: top + ENEMY_INSET,
          w: def.w * CELL - 2 * ENEMY_INSET,
          h: def.h * CELL - 2 * ENEMY_INSET,
          hp,
          maxHp: hp,
          alive: true,
          boss: def.boss === true,
          burnDps: 0,
          burnTime: 0,
          chillTime: 0,
          attackTimer: atk ? atk.interval + this.rng.next() * atk.jitter : 0,
          flash: 0,
          def,
          chillAttackRate: chillResistant(def) ? CHILL_ATTACK_RATE_RESIST : CHILL_ATTACK_RATE,
          stamp: 0,
          burnAcc: 0,
          burnTick: 0,
        };
        this.es.push(e);
        this.byId.set(e.id, e);
      }
    }
    this.totalEnemies = this.es.length;
  }

  // ── 스텝 단계 ───────────────────────────────────────────────

  // 배열 순회는 for...of 대신 인덱스 루프 (반복자 객체 할당 없음, 길이는 매번 다시 읽어 for...of와 같은 순서·범위)

  private descend(dt: number): void {
    const es = this.es;
    let visible = false;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.alive && e.y + e.h > 0) {
        visible = true;
        break;
      }
    }
    const dy = this.stage.descentSpeed * (visible ? 1 : DESCENT_FAST_FORWARD) * dt;
    for (let i = 0; i < es.length; i++) es[i].y += dy;
  }

  private checkBreach(): boolean {
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.alive && e.y + e.h >= FIELD_H) {
        this.lose('breach');
        return true;
      }
    }
    return false;
  }

  private updatePlayer(dt: number, input: CombatInput): void {
    const pl = this.player;
    const ix = input.targetX;
    const iy = input.targetY;
    const hasX = typeof ix === 'number' && Number.isFinite(ix);
    const hasY = typeof iy === 'number' && Number.isFinite(iy);
    // 목표를 향해 걷는다: 가속·최고 속도·도착 감속, 필드 벽 안 어디든 (movement.ts). 목표가 없으면 감속해서 선다
    stepPlayerMotion(pl, hasX ? ix : pl.x, hasY ? iy : pl.y, hasX || hasY, this.stats.moveSpeed, dt);
    if (pl.hp > 0 && this.stats.regenPerSec > 0) {
      pl.hp = Math.min(pl.maxHp, pl.hp + this.stats.regenPerSec * dt);
    }
    if (pl.invuln > 0) pl.invuln = tickDown(pl.invuln, dt);
  }

  private updateEnemies(dt: number): void {
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (!e.alive) continue;
      if (e.flash > 0) e.flash = tickDown(e.flash, dt);
      if (e.chillTime > 0) e.chillTime = tickDown(e.chillTime, dt);

      if (e.burnTime > 0) {
        const d = e.burnDps * Math.min(dt, e.burnTime);
        e.burnTime -= dt;
        e.hp -= d;
        e.burnAcc += d;
        e.burnTick -= dt;
        const ended = e.burnTime <= TIME_EPS;
        if (ended) {
          e.burnTime = 0;
          e.burnDps = 0;
        }
        if (ended || e.burnTick <= 0 || e.hp <= 0) this.flushBurn(e);
        if (e.hp <= 0) {
          this.kill(e);
          continue;
        }
      }

      const atk = e.def.attack;
      if (atk && e.y + e.h > ENEMY_ATTACK_MIN_BOTTOM) {
        // 냉기는 공격을 멈추지 않고 타이머를 느리게 흘린다 (엘리트·보스는 덜 느려짐)
        e.attackTimer -= e.chillTime > 0 ? dt * e.chillAttackRate : dt;
        if (e.attackTimer <= TIME_EPS) {
          this.enemyFire(e, atk);
          e.attackTimer = atk.interval;
        }
      }
    }
  }

  private flushBurn(e: Enemy): void {
    const amount = Math.round(e.burnAcc);
    if (amount > 0) {
      this.emit({ type: 'hit', enemyId: e.id, x: e.x + e.w / 2, y: e.y + e.h / 2, damage: amount, element: 'fire' });
    }
    e.burnAcc -= amount;
    e.burnTick = BURN_EVENT_INTERVAL;
  }

  private enemyFire(e: Enemy, atk: EnemyAttack): void {
    const ox = e.x + e.w / 2;
    const oy = e.y + e.h;
    const base =
      atk.kind === 'straight' ? Math.PI / 2 : Math.atan2(this.player.y - oy, this.player.x - ox);
    const n = Math.max(1, Math.floor(atk.count));
    const spread = atk.spreadDeg * DEG;
    const damage = atk.damage * this.stage.dmgMul;
    for (let k = 0; k < n; k++) {
      const a = fanAngle(base, spread, k, n);
      this.enemyShots.push({
        id: this.nextId++,
        x: ox,
        y: oy,
        vx: Math.cos(a) * atk.projSpeed,
        vy: Math.sin(a) * atk.projSpeed,
        radius: atk.radius,
        damage,
        sprite: atk.sprite,
        alive: true,
      });
    }
    this.emit({ type: 'enemyShoot', enemyId: e.id, x: ox, y: oy });
  }

  /** aim: 이번 스텝의 수동 조준각(clamp 끝남) 또는 null(자동조준) */
  private fireWeapons(dt: number, aim: number | null): void {
    // 대상(수동 조준이면 '보이는 적이 있는가' 판정용)은 이 단계에서 바뀌지 않으므로(투사체는 아직 안 움직임)
    // 스텝마다 한 번만 찾는다
    let target: Enemy | null | undefined;
    if (this.bursts.length > 0) target = this.fireBursts(dt, aim);
    const weapons = this.weapons;
    for (let i = 0; i < weapons.length; i++) {
      const w = weapons[i];
      w.timer -= dt;
      if (w.timer > TIME_EPS) continue;
      if (target === undefined) target = this.findTarget();
      const l = this.loadout.get(w.uid);
      // 보이는 적이 없으면 수동 조준이어도 쏘지 않고 준비된 채 대기
      if (!target || !l) {
        w.timer = 0;
        continue;
      }
      this.fireWeapon(l, aim ?? this.angleTo(target), aim !== null);
      if (w.timer < 0) w.timer = 0;
      w.timer += w.cooldown;
    }
  }

  /**
   * 대기 중인 연사의 다음 발들. 발마다 그 순간의 방향을 다시 잡는다: 수동 조준이면 지금의 조준각(지터 없음),
   * 아니면 자동조준 대상(없으면 직전 방향, 지터). 자동조준이면 찾은 대상을 반환해 무기 단계가 재사용한다.
   */
  private fireBursts(dt: number, aim: number | null): Enemy | null | undefined {
    const target = aim === null ? this.findTarget() : undefined;
    let w = 0;
    for (let i = 0; i < this.bursts.length; i++) {
      const b = this.bursts[i];
      b.timer -= dt;
      const l = this.loadout.get(b.uid);
      while (l && b.left > 0 && b.timer <= TIME_EPS) {
        const ox = this.player.x;
        const oy = this.player.y - FIRE_OFFSET_Y;
        if (aim !== null) b.angle = aim;
        else if (target) b.angle = this.angleTo(target);
        this.launch(l, ox, oy, aim !== null ? b.angle : b.angle + this.jitter());
        this.emit({ type: 'fire', weaponUid: l.uid, x: ox, y: oy, count: 1 });
        b.left -= 1;
        b.timer += BURST_INTERVAL;
      }
      if (l && b.left > 0) this.bursts[w++] = b;
    }
    this.bursts.length = w;
    return target;
  }

  /** 발사 위치(플레이어 위 FIRE_OFFSET_Y)에서 적 중심으로의 각도 */
  private angleTo(t: Enemy): number {
    const ox = this.player.x;
    const oy = this.player.y - FIRE_OFFSET_Y;
    return Math.atan2(t.y + t.h / 2 - oy, t.x + t.w / 2 - ox);
  }

  /** 보이는 적 중 아래 끝이 가장 낮은 적, 동률이면 플레이어와 x가 가까운 적 */
  private findTarget(): Enemy | null {
    const px = this.player.x;
    let best: Enemy | null = null;
    let bestBottom = -Infinity;
    let bestDx = Infinity;
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (!e.alive) continue;
      const bottom = e.y + e.h;
      if (bottom <= 0) continue;
      const dx = Math.abs(e.x + e.w / 2 - px);
      if (bottom > bestBottom + AIM_TIE_EPS) {
        best = e;
        bestBottom = bottom;
        bestDx = dx;
      } else if (bottom >= bestBottom - AIM_TIE_EPS && dx < bestDx) {
        best = e;
        bestBottom = Math.max(bestBottom, bottom);
        bestDx = dx;
      }
    }
    return best;
  }

  /** base: 발사 중심 방향. exact(수동 조준)면 지터 없이 정확히 그 방향(부채꼴도 base 중심) */
  private fireWeapon(l: WeaponLoadout, base: number, exact: boolean): void {
    const ox = this.player.x;
    const oy = this.player.y - FIRE_OFFSET_Y;
    const n = Math.max(1, Math.floor(l.count));
    if (n > 1 && !(l.spreadDeg > 0)) {
      // 부채꼴 없는 다발(예: 분신 거울을 붙인 단발 무기)은 겹쳐 나가지 않게 연사로
      this.launch(l, ox, oy, exact ? base : base + this.jitter());
      this.emit({ type: 'fire', weaponUid: l.uid, x: ox, y: oy, count: 1 });
      this.bursts.push({ uid: l.uid, left: n - 1, timer: BURST_INTERVAL, angle: base });
      return;
    }
    const spread = l.spreadDeg * DEG;
    for (let k = 0; k < n; k++) {
      const a = fanAngle(base, spread, k, n);
      // 수동 조준: 낮게 쏠 때 부채꼴 바깥 발이 아래로 나가 바닥으로 버려지지 않게 발마다 위쪽 반원으로 접는다
      // (가운데 발은 조준각 그대로 — 조준 가이드와 일치)
      this.launch(l, ox, oy, exact ? clampAim(a) : a + this.jitter());
    }
    this.emit({ type: 'fire', weaponUid: l.uid, x: ox, y: oy, count: n });
  }

  private jitter(): number {
    return this.rng.range(-FIRE_JITTER_DEG, FIRE_JITTER_DEG) * DEG;
  }

  private launch(l: WeaponLoadout, ox: number, oy: number, a: number): void {
    this.ps.push({
      id: this.nextId++,
      weaponUid: l.uid,
      x: ox,
      y: oy,
      vx: Math.cos(a) * l.speed,
      vy: Math.sin(a) * l.speed,
      radius: l.radius,
      damage: l.damage,
      pierceLeft: l.pierce,
      bouncesLeft: l.maxBounces > 0 ? l.maxBounces : Infinity,
      elements: l.elements,
      explodeRadius: l.explodeRadius,
      split: l.split,
      sprite: l.sprite,
      spin: l.spin,
      age: 0,
      alive: true,
      maxAge: PROJECTILE_MAX_AGE,
      // 선택 필드도 처음부터 같은 순서로 만들어 둔다 (값은 undefined = 없음과 같다) — 투사체 객체가 모두 같은
      // 숨은 클래스를 쓰게 해서, 필드가 나중에 붙으며 모양이 여러 가지로 갈라지면 생기던 메가모픽 쓰기
      // (p.x 갱신마다 숫자 상자 할당 — 측정: 시뮬레이션 할당의 ~95%)를 없앤다. tests/sim-alloc.test.ts가 지킨다
      lastHit: undefined,
      passing: undefined,
      ghost: undefined,
      trapBounces: undefined,
      bossHitAt: undefined,
    });
  }

  private rebuildColumns(): void {
    const columns = this.columns;
    for (let c = 0; c < columns.length; c++) columns[c].length = 0;
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      // 화면 위(y+h ≤ 0)의 적에는 투사체가 닿을 수 없다 (상단 벽)
      if (!e.alive || e.y + e.h <= 0) continue;
      const c1 = colOf(e.x + e.w);
      for (let c = colOf(e.x); c <= c1; c++) columns[c].push(e);
    }
  }

  // ── 투사체 ──────────────────────────────────────────────────

  private updateProjectiles(dt: number): void {
    // 이번 스텝에 생긴 분열 자식은 다음 스텝부터 움직인다
    const count = this.ps.length;
    for (let i = 0; i < count; i++) {
      const p = this.ps[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age > (p.maxAge ?? PROJECTILE_MAX_AGE)) {
        p.alive = false;
        continue;
      }
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      let n = Math.ceil((speed * dt) / (p.radius * 0.8));
      if (!(n >= 1)) n = 1;
      else if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
      const h = dt / n;
      for (let s = 0; s < n; s++) {
        this.subX = p.x;
        this.subY = p.y;
        p.x += p.vx * h;
        p.y += p.vy * h;
        // 천장에 걸친 적의 아랫면은 천장보다 앞에 있다 — 그 적과 겹쳤으면 적을 먼저 처리
        const topLater = p.y - p.radius < 0 && this.underEnemy(p);
        this.collideWalls(p, !topLater);
        if (p.alive) this.collideEnemies(p);
        if (topLater && p.alive) this.collideWalls(p, true);
        if (p.alive && p.y - p.radius > FIELD_H) p.alive = false;
        if (!p.alive) break;
      }
    }
  }

  private collideWalls(p: Projectile, top: boolean): void {
    const r = p.radius;
    if (p.x - r < 0) {
      p.x = r;
      if (p.vx < 0) this.wallBounce(p, 1, 0, 0, p.y);
    } else if (p.x + r > FIELD_W) {
      p.x = FIELD_W - r;
      if (p.vx > 0) this.wallBounce(p, -1, 0, FIELD_W, p.y);
    }
    if (top && p.alive && p.y - r < 0) {
      p.y = r;
      if (p.vy < 0) this.wallBounce(p, 0, 1, p.x, 0);
    }
  }

  /** 통과 중이 아닌 적과 그 아랫면 쪽(중심이 아랫변보다 아래)에서 겹치는가 */
  private underEnemy(p: Projectile): boolean {
    const r = p.radius;
    const c1 = colOf(p.x + r);
    for (let c = colOf(p.x - r); c <= c1; c++) {
      const col = this.columns[c];
      for (let j = 0; j < col.length; j++) {
        const e = col[j];
        if (!e.alive || p.y <= e.y + e.h || (p.passing && p.passing.includes(e.id))) continue;
        if (overlapsRect(p.x, p.y, r, e)) return true;
      }
    }
    return false;
  }

  private wallBounce(p: Projectile, nx: number, ny: number, x: number, y: number): void {
    if (p.bouncesLeft <= 0) {
      p.alive = false;
      return;
    }
    p.bouncesLeft -= 1;
    const v = bounceVelocityInto(this.vel, p.vx, p.vy, nx, ny);
    p.vx = v.vx;
    p.vy = v.vy;
    this.emit({ type: 'bounce', x, y, wall: true });
  }

  /** 이번 서브스텝 시작 위치(subX, subY)는 고속 충돌의 진입면 판정에 쓴다 */
  private collideEnemies(p: Projectile): void {
    if (p.ghost || (p.passing && p.passing.length > 0)) this.prunePassing(p);
    const r = p.radius;
    const stamp = ++this.stampSeq;
    const c1 = colOf(p.x + r);
    const ct = this.ct;
    let n = 0;
    for (let c = colOf(p.x - r); c <= c1; c++) {
      const col = this.columns[c];
      for (let j = 0; j < col.length; j++) {
        const e = col[j];
        if (e.stamp === stamp) continue;
        e.stamp = stamp;
        if (!e.alive || !aabbOverlap(p, e)) continue;
        if (!circleRectContactInto(ct, p.x, p.y, r, e.x, e.y, e.w, e.h)) continue;
        if (this.tryPierce(p, e)) continue;
        const h = this.hits[n] ?? (this.hits[n] = newHit());
        n++;
        h.e = e;
        // 중심까지 파고들었으면 최소 침투 축 대신 실제로 들어온 면을 쓴다
        if (!(centerInside(p, e) && entryContactInto(h, this.subX, this.subY, p.x, p.y, r, e))) {
          h.nx = ct.nx;
          h.ny = ct.ny;
          h.depth = ct.depth;
        }
      }
    }
    this.hitCount = n;
    if (n > 0) this.resolveBounce(p);
  }

  /** 관통으로 처리했거나(통과 중 포함) 무시해야 하면 true */
  private tryPierce(p: Projectile, e: Enemy): boolean {
    const passing = p.passing;
    if (p.ghost) {
      if (!passing) p.passing = [e.id];
      else if (!passing.includes(e.id)) passing.push(e.id);
      return true;
    }
    if (passing && passing.includes(e.id)) {
      if (p.pierceLeft > 0 && this.canRehit(p, e.id)) this.pierceHit(p, e);
      return true;
    }
    if (p.pierceLeft <= 0) return false;
    if (this.canRehit(p, e.id)) this.pierceHit(p, e);
    (p.passing ??= []).push(e.id);
    return true;
  }

  private canRehit(p: Projectile, enemyId: number): boolean {
    const last = p.lastHit?.get(enemyId);
    return last === undefined || this.time - last >= PIERCE_REHIT_TIME - TIME_EPS;
  }

  private pierceHit(p: Projectile, e: Enemy): void {
    p.pierceLeft -= 1;
    (p.lastHit ??= new Map()).set(e.id, this.time);
    this.projectileHit(p, e, clamp(p.x, e.x, e.x + e.w), clamp(p.y, e.y, e.y + e.h));
    if (p.split) this.spawnSplit(p, p.vx, p.vy, e.id);
  }

  /** 접촉 목록 = this.hits의 앞 hitCount개 (collideEnemies가 채움) */
  private resolveBounce(p: Projectile): void {
    // 실제로 파고드는 접촉만 피해·반사 대상. 주 대상 = 가장 깊은 접촉
    let primary: Hit | null = null;
    let nx = 0;
    let ny = 0;
    const hits = this.hits;
    for (let i = 0; i < this.hitCount; i++) {
      const h = hits[i];
      if (p.vx * h.nx + p.vy * h.ny >= 0) continue;
      nx += h.nx;
      ny += h.ny;
      if (!primary || h.depth > primary.depth) primary = h;
    }
    if (!primary) {
      this.pushOut(p);
      return;
    }

    const len = Math.sqrt(nx * nx + ny * ny);
    if (len > 1e-6) {
      nx /= len;
      ny /= len;
    } else {
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      nx = -p.vx / sp;
      ny = -p.vy / sp;
    }
    const v = bounceVelocityInto(this.vel, p.vx, p.vy, nx, ny);
    // 임시 객체라 바로 꺼내 둔다
    const vx = v.vx;
    const vy = v.vy;
    const e = primary.e;
    const hx = clamp(p.x, e.x, e.x + e.w);
    const hy = clamp(p.y, e.y, e.y + e.h);
    this.projectileHit(p, e, hx, hy);

    const dying = p.bouncesLeft <= 0;
    if (!dying) {
      p.bouncesLeft -= 1;
      p.vx = vx;
      p.vy = vy;
      this.emit({ type: 'bounce', x: hx, y: hy, wall: false });
      // 뚫은 적 몸속에서 이웃 적들 사이를 계속 오가면 갇힌 것 — 빠져나올 때까지 통과
      if (p.passing && p.passing.length > 0) {
        p.trapBounces = (p.trapBounces ?? 0) + 1;
        if (p.trapBounces >= TRAP_BOUNCES) p.ghost = true;
      }
    }
    this.pushOut(p);
    if (p.split) this.spawnSplit(p, vx, vy, e.id);
    if (dying) p.alive = false;
  }

  /** 겹친 적에서 법선 방향으로 밀어낸다. 끝내 못 빠져나오면 겹친 적들을 통과시킨다 */
  private pushOut(p: Projectile): void {
    for (let it = 0; it < PUSH_ITERATIONS; it++) {
      const h = this.scanBlocking(p, false);
      if (!h) return;
      p.x += h.nx * (h.depth + PUSH_EPS);
      p.y += h.ny * (h.depth + PUSH_EPS);
      const r = p.radius;
      p.x = clamp(p.x, r, FIELD_W - r);
      if (p.y < r) p.y = r;
    }
    // 적 사이(또는 벽과 적 사이)에 끼었다 — 무한 핑퐁 대신 빠져나올 때까지 통과
    p.ghost = true;
    this.scanBlocking(p, true);
  }

  /**
   * 통과 중이 아닌 겹친 적 중 가장 깊은 접촉. ghost면 겹친 적 전부를 통과 목록에 넣는다.
   * 반환값은 재사용 객체(this.block) — 다음 호출 전에 읽고 버린다.
   */
  private scanBlocking(p: Projectile, ghost: boolean): Hit | null {
    const r = p.radius;
    const stamp = ++this.stampSeq;
    const c1 = colOf(p.x + r);
    const ct = this.ct;
    const best = this.block;
    let found = false;
    for (let c = colOf(p.x - r); c <= c1; c++) {
      const col = this.columns[c];
      for (let j = 0; j < col.length; j++) {
        const e = col[j];
        if (e.stamp === stamp) continue;
        e.stamp = stamp;
        if (!e.alive || !aabbOverlap(p, e)) continue;
        if (p.passing && p.passing.includes(e.id)) continue;
        if (!circleRectContactInto(ct, p.x, p.y, r, e.x, e.y, e.w, e.h)) continue;
        if (ghost) (p.passing ??= []).push(e.id);
        else if (!found || ct.depth > best.depth) {
          found = true;
          best.e = e;
          best.nx = ct.nx;
          best.ny = ct.ny;
          best.depth = ct.depth;
        }
      }
    }
    return found ? best : null;
  }

  /**
   * 통과 목록 정리. 죽은 적은 빼고, 남은 적 중 하나라도 겹쳐 있으면(터널 안) 유지,
   * 모두 벗어났으면 비우고 ghost 해제. 개별로 빼면 터널 속에서 되돌아올 때 이웃 적에 갇힌다.
   */
  private prunePassing(p: Projectile): void {
    const list = p.passing;
    let inside = false;
    if (list) {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const e = this.byId.get(list[i]);
        if (!e || !e.alive) continue;
        list[w++] = list[i];
        if (!inside && overlapsRect(p.x, p.y, p.radius, e)) inside = true;
      }
      list.length = inside ? w : 0;
    }
    if (!inside) {
      p.ghost = false;
      p.trapBounces = 0;
    }
  }

  private projectileHit(p: Projectile, e: Enemy, hx: number, hy: number): void {
    let direct = p.damage;
    if (e.boss) {
      // 보스 연타 감쇠: 같은 공이 BOSS_REHIT_WINDOW 안에 또 때리면 약하게 (보스 위에서 덜그럭거리는 공)
      const last = p.bossHitAt;
      if (last !== undefined && this.time - last < BOSS_REHIT_WINDOW - TIME_EPS) direct *= BOSS_REHIT_DAMAGE_MUL;
      p.bossHitAt = this.time;
    }
    this.damage(e, direct, p.elements, hx, hy, p.elements[0] ?? null);
    if (p.elements.includes('lightning')) this.chain(e, p.damage, p.elements);
    if (p.explodeRadius > 0) this.explode(p.x, p.y, p.explodeRadius, e, p.damage, p.elements);
  }

  private spawnSplit(p: Projectile, dvx: number, dvy: number, fromEnemy: number): void {
    const spec = p.split;
    if (!spec) return;
    p.split = null;
    const n = Math.max(0, Math.floor(spec.count));
    if (n === 0) return;
    const speed = Math.sqrt(dvx * dvx + dvy * dvy);
    const base = Math.atan2(dvy, dvx);
    const fan = SPLIT_FAN_DEG * DEG;
    for (let k = 0; k < n; k++) {
      const a = fanAngle(base, fan, k, n);
      const child: Projectile = {
        id: this.nextId++,
        weaponUid: p.weaponUid,
        x: p.x,
        y: p.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        radius: spec.radius,
        damage: p.damage * spec.damageMul,
        pierceLeft: 0,
        bouncesLeft: Infinity,
        elements: p.elements,
        explodeRadius: 0,
        split: null,
        sprite: spec.sprite,
        spin: p.spin,
        age: 0,
        alive: true,
        maxAge: SPLIT_CHILD_MAX_AGE,
        // launch와 같은 모양(필드 순서)으로 — launch 주석 참고
        lastHit: undefined,
        // 태어난 자리의 적을 곧바로 다시 때리지 않게
        passing: [fromEnemy],
        ghost: undefined,
        trapBounces: undefined,
        bossHitAt: undefined,
      };
      this.ps.push(child);
    }
    this.emit({ type: 'split', x: p.x, y: p.y, count: n });
  }

  // ── 피해 ────────────────────────────────────────────────────

  /** 피해 + 불/얼음 상태이상. 번개 연쇄·폭발은 직접 적중(projectileHit)에서만 */
  private damage(
    e: Enemy,
    base: number,
    elements: readonly Element[],
    x: number,
    y: number,
    element: Element | null,
  ): void {
    if (!e.alive) return;
    const dealt = base * (e.chillTime > 0 ? CHILL_DAMAGE_TAKEN_MUL : 1);
    e.hp -= dealt;
    e.flash = HIT_FLASH_TIME;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el === 'fire') this.ignite(e, dealt);
      else if (el === 'ice') e.chillTime = CHILL_DURATION;
    }
    this.emit({ type: 'hit', enemyId: e.id, x, y, damage: Math.round(dealt), element });
    if (e.hp <= 0) this.kill(e);
  }

  private ignite(e: Enemy, dealt: number): void {
    if (e.burnTime <= 0) {
      e.burnDps = 0;
      e.burnAcc = 0;
      e.burnTick = BURN_EVENT_INTERVAL;
    }
    e.burnDps = Math.max(e.burnDps, dealt * BURN_RATIO);
    e.burnTime = BURN_DURATION;
  }

  private chain(src: Enemy, base: number, elements: readonly Element[]): void {
    const sx = src.x + src.w / 2;
    const sy = src.y + src.h / 2;
    const range2 = CHAIN_RANGE * CHAIN_RANGE;
    // 후보 객체·배열은 재사용 (연쇄는 연쇄를 부르지 않으므로 겹쳐 쓰일 일이 없다)
    const picks = this.picks;
    const pool = this.pickPool;
    let count = 0;
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e === src || !e.alive || e.y + e.h <= 0) continue;
      const dx = e.x + e.w / 2 - sx;
      const dy = e.y + e.h / 2 - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= range2) {
        const pk = pool[count] ?? (pool[count] = { e, d2 });
        pk.e = e;
        pk.d2 = d2;
        picks[count++] = pk;
      }
    }
    picks.length = count;
    if (count === 0) return;
    picks.sort(byDistanceThenId);
    const dmg = base * CHAIN_DAMAGE_MUL;
    const n = Math.min(CHAIN_TARGETS, count);
    for (let i = 0; i < n; i++) {
      const t = picks[i].e;
      const tx = t.x + t.w / 2;
      const ty = t.y + t.h / 2;
      this.emit({ type: 'chain', fromX: sx, fromY: sy, toX: tx, toY: ty });
      this.damage(t, dmg, elements, tx, ty, 'lightning');
    }
  }

  private explode(
    x: number,
    y: number,
    radius: number,
    src: Enemy,
    base: number,
    elements: readonly Element[],
  ): void {
    const element = firstStatusElement(elements);
    this.emit({ type: 'explode', x, y, radius, element });
    const dmg = base * EXPLODE_DAMAGE_MUL;
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e === src || !e.alive || e.y + e.h <= 0) continue;
      if (!overlapsRect(x, y, radius, e)) continue;
      this.damage(e, dmg, elements, e.x + e.w / 2, e.y + e.h / 2, element);
    }
  }

  private kill(e: Enemy): void {
    if (!e.alive) return;
    e.alive = false;
    e.hp = 0;
    this.killedEnemies++;
    this.emit({ type: 'kill', enemyId: e.id, defId: e.defId, x: e.x + e.w / 2, y: e.y + e.h / 2, boss: e.boss });
  }

  // ── 적 탄 / 접촉 (적 몸에 닿으면 즉시 패배 — step의 touchesEnemy) ──────────────

  private updateEnemyShots(dt: number): void {
    const pl = this.player;
    const shots = this.enemyShots;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s.alive) continue;
      const ox = s.x;
      const oy = s.y;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // 이동 선분으로 판정해 빠른 탄도 플레이어를 건너뛰지 않게
      if (pl.invuln <= 0 && segmentHitsCircle(ox, oy, s.x, s.y, pl.x, pl.y, s.radius + pl.hitRadius)) {
        s.alive = false;
        this.hurtPlayer(s.damage, 'shot', s.x, s.y);
        continue;
      }
      const r = s.radius;
      if (s.x + r < 0 || s.x - r > FIELD_W || s.y + r < 0 || s.y - r > FIELD_H) s.alive = false;
    }
  }

  /** 플레이어 피격 원이 살아있는 적의 충돌 박스와 겹치는가 (무적 시간과 무관) */
  private touchesEnemy(): boolean {
    const pl = this.player;
    const es = this.es;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.alive && overlapsRect(pl.x, pl.y, pl.hitRadius, e)) return true;
    }
    return false;
  }

  private hurtPlayer(damage: number, source: 'shot', x: number, y: number): void {
    const pl = this.player;
    pl.hp -= damage;
    pl.invuln = PLAYER_INVULN_TIME;
    this.emit({ type: 'playerHit', damage: Math.round(damage), x, y, source });
  }

  // ── 종료 / 정리 ─────────────────────────────────────────────

  private lose(reason: LostReason): void {
    if (this.status !== 'running') return;
    this.status = 'lost';
    this.lostReason = reason;
    this.emit({ type: 'lost', reason });
  }

  private win(): void {
    if (this.status !== 'running') return;
    this.status = 'won';
    this.emit({ type: 'won' });
  }

  private compact(): void {
    retainAlive(this.ps);
    retainAlive(this.enemyShots);
    const es = this.es;
    let w = 0;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.alive) es[w++] = e;
      else this.byId.delete(e.id);
    }
    es.length = w;
  }

  private emit(ev: CombatEvent): void {
    this.events.push(ev);
  }
}

/**
 * 냉기 저항: 보스와 엘리트(보스가 아닌 2칸 이상 적 — 곰인형. 전투 씬의 처치 연출 등급과 같은 기준)는
 * 냉기 중에도 공격 타이머가 CHILL_ATTACK_RATE_RESIST로 흐른다 (일반 적은 CHILL_ATTACK_RATE).
 */
export function chillResistant(def: Pick<EnemyDef, 'w' | 'h' | 'boss'>): boolean {
  return def.boss === true || def.w * def.h > 1;
}

// ── 조준 (sim과 전투 씬이 함께 쓴다) ───────────────────────────

/**
 * 수동 조준각을 위쪽 반원 [-(π - AIM_MIN), -AIM_MIN]으로 clamp (AIM_MIN = AIM_MIN_DEG).
 * 범위 밖(수평 근처·아래쪽)은 오른쪽 반(cos ≥ 0)이면 -AIM_MIN, 왼쪽 반이면 -(π - AIM_MIN).
 * 아무 값(2π 넘게 돈 각도 포함)이나 받는다. 유한하지 않으면 바로 위(-π/2).
 */
export function clampAim(angle: number): number {
  if (!Number.isFinite(angle)) return -Math.PI / 2;
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  if (a <= -AIM_MIN && a >= AIM_MIN - Math.PI) return a;
  return Math.cos(a) >= 0 ? -AIM_MIN : AIM_MIN - Math.PI;
}

/** 입력의 수동 조준각(clamp 적용) 또는 null(자동조준) */
function inputAim(input: CombatInput): number | null {
  const a = input.aimAngle;
  return typeof a === 'number' && Number.isFinite(a) ? clampAim(a) : null;
}

/**
 * 조준 가이드 경로 (렌더 전용 미리보기, 게임 상태는 바꾸지 않음).
 * (x, y)에서 angle 방향으로 나가는 반경 r의 공을 직선으로 따라가며 좌·우·상단 벽에서 sim과 같은 규칙
 * (반사 + 수직 성분 보정)으로 꺾는다. 끝나는 곳: 처음 닿는 적(보이는 살아있는 적, r만큼 둥글게 넓힌 사각형 —
 * 실제 원-사각형 충돌과 같은 모양이라 모서리를 스쳐 지나갈 공을 '닿는다'고 그리지 않는다),
 * 선분 maxSegments개, 총 길이 maxLen, 또는 바닥 아래로 빠질 때.
 * 꼭짓점(시작점 포함)을 out[2i], out[2i+1]에 쓰고 res에 개수·닿은 적을 넣어 반환한다.
 * out 길이 ≥ 2 × (maxSegments + 1). 할당 없음 (반사 계산은 모듈 임시 객체에).
 */
export function traceAim(
  x: number,
  y: number,
  angle: number,
  r: number,
  enemies: readonly EnemyEntity[],
  maxLen: number,
  maxSegments: number,
  out: Float32Array | Float64Array | number[],
  res: AimTrace,
): AimTrace {
  let px = x;
  let py = y;
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  let left = maxLen;
  out[0] = px;
  out[1] = py;
  let n = 1;
  res.hitId = -1;
  for (let seg = 0; seg < maxSegments && left > 0; seg++) {
    // 이번 선분이 닿는 벽 (바닥은 열려 있음 → 빠져나감)
    let tWall = Infinity;
    let nx = 0;
    let ny = 0;
    if (dx < -1e-12) {
      tWall = (r - px) / dx;
      nx = 1;
    } else if (dx > 1e-12) {
      tWall = (FIELD_W - r - px) / dx;
      nx = -1;
    }
    let exits = false;
    if (dy < -1e-12) {
      const t = (r - py) / dy;
      if (t < tWall) {
        tWall = t;
        nx = 0;
        ny = 1;
      }
    } else if (dy > 1e-12) {
      const t = (FIELD_H + r - py) / dy;
      if (t < tWall) {
        tWall = t;
        exits = true;
      }
    }
    if (tWall < 0) tWall = 0;

    let tHit = Infinity;
    let hitId = -1;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || e.y + e.h <= 0) continue;
      const t = rayRoundRect(px, py, dx, dy, e.x, e.y, e.x + e.w, e.y + e.h, r);
      if (t < tHit) {
        tHit = t;
        hitId = e.id;
      }
    }

    const lim = tWall < left ? tWall : left;
    if (hitId >= 0 && tHit <= lim) {
      out[2 * n] = px + dx * tHit;
      out[2 * n + 1] = py + dy * tHit;
      n++;
      res.hitId = hitId;
      break;
    }
    px += dx * lim;
    py += dy * lim;
    left -= lim;
    out[2 * n] = px;
    out[2 * n + 1] = py;
    n++;
    if (exits || left <= 0 || lim < tWall) break;
    const v = bounceVelocityInto(traceVel, dx, dy, nx, ny);
    const sp = Math.sqrt(v.vx * v.vx + v.vy * v.vy) || 1;
    dx = v.vx / sp;
    dy = v.vy / sp;
  }
  res.points = n;
  return res;
}

/**
 * 반직선 (px,py)+t(dx,dy) (단위 벡터, t ≥ 0) 위의 반경 r 공이 사각형 [x0,x1]×[y0,y1]에 처음 닿는 t.
 * = 사각형을 r만큼 '둥글게' 넓힌 영역(가로로 넓힌 사각형 ∪ 세로로 넓힌 사각형 ∪ 네 모서리 원)에 들어가는 첫 t.
 * 실제 충돌(circleRectContact)과 같은 모양 — 그냥 r만큼 넓힌 사각형이면 모서리를 스쳐 지나갈 공도 닿는다고 그린다.
 * 시작점이 이미 닿아 있으면 0, 안 닿으면 Infinity.
 */
function rayRoundRect(px: number, py: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  let t = rayBox(px, py, dx, dy, x0 - r, y0, x1 + r, y1);
  let u = rayBox(px, py, dx, dy, x0, y0 - r, x1, y1 + r);
  if (u < t) t = u;
  u = rayCircle(px, py, dx, dy, x0, y0, r);
  if (u < t) t = u;
  u = rayCircle(px, py, dx, dy, x1, y0, r);
  if (u < t) t = u;
  u = rayCircle(px, py, dx, dy, x0, y1, r);
  if (u < t) t = u;
  u = rayCircle(px, py, dx, dy, x1, y1, r);
  return u < t ? u : t;
}

/** 반직선 (단위 방향)이 원 (cx,cy,r)에 들어가는 첫 t ≥ 0. 시작점이 안이면 0, 안 닿으면 Infinity */
function rayCircle(px: number, py: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const ox = px - cx;
  const oy = py - cy;
  const c = ox * ox + oy * oy - r * r;
  if (c <= 0) return 0;
  const b = ox * dx + oy * dy;
  if (b >= 0) return Infinity;
  const disc = b * b - c;
  return disc < 0 ? Infinity : -b - Math.sqrt(disc);
}

/** 반직선 (px,py)+t(dx,dy), t ≥ 0 이 사각형 [x0,x1]×[y0,y1]에 들어가는 첫 t. 시작점이 안이면 0, 안 닿으면 Infinity */
function rayBox(px: number, py: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): number {
  let tmin = 0;
  let tmax = Infinity;
  if (dx !== 0) {
    let a = (x0 - px) / dx;
    let b = (x1 - px) / dx;
    if (a > b) {
      const s = a;
      a = b;
      b = s;
    }
    if (a > tmin) tmin = a;
    if (b < tmax) tmax = b;
  } else if (px < x0 || px > x1) return Infinity;
  if (dy !== 0) {
    let a = (y0 - py) / dy;
    let b = (y1 - py) / dy;
    if (a > b) {
      const s = a;
      a = b;
      b = s;
    }
    if (a > tmin) tmin = a;
    if (b < tmax) tmax = b;
  } else if (py < y0 || py > y1) return Infinity;
  return tmin <= tmax ? tmin : Infinity;
}

// ── 헬퍼 ──────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 남은 시간 감소. 1/60을 반복해 빼면 정수배 시간도 +ε가 남아 한 스텝 늦게 끝나므로 TIME_EPS 이하는 0 */
function tickDown(t: number, dt: number): number {
  const r = t - dt;
  return r > TIME_EPS ? r : 0;
}

function colOf(x: number): number {
  const c = Math.floor(x / CELL);
  return c < 0 ? 0 : c >= FIELD_COLS ? FIELD_COLS - 1 : c;
}

/** n발을 spread(라디안) 부채꼴로 고르게. n=1이면 base */
function fanAngle(base: number, spread: number, k: number, n: number): number {
  return n > 1 ? base - spread / 2 + (spread * k) / (n - 1) : base;
}

/** traceAim 전용 반사 임시값 */
const traceVel: Velocity = { vx: 0, vy: 0 };

/**
 * 반사 + 수직 성분 보정. 보정 때문에 다시 파고드는 방향이 되면 vy를 뒤집는다. 결과를 out에 써서 반환(할당 없음).
 * physics.ts의 reflect → enforceMinVertical과 연산 순서까지 같다 (tests/sim-alloc.test.ts가 비트 단위로 비교).
 */
export function bounceVelocityInto(out: Velocity, vx: number, vy: number, nx: number, ny: number): Velocity {
  // reflect: v·n < 0 일 때만 반사
  const d = vx * nx + vy * ny;
  let rvx = vx;
  let rvy = vy;
  if (!(d >= 0)) {
    rvx = vx - 2 * d * nx;
    rvy = vy - 2 * d * ny;
  }
  // enforceMinVertical: 속력 유지, |vy| ≥ ratio × speed
  const speed = Math.sqrt(rvx * rvx + rvy * rvy);
  const minVy = Math.min(1, Math.max(0, MIN_VERTICAL_RATIO)) * speed;
  if (Math.abs(rvy) >= minVy) {
    out.vx = rvx;
    out.vy = rvy;
  } else {
    const nvy = rvy > 0 ? minVy : -minVy;
    const nvx = Math.sqrt(Math.max(0, speed * speed - nvy * nvy));
    out.vx = rvx < 0 ? -nvx : nvx;
    out.vy = nvy;
  }
  if (out.vx * nx + out.vy * ny < 0) out.vy = -out.vy;
  return out;
}

/**
 * physics.ts의 circleRectContact와 같은 계산을 out에 쓴다(할당 없음). 겹치면 true, 아니면 false(out 불변).
 */
export function circleRectContactInto(
  out: Contact,
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const right = rx + rw;
  const bottom = ry + rh;
  const qx = cx < rx ? rx : cx > right ? right : cx;
  const qy = cy < ry ? ry : cy > bottom ? bottom : cy;
  const dx = cx - qx;
  const dy = cy - qy;
  const d2 = dx * dx + dy * dy;

  if (d2 > 0) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    out.nx = dx / d;
    out.ny = dy / d;
    out.depth = r - d;
    return true;
  }

  // 중심이 안쪽: 가장 얕은 면으로 밀어낸다 (동률이면 위·아래 우선)
  let nx = 0;
  let ny = -1;
  let pen = cy - ry;
  const toBottom = bottom - cy;
  if (toBottom < pen) {
    ny = 1;
    pen = toBottom;
  }
  const toLeft = cx - rx;
  if (toLeft < pen) {
    nx = -1;
    ny = 0;
    pen = toLeft;
  }
  const toRight = right - cx;
  if (toRight < pen) {
    nx = 1;
    ny = 0;
    pen = toRight;
  }
  out.nx = nx;
  out.ny = ny;
  out.depth = pen + r;
  return true;
}

function aabbOverlap(p: ProjectileEntity, e: EnemyEntity): boolean {
  const r = p.radius;
  return p.x + r > e.x && p.x - r < e.x + e.w && p.y + r > e.y && p.y - r < e.y + e.h;
}

function centerInside(p: ProjectileEntity, e: EnemyEntity): boolean {
  return p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h;
}

function overlapsRect(cx: number, cy: number, r: number, e: EnemyEntity): boolean {
  const dx = cx - clamp(cx, e.x, e.x + e.w);
  const dy = cy - clamp(cy, e.y, e.y + e.h);
  return dx * dx + dy * dy < r * r;
}

/**
 * (sx,sy)→(cx,cy) 이동이 r만큼 넓힌 사각형에 들어온 면(슬랩 방식)을 out에 쓰고 true.
 * 시작점이 이미 안쪽이었으면 false, out 불변 (호출 측이 최소 침투 축으로 대체).
 */
function entryContactInto(
  out: Contact,
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  r: number,
  e: EnemyEntity,
): boolean {
  const minX = e.x - r;
  const maxX = e.x + e.w + r;
  const minY = e.y - r;
  const maxY = e.y + e.h + r;
  const dx = cx - sx;
  const dy = cy - sy;
  let tx = -Infinity;
  let ty = -Infinity;
  let fx = 0;
  let fy = 0;
  if (dx > 0) {
    tx = (minX - sx) / dx;
    fx = -1;
  } else if (dx < 0) {
    tx = (maxX - sx) / dx;
    fx = 1;
  }
  if (dy > 0) {
    ty = (minY - sy) / dy;
    fy = -1;
  } else if (dy < 0) {
    ty = (maxY - sy) / dy;
    fy = 1;
  }
  if (tx >= ty) {
    if (!(tx >= 0 && tx <= 1)) return false;
    out.nx = fx;
    out.ny = 0;
    out.depth = fx < 0 ? cx - minX : maxX - cx;
    return true;
  }
  if (!(ty >= 0 && ty <= 1)) return false;
  out.nx = 0;
  out.ny = fy;
  out.depth = fy < 0 ? cy - minY : maxY - cy;
  return true;
}

function segmentHitsCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  rr: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py < rr * rr;
}

function firstStatusElement(elements: readonly Element[]): Element | null {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el === 'fire' || el === 'ice') return el;
  }
  return null;
}

function retainAlive<T extends { alive: boolean }>(arr: T[]): void {
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x.alive) arr[w++] = x;
  }
  arr.length = w;
}
