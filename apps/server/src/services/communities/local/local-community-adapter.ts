/**
 * This machine's own SQLite rooms, behind the `CommunityAdapter` port — the
 * first of the three backends (spec `community-adapter`, D5's order).
 *
 * It is a **wrapper, not a rewrite**. Every rule a room has still lives in
 * `services/rooms/`: the service owns visibility, the one-level thread ceiling,
 * the operator-only roster gates, mention resolution, the cascade guard and the
 * turn budget, and this file owns none of them. What it adds is the port's own
 * three obligations, which the shipped model expresses differently:
 *
 * 1. **An opaque, self-identifying cursor** in place of a bare per-room `seq`
 *    (`local-cursor.ts`).
 * 2. **A `(community, roomId)` address** on everything it emits, where the
 *    `rooms` table has no community column at all.
 * 3. **A typed refusal** for every capability this backend does not have, rather
 *    than a method that quietly does nothing.
 *
 * ## What it declares, and the evidence for each flag
 *
 * | Flag | Value | Why that is true here |
 * | --- | --- | --- |
 * | `roomList` | `'push'` | `RoomService` broadcasts `room_created` / `room_updated` on `eventFanOut`, and this adapter observes them in-process. No polling. |
 * | `roomAddressing` | `'slug'` | `rooms_channel_slug_unique` — `#general` is unique among live channels, and archiving frees the name. |
 * | `canPost` | `true` | `RoomService.post`. |
 * | `roomAdmin` | `true` | `createRoom` / `updateRoom` / `addMember` / `removeMember` all exist and all answer to the owner. |
 * | `roles` | unsupported | There is no role column and no second person to rank. Honest today under ADR `260727-184933` D6, and honest for as long as an install has one operator. |
 * | `admission` | `'open'` | You are never not-admitted to your own machine. |
 * | `invite` | `'none'` | There is no invite primitive locally; it arrives with the community server. |
 * | `agentAdmission` | `'none'` | Agent admission means minting an agent's identity in somebody else's community. Locally an agent is already an author. |
 * | `readCursor` | `'server'` | A read cursor is a server-visible integer here — `read_cursors` for a person, `room_members.last_read_seq` for an agent — and `RoomStore.countUnread` computes a real unread count from it. |
 * | `responseMode` | `true` | `room_members.response_mode` is the per-room addressing override. |
 * | `threadDepth` | `1` | `RoomService.post` refuses a reply whose parent is already a reply (`NESTED_THREAD`). |
 * | `signals` | `'both'` | The room signal channel now carries a presence payload, which is what `'both'` means. See below. |
 * | `credential` | `'none'` | Nothing to hold: this is the machine the store is on. |
 *
 * **`signals` flipped from `'none'` to `'both'`, ten commits after it needed
 * to.** This adapter was written declaring `'none'` because, on the tree it was
 * written against, `RoomSignalEventSchema` carried no structured payload, and
 * Amendment 2 of the port's spec makes round-tripping one part of what `'both'`
 * means — so an adapter emitting a signal that could not say who was working, on
 * what, or since when would have been declaring a capability the conformance
 * suite is right to fail. That argument stands, and it is why waiting was the
 * right call rather than a timid one. **The history is worth
 * getting right, because it is not "the envelope landed later":** `364d3a88e`
 * (#623) widened the envelope with `state`, `entryId` and `since`, and
 * `25aa7af15` (#624) — the commit that first shipped this file, `'none'` and all
 * — is its direct descendant. #624 was branched before #623 merged, so `'none'`
 * was honest **when it was written** and already stale when it landed. Nothing
 * blocked the flip for the ten commits since; nobody had looked.
 *
 * Both directions are real now:
 * `publishSignal` publishes through `RoomService`, and
 * {@link LocalCommunityAdapter.subscribeRoom} maps every `signal` frame the room
 * broadcaster carries onto the port's stream instead of dropping it. C15 proves
 * the round trip through a real room, and
 * `__tests__/local-community-adapter.test.ts` pins the half a shared suite
 * structurally cannot reach: a signal published by the room's OWN producers —
 * the trigger dispatcher, not this adapter — reaches a port subscriber.
 *
 * ## The `'not-admitted'` invalidation is vacuous here, and that is a statement
 *
 * The port makes a `'not-admitted'` connection normative: it invalidates that
 * community's cached rooms, and (Amendment 1 §B) deletes that community's
 * message-index rows in the SAME transaction as the cache drop. **This adapter
 * can never reach that status**, and it holds no cache to drop:
 *
 * - `admission: 'open'` and `credential: 'none'` — there is no operator but you,
 *   and nothing to be admitted by. `connect` has exactly two outcomes,
 *   `'connected'` and `'unreachable'` (the store did not answer).
 * - The `rooms` table has no `communityRef` column yet, so no row here belongs
 *   to a community other than this one. There is no remote cache in existence to
 *   invalidate.
 *
 * So the rule is not skipped, it is unreachable — and it stays the obligation of
 * the first adapter that CAN be refused admission, which is also the first one to
 * cache somebody else's rooms. That ticket owns both halves at once, and it must:
 * dropping cached rooms without deleting their index rows in the same
 * transaction leaves search serving message bodies from a community that ejected
 * you, which is the one place the "cache is never the access boundary" guarantee
 * has nothing to re-check against.
 *
 * @module server/services/communities/local/local-community-adapter
 */
import {
  CommunityMemberNotFoundError,
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  LOCAL_COMMUNITY,
  type AddCommunityMemberOpts,
  type CommunityAdapter,
  type CommunityCapabilities,
  type CommunityConnection,
  type CommunityCursor,
  type CommunityEntry,
  type CommunityEntryPage,
  type CommunityEntryRef,
  type CommunityInvite,
  type CommunityMember,
  type CommunityPresencePayload,
  type CommunityRef,
  type CommunityRoom,
  type CommunityRoomClosedReason,
  type CommunityRoomEvent,
  type CommunityRoomListEvent,
  type CreateCommunityRoomInput,
  type ListCommunityEntriesOpts,
  type PostCommunityEntryInput,
  type UpdateCommunityRoomInput,
} from '@dorkos/shared/community-adapter';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { SignalType } from '@dorkos/shared/relay-schemas';
import type { Room, RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { ROOMS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { RoomError } from '../../rooms/room-errors.js';
import { PushStream } from '../push-stream.js';
import type { RoomService } from '../../rooms/room-service.js';
import type { RoomStore } from '../../rooms/room-store.js';
import { mintLocalCursor, readLocalCursor } from './local-cursor.js';
import {
  toCommunityEntry,
  toCommunityMember,
  toCommunityRoom,
  toCommunitySignal,
  toRoomPresence,
} from './local-projection.js';

/** Page size when a caller does not ask for one. Matches the port's own default shape. */
const DEFAULT_PAGE_SIZE = 50;

/** What this backend declares. Every value is argued in this module's doc. */
const LOCAL_CAPABILITIES: CommunityCapabilities = {
  type: 'local',
  roomList: 'push',
  roomAddressing: 'slug',
  canPost: true,
  roomAdmin: true,
  roles: { supported: false, values: [] },
  admission: 'open',
  invite: 'none',
  agentAdmission: 'none',
  readCursor: 'server',
  responseMode: true,
  threadDepth: 1,
  signals: 'both',
  credential: 'none',
  features: {},
};

/** Everything {@link LocalCommunityAdapter} is constructed from. */
export interface LocalCommunityAdapterDeps {
  /** The wired room service — every rule a room has still lives behind this. */
  service: RoomService;
  /** The room store, for the three reads the service does not expose. */
  store: RoomStore;
  /**
   * Resolve the connected identity's author id — the person who owns this
   * install.
   *
   * Injected rather than read here for the reason `RoomService.isOwnerAuthor` is
   * injected: whether an account exists is not a room's business to know, and an
   * install becomes owned partway through its life. Resolved per call, never
   * captured, so enabling login binds the very next call rather than the next
   * server start.
   */
  resolveIdentity: () => string;
}

/** One live room subscription, and the handle that tears its producer down. */
interface RoomSubscription {
  stream: PushStream<CommunityRoomEvent>;
  controller: AbortController;
}

/**
 * The local rooms backend as a {@link CommunityAdapter}.
 *
 * @example
 * ```typescript
 * const adapter = new LocalCommunityAdapter({ service, store, resolveIdentity });
 * await adapter.connect();
 * const rooms = await adapter.listRooms();
 * ```
 */
export class LocalCommunityAdapter implements CommunityAdapter {
  readonly type = LOCAL_CAPABILITIES.type;
  readonly community: CommunityRef = LOCAL_COMMUNITY;

  private readonly listStreams = new Set<PushStream<CommunityRoomListEvent>>();
  private readonly roomStreams = new Map<string, Set<RoomSubscription>>();
  private unsubscribeLifecycle: (() => void) | null = null;

  /**
   * Wire the adapter over an already-built rooms subsystem.
   *
   * @param deps - The room service, the store, and how to resolve the operator.
   */
  constructor(private readonly deps: LocalCommunityAdapterDeps) {}

  getCapabilities(): CommunityCapabilities {
    // Copied deeply enough that a consumer cannot mutate the declaration.
    return {
      ...LOCAL_CAPABILITIES,
      roles: { ...LOCAL_CAPABILITIES.roles, values: [...LOCAL_CAPABILITIES.roles.values] },
      features: { ...LOCAL_CAPABILITIES.features },
    };
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Report who this machine's rooms belong to.
   *
   * There is no connection to establish and no credential to present — the
   * store is on the same disk as the process reading it. What this can still
   * fail at is answering: a store that cannot be read (a closed handle, a
   * corrupt file) is reported as `'unreachable'` rather than thrown, so a
   * broken local store degrades one community's listing to a warning instead of
   * failing every community's.
   *
   * There is no `signal` parameter because there is nothing to abort: the
   * resolution is one indexed SELECT, synchronously.
   */
  connect(): Promise<CommunityConnection> {
    try {
      const memberId = this.deps.resolveIdentity();
      return Promise.resolve({
        status: 'connected',
        identity: { community: this.community, memberId },
      });
    } catch (err) {
      return Promise.resolve({
        status: 'unreachable',
        error: `this machine's room store did not answer: ${errorMessage(err)}`,
      });
    }
  }

  /** Close every open stream. Idempotent, including on a never-connected adapter. */
  disconnect(): Promise<void> {
    for (const subscriptions of [...this.roomStreams.values()]) {
      for (const subscription of [...subscriptions]) subscription.stream.end();
    }
    this.roomStreams.clear();
    for (const stream of [...this.listStreams]) stream.end();
    this.listStreams.clear();
    this.releaseLifecycle();
    return Promise.resolve();
  }

  // --- Rooms ---------------------------------------------------------------

  // ONE RULE FOR THE WHOLE CLASS, and it is load-bearing rather than stylistic:
  // every method that calls into the room service is `async`. The service is
  // synchronous and refuses by throwing, while this port is promise-returning —
  // so a method that let a `RoomError` escape synchronously would throw at a
  // caller holding a `.catch()`, which is how C11 failed before this rule
  // existed. `async` turns each of those refusals into the rejection the port
  // promises.
  //
  // Three groups sit outside it, none by accident. `connect` and `disconnect`
  // above return a settled promise directly: `connect` already catches, and
  // `disconnect` only walks maps this class owns. The four capability refusals
  // below return `Promise.reject` because they call nothing that can throw —
  // they ARE the throw. And `subscribeRoom` is the deliberate exception in the
  // other direction: its unknown-room and stale-cursor throws MUST both be
  // synchronous, so it cannot be `async` at all.

  async listRooms(): Promise<CommunityRoom[]> {
    // Archived rooms are listed, not hidden: `archived` is a state the port
    // carries on the room, and an archived room still reads. A consumer that
    // wants only live rooms filters on the flag it was given.
    const rooms = this.deps.service.listRooms(this.identity(), { includeArchived: true });
    return rooms.map((room) => toCommunityRoom(this.community, room, room.unreadCount));
  }

  async getRoom(roomId: string): Promise<CommunityRoom | null> {
    const room = this.deps.service.getRoom(roomId, this.identity());
    return room ? this.projectRoom(room) : null;
  }

  subscribeRoomList(signal?: AbortSignal): AsyncIterable<CommunityRoomListEvent> {
    const stream = new PushStream<CommunityRoomListEvent>(() => {
      this.listStreams.delete(stream);
      this.releaseLifecycle();
    });
    this.listStreams.add(stream);
    this.holdLifecycle();
    bindAbort(signal, stream);
    return stream;
  }

  async createRoom(input: CreateCommunityRoomInput): Promise<CommunityRoom> {
    const room = this.deps.service.createRoom(
      {
        kind: input.kind ?? 'channel',
        title: input.title,
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        members: [],
        agentPaths: [],
      },
      this.identity()
    );
    return this.projectRoom(room);
  }

  async updateRoom(roomId: string, patch: UpdateCommunityRoomInput): Promise<CommunityRoom> {
    const room = this.deps.service.updateRoom(roomId, this.identity(), patch);
    return this.projectRoom(room);
  }

  // --- Entries -------------------------------------------------------------

  /**
   * The durable stream for one room: snapshot → gap-free replay → live.
   *
   * Ordered exactly as `room-events-handler.ts` orders it, and for the same
   * reason: **subscribe first, synchronously, then read the log.** Anything
   * committed between the two lands in this reader's queue rather than falling
   * between them, and the `seq` watermark drops whatever the read already
   * covered. The store is synchronous, so both halves happen in one tick and
   * there is no window at all.
   *
   * Both refusals run before any of that, so `CommunityRoomNotFoundError` (a
   * room this identity cannot stream, absent or invisible alike) and
   * `StaleCommunityCursorError` are thrown at call time as the port requires —
   * which is also why this is a plain method returning a stream rather than an
   * `async function*`.
   *
   * **The snapshot carries thread replies; `listEntries` does not.** Both are
   * port-legal and the difference is deliberate: a page is a timeline (the port
   * defines the default read as top-level only, with `thread` to descend), while
   * a stream is a resume and must replay everything committed after the cursor
   * or it has a gap. Conformance U9 accounts for exactly this by building its
   * known-id set from the top level plus every thread.
   *
   * A room that is archived while a reader is subscribed ends with a terminal
   * `room_closed: 'archived'`: an archived room refuses every further write, so
   * the subscription has nothing left to deliver and says so instead of going
   * quiet. Un-archiving is what re-opens it, by subscribing again.
   *
   * **Nothing fallible runs after registration.** Everything that can throw —
   * the visibility read, the cursor, the live subscription, the log read and the
   * snapshot projection — happens first, and a failure part-way through aborts
   * the controller so the broadcaster subscriber it may already have opened is
   * released. Registering earlier would mean a throw left this adapter holding a
   * room subscription and a global fan-out listener that no caller could ever
   * end, because no stream was returned to end.
   *
   * @param roomId - The room to stream.
   * @param sinceCursor - Resume point; emit only what follows it.
   * @param signal - Aborts the stream so a parked consumer terminates promptly.
   */
  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal
  ): AsyncIterable<CommunityRoomEvent> {
    const identity = this.identity();
    const room = this.deps.service.getRoom(roomId, identity);
    // The port's own refusal, not a local one, and the SAME refusal for "no
    // such room" and "not visible to you" — `getRoom` collapsed them one line
    // above, exactly as `requireVisibleRoom` does, and
    // `CommunityRoomNotFoundError` carries no reason field to un-collapse them
    // with. Distinguishing the two would let a caller holding a room id confirm
    // that somebody else's DM exists.
    if (!room) throw new CommunityRoomNotFoundError(this.community, roomId);
    const highestSeq = this.deps.service.maxSeq(roomId);
    const from =
      sinceCursor === undefined
        ? null
        : readLocalCursor(this.community, roomId, sinceCursor, highestSeq);

    const controller = new AbortController();
    let live: AsyncIterator<RoomEvent>;
    let snapshot: CommunityRoomEvent;
    let watermark: number;
    try {
      live = this.deps.service.stream.subscribe(roomId, controller.signal)[Symbol.asyncIterator]();
      const history =
        from === null
          ? this.deps.store.listEntries(roomId, { limit: ROOMS.SNAPSHOT_HISTORY_LIMIT })
          : this.deps.store.listEntriesAfter(roomId, from);
      watermark = history.at(-1)?.seq ?? from ?? highestSeq;
      snapshot = {
        type: 'snapshot',
        room: this.projectRoom(room),
        entries: this.decorate(roomId, history),
        cursor: mintLocalCursor(this.community, roomId, watermark),
      };
    } catch (err) {
      // Releases the broadcaster subscriber, which is registered synchronously
      // by `subscribe` and would otherwise outlive this failed call.
      controller.abort();
      throw err;
    }

    const stream = new PushStream<CommunityRoomEvent>(() => {
      this.dropRoomSubscription(roomId, stream);
      controller.abort();
      this.releaseLifecycle();
    });
    const subscription: RoomSubscription = { stream, controller };
    this.addRoomSubscription(roomId, subscription);
    this.holdLifecycle();

    stream.push(snapshot);
    bindAbort(signal, stream);
    void this.pump(roomId, subscription, live, watermark);
    return stream;
  }

  /**
   * A page of history, oldest-first.
   *
   * **Top-level only unless `opts.thread` names a root** — the port's own
   * default, and the opposite of what {@link LocalCommunityAdapter.subscribeRoom}'s
   * snapshot carries. A page is a timeline; a stream is a resume and must replay
   * every entry after the cursor, replies included, or it has a gap. The
   * difference is port-legal and conformance U9 is written around it.
   *
   * @param roomId - The room to read.
   * @param opts - Cursor, page size, and the thread filter.
   */
  async listEntries(
    roomId: string,
    opts: ListCommunityEntriesOpts = {}
  ): Promise<CommunityEntryPage> {
    const identity = this.identity();
    if (!this.deps.service.getRoom(roomId, identity)) return { entries: [], nextCursor: null };
    const afterSeq =
      opts.cursor === undefined
        ? 0
        : readLocalCursor(this.community, roomId, opts.cursor, this.deps.service.maxSeq(roomId));
    const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
    // One row more than the page needs. Exhaustion is DECLARED by a null cursor,
    // and the only way to declare it honestly is to know whether a further row
    // exists — a short page proves nothing.
    const rows = this.deps.store.listEntriesFrom(roomId, {
      afterSeq,
      limit: limit + 1,
      ...(opts.thread === undefined ? {} : { threadRootEntryId: opts.thread }),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: this.decorate(roomId, page),
      nextCursor:
        rows.length > limit && last ? mintLocalCursor(this.community, roomId, last.seq) : null,
    };
  }

  /**
   * Commit an entry as the connected identity.
   *
   * `input.mentions` is deliberately NOT merged: this backend resolves mentions
   * from the text itself at write time, against the room's own roster
   * (`resolveMentions`), which is strictly stronger than trusting a list a
   * caller assembled. Honouring both would let a caller address someone the
   * message does not name.
   *
   * @param roomId - The room to post into.
   * @param input - What to say, and what it replies to.
   */
  async post(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntryRef> {
    const entry = this.deps.service.post(roomId, {
      authorId: this.identity(),
      text: input.text,
      ...(input.parentEntryId === undefined ? {} : { replyTo: input.parentEntryId }),
    });
    return {
      community: this.community,
      roomId,
      entryId: entry.id,
      cursor: mintLocalCursor(this.community, roomId, entry.seq),
    };
  }

  // --- Roster --------------------------------------------------------------

  async listMembers(roomId: string): Promise<CommunityMember[]> {
    const room = this.deps.service.getRoom(roomId, this.identity());
    return (room?.members ?? []).map((member) => toCommunityMember(this.community, member));
  }

  /**
   * Add an existing author to a room.
   *
   * `opts.role` is not applicable here and is ignored: this backend declares
   * `roles.supported: false`, so there is no declared role to assign and nothing
   * that would read one.
   *
   * @param roomId - The room to add them to.
   * @param memberId - The author id to add.
   * @param opts - Per-room addressing override; `role` has no meaning here.
   */
  async addMember(
    roomId: string,
    memberId: string,
    opts: AddCommunityMemberOpts = {}
  ): Promise<CommunityMember> {
    const member = this.deps.service.addMember(roomId, this.identity(), {
      authorId: memberId,
      ...(opts.responseMode === undefined ? {} : { responseMode: opts.responseMode }),
    });
    return toCommunityMember(this.community, member);
  }

  /**
   * Remove a member from a room. Idempotent, as the port requires: the shipped
   * service reports "not a member" as a typed refusal, and removing somebody who
   * is already gone is the outcome the caller asked for.
   *
   * @param roomId - The room to remove them from.
   * @param memberId - The author id to remove.
   */
  async removeMember(roomId: string, memberId: string): Promise<void> {
    try {
      this.deps.service.removeMember(roomId, this.identity(), memberId);
    } catch (err) {
      if (!(err instanceof RoomError) || err.code !== 'MEMBER_NOT_FOUND') throw err;
    }
  }

  /**
   * Set a membership's per-room addressing override.
   *
   * The service's own `MEMBER_NOT_FOUND` is translated into the port's
   * {@link CommunityMemberNotFoundError} rather than escaping as a `RoomError`:
   * `RoomError` is not exported from `@dorkos/shared`, so a consumer outside this
   * process could only ever duck-type its `.code`. Every other `RoomError` is
   * left alone — a refusal this port has no vocabulary for must not be dressed up
   * as one it does.
   *
   * @param roomId - The room the override applies to.
   * @param memberId - Whose membership to change.
   * @param mode - The addressing mode.
   */
  async setResponseMode(
    roomId: string,
    memberId: string,
    mode: ResponseMode
  ): Promise<CommunityMember> {
    try {
      const member = this.deps.service.updateMembership(roomId, this.identity(), memberId, mode);
      return toCommunityMember(this.community, member);
    } catch (err) {
      if (err instanceof RoomError && err.code === 'MEMBER_NOT_FOUND') {
        throw new CommunityMemberNotFoundError(this.community, memberId);
      }
      throw err;
    }
  }

  // --- Agent admission -----------------------------------------------------

  /**
   * Refused: `agentAdmission: 'none'`.
   *
   * Admitting an agent means minting its identity in a community that is not its
   * owner's machine. Here an agent is already an author the moment it posts, so
   * there is nothing to vouch for and nobody to vouch to.
   *
   * @param _input - Ignored; this backend admits no agents.
   */
  admitAgent(): Promise<CommunityMember> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'agentAdmission', 'admitAgent')
    );
  }

  /** Refused: `agentAdmission: 'none'`. See {@link LocalCommunityAdapter.admitAgent}. */
  revokeAgent(): Promise<void> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'agentAdmission', 'revokeAgent')
    );
  }

  // --- Read cursor ---------------------------------------------------------

  /**
   * The connected identity's own read cursor, or `null` when it has not read
   * anything here.
   *
   * **Read through `RoomService`, which is what makes this the same cursor the
   * cockpit draws** (team-room-home spec §D4). A person's place in a room lives
   * in `read_cursors` and an agent's on the membership row; which one answers
   * for the connected identity is that domain's rule, and asking the membership
   * column directly is how this seam would quietly start reporting a number
   * nothing else in the product agrees with.
   *
   * @param roomId - The room whose cursor to read.
   */
  async getReadCursor(roomId: string): Promise<CommunityCursor | null> {
    const seq = this.deps.service.readCursorFor(roomId, this.identity());
    if (seq === null || seq === 0) return null;
    return mintLocalCursor(this.community, roomId, seq);
  }

  /**
   * Advance the connected identity's read cursor.
   *
   * **Monotonic**, which is the shipped semantic and not a detail of this
   * wrapper: a cursor behind the stored one is ignored, so a stale client
   * cannot un-read a room for a second client reading as the same person.
   *
   * One write path with the cockpit's, through `RoomService` — so a cursor
   * moved here broadcasts `read_cursor` exactly as one moved in a room does,
   * and a community backend cannot become a way to change read state silently.
   *
   * @param roomId - The room whose cursor to set.
   * @param cursor - Where this identity has read to.
   */
  async setReadCursor(roomId: string, cursor: CommunityCursor): Promise<void> {
    const seq = readLocalCursor(this.community, roomId, cursor, this.deps.service.maxSeq(roomId));
    this.deps.service.setReadCursor(roomId, this.identity(), seq);
  }

  // --- Invites -------------------------------------------------------------

  /**
   * Refused: `invite: 'none'`. There is nobody to invite to your own machine,
   * and no token to redeem. The invite primitive arrives with the community
   * server, which is where the consent it expresses first means something.
   */
  createInvite(): Promise<CommunityInvite> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'invite', 'createInvite'));
  }

  // --- Ephemeral -----------------------------------------------------------

  /**
   * Publish an ephemeral signal onto the room's own live channel.
   *
   * **The signal is attributed to `payload.memberId` when there is one**, not to
   * the connected identity, and it has to be: the presence this backend carries
   * is an AGENT working, while the connected identity is the person who
   * triggered it. Attributing it to the caller would name the wrong worker in
   * every case the feature exists for.
   *
   * **So the id is validated against the room's roster, and a stranger is
   * refused rather than published.** The port leaves `memberId` unvalidated on
   * purpose — it exists for backends whose identity model is foreign to ours,
   * where this adapter has nothing to check against. Ours is not one of those:
   * a `memberId` here IS a DorkOS author id in this install's own namespace, so
   * a value naming nobody in the room is a claim about a real person or agent
   * that this backend can see is false. It refuses loudly
   * ({@link CommunityMemberNotFoundError}, the port's own vocabulary and the same
   * refusal {@link LocalCommunityAdapter.setResponseMode} answers with for the
   * same mistake) and **never falls back to the connected
   * identity** — a silent fallback turns a caller's bad id into an indicator
   * saying the operator is working, which is misattribution dressed as
   * robustness. With no `memberId` at all, the emitter speaks for itself.
   *
   * **What this does NOT check, stated because the gap is real:** whether the
   * named member actually holds a claim. A room member can still publish
   * "working" about another member of the same room, and the shared suite says
   * outright that it cannot assert who may call this. Mechanical honesty lives
   * with the claim map, in `RoomTriggerDispatcher` — which makes this adapter a
   * SECOND producer of presence: roster-validated, but not claim-gated. That is
   * safe only while every caller is server-side code that already knows what it
   * started. **Claim-gating (or an explicit refusal here) must land before this
   * method is exposed on a route, on an MCP tool, or to any caller the server
   * did not write.**
   *
   * Nothing here is written. `RoomService.publishSignal` broadcasts and returns;
   * a signal never enters the log, so there is no persistence to opt out of.
   *
   * @param roomId - The room to signal in.
   * @param signal - Which signal.
   * @param payload - The presence lifecycle, on a `'progress'` signal.
   */
  publishSignal(
    roomId: string,
    signal: SignalType,
    payload?: CommunityPresencePayload
  ): Promise<void> {
    const identity = this.identity();
    const room = this.deps.service.getRoom(roomId, identity);
    if (!room) {
      // A room this identity cannot see must not become a room it can be heard
      // in — the same collapse `subscribeRoom` makes, for the same reason.
      return Promise.reject(new CommunityRoomNotFoundError(this.community, roomId));
    }
    const author = payload?.memberId ?? identity;
    if (author !== identity && !room.members.some((member) => member.authorId === author)) {
      return Promise.reject(new CommunityMemberNotFoundError(this.community, author));
    }
    this.deps.service.publishSignal(roomId, signal, author, payload && toRoomPresence(payload));
    return Promise.resolve();
  }

  // --- Internals -----------------------------------------------------------

  /** The connected identity, resolved per call so a change in ownership binds now. */
  private identity(): string {
    return this.deps.resolveIdentity();
  }

  /** Project a room, computing the unread count this identity is owed. */
  private projectRoom(room: Room): CommunityRoom {
    // The cursor comes from `RoomService` for the same reason `getReadCursor`
    // reads it there: which of the two cursors answers for this identity is the
    // room domain's rule, and a count measured against the other one would
    // disagree with the badge the cockpit draws for the same room.
    const cursor = this.deps.service.readCursorFor(room.id, this.identity());
    // `null` means "not a member here", never "nothing unread": a room the
    // operator can see but has not joined has no cursor to count against.
    const unread = cursor === null ? null : this.deps.store.countUnread(room.id, cursor);
    return toCommunityRoom(this.community, room, unread);
  }

  /**
   * Project a page of entries, attaching each thread root's rolled-up summary in
   * ONE query rather than one per row.
   */
  private decorate(roomId: string, entries: readonly RoomEntry[]): CommunityEntry[] {
    const summaries = this.deps.store.countThreadRepliesFor(
      roomId,
      entries.map((entry) => entry.id)
    );
    return entries.map((entry) => toCommunityEntry(this.community, entry, summaries.get(entry.id)));
  }

  /**
   * Forward committed entries and live signals onto one room's community stream.
   *
   * Signals are mapped rather than dropped — `signals: 'both'` claims both
   * directions, and the observing one is the direction that matters for
   * presence: the producer is the trigger dispatcher, never a port caller, so a
   * port subscriber that could only see what it published itself would see
   * nothing anyone cares about. Signals carry no `seq` and are never replayed,
   * so they bypass the watermark entirely instead of being ordered against it.
   *
   * Reactions are dropped, and that is not the same decision: they are DURABLE
   * state with no shape on this port at all, so forwarding one would mean
   * inventing a frame the port has not specified.
   *
   * The broadcaster ends a subscriber it has had to stall (its queue is bounded,
   * so a reader that stops pulling is ended rather than buffered without limit).
   * That is a room this stream can no longer serve, so it terminates with
   * `room_closed: 'unknown'` — honest, since the adapter genuinely cannot tell
   * that from any other internal end, and never a silent stop.
   */
  private async pump(
    roomId: string,
    subscription: RoomSubscription,
    live: AsyncIterator<RoomEvent>,
    watermark: number
  ): Promise<void> {
    const { stream, controller } = subscription;
    let highestSent = watermark;
    try {
      for (;;) {
        const next = await live.next();
        if (next.done || stream.closed) break;
        const event = next.value;
        if (event.type === 'signal') {
          stream.push(toCommunitySignal(event));
          continue;
        }
        if (event.type !== 'entry' || event.seq <= highestSent) continue;
        highestSent = event.seq;
        stream.push({ type: 'entry', entry: toCommunityEntry(this.community, event.entry) });
      }
    } catch (err) {
      logger.warn('[LocalCommunity] a room subscription ended on an error', {
        roomId,
        error: errorMessage(err),
      });
    } finally {
      if (!controller.signal.aborted && !stream.closed) {
        stream.push({ type: 'room_closed', reason: 'unknown' });
      }
      stream.end();
    }
  }

  /** Register one room subscription. */
  private addRoomSubscription(roomId: string, subscription: RoomSubscription): void {
    const existing = this.roomStreams.get(roomId);
    if (existing) existing.add(subscription);
    else this.roomStreams.set(roomId, new Set([subscription]));
  }

  /**
   * Drop one room subscription, and the room's bucket once it is empty.
   *
   * @param roomId - The room it was following.
   * @param stream - The stream whose consumer walked away.
   */
  private dropRoomSubscription(roomId: string, stream: PushStream<CommunityRoomEvent>): void {
    const subscriptions = this.roomStreams.get(roomId);
    if (!subscriptions) return;
    for (const subscription of subscriptions) {
      if (subscription.stream === stream) subscriptions.delete(subscription);
    }
    if (subscriptions.size === 0) this.roomStreams.delete(roomId);
  }

  /**
   * Start observing room lifecycle, if nothing is observing it yet.
   *
   * ONE listener serves every stream this adapter hands out, for the reason the
   * port states about polling: N subscribers must not become N observers.
   */
  private holdLifecycle(): void {
    if (this.unsubscribeLifecycle) return;
    this.unsubscribeLifecycle = eventFanOut.subscribe((eventName, data) => {
      this.onLifecycleEvent(eventName, data);
    });
  }

  /** Stop observing once nothing is listening, so an idle adapter holds nothing. */
  private releaseLifecycle(): void {
    if (this.listStreams.size > 0 || this.roomStreams.size > 0) return;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
  }

  /**
   * Translate one global room-lifecycle event into this community's vocabulary.
   *
   * The room is re-read from the store rather than reconstructed from the
   * payload: the broadcast carries only what a sidebar needed (id, title,
   * archived), while the port's `CommunityRoom` is the whole row. Re-reading is
   * one indexed SELECT in-process, and it is also the guard that keeps this
   * honest — a room this store does not hold is not this community's room, and
   * is ignored.
   */
  private onLifecycleEvent(eventName: string, data: unknown): void {
    if (eventName !== 'room_created' && eventName !== 'room_updated') return;
    const roomId = (data as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId !== 'string') return;
    const room = this.deps.store.getRoom(roomId);
    if (!room) return;

    // The room is projected ONCE and the same event object goes to every
    // subscriber — the fan-out's own aliasing hazard, one layer up, and stated
    // before there is a consumer to be surprised by it. **A room-list event is
    // read-only to whoever receives it:** a subscriber that mutated the room it
    // was handed would silently change what every other subscriber sees, and
    // there is nothing between them to notice. Projecting per subscriber would
    // remove the hazard and multiply four SQLite reads by the number of open
    // streams to do it, which is the trade this comment exists to make visible
    // rather than to quietly reverse.
    const projected = this.projectRoom(room);
    const event: CommunityRoomListEvent =
      eventName === 'room_created'
        ? { type: 'room_added', room: projected }
        : { type: 'room_updated', room: projected };
    for (const stream of [...this.listStreams]) stream.push(event);

    // An archived room accepts no further entry — not from a member and not in
    // the room's own voice — so every reader of it is holding a stream that can
    // never deliver again. Terminating it with the honest reason beats leaving a
    // subscription open forever on a conversation that has been put away.
    if (eventName === 'room_updated' && room.archived) this.closeRoom(roomId, 'archived');
  }

  /** End every subscription to one room with a terminal reason. */
  private closeRoom(roomId: string, reason: CommunityRoomClosedReason): void {
    for (const subscription of [...(this.roomStreams.get(roomId) ?? [])]) {
      subscription.stream.push({ type: 'room_closed', reason });
      subscription.stream.end();
    }
  }
}

/** End a stream when the caller's abort signal fires — or immediately, if it already has. */
function bindAbort(signal: AbortSignal | undefined, stream: { end: () => void }): void {
  if (!signal) return;
  if (signal.aborted) stream.end();
  else signal.addEventListener('abort', () => stream.end(), { once: true });
}

/** The message of a thrown value, whatever it turned out to be. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
