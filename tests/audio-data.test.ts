// 효과음 데이터 검증: sfx.json ↔ SFX_IDS, 생성 파라미터 범위, 게임 데이터 → 효과음 매핑, public/sfx/manifest.json.
import { describe, expect, it } from 'vitest';
import { GAME_DATA } from '../src/data';
import {
  CATEGORY_PRIORITY,
  CATEGORY_RESERVE,
  ELEMENT_HIT_SFX,
  ENEMY_SHOT_SFX,
  SFX_DEFS,
  SFX_IDS,
  WEAPON_FIRE_SFX,
  weaponFireSfx,
  type SfxCategory,
} from '../src/data/sfxMap';

const CATEGORIES: SfxCategory[] = ['ui', 'fire', 'hit', 'enemy', 'reward', 'jingle'];
const ids = new Set<string>(SFX_IDS);
// public/sfx의 파일 목록 (불러오지 않고 이름만 — node 타입 없이)
const SFX_FILES = new Set(Object.keys(import.meta.glob('../public/sfx/*')).map((k) => k.slice('../public/sfx/'.length)));
const MANIFEST_RAW = Object.values(import.meta.glob('../public/sfx/manifest.json', { query: '?raw', import: 'default', eager: true }))[0] as string | undefined;

describe('sfx.json', () => {
  it('id가 SFX_IDS와 정확히 같고 중복이 없다', () => {
    const jsonIds = SFX_DEFS.map((d) => d.id);
    expect(new Set(jsonIds).size).toBe(jsonIds.length);
    expect([...jsonIds].sort()).toEqual([...SFX_IDS].sort());
  });

  it.each(SFX_DEFS.map((d) => [d.id, d] as const))('%s: 생성·재생 파라미터 범위', (_id, d) => {
    expect(CATEGORIES).toContain(d.category);
    // ElevenLabs duration_seconds 0.5..22
    expect(d.duration).toBeGreaterThanOrEqual(0.5);
    expect(d.duration).toBeLessThanOrEqual(22);
    expect(d.influence).toBeGreaterThanOrEqual(0);
    expect(d.influence).toBeLessThanOrEqual(1);
    expect(Number.isInteger(d.variants)).toBe(true);
    expect(d.variants).toBeGreaterThanOrEqual(1);
    expect(d.variants).toBeLessThanOrEqual(8);
    expect(d.volume).toBeGreaterThan(0);
    expect(d.volume).toBeLessThanOrEqual(1);
    expect(Number.isInteger(d.maxVoices)).toBe(true);
    expect(d.maxVoices).toBeGreaterThanOrEqual(1);
    expect(d.minInterval).toBeGreaterThanOrEqual(0);
    expect(d.pitchVar).toBeGreaterThanOrEqual(0);
    expect(d.pitchVar).toBeLessThanOrEqual(0.3);
    // 프롬프트: 영어(ASCII), 비어 있지 않음, API 제한 안
    expect(d.prompt.trim().length).toBeGreaterThan(10);
    expect(d.prompt.length).toBeLessThan(450);
    expect(/^[\x20-\x7e]+$/.test(d.prompt)).toBe(true);
  });

  it('전체 생성량은 예산 안 (총 길이 ≤ 60초)', () => {
    const total = SFX_DEFS.reduce((a, d) => a + d.variants * d.duration, 0);
    expect(total).toBeLessThanOrEqual(60);
  });
});

describe('우선순위 / 예산', () => {
  it('징글 > UI > 보상 > 적 > 타격 > 발사', () => {
    const p = CATEGORY_PRIORITY;
    expect(p.jingle).toBeGreaterThan(p.ui);
    expect(p.ui).toBeGreaterThan(p.reward);
    expect(p.reward).toBeGreaterThan(p.enemy);
    expect(p.enemy).toBeGreaterThan(p.hit);
    expect(p.hit).toBeGreaterThan(p.fire);
  });

  it('사용자 조작·징글은 초당 예산과 무관, 발사음이 가장 먼저 빠진다', () => {
    expect(CATEGORY_RESERVE.ui).toBeNull();
    expect(CATEGORY_RESERVE.jingle).toBeNull();
    const r = (c: SfxCategory): number => CATEGORY_RESERVE[c] ?? -1;
    expect(r('fire')).toBeGreaterThan(r('hit'));
    expect(r('hit')).toBeGreaterThanOrEqual(r('enemy'));
    expect(r('enemy')).toBeGreaterThanOrEqual(r('reward'));
  });
});

describe('게임 데이터 → 효과음 매핑', () => {
  const weapons = Object.values(GAME_DATA.items).filter((d) => d.kind === 'weapon');

  it('모든 무기에 발사음이 있고, 진화 무기는 기본 무기 계열을 따른다', () => {
    for (const w of weapons) expect(ids.has(weaponFireSfx(w.id)), w.id).toBe(true);
    for (const r of GAME_DATA.recipes) expect(weaponFireSfx(r.result), r.result).toBe(weaponFireSfx(r.base));
    // 기본 무기는 전부 직접 매핑 (모르는 무기 기본값에 기대지 않음)
    const evolved = new Set(GAME_DATA.recipes.map((r) => r.result));
    for (const w of weapons) if (!evolved.has(w.id)) expect(WEAPON_FIRE_SFX[w.id], w.id).toBeDefined();
    for (const v of Object.values(WEAPON_FIRE_SFX)) expect(ids.has(v)).toBe(true);
  });

  it('공격하는 적의 탄 그림마다 발사음이 있다', () => {
    for (const e of Object.values(GAME_DATA.enemies)) {
      if (!e.attack) continue;
      const id = ENEMY_SHOT_SFX[e.attack.sprite];
      expect(id, `${e.id} → ${e.attack.sprite}`).toBeDefined();
      expect(ids.has(id)).toBe(true);
    }
  });

  it('속성 적중 소리', () => {
    for (const el of ['fire', 'ice', 'lightning'] as const) expect(ids.has(ELEMENT_HIT_SFX[el])).toBe(true);
  });
});

describe('public/sfx/manifest.json', () => {
  it('있고, 객체이며 (빈 {}도 된다 — 그러면 게임은 무음), 항목은 아는 id·실제 파일·변형 수 이하', () => {
    expect(typeof MANIFEST_RAW).toBe('string');
    const m: unknown = JSON.parse(MANIFEST_RAW ?? 'null');
    expect(m !== null && typeof m === 'object' && !Array.isArray(m)).toBe(true);
    for (const [id, files] of Object.entries(m as Record<string, unknown>)) {
      expect(ids.has(id), id).toBe(true);
      expect(Array.isArray(files)).toBe(true);
      const list = files as unknown[];
      const def = SFX_DEFS.find((d) => d.id === id)!;
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.length).toBeLessThanOrEqual(def.variants);
      for (const f of list) {
        expect(typeof f).toBe('string');
        expect(SFX_FILES.has(f as string), f as string).toBe(true);
      }
    }
  });
});
