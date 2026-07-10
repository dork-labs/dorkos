/**
 * Per-(session, cwd) persistence of the workbench terminal's server-side PTY id,
 * so a page refresh re-attaches to the live shell instead of orphaning it and
 * spawning a new one (DOR-225).
 *
 * `sessionStorage` (not `localStorage`) is deliberate: it survives a reload but
 * is scoped per browser tab, so two tabs viewing the same session never contend
 * over a single PTY. Every accessor is failure-tolerant — a blocked or absent
 * `sessionStorage` (private mode, storage disabled) simply degrades to "no stored
 * id", i.e. a fresh create.
 *
 * @module features/terminal/lib/terminal-id-store
 */

/** Namespace prefix for stored terminal ids, so keys never collide with other state. */
const KEY_PREFIX = 'dork.terminal.id';

/** Build the storage key for a (session, cwd) pair. A null session id is a valid, stable key part. */
function storageKey(sessionId: string | null, cwd: string): string {
  return `${KEY_PREFIX}:${sessionId ?? ''}:${cwd}`;
}

/**
 * Read the stored PTY id for a (session, cwd) pair, or `null` when none is stored
 * (or storage is unavailable).
 *
 * @param sessionId - Active session id, or `null` when unscoped.
 * @param cwd - Working directory the terminal is bound to.
 */
export function readTerminalId(sessionId: string | null, cwd: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(sessionId, cwd));
  } catch {
    return null;
  }
}

/**
 * Persist the PTY id for a (session, cwd) pair so the next mount can re-attach.
 *
 * @param sessionId - Active session id, or `null` when unscoped.
 * @param cwd - Working directory the terminal is bound to.
 * @param id - The server-assigned terminal id to remember.
 */
export function writeTerminalId(sessionId: string | null, cwd: string, id: string): void {
  try {
    sessionStorage.setItem(storageKey(sessionId, cwd), id);
  } catch {
    // Non-fatal — re-attach just won't be available on the next mount.
  }
}

/**
 * Forget the stored PTY id for a (session, cwd) pair — called once the shell has
 * exited (or its PTY was reclaimed), so the next mount spawns a fresh shell
 * rather than attempting a doomed re-attach.
 *
 * @param sessionId - Active session id, or `null` when unscoped.
 * @param cwd - Working directory the terminal is bound to.
 */
export function clearTerminalId(sessionId: string | null, cwd: string): void {
  try {
    sessionStorage.removeItem(storageKey(sessionId, cwd));
  } catch {
    // Non-fatal.
  }
}
