import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { SESSIONS } from '../../../../../config/constants.js';
import { logger } from '../../../../../lib/logger.js';
import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { backgroundTasksMessage, FakeQuery, initMessage } from './fake-pump-query.js';

/** The idle window these tests measure against, unless one overrides it. */
const IDLE_MS = 5 * 60 * 1000;

/**
 * The registry's id resolver, standing in for `SessionStore.sessionKeyOf` —
 * this suite drives the registry directly with ids it invents, which never
 * alias to anything, so every id is already its own answer.
 */
const identity = (sessionId: string): string => sessionId;

/** Acquire options whose launcher hands back a query that inits on demand. */
function launchOpts(
  queries: FakeQuery[],
  overrides: Partial<AcquirePumpOptions> = {}
): AcquirePumpOptions {
  return {
    maxWarmSessions: 12,
    warmIdleMs: IDLE_MS,
    launch: () => {
      const query = new FakeQuery();
      queries.push(query);
      // Init on the next tick, so `warm()` resolves without the test having to
      // reach into the stream.
      queueMicrotask(() => query.emit(initMessage()));
      return query;
    },
    drainGraceMs: 20,
    ...overrides,
  };
}

/** Warm `sessionId`, then run a whole turn on it, so it is the most recently used. */
async function useSession(registry: SessionPumpRegistry, sessionId: string): Promise<void> {
  const pump = registry.peek(sessionId)!;
  await pump.dispatch([{ content: 'hi', messageId: `msg-${sessionId}` }]);
  pump.endTurn();
}

afterEach(async () => {
  await shutdownSessionPumps();
});

describe('SessionPumpRegistry', () => {
  // Purpose: a session this server holds no process for is cold, and asking
  // about one it has never heard of must not create anything.
  it('reports cold for a session it has never heard of', () => {
    const registry = new SessionPumpRegistry(identity);
    expect(registry.warmth('never-seen')).toBe('cold');
    expect(registry.peek('never-seen')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  // Purpose: warmth is the pump's state, reported through the registry — this
  // is what `getSessionWarmth` answers with at each point.
  it('reports the state the machine is actually in', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries));

    expect(registry.warmth('s1')).toBe('cold');
    await pump.warm();
    expect(registry.warmth('s1')).toBe('warm');
    await pump.dispatch([{ content: 'hi', messageId: 'msg-hi' }]);
    expect(registry.warmth('s1')).toBe('running');
    pump.endTurn();
    expect(registry.warmth('s1')).toBe('warm');
    queries[0]!.failStream(new Error('killed'));
    await vi.waitFor(() => expect(registry.warmth('s1')).toBe('crashed'));
  });

  // Purpose: one session, one process. A second acquire must not shadow the
  // pump that owns the running subprocess.
  it('hands back the same pump for a session', () => {
    const registry = new SessionPumpRegistry(identity);
    const first = registry.acquire('s1', launchOpts([]));
    expect(registry.acquire('s1', launchOpts([]))).toBe(first);
  });

  // Purpose: a reaped pump is spent. The next dispatch has to get a fresh one,
  // with a fresh input stream and freshly detected capabilities.
  it('drops a reaped pump so the next acquire builds a fresh one', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const first = registry.acquire('s1', launchOpts(queries));
    await first.warm();

    await registry.reap('s1');
    expect(registry.warmth('s1')).toBe('cold');
    expect(queries[0]!.closed).toBe(1);
    expect(registry.size).toBe(0);

    const second = registry.acquire('s1', launchOpts(queries));
    expect(second).not.toBe(first);
    await second.warm();
    expect(registry.warmth('s1')).toBe('warm');
  });

  // Purpose: recovery is a relaunch of the SAME pump (CRASHED -> RESUMING), so
  // a crashed session must stay on the books rather than being swept away.
  it('keeps a crashed pump, because its recovery is a relaunch of it', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();
    queries[0]!.failStream(new Error('killed'));
    await vi.waitFor(() => expect(registry.warmth('s1')).toBe('crashed'));

    expect(registry.peek('s1')).toBe(pump);
    expect(registry.size).toBe(1);
  });

  // Purpose: reap's callers are timers and sweeps that cannot know the answer
  // in advance, so asking about nothing must be free and silent.
  it('reap is idempotent and a no-op for an unknown or cold session', async () => {
    const registry = new SessionPumpRegistry(identity);
    await expect(registry.reap('never-seen')).resolves.toBe(false);

    const queries: FakeQuery[] = [];
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();
    await registry.reap('s1');
    await registry.reap('s1');
    expect(queries[0]!.closed).toBe(1);
  });

  // Purpose: the ceiling counts PROCESSES, and the one over it is not refused —
  // warmth is a cache, so the least recently USED process makes room. Insertion
  // order is deliberately the wrong answer here: s1 is the oldest pump but the
  // freshest use, so a registry reclaiming by age reaps the wrong session.
  it('reclaims the least recently used warm session, not the oldest one', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, { maxWarmSessions: 3 });
    await registry.acquire('s1', opts).warm();
    await registry.acquire('s2', opts).warm();
    await registry.acquire('s3', opts).warm();
    // Shuffle the activity so recency and insertion order disagree: s2 is used,
    // then s1, leaving s3 — acquired last — as the least recently used.
    await useSession(registry, 's2');
    await useSession(registry, 's1');

    await registry.acquire('s4', opts).warm();

    expect(registry.warmth('s3')).toBe('cold');
    expect(registry.warmth('s1')).toBe('warm');
    expect(registry.warmth('s2')).toBe('warm');
    expect(registry.warmth('s4')).toBe('warm');
    expect(registry.liveCount()).toBe(3);
    // Exactly one process was given back: a reclaim makes room for one launch,
    // never a sweep down to some lower water mark.
    expect(queries.filter((query) => query.closed > 0)).toHaveLength(1);
  });

  // Purpose: a warm process going away tells ONE story at ONE level. The idle
  // reap logs at `info`; this — the rarer, more surprising exit, where a session
  // loses its process so another one can launch — sat at `debug`, so the routine
  // case was louder than the contended one and the contended one was invisible
  // in a default-level log (DOR-1442).
  it('logs at info when the warm ceiling reclaims a slot', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, { maxWarmSessions: 1 });
    await registry.acquire('s1', opts).warm();

    await registry.acquire('s2', opts).warm();

    expect(registry.warmth('s1')).toBe('cold');
    expect(infoSpy).toHaveBeenCalledWith(
      '[SessionPumpRegistry] reclaimed a warm slot',
      expect.objectContaining({ reaped: 's1', asking: 's2' })
    );
    infoSpy.mockRestore();
  });

  // Purpose: a RUNNING pump is mid-turn with somebody watching it. Reclaiming
  // one would kill a live turn to warm a different session, which is never the
  // trade — the refusal is the honest answer instead.
  //
  // A running pump refuses its own reap as well, so "the turn survived" alone
  // would pass whatever the reclaim considered. The reclaim must never ASK: that
  // is what keeps this correct if the pump's guard ever moves.
  it('never reclaims a running session, and refuses rather than killing a turn', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, { maxWarmSessions: 2 });
    const first = registry.acquire('s1', opts);
    const second = registry.acquire('s2', opts);
    await first.warm();
    await second.warm();
    await first.dispatch([{ content: 'a', messageId: 'msg-a' }]);
    await second.dispatch([{ content: 'b', messageId: 'msg-b' }]);
    const reaps = [vi.spyOn(first, 'reap'), vi.spyOn(second, 'reap')];

    await expect(registry.acquire('s3', opts).warm()).rejects.toMatchObject({
      reason: 'warm-ceiling',
    });
    expect(registry.warmth('s1')).toBe('running');
    expect(registry.warmth('s2')).toBe('running');
    for (const reap of reaps) expect(reap).not.toHaveBeenCalled();
    expect(queries.every((query) => query.closed === 0)).toBe(true);
  });

  // Purpose: a session parked on a person declines its reap. The reclaim must
  // move on to the next-least-recent rather than reporting failure — one
  // unavailable candidate is not "nothing is reclaimable".
  it('skips a session parked on a person and reclaims the next-least-recent', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, { maxWarmSessions: 2 });
    // s1 is the least recently used AND parked on an approval nobody has
    // answered; s2 is the next in line.
    await registry.acquire('s1', { ...opts, hasPendingInteraction: () => true }).warm();
    await registry.acquire('s2', opts).warm();

    await registry.acquire('s3', opts).warm();

    expect(registry.warmth('s1')).toBe('warm');
    expect(registry.warmth('s2')).toBe('cold');
    expect(registry.warmth('s3')).toBe('warm');
  });

  // Purpose: a reclaim that can free nothing must still end in a refusal rather
  // than in a launch that quietly exceeds the ceiling.
  it('still refuses when every warm session declines its reap', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, {
      maxWarmSessions: 1,
      hasPendingInteraction: () => true,
    });
    await registry.acquire('s1', opts).warm();

    await expect(registry.acquire('s2', opts).warm()).rejects.toMatchObject({
      reason: 'warm-ceiling',
    });
    expect(registry.liveCount()).toBe(1);
  });

  // Purpose: the ceiling counts what EXISTS, and three launches in one tick all
  // read that count before any of them has a process. Without slots being
  // reserved at the moment they are granted, the check passes three times over a
  // ceiling of two and the host ends up with a subprocess it refused.
  it('holds the ceiling when several sessions warm in the same tick', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const opts = launchOpts(queries, { maxWarmSessions: 2 });

    const settled = await Promise.allSettled([
      registry.acquire('s1', opts).warm(),
      registry.acquire('s2', opts).warm(),
      registry.acquire('s3', opts).warm(),
    ]);

    expect(queries.length).toBe(2);
    expect(registry.liveCount()).toBe(2);
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  // Purpose: eviction is unconditional — a session record going away must never
  // leave its subprocess behind, whatever the pump was doing. The caller drops
  // the record once this resolves, so "closed by the time it resolves" is the
  // whole of "no subprocess outlives its session record".
  it('evict closes the process mid-turn and forgets the session', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();
    await pump.dispatch([{ content: 'hi', messageId: 'msg-hi' }]);

    await registry.evict('s1');
    expect(queries[0]!.closed).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.warmth('s1')).toBe('cold');
  });
});

describe('the warm ceiling when the asking session leaves mid-reclaim', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Purpose: the reservation's OWN failure mode, and the only place it can
  // happen. Every other grant is synchronous with a pump the registry still
  // holds, so `drop` gives the slot back. The reclaim is the exception: it
  // AWAITS a process closing, and the session that asked can be evicted inside
  // that window. Granting it a slot then books one nothing will ever release —
  // and because the reservation counts against the ceiling forever, the host
  // loses one warm slot per occurrence until it restarts.
  it('does not book a slot for a session evicted while the reclaim ran', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    // A long drain grace makes the reclaim's await a window this test owns,
    // rather than a race it would have to sleep on.
    const slow = launchOpts(queries, { maxWarmSessions: 1, drainGraceMs: 10_000 });
    await registry.acquire('s1', slow).warm();
    expect(registry.liveCount()).toBe(1);

    // s2 wants the only slot: the direct grant fails, so it parks inside the
    // reclaim of s1 while that sits on its drain grace.
    const s2 = registry.acquire('s2', slow);
    const refused = expect(s2.warm()).rejects.toMatchObject({ reason: 'process-gone' });
    await Promise.resolve();
    await Promise.resolve();
    // The session record retires while its launch is still parked.
    await registry.evict('s2');
    expect(registry.size).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await refused;

    // s1 was reclaimed and s2 never booted, so the ceiling of one is free —
    // and a fresh session has to be able to take it.
    expect(registry.liveCount()).toBe(0);
    const fresh = registry.acquire('s3', launchOpts(queries, { maxWarmSessions: 1 }));
    await expect(fresh.warm()).resolves.toBeUndefined();
    expect(registry.warmth('s3')).toBe('warm');

    await vi.advanceTimersByTimeAsync(100);
  });
});

describe('the warm-session constants', () => {
  // Purpose: the two ceilings are different numbers on purpose, and the ORDER of
  // the three windows is what the whole design rests on. A future edit that
  // makes processes outlive records, or that lets the reaper fire after an
  // approval has already timed out, breaks here rather than in production.
  it('bounds processes below records, and idleness below both eviction and interaction', () => {
    expect(SESSIONS.MAX_WARM_SESSIONS).toBe(12);
    expect(SESSIONS.WARM_IDLE_MS).toBe(5 * 60 * 1000);
    // Processes are a cache of records, so there must be fewer of them.
    expect(SESSIONS.MAX_WARM_SESSIONS).toBeLessThan(SESSIONS.MAX_SESSIONS);
    // A process may never outlive the record it belongs to.
    expect(SESSIONS.WARM_IDLE_MS).toBeLessThan(SESSIONS.TIMEOUT_MS);
    // The reaper fires INSIDE the window a person has to answer an approval,
    // which is why declining on a pending interaction is not theoretical.
    expect(SESSIONS.WARM_IDLE_MS).toBeLessThan(SESSIONS.INTERACTION_TIMEOUT_MS);
  });
});

describe('the process idle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Let a close finish. The pump's polite drain parks on its own grace timer,
   * which the fake clock owns — so anything that closes a process has to be
   * started, then given the clock, then awaited.
   */
  async function settle<T>(work: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(100);
    return work;
  }

  // Purpose: the whole point of the timer. A process nobody has used for the
  // idle window is given back, and the session goes cold without anything else
  // about it changing.
  it('reaps a warm session that has sat untouched for the idle window', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    await registry.acquire('s1', launchOpts(queries)).warm();
    expect(registry.warmth('s1')).toBe('warm');

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(registry.warmth('s1')).toBe('warm');

    await vi.advanceTimersByTimeAsync(1 + 100);
    expect(registry.warmth('s1')).toBe('cold');
    expect(queries[0]!.closed).toBe(1);
    expect(registry.size).toBe(0);
  });

  // Purpose: the idle reap used to be invisible at info level (DOR-1323,
  // flag-on run L-11) — nothing in the log distinguished a process given back
  // for lack of use from one that crashed or was evicted. One line, naming the
  // session and the idle window it sat for, is what makes it greppable.
  it('logs at info when the idle timer retires a warm process', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    await registry.acquire('s1', launchOpts(queries)).warm();

    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);

    expect(registry.warmth('s1')).toBe('cold');
    expect(infoSpy).toHaveBeenCalledWith(
      '[SessionPumpRegistry] retired an idle warm process',
      expect.objectContaining({ session: 's1', idleMs: IDLE_MS })
    );
    infoSpy.mockRestore();
  });

  // Purpose: pins the ORDER, not just the outcome — the review that caught this
  // (DOR-1323 fix round) mutated the log to fire before `await this.reap(...)`
  // resolves instead of after, and every other test in this file stayed green:
  // a reap that DECLINES (parked on a person) would then still claim "retired"
  // in the log. The line must be true, not merely present.
  it('does NOT log "retired" when the idle reap is declined (parked on a person)', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    await registry.acquire('s1', launchOpts(queries, { hasPendingInteraction: () => true })).warm();

    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);

    // Declined, not retired: still warm, and the log never claimed otherwise.
    expect(registry.warmth('s1')).toBe('warm');
    expect(
      infoSpy.mock.calls.some(
        ([msg]) => msg === '[SessionPumpRegistry] retired an idle warm process'
      )
    ).toBe(false);
    infoSpy.mockRestore();
  });

  // Purpose: the two halves of "armed on a window close, disarmed on the next
  // dispatch". A turn is never idle however long it runs, and the countdown that
  // follows it is measured from the CLOSE — not from the first time the session
  // went warm, which is the off-by-one-arming a single-shot timer would give.
  it('a dispatch disarms the countdown, and the turn ending restarts it', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    await pump.dispatch([{ content: 'hi', messageId: 'msg-hi' }]);
    // Disarmed, not merely ignored when it fires: nothing is counting down
    // against a session that is mid-turn.
    expect(vi.getTimerCount()).toBe(0);
    // A turn that runs for twice the idle window is still a turn, not an idle
    // session.
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(registry.warmth('s1')).toBe('running');
    expect(queries[0]!.closed).toBe(0);

    pump.endTurn();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    expect(registry.warmth('s1')).toBe('warm');

    await vi.advanceTimersByTimeAsync(1_000 + 100);
    expect(registry.warmth('s1')).toBe('cold');
  });

  // Purpose: `INTERACTION_TIMEOUT_MS` (10 min) is deliberately longer than the
  // idle window (5 min), so somebody who walks away from an approval card WILL
  // be sitting here when the timer fires. A reaped process cannot answer the
  // approval they come back to.
  it('never reaps a session parked on a person, and asks again a window later', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    let parked = true;
    const pump = registry.acquire(
      's1',
      launchOpts(queries, { hasPendingInteraction: () => parked })
    );
    const reaps = vi.spyOn(pump, 'reap');
    await pump.warm();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(registry.warmth('s1')).toBe('warm');
    expect(queries[0]!.closed).toBe(0);
    // Once per window, not a retry loop: three windows, three asks.
    expect(reaps).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    parked = false;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(registry.warmth('s1')).toBe('cold');
  });

  // Purpose: the same decline, for the other reason a warm process is still
  // needed. A background subagent outlives the turn that launched it, and
  // reaping under it cancels the tools it runs next (DOR-1238). The idle timer
  // has to keep asking rather than give up, or the process would sit warm for
  // the life of the server.
  it('never reaps a session running a background subagent, and asks again a window later', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries));
    const reaps = vi.spyOn(pump, 'reap');
    await pump.warm();
    queries[0]!.emit(backgroundTasksMessage([{ id: 'agent-1', type: 'local_agent' }]));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(registry.warmth('s1')).toBe('warm');
    expect(queries[0]!.closed).toBe(0);
    // Once per window, not a retry loop: three windows, three asks.
    expect(reaps).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    queries[0]!.emit(backgroundTasksMessage([]));
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(registry.warmth('s1')).toBe('cold');
  });

  // Purpose: a timer that outlives the pump it was armed for is a leak that
  // fires into an empty registry. Every exit from warmth has to take its
  // countdown with it.
  it('leaves no timer armed after a reap, an eviction, or a teardown', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    await registry.acquire('reaped', launchOpts(queries)).warm();
    await registry.acquire('evicted', launchOpts(queries)).warm();
    await registry.acquire('torn-down', launchOpts(queries)).warm();
    expect(vi.getTimerCount()).toBe(3);

    await settle(registry.reap('reaped'));
    expect(vi.getTimerCount()).toBe(2);

    await settle(registry.evict('evicted'));
    expect(vi.getTimerCount()).toBe(1);

    await settle(registry.teardownAll());
    expect(vi.getTimerCount()).toBe(0);
  });

  // Purpose: AC5, asserted by scheduling rather than by sleeping. Both the reap
  // and the dispatch decide on the pump's state SYNCHRONOUSLY, so whichever runs
  // first wins outright and the other is refused — there is no interleaving to
  // race. Both orders are pinned, because only pinning one would leave the other
  // free to become a half-reaped turn.
  it('a reap firing and a dispatch arriving cannot interleave, in either order', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);

    // Reap first: the dispatch that lands behind it is refused outright, and the
    // caller's message stays queued for the fresh pump the next acquire builds.
    const reapFirst = registry.acquire('s1', launchOpts(queries));
    await reapFirst.warm();
    vi.advanceTimersByTime(IDLE_MS);
    expect(reapFirst.state).toBe('reaped');
    await expect(reapFirst.dispatch([{ content: 'hi', messageId: 'm1' }])).rejects.toThrow(
      /cannot go from reaped/
    );

    // Dispatch first: the timer finds a turn open and declines, leaving the turn
    // and its process exactly as they were.
    const dispatchFirst = registry.acquire('s2', launchOpts(queries));
    await dispatchFirst.warm();
    await dispatchFirst.dispatch([{ content: 'hi', messageId: 'm2' }]);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(dispatchFirst.state).toBe('running');
    expect(queries[1]!.closed).toBe(0);

    await settle(registry.teardownAll());
  });
});

describe('shutdownSessionPumps', () => {
  // Purpose: the whole point of the module-level set. No warm subprocess may
  // survive DorkOS, whichever registry happens to hold it.
  it('closes every process in every registry that holds one', async () => {
    const queries: FakeQuery[] = [];
    const first = new SessionPumpRegistry(identity);
    const second = new SessionPumpRegistry(identity);
    await first.acquire('s1', launchOpts(queries)).warm();
    await first.acquire('s2', launchOpts(queries)).warm();
    await second.acquire('s3', launchOpts(queries)).warm();

    await shutdownSessionPumps();

    expect(queries.length).toBe(3);
    for (const query of queries) expect(query.closed).toBe(1);
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
  });

  // Purpose: this runs on every shutdown of every server, including the
  // overwhelming majority that never warmed anything.
  it('is a no-op when nothing was ever warmed', async () => {
    await expect(shutdownSessionPumps()).resolves.toBeUndefined();
  });

  // Purpose: one wedged session must not stop the others being closed, because
  // the point is that nothing is left running.
  it('closes the rest when one pump fails to tear down', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry(identity);
    const doomed = registry.acquire('s1', launchOpts(queries));
    await doomed.warm();
    await registry.acquire('s2', launchOpts(queries)).warm();
    vi.spyOn(doomed, 'teardown').mockRejectedValueOnce(new Error('wedged'));

    await shutdownSessionPumps();
    expect(queries[1]!.closed).toBe(1);
  });
});
