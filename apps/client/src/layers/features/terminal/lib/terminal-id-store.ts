/**
 * Per-(session, cwd) persistence of the workbench terminal's OPEN TABS — an
 * ordered list of server-side PTY ids plus the active tab index — so a page
 * refresh re-attaches to every live shell (in order, with the same tab active)
 * instead of orphaning them and spawning new ones (DOR-225, generalized to
 * multiple terminals in DOR-226).
 *
 * `sessionStorage` (not `localStorage`) is deliberate: it survives a reload but
 * is scoped per browser tab, so two browser tabs viewing the same session never
 * contend over the same PTYs. Every accessor is failure-tolerant — a blocked or
 * absent `sessionStorage` (private mode, storage disabled) or a corrupt value
 * simply degrades to "no stored tabs", i.e. a fresh terminal.
 *
 * Ids are removed only when a shell exits or a tab is explicitly closed (the
 * panel rewrites the whole list on every change); they are NEVER cleared on
 * unmount or refresh, which is exactly what lets the shells survive a reload.
 *
 * @module features/terminal/lib/terminal-id-store
 */

/** Namespace prefix for stored terminal tabs, so keys never collide with other state. */
const KEY_PREFIX = 'dork.terminal.tabs';

/**
 * The persisted terminal-tab state for one (session, cwd): the open PTY ids in
 * tab order and which one is active.
 */
export interface TerminalTabsState {
  /** Ordered server PTY ids — one per open terminal tab, in tab order. */
  ids: string[];
  /** Index into {@link ids} of the active tab; clamped into range on read. */
  activeIndex: number;
}

/** The empty state returned when nothing is stored (or storage is unavailable). */
const EMPTY: TerminalTabsState = { ids: [], activeIndex: 0 };

/** Build the storage key for a (session, cwd) pair. A null session id is a valid, stable key part. */
function storageKey(sessionId: string | null, cwd: string): string {
  return `${KEY_PREFIX}:${sessionId ?? ''}:${cwd}`;
}

/** Clamp `index` into `[0, length - 1]`, or `0` when the list is empty. */
function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

/**
 * Read the stored terminal tabs for a (session, cwd) pair. Returns an empty
 * state (`{ ids: [], activeIndex: 0 }`) when nothing is stored, storage is
 * unavailable, or the stored value is malformed. The returned `activeIndex` is
 * always clamped into range, and `ids` is filtered to non-empty strings.
 *
 * @param sessionId - Active session id, or `null` when unscoped.
 * @param cwd - Working directory the terminals are bound to.
 */
export function readTerminalTabs(sessionId: string | null, cwd: string): TerminalTabsState {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId, cwd));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const { ids, activeIndex } = parsed as { ids?: unknown; activeIndex?: unknown };
    const cleanIds = Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const index = typeof activeIndex === 'number' ? activeIndex : 0;
    return { ids: cleanIds, activeIndex: clampIndex(index, cleanIds.length) };
  } catch {
    return EMPTY;
  }
}

/**
 * Persist the terminal tabs for a (session, cwd) pair so the next mount can
 * re-attach to each live shell with the same tab active. Called by the panel on
 * every tab change (create / close / switch / shell-exit), rewriting the whole
 * list — so a removed id is dropped and the rest are preserved.
 *
 * @param sessionId - Active session id, or `null` when unscoped.
 * @param cwd - Working directory the terminals are bound to.
 * @param state - The open PTY ids in tab order plus the active tab index.
 */
export function writeTerminalTabs(
  sessionId: string | null,
  cwd: string,
  state: TerminalTabsState
): void {
  try {
    const payload: TerminalTabsState = {
      ids: state.ids,
      activeIndex: clampIndex(state.activeIndex, state.ids.length),
    };
    sessionStorage.setItem(storageKey(sessionId, cwd), JSON.stringify(payload));
  } catch {
    // Non-fatal — re-attach just won't be available on the next mount.
  }
}
