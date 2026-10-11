// 투사체 밀도 규칙 (무기가 5종 넘게 모여도 필드가 투사체로 뒤덮이지 않게):
//  - 수명 상한: 무기로 쏜 투사체 PROJECTILE_MAX_AGE, 분열 자식 SPLIT_CHILD_MAX_AGE
//  - 무기 수치: 무기 하나가 내는 투사체 수(초당) 상한, 진화 무기의 시트 DPS 비율
//  - 핵심 재미 유지: 틈으로 들어간 공이 멀쩡한 대형 뒤에서 덜그럭거리며 여러 번 때린다 (수명 상한 안에서도)
// 실제 전투에서의 평균/최대 살아있는 투사체 수는 tests/balance.probe.test.ts가 표로 찍는다.
import { describe, expect, it } from 'vitest';
import {
  CELL,
  ENEMY_INSET,
  FIELD_COLS,
  FIELD_H,
  FIELD_W,
  PLAYER_START_Y,
  PROJECTILE_MAX_AGE,
  SIM_DT,
  SPLIT_CHILD_MAX_AGE,
} from '../src/config';
import { GAME_DATA } from '../src/data/index';
import { CombatSim, FIRE_OFFSET_Y, traceAim, type AimTrace } from '../src/logic/combat/sim';
import type { EnemyDef, ItemDef, PlayerStats, ProjectileEntity, StageDef, WeaponLoadout } from '../src/types';

const TOUGH_PLAYER: PlayerStats = { maxHp: 1e9, moveSpeed: 0, regenPerSec: 0, goldMul: 1, damageMul: 1, cooldownMul: 1 };

function testStage(rows: string[], legend: Record<string, string>, o: Partial<StageDef> = {}): StageDef {
  return { id: 'density', name: 'density', descentSpeed: 0, hpMul: 1, dmgMul: 1, clearGold: 0, rows, legend, background: 'bg_test', ...o };
}

// ── 수명 상한 ─────────────────────────────────────────────────

describe('투사체 수명 상한', () => {
  it('분열 자식은 부모보다 짧게 산다', () => {
    expect(SPLIT_CHILD_MAX_AGE).toBeGreaterThan(0);
    expect(SPLIT_CHILD_MAX_AGE).toBeLessThan(PROJECTILE_MAX_AGE);
  });

  it('무기로 쏜 공은 PROJECTILE_MAX_AGE, 분열 자식은 SPLIT_CHILD_MAX_AGE가 지나면 공중에서 사라진다', () => {
    // 2×2 적을 위쪽에 세워 두고 바로 위로 느리게 한 발: 관통 1로 적을 뚫으며 분열 → 자식 3개는 위로,
    // 부모는 적 위로 빠져나가 천장과 적 윗면 사이를 오간다 (둘 다 바닥으로 빠지지 않고 수명으로 끝난다)
    const big: EnemyDef = { id: 'big', name: 'big', sprite: 'e', w: 2, h: 2, hp: 1e6, gold: 0, dropChance: 0 };
    const weapon: WeaponLoadout = {
      uid: 1, defId: 'w_test', tier: 1, cooldown: 100, damage: 1, count: 1, spreadDeg: 0, speed: 200, radius: 8,
      pierce: 1, maxBounces: 0, elements: [], explodeRadius: 0,
      split: { count: 3, damageMul: 0.5, sprite: 'proj_child', radius: 6 }, sprite: 'proj_test', spin: false,
    };
    const sim = new CombatSim({
      stage: testStage(['...B....'], { B: 'big' }), stageIndex: 0, enemies: { big }, loadout: [weapon],
      player: TOUGH_PLAYER, hp: 1e9, seed: 1,
    });
    sim.enemies[0].y = 300; // x [256, 416] — 플레이어(x 336) 바로 위
    const input = { targetX: null, targetY: null, aimAngle: -Math.PI / 2 };

    const seen = new Map<number, ProjectileEntity>();
    const gone: ProjectileEntity[] = [];
    for (let i = 0; i < Math.ceil((PROJECTILE_MAX_AGE + 2) / SIM_DT); i++) {
      sim.step(SIM_DT, input);
      sim.drainEvents();
      for (const p of sim.projectiles) seen.set(p.id, p);
      for (const [id, p] of seen) {
        if (p.alive) continue;
        gone.push(p);
        seen.delete(id);
      }
    }
    const parents = gone.filter((p) => p.sprite === 'proj_test');
    const children = gone.filter((p) => p.sprite === 'proj_child');
    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(3);
    for (const [p, cap] of [...parents.map((p) => [p, PROJECTILE_MAX_AGE] as const), ...children.map((c) => [c, SPLIT_CHILD_MAX_AGE] as const)]) {
      expect(p.age, p.sprite).toBeGreaterThan(cap - 1e-9);
      expect(p.age, p.sprite).toBeLessThanOrEqual(cap + SIM_DT + 1e-9);
      expect(p.y - p.radius, `${p.sprite} 바닥이 아니라 공중에서`).toBeLessThan(FIELD_H);
    }
  });
});

// ── 무기 수치 ─────────────────────────────────────────────────

/** ★1 무기 하나가 초당 만드는 투사체 수 (분열 자식 포함) */
function launchRate(d: ItemDef): number {
  const w = d.weapon!;
  const p = w.projectile;
  return (p.count * (1 + (p.split?.count ?? 0))) / w.cooldown;
}

/** ★1 시트 DPS: 1발 데미지 × 발 수 × (1 + 분열 자식 몫) / 쿨타임 (속성·폭발·관통·반사 제외) */
function sheetDps(d: ItemDef): number {
  const w = d.weapon!;
  const p = w.projectile;
  return (p.damage * p.count * (1 + (p.split ? p.split.count * p.split.damageMul : 0))) / w.cooldown;
}

/** 무기 하나가 초당 만들 수 있는 투사체 수 상한 (★1, 돌 없이) */
const MAX_LAUNCH_RATE = 2.5;
/** 가장 빠른 ★1 쿨타임 */
const MIN_COOLDOWN = 0.7;

describe('무기 수치 (투사체 밀도)', () => {
  const weapons = Object.values(GAME_DATA.items).filter((d) => d.weapon);

  it.each(weapons.map((d) => [d.id, d] as const))('%s: 쿨타임 하한·초당 투사체 수 상한', (_id, d) => {
    expect(d.weapon!.cooldown).toBeGreaterThanOrEqual(MIN_COOLDOWN);
    expect(launchRate(d)).toBeLessThanOrEqual(MAX_LAUNCH_RATE);
  });

  it.each(GAME_DATA.recipes.map((r) => [r.id, r] as const))('%s: 진화 무기 시트 DPS는 base의 1.3~2.5배', (_id, r) => {
    const ratio = sheetDps(GAME_DATA.items[r.result]) / sheetDps(GAME_DATA.items[r.base]);
    expect(ratio).toBeGreaterThanOrEqual(1.3);
    expect(ratio).toBeLessThanOrEqual(2.5);
  });
});

// ── 핵심 재미: 틈으로 들어간 공 ───────────────────────────────

/** 멀쩡한 웨이브의 뒤쪽 끝(필드 y) — 뒤에 공이 튈 공간이 1줄 남짓 (data.test.ts 조준 검사와 같은 배치) */
const AIM_BACK_Y = 120;
/** 틈으로 쏘는 공: 털뭉치(시작 무기) 크기·속도 */
const BALL_R = 13;
const BALL_SPEED = 950;
/** 손가락 오차: 이 각도(±도) 안에서 전부 통과하는 조준만 '틈 쏘기'로 본다 */
const AIM_WINDOW_DEG = 1;
/** 비교용: 이번 조정 전 수명 상한 */
const OLD_MAX_AGE = 8;
/** 뒤로 들어간 공 하나가 뒤에서 때리는 평균 횟수 하한 */
const RATTLE_MIN = 3;
/** 수명을 줄여도 남아야 하는 덜그럭거림 비율 (OLD_MAX_AGE 대비) */
const RATTLE_KEEP = 0.8;

/** 칸마다 적이 있는가 (여러 칸 적은 덮는 칸 전부). 인덱스 = stage.rows */
function occupied(stage: StageDef): boolean[][] {
  const occ = stage.rows.map(() => new Array<boolean>(FIELD_COLS).fill(false));
  stage.rows.forEach((row, i) => {
    [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const d = GAME_DATA.enemies[stage.legend[ch]];
      for (let dy = 0; dy < d.h; dy++) for (let dx = 0; dx < d.w; dx++) occ[i + dy][c + dx] = true;
    });
  });
  return occ;
}

function wavesOf(stage: StageDef): [number, number][] {
  const occ = occupied(stage);
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= occ.length; i++) {
    const has = i < occ.length && occ[i].some(Boolean);
    if (has && start < 0) start = i;
    if (!has && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** 웨이브 rows[front..back]만 멀쩡한 채로 뒤쪽 끝이 AIM_BACK_Y에 오게 세워 둔 전투 (적은 죽지 않는다) */
function parkedWave(stage: StageDef, [front, back]: [number, number]): CombatSim {
  const sim = new CombatSim({
    stage: { ...stage, rows: stage.rows.slice(front, back + 1), descentSpeed: 0, hpMul: 1e6 },
    stageIndex: 0,
    enemies: GAME_DATA.enemies,
    loadout: [],
    player: TOUGH_PLAYER,
    hp: 1e9,
    seed: 1,
  });
  const dy = AIM_BACK_Y + (back - front + 1) * CELL;
  for (const e of sim.enemies) e.y += dy;
  return sim;
}

/**
 * 플레이어 x마다 조준 가이드(벽 반사 1번)가 ±AIM_WINDOW_DEG 안에서 전부 웨이브 뒤로 넘어가는 각도들 (1° 간격).
 * 가장 수직인 각도 하나만 고르면 곧은 통로를 똑바로 올라가 천장에서 같은 통로로 그대로 떨어지는 공(적중 0)만 재게 된다.
 */
function gapShots(sim: CombatSim, oy: number): { x: number; angle: number }[] {
  const out = new Float64Array(6);
  const res: AimTrace = { points: 0, hitId: -1 };
  const passes = (px: number, a: number): boolean => {
    traceAim(px, oy, a, BALL_R, sim.enemies, 1600, 2, out, res);
    for (let k = 1; k < res.points; k++) if (out[2 * k + 1] < AIM_BACK_Y - 1) return true;
    return false;
  };
  const STEP = 0.5;
  const w = Math.round(AIM_WINDOW_DEG / STEP);
  const shots: { x: number; angle: number }[] = [];
  for (let px = 40; px <= FIELD_W - 40; px += 32) {
    const ok: boolean[] = [];
    for (let deg = -172; deg <= -8; deg += STEP) ok.push(passes(px, (deg * Math.PI) / 180));
    for (let i = w; i < ok.length - w; i += 2) {
      let all = true;
      for (let k = i - w; k <= i + w && all; k++) all = ok[k];
      if (all) shots.push({ x: px, angle: ((-172 + i * STEP) * Math.PI) / 180 });
    }
  }
  return shots;
}

interface Rattle {
  /** 사라질 때까지 직접 적중 수 */
  hits: number;
  /** 그중 웨이브 뒤(공 중심이 뒤쪽 끝보다 위)에서 */
  behind: number;
  /** 수명으로 사라졌는가 (바닥으로 빠지지 않고) */
  expired: boolean;
}

let nextBallId = 1_000_000;

/** 공 하나를 넣고 사라질 때까지. maxAge를 주면 sim 내부 수명 상한을 그 값으로 바꿔 비교한다 */
function rattle(sim: CombatSim, x: number, y: number, angle: number, maxAge?: number): Rattle {
  const p: ProjectileEntity & { maxAge?: number } = {
    id: nextBallId++, weaponUid: 0, x, y,
    vx: Math.cos(angle) * BALL_SPEED, vy: Math.sin(angle) * BALL_SPEED, radius: BALL_R, damage: 1,
    pierceLeft: 0, bouncesLeft: Infinity, elements: [], explodeRadius: 0, split: null, sprite: 'proj_test',
    spin: false, age: 0, alive: true,
  };
  if (maxAge !== undefined) p.maxAge = maxAge;
  sim.projectiles.push(p);
  sim.drainEvents();
  const r: Rattle = { hits: 0, behind: 0, expired: false };
  const idle = { targetX: null, targetY: null };
  for (let i = 0; i < Math.ceil(OLD_MAX_AGE / SIM_DT) + 2 && p.alive; i++) {
    sim.step(SIM_DT, idle);
    for (const ev of sim.drainEvents()) {
      if (ev.type !== 'hit') continue;
      r.hits++;
      if (p.y < AIM_BACK_Y + ENEMY_INSET) r.behind++;
    }
  }
  r.expired = !p.alive && p.y - p.radius <= FIELD_H;
  return r;
}

const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

describe('틈으로 들어간 공 (멀쩡한 웨이브, 정지)', () => {
  it('틈 쏘기 공 중 뒤로 들어간 공은 수명 상한 안에서도 웨이브 뒤에서 여러 번 때린다', () => {
    // 플레이어 시작 높이의 발사점에서, 웨이브마다 (플레이어 x × 틈 각도)로 한 발씩. 같은 궤적을 예전 수명(8초)으로도 돌려 비교
    const oy = PLAYER_START_Y - FIRE_OFFSET_Y;
    const rows: { id: string; wave: string; shots: number; now: Rattle[]; old: Rattle[] }[] = [];
    for (const stage of GAME_DATA.stages) {
      for (const w of wavesOf(stage)) {
        const sim = parkedWave(stage, w);
        const shots = gapShots(sim, oy);
        const now = shots.map((s) => rattle(sim, s.x, oy, s.angle));
        const old = shots.map((s) => rattle(sim, s.x, oy, s.angle, OLD_MAX_AGE));
        rows.push({ id: stage.id, wave: `rows[${w[0]}..${w[1]}]`, shots: shots.length, now, old });
      }
    }
    /** 뒤에서 한 번이라도 때린 공 = 틈으로 들어가 덜그럭거린 공. 똑바로 올라가 같은 통로로 그대로 떨어지는 공은 빠진다 */
    const rattlers = (rs: Rattle[]): Rattle[] => rs.filter((x) => x.behind > 0);
    const lines = rows.map((r) => {
      const now = rattlers(r.now);
      const old = rattlers(r.old);
      return (
        `  ${r.id} ${r.wave.padEnd(12)} shots ${String(r.shots).padStart(2)}  got behind ${String(Math.round((100 * now.length) / Math.max(1, r.shots))).padStart(3)}%` +
        `  behind hits per ball ${mean(now.map((x) => x.behind)).toFixed(1).padStart(5)} (${OLD_MAX_AGE}s cap: ${mean(old.map((x) => x.behind)).toFixed(1).padStart(5)})` +
        `  ended by lifetime ${String(Math.round(100 * mean(now.map((x) => (x.expired ? 1 : 0))))).padStart(3)}%`
      );
    });
    const all = rattlers(rows.flatMap((r) => r.now));
    const allOld = rattlers(rows.flatMap((r) => r.old));
    const shots = rows.reduce((n, r) => n + r.shots, 0);
    const now = mean(all.map((x) => x.behind));
    const old = mean(allOld.map((x) => x.behind));
    console.log(
      `\n[density] gap shots (guide passes the wave within ±${AIM_WINDOW_DEG}°, every 1°) into intact parked waves, back edge at y=${AIM_BACK_Y};` +
        ` ball r${BALL_R} @${BALL_SPEED}px/s, lifetime ${PROJECTILE_MAX_AGE}s (vs ${OLD_MAX_AGE}s)\n` +
        lines.join('\n') +
        `\n  overall: ${Math.round((100 * all.length) / shots)}% of ${shots} gap shots got behind; those hit ${now.toFixed(1)} times from behind` +
        ` (${OLD_MAX_AGE}s cap: ${old.toFixed(1)}), ${Math.round(100 * mean(all.map((x) => (x.expired ? 1 : 0))))}% ended by lifetime\n`,
    );
    // 모든 웨이브에 노릴 수 있는 틈이 있다 (data.test.ts의 레벨 디자인 린트와 같은 조건)
    for (const r of rows) expect(r.shots, `${r.id} ${r.wave}`).toBeGreaterThan(0);
    // 뒤로 들어간 공은 평균 RATTLE_MIN번 이상 뒤에서 때리고, 수명을 줄여도 예전(8초)의 RATTLE_KEEP 이상이 남는다
    expect(now).toBeGreaterThanOrEqual(RATTLE_MIN);
    expect(now).toBeGreaterThanOrEqual(RATTLE_KEEP * old);
  });
});
