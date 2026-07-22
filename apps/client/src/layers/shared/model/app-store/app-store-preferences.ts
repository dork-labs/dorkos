/**
 * Preferences slice — persisted user settings (booleans, font, promo) for the app store.
 *
 * All fields in this slice are backed by localStorage and survive page refresh.
 * `resetPreferences` is intentionally absent here — it touches cross-slice state
 * (sidebarOpen, sidebarActiveTab, devtoolsOpen) so it lives in the core slice in
 * app-store.ts where `set` has the full AppState type.
 *
 * @module shared/model/app-store-preferences
 */
import type { StateCreator } from 'zustand';
import type { FontFamilyKey } from '@/layers/shared/lib';
import {
  DEFAULT_FONT,
  getFontConfig,
  isValidFontKey,
  loadGoogleFont,
  removeGoogleFont,
  applyFontCSS,
  removeFontCSS,
  STORAGE_KEYS,
  FONT_SCALE_MAP,
} from '@/layers/shared/lib';
import { readBool, writeBool, BOOL_KEYS, BOOL_DEFAULTS } from './app-store-helpers';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface PreferencesSlice {
  showTimestamps: boolean;
  setShowTimestamps: (v: boolean) => void;
  expandToolCalls: boolean;
  setExpandToolCalls: (v: boolean) => void;
  autoHideToolCalls: boolean;
  setAutoHideToolCalls: (v: boolean) => void;
  showShortcutChips: boolean;
  setShowShortcutChips: (v: boolean) => void;
  showTaskCelebrations: boolean;
  setShowTaskCelebrations: (v: boolean) => void;
  enableNotificationSound: boolean;
  setEnableNotificationSound: (v: boolean) => void;
  enableTasksNotifications: boolean;
  setEnableTasksNotifications: (v: boolean) => void;
  enableMessagePolling: boolean;
  setEnableMessagePolling: (v: boolean) => void;

  fontSize: 'small' | 'medium' | 'large';
  setFontSize: (v: 'small' | 'medium' | 'large') => void;
  fontFamily: FontFamilyKey;
  setFontFamily: (key: FontFamilyKey) => void;

  promoEnabled: boolean;
  setPromoEnabled: (enabled: boolean) => void;
  dismissedPromoIds: string[];
  dismissPromo: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the preferences slice (all persisted user settings). */
export const createPreferencesSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  PreferencesSlice
> = (set) => ({
  showTimestamps: readBool(BOOL_KEYS.showTimestamps, BOOL_DEFAULTS.showTimestamps),
  setShowTimestamps: (v) => {
    writeBool(BOOL_KEYS.showTimestamps, v);
    set({ showTimestamps: v });
  },
  expandToolCalls: readBool(BOOL_KEYS.expandToolCalls, BOOL_DEFAULTS.expandToolCalls),
  setExpandToolCalls: (v) => {
    writeBool(BOOL_KEYS.expandToolCalls, v);
    set({ expandToolCalls: v });
  },
  autoHideToolCalls: readBool(BOOL_KEYS.autoHideToolCalls, BOOL_DEFAULTS.autoHideToolCalls),
  setAutoHideToolCalls: (v) => {
    writeBool(BOOL_KEYS.autoHideToolCalls, v);
    set({ autoHideToolCalls: v });
  },
  showShortcutChips: readBool(BOOL_KEYS.showShortcutChips, BOOL_DEFAULTS.showShortcutChips),
  setShowShortcutChips: (v) => {
    writeBool(BOOL_KEYS.showShortcutChips, v);
    set({ showShortcutChips: v });
  },
  showTaskCelebrations: readBool(
    BOOL_KEYS.showTaskCelebrations,
    BOOL_DEFAULTS.showTaskCelebrations
  ),
  setShowTaskCelebrations: (v) => {
    writeBool(BOOL_KEYS.showTaskCelebrations, v);
    set({ showTaskCelebrations: v });
  },
  enableNotificationSound: readBool(
    BOOL_KEYS.enableNotificationSound,
    BOOL_DEFAULTS.enableNotificationSound
  ),
  setEnableNotificationSound: (v) => {
    writeBool(BOOL_KEYS.enableNotificationSound, v);
    set({ enableNotificationSound: v });
  },
  enableTasksNotifications: readBool(
    BOOL_KEYS.enableTasksNotifications,
    BOOL_DEFAULTS.enableTasksNotifications
  ),
  setEnableTasksNotifications: (v) => {
    writeBool(BOOL_KEYS.enableTasksNotifications, v);
    set({ enableTasksNotifications: v });
  },
  enableMessagePolling: readBool(
    BOOL_KEYS.enableMessagePolling,
    BOOL_DEFAULTS.enableMessagePolling
  ),
  setEnableMessagePolling: (v) => {
    writeBool(BOOL_KEYS.enableMessagePolling, v);
    set({ enableMessagePolling: v });
  },

  fontSize: (() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.FONT_SIZE);
      if (stored === 'small' || stored === 'medium' || stored === 'large') {
        document.documentElement.style.setProperty('--user-font-scale', FONT_SCALE_MAP[stored]);
        return stored;
      }
    } catch {}
    return 'medium';
  })() as 'small' | 'medium' | 'large',
  setFontSize: (v) => {
    try {
      localStorage.setItem(STORAGE_KEYS.FONT_SIZE, v);
    } catch {}
    document.documentElement.style.setProperty('--user-font-scale', FONT_SCALE_MAP[v]);
    set({ fontSize: v });
  },

  fontFamily: (() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.FONT_FAMILY);
      const key = isValidFontKey(stored ?? '') ? stored! : DEFAULT_FONT;
      const config = getFontConfig(key);
      if (config.googleFontsUrl) loadGoogleFont(config.googleFontsUrl);
      if (config.key !== 'system') applyFontCSS(config.sans, config.mono);
      return key as FontFamilyKey;
    } catch {
      return DEFAULT_FONT;
    }
  })() as FontFamilyKey,
  setFontFamily: (key) => {
    try {
      localStorage.setItem(STORAGE_KEYS.FONT_FAMILY, key);
    } catch {}
    const config = getFontConfig(key);
    if (config.googleFontsUrl) {
      loadGoogleFont(config.googleFontsUrl);
    } else {
      removeGoogleFont();
    }
    if (config.key !== 'system') {
      applyFontCSS(config.sans, config.mono);
    } else {
      removeFontCSS();
    }
    set({ fontFamily: key });
  },

  promoEnabled: readBool(BOOL_KEYS.promoEnabled, BOOL_DEFAULTS.promoEnabled),
  setPromoEnabled: (v) => {
    writeBool(BOOL_KEYS.promoEnabled, v);
    set({ promoEnabled: v });
  },
  dismissedPromoIds: (() => {
    try {
      const stored = localStorage.getItem('dorkos-dismissed-promo-ids');
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed))
          return parsed.filter((id): id is string => typeof id === 'string');
      }
    } catch {}
    return [];
  })(),
  dismissPromo: (id) =>
    set((s) => {
      if (s.dismissedPromoIds.includes(id)) return s;
      const next = [...s.dismissedPromoIds, id];
      try {
        localStorage.setItem('dorkos-dismissed-promo-ids', JSON.stringify(next));
      } catch {}
      return { dismissedPromoIds: next };
    }),
});
