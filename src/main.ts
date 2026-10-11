// 부트스트랩: 로딩 표시 → 앱 생성(+성능 오버레이 ?perf) → 폰트 → 에셋 → GPU 미리 올리기 → 알림 문구 미리 굽기
// → Game → 타이틀(또는 ?gallery 개발 갤러리). 로딩 표시 아래 막대가 진행도.
// 스모크 테스트용 디버그 훅 window.__game 을 노출한다 (docs/ARCHITECTURE.md "디버그 훅").
import { UI_COLORS } from './config';
import { createApp } from './core/app';
import { FONT_FAMILY, loadFonts } from './core/fonts';
import { installPerf, perfMark, perfNow, perfReport, type PerfReport } from './debug/perfOverlay';
import { initGame, type Game } from './game';
import { T } from './i18n/ko';
import { addToStash } from './logic/bag';
import { GAME_DATA } from './data';
import { loadAssets } from './render/assets';
import { prewarmGpu } from './render/gpuWarm';
import { DevGalleryScene } from './scenes/DevGalleryScene';
import { Toast } from './ui/Toast';
import { combatToastTexts, menuToastTexts, toastColors } from './ui/toastStrings';
import type { StashItem, Tier } from './types';

/** 씬이 선택적으로 구현하는 디버그 메서드 (덕 타이핑) */
interface DebugCapableScene {
  debugWin?: () => void;
  debugLose?: () => void;
  setSpeed?: (mul: number) => void;
  refresh?: () => void;
}

export interface GameDebugHandle {
  game: Game;
  /** 현재 씬의 sceneName (없으면 '') */
  scene(): string;
  debug: {
    /** 현재 씬이 debugWin()을 가지고 있으면 호출하고 true */
    winStage(): boolean;
    loseStage(): boolean;
    /** 런이 있으면 골드 추가 후 새 골드 반환, 없으면 null */
    addGold(n: number): number | null;
    /** 보관함에 추가. 런이 없거나 모르는 id거나 보관함이 가득 차면 null */
    addItem(defId: string, tier?: Tier): StashItem | null;
    setSpeed(mul: number): boolean;
  };
  /** 성능 오버레이 기록(끊김·태그) + 알림 캐시 상태 — 측정 도구용 */
  perf(): PerfReport & { toast: ReturnType<typeof Toast.stats> };
}

declare global {
  interface Window {
    __game?: GameDebugHandle;
  }
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** PixiJS가 뜨기 전 보여주는 HTML 로딩 표시 */
function showLoader(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'boot-loader';
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:18px',
    `background:${hex(UI_COLORS.bg)}`,
    `color:${hex(UI_COLORS.textDim)}`,
    `font-family:${FONT_FAMILY}`,
    'font-size:18px',
    'z-index:10',
    'transition:opacity 0.25s',
    'white-space:pre-line',
    'text-align:center',
  ].join(';');

  const dots = document.createElement('div');
  dots.style.cssText = 'display:flex;gap:10px';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.style.cssText = [
      'width:14px',
      'height:14px',
      'border-radius:50%',
      `background:${hex(UI_COLORS.gold)}`,
      `animation:boot-bounce 0.9s ${i * 0.15}s infinite ease-in-out`,
    ].join(';');
    dots.appendChild(d);
  }
  const style = document.createElement('style');
  style.textContent =
    '@keyframes boot-bounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-12px);opacity:1}}';
  const label = document.createElement('div');
  label.className = 'boot-label';
  label.textContent = T.common.loading;
  // 진행 막대 (폰트 → 에셋 → GPU 업로드 → 알림 굽기)
  const track = document.createElement('div');
  track.style.cssText = ['width:180px', 'height:8px', 'border-radius:4px', `background:${hex(UI_COLORS.panelLight)}`, 'overflow:hidden'].join(';');
  const bar = document.createElement('div');
  bar.className = 'boot-bar';
  bar.style.cssText = ['width:0%', 'height:100%', 'border-radius:4px', `background:${hex(UI_COLORS.gold)}`, 'transition:width 0.15s'].join(';');
  track.appendChild(bar);
  el.append(style, dots, label, track);
  document.body.appendChild(el);
  return el;
}

/** 로딩 막대: [from, to] 구간 안에서 done/total 만큼 (0..1) */
function setLoaderProgress(el: HTMLElement, from: number, to: number, done = 1, total = 1): void {
  const bar = el.querySelector<HTMLElement>('.boot-bar');
  if (!bar) return;
  const f = from + (to - from) * (total > 0 ? Math.min(1, done / total) : 1);
  bar.style.width = `${Math.round(f * 100)}%`;
}

function hideLoader(el: HTMLElement): void {
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 300);
}

function installDebugHooks(game: Game): void {
  const current = (): DebugCapableScene | null =>
    (game.scenes.current as unknown as DebugCapableScene | null) ?? null;
  const refresh = (): void => {
    const s = current();
    if (typeof s?.refresh === 'function') s.refresh();
  };

  window.__game = {
    game,
    scene: () => game.scenes.current?.sceneName ?? '',
    perf: () => ({ ...perfReport(), toast: Toast.stats() }),
    debug: {
      winStage() {
        const s = current();
        if (typeof s?.debugWin !== 'function') return false;
        s.debugWin();
        return true;
      },
      loseStage() {
        const s = current();
        if (typeof s?.debugLose !== 'function') return false;
        s.debugLose();
        return true;
      },
      addGold(n) {
        const run = game.run;
        if (!run || !Number.isFinite(n)) return null;
        run.gold = Math.max(0, Math.floor(run.gold + n));
        refresh();
        return run.gold;
      },
      addItem(defId, tier = 1) {
        const run = game.run;
        if (!run || !game.data.items[defId]) return null;
        const t = Math.max(1, Math.min(3, Math.floor(tier))) as Tier;
        const added = addToStash(run.bag, defId, t);
        if (added) refresh();
        return added;
      },
      setSpeed(mul) {
        const s = current();
        if (typeof s?.setSpeed !== 'function') return false;
        s.setSpeed(mul);
        return true;
      },
    },
  };
}

async function main(): Promise<void> {
  const loader = showLoader();
  try {
    const mount = document.getElementById('app');
    if (!mount) throw new Error('#app element not found');
    const gameApp = await createApp(mount);
    // 렌더러 계측은 텍스처가 등록되기 전에 (업로드 이벤트까지 잡히게)
    installPerf(gameApp);
    let game: Game | null = null;
    // 알림 캐시: 배경 굽기는 전투 밖(메뉴)에서만
    Toast.init(gameApp, () => game?.scenes.current?.sceneName !== 'CombatScene');
    const renderer = gameApp.app.renderer;
    const params = new URLSearchParams(window.location.search);
    // ?noprewarm: GPU 미리 올리기·알림 미리 굽기를 건너뛴다 (폰에서 ?perf와 함께 전후 비교용)
    const prewarm = !params.has('noprewarm');
    setLoaderProgress(loader, 0, 0.05);

    let t0 = perfNow();
    await loadFonts();
    perfMark('fonts', t0);
    setLoaderProgress(loader, 0.05, 0.3);

    t0 = perfNow();
    await loadAssets(renderer);
    perfMark('assets', t0);
    setLoaderProgress(loader, 0.3, 0.55);

    // 에셋 텍스처 전부 GPU에 올리고(렌더러 GC 대상에서 뺌) 셰이더를 미리 컴파일 — 첫 화면·처음 보는 적에서 끊기지 않게
    if (prewarm) await prewarmGpu(renderer, { onProgress: (d, n) => setLoaderProgress(loader, 0.55, 0.75, d, n) });

    // 전투 중 뜨는 알림(아이템 드롭 / 보관함 가득 환전)을 미리 구워 둔다 — 드롭 순간 글자 래스터화가 없게
    if (prewarm) {
      await Toast.prewarm(combatToastTexts(GAME_DATA), {
        colors: toastColors(),
        onProgress: (d, n) => setLoaderProgress(loader, 0.75, 1, d, n),
      });
      // 가방·상점 알림은 메뉴 화면의 쉬는 프레임에 하나씩
      Toast.queuePrewarm(menuToastTexts(GAME_DATA));
    }

    game = initGame(gameApp);
    installDebugHooks(game);

    if (params.has('gallery')) game.scenes.goto(new DevGalleryScene());
    else game.toTitle();
    hideLoader(loader);
  } catch (err) {
    const label = loader.querySelector('.boot-label');
    if (label) label.textContent = T.menu.bootFailed;
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error('[main] boot failed', err);
});
