/**
 * The desktop shell's own recent log, for a bug report (DOR-2045).
 *
 * A bug report already carries an excerpt of the SERVER's log, gathered
 * server-side where the scrubbing and the bounding can be enforced. The desktop
 * shell's log is the one thing that cannot work that way: `main.log` belongs to
 * the Electron main process, and the server child does not run there and cannot
 * read it. So on the desktop the report carries a second excerpt, gathered by
 * the shell and passed through the client — the single client-authored field in
 * a diagnostics bundle whose siblings are all server-authored. It arrives
 * already scrubbed and bounded by the main process
 * (`apps/desktop/src/main/shell-log-excerpt/index.ts`).
 *
 * This module is the only place that bridge method is called, so no surface has
 * to carry its own "am I in the desktop app?" branch — the same arrangement
 * `desktop-admin.ts` makes for the two danger-zone actions.
 *
 * @module shared/lib/desktop-shell-log
 */
import { isDesktopShell } from './platform';

/**
 * Ask the desktop shell for a scrubbed tail of its own log.
 *
 * Two guards, each for its own reason: {@link isDesktopShell} because this is a
 * surface question (a browser has no shell log and never will), and the method
 * check because a desktop build older than this one has the bridge without this
 * method on it.
 *
 * Never throws. An IPC round trip that fails, a shell that refuses the sender,
 * and a log that cannot be read all come back the same way — as nothing — and
 * none of them may cost a person the bug report they are sending.
 *
 * @returns The excerpt, or `undefined` when there is no shell log to read.
 */
export async function getDesktopShellLogExcerpt(): Promise<string | undefined> {
  if (!isDesktopShell()) return undefined;
  const getExcerpt = window.electronAPI?.getShellLogExcerpt;
  if (typeof getExcerpt !== 'function') return undefined;
  try {
    const excerpt = await getExcerpt();
    return excerpt && excerpt.length > 0 ? excerpt : undefined;
  } catch {
    return undefined;
  }
}
