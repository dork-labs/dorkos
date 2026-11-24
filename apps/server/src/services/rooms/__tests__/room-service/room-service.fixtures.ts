/**
 * Shared setup for the `RoomService` suites in this folder.
 *
 * @module server/services/rooms/__tests__/room-service/room-service.fixtures
 */
import { expect, vi } from 'vitest';
import { agentLookupFor, createRoomHarness, roomSpec } from '../room-test-harness.js';

/** Ana answers everything by manifest; Bo stays quiet unless mentioned. */
export const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always', emoji: '🐙' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'silent' },
  // Two more bodies, so a roster whose order is left to chance has 120 ways to
  // come out and cannot match the expected one by luck.
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'silent' },
  '/agents/di': { name: 'di', displayName: 'Di', responseMode: 'silent' },
});

/**
 * How many statements whose SQL contains `sqlPart` one room listing prepares,
 * over an install holding `count` rooms of `kind`.
 *
 * Counted off `better-sqlite3.prepare`, because the property under test — that
 * a listing reads in one pass, not once per room — is invisible in the value
 * returned: the same data comes back either way. A DM is listed with the
 * `kind: 'dm'` filter the sidebar uses; channels are listed unfiltered.
 *
 * @param kind - The kind of room to seed and list.
 * @param count - How many rooms to seed first.
 * @param sqlPart - Text that marks the statements being counted.
 */
export function listingReads(kind: 'channel' | 'dm', count: number, sqlPart: string): number {
  // A DM per AGENT, not `count` DMs with the same agent: a direct message is
  // idempotent on its member set, so asking for Ana 25 times is one room and
  // this measurement would quietly become "listing one room, twice".
  const cast = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `/agents/extra-${i}`,
      { name: `extra-${i}`, displayName: `Extra ${i}` },
    ])
  );
  const harness = createRoomHarness({ agents: agentLookupFor(cast) });
  for (let i = 0; i < count; i++) {
    const agentPaths = kind === 'dm' ? [`/agents/extra-${i}`] : [];
    harness.service.createRoom(roomSpec(kind, `Room ${i}`, agentPaths), harness.human);
  }
  const filter = kind === 'dm' ? { kind } : undefined;
  // The whole measurement is void if the seeding did not produce `count` rooms.
  expect(harness.service.listRooms(harness.human, filter)).toHaveLength(count);
  // `$client` is the better-sqlite3 connection drizzle prepares against.
  const sqlite = (harness.db as unknown as { $client: { prepare: (sql: string) => unknown } })
    .$client;
  const prepare = vi.spyOn(sqlite, 'prepare');
  harness.service.listRooms(harness.human, filter);
  const reads = prepare.mock.calls.filter(([sql]) => String(sql).includes(sqlPart)).length;
  prepare.mockRestore();
  return reads;
}
