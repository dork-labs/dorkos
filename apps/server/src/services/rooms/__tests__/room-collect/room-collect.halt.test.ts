/**
 * room-collect: halting and stopping one agent drop what was gathered; one clock across rooms.
 * The suite's full rationale is on `room-collect.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { RoomCollector } from '../../room-collect.js';
import { scriptedRunner, settleUntil } from '../room-test-harness.js';

import {
  ana,
  authors,
  DEBOUNCE_MS,
  heldRunner,
  human,
  notices,
  open,
  postsBy,
  room,
  runner,
  service,
  type HeldRunner,
} from './room-collect.fixtures.js';

describe('a room gathers a burst into one turn', () => {
  describe('halt', () => {
    it('drops the gathered messages as well as the running turns', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      // Held behind the claim — no window is counting for it at all — and it
      // would become Ana's next turn if the room were left alone.
      service.post(room.id, { authorId: human, text: '@ana and the migration?' });

      const stopped = await service.haltRoom(room.id, human);
      expect(stopped).toBe(1);
      expect(held.interrupted).toHaveLength(1);

      // The claim is gone, so nothing is holding the gathered message back — and
      // it still does not run, because the halt dropped it. `triggersIdle`
      // resolving at all is half the assertion: a dropped collection that kept
      // its accounting would never let the room settle.
      await service.triggersIdle();
      expect(runner.turns).toHaveLength(1);
      const halted = notices().filter((entry) => entry.body.notice === 'halted');
      expect(halted).toHaveLength(1);
    });

    it('drops the gathered messages BEFORE it releases any claim', async () => {
      // **The ordering, pinned with a runtime that takes its time stopping.**
      // Releasing a claim is what runs a held batch, so a halt that dropped the
      // buffers after the release loop would start those turns one macrotask
      // later — answering, seconds after Stop, exactly the messages the person
      // pressed it over.
      //
      // Two things make that reachable and neither is decoration. TWO agents,
      // so there is a second `await` inside the loop for the first agent's
      // resumed batch to fire during; and an `interrupt` that yields for real
      // rather than resolving on a microtask, because the resume rides a
      // `setTimeout(0)` and a loop that only awaits microtasks completes before
      // any macrotask runs — which would let a broken order pass.
      const held = heldRunner();
      const slow: HeldRunner = {
        ...held,
        async interrupt(request) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return held.interrupt(request);
        },
      };
      open(slow, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo can you both look?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );
      // One held message apiece, so either agent's release could start a turn.
      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      service.post(room.id, { authorId: human, text: '@bo and the cache?' });

      const stopped = await service.haltRoom(room.id, human);
      expect(stopped).toBe(2);

      // **Asserted the instant the halt returns, before anything is awaited.**
      // A resumed batch fires DURING the halt's own interrupt await, so by the
      // time this line runs a wrong order has already started the turn — and
      // asserting after `triggersIdle()` would meet it as a hang rather than as
      // a countable third turn.
      expect(runner.turns).toHaveLength(2);
      expect(runner.turns.map((turn) => turn.prompt)).toEqual([
        '@ana @bo can you both look?',
        '@ana @bo can you both look?',
      ]);

      // And it stays two: nothing is waiting to start.
      await service.triggersIdle();
      expect(runner.turns).toHaveLength(2);
    });

    it('drops a window that has not closed yet, so nothing answers a stopped room', async () => {
      // A gathering window is work the room is about to do. Leaving it would
      // answer, half a second later, the very messages the person pressed Stop
      // over.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      const stopped = await service.haltRoom(room.id, human);

      expect(stopped).toBe(0);
      await service.triggersIdle();
      expect(runner.turns).toEqual([]);
    });

    it('runs a normal turn for a message whose text is exactly "stop"', async () => {
      // **This test is the guard on the rule**, not a description of a feature.
      // Halting is a control action — a button and a route — and nothing
      // anywhere pattern-matches a message for it. In the Hermes loop incident
      // of 26 May 2026 an operator typed "you are in a loop, stop" and the bot
      // answered it as one more conversational turn; inferring the verb from
      // text would be that same failure wearing the opposite clothes, because
      // the model would then be the thing deciding whether to obey.
      //
      // `room-stopped-turns.test.ts` pins the same rule from the other side.
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      service.post(room.id, { authorId: human, text: 'stop' });
      service.post(room.id, { authorId: human, text: '@ana stop' });
      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the ordinary next turn');

      // Not interrupted, not halted, and no notice — just another message.
      expect(held.interrupted).toEqual([]);
      expect(notices()).toHaveLength(0);
      expect(runner.turns[1].prompt).toBe('@ana stop');
      held.release(ana);
      await service.triggersIdle();
    });
  });

  describe('stopping one agent', () => {
    it('drops every batch that agent was waiting on, including one the cap already closed', async () => {
      // **Why `dropOne` hands back a LIST.** At a cap of one, two messages in a
      // tick leave two collections under one `(room, agent)` key: the cap takes
      // the first out of the map and parks it for a macrotask, and the second
      // opens a fresh one behind it. Both are turns this room has not taken and
      // both hold one of the dispatcher's in-flight credits, so a drop that
      // handed back only one would leak the other's — and `triggersIdle()` would
      // never resolve again. Its resolving here is half of this assertion.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 1 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;
      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      service.post(room.id, { authorId: human, text: '@ana and so is the deploy' });
      service.post(room.id, { authorId: human, text: '@bo what about the cache?' });

      expect(await service.haltAgent(room.id, ana, human)).toBe(0);

      // Bo was never stopped, so Bo's batch is still owed a turn — which is what
      // makes `triggersIdle` a real wait rather than a formality. Landing it is
      // also what proves the stop left another agent's collection alone.
      await settleUntil(() => runner.turns.length === 1, "Bo's own batch to run");
      await service.triggersIdle();

      expect(runner.turns.map((turn) => turn.authorId)).toEqual([bo]);
      expect(postsBy(ana)).toHaveLength(0);
    });
  });
});

/**
 * The collector on its own, with a clock the test controls.
 *
 * Everything above drives the real service, which is right for behaviour and
 * useless for this one property: whether a re-arm reads the clock once or once
 * per room is invisible unless the clock can be made to move between two reads.
 * So this block builds a `RoomCollector` directly and hands it a `Date.now` that
 * ticks on every call — the machine that reproduces the millisecond straddle
 * every time instead of one run in many.
 */
describe('one agent, several waiting rooms, one clock reading', () => {
  /** A room with only what the collector reads off one. */
  function room(id: string): Room {
    return { id, kind: 'channel', title: id } as unknown as Room;
  }

  /** An entry with only what the collector carries. */
  function entry(id: string): RoomEntry {
    return { id, body: { text: id } } as unknown as RoomEntry;
  }

  /**
   * Open a parked collection for one room, as an `elsewhere` hold does.
   *
   * @param collector - The collector under test.
   * @param roomId - The room whose message is waiting.
   * @param at - The arrival reading, which a parked collection never uses for a
   *   deadline but does carry.
   */
  function park(collector: RoomCollector, roomId: string, at: number): void {
    collector.collect({
      room: room(roomId),
      authorId: 'ana',
      agentPath: '/agents/ana',
      displayName: 'Ana',
      entry: entry(`${roomId}-1`),
      depth: 0,
      engaged: null,
      reason: 'mention',
      duringTurnHere: false,
      park: true,
      arrivedAt: at,
    });
  }

  it('sweeps every waiting room in ONE batch, promoted first, across a clock straddle', async () => {
    // **Seeded defect: read `Date.now()` per iteration inside `resumeAgent`.**
    // The two rooms then get deadlines a millisecond apart, land in two
    // different sweeps, and the promoted-first sort — which only ever runs over
    // one batch — never sees the promoted room at all. It parks straight back
    // behind the room it was supposed to overtake, so "Answer here first"
    // silently does nothing. Red with the per-iteration read; green with the one
    // shared reading.
    //
    // The clock ticks on EVERY read, which is the straddle made certain rather
    // than waited for. `resumeAgent`'s real caller re-states a held indicator
    // between iterations, so the loop is not tight enough to rely on luck.
    const real = Date.now;
    let tick = real.call(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));
    try {
      const batches: string[][] = [];
      const collector = new RoomCollector({
        window: () => ({ debounceMs: 0, maxEntries: 20 }),
        run: (batch) => batches.push(batch.map((collection) => collection.room.id)),
      });

      park(collector, 'first', tick);
      park(collector, 'second', tick);
      // The person asks for the LATER room to be answered first.
      expect(collector.promote('second', 'ana')).toBe(true);

      collector.resumeAgent('/agents/ana');
      // The sweep is a macrotask, and the timer runs on the REAL clock rather
      // than the mocked reading, so this waits for it rather than advancing one.
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(batches, 'both waiting rooms came back in one sweep, not two').toEqual([
        ['second', 'first'],
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('re-arms waiting rooms from a fresh message’s own reading, so they share its sweep (DOR-2104)', async () => {
    // A raised `rooms.maxConcurrentTurnsPerAgent` frees a slot with no turn
    // ending, and the dispatcher re-arms the waits just before deciding the
    // fresh message that noticed. **Seeded defect: let `resumeAgent` read its
    // own `Date.now()` instead of the fresh message's `arrivedAt`.** On a clock
    // that has moved on by even a millisecond the wait is due AFTER the fresh
    // message, the sweep hands the fresh one back alone, and it takes the slot
    // ahead of a message that had been waiting — first come, second served.
    const real = Date.now;
    let tick = real.call(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));
    try {
      const batches: string[][] = [];
      const collector = new RoomCollector({
        window: () => ({ debounceMs: 0, maxEntries: 20 }),
        run: (batch) => batches.push(batch.map((collection) => collection.room.id)),
      });

      park(collector, 'waiting', tick);
      // The fresh message's one reading, taken before anything is re-armed —
      // the order `collectOne` works in.
      const arrivedAt = Date.now();
      collector.resumeAgent('/agents/ana', arrivedAt);
      collector.collect({
        room: room('fresh'),
        authorId: 'ana',
        agentPath: '/agents/ana',
        displayName: 'Ana',
        entry: entry('fresh-1'),
        depth: 0,
        engaged: null,
        reason: 'mention',
        duringTurnHere: false,
        park: false,
        arrivedAt,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(
        batches,
        'the waiting room came back in the fresh message’s sweep, ahead of it'
      ).toEqual([['waiting', 'fresh']]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still hands back a lone waiting room', () => {
    // The counter-assertion: the shared reading must not change the ordinary
    // one-room case, which is nearly every case.
    const batches: string[][] = [];
    const collector = new RoomCollector({
      window: () => ({ debounceMs: 0, maxEntries: 20 }),
      run: (batch) => batches.push(batch.map((collection) => collection.room.id)),
    });
    park(collector, 'only', Date.now());
    collector.resumeAgent('/agents/ana');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(batches).toEqual([['only']]);
        resolve();
      }, 5);
    });
  });
});
