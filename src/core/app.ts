// PixiJS 앱 생성 + 논리 좌표(폭 720) 스케일링 + 레터박스 + safe area + 그래픽 품질(렌더 해상도).
import { Application, Container, Graphics } from 'pixi.js';
import { DESIGN_MAX_H, DESIGN_MIN_H, DESIGN_W, SETTINGS_KEY, UI_COLORS } from '../config';
import { looksWeak, resolutionFor, type DeviceHints } from './quality';
import { onSettingsChange, settings, updateSettings } from './settings';
import { bindTweenTicker } from './tween';

/** 논리 좌표 기준 화면 정보 */
export interface Viewport {
  width: number;
  height: number;
  safeTop: number;
  safeBottom: number;
}

export interface GameApp {
  app: Application;
  /** 논리 좌표계 루트 (스케일/센터링 적용됨). 모든 씬은 여기에 붙는다 */
  root: Container;
  readonly viewport: Viewport;
  /** 논리 viewport가 바뀔 때마다 호출. 해제 함수 반환 */
  onResize(cb: (vp: Viewport) => void): () => void;
}

/** 렌더 해상도: settings.quality에 따라 high = min(dpr, 2), low = min(dpr, 1.25) (core/quality.ts) */
function deviceResolution(): number {
  return resolutionFor(settings.quality, window.devicePixelRatio || 1);
}

/**
 * 첫 실행(저장된 설정이 아예 없을 때)만: 저사양으로 보이는 기기면 품질 '낮음'으로 시작한다.
 * updateSettings가 저장하므로 다음 실행부터는 플레이어가 고른(또는 이때 정해진) 값을 그대로 쓴다.
 */
function autoPickQuality(): void {
  try {
    if (typeof localStorage === 'undefined' || localStorage.getItem(SETTINGS_KEY) !== null) return;
  } catch {
    return; // 저장소를 못 읽으면(사생활 보호 모드 등) 기본값 유지
  }
  const nav = navigator as Navigator & DeviceHints;
  if (looksWeak({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory })) {
    updateSettings({ quality: 'low' });
  }
}

export async function createApp(mount: HTMLElement): Promise<GameApp> {
  autoPickQuality();
  const app = new Application();
  await app.init({
    width: Math.max(1, mount.clientWidth || window.innerWidth),
    height: Math.max(1, mount.clientHeight || window.innerHeight),
    background: UI_COLORS.bg,
    resolution: deviceResolution(),
    autoDensity: true,
    antialias: true,
    preference: 'webgl',
  });
  mount.appendChild(app.canvas);
  app.canvas.style.display = 'block';
  app.canvas.style.touchAction = 'none';

  const root = new Container();
  root.label = 'root';
  // 레터박스 띠: 논리 영역 밖으로 삐져나온 씬 내용을 덮는다
  const letterbox = new Graphics();
  letterbox.label = 'letterbox';
  letterbox.eventMode = 'none';
  app.stage.addChild(root, letterbox);

  const probe = createSafeAreaProbe();
  const listeners = new Set<(vp: Viewport) => void>();
  let viewport: Viewport = { width: DESIGN_W, height: DESIGN_MIN_H, safeTop: 0, safeBottom: 0 };

  const applyLayout = (): void => {
    const winW = Math.max(1, mount.clientWidth || window.innerWidth);
    const winH = Math.max(1, mount.clientHeight || window.innerHeight);
    const res = deviceResolution();
    if (app.renderer.width !== winW || app.renderer.height !== winH || app.renderer.resolution !== res) {
      app.renderer.resize(winW, winH, res);
    }

    let scale = winW / DESIGN_W;
    let height = winH / scale;
    if (height < DESIGN_MIN_H) {
      scale = winH / DESIGN_MIN_H;
      height = DESIGN_MIN_H;
    } else if (height > DESIGN_MAX_H) {
      height = DESIGN_MAX_H;
    }
    const ox = (winW - DESIGN_W * scale) / 2;
    const oy = (winH - height * scale) / 2;
    root.scale.set(scale);
    root.position.set(Math.round(ox * res) / res, Math.round(oy * res) / res);

    letterbox.clear();
    if (ox > 0.5) {
      letterbox.rect(0, 0, ox, winH).rect(winW - ox, 0, ox, winH).fill(UI_COLORS.bg);
    }
    if (oy > 0.5) {
      letterbox.rect(0, 0, winW, oy).rect(0, winH - oy, winW, oy).fill(UI_COLORS.bg);
    }

    const inset = readSafeArea(probe);
    const next: Viewport = {
      width: DESIGN_W,
      height,
      safeTop: Math.max(0, (inset.top - oy) / scale),
      safeBottom: Math.max(0, (inset.bottom - oy) / scale),
    };
    const changed =
      next.height !== viewport.height ||
      next.safeTop !== viewport.safeTop ||
      next.safeBottom !== viewport.safeBottom;
    viewport = next;
    if (changed) for (const cb of [...listeners]) cb(viewport);
  };

  // 리사이즈 이벤트는 프레임당 한 번으로 합친다. 회전 직후엔 크기가 늦게 반영되는 브라우저가 있어 한 번 더 잰다.
  let rafId = 0;
  const schedule = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyLayout();
    });
  };
  const scheduleLate = (): void => {
    schedule();
    setTimeout(schedule, 300);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', scheduleLate);
  window.visualViewport?.addEventListener('resize', schedule);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(mount);
  // 품질을 바꾸면 바로 해상도 적용 (다음 프레임에 한 번 — 글자는 새 해상도로 다시 래스터화된다)
  let quality = settings.quality;
  onSettingsChange((s) => {
    if (s.quality === quality) return;
    quality = s.quality;
    schedule();
  });

  applyLayout();
  bindTweenTicker(app.ticker);

  return {
    app,
    root,
    get viewport() {
      return viewport;
    },
    onResize(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function createSafeAreaProbe(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'visibility:hidden',
    'pointer-events:none',
    'padding-top:env(safe-area-inset-top, 0px)',
    'padding-bottom:env(safe-area-inset-bottom, 0px)',
    'padding-left:env(safe-area-inset-left, 0px)',
    'padding-right:env(safe-area-inset-right, 0px)',
  ].join(';');
  document.body.appendChild(el);
  return el;
}

function readSafeArea(el: HTMLElement): { top: number; bottom: number } {
  const cs = getComputedStyle(el);
  return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
}
