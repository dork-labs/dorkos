/**
 * Whether a tab panel is covering the routed page right now (P4).
 *
 * **A store rather than a prop, because two layers need the same bit.** The
 * panels are an opaque layer over the shell's content, so the page underneath
 * has to be made unreachable while they are up — not just invisible. Only
 * `AppShell` can mark that page `inert`, and only `MobileTabsLayout` knows
 * whether a panel is showing, so the bit travels between them here. Lifting the
 * whole tab state into the shell instead would put the phone's navigation state
 * in the one file P4 was supposed to touch once.
 *
 * **Not persisted, and reset when the layout goes away.** "Am I looking at
 * Library or at the room I opened?" is a fact about this glance, not a
 * preference; a phone that comes back after a resize to desktop and back starts
 * where a cold load starts.
 *
 * @module widgets/mobile-tabs/model/mobile-panel-store
 */
import { create } from 'zustand';

/** The one bit, and the acts on it. */
interface MobilePanelState {
  /** Whether a destination's panel is covering the routed page. */
  panelUp: boolean;
  /** Show a destination's panel. */
  raise: () => void;
  /**
   * Put the panels away, revealing the routed page.
   *
   * The commonest caller is a navigation: opening a row is a request to go
   * somewhere, and the layout getting out of the way is what honours it.
   */
  lower: () => void;
}

/** The in-memory panel store. */
export const useMobilePanelStore = create<MobilePanelState>((set) => ({
  // **Down on a cold load, and this is load-bearing.** `/` is the #team room,
  // so a phone that opened with Home covering it could not reach the home
  // surface at all until it navigated somewhere else (review B1). Landing on
  // the route with the destinations one tap away is both honest and reachable.
  panelUp: false,
  raise: () => set({ panelUp: true }),
  lower: () => set({ panelUp: false }),
}));

/** Put the panels away from outside React — the router subscription's caller. */
export function lowerMobilePanels(): void {
  useMobilePanelStore.getState().lower();
}
