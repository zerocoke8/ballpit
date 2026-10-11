// 웹폰트 로드. 실패하거나 느리면 시스템 폰트로 진행한다.
import { perfMark } from '../debug/perfOverlay';

export const FONT_FAMILY = "Jua, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";

const FONT_NAME = 'Jua';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Jua&display=swap';
const TIMEOUT_MS = 3000;
/** 첫 화면에 바로 쓰일 글자 (우선 로드) */
const SAMPLE_TEXT = '동물볼슈터가방상점전투시작이어하기 0123456789ABCabc★+-%';

let loading: Promise<void> | null = null;
/** Jua 조각을 전부 받을 때까지(타임아웃과 무관, 실패해도 resolve) */
let settled: Promise<void> | null = null;
let done = false;
let timedOut = false;

/** 부팅이 기다리는 로드: Jua를 받거나 TIMEOUT_MS가 지나면 resolve (늦으면 폴백 폰트로 진행) */
export function loadFonts(): Promise<void> {
  if (!loading) {
    settled = loadJua()
      .catch((err: unknown) => {
        console.warn('[fonts] 로드 실패', err);
      })
      .then(() => {
        done = true;
      });
    loading = withTimeout(settled, TIMEOUT_MS);
  }
  return loading;
}

/** 타임아웃 안에 Jua 로드가 끝났으면 true (loadFonts가 끝난 뒤에 의미 있음) */
export function fontsReadyInTime(): boolean {
  return done && !timedOut;
}

/**
 * Jua 로드가 실제로 끝나는 시점 (타임아웃 뒤에 늦게 끝날 수도 있다). 그 전에 구워 둔 글자 캐시
 * (Toast 등)는 폴백 폰트로 그려졌으므로, 늦게 끝나면 이 시점에 한 번 다시 굽는다.
 * pixi의 Text는 폰트가 늦게 와도 스스로 다시 그리지 않는다 — 이미 화면에 있는 글자가 전투 중에 갑자기 다시
 * 래스터화되는 일은 없고, 새로 만드는 글자부터 Jua로 그려진다.
 */
export function fontsSettled(): Promise<void> {
  void loadFonts();
  return settled ?? Promise.resolve();
}

async function loadJua(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  await injectStylesheet();
  // 구글 폰트 한글은 unicode-range 조각으로 나뉘어 있어서, 샘플 글자만 로드하면
  // 나머지 글자가 캔버스에서 폴백 폰트로 그려진다. 조각을 전부 요청한다.
  const faces: Promise<unknown>[] = [document.fonts.load(`32px ${FONT_NAME}`, SAMPLE_TEXT)];
  document.fonts.forEach((face) => {
    if (face.family.replace(/["']/g, '') === FONT_NAME && face.status === 'unloaded') {
      faces.push(face.load().catch(() => undefined));
    }
  });
  await Promise.all(faces);
}

function injectStylesheet(): Promise<void> {
  return new Promise((resolve) => {
    const head = document.head;
    for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
      const pre = document.createElement('link');
      pre.rel = 'preconnect';
      pre.href = href;
      if (href.includes('gstatic')) pre.crossOrigin = 'anonymous';
      head.appendChild(pre);
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    head.appendChild(link);
  });
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[fonts] ${FONT_NAME} 로드 ${ms}ms 초과 — 폴백 폰트로 진행`);
      resolve();
    }, ms);
    void p.then(() => {
      if (timedOut) {
        perfMark('fontLate');
        return;
      }
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Jua 로드 시도가 끝났는가 (늦게라도). 이 뒤에 만드는 글자는 Jua로 그려진다 */
export function fontsLoaded(): boolean {
  return done;
}
