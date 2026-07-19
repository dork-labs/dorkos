import { useLayoutEffect, useState } from 'react';

/**
 * DOM id of the app-shell PanelGroup hosting the right panel. Applied to the
 * group in AppShell so {@link useRightPanelSizing} can locate and measure it
 * via `[data-panel-group-id]`.
 */
export const RIGHT_PANEL_GROUP_ID = 'app-shell-right-panel';

/**
 * Size (% of the panel group) the right panel opens at. Also the floor passed
 * to `expand()` — reopening restores a larger remembered size, never a
 * squished sub-default one (DOR-388).
 */
export const RIGHT_PANEL_DEFAULT_PCT = 40;

/** Pixel floor for the expanded panel — tab content squishes below this. */
const MIN_WIDTH_PX = 320;

/** Minimum (%) used until the group has been measured. */
const FALLBACK_MIN_PCT = 20;

/** Cap on the computed minimum so small windows keep a usable resize range. */
const MAX_MIN_PCT = 50;

/**
 * Convert the pixel floor into a percentage of the panel group's width.
 *
 * Returns {@link FALLBACK_MIN_PCT} for an unmeasured (zero-width) group and
 * caps the result at {@link MAX_MIN_PCT} so a small window can't force the
 * minimum above a usable range.
 *
 * @param groupWidthPx - Measured width of the PanelGroup element in pixels
 */
export function minSizePctFor(groupWidthPx: number): number {
  if (groupWidthPx <= 0) return FALLBACK_MIN_PCT;
  const pct = (MIN_WIDTH_PX / groupWidthPx) * 100;
  return Math.min(Math.round(pct * 10) / 10, MAX_MIN_PCT);
}

/** Live percentage constraints for the right panel. */
export interface RightPanelSizing {
  /** Minimum size (% of the group) equivalent to the pixel floor. */
  minPct: number;
  /** Size (% of the group) the panel opens at — never below `minPct`. */
  defaultPct: number;
}

/**
 * Percentage constraints for the right panel backed by a real pixel floor.
 *
 * react-resizable-panels sizes panels as percentages of their group, so a
 * static `minSize` lets the panel shrink to unusable pixel widths on smaller
 * windows. This hook measures the shell PanelGroup with a ResizeObserver and
 * converts the pixel floor into a live percentage — re-computed whenever a
 * window resize or the left sidebar changes the group's width. The library
 * re-validates layout on `minSize` changes, so an open panel below a rising
 * floor is bumped up automatically.
 */
export function useRightPanelSizing(): RightPanelSizing {
  const [minPct, setMinPct] = useState(FALLBACK_MIN_PCT);

  useLayoutEffect(() => {
    const group = document.querySelector(`[data-panel-group-id="${RIGHT_PANEL_GROUP_ID}"]`);
    if (!(group instanceof HTMLElement)) return;
    const update = () => setMinPct(minSizePctFor(group.offsetWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  return { minPct, defaultPct: Math.max(RIGHT_PANEL_DEFAULT_PCT, minPct) };
}
