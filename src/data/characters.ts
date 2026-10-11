import type { CharacterDef } from '../types';

// 시작 아이템은 5×4 가방 기준 좌표.
// 이동 속도 420 px/s: 목표(드래그한 자리)를 향해 이 속도로 '걷는다'(가속 0.1초, 도착 감속 — logic/combat/movement.ts).
// 필드 이동 범위(폭 604 px)를 약 1.5초에 가로지른다. 예전 900은 손가락을 거의 그대로 따라가 너무 휙휙 움직였다.
const CHARACTER_LIST: CharacterDef[] = [
  {
    id: 'penguin',
    name: '펭구',
    desc: '냉동실 출신 날쌘돌이. 얼음판 위처럼 미끄러지듯 피한다.',
    sprite: 'char_penguin',
    portrait: 'portrait_penguin',
    baseMaxHp: 100,
    baseMoveSpeed: 420,
    // 얼음 속성석은 생선 옆(버프는 받음)이지만 소켓 칸은 아니다 → 소켓으로 옮기면 참치 미사일 발견
    startItems: [
      { defId: 'w_fish', x: 1, y: 1, rot: 0 },
      { defId: 's_ice', x: 1, y: 2, rot: 0 },
    ],
    // 최대 HP +15%: 냉기가 공격을 멈추지 않게 바뀌어 참치 미사일로 적을 얼려 두던 펭구가 st5에서 가장 자주 졌다
    // (진 판은 대부분 HP — 체력만 조금. 이동 속도를 더 올리면 프로브 회피 AI는 오히려 더 맞았다)
    passive: { moveSpeedMul: 0.2, maxHpMul: 0.15 },
    passiveDesc: '이동 속도 +20%, 최대 HP +15%',
  },
  {
    id: 'capybara',
    name: '카피',
    desc: '무슨 일이 있어도 태평한 온천 애호가. 맷집 하나는 최고.',
    sprite: 'char_capybara',
    portrait: 'portrait_capybara',
    baseMaxHp: 100,
    baseMoveSpeed: 420,
    // 맞닿은 유자 두 개 → 바로 ★합성 튜토리얼
    startItems: [
      { defId: 'w_yuzu', x: 1, y: 1, rot: 0 },
      { defId: 'w_yuzu', x: 2, y: 1, rot: 0 },
    ],
    // 데미지 +10%: 체력만으로는 보스를 방어선 전에 잡는 경주에서 쓸모가 없었다 (상점에서 얼음을 못 만난 st5는 시드 16개 중
    // 0승 → 10승). 체력 +40%는 그대로 — 맷집 캐릭터
    passive: { maxHpMul: 0.4, damageMul: 0.1 },
    passiveDesc: '최대 HP +40%, 데미지 +10%',
  },
  {
    id: 'cat',
    name: '냥냥',
    desc: '장난감 사냥 경력 9년 차. 앞발이 눈보다 빠르다.',
    sprite: 'char_cat',
    portrait: 'portrait_cat',
    baseMaxHp: 100,
    baseMoveSpeed: 420,
    startItems: [
      { defId: 's_power', x: 1, y: 1, rot: 0 },
      { defId: 'w_hairball', x: 2, y: 1, rot: 0 },
    ],
    // -10% → -15%: 냉기가 공격을 멈추지 않게 바뀐 뒤 st5에서 체력 100짜리 냥냥이 가장 자주 졌다
    passive: { cooldownMul: -0.15 },
    passiveDesc: '모든 무기 쿨타임 -15%',
  },
];

export const CHARACTERS: Record<string, CharacterDef> = Object.fromEntries(CHARACTER_LIST.map((d) => [d.id, d]));
