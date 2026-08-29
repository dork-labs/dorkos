/**
 * The explorer over a session's working directory — what the Files pane has
 * always browsed, now said out loud as a {@link FileExplorerSource}.
 *
 * Every capability here restates something that was already true, so that the
 * pane can ask instead of assume: the directory is writable, the server does
 * its own hiding, there is no provenance to show, and a chosen file opens in
 * the canvas rather than in the pane.
 *
 * @module features/file-explorer/model/session-cwd-source
 */
import type { Transport } from '@dorkos/shared/transport';
import type { ExplorerListing, FileExplorerSource } from './source';

/** What {@link createSessionCwdSource} needs. */
export interface SessionCwdSourceDeps {
  /** The port the listing is read through. */
  transport: Transport;
  /** The session working directory to browse. */
  cwd: string;
}

/**
 * Build the source for a session working directory.
 *
 * @param deps - The transport and the directory.
 */
export function createSessionCwdSource(deps: SessionCwdSourceDeps): FileExplorerSource {
  const { transport, cwd } = deps;
  return {
    // The cwd verbatim: the key this pane's cache and its persisted expansion
    // have always used, so nothing a person had open was reset by sources
    // arriving.
    scopeKey: cwd,
    cwd,
    writable: true,
    // A filesystem knows when a file changed, not who changed it — and "who"
    // is the question the column asks. So it does not draw here.
    provenance: false,
    // The server hides dotfiles AND whatever `git check-ignore` claims, which
    // is more than a client could work out from names alone.
    filtersHidden: true,
    preview: 'canvas',
    // Not here, and not because a session's files are read-only — they are the
    // most editable thing in the app. They are edited in the CANVAS, which is
    // where `preview: 'canvas'` sends them, and which already owns that file's
    // autosave, its conflict handling and its edit-protection against agent
    // pushes. A second editor over the same bytes would be two of all three.
    editable: false,
    list(path: string, options: { showHidden: boolean }): Promise<ExplorerListing> {
      return transport.readFileTree(cwd, {
        path: path === '' ? undefined : path,
        showHidden: options.showHidden,
      });
    },
  };
}
