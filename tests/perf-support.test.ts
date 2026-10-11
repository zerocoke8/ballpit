// 성능 작업 보조 모듈: 그래픽 품질 → 해상도, 저사양 판정, 알림 미리 굽기 목록이 씬의 문구와 맞는지.
import { describe, expect, it } from 'vitest';
import { looksWeak, resolutionFor } from '../src/core/quality';
import { GAME_DATA } from '../src/data';
import { T } from '../src/i18n/ko';
import { sellPrice } from '../src/logic/stats';
import { TOAST_COLORS, combatToastTexts, menuToastTexts, toastColors } from '../src/ui/toastStrings';

describe('quality', () => {
  it('high = min(dpr, 2), low = min(dpr, 1.25)', () => {
    expect(resolutionFor('high', 3)).toBe(2);
    expect(resolutionFor('high', 1.5)).toBe(1.5);
    expect(resolutionFor('low', 3)).toBe(1.25);
    expect(resolutionFor('low', 1)).toBe(1);
    expect(resolutionFor('high', 0)).toBe(1);
    expect(resolutionFor('low', Number.NaN)).toBe(1);
  });

  it('weak device: <= 4 cores or <= 3 GB, unknown values ignored', () => {
    expect(looksWeak({ hardwareConcurrency: 4 })).toBe(true);
    expect(looksWeak({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(true);
    expect(looksWeak({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(false);
    expect(looksWeak({ hardwareConcurrency: 8 })).toBe(false);
    expect(looksWeak({})).toBe(false);
    expect(looksWeak({ hardwareConcurrency: 0, deviceMemory: 0 })).toBe(false);
  });
});

describe('toast prewarm strings', () => {
  it('covers every item drop toast exactly as CombatScene builds it', () => {
    const texts = new Set(combatToastTexts(GAME_DATA));
    expect(texts.has(T.combat.newItem)).toBe(true);
    for (const def of Object.values(GAME_DATA.items)) {
      expect(texts.has(T.combat.newItemNamed(def.name))).toBe(true);
      // 보관함 가득 → 판매가(★1)만큼 골드 (logic/run.ts rewardKill)
      expect(texts.has(T.combat.dropConverted(sellPrice(def, 1)))).toBe(true);
    }
  });

  it('menu toasts include bag/shop fixed messages and evolution names, no duplicates', () => {
    const list = menuToastTexts(GAME_DATA);
    expect(new Set(list).size).toBe(list.length);
    for (const s of [T.bag.stashFull, T.bag.cannotPlace, T.shop.notEnoughGold, T.shop.locked]) expect(list).toContain(s);
    for (const r of GAME_DATA.recipes) expect(list).toContain(T.bag.evolvedToast(GAME_DATA.items[r.result].name));
  });

  it('colors are unique and include drop colors', () => {
    const c = toastColors();
    expect(new Set(c).size).toBe(c.length);
    expect(c).toContain(TOAST_COLORS.drop);
    expect(c).toContain(TOAST_COLORS.dropConverted);
  });
});
