import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../app-store';
import type { PipContent } from '../app-store-pip';

describe('PipSlice', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ pipContent: null, pipGeometry: null });
  });

  it('openPip sets pipContent to the given descriptor', () => {
    const content: PipContent = { kind: 'demo', title: 'Demo panel' };
    useAppStore.getState().openPip(content);
    expect(useAppStore.getState().pipContent).toEqual(content);
  });

  it('openPip called a second time with different content replaces pipContent (no stacking, no dedup)', () => {
    useAppStore.getState().openPip({ kind: 'demo', title: 'First' });
    useAppStore.getState().openPip({ kind: 'demo', title: 'Second' });
    expect(useAppStore.getState().pipContent).toEqual({ kind: 'demo', title: 'Second' });
  });

  it('closePip sets pipContent to null and does not change pipGeometry', () => {
    const geometry = { x: 10, y: 20, width: 360, height: 240 };
    useAppStore.getState().openPip({ kind: 'demo', title: 'Demo' });
    useAppStore.getState().setPipGeometry(geometry);

    useAppStore.getState().closePip();

    expect(useAppStore.getState().pipContent).toBeNull();
    expect(useAppStore.getState().pipGeometry).toEqual(geometry);
  });

  it('setPipGeometry updates state.pipGeometry and writes the identical value as JSON to localStorage', () => {
    const geometry = { x: 5, y: 15, width: 400, height: 300 };
    useAppStore.getState().setPipGeometry(geometry);

    expect(useAppStore.getState().pipGeometry).toEqual(geometry);
    const stored = JSON.parse(localStorage.getItem('dorkos-pip-panel-state')!);
    expect(stored).toEqual(geometry);
  });

  it('resetPreferences clears pipContent and pipGeometry and removes the persisted key', () => {
    useAppStore.getState().openPip({ kind: 'demo', title: 'Demo' });
    useAppStore.getState().setPipGeometry({ x: 1, y: 2, width: 300, height: 200 });

    useAppStore.getState().resetPreferences();

    expect(useAppStore.getState().pipContent).toBeNull();
    expect(useAppStore.getState().pipGeometry).toBeNull();
    expect(localStorage.getItem('dorkos-pip-panel-state')).toBeNull();
  });

  it('never persists pipContent in any localStorage key, across several openPip calls', () => {
    useAppStore.getState().openPip({ kind: 'demo', title: 'A' });
    useAppStore.getState().setPipGeometry({ x: 1, y: 2, width: 300, height: 200 });
    useAppStore.getState().openPip({ kind: 'demo', title: 'B' });
    useAppStore.getState().openPip({ kind: 'demo', title: 'C secret title' });

    const stored = JSON.parse(localStorage.getItem('dorkos-pip-panel-state')!);
    // Only geometry-shaped data is ever persisted.
    expect(Object.keys(stored).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(stored).toEqual({ x: 1, y: 2, width: 300, height: 200 });

    // No localStorage value anywhere carries the content's title text.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key)).not.toContain('secret title');
    }
  });

  describe('hydration', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('hydrates pipGeometry from a pre-seeded localStorage value at store construction, unclamped', async () => {
      localStorage.clear();
      // Deliberately out-of-viewport geometry — hydration must not clamp; that
      // is the floating-panel primitive's job on mount (task 1.1).
      const staleGeometry = { x: -500, y: 99_999, width: 10, height: 10 };
      localStorage.setItem('dorkos-pip-panel-state', JSON.stringify(staleGeometry));

      const { useAppStore: freshStore } = await import('../app-store');
      expect(freshStore.getState().pipGeometry).toEqual(staleGeometry);
    });
  });
});
