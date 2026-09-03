import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock matchMedia (needed by app store init)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock font-related imports to prevent side effects
vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual('@/layers/shared/lib');
  return {
    ...actual,
    loadGoogleFont: vi.fn(),
    removeGoogleFont: vi.fn(),
    applyFontCSS: vi.fn(),
    removeFontCSS: vi.fn(),
    getFontConfig: () => ({ key: 'system', sans: '', mono: '', googleFontsUrl: '' }),
    isValidFontKey: () => false,
  };
});

import { useAppStore } from '@/layers/shared/model';

describe('promo state in app store', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    useAppStore.setState({ promoEnabled: true });
  });

  // `dismissedPromoIds` / `dismissPromo` used to live here, backed by
  // localStorage. They are `usePromoDismissals` (entities/config) now, so a
  // dismissal follows the person between devices instead of the browser — see
  // `use-promo-dismissals.test.tsx`. What is left in the store is the global
  // display toggle, which is genuinely a per-browser preference.

  describe('setPromoEnabled', () => {
    it('toggles the global flag', () => {
      const { result } = renderHook(() => useAppStore());
      expect(result.current.promoEnabled).toBe(true);
      act(() => {
        result.current.setPromoEnabled(false);
      });
      expect(result.current.promoEnabled).toBe(false);
    });

    it('persists to localStorage', () => {
      const { result } = renderHook(() => useAppStore());
      act(() => {
        result.current.setPromoEnabled(false);
      });
      expect(localStorageMock.setItem).toHaveBeenCalledWith('dorkos-promo-enabled', 'false');
    });
  });

  describe('resetAllSettings', () => {
    it('resets promoEnabled to true', () => {
      const { result } = renderHook(() => useAppStore());
      act(() => {
        result.current.setPromoEnabled(false);
      });
      act(() => {
        result.current.resetAllSettings();
      });
      expect(result.current.promoEnabled).toBe(true);
    });

    it('still sweeps the retired dismissal key out of localStorage', () => {
      // What this catches: dropping the sweep along with the store slice. An
      // install that has not yet run the one-time import still carries that
      // key, and a reset that left it behind would let it be imported into
      // config later — resurrecting dismissals the person had just cleared.
      const { result } = renderHook(() => useAppStore());
      act(() => {
        result.current.resetAllSettings();
      });
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('dorkos-dismissed-promo-ids');
    });
  });
});
