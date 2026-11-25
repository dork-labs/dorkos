/**
 * Shared doubles and barriers for the WatcherManager test files.
 *
 * @module __tests__/watcher-manager.fixtures
 */
import * as path from 'node:path';
import { vi } from 'vitest';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import type { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import type { EndpointInfo, RelayLogger } from '../types.js';
import { deferred, type Deferred } from './fake-watcher.js';

/** A spy logger satisfying the full {@link RelayLogger} surface. */
export function createSpyLogger(): RelayLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The two `code`s that mean a watch has stopped listening for good. */
export function isExhaustion(code: string): boolean {
  return code === 'EMFILE' || code === 'ENOSPC';
}

/**
 * The `code` of every watcher failure reported since a given point in the log.
 *
 * SINCE, not in total, and that is the whole point of this helper: an `EMFILE`
 * from a watch that has already been closed and re-armed is over, and counting
 * it again would make every later window look exhausted no matter what it
 * actually reported.
 *
 * @param logger - The spy logger the manager under test was given.
 * @param since - How many `warn` calls had been made when this window opened.
 * @returns The codes reported after that point, in order.
 */
export function watcherErrorCodesSince(logger: RelayLogger, since: number): string[] {
  return vi
    .mocked(logger.warn)
    .mock.calls.slice(since)
    .filter(([message]) => String(message).includes('[watcher-error] WatcherManager'))
    .map(([, fields]) => String((fields as { code?: unknown } | undefined)?.code ?? 'unknown'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createMockMaildirStore(): MaildirStore {
  // `claim` models the real thing — an atomic `new/` -> `cur/` rename that
  // exactly one caller can win. That is the entire dedup story between the
  // startup sweep and the watcher, so a mock that said `ok: true` to everyone
  // would make a double delivery look like a pass.
  const claimed = new Set<string>();
  return {
    claim: vi.fn(async (endpointHash: string, messageId: string) => {
      const key = `${endpointHash}/${messageId}`;
      if (claimed.has(key)) {
        return { ok: false, error: 'claim failed: ENOENT' };
      }
      claimed.add(key);
      return { ok: true, envelope: { subject: 'test' }, path: `/virtual/cur/${messageId}.json` };
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/test/failed/msg.json' }),
    // Nothing is pending unless a test says so — the sweep is a no-op by default.
    listNew: vi.fn().mockResolvedValue([]),
  } as unknown as MaildirStore;
}

export function createMockSubscriptionRegistry(): SubscriptionRegistry {
  return {
    getSubscribers: vi.fn().mockReturnValue([]),
  } as unknown as SubscriptionRegistry;
}

export function createMockSqliteIndex(): SqliteIndex {
  return {
    updateStatus: vi.fn(),
  } as unknown as SqliteIndex;
}

export function createMockCircuitBreaker(): CircuitBreakerManager {
  return {
    recordFailure: vi.fn(),
  } as unknown as CircuitBreakerManager;
}

/**
 * Arm `sqliteIndex.updateStatus` as a delivery barrier.
 *
 * Flipping the index status is the last thing `handleNewMessage` does on the
 * success path, so a test awaiting the returned promise resumes exactly when the
 * dispatch finished — no polling and no clock. The `true` matches the real
 * index, which reports whether it updated a row.
 *
 * @param index - The mock index to arm.
 * @returns The barrier to await after emitting the `add` event.
 */
export function armDeliveryBarrier(index: SqliteIndex): Deferred<void> {
  const barrier = deferred();
  vi.mocked(index.updateStatus).mockImplementation(() => {
    barrier.resolve();
    return true;
  });
  return barrier;
}

/**
 * Arm a barrier that trips when `claim` is next called and has returned.
 *
 * The counterpart to {@link armDeliveryBarrier} for the paths that are
 * SUPPOSED to stop early: a duplicate dispatch loses the claim race and never
 * reaches the index, so there is no delivery to wait on — but the attempt is
 * still observable, and waiting for it is what makes "exactly once" an
 * assertion about finished work rather than about work that had not started.
 *
 * @param store - The mock store whose `claim` to wrap.
 * @returns The barrier to await after triggering the second dispatch.
 */
export function armNextClaimBarrier(store: MaildirStore): Deferred<void> {
  const barrier = deferred();
  const inner = vi.mocked(store.claim).getMockImplementation();
  if (!inner) throw new Error('armNextClaimBarrier: claim has no implementation to wrap');
  vi.mocked(store.claim).mockImplementation(async (endpointHash, messageId) => {
    const result = await inner(endpointHash, messageId);
    barrier.resolve();
    return result;
  });
  return barrier;
}

/**
 * Yield past a macrotask boundary, draining everything queued behind it.
 *
 * The claim barrier trips inside the `claim` mock, which is one microtask
 * BEFORE its caller resumes — so a duplicate dispatch that (wrongly) went on to
 * invoke a handler would not have done it yet, and "handler called once" would
 * pass for the wrong reason. A macrotask boundary drains every pending
 * microtask, including the ones those microtasks queue, so after this the
 * duplicate has finished whatever it was going to do. Nothing on that path
 * touches a timer or real IO, so one hop is a bound, not a guess.
 *
 * @returns A promise resolved on the next macrotask.
 */
export async function flushPendingDispatches(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Race a promise against a descriptive deadline.
 *
 * Only the real-filesystem smoke needs one: everything else waits on a barrier
 * the production code trips. A bare vitest timeout would say "test timed out"
 * and name nothing.
 *
 * @param promise - What to wait for.
 * @param ms - The ceiling, paid only on failure.
 * @param what - What did not happen, for the error message.
 * @returns The promise's value.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  // The timer id is held so the loser of the race can be cancelled — an
  // uncancelled timer keeps the event loop busy past the end of the test.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An endpoint over a path nothing on disk needs to exist at.
 *
 * The store, registry, index and breaker are all doubles, and the watcher is
 * injected, so no test below this line touches the filesystem at all — the
 * exception is the real-filesystem smoke test, which builds its own tmpdir.
 */
export function createEndpoint(hash = 'hash-test', subject = 'relay.agent.test'): EndpointInfo {
  return {
    subject,
    hash,
    maildirPath: path.join('/virtual/relay/endpoints', hash),
    registeredAt: '2026-02-24T00:00:00.000Z',
  };
}
