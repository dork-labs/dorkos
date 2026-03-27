import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { UiCanvasContent } from '@dorkos/shared/types';
import {
  type FontFamilyKey,
  DEFAULT_FONT,
  getFontConfig,
  isValidFontKey,
  loadGoogleFont,
  removeGoogleFont,
  applyFontCSS,
  removeFontCSS,
  STORAGE_KEYS,
  FONT_SCALE_MAP,
  MAX_RECENT_CWDS,
} from '@/layers/shared/lib';
import {
  readBool,
  writeBool,
  BOOL_KEYS,
  BOOL_DEFAULTS,
  type ContextFile,
  type RecentCwd,
} from './app-store-helpers';

export type { ContextFile, RecentCwd } from './app-store-helpers';

interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  sidebarActiveTab: 'overview' | 'sessions' | 'schedules' | 'connections';
  setSidebarActiveTab: (tab: 'overview' | 'sessions' | 'schedules' | 'connections') => void;

  // Transient dialog state (survives mobile sidebar remount)
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  pulseOpen: boolean;
  setPulseOpen: (open: boolean) => void;
  pulseAgentFilter: string | null;
  setPulseAgentFilter: (id: string | null) => void;
  pulseEditScheduleId: string | null;
  setPulseEditScheduleId: (id: string | null) => void;
  openPulseForAgent: (agentId: string) => void;
  openPulseToEdit: (scheduleId: string) => void;
  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  meshOpen: boolean;
  setMeshOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  agentDialogOpen: boolean;
  setAgentDialogOpen: (open: boolean) => void;
  onboardingStep: number | null;
  setOnboardingStep: (step: number | null) => void;
  /** First message generated during onboarding, used for the magic transition animation. */
  dorkbotFirstMessage: string | null;
  setDorkbotFirstMessage: (msg: string | null) => void;
  globalPaletteOpen: boolean;
  setGlobalPaletteOpen: (open: boolean) => void;
  toggleGlobalPalette: () => void;
  globalPaletteInitialSearch: string | null;
  openGlobalPaletteWithSearch: (text: string) => void;
  clearGlobalPaletteInitialSearch: () => void;
  shortcutsPanelOpen: boolean;
  setShortcutsPanelOpen: (open: boolean) => void;
  toggleShortcutsPanel: () => void;

  sessionId: string | null;
  setSessionId: (id: string | null) => void;

  selectedCwd: string | null;
  setSelectedCwd: (cwd: string) => void;

  recentCwds: RecentCwd[];

  devtoolsOpen: boolean;
  toggleDevtools: () => void;

  showTimestamps: boolean;
  setShowTimestamps: (v: boolean) => void;
  expandToolCalls: boolean;
  setExpandToolCalls: (v: boolean) => void;
  autoHideToolCalls: boolean;
  setAutoHideToolCalls: (v: boolean) => void;
  showShortcutChips: boolean;
  setShowShortcutChips: (v: boolean) => void;
  showStatusBarCwd: boolean;
  setShowStatusBarCwd: (v: boolean) => void;
  showStatusBarPermission: boolean;
  setShowStatusBarPermission: (v: boolean) => void;
  showStatusBarModel: boolean;
  setShowStatusBarModel: (v: boolean) => void;
  showStatusBarCost: boolean;
  setShowStatusBarCost: (v: boolean) => void;
  showStatusBarContext: boolean;
  setShowStatusBarContext: (v: boolean) => void;
  showStatusBarGit: boolean;
  setShowStatusBarGit: (v: boolean) => void;
  showTaskCelebrations: boolean;
  setShowTaskCelebrations: (v: boolean) => void;
  enableNotificationSound: boolean;
  setEnableNotificationSound: (v: boolean) => void;
  enablePulseNotifications: boolean;
  setEnablePulseNotifications: (v: boolean) => void;
  showStatusBarSound: boolean;
  setShowStatusBarSound: (v: boolean) => void;
  showStatusBarTunnel: boolean;
  setShowStatusBarTunnel: (v: boolean) => void;
  showStatusBarSync: boolean;
  setShowStatusBarSync: (v: boolean) => void;
  showStatusBarPolling: boolean;
  setShowStatusBarPolling: (v: boolean) => void;
  enableCrossClientSync: boolean;
  setEnableCrossClientSync: (v: boolean) => void;
  enableMessagePolling: boolean;
  setEnableMessagePolling: (v: boolean) => void;
  fontSize: 'small' | 'medium' | 'large';
  setFontSize: (v: 'small' | 'medium' | 'large') => void;
  fontFamily: FontFamilyKey;
  setFontFamily: (key: FontFamilyKey) => void;
  resetPreferences: () => void;

  // Feature promo state
  dismissedPromoIds: string[];
  dismissPromo: (id: string) => void;
  promoEnabled: boolean;
  setPromoEnabled: (enabled: boolean) => void;

  previousCwd: string | null;
  setPreviousCwd: (cwd: string | null) => void;

  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  isTextStreaming: boolean;
  setIsTextStreaming: (v: boolean) => void;
  isWaitingForUser: boolean;
  setIsWaitingForUser: (v: boolean) => void;
  activeForm: string | null;
  setActiveForm: (v: string | null) => void;
  pulseBadgeCount: number;
  setPulseBadgeCount: (v: number) => void;

  contextFiles: ContextFile[];
  addContextFile: (file: Omit<ContextFile, 'id'>) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;

  // Canvas state (transient — not persisted)
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;
  canvasContent: UiCanvasContent | null;
  setCanvasContent: (content: UiCanvasContent | null) => void;
  canvasPreferredWidth: number | null;
  setCanvasPreferredWidth: (width: number | null) => void;
}

export const useAppStore = create<AppState>()(
  devtools(
    (set) => ({
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

      // Transient dialog state (not persisted — survives mobile sidebar remount)
      settingsOpen: false,
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      pulseOpen: false,
      setPulseOpen: (open) =>
        set(
          open
            ? { pulseOpen: true }
            : { pulseOpen: false, pulseAgentFilter: null, pulseEditScheduleId: null }
        ),
      pulseAgentFilter: null,
      setPulseAgentFilter: (id) => set({ pulseAgentFilter: id }),
      pulseEditScheduleId: null,
      setPulseEditScheduleId: (id) => set({ pulseEditScheduleId: id }),
      openPulseForAgent: (agentId) =>
        set({ pulseOpen: true, pulseAgentFilter: agentId, pulseEditScheduleId: null }),
      openPulseToEdit: (scheduleId) =>
        set({ pulseOpen: true, pulseEditScheduleId: scheduleId, pulseAgentFilter: null }),
      relayOpen: false,
      setRelayOpen: (open) => set({ relayOpen: open }),
      meshOpen: false,
      setMeshOpen: (open) => set({ meshOpen: open }),
      pickerOpen: false,
      setPickerOpen: (open) => set({ pickerOpen: open }),
      agentDialogOpen: false,
      setAgentDialogOpen: (open) => set({ agentDialogOpen: open }),
      onboardingStep: null,
      setOnboardingStep: (step) => set({ onboardingStep: step }),
      dorkbotFirstMessage: null,
      setDorkbotFirstMessage: (msg) => set({ dorkbotFirstMessage: msg }),
      globalPaletteOpen: false,
      setGlobalPaletteOpen: (open) => set({ globalPaletteOpen: open }),
      toggleGlobalPalette: () => set((s) => ({ globalPaletteOpen: !s.globalPaletteOpen })),
      globalPaletteInitialSearch: null,
      openGlobalPaletteWithSearch: (text) =>
        set({ globalPaletteOpen: true, globalPaletteInitialSearch: text }),
      clearGlobalPaletteInitialSearch: () => set({ globalPaletteInitialSearch: null }),
      shortcutsPanelOpen: false,
      setShortcutsPanelOpen: (open) => set({ shortcutsPanelOpen: open }),
      toggleShortcutsPanel: () => set((s) => ({ shortcutsPanelOpen: !s.shortcutsPanelOpen })),

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
          const raw: unknown[] = JSON.parse(localStorage.getItem(STORAGE_KEYS.RECENT_CWDS) || '[]');
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

      // Persisted boolean settings — DRY via readBool/writeBool helpers
      showTimestamps: readBool(BOOL_KEYS.showTimestamps, false),
      setShowTimestamps: (v) => {
        writeBool(BOOL_KEYS.showTimestamps, v);
        set({ showTimestamps: v });
      },
      expandToolCalls: readBool(BOOL_KEYS.expandToolCalls, false),
      setExpandToolCalls: (v) => {
        writeBool(BOOL_KEYS.expandToolCalls, v);
        set({ expandToolCalls: v });
      },
      autoHideToolCalls: readBool(BOOL_KEYS.autoHideToolCalls, true),
      setAutoHideToolCalls: (v) => {
        writeBool(BOOL_KEYS.autoHideToolCalls, v);
        set({ autoHideToolCalls: v });
      },
      showShortcutChips: readBool(BOOL_KEYS.showShortcutChips, true),
      setShowShortcutChips: (v) => {
        writeBool(BOOL_KEYS.showShortcutChips, v);
        set({ showShortcutChips: v });
      },
      showStatusBarCwd: readBool(BOOL_KEYS.showStatusBarCwd, true),
      setShowStatusBarCwd: (v) => {
        writeBool(BOOL_KEYS.showStatusBarCwd, v);
        set({ showStatusBarCwd: v });
      },
      showStatusBarPermission: readBool(BOOL_KEYS.showStatusBarPermission, true),
      setShowStatusBarPermission: (v) => {
        writeBool(BOOL_KEYS.showStatusBarPermission, v);
        set({ showStatusBarPermission: v });
      },
      showStatusBarModel: readBool(BOOL_KEYS.showStatusBarModel, true),
      setShowStatusBarModel: (v) => {
        writeBool(BOOL_KEYS.showStatusBarModel, v);
        set({ showStatusBarModel: v });
      },
      showStatusBarCost: readBool(BOOL_KEYS.showStatusBarCost, true),
      setShowStatusBarCost: (v) => {
        writeBool(BOOL_KEYS.showStatusBarCost, v);
        set({ showStatusBarCost: v });
      },
      showStatusBarContext: readBool(BOOL_KEYS.showStatusBarContext, true),
      setShowStatusBarContext: (v) => {
        writeBool(BOOL_KEYS.showStatusBarContext, v);
        set({ showStatusBarContext: v });
      },
      showStatusBarGit: readBool(BOOL_KEYS.showStatusBarGit, true),
      setShowStatusBarGit: (v) => {
        writeBool(BOOL_KEYS.showStatusBarGit, v);
        set({ showStatusBarGit: v });
      },
      showTaskCelebrations: readBool(BOOL_KEYS.showTaskCelebrations, true),
      setShowTaskCelebrations: (v) => {
        writeBool(BOOL_KEYS.showTaskCelebrations, v);
        set({ showTaskCelebrations: v });
      },
      enableNotificationSound: readBool(BOOL_KEYS.enableNotificationSound, true),
      setEnableNotificationSound: (v) => {
        writeBool(BOOL_KEYS.enableNotificationSound, v);
        set({ enableNotificationSound: v });
      },
      enablePulseNotifications: readBool(BOOL_KEYS.enablePulseNotifications, true),
      setEnablePulseNotifications: (v) => {
        writeBool(BOOL_KEYS.enablePulseNotifications, v);
        set({ enablePulseNotifications: v });
      },
      showStatusBarSound: readBool(BOOL_KEYS.showStatusBarSound, true),
      setShowStatusBarSound: (v) => {
        writeBool(BOOL_KEYS.showStatusBarSound, v);
        set({ showStatusBarSound: v });
      },
      showStatusBarTunnel: readBool(BOOL_KEYS.showStatusBarTunnel, true),
      setShowStatusBarTunnel: (v) => {
        writeBool(BOOL_KEYS.showStatusBarTunnel, v);
        set({ showStatusBarTunnel: v });
      },
      showStatusBarSync: readBool(BOOL_KEYS.showStatusBarSync, true),
      setShowStatusBarSync: (v) => {
        writeBool(BOOL_KEYS.showStatusBarSync, v);
        set({ showStatusBarSync: v });
      },
      showStatusBarPolling: readBool(BOOL_KEYS.showStatusBarPolling, true),
      setShowStatusBarPolling: (v) => {
        writeBool(BOOL_KEYS.showStatusBarPolling, v);
        set({ showStatusBarPolling: v });
      },
      enableCrossClientSync: readBool(
        BOOL_KEYS.enableCrossClientSync,
        BOOL_DEFAULTS.enableCrossClientSync
      ),
      setEnableCrossClientSync: (v) => {
        writeBool(BOOL_KEYS.enableCrossClientSync, v);
        set({ enableCrossClientSync: v });
      },
      enableMessagePolling: readBool(
        BOOL_KEYS.enableMessagePolling,
        BOOL_DEFAULTS.enableMessagePolling
      ),
      setEnableMessagePolling: (v) => {
        writeBool(BOOL_KEYS.enableMessagePolling, v);
        set({ enableMessagePolling: v });
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
          if (config.googleFontsUrl) {
            loadGoogleFont(config.googleFontsUrl);
          }
          if (config.key !== 'system') {
            applyFontCSS(config.sans, config.mono);
          }
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

      resetPreferences: () => {
        try {
          for (const lsKey of Object.values(BOOL_KEYS)) {
            localStorage.removeItem(lsKey);
          }
          localStorage.removeItem(STORAGE_KEYS.FONT_SIZE);
          localStorage.removeItem(STORAGE_KEYS.FONT_FAMILY);
          localStorage.removeItem('dorkos-sidebar-active-tab');
          localStorage.removeItem('dorkos-dismissed-promo-ids');
        } catch {}
        document.documentElement.style.setProperty('--user-font-scale', '1');
        const defaultConfig = getFontConfig(DEFAULT_FONT);
        if (defaultConfig.googleFontsUrl) loadGoogleFont(defaultConfig.googleFontsUrl);
        applyFontCSS(defaultConfig.sans, defaultConfig.mono);
        set({
          ...BOOL_DEFAULTS,
          devtoolsOpen: false,
          fontSize: 'medium',
          fontFamily: DEFAULT_FONT,
          sidebarActiveTab: 'overview',
          dismissedPromoIds: [],
        });
      },

      previousCwd: null,
      setPreviousCwd: (cwd) => set({ previousCwd: cwd }),

      isStreaming: false,
      setIsStreaming: (v) => set({ isStreaming: v }),
      isTextStreaming: false,
      setIsTextStreaming: (v) => set({ isTextStreaming: v }),
      isWaitingForUser: false,
      setIsWaitingForUser: (v) => set({ isWaitingForUser: v }),
      activeForm: null,
      setActiveForm: (v) => set({ activeForm: v }),
      pulseBadgeCount: 0,
      setPulseBadgeCount: (v) => set({ pulseBadgeCount: v }),

      contextFiles: [],
      addContextFile: (file) =>
        set((s) => {
          if (s.contextFiles.some((f) => f.path === file.path)) return s;
          return { contextFiles: [...s.contextFiles, { ...file, id: crypto.randomUUID() }] };
        }),
      removeContextFile: (id) =>
        set((s) => ({ contextFiles: s.contextFiles.filter((f) => f.id !== id) })),
      clearContextFiles: () => set({ contextFiles: [] }),

      // Canvas state (transient — not persisted)
      canvasOpen: false,
      setCanvasOpen: (open) => set({ canvasOpen: open }),
      canvasContent: null,
      setCanvasContent: (content) => set({ canvasContent: content }),
      canvasPreferredWidth: null,
      setCanvasPreferredWidth: (width) => set({ canvasPreferredWidth: width }),
    }),
    { name: 'app-store' }
  )
);
