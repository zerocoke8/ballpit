import { describe, expect, it } from 'vitest';
import { BAG_START_COLS, BAG_START_ROWS, CELL, ENEMY_INSET, FIELD_COLS, PLAYER_MAX_X, PLAYER_MIN_X, PLAYER_START_Y } from '../src/config';
import { ASSETS, ASSET_MAP, GAME_DATA } from '../src/data';
import { FIRE_OFFSET_Y, traceAim, type AimTrace } from '../src/logic/combat/sim';
import type { Cell, EnemyDef, EnemyEntity, ItemDef, Rarity, Rot, StageDef, StartItem } from '../src/types';

const { items, recipes, enemies, stages, characters } = GAME_DATA;
const itemList = Object.values(items);
const weaponList = itemList.filter((d) => d.kind === 'weapon');

// ── 기하 헬퍼: ARCHITECTURE.md의 bag.ts 계약과 같은 규칙 (bag.ts에 의존하지 않음) ──

function footprint(def: ItemDef, rot: Rot): { w: number; h: number } {
  return rot % 2 === 1 ? { w: def.h, h: def.w } : { w: def.w, h: def.h };
}

/** 시계방향 1회: (x, y) → (h-1-y, x), 이후 w/h 교환 */
function rotateLocalCell(c: Cell, w: number, h: number, rot: Rot): Cell {
  let { x, y } = c;
  let cw = w;
  let ch = h;
  for (let i = 0; i < rot; i++) {
    [x, y] = [ch - 1 - y, x];
    [cw, ch] = [ch, cw];
  }
  return { x, y };
}

function localCells(w: number, h: number): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ x, y });
  return out;
}

function placedCells(si: StartItem, def: ItemDef): Cell[] {
  const { w, h } = footprint(def, si.rot);
  return localCells(w, h).map((c) => ({ x: si.x + c.x, y: si.y + c.y }));
}

function placedSockets(si: StartItem, def: ItemDef): Cell[] {
  return (def.sockets ?? []).map((s) => {
    const r = rotateLocalCell(s, def.w, def.h, si.rot);
    return { x: si.x + r.x, y: si.y + r.y };
  });
}

const cellKey = (c: Cell): string => `${c.x},${c.y}`;
const touches = (a: Cell, b: Cell): boolean => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const edgeAdjacent = (a: Cell[], b: Cell[]): boolean => a.some((p) => b.some((q) => touches(p, q)));

const isPosInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;
const isPos = (n: number): boolean => Number.isFinite(n) && n > 0;

// ─────────────────────────────────────────────────────────────

describe('에셋 참조', () => {
  it('assets.json 키가 중복되지 않는다', () => {
    expect(new Set(ASSETS.map((a) => a.key)).size).toBe(ASSETS.length);
    expect(Object.keys(ASSET_MAP).length).toBe(ASSETS.length);
  });

  it('데이터가 참조하는 모든 에셋 키가 assets.json에 있다', () => {
    const refs: [string, string][] = [];
    for (const d of itemList) {
      refs.push([`item ${d.id}.icon`, d.icon]);
      const p = d.weapon?.projectile;
      if (p) {
        refs.push([`item ${d.id}.projectile.sprite`, p.sprite]);
        if (p.split) refs.push([`item ${d.id}.projectile.split.sprite`, p.split.sprite]);
      }
    }
    for (const e of Object.values(enemies)) {
      refs.push([`enemy ${e.id}.sprite`, e.sprite]);
      if (e.attack) refs.push([`enemy ${e.id}.attack.sprite`, e.attack.sprite]);
    }
    for (const c of Object.values(characters)) {
      refs.push([`character ${c.id}.sprite`, c.sprite]);
      refs.push([`character ${c.id}.portrait`, c.portrait]);
    }
    for (const s of stages) refs.push([`stage ${s.id}.background`, s.background]);

    const missing = refs.filter(([, key]) => !ASSET_MAP[key]).map(([where, key]) => `${where} → ${key}`);
    expect(missing).toEqual([]);
  });
});

describe('아이템', () => {
  it('레코드 키와 id가 같다', () => {
    for (const [k, d] of Object.entries(items)) expect(d.id, k).toBe(k);
  });

  it('종류별 효과 필드가 정확히 하나 있다', () => {
    for (const d of itemList) {
      expect(!!d.weapon, `${d.id}.weapon`).toBe(d.kind === 'weapon');
      expect(!!d.stone, `${d.id}.stone`).toBe(d.kind === 'stone');
      expect(!!d.gear, `${d.id}.gear`).toBe(d.kind === 'gear');
    }
  });

  it('크기·가격·상점 필드가 유효하다', () => {
    for (const d of itemList) {
      expect(isPosInt(d.w) && isPosInt(d.h), `${d.id} 크기`).toBe(true);
      expect(isPosInt(d.price), `${d.id}.price`).toBe(true);
      expect(isNonNegInt(d.shopWeight), `${d.id}.shopWeight`).toBe(true);
      expect(isNonNegInt(d.minStage), `${d.id}.minStage`).toBe(true);
      expect(d.name.length > 0 && d.desc.length > 0, `${d.id} 이름/설명`).toBe(true);
    }
  });

  it('무기 수치가 양수다', () => {
    for (const d of weaponList) {
      const w = d.weapon!;
      const p = w.projectile;
      const ctx = d.id;
      expect(isPos(w.cooldown), `${ctx}.cooldown`).toBe(true);
      expect(isPos(p.radius), `${ctx}.radius`).toBe(true);
      expect(isPos(p.speed), `${ctx}.speed`).toBe(true);
      expect(isPos(p.damage), `${ctx}.damage`).toBe(true);
      expect(isPosInt(p.count), `${ctx}.count`).toBe(true);
      expect(p.spreadDeg >= 0, `${ctx}.spreadDeg`).toBe(true);
      if (p.count > 1) expect(p.spreadDeg > 0, `${ctx} 다발은 부채꼴 필요`).toBe(true);
      expect(isNonNegInt(p.pierce), `${ctx}.pierce`).toBe(true);
      expect(isNonNegInt(p.maxBounces), `${ctx}.maxBounces`).toBe(true);
      if (p.explodeRadius !== undefined) expect(isPos(p.explodeRadius), `${ctx}.explodeRadius`).toBe(true);
      if (p.split) {
        expect(isPosInt(p.split.count), `${ctx}.split.count`).toBe(true);
        expect(isPos(p.split.damageMul), `${ctx}.split.damageMul`).toBe(true);
        expect(isPos(p.split.radius), `${ctx}.split.radius`).toBe(true);
      }
    }
  });

  it('돌·장비 효과가 비어 있지 않고 유한하다', () => {
    for (const d of itemList) {
      const eff = d.stone ?? d.gear;
      if (!eff) continue;
      const entries = Object.entries(eff);
      expect(entries.length, `${d.id} 효과`).toBeGreaterThan(0);
      for (const [k, v] of entries) {
        if (k === 'element') continue;
        expect(Number.isFinite(v) && v !== 0, `${d.id}.${k}`).toBe(true);
      }
    }
  });

  it('소켓은 아이템 바깥이면서 변으로 맞닿은 칸이다', () => {
    for (const d of itemList) {
      if (!d.sockets) continue;
      const body = localCells(d.w, d.h);
      const bodyKeys = new Set(body.map(cellKey));
      expect(new Set(d.sockets.map(cellKey)).size, `${d.id} 소켓 중복`).toBe(d.sockets.length);
      for (const s of d.sockets) {
        expect(bodyKeys.has(cellKey(s)), `${d.id} 소켓 ${cellKey(s)}이 몸통 안`).toBe(false);
        expect(edgeAdjacent([s], body), `${d.id} 소켓 ${cellKey(s)}이 인접하지 않음`).toBe(true);
      }
    }
  });

  it('상점에 나오는 아이템이 희귀도별로 있다', () => {
    const eligible = (r: Rarity, stage: number): ItemDef[] =>
      itemList.filter((d) => d.rarity === r && d.shopWeight > 0 && d.minStage <= stage);
    expect(eligible('common', 0).length).toBeGreaterThan(0);
    expect(eligible('rare', stages.length - 1).length).toBeGreaterThan(0);
    expect(eligible('epic', stages.length - 1).length).toBeGreaterThan(0);
    // 첫 상점(스테이지 0)에서도 무기를 살 수 있다
    expect(weaponList.some((d) => d.shopWeight > 0 && d.minStage === 0)).toBe(true);
  });
});

describe('레시피', () => {
  it('id·(base, ingredient) 조합이 중복되지 않는다', () => {
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
    expect(new Set(recipes.map((r) => `${r.base}+${r.ingredient}`)).size).toBe(recipes.length);
  });

  it('존재하는 아이템을 참조하고 base는 소켓 있는 무기, result는 같은 크기의 상점 비노출 무기', () => {
    for (const r of recipes) {
      const base = items[r.base];
      const ing = items[r.ingredient];
      const res = items[r.result];
      expect(base, `${r.id}.base`).toBeDefined();
      expect(ing, `${r.id}.ingredient`).toBeDefined();
      expect(res, `${r.id}.result`).toBeDefined();
      expect(base.kind, `${r.id} base 종류`).toBe('weapon');
      expect(base.sockets?.length ?? 0, `${r.id} base 소켓`).toBeGreaterThan(0);
      expect(res.kind, `${r.id} result 종류`).toBe('weapon');
      expect([res.w, res.h], `${r.id} result 크기`).toEqual([base.w, base.h]);
      expect(res.shopWeight, `${r.id} result shopWeight`).toBe(0);
      expect(r.result, `${r.id} 자기 자신으로 진화`).not.toBe(r.base);
    }
  });

  it('레시피 base 무기는 소켓이 1~2개다', () => {
    for (const id of new Set(recipes.map((r) => r.base))) {
      const n = items[id].sockets?.length ?? 0;
      expect(n >= 1 && n <= 2, `${id} 소켓 ${n}개`).toBe(true);
    }
  });

  it('상점에 안 나오는 무기는 레시피로 얻을 수 있다', () => {
    const results = new Set(recipes.map((r) => r.result));
    for (const d of weaponList) if (d.shopWeight === 0) expect(results.has(d.id), d.id).toBe(true);
  });
});

describe('적', () => {
  it('레코드 키와 id가 같고 수치가 유효하다', () => {
    for (const [k, e] of Object.entries(enemies)) {
      expect(e.id, k).toBe(k);
      expect(isPosInt(e.w) && isPosInt(e.h) && e.w <= FIELD_COLS, `${k} 크기`).toBe(true);
      expect(isPos(e.hp), `${k}.hp`).toBe(true);
      // 소수 골드 허용: rewardKill이 floor + 소수 부분 확률로 지급 (0도 가능)
      expect(Number.isFinite(e.gold) && e.gold >= 0, `${k}.gold`).toBe(true);
      expect(e.dropChance >= 0 && e.dropChance <= 1, `${k}.dropChance`).toBe(true);
      // 접촉은 즉시 패배라 적마다 접촉 피해 수치를 두지 않는다 (옛 필드가 데이터에 남아 있지 않게)
      expect('contactDamage' in e, `${k}.contactDamage`).toBe(false);
      const a = e.attack;
      if (!a) continue;
      expect(isPos(a.interval), `${k}.attack.interval`).toBe(true);
      expect(a.jitter >= 0, `${k}.attack.jitter`).toBe(true);
      expect(isPos(a.projSpeed), `${k}.attack.projSpeed`).toBe(true);
      expect(isPos(a.damage), `${k}.attack.damage`).toBe(true);
      expect(isPosInt(a.count), `${k}.attack.count`).toBe(true);
      expect(a.spreadDeg >= 0, `${k}.attack.spreadDeg`).toBe(true);
      expect(isPos(a.radius), `${k}.attack.radius`).toBe(true);
      if (a.kind === 'spread') expect(a.count > 1 && a.spreadDeg > 0, `${k} spread`).toBe(true);
    }
  });
});

/** 스테이지 배치 오류 목록 (없으면 빈 배열) */
function stageErrors(stage: StageDef): string[] {
  const errors: string[] = [];
  const occupied = new Map<string, string>();
  for (const [ch, id] of Object.entries(stage.legend)) {
    if (ch.length !== 1 || ch === '.') errors.push(`legend 문자 '${ch}'`);
    if (!enemies[id]) errors.push(`legend '${ch}' → 없는 적 ${id}`);
  }
  stage.rows.forEach((row, i) => {
    if (row.length !== FIELD_COLS) errors.push(`rows[${i}] 길이 ${row.length}`);
  });
  stage.rows.forEach((row, i) => {
    [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const def = enemies[stage.legend[ch]];
      if (!def) {
        errors.push(`rows[${i}][${c}] '${ch}'이 legend에 없음`);
        return;
      }
      if (c + def.w > FIELD_COLS || i + def.h > stage.rows.length) {
        errors.push(`rows[${i}][${c}] ${def.id}가 범위를 벗어남`);
        return;
      }
      for (let dy = 0; dy < def.h; dy++) {
        for (let dx = 0; dx < def.w; dx++) {
          const r = i + dy;
          const cc = c + dx;
          if ((dx || dy) && stage.rows[r][cc] !== '.') errors.push(`rows[${r}][${cc}]는 ${def.id}에 덮여 '.'이어야 함`);
          const k = `${r},${cc}`;
          const prev = occupied.get(k);
          if (prev) errors.push(`rows[${r}][${cc}] ${prev}와 ${def.id}가 겹침`);
          occupied.set(k, def.id);
        }
      }
    });
  });
  return errors;
}

describe('스테이지', () => {
  it('id가 중복되지 않고 수치가 유효하다', () => {
    expect(new Set(stages.map((s) => s.id)).size).toBe(stages.length);
    for (const s of stages) {
      expect(isPos(s.descentSpeed), `${s.id}.descentSpeed`).toBe(true);
      expect(isPos(s.hpMul), `${s.id}.hpMul`).toBe(true);
      expect(isPos(s.dmgMul), `${s.id}.dmgMul`).toBe(true);
      expect(isNonNegInt(s.clearGold), `${s.id}.clearGold`).toBe(true);
      expect(s.rows.length, `${s.id} 줄 수`).toBeGreaterThan(0);
    }
  });

  it.each(stages.map((s) => [s.id, s] as const))('%s 배치가 올바르다', (_id, stage) => {
    expect(stageErrors(stage)).toEqual([]);
    expect(stage.rows.some((r) => /[^.]/.test(r)), '적이 하나 이상').toBe(true);
  });

  it('마지막 스테이지에 보스가 있다', () => {
    const last = stages[stages.length - 1];
    const chars = new Set(last.rows.join('').replace(/\./g, ''));
    expect([...chars].some((ch) => enemies[last.legend[ch]]?.boss)).toBe(true);
  });

  it('검증기가 겹침과 덮인 칸 오류를 잡아낸다', () => {
    const base = stages[0];
    const bad: StageDef = { ...base, legend: { s: 'soldier', T: 'teddy' }, rows: ['.T.....s', '..s.....'] };
    expect(stageErrors(bad).length).toBeGreaterThan(0);
    const out: StageDef = { ...base, legend: { T: 'teddy' }, rows: ['.......T', '........'] };
    expect(stageErrors(out).length).toBeGreaterThan(0);
  });
});

// ── 레벨 디자인 린트: 벽돌깨기식 대형 (src/data/stages.ts 머리 주석의 규칙) ──

type Occ = (EnemyDef | null)[][];

/** 칸마다 차지한 적 (여러 칸 적은 덮는 칸 전부). 인덱스는 stage.rows와 같다 (0 = 맨 앞줄) */
function occupancy(stage: StageDef): Occ {
  const occ: Occ = stage.rows.map(() => new Array<EnemyDef | null>(FIELD_COLS).fill(null));
  stage.rows.forEach((row, i) => {
    [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const def = enemies[stage.legend[ch]];
      for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) occ[i + dy][c + dx] = def;
    });
  });
  return occ;
}

const filled = (row: (EnemyDef | null)[]): number => row.filter((e) => e !== null).length;

/** 연속된 비어 있지 않은 줄 묶음 = 웨이브. [앞줄, 뒷줄] (포함) */
function wavesOf(occ: Occ): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= occ.length; i++) {
    const has = i < occ.length && filled(occ[i]) > 0;
    if (has && start < 0) start = i;
    if (!has && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** 웨이브 안 빈칸을 앞(아래)·뒤(위)에서 4방향으로 채워 본다. 공(반경 ≤ 30)은 빈칸(92px 틈)을 지나갈 수 있다 */
function channels(occ: Occ, [front, back]: [number, number]): { through: boolean; enclosed: number } {
  const flood = (srcRow: number): Set<number> => {
    const seen = new Set<number>();
    const q: [number, number][] = [];
    for (let c = 0; c < FIELD_COLS; c++) {
      if (occ[srcRow][c] === null) {
        seen.add(srcRow * FIELD_COLS + c);
        q.push([srcRow, c]);
      }
    }
    while (q.length > 0) {
      const [i, c] = q.pop()!;
      for (const [di, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nc = c + dc;
        if (ni < front || ni > back || nc < 0 || nc >= FIELD_COLS || occ[ni][nc] !== null) continue;
        const k = ni * FIELD_COLS + nc;
        if (!seen.has(k)) {
          seen.add(k);
          q.push([ni, nc]);
        }
      }
    }
    return seen;
  };
  const fromFront = flood(front);
  const fromBack = flood(back);
  let through = false;
  let enclosed = 0;
  for (let i = front; i <= back; i++) {
    for (let c = 0; c < FIELD_COLS; c++) {
      if (occ[i][c] !== null) continue;
      const k = i * FIELD_COLS + c;
      if (fromFront.has(k) && fromBack.has(k)) through = true;
      if (!fromFront.has(k) && !fromBack.has(k)) enclosed++;
    }
  }
  return { through, enclosed };
}

/** 조준 가능성 검사: 멀쩡한 웨이브의 뒤쪽 끝을 이 높이(필드 y)에 두면 뒤에 공이 튈 공간이 1줄 남짓 생긴다 */
const AIM_BACK_Y = 120;
/** 검사하는 공 반경 (냉동 생선 = 시작 무기 중 가장 큰 공) */
const AIM_BALL_R = 16;
/** 손가락 오차: 이 각도(±도) 안에서 전부 통과해야 '노릴 수 있다' */
const AIM_WINDOW_DEG = 1;

/** 웨이브 rows[front..back]을 멀쩡한 채로 뒤쪽 끝이 AIM_BACK_Y에 오게 놓은 적들 (sim의 배치 규칙과 같음) */
function intactWave(stage: StageDef, [front, back]: [number, number]): EnemyEntity[] {
  const es: EnemyEntity[] = [];
  for (let i = front; i <= back; i++) {
    [...stage.rows[i]].forEach((ch, c) => {
      if (ch === '.') return;
      const d = enemies[stage.legend[ch]];
      const top = -(i + d.h) * CELL + AIM_BACK_Y + (back + 1) * CELL;
      es.push({
        id: es.length + 1, defId: d.id, x: c * CELL + ENEMY_INSET, y: top + ENEMY_INSET,
        w: d.w * CELL - 2 * ENEMY_INSET, h: d.h * CELL - 2 * ENEMY_INSET, hp: 1, maxHp: 1, alive: true,
        boss: !!d.boss, burnDps: 0, burnTime: 0, chillTime: 0, attackTimer: 0, flash: 0,
      });
    });
  }
  return es;
}

/**
 * 플레이어 x 위치들 중 '틈으로 노릴 수 있는' 곳의 비율: 조준 가이드(traceAim, 벽 반사 1번)가 ±AIM_WINDOW_DEG 안의
 * 모든 각도에서 웨이브 뒤쪽 끝을 넘어가거나(뒤 공간으로 들어감) 뒷줄 윗면에서 멈춘다.
 */
function aimableShare(es: EnemyEntity[]): number {
  const out = new Float64Array(6);
  const res: AimTrace = { points: 0, hitId: -1 };
  const oy = PLAYER_START_Y - FIRE_OFFSET_Y; // 시작 높이의 발사점
  const passes = (px: number, a: number): boolean => {
    traceAim(px, oy, a, AIM_BALL_R, es, 1600, 2, out, res);
    for (let k = 1; k < res.points; k++) if (out[2 * k + 1] < AIM_BACK_Y - 1) return true;
    return res.hitId >= 0 && out[2 * (res.points - 1) + 1] <= AIM_BACK_Y + ENEMY_INSET + 0.5;
  };
  const STEP = 0.5;
  const w = Math.round(AIM_WINDOW_DEG / STEP);
  let ok = 0;
  let n = 0;
  for (let px = 40; px <= FIELD_COLS * CELL - 40; px += 16) {
    n++;
    const f: boolean[] = [];
    for (let deg = -172; deg <= -8; deg += STEP) f.push(passes(px, (deg * Math.PI) / 180));
    let run = 0;
    for (const v of f) {
      run = v ? run + 1 : 0;
      if (run >= 2 * w + 1) {
        ok++;
        break;
      }
    }
  }
  return ok / n;
}

const isAttacker = (e: EnemyDef): boolean => !!e.attack && !e.boss && e.w * e.h === 1;
const isElite = (e: EnemyDef): boolean => !e.boss && e.w * e.h > 1;

/** 스테이지 안의 적 (좌하단 칸 기준) */
function placed(stage: StageDef): { def: EnemyDef; row: number; col: number }[] {
  const out: { def: EnemyDef; row: number; col: number }[] = [];
  stage.rows.forEach((row, i) => {
    [...row].forEach((ch, c) => {
      if (ch !== '.') out.push({ def: enemies[stage.legend[ch]], row: i, col: c });
    });
  });
  return out;
}

describe('레벨 디자인 (벽돌깨기 대형)', () => {
  const each = stages.map((s, i) => [s.id, s, i] as const);

  it.each(each)('%s: 모든 줄에 빈칸이 1칸 이상 (공이 비집고 들어갈 틈)', (_id, stage) => {
    const occ = occupancy(stage);
    const full = occ.map((r, i) => (filled(r) >= FIELD_COLS ? i : -1)).filter((i) => i >= 0);
    expect(full, '꽉 찬 줄').toEqual([]);
  });

  it.each(each)('%s: 웨이브 3~5개, 웨이브마다 3~7줄, 웨이브 사이 빈 줄 3~4개', (_id, stage) => {
    const occ = occupancy(stage);
    const waves = wavesOf(occ);
    expect(waves.length >= 3 && waves.length <= 5, `웨이브 ${waves.length}개`).toBe(true);
    for (const [a, b] of waves) expect(b - a + 1 >= 3 && b - a + 1 <= 7, `rows[${a}..${b}] 높이`).toBe(true);
    for (let w = 1; w < waves.length; w++) {
      const gap = waves[w][0] - waves[w - 1][1] - 1;
      expect(gap >= 3 && gap <= 4, `웨이브 ${w}→${w + 1} 사이 빈 줄 ${gap}`).toBe(true);
    }
    // 앞뒤로 남는 빈 줄 없음 (첫 줄부터 바로 등장, 마지막 줄이 마지막 적)
    expect(waves[0][0], '맨 앞 빈 줄').toBe(0);
    expect(waves[waves.length - 1][1], '맨 뒤 빈 줄').toBe(stage.rows.length - 1);
  });

  it.each(each)('%s: 빽빽하다 — 보스가 없는 줄은 5칸 이상, 그중 80% 이상이 6~7칸', (_id, stage) => {
    const rows = occupancy(stage).filter((r) => filled(r) > 0 && !r.some((e) => e?.boss));
    for (const r of rows) expect(filled(r), '5칸 미만 줄').toBeGreaterThanOrEqual(5);
    const dense = rows.filter((r) => filled(r) >= 6).length;
    expect(dense / rows.length).toBeGreaterThanOrEqual(0.8);
  });

  it.each(each)('%s: 웨이브마다 앞에서 뒤까지 뚫린 통로가 있고, 어디서도 닿지 않는 막힌 구멍이 없다', (_id, stage) => {
    const occ = occupancy(stage);
    for (const w of wavesOf(occ)) {
      const { through, enclosed } = channels(occ, w);
      expect(through, `rows[${w[0]}..${w[1]}] 관통 통로`).toBe(true);
      expect(enclosed, `rows[${w[0]}..${w[1]}] 막힌 빈칸`).toBe(0);
    }
  });

  it.each(each)('%s: 웨이브마다 조준 가이드로 노릴 수 있는 틈이 있다 (멀쩡한 웨이브, 플레이어 위치의 10% 이상에서 ±1°)', (_id, stage) => {
    // 1칸 지그재그·좁아지는 균열은 직선이 못 지나가서 운으로만 뒤로 들어간다 — 곧은 통로·2칸 폭 45° 균열·벽 통로가 필요
    const occ = occupancy(stage);
    for (const w of wavesOf(occ)) {
      expect(aimableShare(intactWave(stage, w)), `rows[${w[0]}..${w[1]}]`).toBeGreaterThanOrEqual(0.1);
    }
  });

  it.each(each)('%s: 공격형(1칸, 공격 있음) 비율 상한 — 첫 스테이지 8% → 마지막 15%', (_id, stage, i) => {
    const all = placed(stage);
    const attackers = all.filter((p) => isAttacker(p.def)).length;
    const cap = 0.08 + ((0.15 - 0.08) * i) / Math.max(1, stages.length - 1);
    expect(attackers / all.length, `${attackers}/${all.length}`).toBeLessThanOrEqual(cap + 1e-9);
  });

  it.each(each)('%s: 공격형이 웨이브 맨 뒷줄에만 몰려 있지 않다 (절반 이하)', (_id, stage) => {
    const waves = wavesOf(occupancy(stage));
    const attackers = placed(stage).filter((p) => isAttacker(p.def));
    const backRow = attackers.filter((p) => waves.some(([, b]) => p.row === b)).length;
    expect(backRow, `${backRow}/${attackers.length}`).toBeLessThanOrEqual(attackers.length / 2);
  });

  it('엘리트(곰인형 등 여러 칸, 보스 아님)는 세 번째 스테이지부터', () => {
    stages.forEach((s, i) => {
      if (i < 2) expect(placed(s).filter((p) => isElite(p.def)).map((p) => p.def.id), s.id).toEqual([]);
    });
    expect(stages.slice(2).every((s) => placed(s).some((p) => isElite(p.def)))).toBe(true);
  });

  it('보스는 마지막 스테이지의 마지막 웨이브에만, 보스가 있는 줄은 양옆에 2칸 이상 비어 있다', () => {
    stages.forEach((s, i) => {
      const occ = occupancy(s);
      const bosses = placed(s).filter((p) => p.def.boss);
      if (i < stages.length - 1) {
        expect(bosses, s.id).toEqual([]);
        return;
      }
      expect(bosses.length).toBe(1);
      const last = wavesOf(occ).at(-1)!;
      const b = bosses[0];
      expect(b.row >= last[0] && b.row + b.def.h - 1 <= last[1], '보스가 마지막 웨이브 안').toBe(true);
      for (let r = b.row; r < b.row + b.def.h; r++) {
        expect(FIELD_COLS - filled(occ[r]), `rows[${r}] 보스 옆 빈칸`).toBeGreaterThanOrEqual(2);
      }
    });
  });

  it('린트가 꽉 찬 줄·막힌 구멍·관통 없는 웨이브를 잡아낸다', () => {
    const base = stages[0];
    const mk = (rows: string[]): StageDef => ({ ...base, legend: { s: 'soldier' }, rows: [...rows].reverse() });
    // 위 → 아래로 적음. 가운데 줄은 꽉 참, 빈칸 (1,0)은 사방이 막힘
    const bad = mk(['ss.sssss', 'ssssssss', 's.ssssss']);
    expect(occupancy(bad).some((r) => filled(r) === FIELD_COLS)).toBe(true);
    expect(channels(occupancy(bad), [0, 2]).through).toBe(false);
    const hole = mk(['sss.ssss', 'ss.s.sss', 'sss.ssss']);
    // 가운데 줄의 빈칸 두 개는 위·아래·옆이 모두 적이라 어디서도 닿지 않는다 (대각선으로만 이웃)
    expect(channels(occupancy(hole), [0, 2]).enclosed).toBeGreaterThan(0);
    const ok = mk(['ss.sssss', 'ss..ssss', 'sss.ssss']);
    expect(channels(occupancy(ok), [0, 2])).toEqual({ through: true, enclosed: 0 });
    // 1칸 지그재그는 4방향으로는 뚫려 있어도 직선(조준 가이드)으로는 못 지나간다 / 같은 칸의 곧은 통로는 지나간다
    const zigzag = mk(['sss.ssss', 'ss..ssss', 'ss.sssss', 'ss..ssss', 'sss.ssss']);
    expect(channels(occupancy(zigzag), [0, 4]).through).toBe(true);
    expect(aimableShare(intactWave(zigzag, [0, 4]))).toBe(0);
    const spine = mk(['sss.ssss', 'ss..ssss', 'sss.ssss', 'ss..ssss', 'sss.ssss']);
    expect(aimableShare(intactWave(spine, [0, 4]))).toBeGreaterThanOrEqual(0.1);
  });
});

describe('캐릭터', () => {
  const startBag = (si: StartItem[]) => si.map((s) => ({ si: s, def: items[s.defId] }));

  it('레코드 키와 id가 같고 수치가 유효하다', () => {
    for (const [k, c] of Object.entries(characters)) {
      expect(c.id, k).toBe(k);
      expect(isPos(c.baseMaxHp), `${k}.baseMaxHp`).toBe(true);
      expect(isPos(c.baseMoveSpeed), `${k}.baseMoveSpeed`).toBe(true);
      expect(c.startItems.length, `${k} 시작 아이템`).toBeGreaterThan(0);
    }
  });

  it("이동 속도는 '걷기': 패시브까지 넣어도 필드 이동 범위를 1초 넘게 걸려 가로지른다", () => {
    // 예전 900 px/s는 손가락을 거의 그대로 따라가 '휙휙' 움직였다 (사용자 피드백) — 380~460 띠에서 손맛으로 고른다
    const width = PLAYER_MAX_X - PLAYER_MIN_X;
    for (const [k, c] of Object.entries(characters)) {
      expect(c.baseMoveSpeed, `${k}.baseMoveSpeed`).toBeGreaterThanOrEqual(380);
      expect(c.baseMoveSpeed, `${k}.baseMoveSpeed`).toBeLessThanOrEqual(460);
      const speed = c.baseMoveSpeed * (1 + (c.passive.moveSpeedMul ?? 0));
      expect(width / speed, `${k} 가로지르는 시간(초)`).toBeGreaterThan(1);
    }
  });

  it('시작 아이템이 존재하고 5×4 가방 안에 겹치지 않게 들어간다', () => {
    for (const c of Object.values(characters)) {
      const taken = new Set<string>();
      for (const si of c.startItems) {
        const def = items[si.defId];
        expect(def, `${c.id} ${si.defId}`).toBeDefined();
        expect([0, 1, 2, 3]).toContain(si.rot);
        if (si.tier !== undefined) expect([1, 2, 3]).toContain(si.tier);
        for (const cell of placedCells(si, def)) {
          const inside = cell.x >= 0 && cell.y >= 0 && cell.x < BAG_START_COLS && cell.y < BAG_START_ROWS;
          expect(inside, `${c.id} ${si.defId} ${cellKey(cell)} 가방 밖`).toBe(true);
          expect(taken.has(cellKey(cell)), `${c.id} ${cellKey(cell)} 겹침`).toBe(false);
          taken.add(cellKey(cell));
        }
      }
    }
  });

  it('카피바라: 유자 두 개가 맞닿아 있다 (★합성 튜토리얼)', () => {
    const yuzus = startBag(characters.capybara.startItems).filter((x) => x.si.defId === 'w_yuzu');
    expect(yuzus.length).toBe(2);
    const [a, b] = yuzus;
    expect((a.si.tier ?? 1) === (b.si.tier ?? 1)).toBe(true);
    expect(edgeAdjacent(placedCells(a.si, a.def), placedCells(b.si, b.def))).toBe(true);
  });

  it('펭귄: 얼음 속성석은 생선 소켓에 있지 않고, 비어 있는 소켓이 가방 안에 있다', () => {
    const bag = startBag(characters.penguin.startItems);
    const fish = bag.find((x) => x.si.defId === 'w_fish')!;
    const ice = bag.find((x) => x.si.defId === 's_ice')!;
    expect(fish && ice).toBeTruthy();
    const sockets = placedSockets(fish.si, fish.def);
    const iceCells = new Set(placedCells(ice.si, ice.def).map(cellKey));
    expect(sockets.some((s) => iceCells.has(cellKey(s)))).toBe(false);

    const taken = new Set(bag.flatMap((x) => placedCells(x.si, x.def)).map(cellKey));
    const reachable = sockets.filter(
      (s) => s.x >= 0 && s.y >= 0 && s.x < BAG_START_COLS && s.y < BAG_START_ROWS && !taken.has(cellKey(s)),
    );
    expect(reachable.length).toBeGreaterThan(0);
  });

  it('고양이: 털뭉치와 공격 강화석이 맞닿아 있다', () => {
    const bag = startBag(characters.cat.startItems);
    const hair = bag.find((x) => x.si.defId === 'w_hairball')!;
    const power = bag.find((x) => x.si.defId === 's_power')!;
    expect(hair && power).toBeTruthy();
    expect(edgeAdjacent(placedCells(hair.si, hair.def), placedCells(power.si, power.def))).toBe(true);
  });
});

describe('기하 헬퍼 (계약 확인)', () => {
  it('rotateLocalCell은 시계방향으로 돈다', () => {
    // 2×1 무기의 오른쪽 끝 옆 소켓 (2,0) → 1회 회전하면 1×2가 되고 소켓은 아래 (0,2)
    expect(rotateLocalCell({ x: 2, y: 0 }, 2, 1, 1)).toEqual({ x: 0, y: 2 });
    expect(rotateLocalCell({ x: 2, y: 0 }, 2, 1, 2)).toEqual({ x: -1, y: 0 });
    expect(rotateLocalCell({ x: 2, y: 0 }, 2, 1, 3)).toEqual({ x: 0, y: -1 });
  });
});
