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
import { ROOM_FILE_CHANGED_CODE, type RoomFileEntry } from '@dorkos/shared/room-files';
import { roomKeys } from '@/layers/entities/room';
import { errorCodeOf, ROOM_HAS_NO_REPO_CODE } from '../lib/error-code';
import { roomFileConflictOf, saveRefusalMessage } from '../lib/save-errors';
import { watchRoomEntries } from './room-entry-watch';
import type {
  ExplorerEntry,
  ExplorerFile,
  ExplorerListing,
  ExplorerSaveInput,
  ExplorerSaveOutcome,
  FileExplorerSource,
} from './source';

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
    // The tree is not writable and the FILES are — the opposite pair from a
    // session, and both halves are true at once. Merging is what adds and
    // removes entries here; a person's own edits go through §3.10's door, one
    // save to one commit with their name on it.
    editable: true,
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
          // What a later save checks itself against. Carried from the read that
          // opened the file rather than read again at save time: the point of
          // the lock is that it names the version the PERSON saw.
          commit: file.commit,
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
        return {
          path,
          size: 0,
          lastCommit: null,
          commit: null,
          body: { kind: 'not-readable', reason },
        };
      }
    },
    async save(input: ExplorerSaveInput): Promise<ExplorerSaveOutcome> {
      try {
        const saved = await transport.saveRoomFile(roomId, {
          path: input.path,
          baseCommit: input.baseCommit,
          text: input.text,
        });
        return {
          status: 'saved',
          commit: saved.commit,
          lastCommit: saved.lastCommit,
          committed: saved.committed,
        };
      } catch (error) {
        const code = errorCodeOf(error);
        // The one refusal a person ANSWERS rather than acknowledges. Nothing was
        // written, and the room hands back where it is now — which is both what
        // "open theirs" re-reads at and what "save mine over theirs" sends back
        // as the base.
        if (code === ROOM_FILE_CHANGED_CODE) {
          const conflict = roomFileConflictOf(error);
          // A `FILE_CHANGED` with no parsed conflict on it cannot be offered as
          // a choice — there is no commit to re-read at or to save against — so
          // it is told as a refusal rather than as a dialog with dead buttons.
          if (conflict !== null) {
            return { status: 'conflict', commit: conflict.commit, lastCommit: conflict.lastCommit };
          }
          return {
            status: 'refused',
            reason:
              'Somebody changed this file while you were editing it, so nothing was saved. Close this and open it again to see their version.',
          };
        }
        // The room's copy has changed since the warning above the files was
        // last drawn — this refusal is the proof. Re-ask now, so the sentence
        // the person is about to read has something to point at.
        if (code === 'MAIN_CHECKOUT_DIRTY') {
          void queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(roomId) });
        }
        const reason = saveRefusalMessage(code);
        // A refusal nobody wrote copy for is a bug, not a rule. Rethrowing is
        // what puts it in front of somebody who can fix it, rather than dressing
        // it up as an ordinary answer.
        if (reason === undefined) throw error;
        return { status: 'refused', reason };
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
