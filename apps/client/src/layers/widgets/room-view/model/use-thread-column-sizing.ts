import { useCallback, useState } from 'react';

/** Id of the room/thread `PanelGroup`, and the prefix of its panes' ids. */
export const THREAD_SPLIT_ID = 'room-thread-split';

/** Narrowest the thread may get: below this its composer and messages squash. */
const THREAD_MIN_PX = 320;

/** Narrowest the room beside it may get, so its timeline stays a readable column. */
const ROOM_MIN_PX = 360;

/** Width (% of the split) a thread opens at before anyone has dragged it. */
const THREAD_DEFAULT_PCT = 40;

/**
 * Cap on each side's floor. When the split is too narrow to honour both pixel
 * floors, neither side may claim more than half of it — the two meet in the
 * middle instead of one squeezing the other off screen.
 */
const MAX_FLOOR_PCT = 50;

/** Floors used until the split has been measured (jsdom, the first frame). */
const FALLBACK_FLOOR_PCT = 25;

/** Live percentage bounds for the thread column. */
export interface ThreadColumnSizing {
  /** Narrowest the thread may be dragged, as a % of the split. */
  minPct: number;
  /** Widest the thread may be dragged — whatever leaves the room its floor. */
  maxPct: number;
  /** Where a first-ever thread opens, inside `[minPct, maxPct]`. */
  defaultPct: number;
}

function floorPct(px: number, splitWidthPx: number): number {
  if (splitWidthPx <= 0) return FALLBACK_FLOOR_PCT;
  return Math.min(Math.round((px / splitWidthPx) * 1000) / 10, MAX_FLOOR_PCT);
}

/**
 * The thread column's bounds for a split of the given width.
 *
 * `react-resizable-panels` sizes panes in percentages of their group, so the
 * two pixel floors — one for the thread, one for the room — are converted here
 * against the measured width. The thread's maximum is whatever leaves the room
 * its floor, so dragging the thread wide can never shrink the room's timeline
 * below a readable column, and dragging it narrow can never squash the
 * composer.
 *
 * @param splitWidthPx - Measured width of the room + thread split, in pixels.
 */
export function threadColumnSizingFor(splitWidthPx: number): ThreadColumnSizing {
  const minPct = floorPct(THREAD_MIN_PX, splitWidthPx);
  const maxPct = Math.round((100 - floorPct(ROOM_MIN_PX, splitWidthPx)) * 10) / 10;
  return {
    minPct,
    maxPct,
    defaultPct: Math.min(Math.max(THREAD_DEFAULT_PCT, minPct), maxPct),
  };
}

/**
 * Where the thread should sit, as a % of the split: the width this reader
 * chose, in pixels, held inside today's bounds — or the default when they have
 * never chosen one.
 *
 * **The chosen width is kept in pixels and never overwritten by a clamp.** A
 * narrower window or the right panel opening squeezes the thread to fit; the
 * squeeze is applied here, on the way out, and the stored number is untouched,
 * so the thread grows back to the width the reader set as soon as there is room
 * for it again.
 *
 * @param chosenPx - The thread width this reader last dragged to, or `null`.
 * @param splitWidthPx - The split's measured width, or `null` before it has one.
 * @param sizing - The split's current bounds.
 */
export function threadPctFor(
  chosenPx: number | null,
  splitWidthPx: number | null,
  sizing: ThreadColumnSizing
): number {
  if (chosenPx === null || splitWidthPx === null || splitWidthPx <= 0) return sizing.defaultPct;
  const pct = (chosenPx / splitWidthPx) * 100;
  return Math.round(Math.min(Math.max(pct, sizing.minPct), sizing.maxPct) * 10) / 10;
}

/**
 * The thread width this reader last chose, from their own browser.
 *
 * @param storageKey - Where it is kept.
 */
export function readChosenThreadWidth(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey);
    const px = raw === null ? NaN : Number(raw);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

/**
 * Remember a thread width this reader chose. Losing it is harmless — the
 * thread opens at the default — so a browser that refuses storage is ignored.
 *
 * @param storageKey - Where to keep it.
 * @param px - The width, in pixels.
 */
export function writeChosenThreadWidth(storageKey: string, px: number): void {
  try {
    localStorage.setItem(storageKey, String(Math.round(px)));
  } catch {
    // Private mode or blocked storage: the width lasts this visit only.
  }
}

/** The measured split: a ref for its element, and the bounds it implies. */
export interface ThreadColumnMeasure {
  /** Attach to the element the split fills. */
  ref: (element: HTMLElement | null) => void | (() => void);
  /** The split's element once mounted, for reaching the separator inside it. */
  element: HTMLElement | null;
  /** The split's width in pixels, or `null` before it has been measured. */
  width: number | null;
  /** The thread's current bounds. */
  sizing: ThreadColumnSizing;
}

/**
 * Measure the room + thread split and keep the thread's bounds in pixels.
 *
 * Re-measured on every size change — a window resize, the sidebar collapsing,
 * the right panel opening beside the room. Measured inside the ref callback so
 * the first real bounds are in place in the same pre-paint pass the split
 * mounts in.
 */
export function useThreadColumnSizing(): ThreadColumnMeasure {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    if (node === null) return;
    setElement(node);
    const update = () => setWidth(node.offsetWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      setElement(null);
      setWidth(null);
    };
  }, []);

  return { ref, element, width, sizing: threadColumnSizingFor(width ?? 0) };
}
