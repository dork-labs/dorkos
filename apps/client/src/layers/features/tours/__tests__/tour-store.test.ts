import { describe, it, expect, beforeEach } from 'vitest';

import { useTourStore } from '../model/tour-store';

function reset() {
  useTourStore.setState({ runningTourId: null, activeIndex: 0, pendingOfferId: null });
}

describe('useTourStore', () => {
  beforeEach(reset);

  it('startTour runs a tour at step 0 and clears any pending offer', () => {
    useTourStore.getState().setPendingOffer('tasks');
    useTourStore.getState().startTour('general');
    const s = useTourStore.getState();
    expect(s.runningTourId).toBe('general');
    expect(s.activeIndex).toBe(0);
    expect(s.pendingOfferId).toBeNull();
  });

  it('advanceStep increments the active index', () => {
    useTourStore.getState().startTour('general');
    useTourStore.getState().advanceStep();
    useTourStore.getState().advanceStep();
    expect(useTourStore.getState().activeIndex).toBe(2);
  });

  it('endTour clears the running tour', () => {
    useTourStore.getState().startTour('tasks');
    useTourStore.getState().endTour();
    expect(useTourStore.getState().runningTourId).toBeNull();
    expect(useTourStore.getState().activeIndex).toBe(0);
  });

  it('setPendingOffer / clearPendingOffer manage the offer', () => {
    useTourStore.getState().setPendingOffer('mesh');
    expect(useTourStore.getState().pendingOfferId).toBe('mesh');
    useTourStore.getState().clearPendingOffer();
    expect(useTourStore.getState().pendingOfferId).toBeNull();
  });
});
