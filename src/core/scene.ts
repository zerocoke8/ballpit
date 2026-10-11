// 씬 기반 클래스 + 전환 관리자.
import { Container, Graphics, type GraphicsContext, type Ticker } from 'pixi.js';
import { UI_COLORS } from '../config';
import { perfMark, perfNow } from '../debug/perfOverlay';
import type { GameApp, Viewport } from './app';

export abstract class Scene extends Container {
  /** 디버그/스모크 테스트용 고정 이름 (빌드 압축 후에도 유지되도록 클래스 이름 대신 사용) */
  abstract readonly sceneName: string;
  /** 진입 직후(onEnter 다음) + 리사이즈 시 */
  abstract layout(vp: Viewport): void;
  /** 초 단위, 최대 0.1로 clamp */
  update(_dt: number): void {}
  onEnter(): void {}
  /** 리스너/타이머 정리. 이후 destroy({children:true})가 호출되고, 트리 안 Graphics의 자기 컨텍스트도 해제된다(destroyTree) */
  onExit(): void {}
}

const MAX_DT = 0.1;
const FADE_OUT = 0.14;
const FADE_IN = 0.2;
/**
 * 페이드는 한 프레임에 이 시간(초)까지만 진행. 새 씬의 첫 렌더(글자 래스터화 등)로 긴 프레임이 생겨도 덮개가 한 번에
 * 반쯤 걷히며 튀지 않게 (측정: 전투 진입 교체 프레임 ~230 ms @ CPU 4배 감속 → 다음 프레임에 덮개가 0.5 걷혔다)
 */
const FADE_MAX_STEP = 1 / 30;

/**
 * 트리 전체를 destroy({ children: true }) 하면서, 그 안의 Graphics가 '자기 것으로 만든' GraphicsContext
 * (new Graphics()로 생긴 컨텍스트 = GPU 지오메트리·버퍼)도 바로 해제한다.
 * pixi v8의 Graphics.destroy(옵션 객체)는 자기 컨텍스트를 남겨서, 렌더러 GC(60초 미사용, 30초마다)까지
 * GPU 지오메트리가 쌓였다 (측정: 전투→클리어→상점 한 바퀴마다 고아 컨텍스트 ~95개, GL 버퍼 ~110개).
 * 공유 컨텍스트(new Graphics(ctx) — menuFx 색종이 모양 등)는 Graphics가 소유하지 않으므로 건드리지 않는다
 * (pixi의 g.destroy()와 같은 기준). 씬의 destroy 재정의(리스너 해제 등)는 그대로 돌고, 그 뒤에 컨텍스트만 지운다.
 */
export function destroyTree(root: Container): void {
  if (root.destroyed) return;
  const owned: GraphicsContext[] = [];
  collectOwnedContexts(root, owned);
  root.destroy({ children: true });
  for (const ctx of owned) if (!ctx.destroyed) ctx.destroy();
}

function collectOwnedContexts(node: Container, out: GraphicsContext[]): void {
  if (node instanceof Graphics) {
    // 생성자에서 직접 만든 컨텍스트만 (pixi 내부 필드, Graphics.destroy()가 지우는 것과 같은 대상)
    const own = (node as unknown as { _ownedContext?: GraphicsContext | null })._ownedContext;
    if (own) out.push(own);
  }
  const ch = node.children;
  for (let i = 0; i < ch.length; i++) collectOwnedContexts(ch[i], out);
}

export class SceneManager {
  private _current: Scene | null = null;
  private pending: Scene | null = null;
  private phase: 'idle' | 'out' | 'in' = 'idle';
  private readonly overlay: Graphics;

  constructor(private readonly gameApp: GameApp) {
    this.overlay = new Graphics();
    this.overlay.label = 'sceneFade';
    this.overlay.eventMode = 'none';
    this.overlay.visible = false;
    this.overlay.alpha = 0;
    this.drawOverlay(gameApp.viewport);
    gameApp.root.addChild(this.overlay);

    gameApp.app.ticker.add(this.tick);
    gameApp.onResize((vp) => {
      this.drawOverlay(vp);
      this._current?.layout(vp);
    });
  }

  get current(): Scene | null {
    return this._current;
  }

  /** 이전 씬 onExit + destroyTree(자기 Graphics 컨텍스트까지), 짧은 페이드. current는 실제 교체 시점에 바뀐다 */
  goto(scene: Scene): void {
    perfMark('goto');
    if (this.pending && this.pending !== scene) destroyTree(this.pending);
    this.pending = scene;
    if (!this._current) {
      this.overlay.alpha = 1;
      this.swap();
      return;
    }
    if (this.phase !== 'out') {
      this.phase = 'out';
      this.overlay.visible = true;
      this._current.eventMode = 'none';
    }
  }

  private swap(): void {
    const next = this.pending;
    this.pending = null;
    if (!next) return;
    const prev = this._current;
    if (prev) {
      const t0 = perfNow();
      try {
        prev.onExit();
      } catch (err) {
        console.error('[scene] onExit 오류', err);
      }
      prev.removeFromParent();
      destroyTree(prev);
      perfMark('sceneExit', t0);
    }
    const t1 = perfNow();
    this._current = next;
    const root = this.gameApp.root;
    root.addChild(next);
    root.addChild(this.overlay); // 페이드 오버레이는 항상 맨 위
    next.onEnter();
    next.layout(this.gameApp.viewport);
    perfMark('sceneEnter', t1);
    this.phase = 'in';
    this.overlay.visible = true;
  }

  private readonly tick = (ticker: Ticker): void => {
    const dt = Math.min(ticker.deltaMS / 1000, MAX_DT);
    if (this.phase === 'out') {
      this.overlay.alpha = Math.min(1, this.overlay.alpha + Math.min(dt, FADE_MAX_STEP) / FADE_OUT);
      if (this.overlay.alpha >= 1) this.swap();
    } else if (this.phase === 'in') {
      this.overlay.alpha = Math.max(0, this.overlay.alpha - Math.min(dt, FADE_MAX_STEP) / FADE_IN);
      if (this.overlay.alpha <= 0) {
        this.phase = 'idle';
        this.overlay.visible = false;
      }
    }
    const scene = this._current;
    if (!scene || scene.destroyed) return;
    try {
      scene.update(dt);
    } catch (err) {
      // 예외가 ticker 밖으로 나가면 렌더 루프 전체가 멈춘다
      console.error('[scene] update 오류', err);
    }
  };

  private drawOverlay(vp: Viewport): void {
    // 레터박스 바깥까지 넉넉히 덮는다
    this.overlay.clear().rect(-vp.width, -vp.height, vp.width * 3, vp.height * 3).fill(UI_COLORS.bg);
  }
}
