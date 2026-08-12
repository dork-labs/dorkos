import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

/** Acquire options whose launcher hands back a query that inits on demand. */
function launchOpts(
  queries: FakeQuery[],
  overrides: Partial<AcquirePumpOptions> = {}
): AcquirePumpOptions {
  return {
    maxWarmSessions: 12,
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

afterEach(async () => {
  await shutdownSessionPumps();
});

describe('SessionPumpRegistry', () => {
  // Purpose: a session this server holds no process for is cold, and asking
  // about one it has never heard of must not create anything.
  it('reports cold for a session it has never heard of', () => {
    const registry = new SessionPumpRegistry();
    expect(registry.warmth('never-seen')).toBe('cold');
    expect(registry.peek('never-seen')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  // Purpose: warmth is the pump's state, reported through the registry — this
  // is what `getSessionWarmth` answers with at each point.
  it('reports the state the machine is actually in', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry();
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
    const registry = new SessionPumpRegistry();
    const first = registry.acquire('s1', launchOpts([]));
    expect(registry.acquire('s1', launchOpts([]))).toBe(first);
  });

  // Purpose: a reaped pump is spent. The next dispatch has to get a fresh one,
  // with a fresh input stream and freshly detected capabilities.
  it('drops a reaped pump so the next acquire builds a fresh one', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry();
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
    const registry = new SessionPumpRegistry();
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
    const registry = new SessionPumpRegistry();
    await expect(registry.reap('never-seen')).resolves.toBeUndefined();

    const queries: FakeQuery[] = [];
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();
    await registry.reap('s1');
    await registry.reap('s1');
    expect(queries[0]!.closed).toBe(1);
  });

  // Purpose: the ceiling counts PROCESSES. Twelve is not fifty for a reason,
  // and with nothing able to reclaim a slot the honest answer is a refusal
  // rather than a thirteenth subprocess.
  it('refuses to launch over the warm ceiling when nothing can reclaim a slot', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry();
    const opts = launchOpts(queries, { maxWarmSessions: 2 });
    await registry.acquire('s1', opts).warm();
    await registry.acquire('s2', opts).warm();

    await expect(registry.acquire('s3', opts).warm()).rejects.toMatchObject({
      reason: 'warm-ceiling',
    });
    expect(registry.liveCount()).toBe(2);
    expect(queries.length).toBe(2);
  });

  // Purpose: the seam task 3.4 fills with LRU. Once something CAN make room,
  // the same launch goes through — and the ceiling still holds afterwards.
  it('launches over the ceiling once a slot can be reclaimed', async () => {
    const queries: FakeQuery[] = [];
    const registry: SessionPumpRegistry = new SessionPumpRegistry({
      reclaimWarmSlot: async () => {
        await registry.reap('s1');
        return true;
      },
    });
    const opts = launchOpts(queries, { maxWarmSessions: 2 });
    await registry.acquire('s1', opts).warm();
    await registry.acquire('s2', opts).warm();

    await registry.acquire('s3', opts).warm();
    expect(registry.warmth('s1')).toBe('cold');
    expect(registry.warmth('s3')).toBe('warm');
    expect(registry.liveCount()).toBe(2);
  });

  // Purpose: a reclaim that cannot free anything must still end in a refusal
  // rather than in a launch that quietly exceeds the ceiling.
  it('still refuses when the reclaim frees nothing', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry({ reclaimWarmSlot: async () => false });
    const opts = launchOpts(queries, { maxWarmSessions: 1 });
    await registry.acquire('s1', opts).warm();

    await expect(registry.acquire('s2', opts).warm()).rejects.toMatchObject({
      reason: 'warm-ceiling',
    });
  });

  // Purpose: eviction is unconditional — a session record going away must never
  // leave its subprocess behind, whatever the pump was doing.
  it('evict closes the process mid-turn and forgets the session', async () => {
    const queries: FakeQuery[] = [];
    const registry = new SessionPumpRegistry();
    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.warm();
    await pump.dispatch([{ content: 'hi', messageId: 'msg-hi' }]);

    await registry.evict('s1');
    expect(queries[0]!.closed).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.warmth('s1')).toBe('cold');
  });
});

describe('shutdownSessionPumps', () => {
  // Purpose: the whole point of the module-level set. No warm subprocess may
  // survive DorkOS, whichever registry happens to hold it.
  it('closes every process in every registry that holds one', async () => {
    const queries: FakeQuery[] = [];
    const first = new SessionPumpRegistry();
    const second = new SessionPumpRegistry();
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
    const registry = new SessionPumpRegistry();
    const doomed = registry.acquire('s1', launchOpts(queries));
    await doomed.warm();
    await registry.acquire('s2', launchOpts(queries)).warm();
    vi.spyOn(doomed, 'teardown').mockRejectedValueOnce(new Error('wedged'));

    await shutdownSessionPumps();
    expect(queries[1]!.closed).toBe(1);
  });
});
