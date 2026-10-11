// 상점 화면.

export const shop = {
  title: '상점',
  reroll: '새로고침',
  lock: '잠금',
  unlock: '잠금 해제',
  buy: '구매',
  soldOut: '품절',
  notEnoughGold: '골드가 부족해요',
  stashFull: '보관함이 가득 찼어요',
  bought: '보관함에 넣었어요!',
  sold: (n: number): string => `+${n} 골드`,

  expandBag: '가방 확장',
  expandCol: '열 +1',
  expandRow: '행 +1',
  maxExpanded: '최대 크기',

  heal: 'HP 회복',
  healDesc: (pct: number): string => `최대 HP의 ${pct}% 회복`,
  healBought: '이번 상점에서는 이미 회복했어요',
  fullHp: 'HP가 가득 찼어요',

  nextStage: '다음 스테이지',
  price: (n: number): string => `${n}`,

  // ── 상단 바 ──
  nextStageLabel: (n: number, total: number): string => `다음: 스테이지 ${n}/${total}`,
  hpValue: (cur: number, max: number): string => `${Math.ceil(cur)}/${max}`,

  // ── 버튼 / 알림 ──
  nextStageButton: '다음 스테이지 ▶',
  buyButton: '구매',
  tapToPreview: '눌러서 미리보기',
  locked: '잠금! 새로고침해도 남아요',
  unlocked: '잠금 해제',
  rerollNothing: '새로고침할 칸이 없어요',
  rerolled: '새 물건이 들어왔어요!',
  expandTitle: '어느 쪽으로 늘릴까요?',
  expandColSub: (n: number): string => `가로 ${n}칸`,
  expandRowSub: (n: number): string => `세로 ${n}칸`,
  expanded: '가방이 커졌어요!',
  healed: (n: number): string => `HP +${n}`,
  healDone: '회복 완료',

  // ── 상점 머리말 / 안내 말풍선 ──
  header: '상점',
  headerHint: '카드를 눌러 미리보기',
  tips: [
    '카드를 누르면 미리 보고,\n구매 버튼으로 살 수 있어요!',
    '산 물건은 보관함으로 가요.\n가방으로 끌어 넣어야 효과가 나요!',
    '같은 아이템 두 개를 맞붙이면\n★ 합성할 수 있어요!',
    '무기의 ◇ 칸에 맞는 강화석을 두면\n더 센 무기로 진화해요!',
    '자물쇠를 걸어 두면\n새로고침해도 남아 있어요.',
    '필요 없는 아이템은 판매 칸에\n끌어다 놓으면 골드가 돼요.',
  ],
} as const;
