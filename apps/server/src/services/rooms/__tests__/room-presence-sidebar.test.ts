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
import type { RoomTurnRequest, RoomTurnResult } from '../room-trigger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { agentLookupFor, createRoomHarness, type ScriptedTurnRunner } from './room-test-harness.js';

/** The agents these rooms are built from. */
const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/** A runner whose turns only finish when the test says so. */
interface GatedRunner extends ScriptedTurnRunner {
  /** Let one agent's oldest held turn answer now. */
  release(authorId: string): void;
  /** Let every held turn answer now. */
  releaseAll(): void;
}

/**
 * Build a runner that holds every turn open until released.
 *
 * Holding is what makes a claim observable at all: a turn that answered would
 * have taken and released its claim inside one `await`, and every count in
 * between would be a thing the test never got to look at.
 */
function gatedRunner(): GatedRunner {
  const turns: ScriptedTurnRunner['turns'] = [];
  // Queued per agent, not keyed by it: a map that overwrote would silently drop
  // a second turn, and one of the scenarios below is about proving a second turn
  // never starts. A runner that cannot hold two agrees with a dispatcher that
  // runs two.
  const gates = new Map<string, Array<() => void>>();
  return {
    turns,
    interrupted: [],
    interrupt: () => Promise.resolve(),
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      return new Promise<RoomTurnResult>((resolve) => {
        const queued = gates.get(request.authorId) ?? [];
        queued.push(() => resolve({ sessionId: request.sessionId ?? 'session-1', text: 'on it' }));
        gates.set(request.authorId, queued);
      });
    },
    release(authorId) {
      const queued = gates.get(authorId);
      const gate = queued?.shift();
      if (!gate) throw new Error(`no held turn for ${authorId}`);
      gate();
    },
    releaseAll() {
      for (const queued of [...gates.values()]) {
        for (const gate of queued.splice(0)) gate();
      }
    },
  };
}

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

  it('does not repaint the dot for a second question the busy agent never takes', async () => {
    // Two questions to one agent, the second arriving while the first turn is
    // still running. The room refuses it — one turn per agent per room — and
    // says so in a notice, so there is no second claim, no second turn, and
    // nothing for the sidebar to redraw: the dot was already up, and it means
    // the same thing it meant a moment ago.
    service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
    await settleUntil(() => runner.turns.length === 1, 'Ana handed her first turn');
    expect(counts).toEqual([{ roomId: room.id, working: 1 }]);

    service.post(room.id, { authorId: human, text: '@ana and the migration?' });
    await settleUntil(
      () => service.listEntries(room.id, human, { limit: 20 }).some((e) => e.kind === 'notice'),
      'the room to say Ana is busy'
    );

    expect(runner.turns).toHaveLength(1);
    expect(service.listRooms(human).map((summary) => summary.working)).toEqual([1]);
    expect(counts).toEqual([{ roomId: room.id, working: 1 }]);

    // And the one turn there is takes the dot down with it when it ends.
    runner.release(ana);
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
