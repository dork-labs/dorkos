import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../app-store';
import { DEFAULT_FONT } from '@/layers/shared/lib/font-config';

/**
 * The two resets, side by side. What keeps them honest is that each assertion
 * names a key the OTHER one owns: `resetAppearance` must leave every
 * cross-slice key standing, and `resetAllSettings` must still take them all
 * down (DOR-923).
 */
const CROSS_SLICE_KEYS = [
  'dorkos-show-timestamps',
  'dorkos-expand-tool-calls',
  'dorkos-auto-hide-tool-calls',
  'dorkos-promo-enabled',
  'dorkos-sidebar-active-tab',
  'dorkos-right-panel-state',
  'dorkos-right-panel-layouts',
  'dorkos-pip-panel-state',
  'dorkos-dismissed-promo-ids',
];

function seed() {
  const s = useAppStore.getState();
  s.setShowTimestamps(true);
  s.setExpandToolCalls(true);
  s.setAutoHideToolCalls(false);
  s.setPromoEnabled(false);
  s.setSidebarActiveTab('connections');
  s.setPipGeometry({ x: 1, y: 2, width: 300, height: 200 });
  localStorage.setItem('dorkos-right-panel-state', '{"open":true,"activeTab":"profile"}');
  localStorage.setItem('dorkos-right-panel-layouts', '{"a1":{"open":true}}');
  localStorage.setItem('dorkos-dismissed-promo-ids', '["welcome"]');
  s.setFontSize('large');
  s.setFontFamily('geist');
}

describe('CoreSlice — resets', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().resetAllSettings();
    localStorage.clear();
  });

  describe('resetAppearance', () => {
    it('puts typography back to its default in state, storage, and the document', () => {
      seed();
      expect(document.documentElement.style.getPropertyValue('--user-font-scale')).not.toBe('1');

      useAppStore.getState().resetAppearance();

      expect(useAppStore.getState().fontSize).toBe('medium');
      expect(useAppStore.getState().fontFamily).toBe(DEFAULT_FONT);
      expect(localStorage.getItem('dorkos-font-size')).toBeNull();
      expect(localStorage.getItem('dorkos-font-family')).toBeNull();
      expect(document.documentElement.style.getPropertyValue('--user-font-scale')).toBe('1');
    });

    it('leaves every cross-slice storage key standing', () => {
      seed();

      useAppStore.getState().resetAppearance();

      for (const key of CROSS_SLICE_KEYS) {
        expect(
          localStorage.getItem(key),
          `${key} should survive an appearance reset`
        ).not.toBeNull();
      }
    });

    it('leaves every cross-slice value in the store alone', () => {
      seed();

      useAppStore.getState().resetAppearance();

      const s = useAppStore.getState();
      expect(s.showTimestamps).toBe(true);
      expect(s.expandToolCalls).toBe(true);
      expect(s.autoHideToolCalls).toBe(false);
      expect(s.promoEnabled).toBe(false);
      expect(s.sidebarActiveTab).toBe('connections');
      expect(s.pipGeometry).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    });
  });

  describe('resetAllSettings', () => {
    it('puts typography back to its default too', () => {
      seed();

      useAppStore.getState().resetAllSettings();

      expect(useAppStore.getState().fontSize).toBe('medium');
      expect(useAppStore.getState().fontFamily).toBe(DEFAULT_FONT);
      expect(localStorage.getItem('dorkos-font-size')).toBeNull();
      expect(localStorage.getItem('dorkos-font-family')).toBeNull();
    });

    it('still clears every cross-slice key — the clean slate is unchanged', () => {
      seed();

      useAppStore.getState().resetAllSettings();

      for (const key of CROSS_SLICE_KEYS) {
        expect(localStorage.getItem(key), `${key} should be cleared by the clean slate`).toBeNull();
      }
      const s = useAppStore.getState();
      expect(s.showTimestamps).toBe(false);
      expect(s.expandToolCalls).toBe(false);
      expect(s.autoHideToolCalls).toBe(true);
      expect(s.promoEnabled).toBe(true);
      expect(s.sidebarActiveTab).toBe('overview');
      expect(s.pipGeometry).toBeNull();
    });
  });

  /**
   * The one key that is NOT a preference, asserted rather than removed from the
   * list (DOR-2006 review nit).
   *
   * `dorkos-canvas-sessions` stopped being local state when the canvas moved to
   * the server: what is left is a one-time migration payload holding documents
   * that may exist NOWHERE else yet. Dropping it from `CROSS_SLICE_KEYS` made
   * the suite silent about it; sweeping it would throw away somebody's canvas
   * because they reset their preferences before opening that session again.
   */
  describe('the retired canvas key', () => {
    const LEGACY_CANVAS_KEY = 'dorkos-canvas-sessions';

    it('survives both resets, because it is a migration payload and not a preference', () => {
      seed();
      localStorage.setItem(LEGACY_CANVAS_KEY, '{"s1":{"documents":[]}}');

      useAppStore.getState().resetAppearance();
      expect(localStorage.getItem(LEGACY_CANVAS_KEY)).not.toBeNull();

      useAppStore.getState().resetAllSettings();
      expect(localStorage.getItem(LEGACY_CANVAS_KEY)).not.toBeNull();
    });
  });
});
