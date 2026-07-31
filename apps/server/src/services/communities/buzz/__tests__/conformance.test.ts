/**
 * @vitest-environment node
 *
 * The read-only Buzz adapter against the shared `CommunityAdapter` conformance
 * suite — the second backend to clear it, and the first that is not ours.
 *
 * **Nothing in the suite was weakened to let it pass.** That is the claim this
 * file exists to make checkable: the local adapter pushes, addresses by slug,
 * posts, administers rooms, has no roles, holds a server-side read cursor and
 * signals both ways. This one polls, addresses by UUID, refuses every write,
 * declares five roles, has no cursor at all, cannot be admitted without an
 * operator, and threads to unbounded depth. Every one of those differences is a
 * declared flag with a branched assertion, and the run's skips are all
 * declaration-driven.
 *
 * **The suite is registered TWICE, against the two things a relay's `limit` can
 * mean.** NIP-01's convention returns the newest matching events; a plain SQL
 * limit returns the oldest. Which one Buzz does is not something an adapter can
 * ask, so the history walk is written to be correct under either — and running
 * the whole suite both ways is what turns that from a claim into a fact. A walk
 * that quietly assumed one would go green here and lose entries in production.
 *
 * **The fixtures are out-of-band, because a read-only backend's are.** Seeding a
 * room means the relay's admin tool creating a channel and putting our key on it,
 * exactly as `buzz-admin add-member` would — which the suite's own doc names as
 * "the honest cost of that backend rather than a reason to stop testing it".
 */
import { describe, expect, it } from 'vitest';
import { communityConformance } from '@dorkos/test-utils';
import {
  CommunityRoomNotFoundError,
  type CommunityAdapter,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { BuzzCommunityAdapter } from '../buzz-community-adapter.js';
import { deriveBuzzIdentity } from '../buzz-identity.js';
import { FakeBuzzRelay, type LimitSemantics } from './fake-buzz-relay.js';

/**
 * The credential U12 hunts for.
 *
 * It is the real secret here and not a sentinel: the adapter derives its
 * secp256k1 key from this string, so a surface that leaked it would hand a reader
 * the ability to authenticate as this install. The pubkey derived from it appears
 * all over the port's DTOs, which is correct and is exactly the distinction U12
 * has to be able to make.
 */
const PLANTED_CREDENTIAL = 'f'.repeat(63) + '1';

/** Polled fast enough that C13's budget is a second rather than a minute. */
const POLL_INTERVAL_MS = 15;

/** Everything a hook needs, resolved from the adapter the suite handed it. */
interface BuzzFixture {
  relay: FakeBuzzRelay;
  pubkey: string;
}

const fixtures = new WeakMap<CommunityAdapter, BuzzFixture>();

/**
 * Build one adapter over a fresh relay that has already admitted our key.
 *
 * The admission is the point, not a shortcut: this relay requires membership, as
 * every published Buzz deployment does, so `makeAdapter`'s contract — "an adapter
 * that can reach `'connected'` with no setup call in between" — is met by the
 * operator having acted BEFORE the run, which is the real shape of
 * `admission: 'out-of-band'`.
 *
 * @param community - The ref this adapter serves.
 * @param limitSemantics - Which end of a range this relay's `limit` keeps.
 */
function makeAdapterOn(
  community: string,
  limitSemantics: LimitSemantics,
  historyPageSize?: number
): CommunityAdapter {
  const relay = new FakeBuzzRelay({ requireRelayMembership: true, limitSemantics });
  const pubkey = deriveBuzzIdentity(PLANTED_CREDENTIAL).pubkey;
  relay.admitToRelay(pubkey);

  const adapter = new BuzzCommunityAdapter({
    community: community as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    credential: PLANTED_CREDENTIAL,
    openSocket: relay.socketFactory(),
    roomListPollIntervalMs: POLL_INTERVAL_MS,
    connectTimeoutMs: 500,
    ...(historyPageSize === undefined ? {} : { historyPageSize }),
  });
  fixtures.set(adapter, { relay, pubkey });
  return adapter;
}

/** The relay behind one adapter. */
function fixtureFor(adapter: CommunityAdapter): BuzzFixture {
  const fixture = fixtures.get(adapter);
  if (!fixture) throw new Error('no fixture for this adapter');
  return fixture;
}

/**
 * Arrange a readable channel: two top-level messages, one threaded reply, our key
 * on the roster, and a second member so the roster is not a mirror.
 *
 * The reply matters for U9, which builds its known-id set from the top level plus
 * every thread — a room with no reply would let a backend that replayed something
 * it does not hold pass unnoticed.
 *
 * The trailing `listRooms()` is not decoration either. `subscribeRoom` refuses
 * synchronously against the room cache, and a channel created out of band a
 * millisecond ago is not in it until a read happens — the honest cost of
 * `roomList: 'poll'`, and a caller that lists before it subscribes is the shape
 * that cost takes.
 *
 * @param adapter - The adapter to arrange the room on.
 */
async function seedRoom(adapter: CommunityAdapter): Promise<string> {
  const { relay, pubkey } = fixtureFor(adapter);
  const channelId = relay.createChannel({ name: 'engineering', topic: 'Q3 migration' });
  relay.addMember(channelId, pubkey, 'member');
  relay.addMember(channelId, deriveBuzzIdentity('another-member').pubkey, 'owner');

  const first = relay.post({
    channelId,
    authorSecret: 'another-member',
    text: 'the first thing said',
  });
  relay.post({ channelId, authorSecret: 'another-member', text: 'the second thing said' });
  relay.post({
    channelId,
    authorSecret: 'another-member',
    text: 'an answer, inside a thread',
    rootId: first.id,
  });

  await adapter.listRooms();
  return channelId;
}

/** A relay whose socket never opens — the Buzz shape of "the host did not answer". */
function makeUnreachableAdapter(): CommunityAdapter {
  return new BuzzCommunityAdapter({
    community: 'buzz-unreachable' as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    credential: PLANTED_CREDENTIAL,
    openSocket: (_url, handlers) => {
      setTimeout(() => handlers.onClose('connect ECONNREFUSED'), 0);
      return { send: () => {}, close: () => {} };
    },
    connectTimeoutMs: 500,
  });
}

/**
 * A relay that requires membership and has not been told about us — the case
 * `'not-admitted'` exists for, and the one a person can actually act on.
 */
function makeUnadmittedAdapter(): CommunityAdapter {
  const relay = new FakeBuzzRelay({ requireRelayMembership: true });
  return new BuzzCommunityAdapter({
    community: 'buzz-unadmitted' as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    credential: PLANTED_CREDENTIAL,
    openSocket: relay.socketFactory(),
    connectTimeoutMs: 500,
  });
}

/**
 * A relay that has banned this key. Buzz runs its ban gate at NIP-42 auth time
 * and denies the connection outright (`handlers/auth.rs:106-184`), which is a
 * credential refusal and not an admission question — the distinction C17 checks.
 */
function makeUnauthorizedAdapter(): CommunityAdapter {
  const pubkey = deriveBuzzIdentity(PLANTED_CREDENTIAL).pubkey;
  const relay = new FakeBuzzRelay({ banned: [pubkey] });
  return new BuzzCommunityAdapter({
    community: 'buzz-banned' as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    credential: PLANTED_CREDENTIAL,
    openSocket: relay.socketFactory(),
    connectTimeoutMs: 500,
  });
}

/**
 * The three registrations, and what each one is and is NOT for.
 *
 * The first two vary what a relay's `limit` means. The third holds that constant
 * and shrinks the page instead, so every historical read comes back saturated and
 * the walk's window narrowing runs on every call rather than never.
 *
 * **That third one exercises the walk; it does not assert anything about it**,
 * and the distinction is not pedantic. This suite has no independent view of a
 * room — U8 compares the adapter's paged walk against the adapter's own wide
 * read, U6 compares a resume against the same — so a walk that silently drops
 * half the history is self-consistent and passes every assertion here. Both
 * mutations that broke the walk during development (dropping the above-probe,
 * and narrowing to an inclusive ceiling) leave all 98 of these green. What
 * catches them is a fixture that knows what it wrote:
 * `buzz-community-adapter.test.ts` seeds a known set of entries and demands
 * exactly those back, and `buzz-history.test.ts` drives the walk directly.
 *
 * Running the walk still earns its place — a crash, a hang or a thrown refusal
 * shows up here — but read this registration as coverage of the code path, not
 * as a correctness gate.
 */
const REGISTRATIONS: { limitSemantics: LimitSemantics; historyPageSize?: number }[] = [
  { limitSemantics: 'newest' },
  { limitSemantics: 'oldest' },
  { limitSemantics: 'newest', historyPageSize: 2 },
];

for (const { limitSemantics, historyPageSize } of REGISTRATIONS) {
  communityConformance(() => makeAdapterOn('buzz-primary', limitSemantics, historyPageSize), {
    name: `BuzzCommunityAdapter — conformance (limit keeps the ${limitSemantics}${
      historyPageSize === undefined ? '' : `, page size ${historyPageSize}`
    })`,
    plantedCredential: PLANTED_CREDENTIAL,
    seedRoom,
    makeUnreachableAdapter,
    // A channel the relay's admin tool made and nobody has said anything in —
    // which this adapter cannot arrange for itself, because arranging it would
    // be a write.
    seedEmptyRoom: async (adapter) => {
      const channelId = fixtureFor(adapter).relay.createChannel({ name: 'nothing-said-here' });
      await adapter.listRooms();
      return channelId;
    },
    makeUnadmittedAdapter,
    makeUnauthorizedAdapter,
    secondCommunity: () => makeAdapterOn('buzz-secondary', limitSemantics, historyPageSize),
    // Archiving is how a Buzz channel stops being servable mid-subscription: it
    // evicts every live subscription. The arranged reason is 'unknown' and that
    // is the assertion — the relay emits ONE string for archiving and for an
    // open-to-private flip, so an adapter that answered 'archived' would tell a
    // member who just lost access that the room was put away.
    makeEvictedRoom: (adapter, roomId) => {
      fixtureFor(adapter).relay.archiveChannel(roomId);
      return Promise.resolve('unknown');
    },
  });
}

describe('BuzzCommunityAdapter fixtures', () => {
  it('plants a credential the suite can actually look for', async () => {
    // A leakage assertion is only as good as the secret behind it. This pins
    // that the planted string genuinely IS the key material — so U12 proves the
    // adapter drops it, not that nothing ever held it.
    const adapter = makeAdapterOn('buzz-primary', 'newest');
    const connection = await adapter.connect();
    expect(connection.status).toBe('connected');
    expect(
      connection.identity?.memberId,
      'the connected identity is the pubkey this credential derives'
    ).toBe(deriveBuzzIdentity(PLANTED_CREDENTIAL).pubkey);
    expect(connection.identity?.memberId, 'and the pubkey is emphatically not the secret').not.toBe(
      PLANTED_CREDENTIAL
    );
    await adapter.disconnect();
  });

  it('refuses to stream a channel the relay has never shown it', async () => {
    // The eager-throw path over a poll-shaped backend: a room the cache has
    // never seen is refused at call time, awaiting nothing.
    const adapter = makeAdapterOn('buzz-primary', 'newest');
    await adapter.connect();
    expect(() => adapter.subscribeRoom('00000000-0000-4000-8000-000000009999')).toThrow(
      CommunityRoomNotFoundError
    );
    await adapter.disconnect();
  });
});
