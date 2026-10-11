// 가방 화면 (전투 일시정지 / 상점 공용).

const signedPct = (n: number): string => `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`;
const stars = (n: number): string => '★'.repeat(Math.max(1, Math.min(3, n)));

export const bag = {
  title: '가방',
  stash: '보관함',
  stashInactive: '보관함 아이템은 효과가 없어요',
  rotate: '회전',
  merge: '합성',
  mergeTier: '★ 합성',
  mergeRecipe: '진화!',
  mergeAvailable: '합성 가능!',
  close: '닫기',
  sell: '판매',
  sellZone: '여기로 끌어서 판매',
  sellFor: (n: number): string => `${n} 골드에 판매`,

  cannotPlace: '여기엔 놓을 수 없어요',
  stashFull: '보관함이 가득 찼어요',
  socket: '소켓',
  recipeHint: (name: string): string => `◇ 칸에 ${name}을(를) 두면 진화`,
  stoneHint: '맞닿은 무기를 강화해요',
  gearHint: '가방에 있으면 효과가 적용돼요',
  tapToSelect: '아이템을 눌러서 정보 보기',

  // ── 보관함 ──
  stashCount: (n: number, cap: number): string => `보관함 ${n}/${cap}`,
  sizeBadge: (w: number, h: number): string => `${w}×${h}`,

  // ── 툴팁 ──
  emptyTitle: '가방',
  emptyLines: [
    '아이템을 눌러서 정보 보기',
    '끌어서 옮기기 · 두 번 눌러 회전',
    '같은 아이템 두 개를 맞붙이면 ★ 합성!',
  ],
  emptyDragHint: '끌고 있는 동안 R키 · 오른쪽 클릭 · 두 번째 손가락으로 회전',
  evolved: '진화 무기',
  inStash: '보관함: 가방에 넣어야 효과가 나요',
  previewNote: '구매하면 보관함으로 들어가요',
  statDamage: '공격력',
  statCooldown: '쿨타임',
  statPierce: '관통',
  statSplit: '분열',
  statExplode: '폭발',
  statBounces: '튕김',
  infinite: '∞',
  seconds: (s: number): string => `${s < 1 ? s.toFixed(2) : s.toFixed(1)}초`,
  times: (n: number): string => `×${n}`,
  bounces: (n: number): string => `${n}회`,

  // 강화석 효과 (★ 반영된 값)
  stoneDamage: (mul: number): string => `데미지 ${signedPct(mul)}`,
  stoneCooldown: (mul: number): string => `쿨타임 ${signedPct(mul)}`,
  stoneElement: (el: string): string => `${el} 속성 부여`,
  stoneCount: (n: number): string => `발사 수 +${n}`,
  stonePierce: (n: number): string => `관통 +${n}`,
  stoneApplies: '맞닿은 무기에 적용',
  stoneBuffing: (names: string): string => `적용 중: ${names}`,
  stoneNoTarget: '아직 맞닿은 무기가 없어요',

  // 장비 효과 (★ 반영된 값)
  gearMaxHp: (n: number): string => `최대 HP +${Math.round(n)}`,
  gearMoveSpeed: (mul: number): string => `이동 속도 ${signedPct(mul)}`,
  gearRegen: (n: number): string => `초당 HP ${Number.isInteger(n) ? n : n.toFixed(1)} 회복`,
  gearGold: (mul: number): string => `골드 획득 ${signedPct(mul)}`,
  gearDamage: (mul: number): string => `모든 무기 공격력 ${signedPct(mul)}`,

  // 맞닿은 강화석 목록 (무기 툴팁)
  buffedByTitle: '강화',
  buffLine: (name: string, effect: string): string => `${name}: ${effect}`,
  noBuffs: '강화석을 맞붙이면 더 강해져요',

  // 레시피 힌트 (이름은 호출 쪽에서 <item>태그</item>로 감싼다)
  recipeBase: (ingredient: string, result: string): string => `◇ 칸에 ${ingredient} → ${result}`,
  recipeIngredient: (base: string, result: string): string => `${base}의 ◇ 칸에 놓으면 → ${result}`,
  recipeIngredientMany: (bases: string): string => `${bases}의 ◇ 칸에 놓으면 진화!`,

  // 합성
  mergeTierResult: (name: string, tier: number): string => `합성 가능! → ${stars(tier)} ${name}`,
  mergeRecipeResult: (name: string): string => `합성 가능! → ${name}`,
  tierUp: (tier: number): string => `★${tier} 승급!`,
  evolvedToast: (name: string): string => `진화! ${name}`,

  // 회전 / 배치 / 판매
  cannotRotate: '회전할 자리가 없어요',
  noFreeSpot: '가방에 빈 자리가 없어요',
  placed: '가방에 넣었어요',
  sellConfirm: '한 번 더 눌러 판매',
  sellDrop: (n: number): string => `놓으면 +${n}`,
  sellPrice: (n: number): string => `+${n}`,
  soldToast: (n: number): string => `+${n} 골드`,
} as const;
