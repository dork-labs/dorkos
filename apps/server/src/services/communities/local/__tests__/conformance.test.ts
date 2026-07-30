/**
 * @vitest-environment node
 *
 * The local rooms backend against the shared `CommunityAdapter` conformance
 * suite — the same gate a Buzz relay and `apps/community` will each clear, and
 * the first time it is run against something other than the reference fake.
 *
 * Everything below the adapter is the real thing: the real `RoomService`, the
 * real store over a real (in-memory) SQLite with every migration applied, the
 * real author registry, the real broadcaster, and the real `eventFanOut` the
 * room-list stream reads. Only the turn runner stands in, because the
 * alternative is a model call — and it is scripted to say nothing, so a seeded
 * room holds exactly the entries this file put in it.
 *
 * **The four hooks this backend declines, and why each is a decision:**
 *
 * - `makeUnadmittedAdapter` / `makeUnauthorizedAdapter` — you cannot be refused
 *   admission to your own machine. `admission: 'open'`, `credential: 'none'`,
 *   and `connect` has two reachable outcomes. Both cases register a named skip.
 * - `secondCommunity` — a second LOCAL community cannot exist: `'local'` is a
 *   reserved ref and this process has one room store. The cross-community
 *   rejection is asserted directly in `local-community-adapter.test.ts` instead,
 *   against a hand-built foreign cursor, which is the only way that value can
 *   arise here.
 * - `revokeOwner` / `seedAgentEntry` — both belong to agent admission, which
 *   this backend declares `'none'`; the suite skips those cases on the
 *   declaration alone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { communityConformance } from '@dorkos/test-utils';
import type { CommunityAdapter } from '@dorkos/shared/community-adapter';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { RoomStore } from '../../../rooms/room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { LocalCommunityAdapter } from '../local-community-adapter.js';
import { localCommunityIdentity } from '../register-local-community.js';

/**
 * The agent directory this install knows about — and the string U12 hunts for.
 *
 * A local adapter holds no credential, so the leakage assertion would be
 * vacuous against a sentinel nobody stores. This is the value that IS secret
 * here: `authors.natural_key` for an agent is its absolute directory, and
 * `author-registry.ts` exists to keep it off a shared surface. Planting it in a
 * room's roster gives U12 something real to find.
 */
const PLANTED_AGENT_PATH = '/Users/planted/agents/ana';

/** Everything a hook needs, resolved from the adapter the suite handed it. */
interface LocalFixture {
  harness: RoomHarness;
  store: RoomStore;
}

const fixtures = new WeakMap<CommunityAdapter, LocalFixture>();

/** Unique channel titles, so seeding twice in one test never collides on a slug. */
let seeded = 0;

/**
 * Build one adapter over a fresh in-memory install, ready to connect.
 *
 * `localCommunityIdentity` is the production resolver, not a stub: with no
 * accounts it answers with the unbound `'local'` author, which is the posture
 * every install starts in.
 */
function makeAdapter(): CommunityAdapter {
  const harness = createRoomHarness({
    agents: agentLookupFor({ [PLANTED_AGENT_PATH]: { name: 'Ana' } }),
    // Says nothing, ever. A room that answered itself would make "how many
    // entries does this room hold" a race.
    runner: scriptedRunner(() => null),
  });
  const store = new RoomStore(harness.db);
  const adapter = new LocalCommunityAdapter({
    service: harness.service,
    store,
    resolveIdentity: localCommunityIdentity(harness.authors),
  });
  fixtures.set(adapter, { harness, store });
  return adapter;
}

/** The install behind one adapter. */
function fixtureFor(adapter: CommunityAdapter): LocalFixture {
  const fixture = fixtures.get(adapter);
  if (!fixture) throw new Error('no fixture for this adapter');
  return fixture;
}

/**
 * Arrange a readable channel: two top-level entries, one thread reply, and an
 * agent on the roster.
 *
 * The reply is not decoration. U9 builds its known-id set from the top level
 * PLUS every thread it holds, and a replay legitimately carries both — a room
 * seeded only with top-level entries would let a backend that replayed
 * something it does not hold pass unnoticed.
 *
 * The agent joins **after** the posts and joins `'silent'`: it is here to be a
 * roster row U12 can inspect, not a participant, and an agent that answered
 * would put entries in this room that no assertion accounted for.
 */
async function seedRoom(adapter: CommunityAdapter): Promise<string> {
  const { harness } = fixtureFor(adapter);
  seeded += 1;
  const room = await adapter.createRoom({ title: `Room ${seeded}` });
  const first = await adapter.post(room.roomId, { text: 'the first thing said' });
  await adapter.post(room.roomId, { text: 'the second thing said' });
  await adapter.post(room.roomId, {
    text: 'an answer, inside a thread',
    parentEntryId: first.entryId,
  });
  harness.service.addMember(room.roomId, harness.human, {
    agentPath: PLANTED_AGENT_PATH,
    responseMode: 'silent',
  });
  return room.roomId;
}

/**
 * An install whose store will not answer — the local shape of "the host did not
 * answer". Closing the connection is not a simulation: every read this adapter
 * makes goes through it, so `connect` meets exactly the failure a corrupt or
 * locked database would produce.
 */
function makeUnreachableAdapter(): CommunityAdapter {
  const adapter = makeAdapter();
  fixtureFor(adapter).harness.db.$client.close();
  return adapter;
}

communityConformance(makeAdapter, {
  name: 'LocalCommunityAdapter — conformance',
  plantedCredential: PLANTED_AGENT_PATH,
  seedRoom,
  makeUnreachableAdapter,
  // Archiving is how a local room stops being servable: it refuses every
  // further entry, in a member's voice and in the room's own, so a live
  // subscription has nothing left to deliver and says so.
  makeEvictedRoom: async (adapter, roomId) => {
    await adapter.updateRoom(roomId, { archived: true });
    return 'archived';
  },
});

describe('LocalCommunityAdapter fixtures', () => {
  beforeEach(() => {
    seeded = 0;
  });

  it('plants a credential the suite can actually look for', async () => {
    // A leakage assertion is only as good as the secret behind it. This pins
    // that the planted path is genuinely stored — so U12 is checking that the
    // adapter drops it, not that nothing ever held it.
    const adapter = makeAdapter();
    await adapter.connect();
    const roomId = await seedRoom(adapter);
    const { harness } = fixtureFor(adapter);

    const stored = new AuthorRegistry(harness.db)
      .getMany((await adapter.listMembers(roomId)).map((m) => m.memberId))
      .values();
    expect(
      [...stored].map((author) => author.naturalKey),
      "the agent's directory is in this install's author table"
    ).toContain(PLANTED_AGENT_PATH);
  });
});
