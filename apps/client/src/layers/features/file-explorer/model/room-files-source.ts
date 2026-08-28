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
import { roomKeys } from '@/layers/entities/room';
import { errorCodeOf } from '../lib/error-code';
import type { ExplorerEntry, ExplorerFile, ExplorerListing, FileExplorerSource } from './source';

/**
 * The shortest gap between two refreshes the room's stream can provoke.
 *
 * A room's files change when somebody merges, and a merge is announced in the
 * room as an entry of its own (spec §3.6, task 2.3) — but so is every message,
 * and this stream carries both. Rather than guess at the shape of an entry that
 * does not exist yet, ANY arriving entry is taken as "look again", and the cost
 * of being wrong is bounded here: a room talking all afternoon buys at most one
 * directory listing every fifteen seconds, and a merge lands on screen inside
 * that same window. When merge entries arrive, this needs no shape to learn —
 * they are entries, and entries are already the signal.
 */
export const ROOM_FILES_REFRESH_INTERVAL_MS = 15_000;

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
 */
const NOT_READABLE_COPY: Record<string, string> = {
  ROOM_FILE_NOT_READABLE: "This isn't a file that can be shown here.",
  ROOM_FILE_NOT_FOUND: "This file isn't in the room's files any more.",
};

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
      const listing = await transport.readRoomFiles(roomId, path === '' ? undefined : path);
      return { entries: listing.entries.map(toExplorerEntry) };
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
        const reason = NOT_READABLE_COPY[errorCodeOf(error) ?? ''];
        if (reason === undefined) throw error;
        return { path, size: 0, lastCommit: null, body: { kind: 'not-readable', reason } };
      }
    },
    events(onChange: () => void): () => void {
      // The room's own stream is what tells this client anything happened: it
      // merges every arriving entry into the room's cached history, so watching
      // that cache entry is watching the stream, without opening a second one
      // or reaching past the hook that owns it.
      const historyKey = JSON.stringify(roomKeys.entries(roomId));
      let lastAt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const fire = (): void => {
        lastAt = Date.now();
        onChange();
      };

      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated') return;
        if (JSON.stringify(event.query.queryKey) !== historyKey) return;
        if (timer !== null) return;
        const wait = Math.max(0, ROOM_FILES_REFRESH_INTERVAL_MS - (Date.now() - lastAt));
        // Trailing rather than leading, deliberately: the entry that announces
        // a merge reaches this client at the same moment the merge lands, and
        // a listing asked for in that instant can still race the commit it is
        // asking about. Waiting is both cheaper and more likely to be right.
        timer = setTimeout(() => {
          timer = null;
          fire();
        }, wait);
      });

      return () => {
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
      };
    },
  };
}
