/**
 * The explorer over a room's own files (spec `project-rooms` §3.9).
 *
 * Read-only, and that is a fact about the place rather than a limitation of the
 * pane: a room's files are a git commit — the tip of `main` — so there is
 * nothing on disk for a click to rename. Writing them is what merging does, and
 * a person editing them is §3.10's job, not this one.
 *
 * Everything it returns is written by the room's members: names, commit
 * subjects, author names, file bodies. None of it is authored by DorkOS, so it
 * is rendered as untrusted text the same way a message body is.
 *
 * @module features/file-explorer/model/room-files-source
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomFileEntry } from '@dorkos/shared/room-files';
import { errorCodeOf, ROOM_HAS_NO_REPO_CODE } from '../lib/error-code';
import { watchRoomEntries } from './room-entry-watch';
import type { ExplorerEntry, ExplorerFile, ExplorerListing, FileExplorerSource } from './source';

/** What {@link createRoomFilesSource} needs. */
export interface RoomFilesSourceDeps {
  /** The port the listing is read through. */
  transport: Transport;
  /** The cache the room's stream writes arriving entries into. */
  queryClient: QueryClient;
  /** The room whose files to browse. */
  roomId: string;
}

/**
 * One listing entry, translated.
 *
 * A symlink and a submodule both land as `file`, which is what the pane needs
 * to know: neither is descended into, so neither gets a chevron. The link keeps
 * its own flag so the row can say what it is; the API refuses to serve what
 * either points at, and the preview renders that refusal.
 */
function toExplorerEntry(entry: RoomFileEntry): ExplorerEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.kind === 'dir' ? 'dir' : 'file',
    size: entry.size,
    isSymlink: entry.kind === 'symlink',
    lastCommit: entry.lastCommit,
  };
}

/**
 * The refusal codes that describe the FILE rather than the request.
 *
 * A directory, a link and a submodule are all real answers to "show me this" —
 * there is simply nothing to show — so they become a body the preview renders,
 * not an error it apologises for. Everything else stays a rejection.
 *
 * A `Map` rather than an object literal because the key is a string off a
 * thrown error, and an object would answer `'constructor'` and `'toString'`
 * with something from its prototype — turning a refusal nobody wrote copy for
 * into a "preview" of a function.
 */
const NOT_READABLE_COPY = new Map<string, string>([
  ['ROOM_FILE_NOT_READABLE', "This isn't a file that can be shown here."],
  ['ROOM_FILE_NOT_FOUND', "This file isn't in the room's files any more."],
]);

/**
 * Build the source for a room's own files.
 *
 * @param deps - The transport, the query cache, and the room.
 */
export function createRoomFilesSource(deps: RoomFilesSourceDeps): FileExplorerSource {
  const { transport, queryClient, roomId } = deps;
  return {
    scopeKey: `room:${roomId}`,
    // No working directory: a commit is not a place on disk. Every path that
    // would need one is unreachable, because nothing here is writable.
    cwd: null,
    writable: false,
    provenance: true,
    // The API serves the tree as committed, with nothing dropped — so hiding
    // the plumbing is this client's job here.
    filtersHidden: false,
    preview: 'inline',
    async list(path: string): Promise<ExplorerListing> {
      try {
        const listing = await transport.readRoomFiles(roomId, path === '' ? undefined : path);
        return { entries: listing.entries.map(toExplorerEntry) };
      } catch (error) {
        // "This room has no files of its own" is the ordinary answer, not a
        // failure: most rooms are conversations and always will be. Left on the
        // rejection path it was retried, logged as a query error and dropped a
        // breadcrumb — once per repo-less room a person opened, which at any
        // scale is most of them. It comes back as a listing that says so.
        if (errorCodeOf(error) !== ROOM_HAS_NO_REPO_CODE) throw error;
        return { entries: [], absent: true };
      }
    },
    async read(path: string): Promise<ExplorerFile> {
      try {
        const file = await transport.readRoomFileContent(roomId, path);
        return {
          path: file.path,
          size: file.size,
          lastCommit: file.lastCommit,
          body:
            file.body.kind === 'text'
              ? { kind: 'text', text: file.body.text }
              : file.body.kind === 'binary'
                ? { kind: 'binary' }
                : { kind: 'too-large', maxBytes: file.body.maxBytes },
        };
      } catch (error) {
        const reason = NOT_READABLE_COPY.get(errorCodeOf(error) ?? '');
        if (reason === undefined) throw error;
        return { path, size: 0, lastCommit: null, body: { kind: 'not-readable', reason } };
      }
    },
    events(onChange: () => void): () => void {
      // One shared watcher, so the tree and the pending-work badges above it
      // refresh off the same signal at the same rate rather than on two clocks
      // that drift apart — a listing showing a merged file beside a badge still
      // claiming it is unmerged is worse than either being a moment late.
      return watchRoomEntries(queryClient, roomId, onChange);
    },
  };
}
