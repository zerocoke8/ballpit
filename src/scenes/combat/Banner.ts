// 화면 가운데 띠 배너 (스테이지 시작, 보스 등장, 클리어, 패배). 한 번에 하나, update(dt)로 직접 애니메이션.
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { DESIGN_W, UI_COLORS } from '../../config';
import { textStyle } from '../../ui';

export type BannerKind = 'intro' | 'boss' | 'clear' | 'defeat';

const BAND_H = 170;
const IN_TIME = 0.18;
const OUT_TIME = 0.25;

const BAND_COLOR: Record<BannerKind, number> = {
  intro: 0x1a1226,
  boss: 0x7a0f1e,
  clear: 0x1f4a2a,
  defeat: 0x2a1020,
};
const TITLE_COLOR: Record<BannerKind, number> = {
  intro: UI_COLORS.text,
  boss: 0xffe14a,
  clear: UI_COLORS.gold,
  defeat: 0xff9aa8,
};

/**
 * 글자 스타일은 종류별로 하나씩 만들어 같이 쓴다. pixi 8의 글자 텍스처 캐시 키는 (글자 + TextStyle '인스턴스' + 해상도)라서
 * 같은 옵션으로 새로 만든 스타일끼리는 텍스처를 같이 쓰지 못한다 — 미리 그려 둔 글자(warmupTexts)가 실제 배너에
 * 재사용되지 않고 배너가 뜰 때마다 다시 래스터화되던 원인 (측정: 보스 등장 배너 프레임 렌더 16 ms @ CPU 4배 감속)
 */
const titleStyles = new Map<BannerKind, TextStyle>();
let subtitleStyle: TextStyle | null = null;

function makeTitle(kind: BannerKind, title: string): Text {
  let style = titleStyles.get(kind);
  if (!style) {
    const big = kind === 'intro' ? 76 : 84;
    style = new TextStyle(textStyle('title', { fontSize: big, fill: TITLE_COLOR[kind] }));
    titleStyles.set(kind, style);
  }
  return new Text({ text: title, style });
}

function makeSubtitle(subtitle: string): Text {
  subtitleStyle ??= new TextStyle(textStyle('heading', { fontSize: 36 }));
  return new Text({ text: subtitle, style: subtitleStyle });
}

export class Banner extends Container {
  private readonly band = new Graphics();
  private readonly content = new Container();
  private title: Text | null = null;
  private subtitle: Text | null = null;
  private kind: BannerKind = 'intro';
  private t = 0;
  private duration = 0;
  private active = false;

  constructor() {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    this.addChild(this.band, this.content);
    this.visible = false;
  }

  /** duration = 전체 표시 시간(초). Infinity면 hide()까지 유지 */
  show(kind: BannerKind, title: string, subtitle: string | null, duration: number): void {
    this.clearTexts();
    this.kind = kind;
    this.t = 0;
    this.duration = duration;
    this.active = true;
    this.visible = true;

    const band = this.band;
    band.clear();
    band.rect(0, -BAND_H / 2 - 6, DESIGN_W, BAND_H + 12).fill({ color: 0x000000, alpha: 0.25 });
    band.rect(0, -BAND_H / 2, DESIGN_W, BAND_H).fill({ color: BAND_COLOR[kind], alpha: 0.86 });
    band.rect(0, -BAND_H / 2, DESIGN_W, 5).fill({ color: TITLE_COLOR[kind], alpha: 0.8 });
    band.rect(0, BAND_H / 2 - 5, DESIGN_W, 5).fill({ color: TITLE_COLOR[kind], alpha: 0.8 });
    if (kind === 'boss') {
      // 경고 줄무늬
      for (let x = -40; x < DESIGN_W + 40; x += 56) {
        band.poly([x, -BAND_H / 2, x + 28, -BAND_H / 2, x + 12, -BAND_H / 2 + 18, x - 16, -BAND_H / 2 + 18]);
        band.poly([x, BAND_H / 2 - 18, x + 28, BAND_H / 2 - 18, x + 12, BAND_H / 2, x - 16, BAND_H / 2]);
      }
      band.fill({ color: 0xffe14a, alpha: 0.9 });
    }

    this.title = makeTitle(kind, title);
    this.title.anchor.set(0.5);
    this.title.position.set(DESIGN_W / 2, subtitle ? -22 : 0);
    this.content.addChild(this.title);
    if (subtitle) {
      this.subtitle = makeSubtitle(subtitle);
      this.subtitle.anchor.set(0.5);
      this.subtitle.position.set(DESIGN_W / 2, 48);
      if (this.subtitle.width > DESIGN_W - 60) this.subtitle.scale.set((DESIGN_W - 60) / this.subtitle.width);
      this.content.addChild(this.subtitle);
    }
    this.apply();
  }

  /**
   * show(kind, title, subtitle)가 만들 것과 똑같은 Text들. 미리 한 번 렌더해 두는 용도:
   * 큰 외곽선 한글 글자의 첫 래스터화(글리프 + 텍스처 할당)는 저사양 폰에서 수십 ms라,
   * 전투 도중(보스 등장)이나 승패 순간에 끊기지 않게 인트로 동안 미리 그려 둔다. 같은 글자·스타일의 Text는 텍스처를
   * 같이 쓰므로, 호출 쪽은 이것들을 (아주 작게) 계속 그려 두어야 한다 — 바로 destroy하면 텍스처도 반납돼 효과가 없다.
   */
  static warmupTexts(kind: BannerKind, title: string, subtitle: string | null): Text[] {
    return subtitle ? [makeTitle(kind, title), makeSubtitle(subtitle)] : [makeTitle(kind, title)];
  }

  hide(): void {
    if (!this.active) return;
    this.duration = Math.min(this.duration, this.t + OUT_TIME);
  }

  get isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    if (this.t >= this.duration) {
      this.active = false;
      this.visible = false;
      this.clearTexts();
      return;
    }
    this.apply();
  }

  private apply(): void {
    const t = this.t;
    const kIn = Math.min(1, t / IN_TIME);
    const out = Number.isFinite(this.duration) ? Math.max(0, (t - (this.duration - OUT_TIME)) / OUT_TIME) : 0;
    // 띠: 튀어나오듯 펼쳐짐 (살짝 넘쳤다 제자리)
    const m = kIn - 1;
    this.band.scale.y = (1 + 2.6 * m * m * m + 1.6 * m * m) * (1 - out);
    this.band.alpha = 1 - out;
    // 제목: 작게 시작해 통통 튀며 제자리 (감쇠 진동) + 살짝 기울었다 펴짐, 자리 잡은 뒤엔 숨쉬기
    const damp = Math.exp(-7 * t);
    let s = 1 - 0.8 * damp * Math.cos(16 * t);
    if (this.kind === 'intro' || this.kind === 'clear') s *= 1 + 0.025 * Math.sin(t * 6) * (1 - damp);
    if (this.title) {
      // 세로는 덜 출렁 → 넘칠 때 납작, 모자랄 때 길쭉 (말랑한 느낌)
      const shrink = 1 - out * 0.3;
      this.title.scale.set(s * shrink, (1 + (s - 1) * 0.72) * shrink);
      this.title.rotation = -0.09 * Math.exp(-6 * t) * Math.sin(14 * t);
      this.title.alpha = Math.min(1, t / 0.08) * (1 - out);
      if (this.kind === 'boss') this.title.alpha *= 0.7 + 0.3 * Math.abs(Math.sin(t * 9));
    }
    if (this.subtitle) {
      // 오른쪽에서 미끄러져 들어와 살짝 지나쳤다 돌아옴
      const k = Math.min(1, Math.max(0, (t - 0.1) / 0.3));
      const km = k - 1;
      const slide = 1 + 2.4 * km * km * km + 1.4 * km * km;
      this.subtitle.alpha = Math.min(1, k * 2) * (1 - out);
      this.subtitle.x = DESIGN_W / 2 + (1 - slide) * 90;
    }
    this.content.alpha = 1;
  }

  private clearTexts(): void {
    this.title?.destroy();
    this.subtitle?.destroy();
    this.title = null;
    this.subtitle = null;
  }
}
