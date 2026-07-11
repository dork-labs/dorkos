import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../app-store';
import { readPipGeometry } from '../app-store-helpers';
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

  describe('readPipGeometry validation', () => {
    it('returns null for corrupt (non-JSON) data', () => {
      localStorage.setItem('dorkos-pip-panel-state', 'not-json');
      expect(readPipGeometry()).toBeNull();
    });

    it('returns null for valid JSON with a wrong shape (missing fields)', () => {
      localStorage.setItem('dorkos-pip-panel-state', JSON.stringify({ x: 5 }));
      expect(readPipGeometry()).toBeNull();
    });

    it('returns null for non-object JSON values', () => {
      localStorage.setItem('dorkos-pip-panel-state', JSON.stringify([1, 2, 3, 4]));
      expect(readPipGeometry()).toBeNull();
      localStorage.setItem('dorkos-pip-panel-state', 'null');
      expect(readPipGeometry()).toBeNull();
      localStorage.setItem('dorkos-pip-panel-state', '42');
      expect(readPipGeometry()).toBeNull();
    });

    it('returns null when a field is non-numeric', () => {
      localStorage.setItem(
        'dorkos-pip-panel-state',
        JSON.stringify({ x: '5', y: 10, width: 300, height: 200 })
      );
      expect(readPipGeometry()).toBeNull();
    });

    it('returns null when a field is NaN or Infinity', () => {
      // JSON.stringify turns NaN/Infinity into null, so craft raw strings that
      // JSON.parse would never produce but a buggy writer or manual edit could.
      localStorage.setItem(
        'dorkos-pip-panel-state',
        JSON.stringify({ x: null, y: 10, width: 300, height: 200 })
      );
      expect(readPipGeometry()).toBeNull();
      localStorage.setItem('dorkos-pip-panel-state', '{"x":1e999,"y":10,"width":300,"height":200}');
      expect(readPipGeometry()).toBeNull();
    });

    it('returns the geometry when all four fields are finite numbers', () => {
      const geometry = { x: 5, y: 10, width: 300, height: 200 };
      localStorage.setItem('dorkos-pip-panel-state', JSON.stringify(geometry));
      expect(readPipGeometry()).toEqual(geometry);
    });
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

    it.each([
      ['corrupt JSON', 'not-json'],
      ['wrong shape', JSON.stringify({ x: 5 })],
      ['non-numeric field', JSON.stringify({ x: '5', y: 10, width: 300, height: 200 })],
      ['non-finite field', '{"x":1e999,"y":10,"width":300,"height":200}'],
    ])('falls back to null pipGeometry when the persisted value is %s', async (_label, raw) => {
      localStorage.clear();
      localStorage.setItem('dorkos-pip-panel-state', raw);

      const { useAppStore: freshStore } = await import('../app-store');
      expect(freshStore.getState().pipGeometry).toBeNull();
    });
  });
});
