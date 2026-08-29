/**
 * Room Transport methods factory (HTTP adapter) — channels and DMs (spec
 * `rooms`). Talks to the Express `/api/rooms/*` routes.
 *
 * Only what the cockpit performs today is here: reading a room, posting to it,
 * replying inside a thread, settling its title / topic / archived flag, editing
 * its roster, and moving the read cursor. The thread reply is its own route
 * rather than a flag on the post, because nothing has to be created first — a
 * thread is a relation between entries (ADR 260728-022013).
 *
 * @module shared/lib/transport/room-methods
 */

import {
  RoomEventSchema,
  type AddRoomMemberRequest,
  type AuthorRef,
  type CreateRoomRequest,
  type HaltRoomResponse,
  type PromoteHoldResponse,
  type ListRoomEntriesQuery,
  type ListRoomsQuery,
  type ListThreadsQuery,
  type PostThreadReplyRequest,
  type PostToRoomRequest,
  type PostToRoomResponse,
  type RoomAttachment,
  type RoomEntry,
  type RoomEvent,
  type RoomMember,
  type RoomRosterEntry,
  type RoomSessionsResponse,
  type RoomSummary,
  type RoomWithRoster,
  type ThreadSummary,
  type ToggleReactionRequest,
  type ToggleReactionResponse,
  type UpdateMembershipRequest,
  type UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import type {
  RoomFileContentResponse,
  RoomFileListResponse,
  RoomFileSaveRequest,
  RoomFileSaveResponse,
} from '@dorkos/shared/room-files';
import type {
  RoomMainRepairRequest,
  RoomMainRepairResult,
  RoomRepoStatus,
} from '@dorkos/shared/room-repo';
import type { UploadProgress } from '@dorkos/shared/types';
import type { UploadFile } from '@dorkos/shared/transport';
import { SSE_RESILIENCE } from '../constants';
import { fetchJSON, fetchNoContent, buildQueryString } from './http-client';
import { streamSocketFrames, type StreamSocketClosed } from './stream-socket-iterator';
import { uploadRoomAttachmentsOverHttp } from './upload-methods';

/**
 * A room's event stream answered with an HTTP error rather than a stream.
 *
 * Its own class so the retry loop can read the STATUS rather than the sentence.
 * "Briefly unreachable" and "this room is not yours to read" both arrive here as
 * a rejected promise, and only the status tells them apart — a distinction the
 * loop needs because it now retries forever, and forever is the wrong answer to
 * a room that has been deleted or access that has been revoked.
 *
 * The in-process adapter (`DirectTransport`, Obsidian) never throws one, and
 * that is correct: it has no HTTP status to report, so everything it throws is
 * treated as retryable — which it is.
 */
export class RoomStreamHttpError extends Error {
  /** The HTTP status the room's event route answered with. */
  readonly status: number;

  /**
   * Build the error the room's event route answered with.
   *
   * @param status - The HTTP status.
   * @param statusText - The reason phrase, for the log line.
   */
  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'RoomStreamHttpError';
    this.status = status;
  }
}

/**
 * Statuses that mean trying again cannot help.
 *
 * The server has ANSWERED, and its answer is that this reader may not read this
 * room: it is gone (404), or they are not signed in (401), or they are not a
 * member (403). Every other failure — a dropped socket, a 5xx, a restart, an
 * offline laptop — is a reason to keep trying.
 */
const FATAL_STREAM_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * Is this the server telling a reader the room is not theirs to read?
 *
 * Anything it cannot recognise is retryable, deliberately: the cost of retrying
 * a genuinely fatal error is a notice that says "reconnecting" too long, and the
 * cost of giving up on a retryable one is a room frozen for the session.
 *
 * @param err - Whatever the stream threw.
 */
export function isFatalStreamError(err: unknown): boolean {
  return err instanceof RoomStreamHttpError && FATAL_STREAM_STATUSES.has(err.status);
}

/** Create the room methods bound to a base URL. */
export function createRoomMethods(baseUrl: string) {
  return {
    listRooms(query?: ListRoomsQuery): Promise<RoomSummary[]> {
      const qs = buildQueryString({
        kind: query?.kind,
        includeArchived: query?.includeArchived,
      });
      return fetchJSON<{ rooms: RoomSummary[] }>(baseUrl, `/rooms${qs}`).then((r) => r.rooms);
    },

    listThreads(query?: ListThreadsQuery): Promise<ThreadSummary[]> {
      const qs = buildQueryString({ limit: query?.limit });
      return fetchJSON<{ threads: ThreadSummary[] }>(baseUrl, `/rooms/threads${qs}`).then(
        (r) => r.threads
      );
    },

    createRoom(req: CreateRoomRequest): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, '/rooms', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    getRoom(id: string): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, `/rooms/${id}`);
    },

    updateRoom(id: string, req: UpdateRoomRequest): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, `/rooms/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(req),
      });
    },

    listRoomEntries(id: string, query?: ListRoomEntriesQuery): Promise<RoomEntry[]> {
      const qs = buildQueryString({ before: query?.before, limit: query?.limit });
      return fetchJSON<{ entries: RoomEntry[] }>(baseUrl, `/rooms/${id}/entries${qs}`).then(
        (r) => r.entries
      );
    },

    /**
     * One directory of a room's files. `path` rides as a query value rather
     * than a path segment because a repo path holds slashes, and a segment
     * would mean encoding them out and decoding them back in — one more place
     * for the two ends to disagree about what a filename is.
     */
    readRoomFiles(id: string, path?: string): Promise<RoomFileListResponse> {
      const qs = buildQueryString({ path });
      return fetchJSON<RoomFileListResponse>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/files${qs}`
      );
    },

    /** One file out of a room's `main`, for the same reason in the same shape. */
    readRoomFileContent(id: string, path: string): Promise<RoomFileContentResponse> {
      const qs = buildQueryString({ path });
      return fetchJSON<RoomFileContentResponse>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/files/content${qs}`
      );
    },

    /** Where the room's files stand, and who is holding work it has not got. */
    readRoomRepoStatus(id: string): Promise<RoomRepoStatus> {
      return fetchJSON<RoomRepoStatus>(baseUrl, `/rooms/${encodeURIComponent(id)}/repo/status`);
    },

    /**
     * Save one file, as one commit by the person doing it.
     *
     * The same URL the read uses, with the file named in the BODY rather than
     * the query — a save carries its contents anyway, so putting the path
     * beside them keeps one request rather than a query and a body that could
     * disagree about which file this is.
     *
     * A `FILE_CHANGED` refusal arrives as a thrown error carrying the server's
     * `code` and its parsed `body`, which is where the `conflict` the reload /
     * keep-mine choice needs lives.
     */
    saveRoomFile(id: string, req: RoomFileSaveRequest): Promise<RoomFileSaveResponse> {
      return fetchJSON<RoomFileSaveResponse>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/files/content`,
        { method: 'PUT', body: JSON.stringify(req) }
      );
    },

    /**
     * Keep or discard the changes somebody made outside DorkOS.
     *
     * The operator's door out of `MAIN_CHECKOUT_DIRTY`; a discard names its
     * files, and the server refuses any name it is not reporting right now.
     */
    repairRoomMain(id: string, req: RoomMainRepairRequest): Promise<RoomMainRepairResult> {
      return fetchJSON<RoomMainRepairResult>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/repo/main/repair`,
        { method: 'POST', body: JSON.stringify(req) }
      );
    },

    /**
     * Post to a room. The 202 answers with the entry's identity only — the
     * entry itself arrives on `subscribeRoom`, so nothing here writes it into
     * the cache.
     */
    postToRoom(id: string, req: PostToRoomRequest): Promise<PostToRoomResponse> {
      return fetchJSON<PostToRoomResponse>(baseUrl, `/rooms/${id}/entries`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    /**
     * Upload files into a room, ahead of the message that names them.
     *
     * Its own request rather than a field on {@link postToRoom} because the
     * body is multipart and the bytes exist before the entry does: the ids come
     * back here, and the post that follows carries them in `attachmentIds`.
     *
     * No `cwd` — a room has none. That is the whole reason this endpoint is not
     * `/uploads`.
     */
    uploadRoomAttachments(
      id: string,
      files: UploadFile[],
      onProgress?: (progress: UploadProgress) => void,
      signal?: AbortSignal
    ): Promise<RoomAttachment[]> {
      return uploadRoomAttachmentsOverHttp(baseUrl, id, files, onProgress, signal);
    },

    /**
     * Reply in the thread hanging off `req.rootEntryId`. Trigger-only, exactly
     * as `postToRoom` is — the reply reaches this reader on `subscribeRoom`,
     * where the timeline gathers it under its root.
     */
    replyInThread(id: string, req: PostThreadReplyRequest): Promise<PostToRoomResponse> {
      return fetchJSON<PostToRoomResponse>(baseUrl, `/rooms/${id}/threads`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    /**
     * Stop every turn running in this room. A control action: it reaches the
     * runtimes, never the models, and the room's own `halted` notice arrives on
     * `subscribeRoom` like any other entry.
     */
    haltRoom(id: string): Promise<HaltRoomResponse> {
      return fetchJSON<HaltRoomResponse>(baseUrl, `/rooms/${id}/halt`, { method: 'POST' });
    },

    /**
     * Stop one agent's turn here and leave the rest of the room working. A path
     * segment rather than a body field, because a target that can be omitted is
     * a stop that can quietly take the whole room with it.
     */
    haltRoomAgent(id: string, authorId: string): Promise<HaltRoomResponse> {
      return fetchJSON<HaltRoomResponse>(
        baseUrl,
        `/rooms/${id}/halt/${encodeURIComponent(authorId)}`,
        { method: 'POST' }
      );
    },

    /**
     * Ask for this room to be the next one that agent answers. Reorders; the
     * turn in the way is untouched.
     */
    promoteHold(id: string, authorId: string): Promise<PromoteHoldResponse> {
      return fetchJSON<PromoteHoldResponse>(
        baseUrl,
        `/rooms/${id}/holds/${encodeURIComponent(authorId)}/promote`,
        { method: 'POST' }
      );
    },

    /**
     * Where each of this room's agents does its work. Ids only, people only —
     * see the port's own note.
     */
    listRoomSessions(id: string): Promise<RoomSessionsResponse> {
      return fetchJSON<RoomSessionsResponse>(baseUrl, `/rooms/${id}/sessions`);
    },

    /**
     * Toggle one emoji on one entry. The 202 says which way this caller's own
     * click went; the entry's whole new set arrives on `subscribeRoom`, which
     * is what a pill must ultimately be drawn from.
     */
    toggleReaction(
      id: string,
      entryId: string,
      req: ToggleReactionRequest
    ): Promise<ToggleReactionResponse> {
      return fetchJSON<ToggleReactionResponse>(
        baseUrl,
        `/rooms/${id}/entries/${encodeURIComponent(entryId)}/reactions`,
        { method: 'POST', body: JSON.stringify(req) }
      );
    },

    addRoomMember(id: string, req: AddRoomMemberRequest): Promise<RoomRosterEntry> {
      return fetchJSON<RoomRosterEntry>(baseUrl, `/rooms/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    updateRoomMember(
      id: string,
      authorId: string,
      req: UpdateMembershipRequest
    ): Promise<RoomRosterEntry> {
      return fetchJSON<RoomRosterEntry>(
        baseUrl,
        `/rooms/${id}/members/${encodeURIComponent(authorId)}`,
        { method: 'PATCH', body: JSON.stringify(req) }
      );
    },

    setAuthorHandle(authorId: string, handle: string): Promise<AuthorRef> {
      return fetchJSON<AuthorRef>(
        baseUrl,
        `/rooms/authors/${encodeURIComponent(authorId)}/handle`,
        { method: 'PATCH', body: JSON.stringify({ handle }) }
      );
    },

    /** The route answers 204, so there is no body to read back. */
    removeRoomMember(id: string, authorId: string): Promise<void> {
      return fetchNoContent(baseUrl, `/rooms/${id}/members/${encodeURIComponent(authorId)}`, {
        method: 'DELETE',
      });
    },

    /**
     * Subscribe to a room's durable event stream, over a WebSocket.
     *
     * The leading `snapshot` frame of a cold connect is skipped: the room and
     * its history are hydrated through `getRoom` / `listRoomEntries`, so
     * re-parsing the snapshot here would only duplicate what the cache already
     * holds. Callers that already have entries pass the highest `seq` they hold
     * as `sinceCursor`, which the server replays from gap-free.
     *
     * Malformed frames are dropped with a warning rather than tearing the
     * stream down, matching the session stream's validation semantics.
     *
     * Two pieces of resilience live down here rather than in the consuming
     * hook, and both have to. **Silence detection**, because the server's
     * heartbeat is a frame the layer above never sees — up there a dead socket
     * and a quiet room look identical, and rooms are quiet nearly all the time.
     * And **the refusal status**, because a browser cannot read the status of a
     * failed WebSocket handshake at all: the server therefore refuses with an
     * application close code, and this is where that becomes the
     * {@link RoomStreamHttpError} the retry loop reads to tell "briefly
     * unreachable" from "this room is not yours".
     */
    async *subscribeRoom(
      roomId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<RoomEvent> {
      let closed: StreamSocketClosed = { status: null, silent: false };
      const qs = buildQueryString({ after: sinceCursor });
      const frames = streamSocketFrames(`${baseUrl}/rooms/${roomId}/events${qs}`, {
        signal,
        onClosed: (result) => (closed = result),
      });

      for await (const frame of frames) {
        if (frame.event === 'snapshot') continue;
        const parsed = RoomEventSchema.safeParse(frame.data);
        if (!parsed.success) {
          console.warn('[Transport] dropping malformed room-event frame', {
            roomId,
            issues: parsed.error.issues,
          });
          continue;
        }
        yield parsed.data;
      }

      if (signal?.aborted) return;
      // The stream ENDED, and how it ended is what the caller's retry loop acts
      // on. A refusal carries its status; anything else is a drop worth
      // retrying. Throwing rather than returning is deliberate: a return would
      // read as "the room is over".
      if (closed.status !== null) {
        throw new RoomStreamHttpError(closed.status, 'stream refused');
      }
      if (closed.silent) {
        throw new Error(
          `Room stream heard nothing for ${SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS}ms — treating it as dropped`
        );
      }
      throw new Error('Room stream closed');
    },
  };
}
