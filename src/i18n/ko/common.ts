// 공용 UI 문자열: 등급/속성/종류 이름, 단위, 스탯 라벨.

const pct = (n: number): string => `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`;

export const common = {
  ok: '확인',
  cancel: '취소',
  close: '닫기',
  back: '뒤로',
  yes: '예',
  no: '아니요',
  next: '다음',
  loading: '불러오는 중…',

  rarity: { common: '일반', rare: '희귀', epic: '영웅', legendary: '전설' },
  element: { fire: '불', ice: '얼음', lightning: '번개' },
  kind: { weapon: '무기', stone: '강화석', gear: '장비' },

  stat: {
    damage: '공격력',
    cooldown: '쿨타임',
    count: '발사 수',
    pierce: '관통',
    bounce: '반사',
    explode: '폭발',
    split: '분열',
    maxHp: '최대 HP',
    moveSpeed: '이동 속도',
    regen: '초당 회복',
    goldMul: '골드 획득',
  },

  tier: (n: number): string => '★'.repeat(Math.max(1, Math.min(3, n))),
  gold: (n: number): string => `${n} 골드`,
  seconds: (n: number): string => `${n.toFixed(1)}초`,
  percent: pct,
  perSecond: (n: number): string => `초당 ${n}`,
  stage: (n: number): string => `스테이지 ${n}`,
  hp: (cur: number, max: number): string => `${Math.ceil(cur)} / ${max}`,

  /** 임시 개발 갤러리 화면 */
  dev: {
    galleryTitle: '개발 갤러리',
    assets: (art: number, total: number): string => `에셋 ${total}개 · 아트 ${art} · 플레이스홀더 ${total - art}`,
    toastButton: '토스트 띄우기',
    toastText: '안녕! 동물 친구들 출동 🐾',
    disabled: '비활성 버튼',
    actorState: (state: string): string => `상태: ${state}`,
    legend: '● 아트  ○ 플레이스홀더',
  },
} as const;
