// 첫 스테이지 조작 안내 말풍선 (필드 좌표): 캐릭터 옆(조준선을 가리지 않는 쪽)에 붙어 둥실거리다가
// 첫 탭 조준에 톡 줄어들며 사라진다. 꼬리가 캐릭터를 가리킨다.
import { Container, Graphics, Text } from 'pixi.js';
import { FIELD_W } from '../../config';
import { textStyle } from '../../ui';
import { AIM_OUTLINE, TUTORIAL_FONT, TUTORIAL_RISE, TUTORIAL_SIDE } from './visual';

const PAD_X = 22;
const PAD_Y = 14;
const TAIL = 18;
const EDGE = 10;
const IN_TIME = 0.35;
const OUT_TIME = 0.22;
const BUBBLE_COLOR = 0xfffaf0;
const RING_COLOR = 0xffc93c;

export class TutorialCallout extends Container {
  private readonly bubble = new Graphics();
  private readonly text: Text;
  private readonly body = new Container();
  private readonly w: number;
  private readonly h: number;
  private side: 1 | -1 = -1;
  private clock = 0;
  private t = 0;
  private state: 'in' | 'show' | 'out' | 'gone' = 'in';

  constructor(text: string) {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;
    this.text = new Text({
      text,
      style: textStyle('body', { fontSize: TUTORIAL_FONT, fill: AIM_OUTLINE, align: 'center', lineHeight: TUTORIAL_FONT * 1.3 }),
    });
    this.text.anchor.set(0.5);
    this.w = Math.ceil(this.text.width + PAD_X * 2);
    this.h = Math.ceil(this.text.height + PAD_Y * 2);
    this.body.addChild(this.bubble, this.text);
    this.addChild(this.body);
    this.drawBubble();
    this.scale.set(0);
  }

  get done(): boolean {
    return this.state === 'gone';
  }

  dismiss(): void {
    if (this.state === 'out' || this.state === 'gone') return;
    this.state = 'out';
    this.t = 0;
  }

  /** px, py = 캐릭터 중심(필드 좌표) */
  update(dt: number, px: number, py: number): void {
    if (this.state === 'gone') return;
    this.clock += dt;
    this.t += dt;

    // 말풍선은 캐릭터 옆, 필드 안쪽으로 공간이 더 넓은 쪽 (가운데면 왼쪽). 조준선(위쪽)을 덜 가린다
    const want: 1 | -1 = px < FIELD_W / 2 - 40 ? 1 : -1;
    if (want !== this.side) {
      this.side = want;
      this.drawBubble();
    }
    const half = this.w / 2;
    const cx = Math.min(FIELD_W - EDGE - half, Math.max(EDGE + half, px + this.side * TUTORIAL_SIDE));
    const bob = Math.sin(this.clock * 3.2) * 5;
    this.position.set(cx, py - TUTORIAL_RISE + bob);

    let s = 1;
    if (this.state === 'in') {
      const f = Math.min(1, this.t / IN_TIME);
      s = backOut(f);
      if (f >= 1) this.state = 'show';
    } else if (this.state === 'out') {
      const f = Math.min(1, this.t / OUT_TIME);
      s = 1 - f;
      this.alpha = 1 - f;
      if (f >= 1) {
        this.state = 'gone';
        this.visible = false;
      }
    }
    this.scale.set(s);
  }

  private drawBubble(): void {
    const g = this.bubble;
    const w = this.w;
    const h = this.h;
    const x0 = -w / 2;
    const y0 = -h / 2;
    // 꼬리: 아래쪽 모서리에서 캐릭터 쪽(반대편)으로
    const tx = -this.side * (w / 2 - 34);
    g.clear();
    g.roundRect(x0, y0 + 5, w, h, 22).fill({ color: 0x000000, alpha: 0.22 });
    g.poly([tx - 14, h / 2 - 2, tx + 14, h / 2 - 2, tx - this.side * 22, h / 2 + TAIL]).fill(BUBBLE_COLOR).stroke({ width: 4, color: AIM_OUTLINE, join: 'round' });
    g.roundRect(x0, y0, w, h, 22).fill(BUBBLE_COLOR).stroke({ width: 4, color: AIM_OUTLINE });
    // 꼬리와 몸통 사이 외곽선 지우기
    g.rect(tx - 12, h / 2 - 4, 24, 6).fill(BUBBLE_COLOR);
    // 반짝이는 점 (탭 느낌)
    g.circle(x0 + 14, y0 + 14, 5).fill(RING_COLOR);
  }
}

function backOut(t: number): number {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}
