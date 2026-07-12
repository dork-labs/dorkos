import { useState, useEffect } from 'react';

/**
 * Height in px the visual viewport is inset from the bottom of the layout
 * viewport — the space a phone's on-screen keyboard (and any other visual-only
 * chrome) is currently eating. Software keyboards shrink the visual viewport
 * without touching the layout viewport, so a `position: fixed; bottom: 0`
 * element can hide behind the keyboard; add this inset to keep it above.
 *
 * Subscribes to both `resize` and `scroll` on `window.visualViewport` — the
 * keyboard opening fires `resize`, and scrolling the shrunken viewport shifts
 * `offsetTop` via `scroll`.
 *
 * Behavior, precisely:
 * - Software keyboard open → the keyboard's height in px.
 * - Pinch-zoomed (`scale > 1`) → 0 by design: zooming also shrinks
 *   `visualViewport.height`, so the formula would report a large phantom
 *   "keyboard" inset with no keyboard present; the reading is unreliable
 *   under zoom, and 0 (the pre-inset behavior) is the right degradation.
 * - `visualViewport` unavailable (jsdom, SSR, old browsers) → 0, exactly the
 *   pre-inset behavior, so degradation is free.
 *
 * @returns The bottom inset in whole pixels (0 when there is no keyboard).
 */
export function useVisualViewportBottomInset(): number {
  const [inset, setInset] = useState(() => readInset());

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      const next = readInset();
      // Only re-render when the rounded value actually moved (resize/scroll
      // fire continuously during a keyboard animation or overscroll).
      setInset((prev) => (prev === next ? prev : next));
    };
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    return () => {
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
    };
  }, []);

  return inset;
}

/** Current bottom inset, or 0 when `visualViewport` is unavailable or pinch-zoomed. */
function readInset(): number {
  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
  if (!vv) return 0;
  // Pinch-zoom also shrinks visualViewport.height, which would read as a large
  // phantom keyboard. The reading is unreliable under zoom — degrade to 0.
  if (vv.scale > 1) return 0;
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
}
