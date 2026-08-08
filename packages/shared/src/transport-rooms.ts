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
import type {
  AuthorRef,
  AddRoomMemberRequest,
  CreateRoomRequest,
  HaltRoomResponse,
  ListRoomEntriesQuery,
  ListRoomsQuery,
  ListThreadsQuery,
  PostThreadReplyRequest,
  PostToRoomRequest,
  PostToRoomResponse,
  RoomEntry,
  RoomEvent,
  RoomMember,
  RoomRosterEntry,
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
   * Advance the caller's read cursor in one room.
   *
   * Monotonic server-side — a lower value is ignored — so a second client that
   * is further behind can never un-read a room for the first. A person's write
   * lands in the same read state {@link Transport.setReadCursor} addresses and
   * broadcasts the same `read_cursor` event, so the two are one fact reached two
   * ways; an agent's stays on its membership row.
   *
   * @param id - The room id.
   * @param lastReadSeq - The `seq` the caller has read up to.
   */
  setRoomReadCursor(id: string, lastReadSeq: number): Promise<RoomMember>;
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
