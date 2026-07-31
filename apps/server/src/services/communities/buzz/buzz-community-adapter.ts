/**
 * A Buzz relay behind the `CommunityAdapter` port — **read-only**, and the
 * foreign case the port exists to survive.
 *
 * The local adapter (`../local/`) wraps a store this process owns. This one talks
 * to somebody else's server, over a different transport, with a different
 * identity model, a different room primitive, no sequence, and no write path. It
 * is here because an interface with one implementation is a fake abstraction: the
 * point is to find out, before `apps/community` sets the contract in concrete,
 * whether the port absorbs a genuinely foreign backend through capability flags —
 * or only by weakening something for everyone.
 *
 * It does. Nothing in the shared conformance suite was softened to let this pass;
 * every difference below is a declared flag, and every capability this backend
 * lacks is a typed refusal rather than a quiet no-op.
 *
 * ## What it declares, and the evidence for each flag
 *
 * | Flag | Value | Why that is true here |
 * | --- | --- | --- |
 * | `roomList` | `'poll'` | Channel-discovery events (kind 39000) are stored **channel-scoped**, so a live global subscription never receives them by fan-out (`subscription.rs:265-288`). There is no room-created push to have. |
 * | `roomAddressing` | `'opaque-id'` | A channel is a UUID with a freely-editable, non-unique `name` (`side_effects.rs:1398-1410`). There is no slug to promise. |
 * | `canPost` | `false` | Deliberate: this adapter reads. Posting is a signing path, a moderation surface and a consent question, and it earns its own ticket. |
 * | `roomAdmin` | `false` | Same. Creating and archiving channels are admin acts on somebody else's server. |
 * | `roles` | supported, five values | `Owner/Admin/Member/Guest/Bot` (`core/channel.rs:108-120`), read straight off the relay-signed roster. No `default`: this adapter admits nobody, so it has no role to give. |
 * | `admission` | `'out-of-band'` | **Declared down.** The library defaults to an open relay (`config.rs:483-485`), so a default-configured instance auto-admits any valid key — but every published deployment turns membership on (`deploy/compose/.env.example:17-18`, the Helm chart, the Justfile), and then joining is an operator running `buzz-admin add-member` with no in-protocol way to ask. A client cannot tell which it is facing before connecting, so the flag names the stricter case and `connect` reports the truth per deployment. |
 * | `invite` | `'none'` | Channel-level kind 9009 is a stub that logs a warning (`side_effects.rs:157-163`). The real invites are community-level HTTP and need admin — a write path this adapter does not have. |
 * | `agentAdmission` | `'none'` | Buzz's NIP-OA owner attestation is a real answer to this, and taking it would mean minting and publishing a second key. Not read-only. |
 * | `readCursor` | `'none'` | Buzz's read state is a NIP-44 ciphertext the user encrypts to themselves, per device slot (`docs/nips/NIP-RS.md`) — and writing one is a write. |
 * | `responseMode` | `false` | Buzz has no per-room agent addressing override at all; the concept is ours. |
 * | `threadDepth` | `'unbounded'` | NIP-10 `e` tags with a server-side `depth` column, documented as "infinitely nested" (`db/thread.rs:1-5`). Our own rooms refuse past one level; this backend reads deeper trees faithfully. |
 * | `signals` | `'none'` | Buzz has typing and presence (kinds 20002/20001) and this adapter could observe them — but the port's `'both'` means both directions, and there is deliberately no `'receive'`: an adapter that can watch typing in a room it cannot type in has nothing to show anyone. |
 * | `credential` | `'machine-managed'` | One secp256k1 key, derived from the credential file the server already mints (`buzz-identity.ts`). Nothing user-facing, nothing to write down. |
 *
 * ## The three things that were hard, and where each lives
 *
 * 1. **No sequence.** `buzz-cursor.ts` and `buzz-history.ts`. A position is
 *    `(created_at, event id)`, and a forward page is walked rather than asked for.
 * 2. **Reads need a key.** `buzz-identity.ts`. The original ticket assumed
 *    otherwise; the relay refuses every unauthenticated `REQ`, unconditionally.
 * 3. **Rooms are polled, not pushed.** {@link BuzzCommunityAdapter.subscribeRoomList}
 *    absorbs it, so a consumer has one code path and only the latency differs.
 *
 * ## One honest limit, stated because it is real
 *
 * A cursor is a watermark over what this adapter has already emitted, not an
 * address of an entry — see {@link BuzzCommunityAdapter.subscribeRoom}. That is
 * the strongest construction available over a wall clock somebody else's clients
 * assign. An event that reaches the relay AFTER a read that should have contained
 * it, carrying an OLDER `created_at` than the watermark — a writer with a skewed
 * clock — is delivered live but would not be replayed to a resume that started
 * below it. Our own rooms cannot lose that entry because their `seq` is allocated
 * on arrival; Buzz has no such number to allocate. This is the mismatch in its
 * purest form, and there is no adapter-side fix for it: it is why the port's
 * cursor is opaque.
 *
 * @module server/services/communities/buzz/buzz-community-adapter
 */
import {
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
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
  type CommunityRef,
  type CommunityRoom,
  type CommunityRoomEvent,
  type CommunityRoomListEvent,
  type ListCommunityEntriesOpts,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import { PushStream } from '../push-stream.js';
import { BEGINNING, comparePositions, readBuzzCursor, type BuzzPosition } from './buzz-cursor.js';
import { DEFAULT_RAW_LIMIT, ascending, positionOf, walkHistoryAfter } from './buzz-history.js';
import { deriveBuzzIdentity } from './buzz-identity.js';
import {
  cursorFor,
  toCommunityEntry,
  toCommunityMembers,
  toCommunityRoom,
  BUZZ_ROLES,
} from './buzz-projection.js';
import {
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_STREAM_MESSAGE,
  threadTags,
  type NostrEvent,
  type NostrFilter,
} from './buzz-protocol.js';
import { BuzzReadRefusedError, BuzzRelayClient } from './buzz-relay-client.js';
import { webSocketBuzzSocket, type BuzzSocketFactory } from './buzz-socket.js';

/** How often to re-read the channel list when nothing says one changed. */
const DEFAULT_ROOM_LIST_POLL_INTERVAL_MS = 30_000;

/** Entries a cold subscription opens with. */
const SNAPSHOT_HISTORY_LIMIT = 50;

/** Page size when a caller does not ask for one. */
const DEFAULT_PAGE_SIZE = 50;

/** Channels to ask for in one discovery read. */
const ROOM_DISCOVERY_LIMIT = 500;

/** Everything {@link BuzzCommunityAdapter} is constructed from. */
export interface BuzzCommunityAdapterDeps {
  /** The locally-minted ref for this relay. One instance serves one community. */
  community: CommunityRef;
  /** The relay's WebSocket URL, e.g. `ws://localhost:3000`. */
  relayUrl: string;
  /**
   * This community's credential, already resolved from the server-side store
   * (`../credentials.ts`). A credential never crosses the port; it is handed to
   * the adapter at construction by the composition root that owns the store.
   */
  credential: string;
  /** How to open a socket. Defaults to a real WebSocket. */
  openSocket?: BuzzSocketFactory;
  /** How often the channel list is re-read. Defaults to 30 seconds. */
  roomListPollIntervalMs?: number;
  /**
   * Rows to ask a relay for per historical read. Defaults to
   * {@link DEFAULT_RAW_LIMIT}.
   *
   * It exists to be turned down. A page this adapter never fills exercises none
   * of {@link walkHistoryAfter}'s window narrowing, so the conformance suite runs
   * once with a page size small enough that every read comes back saturated — the
   * difference between "the walk is correct" and "the walk was never asked to
   * walk". It must stay at or below the relay's own clamp (Buzz's is 2000): a
   * relay that clamps BELOW what we ask makes a full page look short, which is
   * the one input that would let the walk stop early.
   */
  historyPageSize?: number;
  /** Budget for the connect handshake. */
  connectTimeoutMs?: number;
}

/**
 * A Buzz relay as a {@link CommunityAdapter}, read-only.
 *
 * @example
 * ```typescript
 * const adapter = new BuzzCommunityAdapter({
 *   community: ref,
 *   relayUrl: 'ws://localhost:3000',
 *   credential: resolveCommunityCredential(dorkHome, ref),
 * });
 * const connection = await adapter.connect();
 * if (connection.status === 'not-admitted') console.log(connection.disclosure);
 * ```
 */
export class BuzzCommunityAdapter implements CommunityAdapter {
  readonly type = 'buzz';
  readonly community: CommunityRef;

  private readonly client: BuzzRelayClient;
  private readonly capabilities: CommunityCapabilities;
  private readonly rooms = new Map<string, CommunityRoom>();
  private readonly listStreams = new Set<PushStream<CommunityRoomListEvent>>();
  private readonly roomStreams = new Set<PushStream<CommunityRoomEvent>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Wire an adapter. Nothing connects until {@link BuzzCommunityAdapter.connect}.
   *
   * @param deps - The community ref, the relay URL, and this community's credential.
   */
  constructor(private readonly deps: BuzzCommunityAdapterDeps) {
    this.community = deps.community;
    this.client = new BuzzRelayClient({
      community: deps.community,
      relayUrl: deps.relayUrl,
      identity: deriveBuzzIdentity(deps.credential),
      openSocket: deps.openSocket ?? webSocketBuzzSocket,
      ...(deps.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: deps.connectTimeoutMs }),
    });
    this.capabilities = {
      type: this.type,
      roomList: 'poll',
      roomListPollIntervalMs: deps.roomListPollIntervalMs ?? DEFAULT_ROOM_LIST_POLL_INTERVAL_MS,
      roomAddressing: 'opaque-id',
      canPost: false,
      roomAdmin: false,
      roles: { supported: true, values: BUZZ_ROLES },
      admission: 'out-of-band',
      invite: 'none',
      agentAdmission: 'none',
      readCursor: 'none',
      responseMode: false,
      threadDepth: 'unbounded',
      signals: 'none',
      credential: 'machine-managed',
      features: {},
    };
  }

  getCapabilities(): CommunityCapabilities {
    return {
      ...this.capabilities,
      roles: { ...this.capabilities.roles, values: [...this.capabilities.roles.values] },
      features: { ...this.capabilities.features },
    };
  }

  // --- Connection ------------------------------------------------------------

  /**
   * Authenticate against the relay and learn what it can see.
   *
   * **`'not-admitted'` drops this community's cached rooms**, which the port makes
   * normative rather than a cache's discretion: a member who was removed and a
   * key that was never admitted reach the same status on their next connect, so
   * one rule covers both. The other three statuses deliberately do not —
   * `'unreachable'` says nothing about membership, and the cache is what makes an
   * install readable while a host is down.
   *
   * @param signal - Aborts an attempt that is taking too long.
   */
  async connect(signal?: AbortSignal): Promise<CommunityConnection> {
    const connection = await this.client.connect(signal);
    if (connection.status === 'not-admitted') {
      this.rooms.clear();
      return connection;
    }
    if (connection.status !== 'connected') return connection;
    try {
      await this.refreshRooms();
    } catch (err) {
      // A handshake that succeeded and a first read that did not is still a
      // connection: the rooms arrive on the next poll, and reporting failure
      // here would discard a working identity over one slow read.
      logger.warn('[BuzzCommunity] connected, but the first channel read failed', {
        community: this.community,
        error: errorMessage(err),
      });
    }
    return connection;
  }

  /** Close the socket, stop polling, end every stream. Idempotent. */
  disconnect(): Promise<void> {
    this.stopPolling();
    for (const stream of [...this.roomStreams]) stream.end();
    this.roomStreams.clear();
    for (const stream of [...this.listStreams]) stream.end();
    this.listStreams.clear();
    this.client.disconnect();
    return Promise.resolve();
  }

  // --- Rooms -----------------------------------------------------------------

  /**
   * Every channel this identity may see.
   *
   * An authenticated key reads every OPEN channel without joining it, plus the
   * private ones it is a member of — the relay resolves that union in SQL and we
   * simply receive the result (`db/channel.rs:746-773`). Archived channels are
   * listed rather than hidden: `archived` is a state the port carries, and an
   * archived room still reads.
   */
  async listRooms(): Promise<CommunityRoom[]> {
    await this.refreshRooms();
    return [...this.rooms.values()];
  }

  /**
   * One channel, or `null` when it does not exist or is not visible here.
   *
   * Read from the relay rather than the cache, so a room that appeared since the
   * last poll resolves immediately. Both the unknown and the invisible case come
   * back as an empty result set, which is the relay collapsing them for us — the
   * same collapse the port requires.
   *
   * @param roomId - The channel UUID.
   */
  async getRoom(roomId: string): Promise<CommunityRoom | null> {
    const events = await this.read([{ kinds: [KIND_GROUP_METADATA], '#d': [roomId], limit: 1 }]);
    const room = events.map((event) => toCommunityRoom(this.community, event)).find(Boolean);
    if (room) this.rooms.set(room.roomId, room);
    return room ?? null;
  }

  /**
   * Channel lifecycle as a stream — by polling, because Buzz has no push for it.
   *
   * The consumer never learns which it got: the port's whole point here is that
   * the difference is latency, not shape. One poll serves every subscriber, so N
   * subscribers are not N polls, and a read done for another reason
   * ({@link BuzzCommunityAdapter.listRooms}) feeds the same diff rather than
   * racing it — otherwise a listing between two polls would consume the change
   * and the stream would never mention it.
   *
   * @param signal - Aborts the stream so a parked consumer terminates promptly.
   */
  subscribeRoomList(signal?: AbortSignal): AsyncIterable<CommunityRoomListEvent> {
    const stream = new PushStream<CommunityRoomListEvent>(() => {
      this.listStreams.delete(stream);
      if (this.listStreams.size === 0) this.stopPolling();
    });
    this.listStreams.add(stream);
    this.startPolling();
    bindAbort(signal, stream);
    return stream;
  }

  /** Refused: `roomAdmin: false`. Creating a channel is an admin act on somebody else's server. */
  createRoom(): Promise<CommunityRoom> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'roomAdmin', 'createRoom'));
  }

  /** Refused: `roomAdmin: false`. See {@link BuzzCommunityAdapter.createRoom}. */
  updateRoom(): Promise<CommunityRoom> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'roomAdmin', 'updateRoom'));
  }

  // --- Entries ---------------------------------------------------------------

  /**
   * The durable stream for one channel: snapshot → gap-free replay → live.
   *
   * **Both refusals are synchronous**, as the port requires, which is why this is
   * a plain method returning a stream and not an `async function*`. The room is
   * checked BEFORE the cursor, and that order is contractual: an adapter that
   * validated the cursor first would answer a different typed error for a room
   * that does not exist than for one that exists and is hidden, which is the
   * probe the identical message closes, re-opened one line earlier.
   *
   * **The room check reads the cache, and it has to.** An eager throw cannot
   * await a relay round trip. The cache is a poll behind, so a channel created
   * seconds ago is briefly refused — the honest cost of `roomList: 'poll'`, and
   * recoverable by any caller that lists first. The reverse case is not a hole:
   * a room that has gone away since the poll is refused by the relay itself, and
   * arrives as a terminal `room_closed`.
   *
   * **The cursor is a watermark, not an address.** Every entry carries the
   * highest position this stream has emitted so far, not its own. On the history
   * path those are the same value, because history is emitted in ascending order.
   * On the live path they are not: a relay may deliver an event whose wall-clock
   * second is below one already delivered, and minting that event's own position
   * would hand out a cursor that resumes BEFORE entries the caller already has —
   * which the port permits (dedupe is by id) but which is strictly worse than a
   * watermark, because it also re-opens the window in which a later read can skip.
   *
   * A relay that closes the subscription ends the stream with `room_closed:
   * 'unknown'`, and the honesty is the point: Buzz emits ONE reason string —
   * `restricted: channel access revoked` — for both archiving a channel and
   * flipping it private (`side_effects.rs:85,95-128`). An adapter that read it as
   * `'archived'` would tell a member who just lost access that the room was put
   * away. `'unknown'` exists on the port for exactly this.
   *
   * @param roomId - The channel to stream.
   * @param sinceCursor - Resume point; emit only what follows it.
   * @param signal - Aborts the stream so a parked consumer terminates promptly.
   */
  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal
  ): AsyncIterable<CommunityRoomEvent> {
    const room = this.rooms.get(roomId);
    if (!room) throw new CommunityRoomNotFoundError(this.community, roomId);
    const from =
      sinceCursor === undefined ? null : readBuzzCursor(this.community, roomId, sinceCursor);

    const stream = new PushStream<CommunityRoomEvent>(() => {
      this.roomStreams.delete(stream);
    });
    this.roomStreams.add(stream);
    bindAbort(signal, stream);
    void this.pump(room, from, stream);
    return stream;
  }

  /**
   * A page of history, oldest-first.
   *
   * **Top-level only unless `opts.thread` names a root.** NIP-01 filters cannot
   * express "has no `e` tag", so the top-level restriction is applied here, after
   * the read — which is also why the walk must complete before a page can be cut:
   * a relay page of ten events may hold two top-level ones, and slicing before
   * filtering would declare exhaustion on a room with more to give.
   *
   * A thread read matches `#e` against the root, which returns the whole subtree
   * rather than one level, because under NIP-10 every descendant tags the root
   * (`ingest.rs:563-601`). Under `threadDepth: 'unbounded'` that is the right
   * answer rather than an over-fetch.
   *
   * **Each call re-walks from its cursor, and nothing is cached between them**, so
   * paging a room front to back is quadratic in its history rather than linear.
   * That is affordable at the page sizes a real relay serves — the walk stops on
   * the first under-full read, which for a 500-row page is the first read in
   * almost every room — and it is the honest cost of a stateless read over a
   * backend with no sequence to hold a position against. The fix is not a cache
   * here; it is Buzz's own NIP-CW keyset over HTTP, which resumes without
   * re-reading, and which a write-capable adapter already speaking HTTP should
   * take.
   *
   * @param roomId - The channel to read.
   * @param opts - Cursor, page size, and the thread filter.
   */
  async listEntries(
    roomId: string,
    opts: ListCommunityEntriesOpts = {}
  ): Promise<CommunityEntryPage> {
    const after =
      opts.cursor === undefined ? BEGINNING : readBuzzCursor(this.community, roomId, opts.cursor);
    const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
    const rawLimit = this.deps.historyPageSize ?? DEFAULT_RAW_LIMIT;

    const base: NostrFilter = {
      kinds: [KIND_STREAM_MESSAGE],
      '#h': [roomId],
      ...(opts.thread === undefined ? {} : { '#e': [opts.thread] }),
    };
    let events: NostrEvent[];
    try {
      events = await walkHistoryAfter({
        fetch: (filter) => this.read([filter]),
        base,
        after,
        rawLimit,
      });
    } catch (err) {
      // A channel this identity cannot read answers the same way an empty one
      // does, which is the collapse `getRoom` makes for the same reason.
      if (err instanceof BuzzReadRefusedError) return { entries: [], nextCursor: null };
      throw err;
    }

    const matching = opts.thread === undefined ? events.filter(isTopLevel) : events;
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((event) =>
        toCommunityEntry(this.community, roomId, event, this.cursorAt(roomId, positionOf(event)))
      ),
      // Exhaustion is DECLARED. The walk returned everything after the cursor, so
      // "is there more" is a fact here rather than an inference from a row count.
      nextCursor:
        matching.length > page.length && last ? this.cursorAt(roomId, positionOf(last)) : null,
    };
  }

  /**
   * Refused: `canPost: false`. This adapter reads; the signing path, the
   * moderation surface and the consent question that come with writing are their
   * own piece of work.
   */
  post(): Promise<CommunityEntryRef> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'canPost', 'post'));
  }

  // --- Roster ----------------------------------------------------------------

  /**
   * A channel's roster, from the relay-signed kind-39002 event.
   *
   * An unknown or invisible channel returns `[]`, never a throw — the port's own
   * rule, and here it is what the relay does anyway: a read it will not serve
   * yields nothing to project.
   *
   * @param roomId - The channel whose roster to read.
   */
  async listMembers(roomId: string): Promise<CommunityMember[]> {
    let events: NostrEvent[];
    try {
      events = await this.read([{ kinds: [KIND_GROUP_MEMBERS], '#d': [roomId], limit: 1 }]);
    } catch (err) {
      if (err instanceof BuzzReadRefusedError) return [];
      throw err;
    }
    const roster = ascending(events).at(-1);
    return roster ? toCommunityMembers(this.community, roster) : [];
  }

  /** Refused: `roomAdmin: false`. Adding somebody to a channel is kind 9000, an admin write. */
  addMember(
    _roomId: string,
    _memberId: string,
    _opts?: AddCommunityMemberOpts
  ): Promise<CommunityMember> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'roomAdmin', 'addMember'));
  }

  /** Refused: `roomAdmin: false`. See {@link BuzzCommunityAdapter.addMember}. */
  removeMember(): Promise<void> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'roomAdmin', 'removeMember')
    );
  }

  /**
   * Refused: `responseMode: false`. Buzz has no per-room agent addressing
   * override — not one this adapter cannot write, one the model does not have.
   */
  setResponseMode(): Promise<CommunityMember> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'responseMode', 'setResponseMode')
    );
  }

  // --- Agent admission -------------------------------------------------------

  /**
   * Refused: `agentAdmission: 'none'`.
   *
   * Buzz has a real answer to this — NIP-OA binds an agent key to the human key
   * that vouches for it, cryptographically, and is worth reading before we design
   * ours. Taking it means minting and publishing a second keypair, which is a
   * write.
   */
  admitAgent(): Promise<CommunityMember> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'agentAdmission', 'admitAgent')
    );
  }

  /** Refused: `agentAdmission: 'none'`. See {@link BuzzCommunityAdapter.admitAgent}. */
  revokeAgent(): Promise<void> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'agentAdmission', 'revokeAgent')
    );
  }

  // --- Read cursor -----------------------------------------------------------

  /**
   * Refused: `readCursor: 'none'`.
   *
   * Buzz's read state is real (NIP-RS, kind 30078) and this adapter could in
   * principle read its own back — but it is a NIP-44 ciphertext keyed to a device
   * slot, and there is nothing to read until something has written one. Writing
   * is a write.
   */
  getReadCursor(): Promise<CommunityCursor | null> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'readCursor', 'getReadCursor')
    );
  }

  /** Refused: `readCursor: 'none'`. See {@link BuzzCommunityAdapter.getReadCursor}. */
  setReadCursor(): Promise<void> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'readCursor', 'setReadCursor')
    );
  }

  // --- Invites ---------------------------------------------------------------

  /**
   * Refused: `invite: 'none'`.
   *
   * Not "we did not get to it": Buzz's channel-level invite (kind 9009) is a
   * handler that logs a warning and returns Ok (`side_effects.rs:157-163`). What
   * exists is a community-level HTTP invite, authorized to owners and admins. A
   * read-only adapter has neither.
   */
  createInvite(): Promise<CommunityInvite> {
    return Promise.reject(new CommunityUnsupportedError(this.community, 'invite', 'createInvite'));
  }

  // --- Ephemeral -------------------------------------------------------------

  /**
   * Refused: `signals: 'none'`.
   *
   * The port has no `'receive'`, on purpose, and this backend is the case that
   * argues for it: Buzz's typing and presence events are ephemeral kinds this
   * adapter could subscribe to, but an indicator saying somebody is typing in a
   * room this install cannot type in has no consumer. The day the write path
   * lands, this becomes `'both'` and gains a real capability.
   */
  publishSignal(): Promise<void> {
    return Promise.reject(
      new CommunityUnsupportedError(this.community, 'signals', 'publishSignal')
    );
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Run one historical read against the relay.
   *
   * @param filters - NIP-01 filters, OR-ed by the relay.
   */
  private read(filters: NostrFilter[]): Promise<NostrEvent[]> {
    return this.client.query(filters);
  }

  /** The cursor for a position in a room. */
  private cursorAt(roomId: string, position: BuzzPosition): CommunityCursor {
    return cursorFor(this.community, roomId, position);
  }

  /**
   * Re-read the channel list, update the cache, and tell every list subscriber
   * what changed.
   *
   * One function for both the poll and an explicit listing, so a change is
   * reported exactly once however it was noticed.
   */
  private async refreshRooms(): Promise<void> {
    const events = await this.read([{ kinds: [KIND_GROUP_METADATA], limit: ROOM_DISCOVERY_LIMIT }]);
    const seen = new Map<string, CommunityRoom>();
    for (const event of ascending(events)) {
      const room = toCommunityRoom(this.community, event);
      // Later metadata for one channel supersedes earlier: the relay re-signs
      // 39000 on every change, so a discovery read legitimately carries both.
      if (room) seen.set(room.roomId, room);
    }

    const events_: CommunityRoomListEvent[] = [];
    for (const [roomId, room] of seen) {
      const known = this.rooms.get(roomId);
      if (!known) events_.push({ type: 'room_added', room });
      else if (!sameRoom(known, room)) events_.push({ type: 'room_updated', room });
    }
    for (const roomId of this.rooms.keys()) {
      if (!seen.has(roomId)) {
        events_.push({ type: 'room_removed', community: this.community, roomId });
      }
    }

    this.rooms.clear();
    for (const [roomId, room] of seen) this.rooms.set(roomId, room);
    for (const event of events_) {
      for (const stream of [...this.listStreams]) stream.push(event);
    }
  }

  /** Begin polling for channel changes, if nothing is polling yet. */
  private startPolling(): void {
    if (this.pollTimer) return;
    const interval = this.capabilities.roomListPollIntervalMs ?? DEFAULT_ROOM_LIST_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => {
      void this.refreshRooms().catch((err: unknown) => {
        // A failed poll is not a reason to end anyone's stream: the next one may
        // succeed, and a subscriber that lost its stream on a blip would have to
        // be re-opened by a consumer that has no idea why.
        logger.debug('[BuzzCommunity] a channel-list poll failed', {
          community: this.community,
          error: errorMessage(err),
        });
      });
    }, interval);
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  /** Stop polling once nothing is listening, so an idle adapter holds no timer. */
  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Feed one room subscription: backfill to `EOSE`, then live.
   *
   * The subscription is opened FIRST and the backfill is read from the same
   * `REQ`, because Buzz registers a subscription before running its historical
   * query — so there is no window between the two for an entry to fall into. A
   * separate "read history, then subscribe" would have one, and no amount of
   * care on this side could close it.
   *
   * A resume whose backfill comes back saturated is completed by
   * {@link walkHistoryAfter}: one relay page is not a guarantee of coverage, and
   * a resume that is short is a gap.
   *
   * @param room - The room, as the cache knows it.
   * @param from - The resume point, or `null` for a cold snapshot.
   * @param stream - Where events go.
   */
  private async pump(
    room: CommunityRoom,
    from: BuzzPosition | null,
    stream: PushStream<CommunityRoomEvent>
  ): Promise<void> {
    const roomId = room.roomId;
    const base: NostrFilter = { kinds: [KIND_STREAM_MESSAGE], '#h': [roomId] };
    const rawLimit = this.deps.historyPageSize ?? DEFAULT_RAW_LIMIT;
    const subscription = this.client.subscribe([
      { ...base, ...(from === null ? {} : { since: from.createdAt }), limit: rawLimit },
    ]);
    const events = subscription.events[Symbol.asyncIterator]();

    const seen = new Set<string>();
    let watermark: BuzzPosition = from ?? BEGINNING;

    /** Project one event at the running watermark, which never moves backwards. */
    const project = (event: NostrEvent): CommunityEntry => {
      seen.add(event.id);
      const position = positionOf(event);
      if (comparePositions(position, watermark) > 0) watermark = position;
      return toCommunityEntry(this.community, roomId, event, this.cursorAt(roomId, watermark));
    };

    try {
      // --- Backfill: everything the relay already holds, up to EOSE ----------
      const backfill: NostrEvent[] = [];
      for (;;) {
        const next = await events.next();
        if (next.done) return;
        if (next.value.type === 'closed') {
          stream.push({ type: 'room_closed', reason: 'unknown' });
          return;
        }
        if (next.value.type === 'eose') break;
        backfill.push(next.value.event);
      }

      // A saturated page is not a complete one. Only then is the walk worth its
      // round trips — an under-full page already covers the window.
      const history =
        backfill.length >= rawLimit
          ? await walkHistoryAfter({
              fetch: (filter) => this.read([filter]),
              base,
              after: from ?? BEGINNING,
              rawLimit,
            })
          : ascending(backfill).filter(
              (event) => comparePositions(positionOf(event), from ?? BEGINNING) > 0
            );

      // A cold subscription opens with recent history; a RESUME opens with all
      // of it, because a short replay is exactly the gap the port forbids.
      const opening = from === null ? history.slice(-SNAPSHOT_HISTORY_LIMIT) : history;
      stream.push({
        type: 'snapshot',
        room,
        entries: opening.map(project),
        cursor: this.cursorAt(roomId, watermark),
      });

      // --- Live -------------------------------------------------------------
      for (;;) {
        const next = await events.next();
        if (next.done || stream.closed) return;
        if (next.value.type === 'closed') {
          stream.push({ type: 'room_closed', reason: 'unknown' });
          return;
        }
        if (next.value.type !== 'event') continue;
        // Dedupe by id, never by cursor: an overlapping replay is normal, and
        // the relay may re-deliver what the backfill already carried.
        if (seen.has(next.value.event.id)) continue;
        stream.push({ type: 'entry', entry: project(next.value.event) });
      }
    } catch (err) {
      logger.warn('[BuzzCommunity] a room subscription ended on an error', {
        community: this.community,
        roomId,
        error: errorMessage(err),
      });
      // Never a silent end. A reader parked on a stream that simply stopped
      // cannot tell it from a quiet room, which is the failure the port's
      // terminal event exists to prevent — and `'unknown'` is honest, because a
      // failed read genuinely says nothing about why the room went away.
      if (!stream.closed) stream.push({ type: 'room_closed', reason: 'unknown' });
    } finally {
      subscription.close();
      stream.end();
    }
  }
}

/**
 * Whether an event is top-level — no NIP-10 ancestry that Buzz would have
 * honoured on the way in.
 *
 * @param event - The event to classify.
 */
function isTopLevel(event: NostrEvent): boolean {
  return !threadTags(event).some((tag) => tag.marker === 'root' || tag.marker === 'reply');
}

/**
 * Whether two projections of one room differ in anything a subscriber would
 * render.
 *
 * `lastActivityAt` is excluded deliberately: it is the metadata event's own
 * timestamp here, so including it would report an update every time the relay
 * re-signed a channel for an unrelated reason.
 *
 * @param a - The room as it was.
 * @param b - The room as it is.
 */
function sameRoom(a: CommunityRoom, b: CommunityRoom): boolean {
  return (
    a.title === b.title && a.topic === b.topic && a.archived === b.archived && a.kind === b.kind
  );
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
