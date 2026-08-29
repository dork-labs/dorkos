/**
 * The rooms slice of the {@link Transport} port — channels, direct messages and
 * threads (spec `rooms`, ADR 260726-170125).
 *
 * Split out of `transport.ts` rather than declared inline: the HTTP adapter,
 * the Obsidian stubs and the mock Transport already keep rooms in a module of
 * their own, and the port is the one place that had them mixed in with fifteen
 * other domains. `Transport` extends this, so nothing consuming the port sees
 * a difference.
 *
 * @module shared/transport-rooms
 */
import type { UploadProgress } from './schemas.js';
import type { UploadFile } from './transport.js';
import type { RoomFileContentResponse, RoomFileListResponse } from './room-files.js';
import type { RoomRepoStatus } from './room-repo.js';
import type {
  AuthorRef,
  AddRoomMemberRequest,
  CreateRoomRequest,
  HaltRoomResponse,
  PromoteHoldResponse,
  ListRoomEntriesQuery,
  ListRoomsQuery,
  ListThreadsQuery,
  PostThreadReplyRequest,
  PostToRoomRequest,
  PostToRoomResponse,
  RoomAttachment,
  RoomEntry,
  RoomEvent,
  RoomMember,
  RoomRosterEntry,
  RoomSessionsResponse,
  RoomSummary,
  RoomWithRoster,
  ThreadSummary,
  ToggleReactionRequest,
  ToggleReactionResponse,
  UpdateMembershipRequest,
  UpdateRoomRequest,
} from './room-schemas.js';

/** Everything the cockpit does to a room. */
export interface RoomTransport {
  /**
   * List the rooms this caller may see, newest activity first.
   *
   * Each summary carries `unreadCount`, which is `null` when the caller is not
   * a member — not-applicable rather than zero. Do not coerce the two: `0`
   * means "you are in this room and caught up".
   *
   * A direct message also carries `participants`, so a reader can draw the
   * agent it is with without a second call; anything else carries `null`.
   *
   * @param query - Optional `kind` / `includeArchived` filters.
   */
  listRooms(query?: ListRoomsQuery): Promise<RoomSummary[]>;
  /**
   * List every thread this caller takes part in, across every room, newest
   * activity first.
   *
   * Participation selects a thread and the room's roster permits it — the caller
   * wrote the root or wrote a reply, AND is on that room's roster today. There
   * is no follow list to consult and nothing is stored, so this is derived on
   * every read. A room the caller has been removed from contributes no threads
   * at all, so every summary here names a room they are currently in.
   *
   * `unreadCount` is measured against that room's one read cursor, which is why
   * opening a room clears its threads' counts along with the room's own badge.
   * Unlike `RoomSummary.unreadCount` it is never `null`: that field carries a
   * non-member case this one cannot have.
   *
   * @param query - Optional `limit`.
   */
  listThreads(query?: ListThreadsQuery): Promise<ThreadSummary[]>;
  /**
   * Create a channel or a DM. The caller joins it automatically.
   *
   * @param req - The room to create. A channel derives its slug from the title
   *   unless one is given; a DM must carry a title.
   */
  createRoom(req: CreateRoomRequest): Promise<RoomWithRoster>;
  /**
   * Fetch one room with its roster.
   *
   * @param id - The room id. Rejects when the room does not exist or the caller
   *   may not see it — the two are deliberately indistinguishable.
   */
  getRoom(id: string): Promise<RoomWithRoster>;
  /**
   * Patch a room's title, topic or archived flag.
   *
   * Renaming a channel moves its `#slug` with the title — a channel's name IS
   * its slug — so this can be refused when another live channel already holds
   * the name the new title slugs to.
   *
   * Archiving is reversible: pass `{ archived: false }` to bring a room back.
   * That can be refused on the same grounds, because a slug is only reserved
   * while the channel holding it is live.
   *
   * @param id - The room id.
   * @param req - The fields to change; anything omitted is left alone.
   */
  updateRoom(id: string, req: UpdateRoomRequest): Promise<RoomWithRoster>;
  /**
   * Read a page of a room's history, oldest-first within the page.
   *
   * @param id - The room id.
   * @param query - `before` (exclusive `seq` upper bound) and `limit`.
   */
  listRoomEntries(id: string, query?: ListRoomEntriesQuery): Promise<RoomEntry[]>;
  /**
   * List one directory of a room's own files (spec `project-rooms` §3.9).
   *
   * Answers from the commit `main` points at, never the checkout on disk, so a
   * half-written edit is not something a reader can see and `.git` is not a
   * path anybody can name. Every entry carries the last commit that touched it,
   * or `null` when nothing in the searched window did.
   *
   * Gated exactly as reading the room's history is: a caller who is not on the
   * roster is refused as if the room did not exist. A room that has no files of
   * its own is refused separately, with `ROOM_HAS_NO_REPO` — a surface that
   * offers files only to rooms that have them reads that code and shows nothing.
   *
   * @param id - The room id.
   * @param path - The directory, relative to the repo root; omitted means the root.
   */
  readRoomFiles(id: string, path?: string): Promise<RoomFileListResponse>;
  /**
   * Read one file out of a room's `main`.
   *
   * Three honest answers rather than one plus two errors: the text, `binary`
   * for a file whose bytes are never decoded into a string, or `too-large`
   * against the install's ceiling. A directory, a symlink and a submodule are
   * each refused — a link is listed, never followed.
   *
   * Everything it returns is member-written: render it as untrusted text.
   *
   * @param id - The room id.
   * @param path - The file, relative to the repo root.
   */
  readRoomFileContent(id: string, path: string): Promise<RoomFileContentResponse>;
  /**
   * What a room's files hold right now (spec `project-rooms` §3.6).
   *
   * The room's own commit, and for every agent member how far its working copy
   * has run ahead of the room and how far behind, whether it has changes nobody
   * committed, and whether any of that adds up to work the room has not got.
   * The explorer's pending-work badges read exactly this.
   *
   * Gated like every other room read: a caller who is not on the roster is
   * refused as if the room did not exist. A room with no files of its own is
   * refused with `ROOM_HAS_NO_REPO`, which is the ordinary answer for most
   * rooms rather than a failure.
   *
   * It reports working-copy slugs, display names and author ids, never the
   * directory an agent lives at.
   *
   * @param id - The room id.
   */
  readRoomRepoStatus(id: string): Promise<RoomRepoStatus>;
  /**
   * Post to a room. Trigger-only, exactly as {@link postMessage} is: the 202
   * carries the new entry's identity, while the entry itself reaches every
   * reader — the poster included — over {@link subscribeRoom}. So a caller
   * inserts nothing of its own; it waits for the stream, which is also what
   * every agent reply the post triggers arrives on.
   *
   * The author is resolved from the caller server-side and is never part of the
   * request. Rejects when the room is archived.
   *
   * @param id - The room id.
   * @param req - What to say, and the session that produced it when one did.
   */
  postToRoom(id: string, req: PostToRoomRequest): Promise<PostToRoomResponse>;
  /**
   * Upload files into a room, before the message that carries them.
   *
   * Separate from {@link postToRoom} rather than a field on it for the reason
   * the multipart body forces and the access model confirms: bytes and JSON are
   * different requests, and the attachment exists — refusable, retryable, its
   * own progress — before there is an entry to hang it on.
   *
   * The ids come back in request order; the post that follows names them in
   * `attachmentIds`, which is the order they render in.
   *
   * @param id - The room to upload into. The caller must be a person and a
   *   member of it; an agent is refused before its bytes are read.
   * @param files - The files to upload, in the order they should render.
   * @param onProgress - Called as the request body goes out.
   * @param signal - Aborts the request itself, not just this promise.
   */
  uploadRoomAttachments(
    id: string,
    files: UploadFile[],
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal
  ): Promise<RoomAttachment[]>;
  /**
   * Reply inside the thread hanging off one entry in this room.
   *
   * Separate from {@link postToRoom} rather than an optional field on it,
   * mirroring the routes: writing into a thread is a deliberate act with a
   * required target, never an omitted parameter. Trigger-only in exactly the
   * same way — the 202 carries the reply's identity, the reply itself arrives
   * over {@link subscribeRoom}, and it triggers agents through the same
   * addressing, budget and cascade rules an ordinary post does.
   *
   * **`rootEntryId` must be an entry that heads a thread, never a reply.** The
   * server refuses a reply to a reply (`NESTED_THREAD`, 400), so a caller
   * offering this on an arbitrary entry resolves the root itself — one level is
   * what the timeline already draws, so retargeting is what the reader already
   * sees, and a refusal here would be an error message about our own UI.
   *
   * @param id - The room the target entry lives in.
   * @param req - The entry to hang the reply off, and what to say.
   */
  replyInThread(id: string, req: PostThreadReplyRequest): Promise<PostToRoomResponse>;
  /**
   * Stop every agent turn running in this room.
   *
   * **A control action, never a message.** It interrupts the turns and writes
   * one `halted` notice everyone in the room can see; it is not inferred from
   * anything anybody typed, and a person who sends the word "stop" as a message
   * has simply sent a message.
   *
   * Unlike every other write here it is allowed on an ARCHIVED room: archiving
   * stops a room gaining messages, and a turn that was already running when it
   * was archived is still running.
   *
   * @param id - The room to stop.
   * @returns How many in-flight turns were interrupted; `0` when it was idle.
   */
  haltRoom(id: string): Promise<HaltRoomResponse>;
  /**
   * Stop ONE agent's turn in this room, and leave the others working.
   *
   * The same verb as {@link RoomTransport.haltRoom} with a scope, not a
   * different one: it interrupts that agent's turn here, throws away the answer
   * if the turn streams one anyway, drops the messages it had not read yet in
   * this room, and writes one `halted` notice naming who stopped whom. Every
   * other agent in the room carries on.
   *
   * A separate call rather than an optional field on the room-wide stop,
   * because an omitted target would stop everything.
   *
   * @param id - The room the agent is working in.
   * @param authorId - The agent to stop.
   * @returns `1` when a turn was interrupted, `0` when that agent was not
   *   running one here. `0` is a success.
   */
  haltRoomAgent(id: string, authorId: string): Promise<HaltRoomResponse>;
  /**
   * Ask for this room's waiting message to be answered before the other rooms
   * waiting on the same agent.
   *
   * **It reorders and never preempts.** The turn that is in the way is not
   * touched, nothing is interrupted, and the promoted message still waits for
   * the agent to be free — a room that gets passed over is next after that. Like
   * {@link RoomTransport.haltRoom} it is a control action a person presses, and
   * only a person may call it.
   *
   * @param id - The room asking to be answered first.
   * @param authorId - The agent it is waiting on.
   * @returns Whether there was a waiting message to move to the front. `false`
   *   is a normal answer: the wait had already ended.
   */
  promoteHold(id: string, authorId: string): Promise<PromoteHoldResponse>;
  /**
   * Where each agent's work in this room actually runs.
   *
   * One `authorId → sessionId` pair per agent that has answered here, and
   * nothing else — see {@link RoomSessionsResponse} for why the narrowness is
   * the point. It is what turns "Meeting Notes is working on it" into a link you
   * can follow.
   *
   * **Only a person may ask.** A room the caller cannot see answers 404, exactly
   * as reading the room does, and a caller resolved as an agent is refused: an
   * agent enumerating its room-mates' sessions is a capability this domain has
   * not granted.
   *
   * @param id - The room to ask about.
   */
  listRoomSessions(id: string): Promise<RoomSessionsResponse>;
  /**
   * Put one emoji on one entry, or take it back.
   *
   * Trigger-only in the same shape as {@link postToRoom}: the entry's new
   * reaction set reaches every reader — this one included — over
   * {@link subscribeRoom}, so **the stream is authoritative and this response is
   * not**. Somebody else may have reacted between the click and the answer, and
   * the frame carries the entry's whole set while this body only says what YOUR
   * click did. What it adds is the two things a caller cannot derive: which way
   * its own toggle went, and the reader's quick row recomputed with it counted.
   *
   * **Do not retry a bare toggle.** A timeout does not say whether the write
   * landed, and re-sending a flip undoes it. Send `{ on: true | false }`, which
   * names the state and is safe to repeat.
   *
   * @param id - The room the entry lives in.
   * @param entryId - The entry the emoji attaches to.
   * @param req - The emoji, and optionally the state to land in.
   */
  toggleReaction(
    id: string,
    entryId: string,
    req: ToggleReactionRequest
  ): Promise<ToggleReactionResponse>;
  /**
   * Add a member to a room, by author id or by agent directory.
   *
   * @param id - The room id.
   * @param req - Who to add, and optionally how they should behave in this room.
   */
  addRoomMember(id: string, req: AddRoomMemberRequest): Promise<RoomRosterEntry>;
  /**
   * Change one member's per-room response mode — this room's override of the
   * agent's manifest default, which decides when it replies without being
   * addressed.
   *
   * @param id - The room id.
   * @param authorId - The member being changed.
   * @param req - The new response mode.
   */
  updateRoomMember(
    id: string,
    authorId: string,
    req: UpdateMembershipRequest
  ): Promise<RoomRosterEntry>;
  /**
   * Remove a member from a room. Its per-room session binding goes with it, so
   * an agent added back afterwards starts a fresh session rather than resuming
   * the one it had. What it already said stays in the log.
   *
   * @param id - The room id.
   * @param authorId - The member being removed.
   */
  removeRoomMember(id: string, authorId: string): Promise<void>;
  /**
   * Set or clear what somebody types after an `@` to reach this author.
   *
   * **The only write path for a handle**, and deliberately the handles spec's
   * own route rather than a second one under the profile surface that edits it
   * (spec `handles` S6): nothing agent-reachable may write a handle, and an
   * invariant kept in one place is a test rather than a convention.
   *
   * Three refusals, and they are three different things for the person to do
   * about it, so a caller that collapses them into one message is throwing away
   * the answer: `HANDLE_TAKEN` (somebody else has it), `HANDLE_RESERVED` (a
   * handle they released, or a broadcast word like `everyone`) and
   * `INVALID_HANDLE` (the spelling itself is not addressable). Each arrives as
   * the `code` on the thrown error.
   *
   * @param authorId - Whose handle to set.
   * @param handle - The new handle, without the `@`. Empty clears it.
   */
  setAuthorHandle(authorId: string, handle: string): Promise<AuthorRef>;
  /**
   * Subscribe to a room's durable event stream (`GET /rooms/:id/events`).
   *
   * Modeled on {@link subscribeSession}: with `sinceCursor` the server replays
   * only entries above it, and without one the connect is cold — the server
   * leads with a `snapshot` frame, which this skips, because a room's roster and
   * history are already hydrated through {@link getRoom} and
   * {@link listRoomEntries}. Ephemeral `signal` events are delivered live and
   * never replayed.
   *
   * @param roomId - The room id.
   * @param sinceCursor - The highest `seq` already held, to resume from.
   * @param signal - Aborts the subscription and closes the connection.
   */
  subscribeRoom(
    roomId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<RoomEvent>;
}
