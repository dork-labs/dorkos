/**
 * A dead runtime sign-in reaches the operator from a turn nobody is watching
 * (DOR-1654).
 *
 * The gap this pins: every runtime already tags a credential failure
 * `category: 'auth_error'`, and an interactive chat draws a "Fix sign-in" card
 * off that tag — but a scheduled run, a room turn and a relay delivery each
 * consume `sendMessage` themselves, with no projector and no reader for the
 * category, so the tag was computed and dropped. A 3am task that died on an
 * expired token reached nobody.
 *
 * Driven through the REAL {@link RuntimeRegistry} and the REAL
 * {@link NotificationService}, not fakes of either, because the property under
 * test is the wiring: the watch has to be installed at the one seam every
 * caller resolves its runtime through, and it has to produce exactly one row
 * however many turns trip over the same credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { NotificationStore } from '../notification-store.js';
import { notificationEntry } from '../notification-registry.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import {
  SIGNIN_LATCH_WINDOW_MS,
  resetSigninLatch,
  setSigninFailureSink,
} from '../../observability/index.js';
import { watchRuntimeSigninFailures } from '../emitters/runtime-signin.js';

let db: Db;
let store: NotificationStore;

/** Let the emitter's fire-and-forget `notify()` settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Every `signin.required` row the store holds, newest first. */
function signinRows(): NotificationDTO[] {
  return store
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'signin.required');
}

/** A turn that yields one text event, then the runtime's own typed auth error. */
async function* authErrorTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'thinking' } } as StreamEvent;
  yield {
    type: 'error',
    data: {
      message: 'Your sign-in stopped working. Sign in again to keep going.',
      code: 'authentication_failed',
      category: 'auth_error',
    },
  } as StreamEvent;
}

/** A turn that fails for an ordinary reason — nothing to do with credentials. */
async function* executionErrorTurn(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'error',
    data: { message: 'The tool exited with code 1', category: 'execution_error' },
  } as StreamEvent;
}

/** A turn that THROWS its credential failure instead of yielding one. */
async function* thrownAuthTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
  throw new Error('401 Unauthorized: the OAuth token was revoked');
}

/** A turn that throws for an ordinary reason. */
async function* thrownExecutionTurn(): AsyncGenerator<StreamEvent> {
  throw new Error('spawn ENOENT');
}

/** Register a fake through the real registry and run one turn to completion. */
async function runTurn(
  registry: RuntimeRegistry,
  runtimeType: string,
  scenario: () => AsyncGenerator<StreamEvent>
): Promise<StreamEvent[]> {
  const runtime = new FakeAgentRuntime(runtimeType);
  runtime.withScenarios([scenario]);
  registry.register(runtime);

  const seen: StreamEvent[] = [];
  for await (const event of registry.get(runtimeType).sendMessage('sess-1', 'hi', {})) {
    seen.push(event);
  }
  await flush();
  return seen;
}

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));
  resetSigninLatch();
  // The REAL boot wiring, not a stand-in: `index.ts` calls exactly this, so a
  // change that leaves the watch reporting into nothing fails here.
  watchRuntimeSigninFailures();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(() => {
  setNotificationService(null);
  setSigninFailureSink(null);
  resetSigninLatch();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a runtime turn that fails on its sign-in', () => {
  it('tells the operator, naming the runtime in words a person can act on', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);

    const rows = signinRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Claude needs you to sign in again');
    expect(rows[0].body).toBe('Scheduled tasks and agent replies keep failing until you sign in.');
    // `notable` is the one tier the browser-banner surface draws, which is what
    // reaches somebody who left the app open overnight.
    expect(rows[0].tier).toBe('notable');
    expect(rows[0].subject).toEqual({ type: 'system', id: 'claude-code' });
  });

  it('says it once however many turns trip over the same dead credential', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.withScenarios([authErrorTurn, authErrorTurn, authErrorTurn]);
    registry.register(runtime);

    // Three turns in flight together — the shape a nightly schedule actually
    // has, and the one a store-only dedupe cannot catch, because all three ask
    // "have I said this?" before any of them has written a row.
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        for await (const _ of registry.get('claude-code').sendMessage(`sess-${i}`, 'hi', {}));
      })
    );
    await flush();

    expect(signinRows()).toHaveLength(1);
  });

  it('says it again once the window has passed, because it is still broken', async () => {
    vi.useFakeTimers();
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.withScenarios([authErrorTurn, authErrorTurn]);
    registry.register(runtime);

    for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    await flush();
    expect(signinRows()).toHaveLength(1);

    vi.advanceTimersByTime(SIGNIN_LATCH_WINDOW_MS + 1);
    for await (const _ of registry.get('claude-code').sendMessage('sess-2', 'hi', {}));
    await flush();
    expect(signinRows()).toHaveLength(2);
  });

  it('keeps each runtime separate — one dead sign-in is not the other', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);
    await runTurn(registry, 'codex', authErrorTurn);

    const titles = signinRows().map((row) => row.title);
    expect(titles).toHaveLength(2);
    expect(titles).toContain('Claude needs you to sign in again');
    expect(titles).toContain('Codex needs you to sign in again');
  });

  it('reports a credential failure the runtime THREW rather than yielded', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.withScenarios([thrownAuthTurn]);
    registry.register(runtime);

    await expect(async () => {
      for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    }).rejects.toThrow('401 Unauthorized');
    await flush();

    // Re-thrown unchanged: the watch may never alter what a caller sees.
    expect(signinRows()).toHaveLength(1);
  });
});

describe('a runtime turn that fails for any other reason', () => {
  it('says nothing about signing in', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', executionErrorTurn);

    expect(signinRows()).toHaveLength(0);
  });

  it('says nothing about signing in when it throws', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.withScenarios([thrownExecutionTurn]);
    registry.register(runtime);

    await expect(async () => {
      for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    }).rejects.toThrow('spawn ENOENT');
    await flush();

    expect(signinRows()).toHaveLength(0);
  });
});

describe('the watch itself', () => {
  it('passes every event through untouched', async () => {
    const registry = new RuntimeRegistry();
    const seen = await runTurn(registry, 'claude-code', authErrorTurn);

    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'error']);
    expect((seen[1].data as { category: string }).category).toBe('auth_error');
  });

  it('latches for exactly as long as the registry says this may be said', () => {
    // Two windows, one policy. The registry's is the declared answer; the
    // watch's is a synchronous race guard that cannot consult it. Longer there
    // would override the declaration, shorter would make it pointless — so they
    // are pinned equal here rather than left to a comment nobody re-reads.
    expect(SIGNIN_LATCH_WINDOW_MS).toBe(notificationEntry('signin.required').dedupeWindowMs);
  });

  it('leaves every other member of the runtime reachable', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    registry.register(runtime);

    const wrapped = registry.get('claude-code');
    expect(wrapped.type).toBe('claude-code');
    // Bound to the real instance, so a method that reads private state still works.
    expect(wrapped.getCapabilities()).toEqual(runtime.getCapabilities());
  });
});
