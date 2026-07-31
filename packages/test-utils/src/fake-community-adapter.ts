/**
 * In-memory {@link CommunityAdapter} for tests — the community analogue of
 * {@link ./fake-connector-provider.js | FakeConnectorProvider}. Backs the
 * `communityConformance` suite with no network and no persistence.
 *
 * It is configurable across the **whole capability matrix**, and that is the
 * point rather than a convenience: a suite driven only by a fake shaped like our
 * own backends can assert only what our own backends happen to do, which is the
 * failure mode the port exists to prevent. Every flag can be set independently,
 * so a combination none of the three real backends uses is still gated.
 *
 * Out-of-band arrangement (seeding a room, seeding an entry, evicting a room,
 * removing a member) goes through explicit test hooks rather than the port, so a
 * read-only configuration can still be given something to read — exactly how a
 * read-only Buzz adapter arranges its fixtures with an admin tool.
 *
 * @module test-utils/fake-community-adapter
 */
import {
  CommunityMemberNotFoundError,
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  LOCAL_COMMUNITY,
  StaleCommunityCursorError,
  type AddCommunityMemberOpts,
  type AdmitAgentInput,
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
  type CreateCommunityInviteInput,
  type CreateCommunityRoomInput,
  type ListCommunityEntriesOpts,
  type PostCommunityEntryInput,
  type UpdateCommunityRoomInput,
} from '@dorkos/shared/community-adapter';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import type { SignalType } from '@dorkos/shared/relay-schemas';

/** Default page size when a caller does not ask for one. */
const DEFAULT_PAGE_SIZE = 50;

/** Poll interval a `roomList: 'poll'` fake declares — small enough for a test to wait on. */
const DEFAULT_POLL_INTERVAL_MS = 20;

/**
 * A push-driven async iterable. Events queue until a consumer pulls them, so a
 * snapshot pushed before the caller starts iterating is never lost.
 */
class Pushable<T> implements AsyncIterable<T> {
  private readonly _queue: T[] = [];
  private readonly _waiters: ((result: IteratorResult<T>) => void)[] = [];
  private _ended = false;

  /**
   * Build a stream that unregisters itself when the consumer walks away.
   *
   * @param onClose - Called once when the consumer stops iterating, so the
   *   producer can unregister this stream.
   */
  constructor(private readonly onClose: () => void) {}

  /**
   * Queue one event, delivering it immediately if a consumer is parked.
   *
   * @param value - The event to deliver.
   */
  push(value: T): void {
    if (this._ended) return;
    const waiter = this._waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this._queue.push(value);
  }

  /** Terminate the stream after everything already queued has been read. */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    let waiter = this._waiters.shift();
    while (waiter) {
      waiter({ value: undefined as never, done: true });
      waiter = this._waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this._queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this._ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this._waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        this.onClose();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** One entry as the fake stores it — the DTO plus its per-room ordinal. */
interface StoredEntry {
  ordinal: number;
  entry: CommunityEntry;
}

/** One membership as the fake stores it — the room-scoped half of a member. */
interface StoredMembership {
  memberId: string;
  role: string | null;
  responseMode?: ResponseMode;
  joinedAt: string;
}

/** One room as the fake stores it. */
interface StoredRoom {
  room: CommunityRoom;
  entries: StoredEntry[];
  roster: Map<string, StoredMembership>;
  closed?: CommunityRoomClosedReason;
}

/** Construction options for {@link FakeCommunityAdapter}. */
export interface FakeCommunityAdapterOpts {
  /** Adapter type identifier. Defaults to `'fake-community'`. */
  type?: string;
  /** The one community this instance serves. Defaults to {@link LOCAL_COMMUNITY}. */
  community?: CommunityRef;
  /** Capability overrides merged over the all-on default profile. */
  capabilities?: Partial<Omit<CommunityCapabilities, 'type'>>;
  /** What `connect()` reports. Defaults to `'connected'`. */
  connectStatus?: CommunityConnection['status'];
  /** A secret the fake holds and must never return. Defaults to a fixed sentinel. */
  plantedCredential?: string;
  /** The connected identity's member id. Defaults to `'member-self'`. */
  identityMemberId?: string;
  /** Cursor epoch — change it to simulate a superseded stream. Defaults to `'e1'`. */
  epoch?: string;
}

/** The all-on capability profile a fake starts from before overrides. */
const DEFAULT_CAPABILITIES: Omit<CommunityCapabilities, 'type'> = {
  roomList: 'push',
  roomAddressing: 'slug',
  canPost: true,
  roomAdmin: true,
  roles: {
    supported: true,
    default: 'member',
    values: [
      { id: 'owner', label: 'Owner', administers: true, isOwner: true },
      { id: 'admin', label: 'Admin', administers: true },
      { id: 'member', label: 'Member', administers: false },
      { id: 'bot', label: 'Bot', administers: false },
    ],
  },
  admission: 'open',
  invite: 'room',
  agentAdmission: 'owner-vouched',
  readCursor: 'server',
  responseMode: true,
  threadDepth: 1,
  signals: 'both',
  credential: 'machine-managed',
  features: {},
};

/**
 * A full in-memory {@link CommunityAdapter} for Vitest tests.
 *
 * Its cursor is `community|room|epoch|ordinal`, which makes it self-identifying
 * in the three ways the port requires: a cursor from another room, another
 * community or a superseded epoch is rejected rather than bounded.
 * `subscribeRoom` validates it **synchronously** and only then returns a stream,
 * because the port requires the throw at call time and an `async function*`
 * cannot do that. The room itself is checked first and the same way: an id this
 * fake cannot stream is refused with `CommunityRoomNotFoundError` before the
 * cursor is looked at.
 *
 * @example
 * ```typescript
 * const adapter = new FakeCommunityAdapter({ capabilities: { canPost: false } });
 * const roomId = adapter.seedRoom({ entries: 3 });
 * ```
 */
export class FakeCommunityAdapter implements CommunityAdapter {
  readonly type: string;
  readonly community: CommunityRef;

  private readonly _capabilities: CommunityCapabilities;
  private readonly _plantedCredential: string;
  private readonly _identityMemberId: string;
  private readonly _connectStatus: CommunityConnection['status'];
  private readonly _epoch: string;

  private readonly _rooms = new Map<string, StoredRoom>();
  private readonly _directory = new Map<string, Omit<CommunityMember, 'responseMode' | 'role'>>();
  private readonly _agentsByLocalId = new Map<string, string>();
  private readonly _readCursors = new Map<string, CommunityCursor>();
  private readonly _roomStreams = new Map<string, Set<Pushable<CommunityRoomEvent>>>();
  private readonly _listStreams = new Set<Pushable<CommunityRoomListEvent>>();
  private readonly _pollTimers = new Set<ReturnType<typeof setTimeout>>();
  private _counter = 0;
  private _connected = false;

  /**
   * Construct a fake adapter with the given capability configuration.
   *
   * @param opts - Capability and fixture configuration; see {@link FakeCommunityAdapterOpts}.
   */
  constructor(opts: FakeCommunityAdapterOpts = {}) {
    this.type = opts.type ?? 'fake-community';
    this.community = opts.community ?? LOCAL_COMMUNITY;
    this._plantedCredential = opts.plantedCredential ?? 'planted-credential-do-not-leak';
    this._identityMemberId = opts.identityMemberId ?? 'member-self';
    this._connectStatus = opts.connectStatus ?? 'connected';
    this._epoch = opts.epoch ?? 'e1';

    const merged = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    // A declared poll interval is meaningless on a push adapter and required on
    // a poll one, so the fake keeps the pair honest rather than making every
    // caller remember it.
    if (merged.roomList === 'poll') {
      merged.roomListPollIntervalMs = merged.roomListPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    } else {
      delete merged.roomListPollIntervalMs;
    }
    if (!merged.roles.supported) merged.roles = { supported: false, values: [] };
    this._capabilities = { type: this.type, ...merged };

    this._directory.set(this._identityMemberId, {
      community: this.community,
      memberId: this._identityMemberId,
      kind: 'human',
      displayName: 'You',
      ownerMemberId: null,
      joinedAt: this._timestamp(),
    });
  }

  getCapabilities(): CommunityCapabilities {
    // Deep-enough copy so a consumer cannot mutate the fake's declaration.
    return { ...this._capabilities, roles: { ...this._capabilities.roles } };
  }

  // --- Connection ----------------------------------------------------------

  connect(): Promise<CommunityConnection> {
    if (this._connectStatus === 'connected') {
      if (!this._directory.has(this._identityMemberId)) {
        return Promise.resolve({
          status: 'not-admitted',
          disclosure:
            'Ask whoever runs this community to let you in — there is no way to request it from here.',
          error: 'the connected identity is no longer a member',
        });
      }
      this._connected = true;
      return Promise.resolve({
        status: 'connected',
        identity: { community: this.community, memberId: this._identityMemberId },
      });
    }
    if (this._connectStatus === 'not-admitted') {
      return Promise.resolve({
        status: 'not-admitted',
        disclosure:
          'Ask whoever runs this community to let you in — there is no way to request it from here.',
        error: 'this community has not admitted this identity',
      });
    }
    if (this._connectStatus === 'unauthorized') {
      return Promise.resolve({ status: 'unauthorized', error: 'the credential was rejected' });
    }
    return Promise.resolve({ status: 'unreachable', error: 'the host did not answer' });
  }

  disconnect(): Promise<void> {
    this._connected = false;
    for (const timer of this._pollTimers) clearTimeout(timer);
    this._pollTimers.clear();
    for (const streams of this._roomStreams.values()) for (const s of streams) s.end();
    this._roomStreams.clear();
    for (const s of this._listStreams) s.end();
    this._listStreams.clear();
    return Promise.resolve();
  }

  // --- Rooms ---------------------------------------------------------------

  listRooms(): Promise<CommunityRoom[]> {
    return Promise.resolve([...this._rooms.values()].map((r) => this._projectRoom(r)));
  }

  getRoom(roomId: string): Promise<CommunityRoom | null> {
    const stored = this._rooms.get(roomId);
    return Promise.resolve(stored ? this._projectRoom(stored) : null);
  }

  subscribeRoomList(signal?: AbortSignal): AsyncIterable<CommunityRoomListEvent> {
    const stream = new Pushable<CommunityRoomListEvent>(() => {
      this._listStreams.delete(stream);
    });
    this._listStreams.add(stream);
    signal?.addEventListener('abort', () => stream.end());
    return stream;
  }

  createRoom(input: CreateCommunityRoomInput): Promise<CommunityRoom> {
    if (!this._capabilities.roomAdmin) {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'roomAdmin', 'createRoom')
      );
    }
    return Promise.resolve(
      this.seedRoomRecord({
        kind: input.kind ?? 'channel',
        title: input.title,
        slug: input.slug ?? null,
        topic: input.topic ?? null,
      })
    );
  }

  updateRoom(roomId: string, patch: UpdateCommunityRoomInput): Promise<CommunityRoom> {
    if (!this._capabilities.roomAdmin) {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'roomAdmin', 'updateRoom')
      );
    }
    const stored = this._rooms.get(roomId);
    if (!stored) return Promise.reject(new Error(`unknown room '${roomId}'`));
    if (patch.title !== undefined) stored.room.title = patch.title;
    if (patch.topic !== undefined) stored.room.topic = patch.topic;
    if (patch.archived !== undefined) stored.room.archived = patch.archived;
    const room = this._projectRoom(stored);
    this._emitRoomList({ type: 'room_updated', room });
    return Promise.resolve(room);
  }

  // --- Entries -------------------------------------------------------------

  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal
  ): AsyncIterable<CommunityRoomEvent> {
    const stored = this._rooms.get(roomId);
    // Both refusals land SYNCHRONOUSLY, before any stream exists: the port
    // requires the room check and the stale-cursor throw at call time, and this
    // is the reference implementation of that shape.
    if (!stored) throw new CommunityRoomNotFoundError(this.community, roomId);
    const from = sinceCursor === undefined ? 0 : this._ordinalOrThrow(roomId, sinceCursor);

    const stream = new Pushable<CommunityRoomEvent>(() => {
      this._roomStreams.get(roomId)?.delete(stream);
    });
    const replay = stored.entries.filter((e) => e.ordinal > from);
    stream.push({
      type: 'snapshot',
      room: this._projectRoom(stored),
      entries: replay.map((e) => this._copyEntry(e.entry)),
      cursor: this._cursor(roomId, stored.entries.at(-1)?.ordinal ?? 0),
    });
    if (stored.closed) {
      stream.push({ type: 'room_closed', reason: stored.closed });
      stream.end();
      return stream;
    }
    const set = this._roomStreams.get(roomId) ?? new Set();
    set.add(stream);
    this._roomStreams.set(roomId, set);
    signal?.addEventListener('abort', () => stream.end());
    return stream;
  }

  listEntries(roomId: string, opts: ListCommunityEntriesOpts = {}): Promise<CommunityEntryPage> {
    const stored = this._rooms.get(roomId);
    if (!stored) return Promise.resolve({ entries: [], nextCursor: null });
    const from = opts.cursor === undefined ? 0 : this._ordinalOrThrow(roomId, opts.cursor);
    const matching = stored.entries.filter((e) => {
      if (e.ordinal <= from) return false;
      return opts.thread === undefined
        ? e.entry.parentEntryId === null
        : e.entry.threadRootEntryId === opts.thread;
    });
    const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
    const page = matching.slice(0, limit);
    const exhausted = page.length === matching.length;
    return Promise.resolve({
      entries: page.map((e) => this._copyEntry(e.entry)),
      nextCursor: exhausted ? null : (page.at(-1)?.entry.cursor ?? null),
    });
  }

  post(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntryRef> {
    if (!this._capabilities.canPost) {
      return Promise.reject(new CommunityUnsupportedError(this.community, 'canPost', 'post'));
    }
    try {
      const entry = this.seedEntry(roomId, {
        text: input.text,
        authorId: this._identityMemberId,
        parentEntryId: input.parentEntryId,
        mentions: input.mentions,
      });
      return Promise.resolve({
        community: this.community,
        roomId,
        entryId: entry.id,
        cursor: entry.cursor,
      });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Roster --------------------------------------------------------------

  listMembers(roomId: string): Promise<CommunityMember[]> {
    const stored = this._rooms.get(roomId);
    if (!stored) return Promise.resolve([]);
    const members: CommunityMember[] = [];
    for (const membership of stored.roster.values()) {
      const member = this._projectMember(membership);
      if (member) members.push(member);
    }
    return Promise.resolve(members);
  }

  addMember(
    roomId: string,
    memberId: string,
    opts: AddCommunityMemberOpts = {}
  ): Promise<CommunityMember> {
    if (!this._capabilities.roomAdmin) {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'roomAdmin', 'addMember')
      );
    }
    const stored = this._rooms.get(roomId);
    if (!stored) return Promise.reject(new Error(`unknown room '${roomId}'`));
    if (!this._directory.has(memberId)) {
      return Promise.reject(new Error(`unknown member '${memberId}'`));
    }
    const membership: StoredMembership = {
      memberId,
      role: this._defaultRoleFor(memberId, opts.role),
      joinedAt: this._timestamp(),
    };
    if (this._capabilities.responseMode && opts.responseMode) {
      membership.responseMode = opts.responseMode;
    } else if (this._capabilities.responseMode) {
      membership.responseMode = 'mention-only';
    }
    stored.roster.set(memberId, membership);
    return Promise.resolve(this._projectMember(membership)!);
  }

  removeMember(roomId: string, memberId: string): Promise<void> {
    const isOwnAgent = this._directory.get(memberId)?.ownerMemberId === this._identityMemberId;
    if (!this._capabilities.roomAdmin && !isOwnAgent) {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'roomAdmin', 'removeMember')
      );
    }
    this._rooms.get(roomId)?.roster.delete(memberId);
    return Promise.resolve();
  }

  setResponseMode(roomId: string, memberId: string, mode: ResponseMode): Promise<CommunityMember> {
    if (!this._capabilities.responseMode) {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'responseMode', 'setResponseMode')
      );
    }
    const membership = this._rooms.get(roomId)?.roster.get(memberId);
    // The port's typed refusal, and the same one for a member this community
    // never minted as for one it minted and this room does not hold.
    if (!membership) {
      return Promise.reject(new CommunityMemberNotFoundError(this.community, memberId));
    }
    membership.responseMode = mode;
    return Promise.resolve(this._projectMember(membership)!);
  }

  // --- Agent admission -----------------------------------------------------

  admitAgent(input: AdmitAgentInput): Promise<CommunityMember> {
    if (this._capabilities.agentAdmission === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'agentAdmission', 'admitAgent')
      );
    }
    // Admission is DERIVED from the vouching member and re-evaluated here, never
    // copied into a row a cleanup job must find: once the owner is gone, so is
    // the vouch.
    if (!this._directory.has(this._identityMemberId)) {
      return Promise.reject(
        new Error(`'${this._identityMemberId}' is no longer admitted; its vouch no longer holds`)
      );
    }
    const existingId = this._agentsByLocalId.get(input.agentId);
    if (existingId) {
      const membership: StoredMembership = {
        memberId: existingId,
        role: this._nonAdministeringRole(),
        joinedAt: this._directory.get(existingId)!.joinedAt,
      };
      return Promise.resolve(this._projectMember(membership)!);
    }
    this._counter += 1;
    const memberId = `agent-${this._counter}`;
    this._agentsByLocalId.set(input.agentId, memberId);
    this._directory.set(memberId, {
      community: this.community,
      memberId,
      kind: 'agent',
      displayName: input.displayName,
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.color ? { color: input.color } : {}),
      ownerMemberId: this._identityMemberId,
      joinedAt: this._timestamp(),
    });
    return Promise.resolve(
      this._projectMember({
        memberId,
        role: this._nonAdministeringRole(),
        joinedAt: this._timestamp(),
      })!
    );
  }

  revokeAgent(memberId: string): Promise<void> {
    if (this._capabilities.agentAdmission === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'agentAdmission', 'revokeAgent')
      );
    }
    this.removeCommunityMember(memberId);
    return Promise.resolve();
  }

  // --- Read cursor ---------------------------------------------------------

  getReadCursor(roomId: string): Promise<CommunityCursor | null> {
    if (this._capabilities.readCursor === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'readCursor', 'getReadCursor')
      );
    }
    return Promise.resolve(this._readCursors.get(roomId) ?? null);
  }

  setReadCursor(roomId: string, cursor: CommunityCursor): Promise<void> {
    if (this._capabilities.readCursor === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'readCursor', 'setReadCursor')
      );
    }
    this._readCursors.set(roomId, cursor);
    return Promise.resolve();
  }

  // --- Invites -------------------------------------------------------------

  createInvite(input: CreateCommunityInviteInput): Promise<CommunityInvite> {
    const scope = this._capabilities.invite;
    if (scope === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'invite', 'createInvite')
      );
    }
    if (scope === 'community' && input.roomId !== undefined) {
      // No silent widening, and no substituting "an admin adds you": those are
      // different acts with different consent semantics. The wording matters —
      // `invite` is ON here, just narrower than asked for, so saying "capability
      // is off" would send a reader looking for a flag that is already set.
      return Promise.reject(
        new CommunityUnsupportedError(
          this.community,
          'invite',
          'createInvite',
          "this community's invites admit to the community, not to one room"
        )
      );
    }
    this._counter += 1;
    return Promise.resolve({
      community: this.community,
      roomId: input.roomId ?? null,
      token: `invite-${this._counter}`,
      expiresAt: input.expiresAt ?? null,
    });
  }

  // --- Ephemeral -----------------------------------------------------------

  publishSignal(
    roomId: string,
    signal: SignalType,
    payload?: CommunityPresencePayload
  ): Promise<void> {
    if (this._capabilities.signals === 'none') {
      return Promise.reject(
        new CommunityUnsupportedError(this.community, 'signals', 'publishSignal')
      );
    }
    this._emitRoom(roomId, {
      type: 'signal',
      signal,
      memberId: this._identityMemberId,
      at: this._timestamp(),
      ...(payload ? { payload } : {}),
    });
    return Promise.resolve();
  }

  // --- Test hooks (out of band, never the port) -----------------------------

  /**
   * Arrange a readable room with entries, whatever the capability profile says.
   * The stand-in for a read-only backend's admin tool.
   *
   * @param opts - Room shape and how many entries to seed.
   * @returns The new room's id.
   */
  seedRoom(
    opts: { title?: string; kind?: RoomKind; slug?: string | null; entries?: number } = {}
  ): string {
    const room = this.seedRoomRecord({
      kind: opts.kind ?? 'channel',
      title: opts.title ?? `Room ${this._counter + 1}`,
      slug: opts.slug === undefined ? `room-${this._counter + 1}` : opts.slug,
      topic: null,
    });
    for (let i = 0; i < (opts.entries ?? 3); i += 1) {
      this.seedEntry(room.roomId, { text: `entry ${i + 1}`, authorId: this._identityMemberId });
    }
    return room.roomId;
  }

  /**
   * Append an entry out of band — the hook a `canPost: false` profile needs to
   * have anything to read.
   *
   * @param roomId - The room to append to.
   * @param input - Author, text, and the thread relation.
   * @returns The committed entry.
   */
  seedEntry(
    roomId: string,
    input: { text: string; authorId: string; parentEntryId?: string; mentions?: string[] }
  ): CommunityEntry {
    const stored = this._rooms.get(roomId);
    if (!stored) throw new Error(`unknown room '${roomId}'`);

    let parentEntryId: string | null = null;
    let threadRootEntryId: string | null = null;
    let depth = 0;
    if (input.parentEntryId !== undefined) {
      const parent = stored.entries.find((e) => e.entry.id === input.parentEntryId);
      if (!parent) throw new Error(`unknown parent entry '${input.parentEntryId}'`);
      if (this._capabilities.threadDepth === 1 && parent.entry.parentEntryId !== null) {
        throw new Error('NESTED_THREAD: a reply to a reply is refused at one-level depth');
      }
      parentEntryId = parent.entry.id;
      threadRootEntryId = parent.entry.threadRootEntryId ?? parent.entry.id;
      depth = parent.entry.depth + 1;
    }

    this._counter += 1;
    const ordinal = (stored.entries.at(-1)?.ordinal ?? 0) + 1;
    const entry: CommunityEntry = {
      community: this.community,
      roomId,
      id: `entry-${this._counter}`,
      authorId: input.authorId,
      text: input.text,
      mentions: input.mentions ?? [],
      parentEntryId,
      threadRootEntryId,
      depth,
      cursor: this._cursor(roomId, ordinal),
      createdAt: this._timestamp(),
    };
    stored.entries.push({ ordinal, entry });
    stored.room.lastActivityAt = entry.createdAt;
    if (threadRootEntryId) this._refreshThreadSummary(stored, threadRootEntryId);
    this._emitRoom(roomId, { type: 'entry', entry: this._copyEntry(entry) });
    return this._copyEntry(entry);
  }

  /**
   * Make a room unservable and terminate its live subscriptions, the way an
   * archive or an access revocation does.
   *
   * @param roomId - The room to evict.
   * @param reason - The cause the fixture arranged.
   */
  evictRoom(roomId: string, reason: CommunityRoomClosedReason): void {
    const stored = this._rooms.get(roomId);
    if (!stored) return;
    stored.closed = reason;
    this._emitRoom(roomId, { type: 'room_closed', reason });
    for (const stream of this._roomStreams.get(roomId) ?? []) stream.end();
    this._roomStreams.delete(roomId);
  }

  /**
   * Remove a member from the community entirely, taking every agent they
   * vouched for with them — the D8 property asserted by use rather than by a row
   * disappearing.
   *
   * @param memberId - The member to remove.
   */
  removeCommunityMember(memberId: string): void {
    this._directory.delete(memberId);
    for (const [localId, mapped] of this._agentsByLocalId) {
      if (mapped === memberId) this._agentsByLocalId.delete(localId);
    }
    for (const [agentMemberId, member] of this._directory) {
      if (member.ownerMemberId === memberId) this.removeCommunityMember(agentMemberId);
    }
    for (const stored of this._rooms.values()) stored.roster.delete(memberId);
  }

  /** The credential this fake holds. Test-only: the port itself must never return it. */
  plantedCredential(): string {
    return this._plantedCredential;
  }

  /** Whether `connect()` has succeeded and `disconnect()` has not run since. */
  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Create a room record, bypassing the `roomAdmin` gate.
   *
   * @param input - The room's fields.
   * @returns The new room.
   */
  private seedRoomRecord(input: {
    kind: RoomKind;
    title: string;
    slug: string | null;
    topic: string | null;
  }): CommunityRoom {
    this._counter += 1;
    const roomId = `room-${this._counter}`;
    const now = this._timestamp();
    const stored: StoredRoom = {
      room: {
        community: this.community,
        roomId,
        kind: input.kind,
        title: input.title,
        slug: this._capabilities.roomAddressing === 'opaque-id' ? null : input.slug,
        topic: input.topic,
        archived: false,
        createdAt: now,
        lastActivityAt: now,
        unreadCount: null,
      },
      entries: [],
      roster: new Map(),
    };
    stored.roster.set(this._identityMemberId, {
      memberId: this._identityMemberId,
      role: this._capabilities.roles.supported ? (this._capabilities.roles.default ?? null) : null,
      ...(this._capabilities.responseMode ? { responseMode: 'always' as ResponseMode } : {}),
      joinedAt: now,
    });
    this._rooms.set(roomId, stored);
    const room = this._projectRoom(stored);
    this._emitRoomList({ type: 'room_added', room });
    return room;
  }

  /** Project a stored room, computing the unread count its capability allows. */
  private _projectRoom(stored: StoredRoom): CommunityRoom {
    let unreadCount: number | null = null;
    if (this._capabilities.readCursor === 'server') {
      const cursor = this._readCursors.get(stored.room.roomId);
      // A cursor this room cannot interpret means "read nothing here" rather
      // than a listing that throws: a bad cursor must not cost a room its row.
      let from = 0;
      try {
        if (cursor) from = this._ordinalOrThrow(stored.room.roomId, cursor);
      } catch {
        from = 0;
      }
      unreadCount = stored.entries.filter((e) => e.ordinal > from).length;
    }
    return { ...stored.room, unreadCount };
  }

  /** Merge a room-scoped membership with its community-level directory record. */
  private _projectMember(membership: StoredMembership): CommunityMember | undefined {
    const record = this._directory.get(membership.memberId);
    if (!record) return undefined;
    return {
      ...record,
      role: this._capabilities.roles.supported ? membership.role : null,
      ...(this._capabilities.responseMode && membership.responseMode
        ? { responseMode: membership.responseMode }
        : {}),
      joinedAt: membership.joinedAt,
    };
  }

  /**
   * Hand out a COPY of a stored entry, never the stored object.
   *
   * A reference implementation that returns live references makes a caller's
   * before/after comparison compare an object with itself, so a partial write
   * becomes invisible — which is exactly how the conformance suite's "never a
   * partial write" clause was silently satisfied before this existed. An entry
   * has a nested `thread` summary and a `mentions` array, so a shallow spread
   * is not enough.
   */
  private _copyEntry(entry: CommunityEntry): CommunityEntry {
    return structuredClone(entry);
  }

  /** The role a new member gets, honouring an explicit request when it is declared. */
  private _defaultRoleFor(memberId: string, requested?: string): string | null {
    if (!this._capabilities.roles.supported) return null;
    const record = this._directory.get(memberId);
    if (record?.ownerMemberId) return this._nonAdministeringRole();
    if (requested && this._capabilities.roles.values.some((r) => r.id === requested)) {
      return requested;
    }
    return this._capabilities.roles.default ?? null;
  }

  /** An agent's role NEVER administers, whatever its owner's role is. */
  private _nonAdministeringRole(): string | null {
    if (!this._capabilities.roles.supported) return null;
    return this._capabilities.roles.values.find((r) => !r.administers)?.id ?? null;
  }

  /** Recompute a thread root's rolled-up summary. */
  private _refreshThreadSummary(stored: StoredRoom, rootId: string): void {
    const replies = stored.entries.filter((e) => e.entry.threadRootEntryId === rootId);
    const root = stored.entries.find((e) => e.entry.id === rootId);
    if (!root || replies.length === 0) return;
    root.entry.thread = {
      replyCount: replies.length,
      lastReplyAt: replies.at(-1)!.entry.createdAt,
    };
  }

  /** Mint a self-identifying cursor: community, room, epoch and ordinal. */
  private _cursor(roomId: string, ordinal: number): CommunityCursor {
    return `${this.community}|${roomId}|${this._epoch}|${ordinal}` as CommunityCursor;
  }

  /**
   * Read a cursor's ordinal, rejecting one minted for another room, another
   * community, or a superseded epoch — rejected, never bounded, because a
   * foreign cursor is a plausible value that would silently skip real entries.
   */
  private _ordinalOrThrow(roomId: string, cursor: CommunityCursor): number {
    const [community, room, epoch, ordinal] = String(cursor).split('|');
    if (community !== this.community) {
      throw new StaleCommunityCursorError(
        this.community,
        roomId,
        'cursor belongs to another community'
      );
    }
    if (room !== roomId) {
      throw new StaleCommunityCursorError(this.community, roomId, 'cursor belongs to another room');
    }
    if (epoch !== this._epoch) {
      throw new StaleCommunityCursorError(
        this.community,
        roomId,
        'cursor is from a superseded epoch'
      );
    }
    const parsed = Number(ordinal);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new StaleCommunityCursorError(this.community, roomId, 'cursor is malformed');
    }
    const highest = this._rooms.get(roomId)?.entries.at(-1)?.ordinal ?? 0;
    if (parsed > highest) {
      throw new StaleCommunityCursorError(this.community, roomId, 'cursor is ahead of this room');
    }
    return parsed;
  }

  /** Fan one event out to every live subscriber of a room. */
  private _emitRoom(roomId: string, event: CommunityRoomEvent): void {
    for (const stream of this._roomStreams.get(roomId) ?? []) stream.push(event);
  }

  /**
   * Fan a lifecycle event out to room-list subscribers — immediately on a
   * `'push'` adapter, on the declared interval on a `'poll'` one. The latency
   * differs; the shape does not.
   */
  private _emitRoomList(event: CommunityRoomListEvent): void {
    if (this._capabilities.roomList === 'push') {
      for (const stream of this._listStreams) stream.push(event);
      return;
    }
    const timer = setTimeout(() => {
      this._pollTimers.delete(timer);
      for (const stream of this._listStreams) stream.push(event);
    }, this._capabilities.roomListPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    // Never keep a test process alive for a poll nobody is waiting on.
    (timer as { unref?: () => void }).unref?.();
    this._pollTimers.add(timer);
  }

  /** Monotonic ISO timestamps, so `lastActivityAt` ordering is stable in a fast test. */
  private _timestamp(): string {
    this._counter += 1;
    return new Date(Date.UTC(2026, 6, 29, 0, 0, 0) + this._counter * 1000).toISOString();
  }
}
