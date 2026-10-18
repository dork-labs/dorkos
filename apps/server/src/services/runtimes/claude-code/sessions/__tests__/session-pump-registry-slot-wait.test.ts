/**
 * A full warm ceiling is a queue, not a failure (DOR-3012).
 *
 * On 2026-10-18 every one of twelve processes was mid-turn when one room post
 * named seven agents, and all seven were refused in under two seconds. These
 * pin the replacement: a launch with nothing to reclaim waits for a slot, says
 * so once, and is refused only when the wait runs out.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

const identity = (sessionId: string): string => sessionId;

/** Acquire options for a ceiling of one, with a launcher that inits on demand. */
function launchOpts(overrides: Partial<AcquirePumpOptions> = {}): AcquirePumpOptions {
  return {
    maxWarmSessions: 1,
    warmIdleMs: 5 * 60 * 1000,
    slotWaitMs: 60_000,
    launch: () => {
      const query = new FakeQuery();
      queueMicrotask(() => query.emit(initMessage()));
      return query;
    },
    drainGraceMs: 20,
    ...overrides,
  };
}

afterEach(async () => {
  await shutdownSessionPumps();
});

describe('SessionPumpRegistry, when every slot is mid-turn', () => {
  // Purpose: the incident itself. The one slot is RUNNING, so nothing can be
  // reclaimed; the second launch must wait rather than throw, and start the
  // moment the running turn ends and its process becomes reclaimable.
  it('waits for a running turn to end, then takes its slot', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-a' }]);

    let waits = 0;
    const waiting = registry
      .acquire('next', launchOpts({ onWaitingForSlot: () => (waits += 1) }))
      .warm();
    let started = false;
    void waiting.then(() => (started = true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(started).toBe(false);
    expect(waits).toBe(1);
    expect(registry.warmth('busy')).toBe('running');

    busy.endTurn();
    await waiting;

    expect(registry.warmth('next')).toBe('warm');
    expect(registry.warmth('busy')).toBe('cold');
    // Told once, however many times it was woken while it waited.
    expect(waits).toBe(1);
    expect(registry.liveCount()).toBe(1);
  });

  // Purpose: the wait is bounded. A slot that never frees ends in the same
  // `warm-ceiling` refusal as before, so the turn is answered in words rather
  // than hanging until the stall guard cuts it off.
  it('refuses with warm-ceiling once the wait runs out', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-a' }]);

    await expect(
      registry.acquire('next', launchOpts({ slotWaitMs: 30 })).warm()
    ).rejects.toMatchObject({ reason: 'warm-ceiling' });
    expect(registry.warmth('busy')).toBe('running');
  });

  // Purpose: a session evicted while it waits must leave with `process-gone`
  // and must NOT book a slot on its way out — a reservation nothing gives back
  // would shrink the ceiling for the life of the server.
  it('lets a waiting session leave without keeping a slot', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-a' }]);

    const waiting = registry.acquire('gone', launchOpts()).warm();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await registry.evict('gone');

    await expect(waiting).rejects.toMatchObject({ reason: 'process-gone' });

    busy.endTurn();
    // The ceiling still has its one slot: a third session can take it.
    await registry.acquire('third', launchOpts()).warm();
    expect(registry.warmth('third')).toBe('warm');
  });

  // Purpose: several waiters and one freed slot. Exactly one starts; the rest
  // keep waiting rather than all piling past the ceiling.
  it('lets exactly one waiter through per freed slot', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-a' }]);

    // Dispatched, so the one that starts is mid-turn and cannot be reclaimed
    // by the other — an idle warm-up would be, and fairly.
    const outcomes: string[] = [];
    const a = registry
      .acquire('a', launchOpts())
      .dispatch([{ content: 'a', messageId: 'msg-a2' }])
      .then(() => outcomes.push('a'));
    const b = registry
      .acquire('b', launchOpts())
      .dispatch([{ content: 'b', messageId: 'msg-b2' }])
      .then(() => outcomes.push('b'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    busy.endTurn();
    await Promise.race([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcomes).toHaveLength(1);
    expect(registry.liveCount()).toBe(1);
    await shutdownSessionPumps();
    await Promise.allSettled([a, b]);
  });

  // Purpose: Stop on a turn that is only waiting has no process to reach, so
  // the wait itself must end — refused as `process-gone`, which the dispatch
  // settles as interrupted — and must give back nothing it never took.
  it('ends a wait when Stop is pressed, and answers false when nothing waits', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-a' }]);
    expect(registry.stopSlotWait('busy')).toBe(false);

    const waiting = registry.acquire('next', launchOpts()).warm();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.stopSlotWait('next')).toBe(true);

    await expect(waiting).rejects.toMatchObject({ reason: 'process-gone' });
    expect(registry.stopSlotWait('next')).toBe(false);
    expect(registry.warmth('busy')).toBe('running');
  });

  // Purpose: the incident at scale. K agents are mid-turn and N more are woken
  // at once (one room post naming seven agents). Every one of the N must start
  // — late, as busy turns end — and none may be refused, while the ceiling is
  // never exceeded on the way.
  it('starts every one of N waiting launches as K busy turns end, and refuses none', async () => {
    const K = 3;
    const N = 7;
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts({ maxWarmSessions: K });
    const busy = [];
    for (let i = 0; i < K; i += 1) {
      const pump = registry.acquire(`busy-${i}`, opts);
      await pump.warm();
      await pump.dispatch([{ content: 'work', messageId: `busy-msg-${i}` }]);
      busy.push(pump);
    }

    const results: Array<'started' | 'refused'> = [];
    const waiting = Array.from({ length: N }, (_, i) => {
      // Dispatched cold, as a room turn is: the message rides the launch, so
      // the pump is never WARM-and-idle before its turn opens.
      const pump = registry.acquire(`mention-${i}`, opts);
      return pump.dispatch([{ content: 'answer', messageId: `mention-msg-${i}` }]).then(
        () => {
          results.push('started');
          expect(registry.liveCount()).toBeLessThanOrEqual(K);
          // The woken agent answers and its turn ends, freeing its slot.
          pump.endTurn();
        },
        () => results.push('refused')
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(results).toEqual([]);
    expect(registry.liveCount()).toBe(K);

    for (const pump of busy) pump.endTurn();
    await Promise.all(waiting);

    expect(results.filter((r) => r === 'started')).toHaveLength(N);
    expect(results).not.toContain('refused');
    expect(registry.liveCount()).toBeLessThanOrEqual(K);
  });

  // Purpose: first come, first served. With one slot and two turns waiting,
  // the one that arrived first starts first.
  it('serves waiting launches in the order they arrived', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-busy' }]);

    const order: string[] = [];
    const first = registry.acquire('first', launchOpts());
    const firstDone = first.dispatch([{ content: '1', messageId: 'msg-1' }]).then(() => {
      order.push('first');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = registry.acquire('second', launchOpts());
    const secondDone = second.dispatch([{ content: '2', messageId: 'msg-2' }]).then(() => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.isWaitingForSlot('first')).toBe(true);
    expect(registry.isWaitingForSlot('second')).toBe(true);

    busy.endTurn();
    await firstDone;
    expect(order).toEqual(['first']);
    first.endTurn();
    await secondDone;
    expect(order).toEqual(['first', 'second']);
  });

  // Purpose: "cannot go from reaped to warming". A reaped pump leaves the
  // registry the moment it is reaped, so the next dispatch builds a fresh one,
  // while its closing process still counts against the ceiling.
  it('forgets a reaped pump at once, and counts it until its process has closed', async () => {
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts({ drainGraceMs: 50 }));
    await pump.warm();

    const reaping = registry.reap('s1');
    expect(registry.peek('s1')).toBeUndefined();
    expect(registry.liveCount()).toBe(1);
    expect(registry.acquire('s1', launchOpts())).not.toBe(pump);

    expect(await reaping).toBe(true);
    expect(registry.liveCount()).toBe(0);
  });

  // Purpose: a turn sent while a message-less launch (a stage's warm-up) waits
  // for a slot must ride that launch, not be dropped by it.
  it('keeps the message of a turn that joins a launch already waiting', async () => {
    const registry = new SessionPumpRegistry(identity);
    const busy = registry.acquire('busy', launchOpts());
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-busy' }]);

    const received: string[] = [];
    const pump = registry.acquire(
      'staged',
      launchOpts({
        launch: (input) => {
          const query = new FakeQuery();
          void (async () => {
            for await (const message of input.prompt) {
              const content = (message as { message?: { content?: unknown } }).message?.content;
              received.push(typeof content === 'string' ? content : JSON.stringify(content));
            }
          })();
          queueMicrotask(() => query.emit(initMessage()));
          return query;
        },
      })
    );
    const warming = pump.warm();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dispatching = pump.dispatch([{ content: 'the turn', messageId: 'msg-turn' }]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    busy.endTurn();
    await warming;
    await dispatching;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pump.state).toBe('running');
    expect(received.join(' ')).toContain('the turn');
  });

  // Purpose: a process that is closing frees its slot in seconds. A launch
  // waiting meanwhile must wait for it, not reclaim another chat's warm process.
  it('waits for a closing process rather than reclaiming a second one', async () => {
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts({ maxWarmSessions: 3 });
    const busy = registry.acquire('busy', opts);
    await busy.warm();
    await busy.dispatch([{ content: 'a', messageId: 'msg-busy' }]);
    await registry.acquire('closing', launchOpts({ maxWarmSessions: 3, drainGraceMs: 40 })).warm();
    await registry.acquire('spare', opts).warm();

    const reaping = registry.reap('closing');
    expect(registry.liveCount()).toBe(3);
    const next = registry.acquire('next', opts);
    await next.dispatch([{ content: 'n', messageId: 'msg-next' }]);
    await reaping;

    expect(registry.warmth('spare')).toBe('warm');
    expect(registry.warmth('next')).toBe('running');
    expect(registry.liveCount()).toBe(3);
  });

  // Purpose: shutdown still reaches a process that is closing, though it is no
  // longer in the registry's entries.
  it('waits for a closing process at shutdown', async () => {
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts({ drainGraceMs: 30 }));
    await pump.warm();
    let closed = false;
    const reaping = registry.reap('s1').then(() => (closed = true));
    expect(registry.size).toBe(0);

    await shutdownSessionPumps();
    expect(closed).toBe(true);
    await reaping;
  });
});
