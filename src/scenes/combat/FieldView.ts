// 필드 배경 + 엔티티 레이어 묶음. 좌표 = 시뮬레이션 필드 좌표 (1:1), 원점은 필드 좌상단.
import { ColorMatrixFilter, Container, Graphics, Rectangle, Sprite, type Renderer, type Texture } from 'pixi.js';
import { FIELD_H, FIELD_W } from '../../config';
import { tex } from '../../render/assets';
import { BG_DIM_ALPHA } from './visual';

/** 배경 텍스처를 살짝 채도 낮춰 한 번 구워 둔다 (매 프레임 필터 비용 없이) */
const bakedBg = new Map<string, Texture>();

function bakeBackground(renderer: Renderer, key: string): Texture {
  const hit = bakedBg.get(key);
  if (hit) return hit;
  const src = new Sprite(tex(key));
  src.width = FIELD_W;
  src.height = FIELD_H;
  const desat = new ColorMatrixFilter();
  desat.saturate(-0.25, false);
  src.filters = [desat];
  const holder = new Container();
  holder.addChild(src);
  const t = renderer.generateTexture({ target: holder, frame: new Rectangle(0, 0, FIELD_W, FIELD_H), resolution: 1 });
  holder.destroy({ children: true });
  desat.destroy();
  bakedBg.set(key, t);
  return t;
}

/**
 * 그리는 순서 (아래 → 위): 바닥 → 투사체 꼬리 → 적 → 플레이어 투사체 → 타격 이펙트 → 적 탄 → 숫자·콤보.
 * 적 탄은 이펙트보다 위 — 화면이 아무리 번쩍여도 피해야 할 것이 가려지지 않게.
 */
export class FieldView extends Container {
  /** 투사체 꼬리 (적 아래) */
  readonly trailLayer = new Container();
  /** 적 스프라이트 */
  readonly enemyLayer = new Container();
  /** 플레이어 투사체 */
  readonly projectileLayer = new Container();
  /** 타격·폭발·처치 파티클, 번개 */
  readonly fxLayer = new Container();
  /** 적 탄 (꼬리 + 글로우 + 본체) */
  readonly shotLayer = new Container();
  /** 피해 숫자, 골드 팝업, '백어택!' 콤보 */
  readonly topLayer = new Container();

  constructor(renderer: Renderer, backgroundKey: string) {
    super();
    this.eventMode = 'none';
    this.interactiveChildren = false;

    const bg = new Sprite(bakeBackground(renderer, backgroundKey));
    bg.width = FIELD_W;
    bg.height = FIELD_H;

    const shade = new Graphics();
    shade.rect(0, 0, FIELD_W, FIELD_H).fill({ color: 0x1a1226, alpha: BG_DIM_ALPHA });
    // 격자 열 경계 (아주 옅게) — 적 열을 읽기 쉽게. 플레이어는 필드 어디든 갈 수 있어 따로 구역 띠는 없다
    for (let c = 1; c < 8; c++) shade.rect((FIELD_W / 8) * c - 1, 0, 2, FIELD_H);
    shade.fill({ color: 0x000000, alpha: 0.035 });

    this.addChild(
      bg,
      shade,
      this.trailLayer,
      this.enemyLayer,
      this.projectileLayer,
      this.fxLayer,
      this.shotLayer,
      this.topLayer,
    );
  }
}
