import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  STATUS_BAR_REGISTRY,
  getGroupedRegistryItems,
  resetStatusBarPreferences,
} from '../model/status-bar-registry';
import { useAppStore } from '@/layers/shared/model';

// Mock localStorage for the Zustand store
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
  // Reset store to default state before each test
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('STATUS_BAR_REGISTRY', () => {
  it('contains exactly 10 items', () => {
    expect(STATUS_BAR_REGISTRY).toHaveLength(10);
  });

  it('has unique keys', () => {
    const keys = STATUS_BAR_REGISTRY.map((item) => item.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('has the expected keys in order', () => {
    const keys = STATUS_BAR_REGISTRY.map((item) => item.key);
    expect(keys).toEqual([
      'cwd',
      'git',
      'runtime',
      'model',
      'cache',
      'context',
      'usage',
      'permission',
      'sound',
      'polling',
    ]);
  });

  it('every item has label, description, group, icon, and defaultVisible', () => {
    for (const item of STATUS_BAR_REGISTRY) {
      expect(item.label).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(['session', 'controls']).toContain(item.group);
      expect(item.icon).toBeDefined();
      expect(typeof item.defaultVisible).toBe('boolean');
    }
  });

  it('every registry key has a corresponding showStatusBar* boolean in the Zustand store', () => {
    const state = useAppStore.getState();
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const showProp = `showStatusBar${capitalizedKey}` as keyof typeof state;
      expect(typeof state[showProp]).toBe('boolean');
    }
  });

  it('every registry key has a corresponding setShowStatusBar* setter in the Zustand store', () => {
    const state = useAppStore.getState();
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const setProp = `setShowStatusBar${capitalizedKey}` as keyof typeof state;
      expect(typeof state[setProp]).toBe('function');
    }
  });
});

describe('getGroupedRegistryItems', () => {
  it('returns exactly 2 groups', () => {
    const groups = getGroupedRegistryItems();
    expect(groups).toHaveLength(2);
  });

  it('returns groups in order: session, controls', () => {
    const groups = getGroupedRegistryItems();
    expect(groups[0].group).toBe('session');
    expect(groups[1].group).toBe('controls');
  });

  it('session group has 7 items', () => {
    const groups = getGroupedRegistryItems();
    const sessionGroup = groups.find((g) => g.group === 'session');
    expect(sessionGroup?.items).toHaveLength(7);
  });

  it('controls group has 3 items', () => {
    const groups = getGroupedRegistryItems();
    const controlsGroup = groups.find((g) => g.group === 'controls');
    expect(controlsGroup?.items).toHaveLength(3);
  });

  it('includes correct group labels', () => {
    const groups = getGroupedRegistryItems();
    expect(groups[0].label).toBe('Session Info');
    expect(groups[1].label).toBe('Controls');
  });
});

describe('resetStatusBarPreferences', () => {
  it('resets a toggled-off status bar item back to its defaultVisible=true', () => {
    // Turn off CWD
    useAppStore.getState().setShowStatusBarCwd(false);
    expect(useAppStore.getState().showStatusBarCwd).toBe(false);

    resetStatusBarPreferences();

    expect(useAppStore.getState().showStatusBarCwd).toBe(true);
  });

  it('resets all status bar booleans to their defaultVisible values', () => {
    // Turn off several items
    useAppStore.getState().setShowStatusBarGit(false);
    useAppStore.getState().setShowStatusBarModel(false);

    resetStatusBarPreferences();

    const state = useAppStore.getState();
    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const showProp = `showStatusBar${capitalizedKey}` as keyof typeof state;
      expect(state[showProp]).toBe(item.defaultVisible);
    }
  });

  it('does NOT reset non-status-bar preferences like showTimestamps', () => {
    // Change a non-status-bar preference
    useAppStore.getState().setShowTimestamps(true);
    expect(useAppStore.getState().showTimestamps).toBe(true);

    // Also flip a status bar item so we can verify reset works
    useAppStore.getState().setShowStatusBarCwd(false);

    resetStatusBarPreferences();

    // Status bar item is reset
    expect(useAppStore.getState().showStatusBarCwd).toBe(true);
    // Non-status-bar preference is untouched
    expect(useAppStore.getState().showTimestamps).toBe(true);
  });
});
