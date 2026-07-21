import type { FileExplorerEntry } from './types';

/**
 * Feature-owned localStorage persistence for the file explorer (DOR-404). The
 * explorer keeps per-cwd navigation ergonomics — expansion, selection, scroll —
 * as one JSON blob (`Record<cwd, FileExplorerEntry>`) plus a global show-hidden
 * bool, mirroring the canvas/right-panel convention (hand-written `try/catch`
 * `readX`/`writeX` helpers, LRU-capped by `accessedAt`). Zustand's `persist`
 * middleware is deliberately not used anywhere in this app.
 *
 * These helpers live in the feature (not `shared`) because this state is
 * feature-owned: it never crosses devices and never touches server config, so
 * it stays local and works identically in embedded (Obsidian) mode.
 *
 * @module features/file-explorer/model/file-explorer-persistence
 */

/** localStorage key for the per-cwd explorer-state blob (`Record<cwd, entry>`). */
const EXPLORER_STATE_KEY = 'dorkos-file-explorer-state';

/** localStorage key for the global show-hidden preference. */
const SHOW_HIDDEN_KEY = 'dorkos-file-explorer-show-hidden';

/**
 * Maximum number of per-cwd explorer entries kept in localStorage before the
 * least-recently-used one is evicted. Bounds the blob so a user who browses
 * hundreds of directories never grows the stored map unbounded — the same cap
 * the canvas and right-panel slices use.
 */
export const MAX_FILE_EXPLORER_ENTRIES = 50;

type ExplorerStateMap = Record<string, FileExplorerEntry>;

/** A fresh, empty explorer entry for a never-before-seen cwd. */
export function emptyExplorerEntry(): FileExplorerEntry {
  return { expanded: {}, selectedPath: null, scrollTop: 0, accessedAt: Date.now() };
}

/**
 * Read one cwd's persisted explorer entry from the map, or `null` when it is
 * absent or the blob is missing/corrupt — the caller then falls back to
 * {@link emptyExplorerEntry}.
 *
 * @param cwd - Session working directory whose entry to read.
 */
export function readExplorerEntry(cwd: string): FileExplorerEntry | null {
  try {
    const raw = localStorage.getItem(EXPLORER_STATE_KEY);
    if (!raw) return null;
    const map: Record<string, unknown> = JSON.parse(raw);
    const entry = map[cwd];
    if (entry == null || typeof entry !== 'object') return null;
    return normalizeEntry(entry as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Coerce a stored value into a valid {@link FileExplorerEntry}, defaulting bad fields. */
function normalizeEntry(entry: Record<string, unknown>): FileExplorerEntry {
  const expanded =
    entry.expanded != null && typeof entry.expanded === 'object'
      ? (entry.expanded as Record<string, boolean>)
      : {};
  return {
    expanded,
    selectedPath: typeof entry.selectedPath === 'string' ? entry.selectedPath : null,
    scrollTop:
      typeof entry.scrollTop === 'number' && Number.isFinite(entry.scrollTop) ? entry.scrollTop : 0,
    accessedAt: typeof entry.accessedAt === 'number' ? entry.accessedAt : Date.now(),
  };
}

/**
 * Write one cwd's explorer entry into the map, stamping `accessedAt` and
 * enforcing LRU eviction past {@link MAX_FILE_EXPLORER_ENTRIES}. Silently
 * no-ops on quota/serialization errors.
 *
 * @param cwd - Session working directory the entry belongs to.
 * @param entry - The explorer entry to persist.
 */
export function writeExplorerEntry(cwd: string, entry: FileExplorerEntry): void {
  try {
    const raw = localStorage.getItem(EXPLORER_STATE_KEY);
    const map: ExplorerStateMap = raw ? JSON.parse(raw) : {};
    map[cwd] = { ...entry, accessedAt: Date.now() };

    // LRU eviction: keep only the newest MAX_FILE_EXPLORER_ENTRIES entries.
    const entries = Object.entries(map);
    if (entries.length > MAX_FILE_EXPLORER_ENTRIES) {
      entries.sort((a, b) => b[1].accessedAt - a[1].accessedAt);
      const trimmed = Object.fromEntries(entries.slice(0, MAX_FILE_EXPLORER_ENTRIES));
      localStorage.setItem(EXPLORER_STATE_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(EXPLORER_STATE_KEY, JSON.stringify(map));
    }
  } catch {}
}

/** Read the global show-hidden preference (default `false`). */
export function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Write the global show-hidden preference. Silently fails on quota errors. */
export function writeShowHidden(value: boolean): void {
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, String(value));
  } catch {}
}
