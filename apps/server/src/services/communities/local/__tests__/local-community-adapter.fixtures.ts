/**
 * Shared setup for the local-community-adapter suites: everything the original file declared or
 * registered outside its tests.
 */
import { RoomStore } from '../../../rooms/room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { LocalCommunityAdapter } from '../local-community-adapter.js';
import { localCommunityIdentity } from '../register-local-community.js';

/** The one agent this file can put on a roster, for the cases that need a second member. */
export const AGENT_PATH = '/Users/planted/agents/ana';

/** A second agent, for the cases that need a room the identity under test is NOT in. */
export const OTHER_AGENT_PATH = '/Users/planted/agents/other';

/** One adapter over one fresh in-memory install. */
export function setup(): {
  adapter: LocalCommunityAdapter;
  harness: RoomHarness;
  store: RoomStore;
} {
  const harness = createRoomHarness({
    agents: agentLookupFor({ [AGENT_PATH]: { name: 'Ana' } }),
    runner: scriptedRunner(() => null),
  });
  const store = new RoomStore(harness.db);
  const adapter = new LocalCommunityAdapter({
    service: harness.service,
    store,
    // The production resolver, not a stub — it reads the store, which is what
    // makes "the store will not answer" reachable below.
    resolveIdentity: localCommunityIdentity(harness.authors),
  });
  return { adapter, harness, store };
}

/** A room id no install holds — what a caller probing for someone else's room has. */
export const ABSENT = 'no-such-room-id';

/**
 * The error a synchronous refusal threw, or a failure naming what came back
 * instead. A returned stream is the wrong answer as loudly as a wrong error is.
 *
 * @param call - The call that must refuse at call time.
 */
export function refusalFrom(call: () => unknown): Error {
  try {
    call();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal at call time; the call returned instead');
}

/**
 * An error's own enumerable properties, with the room id it was asked about
 * normalized away — so two refusals about two different rooms are comparable on
 * everything except the address each was handed.
 *
 * @param err - The refusal to read.
 * @param roomId - The id to normalize out of every string value.
 */
export function ownShape(err: Error, roomId: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(err).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.replaceAll(roomId, '<id>') : value,
    ])
  );
}

/** A channel with two entries, opened through the port. */
export async function seed(adapter: LocalCommunityAdapter, title = 'Backend'): Promise<string> {
  const room = await adapter.createRoom({ title });
  await adapter.post(room.roomId, { text: 'one' });
  await adapter.post(room.roomId, { text: 'two' });
  return room.roomId;
}
