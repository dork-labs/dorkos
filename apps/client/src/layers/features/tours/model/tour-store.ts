import { create } from 'zustand';

import type { TourId, TourOccasion } from './tour-definitions';

/** Ephemeral runtime state for the living tour (never persisted). */
interface TourStoreState {
  /** The tour currently running, or null when none is. */
  runningTourId: TourId | null;
  /** The active step index within the running tour. */
  activeIndex: number;
  /** The occasion tour currently being offered as a chip, or null. */
  pendingOfferId: TourOccasion | null;
  /** Start a tour at its first step (clears any pending offer). */
  startTour: (id: TourId) => void;
  /** Advance to the next step. */
  advanceStep: () => void;
  /** End the running tour. */
  endTour: () => void;
  /** Offer an occasion tour. */
  setPendingOffer: (id: TourOccasion) => void;
  /** Withdraw the pending offer. */
  clearPendingOffer: () => void;
}

/**
 * The tour runtime store. Holds only ephemeral UI state — which tour is running,
 * which step, and which occasion is being offered. Persistent decisions
 * (seen/declined) live in the config `tours` block via {@link useTours}.
 */
export const useTourStore = create<TourStoreState>()((set) => ({
  runningTourId: null,
  activeIndex: 0,
  pendingOfferId: null,
  startTour: (id) => set({ runningTourId: id, activeIndex: 0, pendingOfferId: null }),
  advanceStep: () => set((s) => ({ activeIndex: s.activeIndex + 1 })),
  endTour: () => set({ runningTourId: null, activeIndex: 0 }),
  setPendingOffer: (id) => set({ pendingOfferId: id }),
  clearPendingOffer: () => set({ pendingOfferId: null }),
}));
