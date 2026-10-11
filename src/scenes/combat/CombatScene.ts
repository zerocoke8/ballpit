// 전투 씬: CombatSim(고정 스텝) 구동 + 렌더러들 + 입력 + 흐름(인트로 → 전투 → 클리어/패배) + 가방 오버레이.
// 게임 규칙은 전부 sim/run 로직에 있고, 여기서는 이벤트를 연출로 옮기기만 한다.
import {
  Container,
  Graphics,
  Point,
  Rectangle,
  Sprite,
  type DestroyOptions,
  type FederatedPointerEvent,
  type Text,
  type Texture,
} from 'pixi.js';
import { sfx } from '../../audio';
import {
  AIM_KEY_RATE_DEG,
  BOTTOM_BAR_MIN_H,
  CELL,
  DESIGN_W,
  ENEMY_INSET,
  FIELD_H,
  FIELD_W,
  FIELD_X,
  HUD_H,
  SIM_DT,
  TAP_SLOP,
  UI_COLORS,
} from '../../config';
import type { Viewport } from '../../core/app';
import { Keyboard } from '../../core/keyboard';
import {
  COIN_STREAK_MAX,
  COIN_STREAK_STEP,
  COIN_STREAK_WINDOW,
  COMBAT_PAN,
  COMBO_PITCH_MAX,
  COMBO_PITCH_STEP,
  DANGER_REPEAT,
  ELEMENT_HIT_SFX,
  ENEMY_SHOT_SFX,
  HEAVY_HIT_DAMAGE,
  weaponFireSfx,
  type SfxId,
} from '../../data/sfxMap';
import { Scene } from '../../core/scene';
import { game } from '../../game';
import { T } from '../../i18n/ko';
import { findMerges } from '../../logic/bag';
import { clampPlayerX, clampPlayerY } from '../../logic/combat/movement';
import { clampAim, CombatSim, FIRE_OFFSET_Y } from '../../logic/combat/sim';
import {
  combatSeed,
  completeStage,
  currentStage,
  rewardKill,
  runCharacter,
  runLoadout,
  runPlayerStats,
  saveRun,
} from '../../logic/run';
import type {
  CombatEvent,
  CombatInput,
  CombatStatus,
  EnemyEntity,
  GameData,
  LostReason,
  RunState,
  StageDef,
  Tier,
  WeaponLoadout,
} from '../../types';
import { tex } from '../../render/assets';
import { Toast } from '../../ui';
import { AimGuide } from './AimGuide';
import { BagOverlay } from './BagOverlay';
import { Banner } from './Banner';
import { BossBar } from './BossBar';
import { ComboLabel } from './ComboLabel';
import { Effects } from './Effects';
import { EnemyLayer, type HitInfo } from './EnemyLayer';
import { FieldView } from './FieldView';
import { Flyers } from './Flyers';
import { FrameView } from './FrameView';
import { ensureNumberFont, fxAtlas, fxTextures } from './fxTextures';
import { Hud } from './Hud';
import { PlayerView } from './PlayerView';
import { ProjectileLayer } from './ProjectileLayer';
import { TutorialCallout } from './TutorialCallout';
import { WeaponBar } from './WeaponBar';
import {
  AIM_GUIDE_DEFAULT_RADIUS,
  AIM_TAP_BODY_RADIUS,
  AIM_TAP_MIN_DIST,
  CELEBRATE_TIME,
  DANGER_RANGE,
  DEFEAT_TIME,
  DEFENSE_RED,
  ENEMY_POP_TIME,
  HITSTOP_BOSS,
  HITSTOP_ELITE,
  HITSTOP_PLAYER,
  INTRO_TIME,
  KEY_MOVE_LEAD,
  MAX_STEPS_PER_FRAME,
  SHAKE_DECAY,
  SHAKE_MAX_PX,
  TOP_PAD_MAX,
  TOP_PAD_RATIO,
  TRAIL_TAPER,
  TRAUMA_BOSS_ARRIVE,
  TRAUMA_BOSS_KILL,
  TRAUMA_DEFEAT,
  TRAUMA_ELITE_KILL,
  TRAUMA_EXPLODE_MAX,
  TRAUMA_PER_EXPLODE_PX,
  TRAUMA_PLAYER_HIT,
  VIGNETTE_TIME,
  WALL_TOP_H,
} from './visual';

export type CombatPhase = 'intro' | 'fight' | 'won' | 'lost';

interface Timer {
  t: number;
  fn: () => void;
}

/**
 * 화면을 누른 포인터 하나. 누른 채 TAP_SLOP 이내면 'pending'(떼면 탭 = 조준),
 * 넘게 움직이면 아무도 드래그 중이 아닐 때 'drag'(이동), 다른 손가락이 드래그 중이면 'aim'(따라 조준, 떼면 확정).
 */
interface PointerTrack {
  id: number;
  mode: 'pending' | 'drag' | 'aim';
  /** 누른 위치 (씬 좌표) */
  downX: number;
  downY: number;
}

/** 드래그가 이만큼(필드 px) 움직이면 '이동을 해봤다'로 친다 (하단 힌트) */
const HINT_DISMISS_DIST = 24;
const MAX_SPEED_MUL = 50;
const DEG = Math.PI / 180;
/** 시작 조준: 바로 위 */
const AIM_START = -Math.PI / 2;
/** debugState.recentShots에 넣는 갓 쏜 투사체 나이 상한(초) */
const RECENT_SHOT_AGE = 0.12;
/** 보스전의 피해 숫자 상한 y (필드 좌표) — BossBar(이름 + 바, 위에서 약 56px) 아래 */
const BOSS_NUMBER_MIN_Y = 86;
/** 미리 그려 둔 글자를 계속 그릴 때의 크기 (텍스처 해상도는 크기와 무관 — 그리는 비용만 거의 0으로) */
const WARM_TEXT_SCALE = 0.01;
/** 인트로 동안 미리 만들어 두는 투사체 / 적 탄 뷰 수 (스트레스 빌드의 평소 동시 투사체 수 정도) */
const PREWARM_PROJ_VIEWS = 32;
const PREWARM_SHOT_VIEWS = 12;

export class CombatScene extends Scene {
  readonly sceneName = 'CombatScene';

  private readonly ready: boolean;
  private readonly data!: GameData;
  private readonly run!: RunState;
  private readonly stage!: StageDef;
  private readonly sim!: CombatSim;

  // ── 레이어 (아래 → 위) ──
  private readonly catcher = new Graphics();
  private readonly field!: FieldView;
  private readonly frame = new FrameView();
  private readonly fieldUi = new Container();
  private readonly playerLayer = new Container();
  private readonly weaponBar = new WeaponBar();
  private readonly overlayLayer = new Container();
  private readonly hud!: Hud;
  private readonly flyers!: Flyers;
  private readonly banner = new Banner();
  private readonly vignette = new Graphics();
  private readonly toastLayer = new Container();
  /**
   * 인트로 동안 미리 그리기 (프레임당 하나씩): 배너·콤보 글자, 적 덮개 실루엣. 바탕(catcher) 아래라 보이지 않는다.
   * pixi 8은 글자 텍스처를 (글자 + TextStyle 인스턴스 + 해상도)로 공유하므로 Banner·ComboLabel은 스타일 인스턴스를
   * 같이 쓰고, 미리 그린 글자는 지우지 않고 아주 작게(WARM_TEXT_SCALE) 계속 그려 둔다 — 지우면 텍스처가 바로 반납되고,
   * 안 그려 두면 렌더러 GC(60초 넘게 안 그려진 것을 치움)가 치운다. 예전엔 둘 다 안 돼서 배너가 뜰 때마다 다시
   * 래스터화했다(측정: 보스 등장 배너 프레임 17 ms → 2 ms @ CPU 4배 감속). 씬과 함께 파괴된다.
   */
  private readonly warmLayer = new Container();
  private readonly warmQueue: (() => Text[])[] = [];

  private readonly enemies!: EnemyLayer;
  private readonly projectiles!: ProjectileLayer;
  private readonly fx!: Effects;
  private readonly combo!: ComboLabel;
  private readonly player!: PlayerView;
  private readonly aimGuide!: AimGuide;
  /** 첫 스테이지 조작 안내 (첫 탭 조준 후 사라지면 null) */
  private tutorial: TutorialCallout | null = null;
  private readonly bossBar: BossBar | null = null;
  private readonly boss: EnemyEntity | null = null;

  // ── 상태 ──
  private phase: CombatPhase = 'intro';
  private introT = INTRO_TIME;
  private acc = 0;
  private speed = 1;
  /** onEnter에서 만든다 (진입하지 못하고 버려진 씬이 window 리스너를 남기지 않게) */
  private keyboard: Keyboard | null = null;
  /** 현재 조준각 (clamp 끝난 값, 필드 좌표 atan2). 매 스텝 input.aimAngle로 sim에 간다 */
  private aimAngle = AIM_START;
  private readonly input: CombatInput = { targetX: null, targetY: null, aimAngle: AIM_START };
  /** 조준 가이드가 쓰는 공 반경 (가장 자주 쏘는 무기) */
  private guideRadius = AIM_GUIDE_DEFAULT_RADIUS;
  /** 눌려 있는 포인터들 (pointerId → 상태) */
  private readonly pointers = new Map<number, PointerTrack>();
  /** 이동 드래그 중인 포인터 (한 번에 하나) */
  private dragId: number | null = null;
  private readonly dragStart = new Point();
  /** 드래그 기준 목표: 드래그가 시작될 때의 이동 목표(아직 걸어가는 중이면 그 목표, 섰으면 캐릭터 위치) */
  private dragPlayerX = 0;
  private dragPlayerY = 0;
  private readonly tmp = new Point();
  private kbActive = false;
  /** 하단 힌트: 탭 조준과 드래그 이동을 한 번씩 해보면 숨긴다 */
  private learnedAim = false;
  private learnedMove = false;
  private overlay: BagOverlay | null = null;
  private pendingClose = false;
  private readonly timers: Timer[] = [];
  private ended = false;
  private leaving = false;
  private exited = false;
  /** 화면 흔들림 트라우마 (0..1, 흔들림 = 트라우마² × SHAKE_MAX_PX) */
  private trauma = 0;
  private shakeClock = 0;
  /** 히트스톱 남은 시간 (시뮬레이션 + 필드 연출 정지) */
  private hitStop = 0;
  private vignetteT = 0;
  /** 피격 분류용 재사용 객체 */
  private readonly hitTmp: HitInfo = { edge: false, nx: 0, ny: -1, cx: 0, cy: 0, size: 0 };
  /** 이벤트 묶음 안에서 직전 폭발 중심 / 직전 연쇄 (휘말린 적 hit의 밀림 방향·종류 판정) */
  private readonly blast = { active: false, x: 0, y: 0, chainX: NaN, chainY: NaN, chainFromX: 0, chainFromY: 0 };
  private bossAnnounced = false;
  private newItemAlert = false;

  // ── 효과음 (sfxMap.ts 수치) ──
  /** 무기 uid → 발사음 (가방을 닫을 때 다시 만든다) */
  private readonly fireSfx = new Map<number, SfxId>();
  /** 이 피해 이상이면 묵직한 타격음 (HEAVY_HIT_DAMAGE × 스테이지 HP 배수) */
  private heavyHit = HEAVY_HIT_DAMAGE;
  /** 효과음용 시계(초, 숨김·가방 중에도 흐름) */
  private sfxClock = 0;
  private dangerOn = false;
  private lastDangerAt = -Infinity;
  private coinStreak = 0;
  private lastCoinAt = -Infinity;
  private vp: Viewport | null = null;
  private hudY = 0;
  private fieldY = 0;

  // ── 이번 스테이지 기록 ──
  /** 적중(hit 이벤트) 통계 — debugState용 (틈 쏘기 플레이테스트가 읽는다) */
  private hitCount = 0;
  private behindHits = 0;
  private topHits = 0;
  private kills = 0;
  private goldEarned = 0;
  private readonly drops: { defId: string; tier: Tier }[] = [];

  constructor() {
    super();
    const run = game?.run ?? null;
    this.ready = run !== null;
    this.warmLayer.eventMode = 'none';
    this.addChild(this.warmLayer, this.catcher);
    if (!run) return;

    const data = game.data;
    const stage = currentStage(data, run);
    const loadout = runLoadout(data, run);
    const renderer = game.gameApp.app.renderer;
    const fx = fxTextures(renderer);
    ensureNumberFont();

    this.data = data;
    this.run = run;
    this.stage = stage;
    this.sim = new CombatSim({
      stage,
      stageIndex: run.stageIndex,
      enemies: data.enemies,
      loadout,
      player: runPlayerStats(data, run),
      hp: run.hp,
      seed: combatSeed(run),
    });

    const atlas = fxAtlas(renderer, TRAIL_TAPER);
    this.field = new FieldView(renderer, stage.background);
    // 피해 → 이펙트 크기 환산: 스테이지 HP 배수만큼 커지는 숫자를 같은 느낌의 크기로
    this.fx = new Effects(atlas, combatSeed(run) ^ 0x9e37, this.field.fxLayer, this.field.topLayer, 1 / Math.max(1, stage.hpMul));
    this.combo = new ComboLabel();
    this.field.topLayer.addChild(this.combo);
    this.enemies = new EnemyLayer(data.enemies, renderer, this.fx);
    this.field.enemyLayer.addChild(this.enemies);
    this.projectiles = new ProjectileLayer(
      this.field.projectileLayer,
      this.field.trailLayer,
      this.field.shotLayer,
      fx.soft,
      atlas.trail,
      // 수명 상한(6초, 분열 자식 2.5초)으로 공중에서 사라지는 공은 작은 연기로 '퐁'
      (x, y, r) => this.fx.fizzle(x, y, r * 2),
    );
    this.player = new PlayerView(runCharacter(data, run).sprite, fx.shadow);
    // 조준 가이드는 캐릭터 아래(발사점 근처 점이 몸에 가려지게), 안내 말풍선은 위
    this.aimGuide = new AimGuide(fx);
    this.guideRadius = guideRadius(loadout);
    this.playerLayer.addChild(this.aimGuide, this.player);
    if (run.stageIndex === 0) {
      this.tutorial = new TutorialCallout(T.combat.aimTutorial);
      this.playerLayer.addChild(this.tutorial);
    }
    this.playerLayer.eventMode = 'none';
    this.fieldUi.eventMode = 'none';

    const boss = this.sim.enemies.find((e) => e.boss) ?? null;
    if (boss) {
      this.boss = boss;
      this.bossBar = new BossBar(data.enemies[boss.defId]?.name ?? '');
      // 등장 전까지는 미리 그리기 층(바탕 아래, 안 보임)에서 계속 그려 둔다 — 처음 보일 때 이름 글자·게이지를 만드느라
      // 끊기지 않게 (측정: 첫 표시 프레임 렌더 12.5 ms @ CPU 4배 감속). 숨겨 두면 렌더러 GC(60초 미사용)가 도로 치운다
      this.bossBar.visible = true;
      this.warmLayer.addChild(this.bossBar);
    }

    this.hud = new Hud(fx.soft, () => this.toggleBag());
    this.hud.setStage(run.stageIndex + 1, stage.name);
    this.hud.setStash(run.bag.stash.length);
    this.hud.setGold(run.gold);
    this.hud.setHp(this.sim.player.hp, this.sim.player.maxHp);
    this.hud.setProgress(0);
    this.flyers = new Flyers({
      onCoinArrive: () => {
        // 표시 골드는 매 프레임 (run.gold - 날아가는 중) 으로 맞춘다. 소리만: 연달아 도착하면 음이 오른다
        this.coinSfx();
      },
      onItemArrive: () => {
        this.newItemAlert = true;
        this.hud.bumpBag();
        this.hud.setStash(this.run.bag.stash.length);
        this.updateBagAlert();
      },
    });
    this.weaponBar.rebuild(loadout, data.items);
    this.rebuildFireSfx(loadout);
    this.heavyHit = HEAVY_HIT_DAMAGE * Math.max(1, stage.hpMul);

    this.vignette.eventMode = 'none';
    this.vignette.alpha = 0;
    this.toastLayer.eventMode = 'none';

    this.addChild(
      this.field,
      this.frame,
      this.fieldUi,
      this.playerLayer,
      this.weaponBar,
      this.overlayLayer,
      this.hud,
      this.flyers,
      this.banner,
      this.vignette,
      this.toastLayer,
    );

    // 입력: 화면 전체를 덮는 바탕이 탭(조준)·드래그(이동)를 받는다 (HUD 버튼·오버레이는 그 위라서 먼저 받음)
    this.catcher.eventMode = 'static';
    this.catcher.on('pointerdown', this.onPointerDown);
    this.catcher.on('globalpointermove', this.onPointerMove);
    this.catcher.on('pointerup', this.onPointerUp);
    this.catcher.on('pointerupoutside', this.onPointerAbort);
    this.catcher.on('pointercancel', this.onPointerAbort);

    this.updateBagAlert();

    // 전투 중·승패 순간에 처음 뜨는 배너 글자를 인트로 동안 미리 래스터화 (Banner.warmupTexts 참고)
    const warm = (kind: Parameters<typeof Banner.warmupTexts>[0], title: string, sub: string | null): void => {
      this.warmQueue.push(() => Banner.warmupTexts(kind, title, sub));
    };
    if (boss) warm('boss', T.combat.bossIncoming, data.enemies[boss.defId]?.name ?? null);
    warm('clear', T.combat.cleared, null);
    warm('defeat', T.combat.defeat, T.combat.breach);
    warm('defeat', T.combat.defeat, T.combat.knockedOut);
    warm('defeat', T.combat.defeat, T.combat.crushed);
    this.warmQueue.push(() => ComboLabel.warmupTexts());
    // 적 덮개 실루엣(피격 번쩍임·냉기)도 인트로 동안 한 프레임에 하나씩 미리 굽는다 (처음 보이는 적 종류에서 끊기지 않게)
    const keys = new Set<string>();
    // 투사체·분열 자식·적 탄 그림 (아래에서 GPU에 미리 올린다)
    const shotKeys = new Set<string>();
    for (const l of loadout) {
      shotKeys.add(l.sprite);
      if (l.split) shotKeys.add(l.split.sprite);
    }
    for (const row of stage.rows) {
      for (const ch of row) {
        const id = stage.legend[ch];
        const def = id ? data.enemies[id] : undefined;
        if (def) {
          keys.add(def.sprite);
          if (def.attack) shotKeys.add(def.attack.sprite);
        }
      }
    }
    for (const key of keys) {
      this.warmQueue.push(() => {
        this.enemies.prepare(key);
        return [];
      });
    }
    // 첫 발사·첫 타격 프레임 몰림 방지 (측정: 첫 발사 프레임 22 ms — 뷰 15개 생성 + 텍스처 첫 업로드, 첫 번개 13 ms,
    // 첫 폭발 7 ms @ CPU 4배 감속): 투사체·적 탄 그림과 이펙트 아틀라스를 한 번 그려 GPU에 올리고(작게 남겨 둠),
    // 투사체 뷰 풀을 채우고, 이펙트 연출을 화면 밖에서 한 번씩 돌린다
    this.warmQueue.push(() => {
      for (const key of shotKeys) this.warmLayer.addChild(warmSprite(tex(key)));
      this.warmLayer.addChild(warmSprite(atlas.impact), warmSprite(fx.soft));
      return [];
    });
    this.warmQueue.push(() => {
      this.projectiles.prewarm(PREWARM_PROJ_VIEWS, PREWARM_SHOT_VIEWS);
      return [];
    });
    this.warmQueue.push(() => {
      this.fx.prewarm();
      return [];
    });
  }

  // ── Scene 수명주기 ──────────────────────────────────────────

  override onEnter(): void {
    if (!this.ready) return;
    window.addEventListener('keydown', this.onRawKey);
    // PixiJS는 네이티브 pointercancel을 넘겨주지 않는다 — 시스템 제스처 등으로 끊긴 드래그가 남지 않게
    window.addEventListener('pointercancel', this.onNativeCancel);
    window.addEventListener('blur', this.onNativeCancel);
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('visibilitychange', this.onVisibility);
    const kb = (this.keyboard = new Keyboard());
    for (const code of ['KeyB', 'Escape', 'Tab']) kb.onPress(code, () => this.toggleBag());
    this.banner.show('intro', T.combat.stage(this.run.stageIndex + 1), this.stage.name, INTRO_TIME + 0.15);
    sfx.play('stage_start');
  }

  override onExit(): void {
    this.exited = true;
    this.keyboard?.dispose();
    this.keyboard = null;
    window.removeEventListener('keydown', this.onRawKey);
    window.removeEventListener('pointercancel', this.onNativeCancel);
    window.removeEventListener('blur', this.onNativeCancel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.catcher.removeAllListeners();
    this.pointers.clear();
    this.dragId = null;
    this.timers.length = 0;
    this.warmQueue.length = 0;
    this.overlay = null;
  }

  /**
   * pixi v8의 Graphics.destroy({ children: true })는 자기 GraphicsContext(와 렌더러 쪽 GPU 지오메트리·버퍼)를 남긴다 —
   * 렌더러 GC가 60초 넘게 안 쓰인 것을 30초마다 치울 때까지. 측정: 전투 6번 뒤 상점 화면에 그래픽 컨텍스트 403개 /
   * GL 버퍼 378개가 남아 있었다(전투 한 번에 약 80개씩). 이 씬의 Graphics는 모두 자기 컨텍스트를 쓰므로(공유 없음) 같이 지운다.
   * (텍스처는 공용 에셋이라 지우지 않는다)
   */
  override destroy(options?: DestroyOptions): void {
    super.destroy({ ...(typeof options === 'object' ? options : {}), children: true, context: true });
  }

  override layout(vp: Viewport): void {
    this.vp = vp;
    this.catcher.clear().rect(0, 0, vp.width, vp.height).fill(UI_COLORS.bg);
    this.catcher.hitArea = new Rectangle(-vp.width, -vp.height, vp.width * 3, vp.height * 3);
    if (!this.ready) return;

    // 남는 높이: 일부는 위 여백, 대부분은 하단 바
    const extra = Math.max(0, vp.height - vp.safeTop - vp.safeBottom - (HUD_H + FIELD_H + BOTTOM_BAR_MIN_H));
    const topPad = Math.min(TOP_PAD_MAX, Math.round(extra * TOP_PAD_RATIO));
    this.hudY = vp.safeTop + topPad;
    this.fieldY = this.hudY + HUD_H;
    const barY = this.fieldY + FIELD_H;
    const barH = Math.max(0, vp.height - vp.safeBottom - barY);

    this.field.position.set(FIELD_X, this.fieldY);
    this.playerLayer.position.set(FIELD_X, this.fieldY);
    this.fieldUi.position.set(FIELD_X, this.fieldY);
    this.frame.layout(this.fieldY, vp.height);
    this.weaponBar.position.set(0, barY);
    this.weaponBar.setHeight(barH);
    this.hud.position.set(0, this.hudY);
    this.hud.setTopExtend(this.hudY);
    this.banner.position.set(0, this.fieldY + FIELD_H * 0.36);
    this.drawVignette(vp);
    this.overlay?.layout(vp, this.fieldY);
  }

  override update(dt: number): void {
    if (!this.ready) {
      if (!this.leaving) {
        this.leaving = true;
        game?.toTitle();
      }
      return;
    }
    if (this.exited) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.sfxClock += dt;

    if (this.pendingClose) this.closeBagNow();
    this.stepWarmup();
    this.runTimers(dt);

    if (!this.overlay) {
      if (this.hitStop > 0) {
        // 히트스톱: 시뮬레이션과 필드 연출을 잠깐 멈춘다 (흔들림은 계속 — 멈춘 장면이 떨린다)
        this.hitStop = Math.max(0, this.hitStop - dt);
      } else {
        if (this.phase === 'intro') {
          this.introT -= dt;
          if (this.introT <= 0) this.phase = 'fight';
        }
        if (!this.ended) this.readAimKeys(dt);
        if (this.phase === 'fight') this.stepSim(dt);
        this.syncWorld(dt);
      }
      this.updateShake(dt);
    } else {
      this.overlay.update(dt);
    }

    this.hud.setGold(Math.max(0, this.run.gold - this.flyers.pendingGold()));
    this.hud.update(dt);
    this.flyers.update(dt);
    this.banner.update(dt);
    this.updateVignette(dt);
  }

  // ── 디버그 (window.__game.debug) ────────────────────────────

  debugWin(): void {
    if (!this.ready || this.ended) return;
    this.closeBagNow();
    this.phase = 'fight';
    this.sim.debugKillAll();
    this.handleEvents(this.sim.drainEvents());
  }

  debugLose(): void {
    if (!this.ready || this.ended) return;
    this.closeBagNow();
    this.phase = 'fight';
    this.sim.debugLose();
    this.handleEvents(this.sim.drainEvents());
  }

  /** 시뮬레이션 배속 (디버그). 프레임당 스텝 상한도 배속만큼 늘어난다 */
  setSpeed(mul: number): void {
    if (!Number.isFinite(mul) || mul <= 0) return;
    this.speed = Math.min(MAX_SPEED_MUL, mul);
  }

  /** 테스트 도구용 읽기 전용 스냅샷 (smoke.mjs · interaction-check.mjs). 런이 없으면 null */
  debugState(): {
    playerX: number;
    playerY: number;
    /** 플레이어 속도(px/s)·최고 속도와 지금 걸어가는 목표(없으면 null) — 이동 감각 검사용 */
    playerVx: number;
    playerVy: number;
    moveSpeed: number;
    targetX: number | null;
    targetY: number | null;
    hp: number;
    maxHp: number;
    status: CombatStatus;
    /** 졌으면 사유 (hp / breach / contact), 아니면 null */
    lostReason: LostReason | null;
    phase: CombatPhase;
    time: number;
    kills: number;
    totalEnemies: number;
    bagOpen: boolean;
    speed: number;
    /** 전투에 장착된 무기 uid (가방 읽기 순서) */
    weaponUids: number[];
    /** 현재 조준각 (라디안, 필드 좌표 atan2: -π/2 = 바로 위) */
    aimAngle: number;
    /** 이동 드래그 중인 포인터가 있는가 / 눌린 포인터 수 */
    dragging: boolean;
    pointers: number;
    /** 갓 쏜(나이 ≤ RECENT_SHOT_AGE) 투사체들 — 조준 방향 확인용 */
    recentShots: { id: number; weaponUid: number; x: number; y: number; vx: number; vy: number; age: number }[];
    /**
     * 이번 전투의 적중 수(hit 이벤트 — 화상·연쇄·폭발 포함). behindHits = 적중점이 맨 앞 웨이브(가장 아래 적부터
     * 빈 줄 없이 이어진 줄들)의 뒤쪽 끝 이상, topHits = 공이 적보다 위에서 그 적의 윗면을 때림(웨이브 뒤·위로 들어간 공)
     */
    hits: number;
    behindHits: number;
    topHits: number;
    /** 맨 앞 웨이브의 뒤쪽 끝(필드 y, 아직 다 안 들어왔으면 음수)과 그 웨이브의 적 수. 적이 없으면 null / 0 */
    frontTop: number | null;
    frontCount: number;
    /** '백어택!' 콤보: 지금(끝났으면 0) / 이번 전투 최고 */
    combo: number;
    bestCombo: number;
    /** 연출 상태 (측정용): 살아있는 이펙트 파티클 수, 화면 흔들림 트라우마, 남은 히트스톱(초) */
    fxParticles: number;
    trauma: number;
    hitStop: number;
  } | null {
    if (!this.ready) return null;
    const sim = this.sim;
    const front = frontWave(sim.enemies);
    const recentShots: { id: number; weaponUid: number; x: number; y: number; vx: number; vy: number; age: number }[] = [];
    for (const p of sim.projectiles) {
      if (p.age <= RECENT_SHOT_AGE) recentShots.push({ id: p.id, weaponUid: p.weaponUid, x: p.x, y: p.y, vx: p.vx, vy: p.vy, age: p.age });
    }
    return {
      playerX: sim.player.x,
      playerY: sim.player.y,
      playerVx: sim.player.vx,
      playerVy: sim.player.vy,
      moveSpeed: runPlayerStats(this.data, this.run).moveSpeed,
      targetX: this.input.targetX,
      targetY: this.input.targetY,
      hp: sim.player.hp,
      maxHp: sim.player.maxHp,
      status: sim.status,
      lostReason: sim.lostReason,
      phase: this.phase,
      time: sim.time,
      kills: sim.killedEnemies,
      totalEnemies: sim.totalEnemies,
      bagOpen: this.overlay !== null,
      speed: this.speed,
      weaponUids: sim.weapons.map((w) => w.uid),
      aimAngle: this.aimAngle,
      dragging: this.dragId !== null,
      pointers: this.pointers.size,
      recentShots,
      hits: this.hitCount,
      behindHits: this.behindHits,
      topHits: this.topHits,
      frontTop: front?.top ?? null,
      frontCount: front?.count ?? 0,
      combo: this.combo.current,
      bestCombo: this.combo.bestCombo,
      fxParticles: this.fx.particleCount,
      trauma: this.trauma,
      hitStop: this.hitStop,
    };
  }

  /** 외부(디버그 훅)에서 런 골드/보관함이 바뀌었을 때 */
  refresh(): void {
    if (!this.ready) return;
    this.hud.setStash(this.run.bag.stash.length);
    this.updateBagAlert();
    this.overlay?.refresh();
  }

  // ── 시뮬레이션 ──────────────────────────────────────────────

  private stepSim(dt: number): void {
    const sim = this.sim;
    this.acc += dt * this.speed;
    const maxSteps = MAX_STEPS_PER_FRAME * Math.max(1, Math.ceil(this.speed));
    let n = 0;
    while (this.acc >= SIM_DT && n < maxSteps && sim.status === 'running') {
      this.readKeyboard();
      sim.step(SIM_DT, this.input);
      this.handleEvents(sim.drainEvents());
      this.acc -= SIM_DT;
      n++;
    }
    // 밀린 시간은 버린다 (느린 기기에서 따라잡으려다 더 느려지지 않게)
    if (n >= maxSteps || sim.status !== 'running') this.acc = 0;
  }

  private handleEvents(events: readonly CombatEvent[]): void {
    /** 이번 묶음의 맨 앞 웨이브 (hit가 있을 때만 한 번 계산, 디버그 통계·백어택 판정용) */
    let front: FrontWave | null | undefined;
    // sim은 'explode' 바로 뒤에 휘말린 적들의 hit를, 'chain' 바로 뒤에 그 대상의 hit를 낸다 → 연출 분류에 쓴다
    const blast = this.blast;
    blast.active = false;
    blast.chainX = NaN;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'fire':
          sfx.playAt(this.fireSfx.get(ev.weaponUid) ?? 'fire_hairball', panAt(ev.x));
          this.weaponBar.onFire(ev.weaponUid);
          this.player.onFire(this.aimAngle);
          this.fx.muzzle(ev.x, ev.y, this.aimAngle);
          blast.active = false;
          break;
        case 'hit': {
          this.hitCount++;
          if (front === undefined) front = frontWave(this.sim.enemies);
          let behind = false;
          if (front) {
            if (ev.y <= front.top + ENEMY_INSET + 0.5) {
              this.behindHits++;
              behind = true;
            }
            // 적중점 = 공 중심을 적 사각형에 clamp → 공이 적보다 위였으면 정확히 그 적의 윗변(모든 적이 같은 칸 격자)
            const d = (((ev.y - front.grid) % CELL) + CELL) % CELL;
            if (d < 0.01 || d > CELL - 0.01) {
              this.topHits++;
              behind = true;
            }
          }
          const direct = this.hitFx(ev);
          // 백어택: 공이 웨이브 뒤·위에서 직접 때림 (화상·폭발·연쇄 제외).
          // 보스는 제외 — 보스 옆으로 넘어간 공이 천장과 보스 윗면 사이를 수명 내내 오가며 '백어택'가 끊기지 않아
          // 보스전 내내 "백어택 x200!" 글자가 보스 머리를 덮고 있었다 (틈을 노리는 재미와도 무관)
          if (direct && behind && !this.ended && ev.enemyId !== this.boss?.id) {
            this.combo.hit(ev.x, ev.y);
            // 콤보가 이어질수록 반음씩 올라간다 (상한)
            sfx.playAt('combo', panAt(ev.x), COMBO_PITCH_STEP ** Math.min(COMBO_PITCH_MAX, this.combo.current - 1));
          }
          break;
        }
        case 'kill':
          this.onKill(ev);
          break;
        case 'explode':
          sfx.playAt('explode', panAt(ev.x));
          this.fx.explosion(ev.x, ev.y, ev.radius, ev.element);
          this.addTrauma(Math.min(TRAUMA_EXPLODE_MAX, ev.radius * TRAUMA_PER_EXPLODE_PX));
          blast.active = true;
          blast.x = ev.x;
          blast.y = ev.y;
          break;
        case 'chain':
          sfx.playAt('elem_zap', panAt(ev.toX));
          this.fx.chain(ev.fromX, ev.fromY, ev.toX, ev.toY);
          blast.chainX = ev.toX;
          blast.chainY = ev.toY;
          blast.chainFromX = ev.fromX;
          blast.chainFromY = ev.fromY;
          break;
        case 'split':
          sfx.playAt('split', panAt(ev.x));
          this.fx.splitPuff(ev.x, ev.y, ev.count);
          blast.active = false;
          break;
        case 'enemyShoot':
          this.enemyShotSfx(ev.enemyId, ev.x);
          this.enemies.onAttack(ev.enemyId);
          blast.active = false;
          break;
        case 'playerHit':
          sfx.playAt('player_hurt', panAt(ev.x));
          this.player.onHit();
          this.fx.playerDamage(this.sim.player.x, this.sim.player.y, ev.damage);
          this.addTrauma(TRAUMA_PLAYER_HIT);
          this.hitStop = Math.max(this.hitStop, HITSTOP_PLAYER);
          this.vignetteT = VIGNETTE_TIME;
          blast.active = false;
          break;
        case 'won':
          this.onWon();
          break;
        case 'lost':
          this.onLost(ev.reason);
          break;
        case 'bounce':
          if (ev.wall) {
            this.fx.wallBounce(ev.x, ev.y, FIELD_W);
            sfx.playAt('bounce_wall', panAt(ev.x));
          }
          blast.active = false;
          break;
      }
    }
  }

  /**
   * 적중 연출 + 피해 숫자. 적중점과 직전 이벤트로 종류를 나눈다:
   * 연쇄(직전 chain의 도착점) / 직접 타격(적 가장자리) / 폭발(직전 explode 뒤의 중심 적중) / 화상 틱(중심 + 불).
   * 직접 타격이면 true.
   */
  private hitFx(ev: Extract<CombatEvent, { type: 'hit' }>): boolean {
    const info = this.enemies.hitInfo(ev.enemyId, ev.x, ev.y, this.hitTmp);
    if (!info) {
      this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element);
      return false;
    }
    const blast = this.blast;
    if (ev.element === 'lightning' && ev.x === blast.chainX && ev.y === blast.chainY) {
      this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element);
      this.pushEnemy(ev.enemyId, info.cx - blast.chainFromX, info.cy - blast.chainFromY, 0.55);
      this.fx.chainHit(ev.x, ev.y);
      return false;
    }
    if (info.edge) {
      // 직접 타격: 플라스틱 '통' (피해가 크면 묵직하게) + 속성이면 속성 소리를 겹친다
      const pan = panAt(ev.x);
      sfx.playAt(ev.damage >= this.heavyHit ? 'hit_heavy' : 'hit_toy', pan);
      if (ev.element) sfx.playAt(ELEMENT_HIT_SFX[ev.element], pan);
      this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element);
      // 맞은 면의 바깥 법선 = 공이 온 쪽 → 적은 반대로 밀리고, 반짝이는 공 쪽으로 튄다
      this.enemies.onHit(ev.enemyId, -info.nx, -info.ny, 1);
      this.fx.impact(ev.x, ev.y, ev.damage, ev.element, info.nx, info.ny);
      return true;
    }
    if (blast.active) {
      this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element);
      this.pushEnemy(ev.enemyId, info.cx - blast.x, info.cy - blast.y, 0.8);
      this.fx.splashHit(ev.x, ev.y, ev.damage);
      return false;
    }
    if (ev.element === 'fire') {
      // 화상 틱: 작은 숫자로 (불타는 적마다 0.5초마다 뜨는 숫자가 HP 숫자를 덮지 않게)
      this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element, true);
      this.fx.burnTick(ev.x, ev.y);
      return false;
    }
    // 가장자리가 아닌 적중 (관통 중 등): 작게
    sfx.playAt('hit_toy', panAt(ev.x), 1.1, 0.6);
    this.fx.damageNumber(ev.enemyId, ev.x, ev.y, ev.damage, ev.element);
    this.enemies.onHit(ev.enemyId, 0, -1, 0.5);
    this.fx.splashHit(ev.x, ev.y, ev.damage);
    return false;
  }

  /** (dx, dy) 쪽으로 밀기 (정규화, 0이면 위로) */
  private pushEnemy(enemyId: number, dx: number, dy: number, strength: number): void {
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) this.enemies.onHit(enemyId, 0, -1, strength);
    else this.enemies.onHit(enemyId, dx / len, dy / len, strength);
  }

  private addTrauma(v: number): void {
    this.trauma = Math.min(1, this.trauma + v);
  }

  /** 트라우마 흔들림 (필드와 플레이어만). 부드러운 잡음(엇갈린 주파수의 사인 합) — 매 프레임 무작위보다 덜 어지럽다 */
  private updateShake(dt: number): void {
    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    this.shakeClock += dt;
    const amp = SHAKE_MAX_PX * this.trauma * this.trauma;
    let ox = 0;
    let oy = 0;
    if (amp > 0.05) {
      const t = this.shakeClock;
      ox = amp * (Math.sin(t * 61.3) * 0.6 + Math.sin(t * 97.1 + 1.7) * 0.4);
      oy = amp * (Math.sin(t * 73.7 + 0.5) * 0.6 + Math.sin(t * 89.3 + 2.9) * 0.4);
    }
    this.field.position.set(FIELD_X + ox, this.fieldY + oy);
    this.playerLayer.position.set(FIELD_X + ox, this.fieldY + oy);
  }

  private onKill(ev: Extract<CombatEvent, { type: 'kill' }>): void {
    const size = this.enemies.onKill(ev.enemyId);
    const x = clamp(ev.x, 0, FIELD_W);
    const y = clamp(ev.y, 0, FIELD_H);
    if (size > 0) {
      const def = this.data.enemies[ev.defId];
      const tier: 0 | 1 | 2 = ev.boss ? 2 : def && def.w * def.h > 1 ? 1 : 0;
      // 적이 부풀었다 하얘지는 '펑'(ENEMY_POP_TIME)이 끝나는 순간에 터진다
      this.fx.killBurst(ev.x, ev.y, size, tier, ENEMY_POP_TIME);
      sfx.playAt(tier === 2 ? 'boss_kill' : tier === 1 ? 'kill_elite' : 'kill_pop', panAt(x));
      if (tier === 2) {
        this.addTrauma(TRAUMA_BOSS_KILL);
        this.hitStop = Math.max(this.hitStop, HITSTOP_BOSS);
      } else if (tier === 1) {
        this.addTrauma(TRAUMA_ELITE_KILL);
        this.hitStop = Math.max(this.hitStop, HITSTOP_ELITE);
      }
    }
    if (ev.boss) this.bossBar?.hide();

    const reward = rewardKill(this.data, this.run, ev.defId);
    this.kills++;
    this.goldEarned += reward.gold;
    const sx = FIELD_X + x;
    const sy = this.fieldY + y;
    // 처치 골드는 소수 확률이라 0골드 처치가 흔하다 — 그때는 동전·'+0'을 띄우지 않는다
    if (reward.gold > 0) {
      const gold = this.hud.goldTarget();
      this.flyers.coin(sx, sy, gold.x, this.hudY + gold.y, reward.gold);
      if (size > 0) this.fx.goldPopup(x, y, reward.gold);
    }

    const drop = reward.drop;
    if (!drop) return;
    if (drop.converted) {
      sfx.playAt('coin', panAt(x));
      this.goldEarned += drop.convertedGold;
      this.toast(T.combat.dropConverted(drop.convertedGold), 0x6b4a12);
      return;
    }
    this.drops.push({ defId: drop.defId, tier: drop.tier });
    sfx.playAt('item_drop', panAt(x));
    const def = this.data.items[drop.defId];
    const bag = this.hud.bagTarget();
    this.flyers.item(def?.icon ?? 'ui_bag', sx, sy, bag.x, this.hudY + bag.y);
    this.toast(def ? T.combat.newItemNamed(def.name) : T.combat.newItem, UI_COLORS.accent);
  }

  private onWon(): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'won';
    this.closeBagNow();
    this.cancelPointers();
    this.tutorial?.dismiss();
    this.combo.end();
    sfx.play('stage_clear');
    this.banner.show('clear', T.combat.cleared, null, CELEBRATE_TIME + 0.6);
    for (let i = 0; i < 5; i++) this.fx.confetti(FIELD_W * (0.15 + i * 0.175), FIELD_H * (0.3 + (i % 2) * 0.12));
    this.after(CELEBRATE_TIME, () => this.finishStage());
  }

  private finishStage(): void {
    if (this.leaving || this.exited) return;
    this.leaving = true;
    const run = this.run;
    const clearedIndex = run.stageIndex;
    const res = completeStage(this.data, run, this.sim.player.hp);
    saveRun(run);
    game.toStageClear({
      stageIndex: clearedIndex,
      kills: this.kills,
      goldEarned: this.goldEarned,
      drops: this.drops,
      clearGold: res.clearGold,
      healed: res.healed,
      finished: res.finished,
    });
  }

  private onLost(reason: LostReason): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'lost';
    this.closeBagNow();
    this.cancelPointers();
    this.tutorial?.dismiss();
    this.combo.end();
    sfx.play('defeat');
    if (reason === 'contact') {
      // 장난감에 부딪힘: 피격처럼 '아야' + 멈칫 + 붉은 테, 그리고 쓰러진다
      const pl = this.sim.player;
      sfx.playAt('player_hurt', panAt(pl.x));
      this.addTrauma(TRAUMA_PLAYER_HIT);
      this.hitStop = Math.max(this.hitStop, HITSTOP_PLAYER);
    }
    if (reason !== 'breach') this.player.die();
    this.addTrauma(TRAUMA_DEFEAT);
    this.vignetteT = VIGNETTE_TIME * 2;
    const sub = reason === 'breach' ? T.combat.breach : reason === 'contact' ? T.combat.crushed : T.combat.knockedOut;
    this.banner.show('defeat', T.combat.defeat, sub, DEFEAT_TIME + 0.6);
    this.after(DEFEAT_TIME, () => {
      if (this.leaving || this.exited) return;
      this.leaving = true;
      const run = this.run;
      game.toResult({ won: false, stageIndex: run.stageIndex, characterId: run.characterId, stats: run.stats });
    });
  }

  // ── 화면 동기화 ─────────────────────────────────────────────

  private syncWorld(dt: number): void {
    const sim = this.sim;
    const lowest = this.enemies.sync(sim.enemies, dt);
    const danger = clamp((lowest - (FIELD_H - DANGER_RANGE)) / DANGER_RANGE, 0, 1);
    this.frame.setDanger(danger);
    this.dangerSfx(danger);
    this.frame.update(dt);
    this.projectiles.sync(sim.projectiles, sim.enemyShots, dt);
    const pl = sim.player;
    this.player.faceAim(Math.cos(this.aimAngle));
    this.player.sync(pl, dt, sim.status === 'running');
    const aiming = sim.status === 'running' && !this.ended;
    this.aimGuide.visible = aiming;
    if (aiming) this.aimGuide.update(dt, pl.x, pl.y - FIRE_OFFSET_Y, this.aimAngle, this.guideRadius, sim.enemies);
    if (this.tutorial) {
      this.tutorial.update(dt, pl.x, pl.y);
      if (this.tutorial.done) {
        this.tutorial.destroy({ children: true, context: true });
        this.tutorial = null;
      }
    }
    this.fx.update(dt);
    this.weaponBar.sync(sim.weapons, dt);
    this.hud.setHp(sim.player.hp, sim.player.maxHp);
    this.hud.setProgress(sim.progress());

    const boss = this.boss;
    if (boss && this.bossBar) {
      if (!this.bossAnnounced && boss.alive && boss.y + boss.h > 0) {
        this.bossAnnounced = true;
        this.fieldUi.addChild(this.bossBar);
        this.bossBar.show();
        // 보스 체력 바(필드 위쪽)가 피해 숫자를 가리지 않게
        this.fx.setNumberTop(BOSS_NUMBER_MIN_Y);
        this.banner.show('boss', T.combat.bossIncoming, this.data.enemies[boss.defId]?.name ?? null, 1.8);
        sfx.play('boss_appear');
        this.addTrauma(TRAUMA_BOSS_ARRIVE);
      }
      if (this.bossAnnounced && boss.alive) this.bossBar.setHp(boss.hp, boss.maxHp);
      this.bossBar.update(dt);
    }
    this.combo.update(dt);
  }

  private drawVignette(vp: Viewport): void {
    const g = this.vignette;
    g.clear();
    // 가장자리에서 안쪽으로 옅어지는 붉은 테 (얇은 띠를 촘촘히 겹쳐 계단이 덜 보이게)
    const bands = 36;
    const w = 5;
    for (let i = 0; i < bands; i++) {
      const inset = i * w + w / 2;
      g.rect(inset, inset, vp.width - inset * 2, vp.height - inset * 2).stroke({
        width: w,
        color: DEFENSE_RED,
        alpha: 0.42 * (1 - i / bands) ** 2.2,
      });
    }
  }

  private updateVignette(dt: number): void {
    if (this.vignetteT > 0) this.vignetteT = Math.max(0, this.vignetteT - dt);
    const a = Math.min(1, this.vignetteT / VIGNETTE_TIME);
    this.vignette.alpha = a;
    this.vignette.visible = a > 0;
  }

  // ── 입력 ────────────────────────────────────────────────────

  private setTarget(x: number, y: number): void {
    this.input.targetX = x;
    this.input.targetY = y;
  }

  private clearTarget(): void {
    this.input.targetX = null;
    this.input.targetY = null;
  }

  private readKeyboard(): void {
    const kb = this.keyboard;
    if (!kb) return;
    let dx = 0;
    let dy = 0;
    if (kb.isDown('ArrowLeft') || kb.isDown('KeyA')) dx -= 1;
    if (kb.isDown('ArrowRight') || kb.isDown('KeyD')) dx += 1;
    if (kb.isDown('ArrowUp') || kb.isDown('KeyW')) dy -= 1;
    if (kb.isDown('ArrowDown') || kb.isDown('KeyS')) dy += 1;
    const pl = this.sim.player;
    if (dx !== 0 || dy !== 0) {
      const inv = 1 / Math.hypot(dx, dy);
      this.setTarget(pl.x + dx * inv * KEY_MOVE_LEAD, pl.y + dy * inv * KEY_MOVE_LEAD);
      this.kbActive = true;
      this.learned('move');
    } else if (this.kbActive) {
      this.kbActive = false;
      // 키를 떼면 목표 없음 → 감속해서 선다 (드래그 중이면 드래그 목표 그대로)
      if (this.dragId === null) this.clearTarget();
    }
  }

  /** 키보드 조준 회전 (데스크톱): Q/, = 왼쪽으로, E/. = 오른쪽으로. 실제 시간 기준 */
  private readAimKeys(dt: number): void {
    const kb = this.keyboard;
    if (!kb) return;
    let rot = 0;
    if (kb.isDown('KeyQ') || kb.isDown('Comma')) rot -= 1;
    if (kb.isDown('KeyE') || kb.isDown('Period')) rot += 1;
    if (rot === 0) return;
    this.setAim(this.aimAngle + rot * AIM_KEY_RATE_DEG * DEG * dt);
    this.learned('aim');
  }

  private setAim(angle: number): void {
    const a = clampAim(angle);
    this.aimAngle = a;
    this.input.aimAngle = a;
  }

  /** 조작을 한 번씩 해보면 안내를 걷는다: 조준 → 말풍선, 조준 + 이동 → 하단 힌트 */
  private learned(what: 'aim' | 'move'): void {
    if (what === 'aim') {
      if (this.learnedAim) return;
      this.learnedAim = true;
      this.tutorial?.dismiss();
    } else {
      if (this.learnedMove) return;
      this.learnedMove = true;
    }
    if (this.learnedAim && this.learnedMove) this.weaponBar.dismissHint();
  }

  /**
   * 화면(씬 좌표)의 점을 향해 조준 — 필드(+ 테두리 벽) 안의 점만. HUD·하단 바를 누른 건 조준이 아니다.
   * 캐릭터 몸 위(AIM_TAP_BODY_RADIUS)나 발사점 바로 옆(AIM_TAP_MIN_DIST)도 조준하지 않는다.
   * 방향 = 발사점(플레이어 위 FIRE_OFFSET_Y) → 그 점, sim과 같은 clamp. tap이면 그 자리에 고리 펄스.
   */
  private aimAtScreen(sx: number, sy: number, tap: boolean): boolean {
    if (sx < 0 || sx > DESIGN_W || sy < this.fieldY - WALL_TOP_H || sy > this.fieldY + FIELD_H) return false;
    const fx = sx - FIELD_X;
    const fy = sy - this.fieldY;
    const pl = this.sim.player;
    const dx = fx - pl.x;
    const by = fy - pl.y;
    if (dx * dx + by * by < AIM_TAP_BODY_RADIUS * AIM_TAP_BODY_RADIUS) return false;
    const dy = by + FIRE_OFFSET_Y;
    if (dx * dx + dy * dy < AIM_TAP_MIN_DIST * AIM_TAP_MIN_DIST) return false;
    const before = this.aimAngle;
    this.setAim(Math.atan2(dy, dx));
    if (tap) {
      this.aimGuide.pulseAt(clamp(fx, 0, FIELD_W), clamp(fy, 0, FIELD_H));
      if (this.aimAngle !== before) this.aimGuide.snap();
      this.learned('aim');
    }
    return true;
  }

  private beginDrag(t: PointerTrack, x: number, y: number): void {
    t.mode = 'drag';
    this.dragId = t.id;
    // 탭 판정 거리만큼 움직인 지금 위치를 기준점으로 → 드래그로 바뀌는 순간 목표가 튀지 않는다.
    // 기준 목표 = 지금 걸어가는 목표(직전 드래그의 끝 — 아직 가는 중이어도 이어서 끌 수 있게), 없으면 캐릭터 위치
    this.dragStart.set(x, y);
    const pl = this.sim.player;
    this.dragPlayerX = this.input.targetX ?? pl.x;
    this.dragPlayerY = this.input.targetY ?? pl.y;
    this.setTarget(this.dragPlayerX, this.dragPlayerY);
  }

  /**
   * 드래그 = 손가락 이동량만큼 목표를 상대 이동. 캐릭터는 그 목표를 향해 이동 속도로 걸어간다(가속·도착 감속은 sim) —
   * 손가락을 빨리 끌면 캐릭터가 뒤따라오며 따라잡는다. 목표는 필드 벽 안 어디든.
   */
  private dragTo(x: number, y: number): void {
    const rx = this.dragPlayerX + (x - this.dragStart.x);
    const ry = this.dragPlayerY + (y - this.dragStart.y);
    const tx = clampPlayerX(rx);
    const ty = clampPlayerY(ry);
    // 벽 밖으로 끌면 기준점을 따라 옮겨서, 되돌릴 때 바로 반응하게
    this.dragStart.x += rx - tx;
    this.dragStart.y += ry - ty;
    this.setTarget(tx, ty);
    if (!this.learnedMove && Math.hypot(tx - this.dragPlayerX, ty - this.dragPlayerY) > HINT_DISMISS_DIST) {
      this.learned('move');
    }
  }

  /** 드래그 끝: 목표는 그대로 — 캐릭터는 손가락을 놓은 자리(목표)까지 마저 걸어가서 선다 */
  private endDrag(): void {
    this.dragId = null;
  }

  /** 포인터 하나를 조준 없이 정리 (드래그였으면 멈춤) */
  private dropPointer(id: number): void {
    const t = this.pointers.get(id);
    if (!t) return;
    this.pointers.delete(id);
    if (t.mode === 'drag' || this.dragId === id) this.endDrag();
  }

  /** 모든 포인터 정리 (가방 열기·승패·포커스 잃음) */
  private cancelPointers(): void {
    this.pointers.clear();
    if (this.dragId !== null) this.endDrag();
  }

  private readonly onPointerDown = (e: FederatedPointerEvent): void => {
    if (!this.ready || this.overlay || this.ended) return;
    // 마우스는 왼쪽 버튼만 (오른쪽 클릭으로 조준되지 않게)
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.dropPointer(e.pointerId); // 놓친 up이 있었다면 정리
    const p = e.getLocalPosition(this, this.tmp);
    this.pointers.set(e.pointerId, { id: e.pointerId, mode: 'pending', downX: p.x, downY: p.y });
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    const t = this.pointers.get(e.pointerId);
    if (!t) return;
    const p = e.getLocalPosition(this, this.tmp);
    if (t.mode === 'drag') {
      this.dragTo(p.x, p.y);
      return;
    }
    if (t.mode === 'pending') {
      const dx = p.x - t.downX;
      const dy = p.y - t.downY;
      if (dx * dx + dy * dy <= TAP_SLOP * TAP_SLOP) return;
      // 탭이 아니다: 아무도 이동 중이 아니면 이동 드래그, 다른 손가락이 이동 중이면 이 손가락은 조준
      if (this.dragId === null) {
        this.beginDrag(t, p.x, p.y);
        return;
      }
      t.mode = 'aim';
    }
    this.aimAtScreen(p.x, p.y, false);
  };

  /** 뗌: 드래그면 멈춤, 아니면(탭 / 두 번째 손가락 조준) 뗀 자리를 향해 조준 */
  private readonly onPointerUp = (e: FederatedPointerEvent): void => {
    const t = this.pointers.get(e.pointerId);
    if (!t) return;
    this.pointers.delete(t.id);
    if (t.mode === 'drag' || this.dragId === t.id) {
      this.endDrag();
      return;
    }
    if (!this.ready || this.overlay || this.ended) return;
    const p = e.getLocalPosition(this, this.tmp);
    // move 없이 멀리서 뗀 포인터(빠른 휙 — 합쳐진 move가 오기 전에 up)는 탭이 아니다
    if (t.mode === 'pending') {
      const mx = p.x - t.downX;
      const my = p.y - t.downY;
      if (mx * mx + my * my > TAP_SLOP * TAP_SLOP) return;
    }
    this.aimAtScreen(p.x, p.y, true);
  };

  /** pointerupoutside / pointercancel: 조준 없이 그 포인터만 정리 */
  private readonly onPointerAbort = (e: FederatedPointerEvent): void => {
    this.dropPointer(e.pointerId);
  };

  /** PixiJS는 네이티브 pointercancel을 넘겨주지 않는다 — 시스템 제스처 등으로 끊긴 포인터, 창 포커스 잃음 */
  private readonly onNativeCancel = (e: Event): void => {
    if (typeof PointerEvent !== 'undefined' && e instanceof PointerEvent) this.dropPointer(e.pointerId);
    else this.cancelPointers();
  };

  /** 탭이 가려지면(앱 전환 등) 눌린 포인터를 정리 — 그동안의 up/cancel을 못 받아 끊긴 드래그가 남지 않게 */
  private readonly onVisibility = (): void => {
    if (document.hidden) this.cancelPointers();
  };

  /** 브라우저 메뉴(우클릭 · 안드로이드 길게 누르기)가 전투 화면을 덮고 다음 탭(조준)을 먹지 않게 */
  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  /** Tab이 브라우저 포커스 이동을 하지 않게 */
  private readonly onRawKey = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') e.preventDefault();
  };

  // ── 가방 ────────────────────────────────────────────────────

  private toggleBag(): void {
    if (!this.ready || this.ended || this.leaving) return;
    // 드래그 중의 Esc/B/Tab은 BagView가 드래그 취소로 처리한다 — 오버레이까지 닫지 않는다
    if (this.overlay?.busy) return;
    if (this.overlay) this.pendingClose = true;
    else this.openBag();
  }

  private openBag(): void {
    if (this.overlay) return;
    sfx.play('bag_open');
    this.cancelPointers();
    this.overlay = new BagOverlay({
      data: this.data,
      run: this.run,
      onChange: () => {
        this.hud.setStash(this.run.bag.stash.length);
        this.updateBagAlert();
      },
      onClose: () => {
        this.pendingClose = true;
      },
    });
    this.overlayLayer.addChild(this.overlay);
    if (this.vp) this.overlay.layout(this.vp, this.fieldY);
    this.newItemAlert = false;
    this.updateBagAlert();
  }

  /** 오버레이를 닫고 바뀐 가방을 전투에 반영 (버튼 이벤트 도중이 아니라 update에서) */
  private closeBagNow(): void {
    this.pendingClose = false;
    const o = this.overlay;
    if (!o) return;
    this.overlay = null;
    sfx.play('bag_close');
    // context: true — 가방을 열고 닫을 때마다 Graphics 컨텍스트가 렌더러 GC 때까지 남지 않게 (destroy 참고)
    o.destroy({ children: true, context: true });
    const loadout = runLoadout(this.data, this.run);
    this.sim.setLoadout(loadout, runPlayerStats(this.data, this.run));
    this.weaponBar.rebuild(loadout, this.data.items);
    this.rebuildFireSfx(loadout);
    this.guideRadius = guideRadius(loadout);
    this.hud.setStash(this.run.bag.stash.length);
    this.hud.setHp(this.sim.player.hp, this.sim.player.maxHp);
    this.updateBagAlert();
    this.acc = 0;
  }

  private updateBagAlert(): void {
    const merges = findMerges(this.run.bag, this.data).length > 0;
    this.hud.setBagAlert(merges || this.newItemAlert);
  }

  // ── 도우미 ──────────────────────────────────────────────────

  /** 미리 그리기: 프레임당 하나 (update는 렌더 전에 돈다 → 이번 프레임에 래스터화). 글자는 남겨 둔다 (warmLayer 참고) */
  private stepWarmup(): void {
    const next = this.warmQueue.shift();
    if (!next) return;
    for (const t of next()) {
      t.scale.set(WARM_TEXT_SCALE);
      this.warmLayer.addChild(t);
    }
  }

  // ── 효과음 도우미 ───────────────────────────────────────────

  private rebuildFireSfx(loadout: readonly WeaponLoadout[]): void {
    this.fireSfx.clear();
    for (const l of loadout) this.fireSfx.set(l.uid, weaponFireSfx(l.defId));
  }

  /** 적 공격 탄 그림에 맞는 발사음 */
  private enemyShotSfx(enemyId: number, x: number): void {
    const list = this.sim.enemies;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== enemyId) continue;
      const shot = this.data.enemies[list[i].defId]?.attack?.sprite;
      const id = shot ? ENEMY_SHOT_SFX[shot] : undefined;
      if (id) sfx.playAt(id, panAt(x));
      return;
    }
  }

  /** 동전이 HUD에 닿을 때 '띵' — 연달아 오면 반음씩 올라간다 */
  private coinSfx(): void {
    const t = this.sfxClock;
    this.coinStreak = t - this.lastCoinAt <= COIN_STREAK_WINDOW ? Math.min(COIN_STREAK_MAX, this.coinStreak + 1) : 0;
    this.lastCoinAt = t;
    // HUD 골드(왼쪽 위)로 모이므로 살짝 왼쪽
    sfx.playAt('coin', -COMBAT_PAN * 0.5, COIN_STREAK_STEP ** this.coinStreak);
  }

  /** 방어선 위험: 위험이 새로 시작될 때만, DANGER_REPEAT 안에는 다시 울리지 않는다 */
  private dangerSfx(danger: number): void {
    if (danger <= 0 || this.ended) {
      this.dangerOn = false;
      return;
    }
    if (this.dangerOn) return;
    this.dangerOn = true;
    if (this.sfxClock - this.lastDangerAt < DANGER_REPEAT) return;
    this.lastDangerAt = this.sfxClock;
    sfx.play('danger');
  }

  private toast(text: string, color: number): void {
    Toast.show(this.toastLayer, text, { y: this.fieldY + FIELD_H * 0.22, color });
  }

  private after(seconds: number, fn: () => void): void {
    this.timers.push({ t: seconds, fn });
  }

  private runTimers(dt: number): void {
    if (this.timers.length === 0) return;
    const due: Timer[] = [];
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) {
        due.push(tm);
        this.timers.splice(i, 1);
      }
    }
    for (const tm of due) {
      if (this.exited) return;
      tm.fn();
    }
  }
}

/** 필드 x → 은은한 좌우 위치 (-COMBAT_PAN..COMBAT_PAN) */
function panAt(x: number): number {
  return clamp((x / FIELD_W) * 2 - 1, -1, 1) * COMBAT_PAN;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 미리 그리기용: 거의 안 보이는 크기의 스프라이트 (그려지는 순간 텍스처가 GPU에 올라간다) */
function warmSprite(t: Texture): Sprite {
  const s = new Sprite(t);
  s.scale.set(WARM_TEXT_SCALE);
  return s;
}

interface FrontWave {
  /** 맨 앞 웨이브의 뒤쪽 끝(칸 경계, 필드 y). 화면 밖 줄도 포함 → 웨이브가 다 들어오기 전엔 음수(아직 뒤쪽 공간 없음) */
  top: number;
  /** 그 웨이브의 적 수 */
  count: number;
  /** 적 충돌 박스 윗변의 격자 위치(아무 적의 y) — 모든 적이 같이 내려오므로 공통 */
  grid: number;
}

/** 맨 앞 웨이브 = 가장 아래 살아있는 적의 줄부터 위로 빈 줄 없이 이어진 줄들. 적이 없으면 null. 디버그 통계용 */
function frontWave(enemies: readonly EnemyEntity[]): FrontWave | null {
  // 모든 적은 같이 내려오므로 칸 경계도 공통 — 줄 번호(round(top / CELL))로 묶는다
  const rows = new Map<number, { top: number; count: number }>();
  let lowest = -Infinity;
  let grid = 0;
  for (const e of enemies) {
    if (!e.alive) continue;
    grid = e.y;
    const top = e.y - ENEMY_INSET;
    const n = Math.round((e.h + 2 * ENEMY_INSET) / CELL);
    for (let k = 0; k < n; k++) {
      const key = Math.round((top + k * CELL) / CELL);
      const row = rows.get(key);
      if (row) {
        if (k === 0) row.count++;
      } else rows.set(key, { top: top + k * CELL, count: k === 0 ? 1 : 0 });
      if (key > lowest) lowest = key;
    }
  }
  if (rows.size === 0) return null;
  let k = lowest;
  let count = rows.get(k)?.count ?? 0;
  while (rows.has(k - 1)) count += rows.get(--k)?.count ?? 0;
  return { top: rows.get(k)?.top ?? 0, count, grid };
}

/** 조준 가이드 공 반경: 가장 자주 쏘는(쿨타임이 가장 짧은) 무기의 반경 */
function guideRadius(loadout: readonly WeaponLoadout[]): number {
  let best: WeaponLoadout | null = null;
  for (const l of loadout) if (!best || l.cooldown < best.cooldown) best = l;
  return best ? best.radius : AIM_GUIDE_DEFAULT_RADIUS;
}
