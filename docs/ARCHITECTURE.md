# 아키텍처 & 모듈 계약

타입은 전부 `src/types.ts`, 상수는 `src/config.ts`. 아래 시그니처는 **공개 API 계약**이다.
구현 중 계약을 바꿔야 하면 이 문서와 `types.ts`를 함께 고친다.

```
src/
  types.ts  config.ts
  logic/            순수 TS (PixiJS/DOM 금지) — vitest로 테스트
    rng.ts          Rng (mulberry32)
    bag.ts          가방 격자·회전·소켓·인접·합성
    stats.ts        유효 스탯(플레이어/무기) 계산, 가격
    run.ts          런 상태·보상·스테이지 진행·세이브
    shop.ts         상점 굴리기·구매·판매·확장·회복
    combat/
      physics.ts    원-사각형 충돌·반사
      movement.ts   플레이어 이동 모델 (목표로 걷기: 가속·최고 속도·도착 감속, 이동 범위)
      sim.ts        CombatSim (고정 스텝 전투 시뮬레이션)
  data/             순수 데이터
    items.ts recipes.ts enemies.ts stages.ts characters.ts assets.json index.ts
    sfx.json        효과음 정의 (ElevenLabs 프롬프트 + 재생 힌트)   sfxMap.ts  SfxId·무기/적/속성 → 효과음 매핑·연출 수치
  audio/            효과음 엔진 (Web Audio API, 라이브러리 없음) — 아래 'audio/' 참고
    index.ts        sfx(재생 창구) · initAudio()   AudioManager.ts   scheduler.ts(재생 판정, 순수)   process.ts(디코드 다듬기, 순수)
  i18n/ko/          UI 문자열 (영역별 파일 + index.ts)
  core/             PixiJS 앱 프레임워크
    app.ts          앱 생성·스케일링·뷰포트·그래픽 품질(렌더 해상도)
    quality.ts      품질 → 해상도, 저사양 판정 (순수, 테스트됨)
    scene.ts        Scene 기반 클래스, SceneManager, destroyTree
    settings.ts     플레이어 설정 (효과음·품질)
    tween.ts        트윈/딜레이
    keyboard.ts     키 입력 상태
    fonts.ts        웹폰트 로드
  debug/
    perfOverlay.ts  폰에서 보는 성능 진단 오버레이(?perf) + perfMark 태그 — 아래 'debug/' 참고
  render/
    assets.ts       manifest 로드, 텍스처/애니메이션 조회, 플레이스홀더 생성
    gpuWarm.ts      부팅 중 텍스처 GPU 업로드·상주 + 셰이더 미리 컴파일
    actor.ts        ActorSprite: 프레임 애니메이션 또는 코드 애니메이션
  ui/               공용 위젯 (Button, Panel, ProgressBar, Toast(구운 텍스처 캐시), text 스타일)
    toastStrings.ts Toast 미리 굽기 목록 (씬과 같은 i18n 포맷터)
  scenes/
    TitleScene.ts CharacterSelectScene.ts StageClearScene.ts ResultScene.ts ShopScene.ts
    settingsUi.ts   설정 창(타이틀) + 스피커 켜기/끄기 버튼(전투 가방 오버레이 · 상점 상단 바)
    combat/         CombatScene + 렌더러 + HUD + 무기바 + 이펙트 (아래 'combat/ 렌더·연출' 참고)
      CombatScene.ts  FieldView.ts(레이어 순서)  EnemyLayer.ts  ProjectileLayer.ts(투사체·꼬리·적 탄)
      Effects.ts(파티클·번개·피해 숫자)  fxTextures.ts(구운 텍스처·아틀라스·숫자 폰트)  ComboLabel.ts('백어택!')
      PlayerView.ts  AimGuide.ts  TutorialCallout.ts  Banner.ts  BossBar.ts  FastBar.ts(전투용 게이지)
      Hud.ts  WeaponBar.ts  Flyers.ts(동전·아이템 비행)  FrameView.ts(벽·방어선)  BagOverlay.ts  visual.ts(연출 상수)
    bag/            BagView (전투 일시정지·상점 공용)
  game.ts           전역 Game: 런 상태 보관 + 화면 전환
  main.ts           부트스트랩
public/sfx/         생성된 효과음 클립 + manifest.json (항상 있어야 함 — {}면 무음으로 동작)
tools/
  gen-assets.mjs    Codex 이미지 생성 파이프라인
  gen-sfx.mjs       ElevenLabs 효과음 생성 파이프라인 (아래 'audio/' 참고)
  smoke.mjs         Playwright 스모크 테스트 (그 밖의 브라우저 도구는 이 문서 맨 끝)
tests/              vitest
```

의존 방향: `scenes → (ui, render, core, logic, data, audio)`, `ui → audio`(Button 탭 소리), `audio → (core/settings, data/sfxMap)`,
`logic → (data 타입, config, rng)`, `data → types`. `audio/`는 PixiJS를 import 하지 않는다.
`logic/`과 `data/`는 `pixi.js`를 import 하지 않는다.

---

## logic/bag.ts

가방 함수는 전달된 `BagState`를 **직접 변경**하고 성공 여부를 반환한다(실패 시 상태 불변).
`items`는 `Record<string, ItemDef>` (보통 `GAME_DATA.items`).

```ts
createBag(cols?: number, rows?: number, stashCapacity?: number): BagState   // 기본 BAG_START_*, STASH_CAPACITY
footprint(def: ItemDef, rot: Rot): { w: number; h: number }                 // 홀수 회전이면 w/h 교환
rotateLocalCell(c: Cell, w: number, h: number, rot: Rot): Cell
  // 회전 전 w×h 프레임의 로컬 칸(바깥 칸도 가능) → 회전 후 로컬 칸.
  // 시계방향 1회: (x, y) → (h-1-y, x), 이후 w/h를 바꿔 rot번 반복.
itemCells(item: BagItem, def: ItemDef): Cell[]           // 가방 절대 좌표
itemSockets(item: BagItem, def: ItemDef): Cell[]         // 소켓 절대 좌표 (가방 범위로 필터하지 않음)
getOccupant(bag, items, x, y): BagItem | null
canPlace(bag, items, defId, x, y, rot, ignoreUid?): boolean   // 범위 안 + 겹침 없음
findFreeSpot(bag, items, defId): { x; y; rot } | null          // rot 0 먼저, 행 우선 탐색, 다음 rot 1
addToStash(bag, defId, tier): StashItem | null                 // 가득 차면 null
addNewToBag(bag, items, defId, tier, x, y, rot): BagItem | null
placeFromStash(bag, items, uid, x, y, rot): boolean
moveItem(bag, items, uid, x, y, rot): boolean                  // 가방 내 이동/회전
moveToStash(bag, uid): boolean                                 // 보관함 가득이면 false
removeByUid(bag, uid): BagItem | StashItem | null
findByUid(bag, uid): { where: 'bag'; item: BagItem } | { where: 'stash'; item: StashItem } | null
areAdjacent(a: BagItem, aDef: ItemDef, b: BagItem, bDef: ItemDef): boolean   // 변 공유(대각 X)
neighbors(bag, items, uid): BagItem[]
findMerges(bag, data: { items; recipes }): MergeOption[]
  // ★합성: defId·tier 같고 tier < MAX_TIER, 변으로 인접한 쌍마다 1개. anchorUid = 더 작은 uid.
  // 레시피: 가방의 base 무기마다, 범위 안 소켓 칸을 차지한 아이템의 defId가 ingredient면 1개.
  // 같은 (kind, anchor, consumed) 중복 없음. 정렬: 레시피 먼저, 그다음 anchorUid 오름차순.
mergesFor(options: MergeOption[], uid: number): MergeOption[]   // anchor 또는 consumed가 uid인 것
applyMerge(bag, data, option, anchorOverrideUid?): BagItem | null
  // 현재 findMerges 결과에 여전히 있는 옵션일 때만 수행.
  // ★합성: 결과는 anchor(또는 쌍 중 override 쪽) 위치·회전·uid 유지, tier+1, 다른 쪽 제거.
  // 레시피: base의 uid·위치·회전·tier 유지하고 defId만 result로, 재료 제거.
expandBag(bag, dir: 'col' | 'row'): boolean     // BAG_MAX_* 초과 시 false. 오른쪽/아래로 늘어남
bagItemsInOrder(bag): BagItem[]                 // y, x 순 (읽기 순서)
```

## logic/stats.ts

```ts
tierMul tables는 config의 TIER_* 사용.
scaledStone(effect: StoneEffect, tier: Tier): StoneEffect    // 수치 × TIER_EFFECT_MUL (element 그대로)
scaledGear(effect: GearEffect, tier: Tier): GearEffect
computePlayerStats(character: CharacterDef, bag: BagState, items): PlayerStats
  // maxHp      = round((baseMaxHp + Σgear.maxHpAdd) × (1 + passive.maxHpMul))
  // moveSpeed  = baseMoveSpeed × (1 + passive.moveSpeedMul + Σgear.moveSpeedMul)
  // regenPerSec= Σgear.regenPerSec
  // goldMul    = 1 + passive.goldMul + Σgear.goldMul
  // damageMul  = 1 + passive.damageMul + Σgear.damageMul
  // cooldownMul= 1 + passive.cooldownMul
  // (gear 수치는 scaledGear 적용 후. 가방(items)에 있는 장비만, 보관함 제외)
stoneBuffsFor(bag, items, uid): { damageMul: number; cooldownMul: number; elements: Element[];
                                  countAdd: number; pierceAdd: number; sourceUids: number[] }
  // uid 무기와 변으로 인접한 stone 아이템들의 scaledStone 합. countAdd/pierceAdd는 합산 후 floor.
computeWeapon(bag, items, uid, player: PlayerStats): WeaponLoadout | null    // 무기가 아니면 null
  // damage   = proj.damage × TIER_DAMAGE_MUL[tier] × (1 + buffs.damageMul) × player.damageMul
  // cooldown = weapon.cooldown × TIER_COOLDOWN_MUL[tier] × max(COOLDOWN_FLOOR_MUL, (1 + buffs.cooldownMul) × player.cooldownMul)
  // count    = proj.count + buffs.countAdd ; pierce = proj.pierce + buffs.pierceAdd
  // elements = 고유 element ∪ buffs.elements (순서: fire, ice, lightning, 중복 제거)
  // explodeRadius = proj.explodeRadius ?? 0 ; split = proj.split ?? null ; spin = proj.spin ?? false
computeLoadout(bag, items, player): WeaponLoadout[]   // bagItemsInOrder 순서의 무기들
itemPrice(def: ItemDef, tier: Tier): number            // def.price × TIER_PRICE_MUL[tier]
sellPrice(def: ItemDef, tier: Tier): number            // max(1, floor(itemPrice × SELL_RATIO))
```

## logic/combat/physics.ts

```ts
circleRectContact(cx, cy, r, rx, ry, rw, rh): { nx: number; ny: number; depth: number } | null
  // 겹치면 원을 밀어낼 단위 법선 + 침투 깊이. 원 중심이 사각형 안이면 최소 침투 축 사용.
reflect(vx, vy, nx, ny): { vx: number; vy: number }      // v·n < 0 일 때만 반사, 아니면 그대로
enforceMinVertical(vx, vy, ratio): { vx: number; vy: number }
  // 속력 유지, |vy| ≥ ratio × speed 보장. vy 부호 유지(0이면 위쪽 = 음수).
circleCircle(ax, ay, ar, bx, by, br): boolean
```

## logic/combat/movement.ts

```ts
interface Mover { x: number; y: number; vx: number; vy: number }   // PlayerEntity가 그대로 맞는다
stepPlayerMotion(m: Mover, tx, ty, hasTarget: boolean, maxSpeed: number, dt: number): void   // 할당 없음, 결정적
  // 목표(이동 범위로 clamp)를 향해 걷는다. 가속도 a = maxSpeed / PLAYER_ACCEL_TIME.
  // 원하는 속도 = 목표 방향 × min(maxSpeed, √(2·a·PLAYER_ARRIVE_BRAKE·d), d/dt) — d = 목표까지 거리
  // 실제 속도는 원하는 속도 쪽으로 스텝당 a·dt까지만(가속·감속·방향 전환 모두). hasTarget이 false면 원하는 속도 0(감속해서 섬).
  // 이번 스텝 이동이 목표를 지나는 평면을 넘으면 목표에 서고 속도 0(지나침·떨림 없음 — 한 스텝 이동 ≤ maxSpeed·dt라 목표 바로 앞에서만).
  // 이동 범위(PLAYER_MIN/MAX_X·Y) 밖이면 벽에 붙이고 그 축의 속도 0. maxSpeed ≤ 0·NaN이면 그 자리에 서고 속도 0.
clampPlayerX(x) / clampPlayerY(y)   // 이동 범위로 clamp (전투 씬의 드래그 목표도 이것으로)
```
- 이동 범위 = 필드 벽 안 어디든: x ∈ [PLAYER_VISUAL_RADIUS, FIELD_W - PLAYER_VISUAL_RADIUS], y ∈ [PLAYER_VISUAL_RADIUS, FIELD_H - PLAYER_VISUAL_RADIUS].
- 밸런스 프로브의 이상적인 회피가 같은 함수로 경로를 미리 굴린다(순간이동 가정 없이 sim과 똑같이).

## logic/combat/sim.ts

필드 좌표: 좌상단 (0,0), 폭 FIELD_W, 높이 FIELD_H. 위·좌·우 벽, 아래는 열림. y는 아래로 증가.

```ts
interface CombatSimOptions {
  stage: StageDef; stageIndex: number;
  enemies: Record<string, EnemyDef>;
  loadout: WeaponLoadout[]; player: PlayerStats; hp: number; seed: number;
}
class CombatSim {
  constructor(opts: CombatSimOptions)
  readonly player: PlayerEntity
  readonly enemies: EnemyEntity[]          // 살아있는 적만 (죽은 적은 스텝 끝에 제거). 렌더러는 id로 diff
  readonly projectiles: ProjectileEntity[] // 살아있는 것만
  readonly enemyShots: EnemyShotEntity[]   // 살아있는 것만
  readonly weapons: WeaponRuntime[]        // loadout 순서
  status: CombatStatus
  lostReason: LostReason | null            // 'hp' | 'breach' | 'contact'
  time: number
  totalEnemies: number
  killedEnemies: number
  step(dt: number, input: CombatInput): void   // status !== 'running'이면 아무것도 안 함
  setLoadout(loadout: WeaponLoadout[], player: PlayerStats): void
    // uid가 같은 무기는 timer 유지(새 cooldown이 더 짧으면 min). 새 무기는 timer = min(cooldown, 0.5).
    // 이번 전투에서 뺐다가 다시 넣은 uid는 남은 시간을 이어서: timer = min(cooldown, 원래 준비 시각 - 지금)
    //   (빼고 넣기로 쿨타임을 초기화하는 악용 방지)
    // 연사 대기열(아래 '연사')은 uid가 새 loadout에 남아 있을 때만 유지 — 빠진 무기의 남은 발은 버린다.
    // maxHp 변화: hp += max(0, 새 maxHp - peakMaxHp); peakMaxHp = max(peakMaxHp, 새 maxHp); hp는 새 maxHp로 clamp.
    //   peakMaxHp = 이번 전투에서 도달한 최대 maxHp(시작값 = 시작 maxHp) → 냄비 뚜껑을 빼고 다시 넣어도 회복되지 않음
  drainEvents(): CombatEvent[]                 // 쌓인 이벤트 반환 후 비움
  progress(): number                           // killed / total
  debugKillAll(): void   // 디버그: 남은 적 전부를 정상 처치 경로로 kill('kill' 이벤트들) → 'won'. running이 아니면 무시
  debugLose(): void      // 디버그: status 'lost', lostReason 'hp', 'lost' 이벤트. running이 아니면 무시
}
// 조준 (sim과 전투 씬이 함께 씀)
FIRE_OFFSET_Y = 30                         // 발사점 = (player.x, player.y - 30)
clampAim(angle: number): number
  // 위쪽 반원 [-(π - AIM_MIN), -AIM_MIN]으로 (AIM_MIN = AIM_MIN_DEG). 범위 밖은 cos ≥ 0이면 -AIM_MIN,
  // 아니면 -(π - AIM_MIN). 2π 넘게 돈 값도 받음. 유한하지 않으면 -π/2.
traceAim(x, y, angle, r, enemies, maxLen, maxSegments, out, res: AimTrace): AimTrace   // AimTrace { points; hitId }
  // 조준 가이드 경로(렌더 전용). 반경 r 공이 좌·우·상단 벽에서 sim과 같은 반사(bounceVelocity: 반사 + 수직 보정)로
  // 꺾이며, 처음 닿는 적(보이는 살아있는 적, r만큼 '둥글게' 넓힌 사각형 = 실제 원-사각형 충돌과 같은 모양 — 모서리를 스쳐
  // 지나갈 공을 닿는다고 그리지 않는다) / 선분 maxSegments개 / 길이 maxLen / 바닥 아래에서 끝.
  // 꼭짓점을 out[2i], out[2i+1]에 씀 (out 길이 ≥ 2(maxSegments+1)). hitId = 닿은 적 id 또는 -1.
chillResistant(def: Pick<EnemyDef, 'w' | 'h' | 'boss'>): boolean
  // 냉기 저항: 보스이거나 2칸 이상(w×h > 1 — 곰인형 같은 엘리트, 전투 씬의 처치 연출 등급과 같은 기준)
```

`CombatInput = { targetX: number | null; targetY: number | null; aimAngle?: number | null }`
- `targetX/targetY`: 플레이어가 걸어갈 목표 위치(필드 좌표). sim이 이동 범위로 clamp하고 `stepPlayerMotion`으로 움직인다(바로 가지 않는다).
  둘 다 null(또는 유한하지 않음) = 목표 없음 → 감속해서 선다. 한 축만 주면 다른 축은 지금 위치.
- `aimAngle`: 수동 조준각(라디안, 필드 좌표 atan2: 0 = 오른쪽, -π/2 = 바로 위). sim이 매 스텝 `clampAim`.
  null/생략/유한하지 않음 = 자동조준(기존 동작 그대로 — 밸런스 프로브와 기존 테스트가 쓴다).

동작 규칙(요약, 세부 수치는 config.ts):
- 초기 배치: `rows[i]`의 칸 (col, i) → 칸 top = `-(i+1)×CELL - SPAWN_GAP`. h>1 적은 좌하단 문자 기준으로
  위로 h칸: top = `-(i+h)×CELL - SPAWN_GAP`. 충돌 박스는 칸 영역에서 ENEMY_INSET만큼 안쪽.
  HP = round(def.hp × stage.hpMul).
- 하강: 모든 적 y += descentSpeed × dt. 화면에 보이는(y+h > 0) 적이 없으면 × DESCENT_FAST_FORWARD.
- 방어선: 살아있는 적의 y+h ≥ FIELD_H → `lost('breach')`.
- 플레이어: `stepPlayerMotion(player, 목표, 목표 있음, stats.moveSpeed, dt)` — PlayerEntity의 vx·vy가 속도.
  시작 위치 (FIELD_W/2, PLAYER_START_Y), 속도 0. 재생, 무적 시간 감소.
- 무기: timer -= dt. timer ≤ 0이면 보이는 적(y+h > 0)이 있을 때만 발사 후 timer += cooldown
  (timer < 0 이면 0으로 보정 후 더함), 없으면 timer = 0 유지(수동 조준이어도 대기).
  발사 위치 (player.x, player.y - FIRE_OFFSET_Y). 방향:
  - 수동 조준(input.aimAngle 유한): clampAim(aimAngle) 그대로, **지터 없음**. count발 spreadDeg 부채꼴도 조준각 중심이고
    발마다 clampAim(낮게 쏠 때 아래를 향하는 바깥 발은 수평 끝으로 접힘 — 바닥으로 버려지지 않게. 가운데 발은 조준각 그대로).
    플레이어가 움직여도 방향은 그대로(발사점만 따라감).
  - 자동조준(null/생략): 대상(보이는 적 중 y+h 최대, 동률은 |x중심-플레이어x| 최소) 방향, 각 발 ±2° 시드 지터.
  'fire' 이벤트 1개 (count = 발사 수).
- 연사: count > 1 이고 spreadDeg = 0 이면(예: 분신 거울을 붙인 단발 무기) 첫 발만 즉시 쏘고 나머지 count-1발은
  BURST_INTERVAL(0.07초, sim 내부 상수) 간격으로 대기열에서 차례로 나간다. 각 발은 나가는 순간의 방향과
  플레이어 위치를 다시 잡는다: 수동 조준이면 그 스텝의 조준각(지터 없음), 자동조준이면 그 순간의 대상
  (대상이 없으면 직전 방향, ±2° 지터). 발마다 'fire'(count 1). 쿨타임은 첫 발 기준.
  각 발의 스탯은 나가는 순간 장착된 같은 uid 무기의 loadout 기준(남은 발 수는 큐에 넣을 때 정해짐).
  대기열은 무기 단계 직전에 처리(같은 스텝에 새로 생긴 연사는 다음 스텝부터 시간이 흐름).
- 투사체: 서브스텝 n = clamp(ceil(speed×dt / (radius×0.8)), 1, MAX_SUBSTEPS).
  벽 반사(좌·우·상단) / 적 충돌: pierceLeft > 0 이면 관통(같은 적 재타격은 PIERCE_REHIT_TIME 후),
  아니면 피해 + 반사 + 밀어내기. 반사할 때 bouncesLeft가 0이면 소멸(피해는 줌), 아니면 1 감소.
  반사 후 enforceMinVertical(MIN_VERTICAL_RATIO). y - r > FIELD_H 이면 소멸. age > 수명 상한이면 소멸 —
  무기 발사 PROJECTILE_MAX_AGE, 분열 자식 SPLIT_CHILD_MAX_AGE (sim 내부 Projectile.maxAge, 없으면 PROJECTILE_MAX_AGE).
  maxBounces 0(무제한) 무기에 기본 반사 상한은 없다 — 수명 상한이 갇힌 공을 정리한다.
  브로드페이즈: 적을 열(column) 버킷으로 나눠 투사체 x 범위의 열만 검사.
- 피해: dmg × (chillTime > 0 ? CHILL_DAMAGE_TAKEN_MUL : 1).
  보스 연타 감쇠: 투사체 직접 적중(projectileHit)이 보스이고 같은 투사체가 BOSS_REHIT_WINDOW 안에 보스를 이미 때렸으면 직접 피해 dmg ×
  BOSS_REHIT_DAMAGE_MUL (sim 내부 Projectile.bossHitAt = 마지막 보스 직접 적중 시각, 적중마다 갱신). 보스만 — 다른 적은 그대로.
  연쇄·폭발 피해는 원래 dmg 기준(둘 다 맞은 적 자신은 제외라 보스 직접 피해와 겹치지 않음).
  불 → burnDps = max(burnDps, dmg×BURN_RATIO), burnTime = BURN_DURATION.
  얼음 → chillTime = CHILL_DURATION (냉기 중 공격 타이머가 느리게 흐름 — 아래 '적 공격').
  번개 → CHAIN_RANGE 내 다른 적 최대 CHAIN_TARGETS에게 dmg×CHAIN_DAMAGE_MUL (연쇄의 연쇄 없음), 'chain' 이벤트.
  폭발 → 반경 내 다른 적에게 dmg×EXPLODE_DAMAGE_MUL, 'explode' 이벤트(element = 폭발이 옮기는 불/얼음 또는 null — 연출 전용).
  분열 → 첫 적중 시 반사된 진행 방향 중심 60° 부채꼴로 split.count개 자식(분열 없음, pierce 0, maxBounces 무제한,
  수명 SPLIT_CHILD_MAX_AGE).
- 적 공격: y+h > 40 이면 attackTimer -= dt × (chillTime > 0 ? 냉기 속도 : 1), 0 이하면 발사 후 interval로 리셋.
  냉기 속도 = CHILL_ATTACK_RATE(일반 적), chillResistant(def)(보스 또는 2칸 이상 적 = 엘리트)면 CHILL_ATTACK_RATE_RESIST — 생성 때 정해 둔다.
  냉기는 공격을 멈추지 않는다(chillTime은 그 스텝에 먼저 줄인 뒤 본다). RNG를 쓰지 않으므로 결정성은 그대로.
  초기 attackTimer = interval + rng×jitter. 발사 원점 = 적 중심 하단. 피해 = attack.damage × stage.dmgMul.
  aimed = 플레이어 방향, straight = 아래, spread = 플레이어 방향 중심 count발 부채꼴.
- 적 탄: 플레이어(hitRadius)와 겹치고 invuln ≤ 0 이면 피해 + invuln = PLAYER_INVULN_TIME ('playerHit' source 'shot'). 필드 밖이면 소멸.
- 스텝 끝 판정(순서대로, 하나만): 살아있는 적의 충돌 박스와 플레이어 피격 원(hitRadius)이 겹치면 `lost('contact')` — 피해 없이 즉시,
  무적 시간과 무관(이번 스텝에 죽은 적은 이미 alive false라 제외) → hp ≤ 0 이면 `lost('hp')` → 모든 적 처치면 `won`. 판정 후 status 고정.
  (방어선은 스텝 처음, 하강 직후.)
- 결정성: 모든 랜덤은 seed로 만든 Rng. 같은 seed + 같은 입력 시퀀스 → 같은 결과.
- 구현 메모(할당): 투사체 객체는 발사·분열 모두 같은 필드 순서로 만든다(선택 필드 lastHit/passing/ghost/trapBounces/bossHitAt도 undefined로
  미리) — 모양이 갈라지면 V8이 메가모픽 쓰기로 p.x 갱신마다 숫자 상자를 할당했다(시뮬레이션 할당의 ~95%). 접촉·반사 계산은
  재사용 임시 객체에 쓰는 `circleRectContactInto` / `bounceVelocityInto`(physics.ts와 비트 단위로 같음, tests/sim-alloc.test.ts),
  배열 순회는 인덱스 루프. 결과는 전과 같다(긴 시드 런 22개의 직렬화 해시 비교).

## logic/run.ts

`data: GameData`를 인자로 받는다. RNG는 `new Rng(run.rngState)` 사용 후 `run.rngState = rng.state`로 되돌려 저장.

```ts
newRun(data, characterId, seed): RunState
  // createBag + 캐릭터 startItems 배치, hp = maxHp, gold 0, stageIndex 0, resumeAt 'combat',
  // shop = { slots: [null×SHOP_SLOTS], rerollCost: SHOP_REROLL_BASE, healBought: false }
runCharacter(data, run): CharacterDef
runPlayerStats(data, run): PlayerStats
runLoadout(data, run): WeaponLoadout[]
currentStage(data, run): StageDef
combatSeed(run): number                    // run.seed와 stageIndex로 결정
rewardKill(data, run, enemyDefId): KillReward
  // g = def.gold × goldMul (소수 가능) → gold = floor(g) + (rng.chance(g - floor(g)) ? 1 : 0) (0도 가능, RNG 매번 1회) 지급, stats.kills++, stats.goldEarned 누적.
  // def.dropChance 확률로 드롭 굴림(rollDropItem). 보관함 가득이면 sellPrice만큼 골드로 환전.
rollDropItem(data, stageIndex, rng): { defId: string; tier: Tier } | null   // 상점과 같은 희귀도 규칙, tier 1
completeStage(data, run, hpAfterCombat): { clearGold: number; healed: number; finished: boolean }
  // run.hp = hpAfterCombat, clearGold×goldMul 지급, maxHp×STAGE_CLEAR_HEAL_RATIO 회복,
  // stats.stagesCleared++, stageIndex++. 마지막 스테이지가 아니면 rollShop(잠금 유지),
  // rerollCost = SHOP_REROLL_BASE, healBought = false, resumeAt = 'shop'.
isRunComplete(data, run): boolean          // stageIndex >= stages.length
isRunValid(data, run): boolean
  // 캐릭터·가방/보관함/상점 아이템 id가 data에 있고, 가방 아이템이 범위 안·겹침 없음, stageIndex < stages.length.
  // (bag/stats는 모르는 defId에 throw 하므로, 아이템 id가 바뀐 옛 세이브를 여기서 거른다)
clampRunHp(data, run): void                // hp > maxHp 이면 maxHp로. 전투 밖에서 가방이 바뀐 뒤(상점 판매·보관함 이동) 호출
saveRun(run): void ; loadRun(data?: GameData): RunState | null ; clearRun(): void
  // localStorage(SAVE_KEY). 모든 접근 try/catch. version !== SAVE_VERSION 이거나 모양이 깨졌으면 null.
  // data를 넘기면 isRunValid도 확인해 실패 시 null (게임 코드는 항상 data를 넘긴다).
```

## logic/shop.ts

```ts
rollShop(data, run, keepLocked = true): void
  // 잠긴 칸은 유지(잠금 해제는 하지 않음), 나머지 칸 새로 굴림:
  // 희귀도 = SHOP_RARITY_WEIGHTS[min(stageIndex, len-1)] → 그 희귀도 중 shopWeight>0, minStage ≤ stageIndex 아이템을
  // shopWeight 가중치로. 해당 희귀도에 후보가 없으면 전체 후보에서. stageIndex ≥ 3이면 10% 확률로 ★2.
  // price = itemPrice(def, tier)
rerollShop(data, run): boolean        // gold ≥ rerollCost 이면 차감, rollShop, rerollCost++
buySlot(data, run, index): boolean    // 골드·보관함 확인 → addToStash, 칸 null
toggleLock(run, index): void
sellItem(data, run, uid): number      // 가방/보관함에서 제거하고 sellPrice 지급, 실패 0
bagExpandCost(run): number | null     // 지금까지 확장 횟수로 BAG_EXPAND_COSTS 조회, 최대면 null
buyBagExpand(run, dir: 'col' | 'row'): boolean
canBuyHeal(data, run): boolean        // !healBought && hp < maxHp && gold ≥ HEAL_COST
buyHeal(data, run): boolean           // maxHp × HEAL_RATIO 회복
```
확장 횟수 = (cols - BAG_START_COLS) + (rows - BAG_START_ROWS).

---

## data/

- `items.ts` → `export const ITEMS: Record<string, ItemDef>`
- `recipes.ts` → `export const RECIPES: RecipeDef[]`
- `enemies.ts` → `export const ENEMIES: Record<string, EnemyDef>`
- `stages.ts` → `export const STAGES: StageDef[]`
- `characters.ts` → `export const CHARACTERS: Record<string, CharacterDef>`
- `assets.json` → `AssetDef[]` (에셋 키의 단일 출처)
- `index.ts` → `export const GAME_DATA: GameData; export const ASSETS: AssetDef[]; export const ASSET_MAP: Record<string, AssetDef>`

### 콘텐츠 목록 (id 고정)

캐릭터: `penguin`(펭구, char_penguin), `capybara`(카피, char_capybara), `cat`(냥냥, char_cat)

기본 무기
| id | 이름 | 크기 | 희귀도 | 아이콘 / 투사체 | 특징 |
|---|---|---|---|---|---|
| w_hairball | 털뭉치 | 1×1 | common | proj_hairball / proj_hairball | 기본 반사 |
| w_fish | 냉동 생선 | 2×1 | common | proj_fish / proj_fish | 묵직, 느린 쿨 |
| w_yuzu | 유자 | 1×1 | common | proj_yuzu / proj_yuzu | 빠른 쿨, 약함 |
| w_sock | 냄새나는 양말 | 1×1 | common | proj_sock / proj_sock | 관통 1 |
| w_duck | 고무오리 | 1×2 | rare | proj_duck / proj_duck | 첫 적중 시 새끼오리 3 분열(proj_duckling) |
| w_toaster | 토스터 | 2×2 | rare | item_toaster / proj_toast | 토스트 3발 부채꼴 |
| w_whoopee | 방귀 쿠션 | 2×1 | rare | item_whoopee / proj_fart | 무한 관통, 느림, 약함 |
| w_watermelon | 수박 | 2×2 | epic | proj_watermelon / proj_watermelon | 크고 강함, 폭발 |

진화 무기 (shopWeight 0)
| id | 이름 | 레시피 | 크기 | 희귀도 | 아이콘 / 투사체 |
|---|---|---|---|---|---|
| w_tuna_missile | 냉동 참치 미사일 | w_fish + s_ice | 2×1 | epic | proj_tuna / proj_tuna (얼음, 관통 1) |
| w_static_hairball | 정전기 털뭉치 | w_hairball + s_lightning | 1×1 | epic | proj_static_hairball (번개) |
| w_yuzu_molotov | 유자 화염병 | w_yuzu + s_fire | 1×1 | epic | proj_yuzu_molotov (불, 폭발) |
| w_sock_gatling | 양말 개틀링 | w_sock + s_haste | 1×1 | epic | item_sock_gatling / proj_sock (초고속 쿨) |
| w_mama_duck | 엄마 오리 | w_duck + s_power | 1×2 | legendary | proj_mama_duck / 분열 5 proj_duckling |
| w_flame_toaster | 불꽃 토스터 | w_toaster + s_fire | 2×2 | legendary | item_flame_toaster / proj_flame_toast ×5 (불) |
| w_methane_bomb | 메탄 폭탄 | w_whoopee + s_fire | 2×1 | legendary | item_methane_cushion / proj_methane (무한 관통 + 폭발 + 불) |
| w_melon_bingsu | 수박 빙수 | w_watermelon + s_ice | 2×2 | legendary | proj_bingsu (얼음, 큰 폭발) |

돌 (1×1): `s_power` 공격 강화석(common, 데미지+25%), `s_haste` 태엽(common, 쿨-15%),
`s_fire`/`s_ice`/`s_lightning` 속성석(rare, 속성 부여 + 데미지+10%), `s_mirror` 분신 거울(epic, 발사 수+1),
`s_drill` 드릴 비트(rare, 관통+1). 아이콘 `item_<id>`.

장비: `g_potlid` 냄비 뚜껑(1×2, common, 최대HP+25), `g_sneakers` 운동화(1×1, common, 이동+20%),
`g_bandage` 반창고(1×1, rare, 초당 1 회복), `g_piggybank` 돼지 저금통(1×1, rare, 골드+25%). 아이콘 `item_<id>`.

적: `soldier` 태엽 병정(1×1, 기본), `block` 블록 골렘(1×1, 단단), `dartgun` 다트총 병정(1×1, aimed 다트),
`robot` 깡통 로봇(1×1, straight 볼트), `jack` 깜짝 상자(1×1, spread 3 스프링), `balloon` 풍선 강아지(1×1, 약함, 드롭↑),
`teddy` 화난 곰인형(2×2 엘리트, aimed), `boss_robot` 장난감 대왕 로봇(4×3 보스, 톱니 5발 50° 부채꼴). 엘리트·보스는 냉기 저항(`chillResistant`).
스프라이트 `enemy_<id>`, 적 탄 `shot_dart`, `shot_bolt`, `shot_spring`, `shot_gear`.

스테이지 5개 (`st1`~`st5`, 배경 `bg_toyroom`). st5 마지막에 boss_robot.

---

## i18n/ko/

영역별 파일이 `export const <area> = { ... } as const`를 내보내고 `index.ts`가 `export const T = { menu, combat, bag, shop, common }`로 모은다.
`common.ts`: 등급/속성/종류 이름 등 공용. 포맷 함수는 `(n: number) => string` 형태로 넣어도 된다.
설정 창·스피커 버튼 문자열은 `menu.settings`.

## core/

```ts
// app.ts
interface Viewport { width: number; height: number; safeTop: number; safeBottom: number }  // 논리 좌표
interface GameApp {
  app: Application;            // PixiJS v8
  root: Container;             // 논리 좌표계 루트 (스케일/센터링 적용됨). 모든 씬은 여기에 붙는다
  viewport: Viewport;
  onResize(cb: (vp: Viewport) => void): () => void;   // 해제 함수 반환
}
createApp(mount: HTMLElement): Promise<GameApp>
  // 캔버스가 창 전체를 채움. scale = 창폭/720, 논리 높이 H = 창높이/scale을 [DESIGN_MIN_H, DESIGN_MAX_H]로 clamp.
  // 창이 너무 넓으면(H<1280) scale = 창높이/1280, 가로 가운데 정렬(레터박스, UI_COLORS.bg).
  // 너무 길면(H>1560) 세로 가운데 정렬. autoDensity.
  // 렌더 해상도 = settings.quality: 'high' = min(devicePixelRatio, 2), 'low' = min(devicePixelRatio, 1.25)
  //   (core/quality.ts resolutionFor). onSettingsChange로 바로 적용(다음 프레임 resize — 글자는 새 해상도로 다시 래스터화).
  //   첫 실행(localStorage에 설정이 아예 없을 때)만, 코어 ≤ 4 또는 deviceMemory ≤ 3GB면 'low'로 시작하고 저장한다(looksWeak).
  // safe area(env(safe-area-inset-*))를 측정해 논리 좌표로 변환.

// scene.ts
abstract class Scene extends Container {
  abstract readonly sceneName: string     // 예: 'CombatScene'
  abstract layout(vp: Viewport): void     // 진입 직후 + 리사이즈 시
  update(dt: number): void                // 초 단위, 최대 0.1로 clamp
  onEnter(): void
  onExit(): void                          // 리스너/타이머 정리
}
class SceneManager {
  constructor(gameApp: GameApp)
  readonly current: Scene | null
  goto(scene: Scene): void                // 이전 씬 onExit + destroyTree(씬), 짧은 페이드
}
destroyTree(root: Container): void
  // root.destroy({ children: true }) + 트리 안 Graphics가 '자기 것으로 만든' GraphicsContext(new Graphics())도 바로 destroy.
  // pixi v8의 Graphics.destroy(옵션 객체)는 자기 컨텍스트를 렌더러 GC(60초 미사용, 30초마다)까지 남겨 GPU 지오메트리가 쌓였다
  // (측정: 전투→클리어→상점 3바퀴 뒤 고아 컨텍스트 290개·GL 버퍼 379개 → 고치고 1개·114개, 바퀴마다 늘지 않음).
  // 공유 컨텍스트(new Graphics(ctx), menuFx 색종이)는 소유가 아니라 건드리지 않는다. 씬의 destroy 재정의는 그대로 돈다.

// tween.ts  (앱 ticker로 구동)
tween(target: object, to: Record<string, number>, duration: number, ease?: Ease): Promise<void>
  // 대상이 파괴됐거나 null이면(pixi v8의 파괴된 Container.scale은 null) 등록하지 않고 resolve 안 되는 Promise —
  // `.then(() => tween(c.scale, …))`로 이어 건 트윈이 그 사이 파괴된 대상을 받아도 매 프레임 throw 하지 않는다
delay(seconds: number): Promise<void>
killTweensOf(target: object): void
Ease: 'linear' | 'outQuad' | 'inQuad' | 'outBack' | 'outElastic' | 'inOutSine'
// 중첩 속성은 target을 직접 넘긴다 (예: tween(sprite.scale, {x:1.2, y:1.2}, 0.1))

// keyboard.ts
class Keyboard { isDown(code: string): boolean; onPress(code: string, cb: () => void): () => void; dispose(): void }

// fonts.ts
loadFonts(): Promise<void>     // 'Jua'(Google Fonts) 로드 시도, 3초 타임아웃 후 폴백 진행
fontsSettled(): Promise<void>  // Jua 로드가 실제로 끝나는 시점 (타임아웃 뒤일 수도). 늦으면 perf 태그 'fontLate'
fontsReadyInTime(): boolean    // 타임아웃 안에 끝났는가 ; fontsLoaded(): boolean — 늦게라도 끝났는가
FONT_FAMILY: string            // "Jua, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
// pixi의 Text는 폰트가 늦게 와도 스스로 다시 그리지 않는다 → 이미 있는 글자가 전투 중 갑자기 다시 래스터화되는 일은 없다.
// 미리 구운 글자 캐시(Toast)는 폴백 폰트로 구웠으면 fontsSettled 뒤 '메뉴 화면에서만' 다시 굽는다.

// quality.ts (순수)
resolutionFor(quality: Quality, dpr: number): number   // high = min(dpr, 2), low = min(dpr, 1.25)
looksWeak({ hardwareConcurrency?, deviceMemory? }): boolean   // 코어 ≤ 4 또는 메모리 ≤ 3GB (모르는 값은 무시)
```

## render/

```ts
// assets.ts
loadAssets(renderer: Renderer): Promise<void>
  // assets/manifest.json(없으면 빈 manifest) 읽기 → images의 PNG 로드, anims의 스프라이트시트 로드,
  // ASSETS 중 PNG 없는 키는 플레이스홀더 텍스처 생성(도형 + 이모지).
tex(key: string): Texture               // 미등록 키는 경고 1회 + 마젠타 '?' 텍스처
animFrames(key: string, state: AnimState): { frames: Texture[]; fps: number; loop: boolean } | null
hasArt(key: string): boolean            // 실제 PNG가 있는지(플레이스홀더 아님)
loadedTextures(): Texture[]             // 로드된 텍스처 전부 (에셋 + 애니메이션 프레임 + '?')

// gpuWarm.ts
prewarmGpu(renderer, opts?: { extra?: Texture[]; onProgress?(done, total); budgetMs? }): Promise<void>
  // main.ts가 로딩 중에 부른다. loadedTextures()의 소스를 전부 GPU에 올리고(renderer.texture.initSource, 12 ms마다 프레임 양보)
  // autoGarbageCollect = false로 상주시킨다 — pixi 렌더러 GC는 60초 넘게 안 그려진 이미지 텍스처를 내렸다가 다음에 쓸 때
  // 다시 올려서(상점에 오래 있다 전투로 돌아오면) 끊겼다 (에셋 전체 RGBA ~13 MB). 끝으로 스프라이트·그래픽·글자·나인슬라이스·
  // 파티클 컨테이너·타일링·색 행렬 필터를 화면 밖 8×8 텍스처에 한 번씩 그려 셰이더를 미리 컴파일한다.

// actor.ts
class ActorSprite extends Container {
  constructor(key: string, displaySize: number)   // 긴 변을 displaySize(논리 px)에 맞춤
  play(state: AnimState): void
    // 프레임 애니메이션이 있으면 AnimatedSprite 재생, 없으면 코드 애니메이션:
    // idle=느린 위아래 출렁임+숨쉬기 스케일, move=빠른 좌우 기울임, attack=스쿼시&스트레치 팝,
    // hit=흰색 플래시+흔들림, die=납작해지며 페이드(완료 Promise 반환)
  update(dt: number): void
  setTint(color: number): void            // 상태이상 표시용
  readonly baseSprite: Sprite
}
```

## ui/

```ts
textStyle(kind: 'title'|'heading'|'body'|'small'|'number'|'button', overrides?): TextStyleOptions
class Button extends Container {
  constructor(opts: { label: string; width: number; height: number; color?: number; icon?: string /*asset key*/;
                      fontSize?: number; sound?: SfxId | null; onTap: () => void })
  setEnabled(v: boolean): void ; setLabel(s: string): void
}   // 누르면 0.94 스케일, 비활성 시 회색 + 탭 무시. 탭 소리 sound: 기본 'ui_tap', 뒤로 가기 'ui_back',
    // 동작이 따로 소리를 내면(구매·새로고침·회전·합성·가방 닫기 등) null
class Panel extends Container { constructor(w, h, opts?: { color?; border?; radius?; alpha? }); resize(w, h) }
class ProgressBar extends Container { constructor(w, h, color, bg?); setValue(0..1, animate?) }
class Toast {
  static show(parent: Container, text: string, opts?: { color?; y? }): void   // 위로 떠오르며 사라짐 (같은 부모면 위로 쌓임)
  static init(gameApp: GameApp, canBakeInBackground?: () => boolean): void   // main.ts. false인 동안(전투 중) 배경 굽기 쉼
  static prewarm(texts: readonly string[], opts?: { colors?; onProgress?; budgetMs? }): Promise<void>   // 지금 굽기(고정)
  static queuePrewarm(texts: readonly string[], colors?: readonly number[]): void   // 메뉴의 쉬는 프레임에 하나씩(고정)
  static stats(): { labels; pinned; fallbackFont; pills; pool; showing; queued }    // 디버그
}
// 문구마다 글자를 한 번 generateTexture로 구워 캐시(고정 = 미리 굽기 항목, 그 밖은 LRU 64개), 배경은 색마다 구운 알약을
// NineSliceSprite로 늘리고, 스프라이트 묶음은 풀에서 재사용 → 구워 둔 문구의 show()는 스프라이트 배치 + 트윈뿐.
// 굽는 해상도 = 논리 1px의 실제 픽셀 수(root 배율 × 렌더 해상도, 0.25 단위 올림, 1..2) — 폰(dpr 3)에서 1.25.
// 해상도가 바뀌거나(품질·회전) 폰트가 늦게 오면 쓰던 텍스처를 그대로 쓰고 메뉴에서 다시 굽는다(전투 중 굽기 없음).
// toastStrings.ts: combatToastTexts(data)(드롭 '새 아이템! {이름}' 전 아이템 + '보관함이 가득 차서 +{sellPrice(def,1)} 골드'),
//   menuToastTexts(data)(가방·상점 고정 문구, 진화 이름), toastColors(), TOAST_COLORS — 씬의 Toast.show와 같은 포맷터·색.
iconWithCount(key: string, size: number): Container & { setCount(n: number): void }  // 코인 아이콘 + 숫자 등
```

## debug/ (성능 진단)

```ts
// perfOverlay.ts — 폰에서 직접 끊김 원인을 보는 DOM 캔버스 오버레이 (Pixi 밖에서 그림, 100 ms마다 갱신)
installPerf(gameApp): void          // main.ts가 createApp 직후 (렌더러 계측 + 제스처). URL ?perf면 바로 켬
setPerfEnabled(on: boolean): void ; perfEnabled(): boolean
perfMark(tag: string, since?: number): void   // 이번 프레임에 일어난 일. since = perfNow() 값이면 걸린 ms도
perfNow(): number                   // 켜져 있으면 performance.now(), 꺼져 있으면 0
perfReport(): { enabled; fps; frames; hitches: { t; dt; upd; rnd; tags }[] }   // 측정 도구용 (window.__game.perf())
```
- 켜기/끄기: URL `?perf` / 세 손가락 탭 / 화면 왼쪽 위 구석(64px) 3초 안에 5번 탭.
- 보이는 것: FPS, `u`(update ms)·`r`(render ms)·렌더 해상도·GPU 텍스처 수·JS 힙, 최근 3초 프레임 시간 꺾은선(16.7 / 33.3 ms 기준선,
  18 ms 넘으면 노랑·25 ms 넘으면 빨강 막대), 끊긴 프레임(> 25 ms) 최근 8개: `시각 간격ms u r 태그들`.
- 끊김 판정은 '프레임 시작 → 다음 프레임 시작' 간격. 그 사이에 찍힌 태그(직전 프레임의 update·render + 사이의 입력 이벤트)를 붙인다.
  같은 태그는 `text×3 12`(횟수·합계 ms)로 묶는다. 순서는 시간 없는 표시 태그(`goto`, `toast` …)를 먼저, 그다음 시간 있는 태그를 오래 걸린 순 —
  오버레이 한 줄(45자)에서 잘려도 가장 비싼 원인이 보인다. 태그 없는 끊김(`?`)은 대개 JS GC·브라우저·GPU 쪽.
- 자동 태그(렌더러 계측 — 꺼져 있으면 원래 함수만 부름): `upload`(텍스처 GPU 업로드), `text`(글자 캔버스 래스터화), `bake`(generateTexture),
  `gfx`(그래픽 지오메트리 재빌드 0.5 ms 이상), `shader`(셰이더 컴파일), `pixiGC`(렌더러 GC), `goto`/`sceneExit`/`sceneEnter`(씬 전환),
  `toast`/`toastBake`(알림·글자 굽기), `fonts`/`assets`/`gpuWarm`(부팅), `fontLate`(타임아웃 뒤 폰트 도착),
  `sfxDecode`(효과음 클립 하나를 메인 스레드에서 다듬은 시간 — 모노 섞기·자르기·버퍼 복사. 브라우저의 네이티브 디코드 몫은 안 보인다).
- 씬에서 쓰기: `import { perfMark, perfNow } from '../debug/perfOverlay'` → `perfMark('explosion')` 또는
  `const t0 = perfNow(); …; perfMark('bossIntro', t0)`. 꺼져 있으면 즉시 반환·할당 없음 — 태그는 상수 문자열로(문자열 조합 금지).
- `?noprewarm`: GPU 미리 올리기·알림 미리 굽기를 건너뜀 (`?perf&noprewarm`으로 전후 비교).

**성능 측정 메모 (CDP CPU 4·6배 감속, 390×844 dpr2 터치, 시스템 Edge)**
- 아이템 드롭 알림: 예전엔 알림마다 Jua 한글 Text(외곽선·줄바꿈) + Graphics 생성 → 그 프레임에 래스터화·업로드·지오메트리.
  드롭 알림 프레임 work p95/최대 12.9/25.7 ms(4배), 29.9/47.2 ms(6배) → 구운 텍스처 캐시 + 부팅 미리 굽기 후 5.7/9.6, 10.2/14.5
  (그 프레임의 처치 연출 포함). st5 스트레스 가방·드롭 50% 40초(6배): 미리 굽기 없이 25 ms 넘는 끊김 5번(전부 `toast text toastBake`) → 0번.
- 메뉴 씬 GPU 지오메트리 누수: SceneManager가 `destroyTree`로 자기 컨텍스트까지 해제 (위 core/ 참고).
- 부팅: 미리 올리기·굽기로 타이틀 준비가 늦어진다. 프로덕션 빌드(vite preview) 재측정 중앙값: 4배 1.40 → 2.17초(+~0.75초), 6배 ~2.3 → ~3.5초(+~1.1초).
  4배의 ~0.7초는 전투 알림 글자 44개 굽기(개당 ~10 ms), GPU 미리 올리기는 ~0.15초. (처음 보고된 +~180/230 ms는 개발 서버·다른 시작 기준이라 이 값보다 작게 나왔다.) 로딩 막대로 진행 표시.
  줄이려면 알림 글자를 캔버스 아틀라스 한 장에 모아 한 번에 올리는 방법(Toast 재작성). 타이틀이 뜬 직후 메뉴 알림 글자 19개를 프레임당 하나씩 굽는 동안
  4배에서 25 ms 넘는 프레임이 몇 개(2~17) 생긴다 — 굽기 간격을 벌려 봤지만 나아지지 않아 그대로 둠.
- 시뮬레이션: 투사체 객체 모양 통일 + 임시 객체 재사용 → 스텝당 할당 28 KB → 1.5 KB, 스텝 시간 ~1/8 (node, st5 스트레스 가방).
- 남은 것: 전투 진입 한 번에 글자 래스터화가 몰림(4배에서 시작 버튼 프레임 ~150 ms = CombatScene 생성자, 페이드 덮인 교체 프레임
  ~230 ms 중 글자 7개 ~150 ms + 그 업로드 ~75 ms, 인트로 두 프레임 ~35 ms). 페이드 뒤라 대부분 가려지지만, 줄이려면 씬 쪽에서
  전투 HUD·배너 글자를 메뉴에서 미리 굽거나 BitmapText로 바꿔야 한다. pixi 내부 할당(변환 갱신 등)이 페이지 할당의 대부분.

## audio/ (효과음)

Web Audio API만 쓴다. 게임 규칙과 무관한 연출 — 소리가 없어도(파일·manifest 없음, 디코드 실패, 브라우저 미지원) 게임은 그대로 돈다.

```ts
// index.ts — 씬·UI는 이것만 쓴다 (initAudio 전이나 브라우저가 아니면 아무것도 안 함)
sfx.play(id: SfxId, opts?: { volume?: number /*0..1*/; rate?: number; pan?: number /*-1..1*/ }): void
sfx.playAt(id: SfxId, pan = 0, rate = 1, volume = 1): void      // 옵션 객체 없이 (전투처럼 자주 부르는 곳)
sfx.sinceLastPlay(id: SfxId): number                            // 마지막 재생 후 초 (없으면 Infinity)
initAudio(): AudioManager | null   // game.ts의 initGame이 부른다: 제스처 리스너 + settings 연결 + 백그라운드 로드 예약
window.__sfx = { stats(), clips(), resetStats(), loaded(): Promise<void>, play(id, opts?) }   // 측정·디버그
```
- **클립 목록**: `public/sfx/manifest.json` = `{ "<id>": ["<id>_1.mp3", ...] }` (변형 순서). 없음/404/JSON 아님(개발 서버의 index.html)/`{}`
  → 조용히 무음. 모르는 id·파일 실패는 그 클립만 빠진다(경고 1줄). 파일이 늘 있게 `{}`라도 커밋한다(빌드에서 404 콘솔 오류 방지).
- **로드**: 부팅 0.7초 뒤 백그라운드로, 메뉴 소리부터(ui → jingle → reward → hit → fire → enemy). fetch는 3개씩 앞서 받고
  디코드는 하나씩 쉬어 가며. 디코드는 `OfflineAudioContext`(48 kHz)로 — 사용자 제스처 전에도 된다.
  디코드 때 `process.ts`: 모노로 섞기(메모리 절반) → 앞 무음 자르기(-50 dBFS, 4 ms 여유) → 뒤 무음 자르기(-50 dBFS와 피크 기준 -45 dB 중
  낮은 쪽, 20 ms 여유) → 피크를 -3 dBFS로 맞추되 빽빽한 소리는 단기 음량(50 ms RMS 최대)이 -12 dBFS를 넘지 않게 더 줄이고
  (같은 프롬프트의 변형끼리도 8 dB 넘게 차이가 났다) → sfx.json의 `volume` 곱하기 → 앞 2 ms(잘랐을 때만) / 끝 12 ms 페이드.
  소리가 하나도 없는 클립(생성 결과가 무음인 경우가 실제로 있었다)은 등록하지 않고 경고 1줄 — 그 id의 다른 변형만 쓴다.
  그래서 **볼륨 조절은 sfx.json의 volume만 고치면 된다**(다시 생성할 필요 없음). 지금 값은 클립마다 단기 음량을 재서
  목표(발사·속성 -24, 타격 -23, 처치 -22, UI 탭 -22~-23, 보상·축하 -16~-19, 징글 -16~-17, 벽 튕김 -30 dBFS)에 맞춘 것.
- **재생 컨텍스트**: 첫 사용자 제스처(window 캡처: pointerup, 마우스 pointerdown, touchend, keydown — 터치 pointerdown은 활성화가 아니라 건너뜀,
  `navigator.userActivation`이 있으면 확인)에서 `AudioContext`를 만들고 resume + 무음 한 표본(옛 iOS). 리스너는 계속 남아
  iOS 'interrupted'(전화·앱 전환)나 suspended면 다음 제스처에서 다시 resume.
  - **첫 탭 소리**: PixiJS의 window `pointerup` 리스너가 우리 것보다 먼저 등록돼 첫 버튼 소리가 컨텍스트보다 먼저 온다 →
    `play()`가 신뢰된(isTrusted) 탭·키 이벤트 처리 중이면(`AudioEnv.currentEvent` = `window.event`) 거기서 잠금을 푼다. 스크립트가 만든 이벤트는 풀지 않는다.
  - **resume은 제스처마다 다시 부른다**(진행 중인 resume이 있어도) — WebKit은 시작할 수 없는 동안 resume()을 끝내지 않고 붙잡아 두므로
    '진행 중이면 건너뛰기'로 막으면 전화·앱 전환 뒤 소리가 영영 돌아오지 않았다.
  - 컨텍스트가 아직 'running'이 아니면 제스처 resume 뒤 `RESUME_GRACE_SEC`(0.3초) 안의 요청만 예약하고 그 밖(잠금 전·'interrupted')은 버린다
    — 멈춘 컨텍스트에 예약된 소리는 풀리는 순간 한꺼번에 터진다.
  - **탭이 숨으면** 재생 중인 소리를 전부 끊고 suspend(그대로 두면 돌아왔을 때 이어서 나거나 칸 재사용 때 딸깍), 다시 보이면 resume. 숨김 중 요청은 버린다.
  - 디코드는 `OfflineAudioContext`, 없으면 `webkitOfflineAudioContext`(사파리 14.1 전 — 실기기 미검증).
- **그래프**: 소스 → 게인(호출 volume) → [StereoPanner(pan ≠ 0)] → 마스터 게인(settings) → 컴프레서(리미터, -6 dB 12:1) → 출력.
  재생 한 번에 이 노드들 말고는 할당하지 않는다(onended 콜백도 없음 — 칸 재사용 때 정리).
- **마스터**: `settings.muted` / `settings.sfxVolume`(게인 = 볼륨², 15 ms 부드럽게), `onSettingsChange`로 바로 반영.
- **재생 판정** (`scheduler.ts` `VoiceScheduler`, 순서대로 — 어디서든 걸리면 버림):
  음소거 → 디코드된 변형 있음 → id별 `minInterval` → 초당 예산(토큰 버킷 18개/초, 최대 8개 — 카테고리별 남겨 둘 토큰
  `CATEGORY_RESERVE`: fire 3, hit 1, enemy 1, reward 0, ui·jingle 예산 무관) → id별 `maxVoices`(넘으면 그 소리 중 가장 오래된 것을 12 ms에
  줄이며 끊음) → 전역 상한 24(빈 칸이 없으면 우선순위가 같거나 낮은 것 중 가장 오래된 것을 끊음, 다 높으면 버림) →
  변형 무작위(직전과 같은 것 회피) → 재생 속도 = 호출 rate × (1 ± pitchVar).
  우선순위 `CATEGORY_PRIORITY`: jingle 5 > ui 4 > reward 3 > enemy 2 > hit 1 > fire 0. id별 예외 `SFX_OVERRIDES`
  (처치·폭발·피격은 타격음보다 앞, 벽 튕김은 발사음과 같은 맨 뒤, `item_drop`은 초당 예산 밖 — 3배속 전투에서 콤보·동전·처치음이 마지막 토큰을
  써서 드롭 소리가 빠졌다; 드롭은 minInterval 0.2초·동시 1개라 드물다). 측정(실제 클립, st5 무기 10종 스트레스 가방, 14초): 초당 평균 17, 1초 창 최대 25, 동시 최대 14,
  출력 피크 -6.5 ~ -10 dBFS(리미터 전에 이미 여유), RMS 약 -25 dBFS (기본 볼륨 0.8). 3배속 보스전: 요청 초당 최대 193 → 재생 15~23/s
  (설계대로 많이 버림: kill_pop 요청 102 중 24 버림, fire_fish 113 중 3만 재생 — 1배속에선 예산 때문에 빠진 처치음 없음).
- **성능**: 오디오 코드는 6배 감속 보스전 메인 스레드의 ~1.9%(1배속 프레임당 ~0.05 ms, 대부분 소스·게인·패너 노드 생성).
  디코드는 타이틀 뒤 ~0.5초에 시작해 64클립 ~1.4초(4배)/~2~2.5초(6배), 클립당 JS 몫 2~13 ms(6배) — 나머지는 브라우저의 네이티브
  decodeAudioData. 그 사이(타이틀 뒤 2~4초 안)에 전투를 시작하면 6배에서 25~70 ms 프레임이 1~6개 있었다(4배는 영향 없음 — 느린 폰이면 다듬기를 Worker로).
  디코드한 PCM(모노 float, 48 kHz, 42.5초) 7.8 MB.

**연결** (매핑과 연출 수치는 `data/sfxMap.ts`):
- 전투(`CombatScene`): fire → 무기 계열 발사음(`weaponFireSfx`: 진화 무기는 레시피의 기본 무기 계열), 좌우 = 필드 x(`COMBAT_PAN` ±0.3) /
  직접 타격 → hit_toy, 피해 ≥ `HEAVY_HIT_DAMAGE`(40) × stage.hpMul 이면 hit_heavy, 속성이면 elem_fire/ice/zap을 겹침 / 가장자리가 아닌 적중(관통 중) → 작은 hit_toy /
  chain → elem_zap / explode / split / bounce(벽) → bounce_wall / kill → kill_pop · kill_elite(2×2) · boss_kill (보이는 적만) /
  enemyShoot → 적 탄 그림별 enemy_shoot_*(`ENEMY_SHOT_SFX`) / playerHit → player_hurt / 동전이 HUD에 닿음 → coin(`COIN_STREAK_WINDOW` 안에
  연달아 오면 반음씩, 최대 7) / 드롭 → item_drop(보관함 가득 → coin) / 백어택 콤보 → combo(콤보마다 반음, 최대 10) /
  인트로 배너 → stage_start / 보스 배너 → boss_appear / 방어선 위험이 새로 시작 → danger(`DANGER_REPEAT` 6초에 한 번) /
  won → stage_clear / lost → defeat / 가방 열기·닫기 → bag_open / bag_close.
- 가방(`BagView`): 집기 item_pick, 놓기(격자·보관함·자동 배치) item_place, 회전 item_rotate, 안 됨(못 놓음·보관함 가득·회전 불가·빈자리 없음·판매 실패) ui_error,
  ★합성 merge_tier, 레시피 진화 merge_evolve, 판매 ui_sell, 판매 칸 첫 탭(확인 대기) ui_tap, 아이템 선택 탭 작은 ui_tap.
- 상점: 카드 선택 ui_tap, 구매 ui_purchase / 실패 ui_error, 새로고침 ui_reroll / 실패 ui_error, 잠금 ui_lock, 가방 확장 bag_expand, 회복 heal.
- 메뉴: Button 기본 ui_tap(뒤로 가기·아니요·닫기·타이틀로 = ui_back), 캐릭터 카드 고르기 ui_tap, 스테이지 클리어 카운트업 = 작은 coin 틱
  (`COUNT_TICK_INTERVAL` 0.07초, 끝으로 갈수록 음이 오름, 건너뛰면 없음), 결과 화면 승리 victory_run / 패배 defeat(전투에서 5초 안에 울렸으면 생략).
- 설정 UI(`scenes/settingsUi.ts`): 타이틀 오른쪽 위 '설정' → 창(효과음 켜기/끄기, 볼륨 5단계 −/+, 그래픽 품질 높음/낮음 = `settings.quality`).
  `SoundToggle`(스피커 버튼): 전투 가방 오버레이('계속하기' 오른쪽)와 상점 상단 바 오른쪽 끝. 값은 `updateSettings`로만 바꾼다.

**생성** (`tools/gen-sfx.mjs`, `npm run gen:sfx`): ElevenLabs `POST /v1/sound-generation?output_format=mp3_44100_128`
(`{ text: prompt, duration_seconds: duration (0.5..22로 clamp), prompt_influence: influence, model_id: 'eleven_text_to_sound_v2' }`) →
`public/sfx/<id>_<n>.mp3` + manifest(다룬 id만 디스크 상태로 다시 계산해 병합, 정렬). 키는 `process.env.ELEVENLABS_API_KEY` 또는 `.env`(출력 안 함).
있는 파일은 건너뜀(`--force`로 다시), 임시 파일 → 성공 시 rename(Windows EPERM/EBUSY는 잠깐씩 기다리며 재시도, manifest 쓰기 실패는 실행을 멈추지 않음 —
실패한 실행은 기존 파일·manifest 그대로), 429/5xx·네트워크 오류는 지수 백오프 재시도(`Retry-After`가 있으면 백오프와 더하지 않고 둘 중 긴 쪽)
(200인데 본문이 MP3가 아니면 크레딧이 나갔을 수 있어 재시도하지 않음), 401/402/403은 즉시 멈춤. 응답 헤더 `character-cost` 합을 마지막에 출력,
`--budget N`(예산 — 나가 있는 요청의 예상 비용도 셈), `--max-rate N`(3클립 뒤 초당 크레딧이 N보다 높으면 멈춤, 기본 25 — 측정값 약 10).
`--dry-run`(API 호출 없음) · `--mock`(크레딧 없이 합성 WAV 자리표시 `<id>_<n>.wav`) · `--no-env-file` · `--only` · `--category` ·
`--concurrency`(기본 2) · `--out` · `--api-base`(시험용 가짜 서버 — 공식 주소가 아니면 .env를 읽지 않음) · `--env-file <path>`(시험용 키 파일 — 가짜 서버와도 읽음).
- 키: `.env`는 UTF-8·UTF-8(BOM)·UTF-16(PowerShell 5.1 `echo > .env`) 모두 읽는다. 키는 출력하지 않고, 이 도구가 내는 모든 출력에서 `***`로 가린다
  (서버가 오류 본문에 키를 되돌려 보내도). 만들 클립이 있는데 키가 없으면 API를 부르기 전에 한국어+영어 안내와 함께 종료 코드 1(기존 클립 그대로).
  만들 클립이 없으면(전부 있음) 키 없이도 manifest만 맞추고 0.
- 키에 `user_read` 권한이 없으면(지금 키가 그렇다) 계정·크레딧 조회 API는 401 — 효과음 생성은 된다. 남은 크레딧은 ElevenLabs 웹에서 본다.
- **첫 실제 생성 (2026-10-10)**: 64클립 50.4초 = **504 크레딧** + 무음으로 온 `enemy_shoot_dart_1` 프롬프트를 고쳐 `--only enemy_shoot_dart --force`로
  다시 5 = 합계 **509**. 원본이 아주 작아 디코드 때 21~26 dB 키우는 클립(잡음은 소리보다 34~52 dB 아래라 쓸 만함 — 들어 보고 얇으면 다시 생성,
  0.5초 클립 하나 약 5 크레딧): `enemy_shoot_dart_1`(원본 피크 -29.3 dBFS), `bounce_wall_1`(-28.8), `bounce_wall_2`(-27.5), `combo_1`(-26.8), `hit_toy_3`(-24.5).

## scenes/ (2차)

```ts
// game.ts
interface StageSummary { stageIndex: number; kills: number; goldEarned: number; drops: { defId: string; tier: Tier }[];
                         clearGold: number; healed: number; finished: boolean }
interface RunResult { won: boolean; stageIndex: number; characterId: string; stats: RunStats }
interface Game {
  readonly gameApp: GameApp; readonly data: GameData; readonly scenes: SceneManager;
  run: RunState | null;
  toTitle(): void; toCharacterSelect(): void;
  startRun(characterId: string): void;   // newRun → saveRun → toCombat
  continueRun(): void;                   // loadRun(data) → resumeAt에 따라 toShop / toCombat (null이면 새 게임 취급)
  toCombat(): void;                      // resumeAt='combat' 저장 후 전투
  toStageClear(summary: StageSummary): void;
  toShop(): void;                        // resumeAt='shop' 저장. 상점에서 가방이 바뀔 때마다 clampRunHp
  toResult(result: RunResult): void;     // clearRun
}
initGame(gameApp: GameApp): Game ; export let game: Game

// bag/BagView.ts — 전투 일시정지 오버레이와 상점이 함께 쓴다
interface BagViewOptions {
  mode: 'combat' | 'shop';
  data: GameData; run: RunState;
  width: number;                   // 보통 720
  onChange?: () => void;           // 배치/합성/판매로 가방이 바뀔 때마다
  sellZone?: boolean;              // 상점에서만 true
}
class BagView extends Container {
  constructor(opts: BagViewOptions)
  refresh(): void                  // 외부에서 가방/보관함이 바뀌었을 때 (구매 등)
  readonly contentHeight: number   // 레이아웃 계산용 (툴팁 + 격자 + 버튼)
  destroy(options?): void
  // ── 구현 후 추가된 공개 API ──
  // opts.onSelect?: (uid: number | null) => void
  selectUid(uid: number | null): void ; readonly selected: number | null
  showTooltipFor(defId: string, tier: Tier): void ; clearPreview(): void   // 상점 카드 미리보기
  stashSlotCenter(index: number): Point ; readonly stashSlotSize: number  // 구매 비행 연출 목표(로컬 좌표)
  setItemVisible(uid: number, visible: boolean): void ; bounce(uid: number): void ; celebrateGrid(): void
  readonly isDragging: boolean
}
// BagView는 자기 입력(R 키, 드래그 중 Esc 취소, 우클릭·두 번째 손가락 회전 — window 리스너)과
// 프레임 애니메이션(onRender)을 스스로 처리한다. 호스트는 update()를 부를 필요 없고 destroy()로 리스너가 해제된다.
// 자신이나 조상이 visible=false면 키 입력을 무시한다.

// combat/CombatScene.ts 공개 메서드 (디버그/스모크용)
debugWin(): void ; debugLose(): void ; setSpeed(mul: number): void ; refresh(): void
debugState(): { playerX; playerY; playerVx; playerVy; moveSpeed; targetX; targetY /* 지금 걸어가는 목표, 없으면 null */;
                hp; maxHp; status; lostReason; phase; time; kills; totalEnemies; bagOpen; speed; weaponUids;
                aimAngle; dragging; pointers; recentShots: { id; weaponUid; x; y; vx; vy; age }[] /* 나이 ≤ 0.12초 */;
                hits; behindHits; topHits; frontTop; frontCount;
                combo; bestCombo; fxParticles; trauma; hitStop }   // 연출 측정용: '백어택' 콤보 지금/최고, 살아있는 이펙트 파티클,
                                                                   // 화면 흔들림 트라우마(0..1), 남은 히트스톱(초)
  // 틈 쏘기 통계 (tools/gap-playtest.mjs가 읽음): hits = 이번 전투 hit 이벤트 수(화상·연쇄·폭발 포함).
  // 맨 앞 웨이브 = 가장 아래 살아있는 적의 줄부터 빈 줄 없이 이어진 줄들(화면 밖 줄 포함), frontTop = 그 맨 윗줄의 위 칸 경계
  // (웨이브가 다 들어오기 전엔 음수), frontCount = 그 웨이브의 적 수. behindHits = 적중점이 frontTop + ENEMY_INSET 이상(위),
  // topHits = 적중점이 적의 윗변(공 중심이 그 적보다 위 — 모든 적이 같은 칸 격자라 윗변 격자와 같은 y인지로 판정).
```

**CombatScene 입력** (모든 입력은 `CombatInput`으로 수렴, 규칙 판정은 sim):
- 씬 상태 `aimAngle`(시작 -π/2, 항상 `clampAim` 끝난 값)을 매 스텝 `input.aimAngle`로 넘긴다.
- 화면 전체를 덮는 바탕(catcher)이 포인터를 `pointerId`별로 추적: 누르면 `pending`.
  `TAP_SLOP`(논리 px)을 넘게 움직이면 — 드래그 중인 포인터가 없으면 `drag`(그 순간 기준점을 다시 잡음 → 상대 이동),
  있으면 `aim`(필드 안에서 그 손가락을 따라 조준). 떼면: `drag` → 드래그만 끝(목표는 그대로 — 캐릭터가 놓은 자리까지 걸어가 선다),
  `pending`/`aim` → 뗀 점을 향해 조준
  (필드 + 테두리 벽 안일 때만, 캐릭터 중심에서 `AIM_TAP_BODY_RADIUS`(= 보이는 크기의 반) 밖이고 발사점에서
  `AIM_TAP_MIN_DIST` 이상 떨어졌을 때만) + 고리 펄스. move 없이 TAP_SLOP 넘게 떨어진 곳에서 뗀 `pending`은 탭이 아니다.
  pointerupoutside / pointercancel / 네이티브 pointercancel → 그 포인터만 조준 없이 정리. 창 blur·탭 숨김(visibilitychange)·
  가방 열기·승패 → 전부 정리. 전투 중에는 window `contextmenu`를 막는다(onEnter/onExit에서 등록/해제).
  마우스는 왼쪽 버튼만. 키보드: 방향키/WASD 이동(목표 = 캐릭터 앞 KEY_MOVE_LEAD, 떼면 목표 없음 → 감속해서 섬),
  Q/E · `,`/`.` 조준 회전(`AIM_KEY_RATE_DEG`, 실제 시간 기준).
- 드래그 목표 = 기준 목표 + 손가락 이동량(`clampPlayerX/Y`로 이동 범위 안). 기준 목표 = 드래그가 시작될 때 `input.targetX/Y`(아직 걸어가는 중이면
  그 목표에서 이어서), 없으면 캐릭터 위치. 벽 밖으로 끌면 기준점을 따라 옮겨 되돌릴 때 바로 반응. 캐릭터는 sim이 걷게 한다(빨리 끌면 뒤처졌다 따라잡음).
- 패배 배너 부제: hp → `T.combat.knockedOut`, breach → `breach`, contact → `crushed`('장난감에 부딪혔어요!' — 피격처럼 '아야'·히트스톱·흔들림 후 쓰러짐).
- 처치 보상: `rewardKill` 골드가 0이면(소수 골드 굴림) 동전 비행·'+0' 팝업을 띄우지 않는다.
- 렌더: `AimGuide`(playerLayer, 캐릭터 아래) — `traceAim`으로 매 프레임 경로 계산, 점 스프라이트 풀(할당 없음),
  가이드 공 반경 = 쿨타임이 가장 짧은 무기의 반경. `TutorialCallout`(첫 스테이지만, 첫 조준에 사라짐).
  `PlayerView.faceAim(cos)`: 그림(오른쪽을 봄)을 조준 쪽으로 좌우 뒤집기.

**combat/ 렌더·연출** (필드 좌표 = sim 좌표. 연출은 sim 이벤트를 옮기기만 한다 — 게임 결과와 무관, 연출 RNG는 따로)
- `FieldView` 레이어(아래 → 위): 바닥(채도 낮춰 한 번 구움) → `trailLayer`(투사체 꼬리) → `enemyLayer` → `projectileLayer` →
  `fxLayer`(타격·폭발·처치 파티클, 번개) → `shotLayer`(적 탄: 꼬리 → 빨간 글로우 → 본체 — 이펙트보다 위라 피할 것이 안 가려짐) →
  `topLayer`(피해 숫자, 골드 팝업, ComboLabel). 플레이어·조준 가이드는 씬의 playerLayer(필드 위).
- 흔들림: 트라우마(0..1)를 더하고 초당 SHAKE_DECAY 감소, 오프셋 = 트라우마² × SHAKE_MAX_PX(엇갈린 사인 합) — 필드와 playerLayer만.
  히트스톱: hitStop > 0 동안 sim·필드 연출 정지(흔들림·HUD는 계속). 값은 `visual.ts`의 TRAUMA_* / HITSTOP_*.
- hit 이벤트 분류(`CombatScene.hitFx`): 직전 'chain'의 도착점 = 연쇄 / 적중점이 적 가장자리 = 직접 타격(`EnemyLayer.hitInfo`) /
  직전 'explode' 뒤의 중심 적중 = 폭발 휘말림 / 중심 + 불 = 화상 틱. 직접 타격이고 맨 앞 웨이브 뒤·위(behind/top)면 콤보 +1(보스 제외).
```ts
// ProjectileLayer — 투사체·적 탄 스프라이트 풀(엔티티 id로 diff, 매 프레임 할당 없음) + 꼬리(위치 링 버퍼 → TRAIL_SEGMENTS 마디 파티클)
new ProjectileLayer(projLayer, trailLayer, shotLayer, glowTex, trailTex, onVanish?: (x, y, radius) => void)
  // onVanish: 플레이어 투사체가 바닥으로 빠지지 않고 필드 안에서 사라짐(수명 상한·반사 소진) → CombatScene이 Effects.fizzle
sync(projectiles, shots, dt): void ; prewarm(projViews, shotViews): void        // 인트로 동안 뷰 풀 미리 채우기
// EnemyLayer — 적 스프라이트(화면 들어오기 직전 생성), HP 비트맵 숫자, 피격 스프링(밀림 + 스쿼시), 처치 '펑'(부풀며 하얘짐)
// 번쩍임·냉기·화상은 필터 대신 키마다 한 번 구운 흰/얼음 실루엣 '덮개' (프레임 애니메이션 적은 예전 tint 방식)
sync(enemies, dt): number /* 가장 아래 적의 y+h */ ; hitInfo(enemyId, x, y, out: HitInfo): HitInfo | null
onHit(enemyId, dx, dy, strength): void ; onAttack(enemyId): void ; onKill(enemyId): number /* 보이는 크기, 안 보이면 0 */
prepare(spriteKey): void   // 덮개 실루엣 미리 굽기 (인트로 동안 프레임당 하나)
// Effects — 파티클 풀 MAX_PARTICLES(아틀라스 한 장 + ParticleContainer 1개 = 드로우콜 1), 번개 마디 파티클(전용 컨테이너),
// 피해 숫자 풀 MAX_DAMAGE_NUMBERS(비트맵 폰트). 풀이 PARTICLE_SOFT_CAP 넘게 차면 장식(파편·연기 꼬리)은 건너뜀
new Effects(atlas, seed, fxParent, topParent, dmgNorm /* 1 / stage.hpMul — 피해 → 크기 환산 */)
damageNumber(enemyId, x, y, amount, element, dot?) ; playerDamage(x, y, amount) ; goldPopup(x, y, amount) ; setNumberTop(y)
impact(x, y, damage, element, nx, ny) ; chainHit(x, y) ; splashHit(x, y, damage) ; burnTick(x, y)
burnEmit / frostEmit(x, y, w, h)          // StatusEmitter — EnemyLayer가 상태이상 중인 적마다 간격으로 부른다
explosion(x, y, radius, element?)         // 얼음이면 서리 폭발(얼음빛 구름 + 결정), 0.3초 안 같은 자리 겹침은 작게·연기 없이
chain(x1, y1, x2, y2) ; splitPuff(x, y, count) ; fizzle(x, y, size) ; killBurst(x, y, size, tier: 0|1|2, delay)
muzzle(x, y, angle) ; wallBounce(x, y, fieldW) ; confetti(x, y) ; update(dt) ; prewarm() ; readonly particleCount
// ComboLabel — '백어택!' → '백어택 xN!' (한글은 Text 한 번 래스터화, 배수는 숫자 비트맵 폰트), COMBO_TIMEOUT 끊기면 끝
hit(x, y) ; end() /* 승패: 페이드 */ ; update(dt) ; readonly current, bestCombo ; static warmupTexts(): Text[]
// FastBar — ui/ProgressBar와 같은 모양·잔상이지만 다시 그리지 않음(알약 NineSlice 폭만) — 보스 체력·HUD HP/진행 바
new FastBar(w, h, color, bg?) ; setValue(0..1, animate?) ; update(dt) ; readonly value
// Banner — 'intro' | 'boss' | 'clear' | 'defeat' 띠 배너 (튀어들어옴·흔들림). static warmupTexts(kind, title, sub): Text[]
// fxTextures.ts — 모듈 캐시(스테이지마다 다시 굽지 않음)
fxTextures(renderer): FxTextures         // soft · ring · spark · shadow · dot
fxAtlas(renderer, trailTaper): FxAtlas   // FxFrame → Texture: fx_* PNG + 파편(shot_bolt/spring/gear) + 코드로 그린 soft·ring·star·shard·trail·beam
enemyOverlayTextures(renderer, key): { white; frost } ; ensureNumberFont() /* NUM_FONT 'CombatNumbers' */
```
- 미리 그리기(인트로 동안 프레임당 하나): 배너·콤보 글자(같은 TextStyle 인스턴스를 공유해야 텍스처를 같이 씀, 아주 작게 계속 그려 둠 —
  안 그리면 렌더러 GC가 60초 뒤 치움), 적 덮개 실루엣, 투사체·적 탄 텍스처 업로드, 뷰 풀, `Effects.prewarm`(화면 밖에서 연출 한 번씩).
  보스 체력 바도 등장 전까지 바탕 아래에서 그려 둔다.
- `CombatScene.destroy`는 항상 `{ children: true, context: true }` — pixi v8은 Graphics 컨텍스트(GPU 지오메트리)를 렌더러 GC 때까지 남긴다.
  전투 씬의 Graphics는 컨텍스트를 공유하지 않아 안전하다(`menuFx`는 공유하므로 SceneManager 전체에 걸면 안 됨 — SceneManager는
  대신 `destroyTree`로 Graphics가 소유한 컨텍스트만 지운다, core/ 참고).
- 연출 상수는 전부 `scenes/combat/visual.ts`(투사체 보이는 크기 PROJ_VISUAL_SCALE 1.4, 꼬리 TRAIL_*, 타격감 ENEMY_KNOCKBACK·SQUASH·FLASH,
  흔들림·히트스톱, 콤보 COMBO_*, 풀 크기 MAX_*). 게임 규칙 수치(수명 PROJECTILE_MAX_AGE 6초·SPLIT_CHILD_MAX_AGE 2.5초 등)는 `config.ts`.

- `StageSummary.stageIndex` = 방금 클리어한 스테이지의 0부터 인덱스. `RunResult.stageIndex` = 런이 끝날 때 진행 중이던 스테이지 인덱스(승리 시 마지막 스테이지).
- 공용 메뉴 연출(색종이, 햇살, 리본, 카운트업, 아이템 칩)은 `src/scenes/menuFx.ts`.

### 디버그 훅 (스모크 테스트용)
`main.ts`는 `window.__game = { game, scene(): string, debug: { winStage(), loseStage(), addGold(n), addItem(defId, tier?), setSpeed(mul) }, perf() }`를 노출한다.
`perf()` = 성능 오버레이 기록(`perfReport()` — 켜져 있을 때만 쌓임) + `toast`(Toast.stats()).
효과음은 `audio/index.ts`가 `window.__sfx`(stats: 재생 수·최근 1초·최대 동시 재생·거절 사유, clips: 디코드한 클립의 길이·자른 무음·피크)를 노출한다.
`scene()`은 현재 씬의 `sceneName`(Scene 기반 클래스의 abstract readonly 필드, 클래스 이름과 같은 문자열로 지정 — 빌드 압축 후에도 유지). 전투 씬은 `winStage/loseStage`를 처리할 수 있어야 한다.
반환값: `winStage/loseStage/setSpeed` → 현재 씬이 처리했으면 true. `addGold` → 새 골드 또는 null. `addItem` → 추가된 StashItem 또는 null. 이후 현재 씬에 `refresh()`가 있으면 호출.

테스트 도구 (모두 자기 개발 서버를 `--port`로 띄우고 끝나면 끈다): `tools/smoke.mjs`(전체 흐름, 포트 5210), `tools/interaction-check.mjs`(실제 터치 입력 30개 검사 — 조준 10개,
이동 감각 4개(휙 끈 뒤 뒤처져 걷기, 속도 상한·놓은 자리에 정확히 서기, 필드 위쪽까지 갔다 오기), 마지막에 다음 전투에서 적에게 걸어 들어가 접촉 패배 포함, 포트 5211),
`tools/gap-playtest.mjs`(실제 터치로 st1을 끝까지 — 조준 가이드로 틈을 노리는 사람 흉내(옆으로 옮길 땐 손가락을 둔 채 캐릭터가 걸어가 설 때까지 기다림), debugState의 hits/behindHits/topHits와
웨이브 뒤로 들어간 공 연속 스크린샷 → `tools/.out/gap/`, 포트 5212), `tools/juice-sheet.mjs`(연출 리뷰 — 장면 8개
(st1 기본, 틈 쏘기 콤보, 폭발, 불, 얼음, 번개, 곰인형 처치, 무기 10종 보스전)를 연출해 장면마다 이펙트가 가장 잘 보이는 프레임을 골라
`tools/.out/juice/sheet.png` 한 장으로, 포트 5213), `tools/screenshot.mjs`(단일 스크린샷).
