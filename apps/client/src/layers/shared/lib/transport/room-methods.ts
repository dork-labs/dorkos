/**
 * Room Transport methods factory (HTTP adapter) — channels and DMs (spec
 * `rooms`). Talks to the `/api/rooms/*` routes through the generated API
 * client (DOR-5473); the multipart upload and the event socket stay by hand.
 *
 * Only what the app performs today is here: reading a room, posting to it,
 * replying inside a thread, settling its title / topic / archived flag, editing
 * its roster, and moving the read cursor. The thread reply is its own route
 * rather than a flag on the post, because nothing has to be created first — a
 * thread is a relation between entries (ADR 260728-022013).
 *
 * @module shared/lib/transport/room-methods
 */

import { z } from 'zod';
import {
  CanvasDocumentSchema,
  RoomEventSchema,
  type AddRoomMemberRequest,
  type AuthorRef,
  type CanvasDocument,
  type CanvasEditingResponse,
  type CanvasThreadResponse,
  type PublishRoomViewResponse,
  type RoomSignalView,
  type CreateRoomRequest,
  type DirectChat,
  type OpenDirectChatRequest,
  type HaltRoomResponse,
  type ReseatOptions,
  type ReseatSeatRequest,
  type PromoteHoldResponse,
  type ListRoomEntriesQuery,
  type ListRoomsQuery,
  type ListThreadsQuery,
  type PostThreadReplyRequest,
  type PostToRoomRequest,
  type PostToRoomResponse,
  type RoomAttachment,
  type RoomEntryListResponse,
  type RoomEvent,
  type RoomRosterEntry,
  type RoomSessionsResponse,
  type RoomSummary,
  type RoomWithRoster,
  type ThreadSummary,
  type ToggleReactionRequest,
  type ToggleReactionResponse,
  type UpdateCanvasDocumentRequest,
  type UpdateMembershipRequest,
  type UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import type {
  RoomCanvasDiffReview,
  RoomCanvasDiffWriteRequest,
  RoomCanvasDiffWriteResult,
  RoomFileChangeResponse,
  RoomFileContentResponse,
  RoomFileDeleteRequest,
  RoomFileFromAttachmentRequest,
  RoomFileListResponse,
  RoomFileMoveRequest,
  RoomFileSaveRequest,
  RoomFileSaveResponse,
} from '@dorkos/shared/room-files';
import { ROOM_UPLOAD_FILES_FIELD } from '@dorkos/shared/room-files';
import type {
  EnableRoomRepoResponse,
  RoomMainRepairRequest,
  RoomMainRepairResult,
  RoomMergeResult,
  RoomRepoStatus,
} from '@dorkos/shared/room-repo';
import type { UiCanvasContent, UploadProgress } from '@dorkos/shared/types';
import type { UploadFile } from '@dorkos/shared/transport';
import type { RoomFileUploadInput } from '@dorkos/shared/transport-rooms';
import { SSE_RESILIENCE } from '../constants';
import { createTransportApiClient } from './api-client';
import { fetchJSON, buildQueryString } from './http-client';
import { streamSocketFrames, type StreamSocketClosed } from './stream-socket-iterator';
import { uploadRoomAttachmentsOverHttp } from './upload-methods';

/**
 * How long a room-files upload may take before it is given up on.
 *
 * Longer than a JSON call's 30 seconds because an upload is up to twenty files
 * at the room's per-file cap, and a slow link moving that much is working, not
 * stuck.
 */
const ROOM_FILE_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * The one part of a cold connect's snapshot this adapter consumes.
 *
 * A room's roster and history are hydrated through `getRoom` and
 * `listRoomEntries`, so the snapshot's other fields are dropped unread — and
 * parsing what you drop is how an unrelated field's drift takes down the field
 * you needed. The canvas has no second source: this stream is the only thing
 * that ever tells a client what is on a room's table (spec `room-canvas` §9.2).
 */
const SNAPSHOT_CANVAS = z.object({ canvas: z.array(CanvasDocumentSchema).optional() });

/**
 * A room's event stream answered with an HTTP error rather than a stream.
 *
 * Its own class so the retry loop can read the STATUS rather than the sentence.
 * "Briefly unreachable" and "this room is not yours to read" both arrive here as
 * a rejected promise, and only the status tells them apart — a distinction the
 * loop needs because it now retries forever, and forever is the wrong answer to
 * a room that has been deleted or access that has been revoked.
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
  const api = createTransportApiClient(baseUrl);
  return {
    async listRooms(query?: ListRoomsQuery): Promise<RoomSummary[]> {
      const { kind, includeArchived } = query ?? {};
      const list = await api.call('rooms.list', { query: { kind, includeArchived } });
      return (list as { rooms: RoomSummary[] }).rooms;
    },

    async listThreads(query?: ListThreadsQuery): Promise<ThreadSummary[]> {
      const list = await api.call('rooms.listThreads', { query: { limit: query?.limit } });
      return (list as { threads: ThreadSummary[] }).threads;
    },

    async createRoom(req: CreateRoomRequest): Promise<RoomWithRoster> {
      return (await api.call('rooms.create', { body: req })) as RoomWithRoster;
    },

    async getRoom(id: string): Promise<RoomWithRoster> {
      return (await api.call('rooms.get', { path: { id } })) as RoomWithRoster;
    },

    async enableRoomRepo(id: string): Promise<EnableRoomRepoResponse> {
      return (await api.call('rooms.createRepo', { path: { id } })) as EnableRoomRepoResponse;
    },

    async updateRoom(id: string, req: UpdateRoomRequest): Promise<RoomWithRoster> {
      return (await api.call('rooms.update', { path: { id }, body: req })) as RoomWithRoster;
    },

    /**
     * The page, with the thread roots it points at ahead of it (DOR-690).
     *
     * **The history this returns is one array in `seq` order, and everything
     * above reads it that way** — the cache the live stream merges into, the
     * cursor it resumes from, the grouping the timeline draws. So the two
     * arrays the server keeps apart are joined here, and this is the only place
     * that knows they were ever separate. Roots go first because every one of
     * them is older than the page's own oldest entry: a root inside the page's
     * `seq` range came back IN the page.
     *
     * The wire keeps them apart so a caller that pages BACKWARDS can tell where
     * the page ends — the `before=` cursor is `entries[0].seq`, never a root's.
     * Nothing asks for that yet; when something does, it reads the envelope
     * rather than un-mixing this array.
     */
    async listRoomEntries(
      id: string,
      query?: ListRoomEntriesQuery
    ): Promise<RoomEntryListResponse> {
      const { before, limit } = query ?? {};
      return (await api.call('rooms.listEntries', {
        path: { id },
        query: { before, limit },
      })) as RoomEntryListResponse;
    },

    /**
     * One directory of a room's files. `path` rides as a query value rather
     * than a path segment because a repo path holds slashes, and a segment
     * would mean encoding them out and decoding them back in — one more place
     * for the two ends to disagree about what a filename is.
     */
    async readRoomFiles(id: string, path?: string): Promise<RoomFileListResponse> {
      return (await api.call('rooms.getFiles', {
        path: { id },
        query: { path },
      })) as RoomFileListResponse;
    },

    /** One file out of a room's `main`, for the same reason in the same shape. */
    async readRoomFileContent(id: string, path: string): Promise<RoomFileContentResponse> {
      return (await api.call('rooms.getFilesContent', {
        path: { id },
        query: { path },
      })) as RoomFileContentResponse;
    },

    /** Where one of a room's pictures is served, named the way its content is. */
    roomFileImageUrl(id: string, path: string): string {
      return `${baseUrl}/rooms/${encodeURIComponent(id)}/files/raw${buildQueryString({ path })}`;
    },

    /** Where the room's files stand, and who is holding work it has not got. */
    async readRoomRepoStatus(id: string): Promise<RoomRepoStatus> {
      return (await api.call('rooms.getRepoStatus', { path: { id } })) as RoomRepoStatus;
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
    async saveRoomFile(id: string, req: RoomFileSaveRequest): Promise<RoomFileSaveResponse> {
      return (await api.call('rooms.updateFilesContent', {
        path: { id },
        body: req,
      })) as RoomFileSaveResponse;
    },

    /**
     * Upload files into one folder of a room's files, as one commit.
     *
     * Through `fetchJSON` rather than the attachment uploader's XHR, on
     * purpose: every refusal here is one the person ANSWERS — a name that is
     * already taken, a file somebody changed — and those arrive as the server's
     * `code` and parsed `body` on the thrown error, which only this path keeps.
     * The text fields go in before the files so the server has them whatever
     * order it reads the body in. The clock is longer than a JSON call's,
     * because twenty files is a real amount of bytes on a slow link.
     */
    async uploadRoomFiles(id: string, input: RoomFileUploadInput): Promise<RoomFileChangeResponse> {
      const form = new FormData();
      form.append('dir', input.dir);
      form.append('baseCommit', input.baseCommit ?? '');
      form.append('replace', JSON.stringify(input.replace));
      for (const file of input.files) {
        const bytes = await file.arrayBuffer();
        form.append(ROOM_UPLOAD_FILES_FIELD, new Blob([bytes], { type: file.type }), file.name);
      }
      return fetchJSON<RoomFileChangeResponse>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/files/upload`,
        { method: 'POST', body: form, timeout: ROOM_FILE_UPLOAD_TIMEOUT_MS }
      );
    },

    /** Rename or move one file or folder, as one commit. */
    async moveRoomFile(id: string, req: RoomFileMoveRequest): Promise<RoomFileChangeResponse> {
      return (await api.call('rooms.moveFiles', {
        path: { id },
        body: req,
      })) as RoomFileChangeResponse;
    },

    /**
     * Delete one file or folder, as one commit. A POST, because the request
     * carries its lock in a body and a DELETE body is one proxies may drop.
     */
    async deleteRoomFile(id: string, req: RoomFileDeleteRequest): Promise<RoomFileChangeResponse> {
      return (await api.call('rooms.deleteFiles', {
        path: { id },
        body: req,
      })) as RoomFileChangeResponse;
    },

    /** Keep a file from a message in this room as one of its files. */
    async saveAttachmentToRoomFiles(
      id: string,
      req: RoomFileFromAttachmentRequest
    ): Promise<RoomFileChangeResponse> {
      return (await api.call('rooms.createFilesFromAttachment', {
        path: { id },
        body: req,
      })) as RoomFileChangeResponse;
    },

    /**
     * Keep or discard the changes somebody made outside DorkOS.
     *
     * The operator's door out of `MAIN_CHECKOUT_DIRTY`; a discard names its
     * files, and the server refuses any name it is not reporting right now.
     */
    async repairRoomMain(id: string, req: RoomMainRepairRequest): Promise<RoomMainRepairResult> {
      return (await api.call('rooms.createRepoMainRepair', {
        path: { id },
        body: req,
      })) as RoomMainRepairResult;
    },

    /**
     * Merge one agent's working copy into the room's `main`.
     *
     * The operator's door to the same server-mediated merge an agent reaches
     * through `merge_to_room_main` — same queue, same refusals, same single
     * line in the room's log.
     */
    async mergeRoomMain(
      id: string,
      input: { summary: string; worktree: string }
    ): Promise<RoomMergeResult> {
      return (await api.call('rooms.mergeRepo', { path: { id }, body: input })) as RoomMergeResult;
    },

    /**
     * Post to a room. The 202 answers with the entry's identity only — the
     * entry itself arrives on `subscribeRoom`, so nothing here writes it into
     * the cache.
     */
    async postToRoom(id: string, req: PostToRoomRequest): Promise<PostToRoomResponse> {
      return (await api.call('rooms.createEntries', {
        path: { id },
        body: req,
      })) as PostToRoomResponse;
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
    async replyInThread(id: string, req: PostThreadReplyRequest): Promise<PostToRoomResponse> {
      return (await api.call('rooms.createThreads', {
        path: { id },
        body: req,
      })) as PostToRoomResponse;
    },

    /**
     * Stop every turn running in this room. A control action: it reaches the
     * runtimes, never the models, and the room's own `halted` notice arrives on
     * `subscribeRoom` like any other entry.
     */
    async haltRoom(id: string): Promise<HaltRoomResponse> {
      return (await api.call('rooms.halt', { path: { id } })) as HaltRoomResponse;
    },

    /**
     * Stop one agent's turn here and leave the rest of the room working. A path
     * segment rather than a body field, because a target that can be omitted is
     * a stop that can quietly take the whole room with it.
     */
    async haltRoomAgent(id: string, authorId: string): Promise<HaltRoomResponse> {
      return (await api.call('rooms.createHalt', { path: { id, authorId } })) as HaltRoomResponse;
    },

    /** Where an agent's seat here could move (re-seat). */
    async getRoomReseatOptions(id: string, authorId: string): Promise<ReseatOptions> {
      return (await api.call('rooms.reseat_options', { path: { id, authorId } })) as ReseatOptions;
    },

    /** Move an agent's seat here to another account (re-seat). */
    async reseatRoomAgent(
      id: string,
      authorId: string,
      request: ReseatSeatRequest
    ): Promise<{ sessionId: string }> {
      return (await api.call('rooms.reseat', { path: { id, authorId }, body: request })) as {
        sessionId: string;
      };
    },

    /**
     * Ask for this room to be the next one that agent answers. Reorders; the
     * turn in the way is untouched.
     */
    async promoteHold(id: string, authorId: string): Promise<PromoteHoldResponse> {
      return (await api.call('rooms.createHoldsPromote', {
        path: { id, authorId },
      })) as PromoteHoldResponse;
    },

    /**
     * Where each of this room's agents does its work. Ids only, people only —
     * see the port's own note.
     */
    async listRoomSessions(id: string): Promise<RoomSessionsResponse> {
      return (await api.call('rooms.getSessions', { path: { id } })) as RoomSessionsResponse;
    },

    /** Open an agent's Direct chat (rule S12), made on first need. */
    async openDirectChat(req: OpenDirectChatRequest): Promise<DirectChat> {
      return (await api.call('directChats.create', { body: req })) as DirectChat;
    },

    /**
     * The Direct chat this session is, or `null`: a 404 is an ordinary answer,
     * and so is a 403 — only the owner has Direct chats.
     */
    async findDirectChat(sessionId: string): Promise<DirectChat | null> {
      try {
        return (await api.call('directChats.getBySession', {
          path: { sessionId },
        })) as DirectChat;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 403) return null;
        throw err;
      }
    },

    /**
     * Toggle one emoji on one entry. The 202 says which way this caller's own
     * click went; the entry's whole new set arrives on `subscribeRoom`, which
     * is what a pill must ultimately be drawn from.
     */
    async toggleReaction(
      id: string,
      entryId: string,
      req: ToggleReactionRequest
    ): Promise<ToggleReactionResponse> {
      return (await api.call('rooms.createEntriesReactions', {
        path: { id, entryId },
        body: req,
      })) as ToggleReactionResponse;
    },

    async addRoomMember(id: string, req: AddRoomMemberRequest): Promise<RoomRosterEntry> {
      return (await api.call('rooms.createMembers', {
        path: { id },
        body: req,
      })) as RoomRosterEntry;
    },

    async updateRoomMember(
      id: string,
      authorId: string,
      req: UpdateMembershipRequest
    ): Promise<RoomRosterEntry> {
      return (await api.call('rooms.updateMembers', {
        path: { id, authorId },
        body: req,
      })) as RoomRosterEntry;
    },

    async setAuthorHandle(authorId: string, handle: string): Promise<AuthorRef> {
      return (await api.call('rooms.updateAuthorsHandle', {
        path: { authorId },
        body: { handle },
      })) as AuthorRef;
    },

    /** The route answers 204, so there is no body to read back. */
    async removeRoomMember(id: string, authorId: string): Promise<void> {
      await api.call('rooms.deleteMembers', { path: { id, authorId } });
    },

    // --- The room's shared canvas (spec `room-canvas` §4) ---

    /**
     * Put something on the room's canvas as the person doing it.
     *
     * The answer is the row the table now holds; every screen is drawn from the
     * `canvas` frame that reaches every viewer, this one included, so nothing
     * here writes state.
     */
    openRoomCanvasDocument(id: string, content: UiCanvasContent): Promise<CanvasDocument> {
      return fetchJSON<CanvasDocument>(baseUrl, `/rooms/${encodeURIComponent(id)}/canvas`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
    },

    /** Change one canvas document — its content, its pin, its place in the order. */
    updateRoomCanvasDocument(
      id: string,
      documentId: string,
      req: UpdateCanvasDocumentRequest
    ): Promise<CanvasDocument> {
      return fetchJSON<CanvasDocument>(
        baseUrl,
        `/rooms/${encodeURIComponent(id)}/canvas/${encodeURIComponent(documentId)}`,
        { method: 'PATCH', body: JSON.stringify(req) }
      );
    },

    /** Take a document off the room's canvas, for everybody. */
    async closeRoomCanvasDocument(id: string, documentId: string): Promise<void> {
      await api.call('rooms.deleteCanvas', { path: { id, documentId } });
    },

    /** The two copies of the file behind a room's worktree diff. */
    async readRoomCanvasDiff(id: string, documentId: string): Promise<RoomCanvasDiffReview> {
      return (await api.call('rooms.getCanvasDiff', {
        path: { id, documentId },
      })) as RoomCanvasDiffReview;
    },

    /** Put a reviewed file back in the member's working copy. */
    async writeRoomCanvasDiff(
      id: string,
      documentId: string,
      req: RoomCanvasDiffWriteRequest
    ): Promise<RoomCanvasDiffWriteResult> {
      return (await api.call('rooms.updateCanvasDiff', {
        path: { id, documentId },
        body: req,
      })) as RoomCanvasDiffWriteResult;
    },

    /** Say which canvas document you are looking at, or that you have looked away. */
    async setRoomCanvasViewing(id: string, documentId: string | null): Promise<void> {
      await api.call('rooms.createCanvasViewing', { path: { id }, body: { documentId } });
    },

    /** Take, refresh or release the edit lock on one canvas document. */
    async setRoomCanvasEditing(
      id: string,
      documentId: string,
      editing: boolean
    ): Promise<CanvasEditingResponse> {
      return (await api.call('rooms.createCanvasEditing', {
        path: { id, documentId },
        body: { editing },
      })) as CanvasEditingResponse;
    },

    /** Open this document's discussion, or re-open the one already there. */
    async discussCanvasDocument(id: string, documentId: string): Promise<CanvasThreadResponse> {
      return (await api.call('rooms.createCanvasThread', {
        path: { id, documentId },
      })) as CanvasThreadResponse;
    },

    /** Follow somebody's browser here, or say you are still following them. */
    async followRoomMember(id: string, memberId: string): Promise<void> {
      await api.call('rooms.updateFollow', { path: { id }, body: { memberId } });
    },

    /** Stop following whoever you were following here. */
    async unfollowRoomMember(id: string): Promise<void> {
      await api.call('rooms.deleteFollow', { path: { id } });
    },

    /** Say where you are looking, for whoever is following you. */
    async publishRoomView(id: string, view: RoomSignalView): Promise<PublishRoomViewResponse> {
      return (await api.call('rooms.createFollowView', {
        path: { id },
        body: view,
      })) as PublishRoomViewResponse;
    },

    /**
     * Subscribe to a room's durable event stream, over a WebSocket.
     *
     * The leading `snapshot` frame of a cold connect is skipped EXCEPT for its
     * canvas: the room and its history are hydrated through `getRoom` /
     * `listRoomEntries`, while the room's shared canvas is hydrated from this
     * stream and nowhere else — so
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
        // The leading frame of a COLD connect. Its roster and history are
        // already hydrated through `getRoom` / `listRoomEntries`, so almost all
        // of it is skipped — but the room's canvas is hydrated from this stream
        // and nowhere else (spec `room-canvas` §9.2), so dropping the whole
        // frame would leave a cold reader looking at an empty table. Each
        // document comes through as the `canvas` frame a resume would have sent:
        // no `change`, because nothing just happened — these are the rows that
        // were already there.
        if (frame.event === 'snapshot') {
          // **Only the canvas is parsed, not the whole snapshot.** The rest of
          // that frame is thrown away here, and validating what you discard buys
          // nothing while costing something real: a roster field this adapter
          // never reads, drifting or arriving from an older server, would fail
          // the parse and take the canvas down with it.
          const snapshot = SNAPSHOT_CANVAS.safeParse(frame.data);
          if (!snapshot.success) {
            console.warn('[Transport] dropping a room snapshot’s malformed canvas', {
              roomId,
              issues: snapshot.error.issues,
            });
            continue;
          }
          for (const document of snapshot.data.canvas ?? []) {
            yield { type: 'canvas', documentId: document.id, document };
          }
          continue;
        }
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
