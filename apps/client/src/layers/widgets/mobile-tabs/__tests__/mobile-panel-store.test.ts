// @vitest-environment jsdom
/**
 * The one bit the phone cockpit shares with the shell, and the value it starts
 * at.
 *
 * **A file of its own, because the default is the thing under test.** Vitest
 * gives each file a fresh module registry, so the store here is the one the app
 * boots with. In `MobileTabsLayout.test.tsx` the same store has already been
 * written by an earlier render, so an assertion about its initial value there
 * measures the previous test's cleanup — which is exactly how flipping the
 * default to `true` passed that suite unchanged.
 */
import { describe, it, expect } from 'vitest';
import { useMobilePanelStore, lowerMobilePanels } from '../model/mobile-panel-store';

describe('the mobile panel store', () => {
  it('starts DOWN, so a cold load lands on the routed page (review B1)', () => {
    // `/` is the #team room. A phone that opened with a destination's panel
    // over it could not reach the home surface at all until it navigated
    // somewhere else, and nothing on screen dismissed the layer.
    expect(useMobilePanelStore.getState().panelUp).toBe(false);
  });

  it('raises and lowers', () => {
    useMobilePanelStore.getState().raise();
    expect(useMobilePanelStore.getState().panelUp).toBe(true);
    useMobilePanelStore.getState().lower();
    expect(useMobilePanelStore.getState().panelUp).toBe(false);
  });

  it('lowers from outside React — the router subscription’s caller', () => {
    useMobilePanelStore.getState().raise();
    lowerMobilePanels();
    expect(useMobilePanelStore.getState().panelUp).toBe(false);
  });
});
