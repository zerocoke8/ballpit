// 툴팁에 보여줄 내용을 런 상태에서 계산한다 (그리기는 TooltipPanel). 수치는 전부 logic/stats에서 온다.
import { ELEMENT_COLORS } from '../../config';
import { T } from '../../i18n/ko';
import { addNewToBag, createBag, findByUid, mergesFor, neighbors } from '../../logic/bag';
import { runPlayerStats } from '../../logic/run';
import { computeWeapon, scaledGear, scaledStone, stoneBuffsFor } from '../../logic/stats';
import type { Element, GameData, GearEffect, ItemDef, MergeOption, RunState, StoneEffect, Tier } from '../../types';

/** 이 값 이상이면 관통 ∞ 표시 */
const PIERCE_INFINITE = 99;
const FLOOR_EPS = 1e-9;

export interface StatChip {
  label: string;
  value: string;
  /** 강화석 덕분에 좋아진 값 (초록) */
  boosted?: boolean;
  /** 칩 배경 색 (속성 등) */
  color?: number;
}

export type LineTone = 'normal' | 'dim' | 'good' | 'merge' | 'hint' | 'warn';

export interface TooltipLine {
  /** <item>이름</item> 태그 사용 가능 */
  text: string;
  tone: LineTone;
  /** 공간이 모자라면 낮은 것부터 뺀다 */
  priority: number;
}

export interface ItemTooltipModel {
  type: 'item';
  def: ItemDef;
  tier: Tier;
  kindLabel: string;
  rarityLabel: string;
  stats: StatChip[];
  lines: TooltipLine[];
}

export interface EmptyTooltipModel {
  type: 'empty';
  title: string;
  lines: TooltipLine[];
}

export type TooltipModel = ItemTooltipModel | EmptyTooltipModel;

const NBSP = String.fromCharCode(0xa0);

/** 이름 강조 태그. 이름 중간에서 줄이 바뀌지 않게 공백을 NBSP로 */
export const tagItem = (name: string): string => `<item>${name.replace(/ /g, NBSP)}</item>`;

/** 10 미만은 소수 한 자리(정수면 생략), 이상은 반올림 */
export function fmtNum(n: number): string {
  if (n >= 10) return String(Math.round(n));
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function floorEps(n: number): number {
  return Math.floor(n + FLOOR_EPS);
}

/** 강화석 효과 문장들 (★ 반영 후) */
export function stoneEffectChips(effect: StoneEffect): StatChip[] {
  const out: StatChip[] = [];
  if (effect.element) {
    out.push({ label: T.bag.stoneElement(T.common.element[effect.element]), value: '', color: ELEMENT_COLORS[effect.element] });
  }
  if (effect.damageMul) out.push({ label: T.bag.stoneDamage(effect.damageMul), value: '', boosted: true });
  if (effect.cooldownMul) out.push({ label: T.bag.stoneCooldown(effect.cooldownMul), value: '', boosted: true });
  if (effect.projectileCountAdd) out.push({ label: T.bag.stoneCount(floorEps(effect.projectileCountAdd)), value: '', boosted: true });
  if (effect.pierceAdd) out.push({ label: T.bag.stonePierce(floorEps(effect.pierceAdd)), value: '', boosted: true });
  return out;
}

export function stoneEffectText(effect: StoneEffect): string {
  return stoneEffectChips(effect)
    .map((c) => c.label)
    .join(', ');
}

export function gearEffectChips(effect: GearEffect): StatChip[] {
  const out: StatChip[] = [];
  if (effect.maxHpAdd) out.push({ label: T.bag.gearMaxHp(effect.maxHpAdd), value: '', boosted: true });
  if (effect.moveSpeedMul) out.push({ label: T.bag.gearMoveSpeed(effect.moveSpeedMul), value: '', boosted: true });
  if (effect.regenPerSec) out.push({ label: T.bag.gearRegen(effect.regenPerSec), value: '', boosted: true });
  if (effect.goldMul) out.push({ label: T.bag.gearGold(effect.goldMul), value: '', boosted: true });
  if (effect.damageMul) out.push({ label: T.bag.gearDamage(effect.damageMul), value: '', boosted: true });
  return out;
}

export function isEvolved(data: GameData, defId: string): boolean {
  return data.recipes.some((r) => r.result === defId);
}

/** 합성 옵션 한 줄 */
export function mergeLineText(data: GameData, opt: MergeOption): string {
  const name = data.items[opt.resultDefId]?.name ?? opt.resultDefId;
  return opt.kind === 'tier' ? T.bag.mergeTierResult(name, opt.resultTier) : T.bag.mergeRecipeResult(name);
}

/** 레시피 힌트 줄 (무기 = base 쪽, 강화석 = 재료 쪽) */
export function recipeHintLines(data: GameData, def: ItemDef): string[] {
  const asBase = data.recipes.filter((r) => r.base === def.id);
  const lines: string[] = [];
  for (const r of asBase) {
    const ing = data.items[r.ingredient];
    const res = data.items[r.result];
    if (ing && res) lines.push(T.bag.recipeBase(tagItem(ing.name), tagItem(res.name)));
  }
  const asIng = data.recipes.filter((r) => r.ingredient === def.id);
  if (asIng.length === 1) {
    const base = data.items[asIng[0].base];
    const res = data.items[asIng[0].result];
    if (base && res) lines.push(T.bag.recipeIngredient(tagItem(base.name), tagItem(res.name)));
  } else if (asIng.length > 1) {
    const names = asIng
      .map((r) => data.items[r.base]?.name)
      .filter((n): n is string => !!n)
      .map(tagItem)
      .join('·');
    lines.push(T.bag.recipeIngredientMany(names));
  }
  return lines;
}

interface Target {
  defId: string;
  tier: Tier;
  /** 가방/보관함 아이템이면 uid */
  uid: number | null;
  where: 'bag' | 'stash' | 'preview';
}

/** 가방 밖(보관함·상점) 무기의 스탯: 아무것도 맞닿지 않은 임시 가방에서 계산 */
function standaloneWeapon(data: GameData, run: RunState, defId: string, tier: Tier) {
  const def = data.items[defId];
  const tmp = createBag(Math.max(1, def.w, def.h), Math.max(1, def.w, def.h), 0);
  const placed = addNewToBag(tmp, data.items, defId, tier, 0, 0, 0);
  if (!placed) return null;
  return computeWeapon(tmp, data.items, placed.uid, runPlayerStats(data, run));
}

export function buildItemTooltip(
  data: GameData,
  run: RunState,
  target: Target,
  merges: readonly MergeOption[],
): ItemTooltipModel | null {
  const def = data.items[target.defId];
  if (!def) return null;
  const bag = run.bag;
  const stats: StatChip[] = [];
  const lines: TooltipLine[] = [];
  const inBag = target.where === 'bag' && target.uid !== null;

  // 합성 가능 (가장 중요)
  if (inBag && target.uid !== null) {
    const opts = mergesFor([...merges], target.uid);
    if (opts.length > 0) lines.push({ text: mergeLineText(data, opts[0]), tone: 'merge', priority: 100 });
  }

  if (def.kind === 'weapon' && def.weapon) {
    const w = inBag && target.uid !== null
      ? computeWeapon(bag, data.items, target.uid, runPlayerStats(data, run))
      : standaloneWeapon(data, run, def.id, target.tier);
    const buffs = inBag && target.uid !== null ? stoneBuffsFor(bag, data.items, target.uid) : null;
    if (w) {
      const dmg = fmtNum(w.damage) + (w.count > 1 ? ` ${T.bag.times(w.count)}` : '');
      stats.push({ label: T.bag.statDamage, value: dmg, boosted: !!buffs && (buffs.damageMul > 0 || buffs.countAdd > 0) });
      stats.push({ label: T.bag.statCooldown, value: T.bag.seconds(w.cooldown), boosted: !!buffs && buffs.cooldownMul < 0 });
      if (w.pierce > 0) {
        stats.push({
          label: T.bag.statPierce,
          value: w.pierce >= PIERCE_INFINITE ? T.bag.infinite : String(w.pierce),
          boosted: !!buffs && buffs.pierceAdd > 0,
        });
      }
      if (w.split) stats.push({ label: T.bag.statSplit, value: String(w.split.count) });
      if (w.explodeRadius > 0) stats.push({ label: T.bag.statExplode, value: '' });
      if (w.maxBounces > 0) stats.push({ label: T.bag.statBounces, value: T.bag.bounces(w.maxBounces) });
      for (const el of w.elements as Element[]) {
        stats.push({ label: T.common.element[el], value: '', color: ELEMENT_COLORS[el] });
      }
    }
    if (buffs && buffs.sourceUids.length > 0) {
      const parts: string[] = [];
      for (const suid of buffs.sourceUids) {
        const found = findByUid(bag, suid);
        const sdef = found ? data.items[found.item.defId] : undefined;
        if (!found || !sdef?.stone) continue;
        parts.push(T.bag.buffLine(tagItem(sdef.name), stoneEffectText(scaledStone(sdef.stone, found.item.tier))));
      }
      if (parts.length > 0) lines.push({ text: parts.join('  ·  '), tone: 'good', priority: 80 });
    } else if (inBag) {
      lines.push({ text: T.bag.noBuffs, tone: 'dim', priority: 20 });
    }
  } else if (def.kind === 'stone' && def.stone) {
    stats.push(...stoneEffectChips(scaledStone(def.stone, target.tier)));
    if (inBag && target.uid !== null) {
      const targets = neighbors(bag, data.items, target.uid)
        .map((n) => data.items[n.defId])
        .filter((d): d is ItemDef => !!d && d.kind === 'weapon')
        .map((d) => tagItem(d.name));
      lines.push(
        targets.length > 0
          ? { text: `${T.bag.stoneApplies} — ${T.bag.stoneBuffing(targets.join(', '))}`, tone: 'good', priority: 80 }
          : { text: `${T.bag.stoneApplies} — ${T.bag.stoneNoTarget}`, tone: 'normal', priority: 80 },
      );
    } else {
      lines.push({ text: T.bag.stoneApplies, tone: 'normal', priority: 80 });
    }
  } else if (def.kind === 'gear' && def.gear) {
    stats.push(...gearEffectChips(scaledGear(def.gear, target.tier)));
    lines.push({ text: T.bag.gearHint, tone: 'normal', priority: 60 });
  }

  for (const text of recipeHintLines(data, def)) lines.push({ text, tone: 'hint', priority: 70 });

  if (target.where === 'stash') lines.push({ text: T.bag.inStash, tone: 'warn', priority: 75 });
  else if (target.where === 'preview') lines.push({ text: T.bag.previewNote, tone: 'dim', priority: 15 });

  lines.push({ text: def.desc, tone: 'dim', priority: 10 });

  const evolved = isEvolved(data, def.id);
  return {
    type: 'item',
    def,
    tier: target.tier,
    kindLabel: evolved ? T.bag.evolved : T.common.kind[def.kind],
    rarityLabel: T.common.rarity[def.rarity],
    stats,
    lines,
  };
}

export function buildEmptyTooltip(): EmptyTooltipModel {
  const lines: TooltipLine[] = T.bag.emptyLines.map((text, i) => ({ text, tone: 'normal' as LineTone, priority: 50 - i }));
  lines.push({ text: T.bag.emptyDragHint, tone: 'dim', priority: 10 });
  return { type: 'empty', title: T.bag.emptyTitle, lines };
}
