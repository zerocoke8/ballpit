// '백어택!' 콤보 글자 (필드 좌표, topLayer). 공이 틈으로 들어가 웨이브 뒤·위에서 적을 때리면 그 근처에
// "백어택!" → 이어지면 "백어택 x3!"처럼 배수가 붙고 콤보가 클수록 크고 뜨거운 색이 된다.
// COMBO_TIMEOUT 동안 백어택가 없으면 사라진다. 글자 갱신은 COMBO_REFRESH 간격으로 묶어서(연타에도 깜빡이지 않게).
// 한글 글자(Text)는 처음에 한 번만 래스터화하고, 바뀌는 배수는 숫자 비트맵 폰트로 그린다 → 갱신 비용 없음.
import { BitmapText, Container, Text, TextStyle } from 'pixi.js';
import { FIELD_W } from '../../config';
import { T } from '../../i18n/ko';
import { textStyle } from '../../ui';
import { NUM_FONT } from './fxTextures';
import { COMBO_COLOR, COMBO_HOT_COLOR, COMBO_REFRESH, COMBO_TIMEOUT } from './visual';

const FONT = 40;
const COUNT_FONT = 42;
const POP_TIME = 0.2;
const FADE_TIME = 0.28;
/** 화면 가장자리·위쪽에서 이만큼 안쪽에 둔다 */
const EDGE_X = 120;
const TOP_Y = 64;
/**
 * 적중점보다 이만큼 위에 띄운다 (위에 자리가 없으면 LIFT_BELOW만큼 아래). 적중점에서 튀어 오르는 피해 숫자가
 * 적중점 위 약 20~75 px를 차지하므로 그보다 위 (58이었을 때 "x3!"이 피해 숫자와 겹쳤다)
 */
const LIFT = 96;
const LIFT_BELOW = 50;
/** 이 콤보부터 뜨거운 색 */
const HOT_AT = 6;
/** 이 콤보부터는 오래 떠 있으므로 살짝 투명하게 (뒤의 적이 비쳐 보이게) */
const LONG_AT = 12;

/**
 * 글자 스타일 하나를 같이 쓴다 — pixi 8의 글자 텍스처 캐시 키가 TextStyle 인스턴스라서, 그래야 미리 그린 글자(warmupTexts)와
 * 이 라벨의 글자가 텍스처를 공유한다 (Banner의 스타일 주석 참고)
 */
let sharedStyle: TextStyle | null = null;
function comboStyle(): TextStyle {
  sharedStyle ??= new TextStyle(textStyle('title', { fontSize: FONT, fill: COMBO_COLOR, letterSpacing: 1 }));
  return sharedStyle;
}

export class ComboLabel extends Container {
  private readonly single: Text;
  private readonly word: Text;
  private readonly count: BitmapText;
  private combo = 0;
  private shownCombo = 0;
  private best = 0;
  private sinceHit = Infinity;
  private sinceRefresh = Infinity;
  private pop = POP_TIME;
  private fade = 0;
  private tx = 0;
  private ty = 0;
  private clock = 0;

  constructor() {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    const style = comboStyle();
    this.single = new Text({ text: T.combat.backstab, style });
    this.single.anchor.set(0.5);
    this.word = new Text({ text: T.combat.backstabCombo, style });
    this.word.anchor.set(1, 0.5);
    this.count = new BitmapText({ text: T.combat.comboCount(2), style: { fontFamily: NUM_FONT, fontSize: COUNT_FONT } });
    this.count.anchor.set(0, 0.55);
    this.addChild(this.single, this.word, this.count);
    this.visible = false;
  }

  /**
   * 생성자가 만들 것과 같은 한글 Text들 — 인트로 동안 한 번 미리 렌더해 첫 백어택에서 끊기지 않게
   * (Banner.warmupTexts와 같은 용도 — 호출 쪽이 계속 그려 두어야 텍스처가 남는다).
   */
  static warmupTexts(): Text[] {
    const style = comboStyle();
    return [new Text({ text: T.combat.backstab, style }), new Text({ text: T.combat.backstabCombo, style })];
  }

  /** 지금 콤보 (끝났으면 0) / 이번 전투 최고 */
  get current(): number {
    return this.combo;
  }

  get bestCombo(): number {
    return this.best;
  }

  /** 백어택 적중 1회 (필드 좌표) */
  hit(x: number, y: number): void {
    const fresh = this.combo === 0;
    this.combo++;
    if (this.combo > this.best) this.best = this.combo;
    this.sinceHit = 0;
    this.tx = clamp(x, EDGE_X, FIELD_W - EDGE_X);
    // 위쪽 끝 근처면 적중점 아래에 — 위로 밀어 넣으면 그 자리에서 올라오는 피해 숫자와 겹친다
    this.ty = y - LIFT >= TOP_Y ? y - LIFT : y + LIFT_BELOW;
    if (fresh) {
      this.position.set(this.tx, this.ty);
      this.sinceRefresh = Infinity;
    }
  }

  /** 전투가 끝남: 이어지던 콤보를 짧게 페이드하며 끝낸다 (승리 배너 위에 남지 않게) */
  end(): void {
    if (this.combo === 0) return;
    this.combo = 0;
    this.fade = FADE_TIME;
  }

  /** 전투가 끝나면 바로 정리 */
  reset(): void {
    this.combo = 0;
    this.shownCombo = 0;
    this.visible = false;
  }

  update(dt: number): void {
    this.clock += dt;
    this.sinceHit += dt;
    this.sinceRefresh += dt;
    if (this.combo > 0 && this.sinceHit > COMBO_TIMEOUT) {
      this.combo = 0;
      this.fade = FADE_TIME;
    }
    if (this.combo > 0 && this.combo !== this.shownCombo && this.sinceRefresh >= COMBO_REFRESH) {
      this.sinceRefresh = 0;
      this.show(this.combo);
    }
    if (this.combo === 0 && this.fade <= 0) {
      this.visible = false;
      this.shownCombo = 0;
      return;
    }
    if (!this.visible) return;

    // 따라가기 (적중점이 바뀌어도 튀지 않게)
    const f = Math.min(1, dt * 9);
    this.x += (this.tx - this.x) * f;
    this.y += (this.ty - this.y) * f;

    this.pop += dt;
    const n = this.shownCombo;
    // 콤보가 클수록 조금씩 커지되(최대 1.15배) 전투 화면을 덮지 않게 — 긴 콤보는 오래 떠 있으므로 키우지 않고 살짝 투명하게
    const grow = 1 + Math.min(0.15, (n - 1) * 0.03);
    const q = Math.min(1, this.pop / POP_TIME);
    // 처음 몇 번은 크게 톡, 콤보가 길어지면 작게 (계속 갱신돼도 정신없지 않게)
    const amp = n < 4 ? 0.45 : 0.2;
    const popS = 1 + amp * (1 - outBack(q));
    let alpha = 1;
    if (this.combo === 0) {
      this.fade = Math.max(0, this.fade - dt);
      const k = this.fade / FADE_TIME;
      alpha = k;
      this.y -= 40 * dt;
    }
    this.scale.set(grow * popS);
    this.rotation = Math.sin(this.pop * 30) * 0.12 * (1 - q) + (n >= HOT_AT ? Math.sin(this.clock * 9) * 0.03 : 0);
    this.alpha = alpha * (n >= LONG_AT ? 0.8 : 0.94);
  }

  private show(n: number): void {
    this.shownCombo = n;
    this.visible = true;
    this.fade = 0;
    this.pop = 0;
    const hot = n >= HOT_AT;
    if (n <= 1) {
      this.single.visible = true;
      this.word.visible = false;
      this.count.visible = false;
      this.single.tint = 0xffffff;
      return;
    }
    this.single.visible = false;
    this.word.visible = true;
    this.count.visible = true;
    const s = T.combat.comboCount(n);
    if (this.count.text !== s) this.count.text = s;
    // 글자(색 있는 Text, 채움 = COMBO_COLOR)는 tint로 덥힌다: 분홍 × 이 값 ≈ COMBO_HOT_COLOR
    this.word.tint = hot ? 0xff98dc : 0xffffff;
    this.count.tint = hot ? COMBO_HOT_COLOR : COMBO_COLOR;
    // [백어택][x3!] 를 가운데 정렬
    const gap = 8;
    const total = this.word.width + gap + this.count.width;
    this.word.x = -total / 2 + this.word.width;
    this.count.x = this.word.x + gap;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function outBack(k: number): number {
  const c1 = 2.2;
  const c3 = c1 + 1;
  const m = k - 1;
  return 1 + c3 * m * m * m + c1 * m * m;
}
