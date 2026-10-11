// 타이틀 / 캐릭터 선택 / 스테이지 클리어 / 결과 화면.

/** 마지막 글자 받침 유무로 조사 고르기: josa('생선', '을', '를') → '생선을' */
function josa(word: string, withFinal: string, withoutFinal: string): string {
  const last = word.trim().charCodeAt(word.trim().length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  const hasFinal = isHangul && (last - 0xac00) % 28 !== 0;
  return word + (hasFinal ? withFinal : withoutFinal);
}

export const menu = {
  // ── 타이틀 ────────────────────────────────────────────────
  gameTitle: '동물 볼슈터',
  subtitle: '장난감 군단을 막아라!',
  tapToStart: '화면을 눌러 시작',
  newRun: '새 게임',
  continueRun: '이어하기',
  confirmNewRun: '진행 중인 게임이 사라져요.\n새로 시작할까요?',
  version: (v: string): string => `v${v} 프로토타입`,

  // ── 캐릭터 선택 ───────────────────────────────────────────
  selectCharacter: '누구랑 갈까?',
  passive: '패시브',
  startItems: '시작 아이템',
  startRun: '시작!',
  maxHp: '최대 HP',
  moveSpeed: '이동 속도',
  times: (n: number): string => `×${n}`,
  /** 시작 아이템에 레시피 재료가 함께 있을 때 (펭귄: 얼음 속성석 + 냉동 생선) */
  recipeTeaser: (ingredient: string, base: string): string =>
    `쉿, 비밀! ${josa(ingredient, '을', '를')} ${base}의 ◇ 칸에 옮기면… 무슨 일이 생길까?`,
  /** 같은 아이템 두 개가 맞닿아 있을 때 (카피바라: 유자 ×2) */
  tierTeaser: (name: string): string => `${name} 두 개가 딱 붙어 있네? 가방을 열어 ★ 합성해 봐요!`,
  /** 강화석이 무기 옆에 있을 때 */
  stoneTeaser: (stone: string): string => `${josa(stone, '은', '는')} 맞닿은 무기를 더 세게 만들어요.`,
  teaserTitle: '팁',

  // ── 스테이지 클리어 ───────────────────────────────────────
  stageClear: '스테이지 클리어!',
  stageClearN: (n: number): string => `스테이지 ${n} 클리어!`,
  clearGold: '클리어 보너스',
  healed: '회복',
  kills: '처치',
  goldEarned: '획득 골드',
  drops: '획득 아이템',
  noDrops: '없음',
  toShop: '상점으로 ▶',
  viewEnding: '엔딩 보기',
  plus: (n: number): string => `+${n}`,
  totalGold: (n: number): string => `보유 골드 ${n}`,

  // ── 결과 ──────────────────────────────────────────────────
  victory: '승리!',
  victoryDesc: '장난감 군단을 모두 물리쳤어요!',
  defeat: '패배…',
  defeatDesc: '다음엔 더 잘할 수 있어요!',
  reachedStage: (n: number): string => `스테이지 ${n}까지 도달`,
  reachedStageLabel: '도달 스테이지',
  stagesCleared: '클리어한 스테이지',
  killsCount: '처치 수',
  stageOf: (n: number, total: number): string => `${n} / ${total}`,
  toTitle: '타이틀로',
  retry: '다시 하기',

  // ── 설정 (타이틀의 설정 창 · 전투 가방/상점의 스피커 버튼) ─────
  settings: {
    button: '설정',
    title: '설정',
    sfx: '효과음',
    on: '켜기',
    off: '끄기',
    volume: '볼륨',
    /** 볼륨 단계 표시 (예: 3 / 5) */
    volumeStep: (n: number, total: number): string => `${n} / ${total}`,
    quality: '그래픽 품질',
    qualityHigh: '높음',
    qualityLow: '낮음',
    qualityHint: '버벅이면 낮음으로 바꿔 보세요',
    close: '닫기',
    /** 스피커 버튼 접근성 이름 */
    muteLabel: '소리 끄기',
    unmuteLabel: '소리 켜기',
  },

  // ── 부팅 ──────────────────────────────────────────────────
  bootFailed: '앗, 게임을 불러오지 못했어요.\n새로고침해 주세요.',
} as const;
