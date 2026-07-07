/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { STATUS_BAR_REGISTRY, resetStatusBarPreferences } from '../model/status-bar-registry';
import { useAppStore } from '@/layers/shared/model';

// localStorage mock required for Zustand store persistence calls.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(global, 'localStorage', { value: localStorageMock });

beforeEach(() => {
  localStorageMock.clear();
  // Reset all status bar visibility to defaults before each test
  useAppStore.setState({
    showStatusBarCwd: true,
    showStatusBarGit: true,
    showStatusBarModel: true,
    showStatusBarContext: true,
    showStatusBarPermission: true,
    showStatusBarSound: true,
    showStatusBarPolling: true,
    showTimestamps: false,
  });
});

describe('Status bar inline management integration', () => {
  it('registry covers all showStatusBar* store properties', () => {
    const store = useAppStore.getState();
    const storeKeys = Object.keys(store)
      .filter((k) => k.startsWith('showStatusBar') && !k.startsWith('setShowStatusBar'))
      .map((k) => k.replace('showStatusBar', ''))
      .map((k) => k.charAt(0).toLowerCase() + k.slice(1));

    const registryKeys = STATUS_BAR_REGISTRY.map((item) => item.key);

    // Every store key should be in the registry
    for (const storeKey of storeKeys) {
      expect(registryKeys).toContain(storeKey);
    }
  });

  it('every registry key has a corresponding store getter and setter', () => {
    const store = useAppStore.getState() as unknown as Record<string, unknown>;
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const showProp = `showStatusBar${capitalizedKey}`;
      const setProp = `setShowStatusBar${capitalizedKey}`;

      expect(typeof store[showProp]).toBe('boolean');
      expect(typeof store[setProp]).toBe('function');
    }
  });

  it('resetStatusBarPreferences only resets status bar toggles', () => {
    const store = useAppStore.getState();

    // Change a status bar preference
    store.setShowStatusBarCwd(false);
    // Change a non-status-bar preference
    store.setShowTimestamps(true);

    resetStatusBarPreferences();

    // Status bar pref should be reset to defaultVisible
    expect(useAppStore.getState().showStatusBarCwd).toBe(true);
    // Non-status-bar pref should be unchanged
    expect(useAppStore.getState().showTimestamps).toBe(true);
  });

  it('registry defaultVisible values match expected store defaults (all true)', () => {
    // All current items default to true — this test will catch any future
    // deviation from this assumption and force an explicit decision.
    for (const item of STATUS_BAR_REGISTRY) {
      expect(item.defaultVisible).toBe(true);
    }
  });

  it('registry count matches the number of showStatusBar* properties in the store', () => {
    const store = useAppStore.getState();
    const storeStatusBarKeys = Object.keys(store).filter(
      (k) => k.startsWith('showStatusBar') && !k.startsWith('setShowStatusBar')
    );

    expect(STATUS_BAR_REGISTRY).toHaveLength(storeStatusBarKeys.length);
  });

  it('resetStatusBarPreferences restores all registry items to their defaultVisible values', () => {
    const store = useAppStore.getState();

    // Hide all items
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const setProp = `setShowStatusBar${capitalizedKey}` as keyof typeof store;
      (store[setProp] as (v: boolean) => void)(false);
    }

    resetStatusBarPreferences();

    const resetState = useAppStore.getState() as unknown as Record<string, unknown>;
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const showProp = `showStatusBar${capitalizedKey}`;
      expect(resetState[showProp]).toBe(item.defaultVisible);
    }
  });
});
