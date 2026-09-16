/**
 * The two registry consumers of the quiet predicate (spec
 * `warm-process-lifecycle` D1, slice 2 — T4 and T7).
 *
 * Both used to measure the wrong thing. The idle timer measured the gap since
 * the last TURN WINDOW closed, so a warm process talking at length with no
 * window around it was reaped mid-sentence at five minutes; the warm-ceiling
 * reclaim asked `reap`, which counted background subagents and nothing else, so
 * a process pinned by a Monitor was handed to the next session that wanted a
 * slot (DOR-2064, DOR-2065).
 *
 * In its own file rather than appended to `session-pump-registry.test.ts`
 * because every case here drives the fake clock and the async reap together,
 * which the suite next door deliberately does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { PumpRefusedError } from '../session-pump.js';
import {
  assistantMessage,
  backgroundTasksMessage,
  FakeQuery,
  initMessage,
  type BackgroundTaskType,
} from './fake-pump-query.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The idle window these tests measure against. */
const IDLE_MS = 5 * 60 * 1000;

/** The ceiling these tests fill. */
const CEILING = 12;

/** This suite invents its own ids, so every one is already its own key. */
const identity = (sessionId: string): string => sessionId;

/** Acquire options whose launcher hands back a query that inits on demand. */
function launchOpts(
  queries: Map<string, FakeQuery>,
  sessionId: string,
  overrides: Partial<AcquirePumpOptions> = {}
): AcquirePumpOptions {
  return {
    maxWarmSessions: CEILING,
    warmIdleMs: IDLE_MS,
    launch: () => {
      const query = new FakeQuery();
      queries.set(sessionId, query);
      queueMicrotask(() => query.emit(initMessage()));
      return query;
    },
    drainGraceMs: 20,
    ...overrides,
  };
}

/** Warm `sessionId` and leave one live background task of `type` on it. */
async function warmHolding(
  registry: SessionPumpRegistry,
  queries: Map<string, FakeQuery>,
  sessionId: string,
  type: BackgroundTaskType
): Promise<void> {
  const pump = registry.acquire(sessionId, launchOpts(queries, sessionId));
  await pump.warm();
  queries.get(sessionId)!.emit(backgroundTasksMessage([{ id: `${sessionId}-task`, type }]));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
  vi.clearAllMocks();
});

afterEach(async () => {
  // Real timers FIRST: the teardown below waits out each pump's drain grace,
  // and a fake clock nobody is advancing any more would hang the hook.
  vi.useRealTimers();
  await shutdownSessionPumps();
});

// T4. A process producing frames is in use, whether or not DorkOS opened a turn
// to catch them in.
describe('the idle timer counts what the process says, not only what DorkOS asked', () => {
  it('measures the window again from a frame that arrived with no turn open', async () => {
    const queries = new Map<string, FakeQuery>();
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries, 's1'));
    await pump.warm();

    // A frame one second before the window would have elapsed.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    queries.get('s1')!.emit(assistantMessage());
    await vi.advanceTimersByTimeAsync(1_000);

    // The old timer reaped here, because nothing it read had changed.
    expect(registry.warmth('s1')).toBe('warm');

    // And the re-armed window is measured from that frame, not from scratch.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(registry.warmth('s1')).toBe('cold');
  });

  it('still reaps a process that produced nothing in its window', async () => {
    // The exemption did not widen into a general reprieve: with no frames, the
    // timer behaves exactly as it always did.
    const queries = new Map<string, FakeQuery>();
    const registry = new SessionPumpRegistry(identity);
    const pump = registry.acquire('s1', launchOpts(queries, 's1'));
    await pump.warm();

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(registry.warmth('s1')).toBe('cold');
  });
});

// T7. Warmth is a cache and LRU is what a cache does — but only over processes
// that are genuinely reclaimable, and a process holding work is not one.
describe('the warm ceiling reclaims only processes that are not working', () => {
  it('refuses a thirteenth session when twelve are pinned by background work', async () => {
    const queries = new Map<string, FakeQuery>();
    const registry = new SessionPumpRegistry(identity);
    for (let i = 0; i < CEILING; i += 1) {
      // A Monitor, not a subagent: the old rule counted `local_agent` alone, so
      // all twelve of these were reclaimable and the thirteenth sailed through.
      await warmHolding(registry, queries, `held-${i}`, 'monitor');
    }

    const latecomer = registry.acquire('late', launchOpts(queries, 'late'));
    await expect(latecomer.warm()).rejects.toThrow(PumpRefusedError);
    // Refused at the slot, before any process was booted, so the pump never
    // left COLD — there is nothing to report as crashed.
    expect(registry.warmth('late')).toBe('cold');
    for (let i = 0; i < CEILING; i += 1) {
      expect(registry.warmth(`held-${i}`)).toBe('warm');
    }
  });

  it('reclaims a process holding only background shells', async () => {
    const queries = new Map<string, FakeQuery>();
    const registry = new SessionPumpRegistry(identity);
    for (let i = 0; i < CEILING; i += 1) {
      await warmHolding(registry, queries, `shell-${i}`, 'local_bash');
    }

    // Shells hold nothing, so the least recently used process goes and the
    // thirteenth session gets its slot. The reclaim closes a process, which
    // waits out its drain grace — a fake clock has to be advanced through it.
    const latecomer = registry.acquire('late', launchOpts(queries, 'late'));
    const warming = latecomer.warm();
    await vi.advanceTimersByTimeAsync(200);
    await warming;
    expect(registry.warmth('late')).toBe('warm');
    expect(registry.warmth('shell-0')).toBe('cold');
  });
});
