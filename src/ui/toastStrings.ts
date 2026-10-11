// Toast 미리 굽기 목록: 게임이 실제로 띄우는 알림 문구를 씬 코드와 같은 i18n 포맷터로 만든다.
// (pixi를 import 하지 않는다 — tests/toast-strings.test.ts가 씬의 문구 조합과 맞는지 확인)
import { UI_COLORS } from '../config';
import { T } from '../i18n/ko';
import { sellPrice } from '../logic/stats';
import type { GameData } from '../types';

/** 씬 코드가 쓰는 알림 배경색 (CombatScene / BagView / ShopScene의 Toast.show 호출과 같은 값) */
export const TOAST_COLORS = {
  drop: UI_COLORS.accent,
  dropConverted: 0x6b4a12,
  bad: UI_COLORS.bad,
  tier: 0xc98a10,
  evolved: 0xa03ca8,
  locked: 0x8a6a10,
  expanded: 0x2f6fb0,
  healed: 0xb03050,
  plain: UI_COLORS.panelLight,
} as const;

/**
 * 전투 중에 뜰 수 있는 알림 (부팅 로딩 중에 굽는다): 아이템 드롭 '새 아이템! {이름}'(모든 아이템)과
 * 보관함이 가득 찼을 때의 '보관함이 가득 차서 +{판매가} 골드'(드롭은 ★1 → sellPrice(def, 1)).
 * CombatScene.onReward와 같은 포맷터·인자.
 */
export function combatToastTexts(data: GameData): string[] {
  const out = new Set<string>();
  out.add(T.combat.newItem);
  for (const def of Object.values(data.items)) {
    out.add(T.combat.newItemNamed(def.name));
    out.add(T.combat.dropConverted(sellPrice(def, 1)));
  }
  return [...out];
}

/** 메뉴(가방·상점)에서 자주 뜨는 고정 문구 — 메뉴 화면의 쉬는 프레임에 하나씩 굽는다 */
export function menuToastTexts(data: GameData): string[] {
  const out = new Set<string>([
    T.bag.stashFull,
    T.bag.cannotPlace,
    T.bag.cannotRotate,
    T.bag.noFreeSpot,
    T.bag.sellZone,
    T.bag.tierUp(2),
    T.bag.tierUp(3),
    T.shop.locked,
    T.shop.stashFull,
    T.shop.notEnoughGold,
    T.shop.rerollNothing,
    T.shop.expanded,
    T.shop.healBought,
    T.shop.fullHp,
  ]);
  // 진화 결과 이름 (레시피 결과물)
  for (const r of data.recipes) {
    const def = data.items[r.result];
    if (def) out.add(T.bag.evolvedToast(def.name));
  }
  return [...out];
}

export function toastColors(): number[] {
  return [...new Set<number>(Object.values(TOAST_COLORS))];
}
