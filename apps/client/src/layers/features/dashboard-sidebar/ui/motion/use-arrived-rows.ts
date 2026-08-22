/**
 * Which rows in a section have just turned up (spec `sidebar-simplification`
 * D5, "Arrive, settle, no pulse").
 *
 * @module features/dashboard-sidebar/ui/motion/use-arrived-rows
 */
import { useEffect, useState } from 'react';
import { ARRIVED_TINT_MS, LAYOUT_KEY_SEPARATOR } from './sidebar-motion';

/** Nothing arrived, as one identity — a fresh `Set` per render would re-run effects. */
const NOTHING: ReadonlySet<string> = new Set<string>();

/** The row keys a layout key spells, in order. */
function keysOf(layoutKey: string): string[] {
  return layoutKey === '' ? [] : layoutKey.split(LAYOUT_KEY_SEPARATOR);
}

/**
 * The rows that entered this section since the last frame, for one tint each.
 *
 * **Nothing arrives at boot, and that is the whole reason this is state and not
 * an effect.** `initial` is read once, when a row mounts, so "is this row new?"
 * has to be answerable in the render that mounts it — an effect answers a frame
 * too late and the entrance never plays. The set is therefore adjusted DURING
 * render against the previous layout key, which is React's own pattern for state
 * that follows a prop (`react.dev/learn/you-might-not-need-an-effect`), and the
 * first render seeds "seen" with everything the section already had. A panel
 * painting for the first time — warm or cold — has no arrivals by construction.
 *
 * **`enabled` is the boot gate**, and while it is false the section still tracks
 * what it has seen but reports nothing. That covers the window a warm boot
 * spends between its first paint and the gate opening, where rows genuinely do
 * appear and none of them is an arrival: they are the panel loading.
 *
 * The set empties itself {@link ARRIVED_TINT_MS} later, so `data-arrived` is a
 * pulse rather than a state — a row cannot sit tinted, and a boot cannot inherit
 * one.
 *
 * @param layoutKey - The section's row ids in order, from `sectionLayoutKey`.
 * @param enabled - Whether arrivals should be reported at all.
 */
export function useArrivedRows(layoutKey: string, enabled: boolean): ReadonlySet<string> {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(keysOf(layoutKey)));
  const [lastKey, setLastKey] = useState(layoutKey);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NOTHING);

  if (lastKey !== layoutKey) {
    const keys = keysOf(layoutKey);
    const fresh = enabled ? keys.filter((key) => !seen.has(key)) : [];
    setLastKey(layoutKey);
    setSeen(new Set(keys));
    setArrived(fresh.length === 0 ? NOTHING : new Set(fresh));
  }

  useEffect(() => {
    if (arrived.size === 0) return;
    const timer = setTimeout(() => setArrived(NOTHING), ARRIVED_TINT_MS);
    return () => clearTimeout(timer);
  }, [arrived]);

  return arrived;
}
