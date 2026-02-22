import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
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

/** Read a boolean from localStorage with try/catch safety. */
function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
  } catch {
    return defaultValue;
  }
}

/** Write a boolean to localStorage with try/catch safety. */
function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {}
}

export interface ContextFile {
  id: string;
  path: string;
  basename: string;
}

export interface RecentCwd {
  path: string;
  accessedAt: string;
}

interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

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
  showStatusBarVersion: boolean;
  setShowStatusBarVersion: (v: boolean) => void;
  showStatusBarTunnel: boolean;
  setShowStatusBarTunnel: (v: boolean) => void;
  verboseLogging: boolean;
  setVerboseLogging: (v: boolean) => void;
  fontSize: 'small' | 'medium' | 'large';
  setFontSize: (v: 'small' | 'medium' | 'large') => void;
  fontFamily: FontFamilyKey;
  setFontFamily: (key: FontFamilyKey) => void;
  resetPreferences: () => void;

  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  isWaitingForUser: boolean;
  setIsWaitingForUser: (v: boolean) => void;
  activeForm: string | null;
  setActiveForm: (v: string | null) => void;

  contextFiles: ContextFile[];
  addContextFile: (file: Omit<ContextFile, 'id'>) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;
}

// localStorage keys for all persisted boolean settings
const BOOL_KEYS = {
  showTimestamps: 'dorkos-show-timestamps',
  expandToolCalls: 'dorkos-expand-tool-calls',
  autoHideToolCalls: 'dorkos-auto-hide-tool-calls',
  showShortcutChips: 'dorkos-show-shortcut-chips',
  showStatusBarCwd: 'dorkos-show-status-bar-cwd',
  showStatusBarPermission: 'dorkos-show-status-bar-permission',
  showStatusBarModel: 'dorkos-show-status-bar-model',
  showStatusBarCost: 'dorkos-show-status-bar-cost',
  showStatusBarContext: 'dorkos-show-status-bar-context',
  showStatusBarGit: 'dorkos-show-status-bar-git',
  showTaskCelebrations: 'dorkos-show-task-celebrations',
  enableNotificationSound: 'dorkos-enable-notification-sound',
  enablePulseNotifications: 'dorkos-enable-pulse-notifications',
  showStatusBarSound: 'dorkos-show-status-bar-sound',
  showStatusBarVersion: 'dorkos-show-status-bar-version',
  showStatusBarTunnel: 'dorkos-show-status-bar-tunnel',
  verboseLogging: 'dorkos-verbose-logging',
} as const;

// Default values for each persisted boolean
const BOOL_DEFAULTS: Record<keyof typeof BOOL_KEYS, boolean> = {
  showTimestamps: false,
  expandToolCalls: false,
  autoHideToolCalls: true,
  showShortcutChips: true,
  showStatusBarCwd: true,
  showStatusBarPermission: true,
  showStatusBarModel: true,
  showStatusBarCost: true,
  showStatusBarContext: true,
  showStatusBarGit: true,
  showTaskCelebrations: true,
  enableNotificationSound: true,
  enablePulseNotifications: true,
  showStatusBarSound: true,
  showStatusBarVersion: true,
  showStatusBarTunnel: true,
  verboseLogging: false,
};

export const useAppStore = create<AppState>()(
  devtools(
    (set) => ({
      sidebarOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      sessionId: null,
      setSessionId: (id) => set({ sessionId: id }),

      selectedCwd: null,
      setSelectedCwd: (cwd) =>
        set((s) => {
          const entry: RecentCwd = { path: cwd, accessedAt: new Date().toISOString() };
          const recents = [entry, ...s.recentCwds.filter((r) => r.path !== cwd)].slice(0, MAX_RECENT_CWDS);
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
      showStatusBarVersion: readBool(BOOL_KEYS.showStatusBarVersion, true),
      setShowStatusBarVersion: (v) => {
        writeBool(BOOL_KEYS.showStatusBarVersion, v);
        set({ showStatusBarVersion: v });
      },
      showStatusBarTunnel: readBool(BOOL_KEYS.showStatusBarTunnel, true),
      setShowStatusBarTunnel: (v) => {
        writeBool(BOOL_KEYS.showStatusBarTunnel, v);
        set({ showStatusBarTunnel: v });
      },
      verboseLogging: readBool(BOOL_KEYS.verboseLogging, false),
      setVerboseLogging: (v) => {
        writeBool(BOOL_KEYS.verboseLogging, v);
        set({ verboseLogging: v });
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
        });
      },

      isStreaming: false,
      setIsStreaming: (v) => set({ isStreaming: v }),
      isWaitingForUser: false,
      setIsWaitingForUser: (v) => set({ isWaitingForUser: v }),
      activeForm: null,
      setActiveForm: (v) => set({ activeForm: v }),

      contextFiles: [],
      addContextFile: (file) =>
        set((s) => {
          if (s.contextFiles.some((f) => f.path === file.path)) return s;
          return { contextFiles: [...s.contextFiles, { ...file, id: crypto.randomUUID() }] };
        }),
      removeContextFile: (id) =>
        set((s) => ({ contextFiles: s.contextFiles.filter((f) => f.id !== id) })),
      clearContextFiles: () => set({ contextFiles: [] }),
    }),
    { name: 'app-store' }
  )
);
