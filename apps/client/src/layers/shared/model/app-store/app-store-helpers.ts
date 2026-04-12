/**
 * Shared helpers, types, and localStorage configuration for the app store.
 *
 * @module shared/model/app-store-helpers
 */
import type { UiCanvasContent } from '@dorkos/shared/types';
import { STORAGE_KEYS, MAX_CANVAS_SESSIONS } from '@/layers/shared/lib';

/** Read a boolean from localStorage with try/catch safety. */
export function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
  } catch {
    return defaultValue;
  }
}

/** Write a boolean to localStorage with try/catch safety. */
export function writeBool(key: string, v: boolean): void {
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

/** localStorage keys for all persisted boolean settings. */
export const BOOL_KEYS = {
  sidebarOpen: 'dorkos-sidebar-open',
  showTimestamps: 'dorkos-show-timestamps',
  expandToolCalls: 'dorkos-expand-tool-calls',
  autoHideToolCalls: 'dorkos-auto-hide-tool-calls',
  showShortcutChips: 'dorkos-show-shortcut-chips',
  showStatusBarCwd: 'dorkos-show-status-bar-cwd',
  showStatusBarPermission: 'dorkos-show-status-bar-permission',
  showStatusBarModel: 'dorkos-show-status-bar-model',
  showStatusBarCost: 'dorkos-show-status-bar-cost',
  showStatusBarContext: 'dorkos-show-status-bar-context',
  showStatusBarCache: 'dorkos-show-status-bar-cache',
  showStatusBarUsage: 'dorkos-show-status-bar-usage',
  showStatusBarGit: 'dorkos-show-status-bar-git',
  showTaskCelebrations: 'dorkos-show-task-celebrations',
  enableNotificationSound: 'dorkos-enable-notification-sound',
  enableTasksNotifications: 'dorkos-enable-tasks-notifications',
  showStatusBarSound: 'dorkos-show-status-bar-sound',
  showStatusBarSync: 'dorkos-show-status-bar-sync',
  showStatusBarPolling: 'dorkos-show-status-bar-polling',
  enableCrossClientSync: 'dorkos-enable-cross-client-sync',
  enableMessagePolling: 'dorkos-enable-message-polling',
  promoEnabled: 'dorkos-promo-enabled',
} as const;

/** Default values for each persisted boolean. */
export const BOOL_DEFAULTS: Record<keyof typeof BOOL_KEYS, boolean> = {
  sidebarOpen: false,
  showTimestamps: false,
  expandToolCalls: false,
  autoHideToolCalls: true,
  showShortcutChips: true,
  showStatusBarCwd: true,
  showStatusBarPermission: true,
  showStatusBarModel: true,
  showStatusBarCost: true,
  showStatusBarContext: true,
  showStatusBarCache: true,
  showStatusBarUsage: true,
  showStatusBarGit: true,
  showTaskCelebrations: true,
  enableNotificationSound: true,
  enableTasksNotifications: true,
  showStatusBarSound: true,
  showStatusBarSync: true,
  showStatusBarPolling: true,
  enableCrossClientSync: false,
  enableMessagePolling: false,
  promoEnabled: true,
};

// ---------------------------------------------------------------------------
// Canvas session persistence (per-session localStorage map)
// ---------------------------------------------------------------------------

/** Persisted canvas state for a single session. */
export interface CanvasSessionEntry {
  open: boolean;
  content: UiCanvasContent | null;
  accessedAt: number;
}

type CanvasSessionMap = Record<string, CanvasSessionEntry>;

/** Read a single session's canvas state from the persisted map. */
export function readCanvasSession(sessionId: string): CanvasSessionEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS);
    if (!raw) return null;
    const map: CanvasSessionMap = JSON.parse(raw);
    return map[sessionId] ?? null;
  } catch {
    return null;
  }
}

/** Write a session's canvas state to the persisted map, enforcing LRU eviction. */
export function writeCanvasSession(sessionId: string, entry: CanvasSessionEntry): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS);
    const map: CanvasSessionMap = raw ? JSON.parse(raw) : {};
    map[sessionId] = { ...entry, accessedAt: Date.now() };

    // LRU eviction: keep only the newest MAX_CANVAS_SESSIONS entries
    const entries = Object.entries(map);
    if (entries.length > MAX_CANVAS_SESSIONS) {
      entries.sort((a, b) => b[1].accessedAt - a[1].accessedAt);
      const trimmed = Object.fromEntries(entries.slice(0, MAX_CANVAS_SESSIONS));
      localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify(map));
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Right panel persistence (global, not per-session)
// ---------------------------------------------------------------------------

/** Persisted right panel structural state. */
export interface RightPanelStateEntry {
  open: boolean;
  activeTab: string | null;
}

/** Read right panel state from localStorage. Returns null if missing or corrupt. */
export function readRightPanelState(): RightPanelStateEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RIGHT_PANEL_STATE);
    if (!raw) return null;
    return JSON.parse(raw) as RightPanelStateEntry;
  } catch {
    return null;
  }
}

/** Write right panel state to localStorage. Silently fails on quota errors. */
export function writeRightPanelState(entry: RightPanelStateEntry): void {
  try {
    localStorage.setItem(STORAGE_KEYS.RIGHT_PANEL_STATE, JSON.stringify(entry));
  } catch {}
}
