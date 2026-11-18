/**
 * A process that just finished a turn is not taken to make room (DOR-4498).
 *
 * On 2026-11-18 about 45 sessions shared 14 warm slots. Nearly every slot was
 * mid-turn, so the only reclaimable processes were busy lanes in the moment
 * between two of their turns, and LRU took them: the six busiest were relaunched
 * 30 to 55 times in 70 minutes, each relaunch starting every MCP server again.
 * These pin the grace window that replaced it: a launch waits for a slot rather
 * than take one that ended its turn less than `reclaimGraceMs` ago.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

const identity = (sessionId: string): string => sessionId;

/** Long enough to observe a wait inside it, short enough to keep the suite fast. */
const GRACE_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Acquire options for a ceiling of one; every launch is recorded in `launched`. */
function launchOpts(
  launched: FakeQuery[],
  overrides: Partial<AcquirePumpOptions> = {}
): AcquirePumpOptions {
  return {
    maxWarmSessions: 1,
    warmIdleMs: 5 * 60 * 1000,
    slotWaitMs: 60_000,
    reclaimGraceMs: GRACE_MS,
    launch: () => {
      const query = new FakeQuery();
      launched.push(query);
      queueMicrotask(() => query.emit(initMessage()));
      return query;
    },
    drainGraceMs: 20,
    ...overrides,
  };
}

/** Warm `sessionId`, run one turn on it, and end the turn, leaving it WARM. */
async function oneTurn(
  registry: SessionPumpRegistry,
  sessionId: string,
  opts: AcquirePumpOptions,
  messageId: string
): Promise<void> {
  const pump = registry.acquire(sessionId, opts);
  await pump.dispatch([{ content: messageId, messageId }]);
  pump.endTurn();
}

afterEach(async () => {
  await shutdownSessionPumps();
});

describe('SessionPumpRegistry reclaim grace', () => {
  // Purpose: the incident. The only reclaimable process has just ended a turn,
  // so the new launch waits, says so once, and takes the slot only after the
  // grace has run out.
  it('makes a launch wait rather than take a process inside its grace', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    await oneTurn(registry, 'busy', launchOpts(launched), 'msg-a');
    const endedAt = Date.now();

    let waits = 0;
    const next = registry
      .acquire('next', launchOpts(launched, { onWaitingForSlot: () => (waits += 1) }))
      .warm();
    let started = false;
    void next.then(() => (started = true));
    await sleep(GRACE_MS / 3);

    expect(started).toBe(false);
    expect(waits).toBe(1);
    expect(registry.warmth('busy')).toBe('warm');

    await next;
    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(GRACE_MS - 5);
    expect(registry.warmth('next')).toBe('warm');
    expect(registry.warmth('busy')).toBe('cold');
  });

  // Purpose: what the grace is for. A busy lane that takes its next turn inside
  // the grace keeps its process every time; the waiting launch gets the slot
  // only once the lane goes quiet, and the lane is relaunched zero times.
  it('keeps a busy lane warm across turns while another launch waits', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    const busyOpts = launchOpts(launched);
    await oneTurn(registry, 'busy', busyOpts, 'msg-1');

    const next = registry.acquire('next', launchOpts(launched)).warm();
    let started = false;
    void next.then(() => (started = true));

    for (let turn = 2; turn <= 4; turn++) {
      await sleep(GRACE_MS / 3);
      expect(started).toBe(false);
      await oneTurn(registry, 'busy', busyOpts, `msg-${turn}`);
    }

    await next;
    // One launch for the lane, one for the newcomer: the lane never relaunched.
    expect(launched).toHaveLength(2);
    expect(registry.warmth('next')).toBe('warm');
  });

  // Purpose: the grace is a choice the caller makes. Unset, a reclaim behaves
  // exactly as it did before DOR-4498, taking the warm process at once.
  it('reclaims at once when no grace is set', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    await oneTurn(registry, 'busy', launchOpts(launched, { reclaimGraceMs: undefined }), 'msg-a');

    const started = Date.now();
    await registry.acquire('next', launchOpts(launched, { reclaimGraceMs: undefined })).warm();

    expect(Date.now() - started).toBeLessThan(GRACE_MS);
    expect(registry.warmth('busy')).toBe('cold');
  });

  // Purpose: a person never stares at "waiting for a slot" because of the
  // grace. Their launch takes the warm process at once, even inside its grace.
  it('lets a person-started launch take a process inside its grace at once', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    await oneTurn(registry, 'busy', launchOpts(launched), 'msg-a');

    let waits = 0;
    const started = Date.now();
    await registry
      .acquire(
        'person',
        launchOpts(launched, { skipReclaimGrace: () => true, onWaitingForSlot: () => (waits += 1) })
      )
      .warm();

    expect(Date.now() - started).toBeLessThan(GRACE_MS);
    expect(waits).toBe(0);
    expect(registry.warmth('busy')).toBe('cold');
  });

  // Purpose: the other half of the same rule. Agent-started work, which reads
  // false here, still waits for the grace.
  it('keeps an agent-started launch waiting inside the grace', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    await oneTurn(registry, 'busy', launchOpts(launched), 'msg-a');

    const next = registry
      .acquire('agent', launchOpts(launched, { skipReclaimGrace: () => false }))
      .warm();
    let done = false;
    void next.then(() => (done = true));
    await sleep(GRACE_MS / 3);

    expect(done).toBe(false);
    expect(registry.warmth('busy')).toBe('warm');
    await next;
  });

  // Purpose: a reclaim closes the process it takes. DorkOS's part of "no orphan
  // MCP child" is reaching the forceful close on the CLI, whose own exit takes
  // its stdio servers with it (0 orphans found after 57 reclaims, 2026-11-18).
  it('closes the process it reclaims', async () => {
    const registry = new SessionPumpRegistry(identity);
    const launched: FakeQuery[] = [];
    await oneTurn(registry, 'busy', launchOpts(launched), 'msg-a');

    await registry.acquire('next', launchOpts(launched)).warm();

    expect(launched[0]?.closed).toBeGreaterThanOrEqual(1);
    expect(launched[1]?.closed).toBe(0);
    expect(registry.liveCount()).toBe(1);
  });
});
