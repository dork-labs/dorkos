/**
 * Whether Today's "+ N automated" reveal is open, for as long as this window
 * lives (BC-19).
 *
 * **Deliberately not persisted config.** Unfolding a reveal is a glance, not a
 * setting: it answers "what ran overnight?" once, and a person who opened it on
 * Tuesday has not asked to see scheduled runs on every machine forever. Library
 * section folds ARE preferences and live in `~/.dork/config.json`; this one
 * resets with the tab, which is the honest lifetime for a glance.
 *
 * @module features/dashboard-sidebar/model/today-reveal-store
 */
import { create } from 'zustand';

/** The one bit, and the two acts on it. */
interface TodayRevealState {
  /** Whether the automated runs are unfolded under their reveal row. */
  automatedExpanded: boolean;
  /** Open it if it is shut, shut it if it is open. */
  toggleAutomated: () => void;
  /** Fold it back. Tests, and any surface that resets the panel. */
  reset: () => void;
}

/**
 * The in-memory reveal store.
 *
 * Read by `useSidebarState` into the model's snapshot, written by the row's own
 * click through {@link toggleTodayAutomated}: the row builds its handler in
 * render and fires it in an event, so it must not subscribe. It is the last
 * store of this shape in the panel — the idle-nudge dismissals used the same
 * one until DOR-1391 retired them.
 */
export const useTodayRevealStore = create<TodayRevealState>((set) => ({
  automatedExpanded: false,
  toggleAutomated: () => set((state) => ({ automatedExpanded: !state.automatedExpanded })),
  reset: () => set({ automatedExpanded: false }),
}));

/** Unfold or fold Today's automated runs from outside React. */
export function toggleTodayAutomated(): void {
  useTodayRevealStore.getState().toggleAutomated();
}
