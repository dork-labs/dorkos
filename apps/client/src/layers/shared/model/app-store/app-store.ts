/**
 * App store — global Zustand store for the DorkOS client.
 *
 * Composed from four slices, each responsible for a distinct domain:
 *   - CoreSlice        : sidebar, session, navigation, streaming status, context files
 *   - PanelsSlice      : transient dialog / panel open-close state
 *   - PreferencesSlice : persisted boolean settings, font, and promo
 *   - CanvasSlice      : per-session canvas UI state
 *
 * @module shared/model/app-store
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  type FontFamilyKey,
  DEFAULT_FONT,
  getFontConfig,
  loadGoogleFont,
  applyFontCSS,
  STORAGE_KEYS,
  MAX_RECENT_CWDS,
} from '@/layers/shared/lib';
import { readBool, writeBool, BOOL_KEYS, BOOL_DEFAULTS, type RecentCwd } from './app-store-helpers';
import { createPanelsSlice } from './app-store-panels';
import { createPreferencesSlice } from './app-store-preferences';
import { createCanvasSlice } from './app-store-canvas';
import type { AppState } from './app-store-types';

export type { AppState } from './app-store-types';
export type { ContextFile, RecentCwd } from './app-store-helpers';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>()(
  devtools(
    (...a) => {
      const [set] = a;
      return {
        // ── Sidebar ────────────────────────────────────────────────────────
        // On mobile, always start closed regardless of persisted value
        sidebarOpen: (() => {
          try {
            if (window.matchMedia('(max-width: 767px)').matches) return false;
          } catch {}
          return readBool(BOOL_KEYS.sidebarOpen, BOOL_DEFAULTS.sidebarOpen);
        })(),
        toggleSidebar: () =>
          set((s) => {
            const next = !s.sidebarOpen;
            writeBool(BOOL_KEYS.sidebarOpen, next);
            return { sidebarOpen: next };
          }),
        setSidebarOpen: (open) => {
          writeBool(BOOL_KEYS.sidebarOpen, open);
          set({ sidebarOpen: open });
        },

        sidebarActiveTab: (() => {
          try {
            const stored = localStorage.getItem('dorkos-sidebar-active-tab');
            if (
              stored === 'overview' ||
              stored === 'sessions' ||
              stored === 'schedules' ||
              stored === 'connections'
            )
              return stored;
          } catch {}
          return 'overview';
        })() as 'overview' | 'sessions' | 'schedules' | 'connections',
        setSidebarActiveTab: (tab) => {
          try {
            localStorage.setItem('dorkos-sidebar-active-tab', tab);
          } catch {}
          set({ sidebarActiveTab: tab });
        },

        // Not persisted — always starts at dashboard level
        sidebarLevel: 'dashboard' as const,
        setSidebarLevel: (level) => set({ sidebarLevel: level }),

        // ── Session & navigation ───────────────────────────────────────────
        sessionId: null,
        setSessionId: (id) => set({ sessionId: id }),

        selectedCwd: null,
        setSelectedCwd: (cwd) =>
          set((s) => {
            const entry: RecentCwd = { path: cwd, accessedAt: new Date().toISOString() };
            const recents = [entry, ...s.recentCwds.filter((r) => r.path !== cwd)].slice(
              0,
              MAX_RECENT_CWDS
            );
            try {
              localStorage.setItem(STORAGE_KEYS.RECENT_CWDS, JSON.stringify(recents));
            } catch {}
            return { selectedCwd: cwd, recentCwds: recents };
          }),

        recentCwds: (() => {
          try {
            const raw: unknown[] = JSON.parse(
              localStorage.getItem(STORAGE_KEYS.RECENT_CWDS) || '[]'
            );
            return raw.map((item) =>
              typeof item === 'string'
                ? { path: item, accessedAt: new Date().toISOString() }
                : (item as RecentCwd)
            );
          } catch {
            return [];
          }
        })(),

        devtoolsOpen: false,
        toggleDevtools: () => set((s) => ({ devtoolsOpen: !s.devtoolsOpen })),

        previousCwd: null,
        setPreviousCwd: (cwd) => set({ previousCwd: cwd }),

        // ── Session UI status ──────────────────────────────────────────────
        isStreaming: false,
        setIsStreaming: (v) => set({ isStreaming: v }),
        isTextStreaming: false,
        setIsTextStreaming: (v) => set({ isTextStreaming: v }),
        isWaitingForUser: false,
        setIsWaitingForUser: (v) => set({ isWaitingForUser: v }),
        activeForm: null,
        setActiveForm: (v) => set({ activeForm: v }),
        tasksBadgeCount: 0,
        setTasksBadgeCount: (v) => set({ tasksBadgeCount: v }),

        // ── Context files ──────────────────────────────────────────────────
        contextFiles: [],
        addContextFile: (file) =>
          set((s) => {
            if (s.contextFiles.some((f) => f.path === file.path)) return s;
            return { contextFiles: [...s.contextFiles, { ...file, id: crypto.randomUUID() }] };
          }),
        removeContextFile: (id) =>
          set((s) => ({ contextFiles: s.contextFiles.filter((f) => f.id !== id) })),
        clearContextFiles: () => set({ contextFiles: [] }),

        // ── Preferences reset (cross-slice — lives here where set is fully typed) ──
        resetPreferences: () => {
          try {
            for (const lsKey of Object.values(BOOL_KEYS)) {
              localStorage.removeItem(lsKey);
            }
            localStorage.removeItem(STORAGE_KEYS.FONT_SIZE);
            localStorage.removeItem(STORAGE_KEYS.FONT_FAMILY);
            localStorage.removeItem('dorkos-sidebar-active-tab');
            localStorage.removeItem('dorkos-dismissed-promo-ids');
            localStorage.removeItem(STORAGE_KEYS.CANVAS_SESSIONS);
          } catch {}
          document.documentElement.style.setProperty('--user-font-scale', '1');
          const defaultConfig = getFontConfig(DEFAULT_FONT);
          if (defaultConfig.googleFontsUrl) loadGoogleFont(defaultConfig.googleFontsUrl);
          applyFontCSS(defaultConfig.sans, defaultConfig.mono);
          set({
            ...BOOL_DEFAULTS,
            devtoolsOpen: false,
            fontSize: 'medium' as const,
            fontFamily: DEFAULT_FONT as FontFamilyKey,
            sidebarActiveTab: 'overview' as const,
            dismissedPromoIds: [],
          });
        },

        // ── Composed slices ────────────────────────────────────────────────
        ...createPanelsSlice(...a),
        ...createPreferencesSlice(...a),
        ...createCanvasSlice(...a),
      };
    },
    { name: 'app-store' }
  )
);
