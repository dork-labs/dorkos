import { useCallback, useState } from 'react';

/**
 * `autoSaveId` of the room/thread split. The library stores the dragged width
 * in this viewer's browser under it, so every room reopens its thread at the
 * width this reader last left one — the same per-viewer memory the right
 * panel's split has.
 */
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
  const maxPct = 100 - floorPct(ROOM_MIN_PX, splitWidthPx);
  return {
    minPct,
    maxPct,
    defaultPct: Math.min(Math.max(THREAD_DEFAULT_PCT, minPct), maxPct),
  };
}

/** The measured split: a ref for its element, and the bounds it implies. */
export interface ThreadColumnMeasure {
  /** Attach to the element the split fills. */
  ref: (element: HTMLElement | null) => void | (() => void);
  /**
   * True once the split's element exists and has been measured.
   *
   * The thread pane waits for this. `react-resizable-panels` writes the
   * separator's ARIA range when the layout changes, not when the bounds do, so
   * a pane mounted against the unmeasured fallback would announce a range it
   * does not have until the first drag. Measuring inside the ref callback puts
   * the real bounds in place in the same pre-paint pass, so nothing flashes.
   */
  measured: boolean;
  /** The thread's current bounds. */
  sizing: ThreadColumnSizing;
}

/**
 * Measure the room + thread split and keep the thread's bounds in pixels.
 *
 * Re-measured on every size change — a window resize, the sidebar collapsing,
 * the right panel opening beside the room — and the library re-validates the
 * layout when the bounds move, so a thread wider than a shrinking room allows
 * is pulled back in on its own.
 */
export function useThreadColumnSizing(): ThreadColumnMeasure {
  const [width, setWidth] = useState<number | null>(null);

  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    const update = () => setWidth(element.offsetWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      setWidth(null);
    };
  }, []);

  return { ref, measured: width !== null, sizing: threadColumnSizingFor(width ?? 0) };
}
