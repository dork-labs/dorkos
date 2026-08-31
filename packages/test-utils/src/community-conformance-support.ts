/**
 * Shared scaffolding for the `CommunityAdapter` conformance suite: its hooks,
 * its stream helpers, and the capability→method probe table.
 *
 * Split out of `community-conformance.ts` so the two halves of the suite —
 * universal assertions and capability-branched ones, which is the spec's own
 * seam — each read as one thing. Nothing here asserts; it only arranges.
 *
 * @module test-utils/community-conformance-support
 */
import {
  type CommunityAdapter,
  type CommunityCapabilities,
  type CommunityCursor,
  type CommunityEntry,
  type CommunityGatedCapability,
  type CommunityMember,
  type CommunityRoom,
  type CommunityRoomClosedReason,
  type CommunityRoomEvent,
} from '@dorkos/shared/community-adapter';

/** Default budget for one awaited stream event. */
export const DEFAULT_EVENT_TIMEOUT_MS = 1_000;

/** How long to watch a stream when asserting that NOTHING arrives. */
export const QUIET_WINDOW_MS = 60;

/** Page size the pagination assertion uses, so any room with two entries pages. */
export const PAGE_SIZE = 1;

/**
 * Guard a class-identity assertion (`toThrow(SomeClass)`, `toBeInstanceOf(SomeClass)`)
 * against a stale `@dorkos/shared` dist.
 *
 * Vite's SSR interop does not enforce named-export existence the way Node's
 * ESM linker does: importing a class absent from the built dist lands as
 * `undefined` rather than a resolution error, a fake adapter's `throw new
 * SomeError(...)` becomes a bare `TypeError`, and `expect(...).toThrow(undefined)`
 * degrades to a bare `toThrow()` — so the assertion passes with the class it
 * exists to discriminate silently gone (DOR-755, DOR-754). Reachable in
 * exactly the loop `AGENTS.md` prescribes: `pnpm vitest run <path>` after
 * pulling without rebuilding `packages/shared/dist`.
 *
 * Call at the top of any conformance case whose whole job is discriminating
 * one error class from another.
 *
 * @param ctor - The imported binding to check.
 * @param name - Its name, for the failure message.
 */
export function assertImported(ctor: unknown, name: string): void {
  if (typeof ctor !== 'function') {
    throw new Error(
      `stale @dorkos/shared dist: ${name} did not import — rebuild with \`pnpm --filter @dorkos/shared build\``
    );
  }
}

/** Tuning knobs + hooks for the community conformance suite. */
export interface CommunityConformanceOpts {
  /** Label for the registered describe block. Defaults to `'CommunityAdapter conformance'`. */
  name?: string;

  /**
   * REQUIRED: arrange one readable room **containing at least two entries**,
   * and return its id.
   *
   * Required rather than optional because every backend must be able to arrange
   * something to read. A read-only backend arranges it out of band with an admin
   * tool, which is the honest cost of that backend rather than a reason to stop
   * testing it.
   *
   * @param adapter - The adapter to arrange the room on.
   */
  seedRoom: (adapter: CommunityAdapter) => Promise<string>;

  /**
   * REQUIRED: a credential string the adapter genuinely holds. The
   * no-leakage assertion has nothing to look for otherwise.
   */
  plantedCredential: string;

  /**
   * REQUIRED: an adapter whose host does not answer. An adapter that throws
   * instead of returning a typed `'unreachable'` fails here.
   */
  makeUnreachableAdapter: () => CommunityAdapter;

  /** Optional: an adapter whose credential is valid but which has not been admitted. */
  makeUnadmittedAdapter?: () => CommunityAdapter;

  /** Optional: an adapter whose credential is wrong, expired, rejected or banned. */
  makeUnauthorizedAdapter?: () => CommunityAdapter;

  /**
   * Optional: remove the connected member from the community, so the derived
   * half of agent admission can be asserted **by use**.
   *
   * @param adapter - The adapter to mutate.
   * @param ownerMemberId - The connected identity to remove.
   */
  revokeOwner?: (adapter: CommunityAdapter, ownerMemberId: string) => Promise<void>;

  /**
   * Optional: make a room unservable mid-subscription and return the cause the
   * fixture arranged, so the terminal event's reason can be checked rather than
   * merely its arrival.
   *
   * @param adapter - The adapter holding the room.
   * @param roomId - The room to evict.
   */
  makeEvictedRoom?: (
    adapter: CommunityAdapter,
    roomId: string
  ) => Promise<CommunityRoomClosedReason>;

  /**
   * Optional: arrange an entry **authored by an admitted agent**, out of band,
   * and return its id.
   *
   * The port has no post-as-agent — `post` always writes as the connected
   * identity — so the invariant that matters most about attribution ("an entry
   * authored by an agent NEVER carries its owner's id") is unassertable without
   * a fixture that can write one. An adapter declaring
   * `agentAdmission: 'owner-vouched'` and omitting this hook declines that case,
   * and the suite says so by name rather than passing quietly.
   *
   * **The seeded entry must be TOP-LEVEL** — not a thread reply. The assertion
   * reads it back through the default (top-level) queries, so a reply would come
   * back undefined and fail for the wrong reason.
   *
   * @param adapter - The adapter to arrange the entry on.
   * @param roomId - The room to write into.
   * @param agent - The admitted agent to attribute the entry to.
   */
  seedAgentEntry?: (
    adapter: CommunityAdapter,
    roomId: string,
    agent: CommunityMember
  ) => Promise<string>;

  /**
   * Optional: arrange a room with NOTHING in it, and return its id.
   *
   * A backend that declares `roomAdmin` does not need this — the suite makes an
   * empty room with `createRoom`. It exists for the backends that cannot, which
   * are exactly the ones where an empty room is most likely to be untested: a
   * read-only adapter's fixtures are all arranged out of band, so nobody writes
   * the empty case unless something asks for it.
   *
   * The case it exists for is narrow and was a real bug: the cursor an adapter
   * mints for a room with no history is the one cursor it never mints anywhere
   * else, so it is the one an encoding can reject without any other assertion
   * noticing.
   *
   * @param adapter - The adapter to arrange the room on.
   */
  seedEmptyRoom?: (adapter: CommunityAdapter) => Promise<string>;

  /** Optional: a second community, for the cross-community cursor rejection. */
  secondCommunity?: () => CommunityAdapter;

  /** Budget for one awaited stream event. Defaults to {@link DEFAULT_EVENT_TIMEOUT_MS}. */
  eventTimeoutMs?: number;
}

/** One capability-gated call the "off means refuse" assertion drives. */
export interface GatedProbe {
  /** Whether this capability is OFF for the given declaration. */
  isOff: (caps: CommunityCapabilities) => boolean;
  /** The method names this capability gates, each with the call that must refuse. */
  calls: (
    adapter: CommunityAdapter,
    ctx: { roomId: string; memberId: string }
  ) => { method: string; run: () => Promise<unknown> }[];
}

/** Pull one event from a stream, or fail with a message naming what was awaited. */
export async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  what: string,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)),
      timeoutMs
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) throw new Error(`stream ended before ${what}`);
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read every event that arrives within a short quiet window, then stop. */
export async function drainQuietly<T>(iterator: AsyncIterator<T>, ms: number): Promise<T[]> {
  const collected: T[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      collected.push(
        await nextEvent(iterator, 'a quiet-window event', Math.max(1, deadline - Date.now()))
      );
    } catch {
      break;
    }
  }
  return collected;
}

/**
 * Page through a room's top-level history.
 *
 * `emptyAfterPromise` records whether any page followed a non-null cursor and
 * came back empty. That is the other half of "`null` is the only authority on
 * exhaustion": if a non-null cursor does not promise there is more, it says
 * nothing at all, and a backend inferring exhaustion from row counts would slip
 * through on the null half alone.
 */
export async function pageAllEntries(
  adapter: CommunityAdapter,
  roomId: string,
  limit = PAGE_SIZE
): Promise<{ entries: CommunityEntry[]; pages: number; emptyAfterPromise: boolean }> {
  const entries: CommunityEntry[] = [];
  let cursor: CommunityCursor | undefined;
  let pages = 0;
  let emptyAfterPromise = false;
  // Bounded so a backend that never declares exhaustion fails loudly rather
  // than hanging the suite.
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await adapter.listEntries(roomId, cursor ? { cursor, limit } : { limit });
    pages += 1;
    if (cursor !== undefined && page.entries.length === 0) emptyAfterPromise = true;
    entries.push(...page.entries);
    if (page.nextCursor === null) return { entries, pages, emptyAfterPromise };
    cursor = page.nextCursor;
  }
  throw new Error(`listEntries never declared exhaustion for room '${roomId}'`);
}

/** One connected adapter with a seeded room — the arrangement most cases need. */
export interface CommunityArrangement {
  /** The adapter under test. */
  adapter: CommunityAdapter;
  /** Its declared capabilities. */
  caps: CommunityCapabilities;
  /** A readable room with at least two entries. */
  roomId: string;
  /** The connected identity's member id, or `''` when the connection did not succeed. */
  identityMemberId: string;
}

/** The whole observable store, for the "no partial write" comparison. */
export interface CommunityStoreSnapshot {
  /** Every room. */
  rooms: CommunityRoom[];
  /** Every entry in the arranged room. */
  entries: CommunityEntry[];
  /** Every member of the arranged room. */
  members: CommunityMember[];
}

/** Everything both halves of the suite need, resolved once. */
export interface CommunityConformanceContext {
  /** Factory producing a fresh, ready-to-use adapter. */
  makeAdapter: () => CommunityAdapter;
  /** The suite's hooks, with defaults applied. */
  opts: CommunityConformanceOpts & { name: string; eventTimeoutMs: number };
  /** Budget for one awaited stream event. */
  eventTimeoutMs: number;
  /** Connect a fresh adapter and seed it a readable room. */
  arrange: () => Promise<CommunityArrangement>;
  /** Read one room's stream until `predicate` matches, or fail. */
  awaitRoomEvent: (
    iterator: AsyncIterator<CommunityRoomEvent>,
    predicate: (event: CommunityRoomEvent) => boolean,
    what: string
  ) => Promise<CommunityRoomEvent>;
  /** Read the whole observable store. */
  storeSnapshot: (adapter: CommunityAdapter, roomId: string) => Promise<CommunityStoreSnapshot>;
}

/**
 * Resolve the suite's hooks and helpers once, so both halves share one
 * arrangement rather than each growing its own.
 *
 * @param makeAdapter - Factory producing a fresh, ready-to-use adapter.
 * @param opts - Required hooks + declared differences.
 */
export function createCommunityConformanceContext(
  makeAdapter: () => CommunityAdapter,
  opts: CommunityConformanceOpts
): CommunityConformanceContext {
  const resolved = {
    ...opts,
    name: opts.name ?? 'CommunityAdapter conformance',
    eventTimeoutMs: opts.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS,
  };
  const { seedRoom, eventTimeoutMs } = resolved;

  async function arrange(): Promise<CommunityArrangement> {
    const adapter = makeAdapter();
    const connection = await adapter.connect();
    const roomId = await seedRoom(adapter);
    return {
      adapter,
      caps: adapter.getCapabilities(),
      roomId,
      identityMemberId: connection.identity?.memberId ?? '',
    };
  }

  async function awaitRoomEvent(
    iterator: AsyncIterator<CommunityRoomEvent>,
    predicate: (event: CommunityRoomEvent) => boolean,
    what: string
  ): Promise<CommunityRoomEvent> {
    const deadline = Date.now() + eventTimeoutMs;
    for (;;) {
      const event = await nextEvent(iterator, what, Math.max(1, deadline - Date.now()));
      if (predicate(event)) return event;
    }
  }

  async function storeSnapshot(
    adapter: CommunityAdapter,
    roomId: string
  ): Promise<CommunityStoreSnapshot> {
    const topLevel = (await adapter.listEntries(roomId, { limit: 500 })).entries;
    // Thread replies are part of the store too. Reading only the top level
    // would leave a refused write that scribbled into a thread invisible.
    const entries = [...topLevel];
    for (const entry of topLevel) {
      entries.push(
        ...(await adapter.listEntries(roomId, { thread: entry.id, limit: 500 })).entries
      );
    }
    // structuredClone, not the values as returned: an adapter that hands back
    // live references to its own store would make a before/after comparison
    // compare an object with itself, and "never a partial write" would assert
    // nothing at all. Cloning here is half the fix — the other half is that a
    // conforming adapter must not hand out live references in the first place.
    return structuredClone({
      rooms: await adapter.listRooms(),
      entries,
      members: await adapter.listMembers(roomId),
    });
  }

  return { makeAdapter, opts: resolved, eventTimeoutMs, arrange, awaitRoomEvent, storeSnapshot };
}

/**
 * One probe per method-gating capability. The `Record` is exhaustive by type,
 * which is the mechanism behind "a new flag is covered the day it is added":
 * adding a member to `COMMUNITY_GATED_CAPABILITIES` fails this file's own
 * typecheck until its refusal is asserted here.
 */
export const GATED_PROBES: Record<CommunityGatedCapability, GatedProbe> = {
  canPost: {
    isOff: (caps) => !caps.canPost,
    calls: (adapter, { roomId }) => [
      { method: 'post', run: () => adapter.post(roomId, { text: 'refused' }) },
    ],
  },
  roomAdmin: {
    isOff: (caps) => !caps.roomAdmin,
    calls: (adapter, { roomId }) => [
      { method: 'createRoom', run: () => adapter.createRoom({ title: 'refused' }) },
      { method: 'updateRoom', run: () => adapter.updateRoom(roomId, { title: 'refused' }) },
      { method: 'addMember', run: () => adapter.addMember(roomId, 'someone-else') },
      { method: 'removeMember', run: () => adapter.removeMember(roomId, 'someone-else') },
    ],
  },
  invite: {
    isOff: (caps) => caps.invite === 'none',
    calls: (adapter) => [{ method: 'createInvite', run: () => adapter.createInvite({}) }],
  },
  agentAdmission: {
    isOff: (caps) => caps.agentAdmission === 'none',
    calls: (adapter) => [
      {
        method: 'admitAgent',
        run: () => adapter.admitAgent({ agentId: 'refused', displayName: 'Refused' }),
      },
      { method: 'revokeAgent', run: () => adapter.revokeAgent('refused') },
    ],
  },
  readCursor: {
    isOff: (caps) => caps.readCursor === 'none',
    calls: (adapter, { roomId }) => [
      { method: 'getReadCursor', run: () => adapter.getReadCursor(roomId) },
      {
        method: 'setReadCursor',
        run: () => adapter.setReadCursor(roomId, 'refused' as CommunityCursor),
      },
    ],
  },
  responseMode: {
    isOff: (caps) => !caps.responseMode,
    calls: (adapter, { roomId, memberId }) => [
      {
        method: 'setResponseMode',
        run: () => adapter.setResponseMode(roomId, memberId, 'silent'),
      },
    ],
  },
  signals: {
    isOff: (caps) => caps.signals === 'none',
    calls: (adapter, { roomId }) => [
      { method: 'publishSignal', run: () => adapter.publishSignal(roomId, 'typing') },
    ],
  },
};
