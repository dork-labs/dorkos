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
  showStatusBarSound: boolean;
  setShowStatusBarSound: (v: boolean) => void;
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
  showTimestamps: 'gateway-show-timestamps',
  expandToolCalls: 'gateway-expand-tool-calls',
  autoHideToolCalls: 'gateway-auto-hide-tool-calls',
  showShortcutChips: 'gateway-show-shortcut-chips',
  showStatusBarCwd: 'gateway-show-status-bar-cwd',
  showStatusBarPermission: 'gateway-show-status-bar-permission',
  showStatusBarModel: 'gateway-show-status-bar-model',
  showStatusBarCost: 'gateway-show-status-bar-cost',
  showStatusBarContext: 'gateway-show-status-bar-context',
  showStatusBarGit: 'gateway-show-status-bar-git',
  showTaskCelebrations: 'gateway-show-task-celebrations',
  enableNotificationSound: 'gateway-enable-notification-sound',
  showStatusBarSound: 'gateway-show-status-bar-sound',
  verboseLogging: 'gateway-verbose-logging',
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
  showStatusBarSound: true,
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
          const recents = [entry, ...s.recentCwds.filter((r) => r.path !== cwd)].slice(0, 10);
          try {
            localStorage.setItem('gateway-recent-cwds', JSON.stringify(recents));
          } catch {}
          return { selectedCwd: cwd, recentCwds: recents };
        }),

      recentCwds: (() => {
        try {
          const raw: unknown[] = JSON.parse(localStorage.getItem('gateway-recent-cwds') || '[]');
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
      showStatusBarSound: readBool(BOOL_KEYS.showStatusBarSound, true),
      setShowStatusBarSound: (v) => {
        writeBool(BOOL_KEYS.showStatusBarSound, v);
        set({ showStatusBarSound: v });
      },
      verboseLogging: readBool(BOOL_KEYS.verboseLogging, false),
      setVerboseLogging: (v) => {
        writeBool(BOOL_KEYS.verboseLogging, v);
        set({ verboseLogging: v });
      },

      fontSize: (() => {
        try {
          const stored = localStorage.getItem('gateway-font-size');
          if (stored === 'small' || stored === 'medium' || stored === 'large') {
            const scaleMap = { small: '0.9', medium: '1', large: '1.15' };
            document.documentElement.style.setProperty('--user-font-scale', scaleMap[stored]);
            return stored;
          }
        } catch {}
        return 'medium';
      })() as 'small' | 'medium' | 'large',
      setFontSize: (v) => {
        try {
          localStorage.setItem('gateway-font-size', v);
        } catch {}
        const scaleMap = { small: '0.9', medium: '1', large: '1.15' };
        document.documentElement.style.setProperty('--user-font-scale', scaleMap[v]);
        set({ fontSize: v });
      },

      fontFamily: (() => {
        try {
          const stored = localStorage.getItem('gateway-font-family');
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
          localStorage.setItem('gateway-font-family', key);
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
          localStorage.removeItem('gateway-font-size');
          localStorage.removeItem('gateway-font-family');
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
