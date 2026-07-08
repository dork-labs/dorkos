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
  showStatusBarRuntime: 'dorkos-show-status-bar-runtime',
  showStatusBarModel: 'dorkos-show-status-bar-model',
  showStatusBarContext: 'dorkos-show-status-bar-context',
  showStatusBarCache: 'dorkos-show-status-bar-cache',
  showStatusBarUsage: 'dorkos-show-status-bar-usage',
  showStatusBarGit: 'dorkos-show-status-bar-git',
  showTaskCelebrations: 'dorkos-show-task-celebrations',
  enableNotificationSound: 'dorkos-enable-notification-sound',
  enableTasksNotifications: 'dorkos-enable-tasks-notifications',
  showStatusBarSound: 'dorkos-show-status-bar-sound',
  showStatusBarPolling: 'dorkos-show-status-bar-polling',
  enableMessagePolling: 'dorkos-enable-message-polling',
  promoEnabled: 'dorkos-promo-enabled',
} as const;

/**
 * Orphaned localStorage keys removed by the one-time migration below.
 *
 * `dorkos-enable-cross-client-sync` backed the retired "Multi-window sync" flag
 * and `dorkos-show-status-bar-sync` backed its now-removed status-bar toggle.
 * Cross-client live sync is always-on (spec chat-stream-reconnection, ADR-0266),
 * so both preferences no longer exist.
 */
const ORPHANED_BOOL_KEYS = [
  'dorkos-enable-cross-client-sync',
  'dorkos-show-status-bar-sync',
] as const;

/**
 * One-time purge of localStorage keys for preferences removed in the
 * always-on-sync migration. Mirrors the `try/catch` + `removeItem` pattern used
 * by `resetPreferences`. A no-op when the keys are absent; never throws.
 */
export function purgeOrphanedPreferenceKeys(): void {
  try {
    for (const key of ORPHANED_BOOL_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {}
}

/** Default values for each persisted boolean. */
export const BOOL_DEFAULTS: Record<keyof typeof BOOL_KEYS, boolean> = {
  sidebarOpen: false,
  showTimestamps: false,
  expandToolCalls: false,
  autoHideToolCalls: true,
  showShortcutChips: true,
  showStatusBarCwd: true,
  showStatusBarPermission: true,
  showStatusBarRuntime: true,
  showStatusBarModel: true,
  showStatusBarContext: true,
  showStatusBarCache: true,
  showStatusBarUsage: true,
  showStatusBarGit: true,
  showTaskCelebrations: true,
  enableNotificationSound: true,
  enableTasksNotifications: true,
  showStatusBarSound: true,
  showStatusBarPolling: true,
  enableMessagePolling: false,
  promoEnabled: true,
};

// ---------------------------------------------------------------------------
// Canvas session persistence (per-session localStorage map)
// ---------------------------------------------------------------------------

/**
 * A persisted canvas document (the durable subset of the in-memory
 * `CanvasDocument` — the transient `editing` flag is never persisted, so a
 * reload never resurrects edit mode).
 */
export interface PersistedCanvasDocument {
  id: string;
  content: UiCanvasContent;
  openedAt: number;
  lastActiveAt: number;
  sourceLabel: string;
}

/** Persisted canvas state for a single session (multi-document, DOR-219). */
export interface CanvasSessionEntry {
  open: boolean;
  documents: PersistedCanvasDocument[];
  activeDocumentId: string | null;
  accessedAt: number;
}

type CanvasSessionMap = Record<string, CanvasSessionEntry>;

/**
 * Read a single session's canvas state from the persisted map.
 *
 * Tolerates the pre-multi-document shape (`{ open, content }`) by wrapping a
 * legacy single `content` into a one-document array, so a canvas persisted
 * before DOR-219 restores as a single open document instead of being dropped.
 */
export function readCanvasSession(sessionId: string): CanvasSessionEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS);
    if (!raw) return null;
    const map: Record<string, unknown> = JSON.parse(raw);
    const entry = map[sessionId];
    if (entry == null || typeof entry !== 'object') return null;
    return normalizeCanvasEntry(entry as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Coerce a stored entry (current or legacy single-content shape) into a {@link CanvasSessionEntry}. */
function normalizeCanvasEntry(entry: Record<string, unknown>): CanvasSessionEntry {
  const open = entry.open === true;
  const accessedAt = typeof entry.accessedAt === 'number' ? entry.accessedAt : Date.now();

  if (Array.isArray(entry.documents)) {
    return {
      open,
      documents: entry.documents as PersistedCanvasDocument[],
      activeDocumentId: typeof entry.activeDocumentId === 'string' ? entry.activeDocumentId : null,
      accessedAt,
    };
  }

  // Legacy single-content shape (pre-DOR-219): wrap into one document.
  const legacyContent = entry.content as UiCanvasContent | null | undefined;
  if (legacyContent) {
    const id = 'legacy-canvas-document';
    return {
      open,
      documents: [
        {
          id,
          content: legacyContent,
          openedAt: accessedAt,
          lastActiveAt: accessedAt,
          sourceLabel: '',
        },
      ],
      activeDocumentId: id,
      accessedAt,
    };
  }

  return { open, documents: [], activeDocumentId: null, accessedAt };
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
