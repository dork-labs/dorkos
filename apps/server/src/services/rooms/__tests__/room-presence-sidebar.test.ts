/**
 * What a reader who is NOT in the room is told about the work in it.
 *
 * The room's own presence signals reach one audience: whoever has that room
 * open. A sidebar draws every room at once, so the dot on a row rides the
 * global fan-out instead — `room_presence`, a bare `{ roomId, working }` count
 * published from the same claim transitions and the same republish tick
 * (room-presence spec §6).
 *
 * Three properties are pinned here, and each is a way the dot could lie:
 *
 * 1. **The count moves with the claims**, and only when it actually moves — a
 *    room that goes busy says so once, not once per claim.
 * 2. **The tick re-states it**, because the global stream has no replay and a
 *    reader who opened the cockpit after the turn started would otherwise never
 *    hear about it.
 * 3. **The room list agrees**, so a fresh page load draws its dots without
 *    waiting up to ten seconds for that tick.
 *
 * The events are observed through `eventFanOut.subscribe`, which is the same
 * in-process seam the local community adapter reads — the real broadcast, not a
 * mock of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  type GatedRunner,
} from './room-test-harness.js';
import { claimsWorkingIn, type ActiveClaim } from '../room-claims.js';

/** The agents these rooms are built from. */
const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('the sidebar is told which rooms have an agent working', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: GatedRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let bo: string;
  /** Every `room_presence` event the fan-out carried, in order. */
  let counts: Array<{ roomId: string; working: number }> = [];
  let unsubscribe = (): void => {};

  beforeEach(() => {
    runner = gatedRunner();
    ({ service, authors, human } = createRoomHarness({ agents, runner }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    // `mention-only` for the same reason the claim tests use it: a channel seeds
    // `engaged`, so a second message would re-trigger an agent whose turn is
    // still held and a scenario about one claim would measure two.
    for (const authorId of [ana, bo])
      service.updateMembership(room.id, human, authorId, 'mention-only');
    counts = [];
    unsubscribe = eventFanOut.subscribe((name, data) => {
      if (name === 'room_presence') counts.push(data as { roomId: string; working: number });
    });
  });

  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  /** Wait until `ready` holds, letting the dispatcher's promises run. */
  async function settleUntil(ready: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (ready()) return;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('says a room went busy, and says it once', async () => {
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await settleUntil(() => counts.length > 0, 'the room to report an agent working');

    expect(counts).toEqual([{ roomId: room.id, working: 1 }]);
  });

  it('counts the second agent, and counts them down again as each finishes', async () => {
    service.post(room.id, { authorId: human, text: '@ana @bo can you two look at this?' });
    await settleUntil(() => counts.length === 2, 'both agents claimed');
    expect(counts.map((event) => event.working)).toEqual([1, 2]);

    runner.release(ana);
    await settleUntil(() => counts.length === 3, "Ana's answer to land");
    // One agent finishing is not the room going quiet — the dot stays up for Bo.
    expect(counts.at(-1)).toEqual({ roomId: room.id, working: 1 });

    runner.release(bo);
    await service.triggersIdle();
    expect(counts.at(-1)).toEqual({ roomId: room.id, working: 0 });
  });

  it('does not repaint the dot for a second question the busy agent has not reached yet', async () => {
    // Two questions to one agent, the second arriving while the first turn is
    // still running. Since RP8 that second one is HELD rather than refused — it
    // rides Ana's next turn — but either way there is no second claim while the
    // first is up, so there is nothing for the sidebar to redraw: the dot was
    // already there, and it means the same thing it meant a moment ago.
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await settleUntil(() => runner.turns.length === 1, 'Ana handed her first turn');
    expect(counts).toEqual([{ roomId: room.id, working: 1 }]);

    service.post(room.id, { authorId: human, text: '@ana and the migration?' });
    // Absence is never the condition. Bo is asked next and answers, and his turn
    // running is the proof that the room has finished deciding about Ana's
    // second message — whatever it decided.
    service.post(room.id, { authorId: human, text: '@bo anything from you?' });
    await settleUntil(() => runner.turns.length === 2, 'Bo handed a turn of his own');

    expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
    // Two agents working now, and the room said so once — never twice for Ana.
    expect(counts).toEqual([
      { roomId: room.id, working: 1 },
      { roomId: room.id, working: 2 },
    ]);

    // And when Ana's turn ends, the held question becomes her next one rather
    // than disappearing — so the dot only reaches zero once everything the room
    // was asked has actually run.
    runner.release(ana);
    await settleUntil(
      () => runner.turns.filter((turn) => turn.authorId === ana).length === 2,
      'the held question to become Ana second turn'
    );
    expect(runner.turns.filter((turn) => turn.authorId === ana)[1].prompt).toBe(
      '@ana and the migration?'
    );
    runner.release(ana);
    runner.release(bo);
    await service.triggersIdle();
    expect(counts.at(-1)).toEqual({ roomId: room.id, working: 0 });
  });

  it('re-states the count on the tick, so a reader who arrived late still sees the dot', async () => {
    // The global stream has no replay. Without this repaint, opening the cockpit
    // one second after a turn started would show an idle sidebar for as long as
    // the turn ran — which is the whole hour, at the ceiling.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    service.post(room.id, { authorId: human, text: '@ana @bo can you two look at this?' });
    await vi.waitFor(() => expect(counts).toHaveLength(2));

    counts = [];
    await vi.advanceTimersByTimeAsync(10_000);

    // One event for the ROOM, not one per claim: the sidebar draws a count.
    expect(counts).toEqual([{ roomId: room.id, working: 2 }]);

    runner.releaseAll();
    vi.useRealTimers();
    await service.triggersIdle();
  });

  it('stops re-stating once the room is quiet', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await vi.waitFor(() => expect(counts).toHaveLength(1));
    runner.release(ana);
    await vi.waitFor(() => expect(counts.at(-1)?.working).toBe(0));

    counts = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(counts).toEqual([]);
    vi.useRealTimers();
  });

  it('carries the count on the room list, so a fresh page load draws its dots', async () => {
    expect(service.listRooms(human).map((summary) => summary.working)).toEqual([0]);

    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    // Waits on the TURN rather than on the event, so this reads the claim map
    // through the list even if nothing were ever broadcast.
    await settleUntil(() => runner.turns.length > 0, 'Ana handed a turn');
    expect(service.listRooms(human).map((summary) => summary.working)).toEqual([1]);

    runner.release(ana);
    await service.triggersIdle();
    // Back to a number, not to absent: "nobody is working" is something this
    // server always knows, so there is never a reason to omit it.
    expect(service.listRooms(human).map((summary) => summary.working)).toEqual([0]);
  });
});

/**
 * What a reader who OPENS the room is told about the work in it (DOR-786).
 *
 * The sidebar's count above answers "is anything happening in that room". This
 * answers "who", for the surface looking at the room itself — and it exists
 * because presence used to be ephemeral-only: a room opened mid-turn drew
 * nothing until the dispatcher's next republish, up to ten seconds later, and the
 * details sheet opened over a room whose stream it does not have drew nothing
 * ever. ADR 260824-120019 has the reversal; this is the server half of it.
 *
 * Every assertion here names an AGENT, not a count, and reads it back through the
 * two paths a client actually arrives on — the room GET and the SSE hydration
 * snapshot. Both go through `withRoster`, which is the point of putting it there,
 * and a test that only checked one would not notice if they diverged.
 */
describe('a room read says who is working in it', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: GatedRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let bo: string;

  beforeEach(() => {
    runner = gatedRunner();
    ({ service, authors, human } = createRoomHarness({ agents, runner }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    for (const authorId of [ana, bo])
      service.updateMembership(room.id, human, authorId, 'mention-only');
  });

  afterEach(() => {
    runner.releaseAll();
  });

  /** Wait until `ready` holds, letting the dispatcher's promises run. */
  async function until(ready: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (ready()) return;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('names the agent mid-turn, and says when its turn started', async () => {
    expect(service.getRoom(room.id, human)?.workingAgents).toEqual([]);

    const before = new Date().toISOString();
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await until(() => runner.turns.length === 1, 'Ana handed a turn');

    const working = service.getRoom(room.id, human)?.workingAgents ?? [];
    // The AGENT, not a count — this is what lets the sheet put a working dot on
    // the right roster row on its first paint.
    expect(working.map((claim) => claim.authorId)).toEqual([ana]);
    // And when its turn started, so a room opened four minutes in draws `4m`
    // rather than `0s` corrected a second later. A real timestamp from the claim,
    // bounded by the clock either side of it rather than matched loosely.
    expect(working[0].since >= before).toBe(true);
    expect(working[0].since <= new Date().toISOString()).toBe(true);

    runner.release(ana);
    await service.triggersIdle();
    // Back to `[]`, not to absent: "nobody is working" is something this server
    // always knows, so there is never a reason to omit it.
    expect(service.getRoom(room.id, human)?.workingAgents).toEqual([]);
  });

  it('says the same thing on the SSE hydration snapshot a cold connect opens with', async () => {
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await until(() => runner.turns.length === 1, 'Ana handed a turn');

    // The other way a client arrives at a room, and the one the spec's resolved
    // question was actually about. Both are built by `withRoster`, and this is
    // what would go red if somebody moved the field onto the GET alone.
    const snapshot = service.snapshot(room.id, human, 50);
    expect(snapshot.room.workingAgents?.map((claim) => claim.authorId)).toEqual([ana]);
    expect(snapshot.room.workingAgents).toEqual(service.getRoom(room.id, human)?.workingAgents);
  });

  it('lists both agents oldest-claim-first when two are working', async () => {
    service.post(room.id, { authorId: human, text: '@ana can you start?' });
    await until(() => runner.turns.length === 1, 'Ana handed a turn');
    service.post(room.id, { authorId: human, text: '@bo you too?' });
    await until(() => runner.turns.length === 2, 'Bo handed a turn');

    const working = service.getRoom(room.id, human)?.workingAgents ?? [];
    expect(working).toHaveLength(2);
    // Ana claimed first, so Ana is first — the order a reader scans, and the same
    // one the app's own presence line uses.
    //
    // **This case does not, on its own, prove the sort is doing anything**, and
    // saying so is the point: through the dispatcher, a live claim map's
    // insertion order already equals its claim order, because releasing DELETES
    // the key and re-claiming appends it. So both orderings agree here, and this
    // assertion would survive the sort being deleted. What the sort actually
    // decides is pinned directly on the pure function below.
    expect(working.map((claim) => claim.authorId)).toEqual([ana, bo]);
    expect(working[0].since <= working[1].since).toBe(true);
  });

  it('says nothing about work in a room the reader cannot see', () => {
    // The field rides `withRoster`, which is reached only through the visibility
    // check — so this is really a test that adding it did not open a side door.
    const outsider = authors.resolveAgent('/agents/bo', 'Bo').id;
    const priv = service.createRoom(
      { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(service.getRoom(priv.id, outsider)).toBeNull();
  });
});

/**
 * The published "oldest claim first" promise, pinned where it can actually fail.
 *
 * `claimsWorkingIn` is an exported pure function over a read-only view of the
 * claim map, and its TSDoc promises an order. The end-to-end case above cannot
 * test that promise: through the dispatcher, insertion order and claim order are
 * the same thing — releasing DELETES the key and re-claiming appends it, so a
 * finished-and-reclaimed agent lands at the end under both orderings. Deleting
 * the sort therefore leaves the whole room suite green, which is exactly the
 * "verification that cannot fail" this repo catalogues.
 *
 * So the two things the sort really decides are asserted on the function itself,
 * with a map built to disagree. That is legitimate rather than artificial: the
 * promise is made by an exported function about its own output, and a caller
 * must not have to preserve insertion order for it to hold.
 */
describe('claimsWorkingIn keeps its ordering promise', () => {
  /** One claim, with only the fields this function reads made interesting. */
  function claim(authorId: string, claimedAt: string): ActiveClaim {
    return {
      roomId: 'room-1',
      cascadeRoot: 'entry-root',
      authorId,
      agentPath: `/agents/${authorId}`,
      entryId: 'entry-1',
      dispatchId: `dsp_${authorId}`,
      depth: 1,
      aside: false,
      spokeViaTool: false,
      claimedAt,
      pastDeadline: false,
      activityPublishedAt: 0,
    };
  }

  it('sorts by when the turn started, not by the order the map happens to hold', () => {
    // Built backwards on purpose: `bo` was inserted first and started LATER.
    const claims = new Map<string, ActiveClaim>([
      ['room-1\u0000bo', claim('bo', '2026-08-28T10:05:00.000Z')],
      ['room-1\u0000ana', claim('ana', '2026-08-28T10:00:00.000Z')],
    ]);

    expect(claimsWorkingIn(claims, 'room-1').map((row) => row.authorId)).toEqual(['ana', 'bo']);
  });

  it('breaks a same-millisecond tie on the author id, so two reads never disagree', () => {
    // The reachable half: two agents triggered by one message claim in the same
    // sweep and can share a millisecond. Without the tiebreak their order is
    // whatever the roster happened to produce, and a room drawn twice could
    // swap them with nothing having changed.
    const together = '2026-08-28T10:00:00.000Z';
    const claims = new Map<string, ActiveClaim>([
      ['room-1\u0000zoe', claim('zoe', together)],
      ['room-1\u0000ana', claim('ana', together)],
    ]);

    expect(claimsWorkingIn(claims, 'room-1').map((row) => row.authorId)).toEqual(['ana', 'zoe']);
  });

  it('answers only for the room asked about', () => {
    const claims = new Map<string, ActiveClaim>([
      ['room-1\u0000ana', claim('ana', '2026-08-28T10:00:00.000Z')],
      ['room-2\u0000bo', { ...claim('bo', '2026-08-28T09:00:00.000Z'), roomId: 'room-2' }],
    ]);

    expect(claimsWorkingIn(claims, 'room-1').map((row) => row.authorId)).toEqual(['ana']);
  });
});
