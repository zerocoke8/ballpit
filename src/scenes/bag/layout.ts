// BagView 내부 배치 계산 (BagView 로컬 좌표, 원점 좌상단). 격자 칸 크기는 가방 크기와 폭에 맞춰 정한다.
import { CELL } from '../../config';

/** 툴팁 패널 높이 (고정) */
export const TOOLTIP_H = 230;
/** 섹션 사이 간격 */
export const SECTION_GAP = 14;
/** 바깥 여백 */
export const MARGIN = 16;
/** 격자와 보관함 사이 */
const GRID_STASH_GAP = 12;
/** 격자 최대 높이 (7×6 가방도 상점 화면에 들어가도록) */
const MAX_GRID_H = 490;
/** 보관함 칸 */
const STASH_COLS = 2;
const STASH_SLOT_MAX = 72;
const STASH_SLOT_GAP = 6;
const STASH_LABEL_H = 30;
/** 하단 버튼 줄 */
export const BUTTONS_H = 76;

export interface BagMetrics {
  width: number;
  cell: number;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  stashX: number;
  stashY: number;
  stashW: number;
  stashH: number;
  stashSlot: number;
  stashSlotGap: number;
  stashCols: number;
  stashRows: number;
  stashLabelH: number;
  /** 격자/보관함 영역 높이 */
  areaY: number;
  areaH: number;
  buttonsY: number;
  contentHeight: number;
}

export function computeBagMetrics(width: number, cols: number, rows: number, stashCapacity: number): BagMetrics {
  const stashRows = Math.max(1, Math.ceil(stashCapacity / STASH_COLS));
  const inner = width - MARGIN * 2;
  // 보관함 칸은 격자 칸보다 크지 않게. 먼저 최대 크기로 가정하고 격자 칸을 정한다
  const stashSlotGuess = STASH_SLOT_MAX;
  const stashWGuess = STASH_COLS * stashSlotGuess + (STASH_COLS - 1) * STASH_SLOT_GAP;
  const fitW = Math.floor((inner - GRID_STASH_GAP - stashWGuess) / Math.max(1, cols));
  const fitH = Math.floor(MAX_GRID_H / Math.max(1, rows));
  const cell = Math.max(40, Math.min(CELL, fitW, fitH));
  const stashSlot = Math.min(STASH_SLOT_MAX, cell);
  const stashW = STASH_COLS * stashSlot + (STASH_COLS - 1) * STASH_SLOT_GAP;
  const stashH = STASH_LABEL_H + stashRows * stashSlot + (stashRows - 1) * STASH_SLOT_GAP;

  const gridW = cols * cell;
  const gridH = rows * cell;
  const total = gridW + GRID_STASH_GAP + stashW;
  const gridX = Math.round((width - total) / 2);
  const areaY = TOOLTIP_H + SECTION_GAP;
  const areaH = Math.max(gridH, stashH);
  const gridY = areaY + Math.round((areaH - gridH) / 2);
  const stashX = gridX + gridW + GRID_STASH_GAP;
  const stashY = areaY;
  const buttonsY = areaY + areaH + SECTION_GAP;

  return {
    width,
    cell,
    gridX,
    gridY,
    gridW,
    gridH,
    stashX,
    stashY,
    stashW,
    stashH,
    stashSlot,
    stashSlotGap: STASH_SLOT_GAP,
    stashCols: STASH_COLS,
    stashRows,
    stashLabelH: STASH_LABEL_H,
    areaY,
    areaH,
    buttonsY,
    contentHeight: buttonsY + BUTTONS_H,
  };
}

/** 보관함 index번 칸의 좌상단 */
export function stashSlotPos(m: BagMetrics, index: number): { x: number; y: number } {
  const c = index % m.stashCols;
  const r = Math.floor(index / m.stashCols);
  return {
    x: m.stashX + c * (m.stashSlot + m.stashSlotGap),
    y: m.stashY + m.stashLabelH + r * (m.stashSlot + m.stashSlotGap),
  };
}

/** 로컬 좌표 → 보관함 칸 index (칸 사이 틈 포함, 영역 밖이면 -1) */
export function stashIndexAt(m: BagMetrics, x: number, y: number, capacity: number): number {
  const top = m.stashY + m.stashLabelH;
  if (x < m.stashX || x >= m.stashX + m.stashW || y < top || y >= m.stashY + m.stashH) return -1;
  const step = m.stashSlot + m.stashSlotGap;
  const c = Math.min(m.stashCols - 1, Math.floor((x - m.stashX) / step));
  const r = Math.min(m.stashRows - 1, Math.floor((y - top) / step));
  const idx = r * m.stashCols + c;
  return idx < capacity ? idx : -1;
}

/** 보관함 영역(라벨 포함) 안인지 — 드롭 판정용으로 살짝 넉넉하게 */
export function inStashArea(m: BagMetrics, x: number, y: number, pad = 10): boolean {
  return x >= m.stashX - pad && x <= m.stashX + m.stashW + pad && y >= m.stashY - pad && y <= m.stashY + m.stashH + pad;
}
