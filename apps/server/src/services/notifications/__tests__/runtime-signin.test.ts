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
import { ClaudeCodeAdapter } from '@dorkos/relay';
import type {
  AgentRuntimeLike,
  ClaudeCodeAdapterDeps,
  RelayPublisher,
  TraceStoreLike,
} from '@dorkos/relay';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
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
const THROWN_AUTH_ERROR = new Error('401 Unauthorized: the OAuth token was revoked');

async function* thrownAuthTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
  throw THROWN_AUTH_ERROR;
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
    // `notable` is the only tier an OS banner can be drawn for at all — see the
    // registry entry for why that is a possible second surface rather than a
    // promised one. The inbox row asserted above is the guaranteed surface.
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

  it('does not go quiet for an hour when the row failed to save', async () => {
    // The latch is claimed BEFORE the row is written — it has to be, or the
    // concurrent case above is unfixable — so a claim is optimistic. `notify()`
    // swallows a store failure and answers "nothing stored", and without the
    // release that would silence this runtime for an hour on a notification
    // that never happened.
    const registry = new RuntimeRegistry();
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.withScenarios([authErrorTurn, authErrorTurn]);
    registry.register(runtime);

    const insert = vi.spyOn(store, 'insert').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    await flush();
    expect(signinRows()).toHaveLength(0);

    // The very next failing turn tries again rather than finding itself latched.
    insert.mockRestore();
    for await (const _ of registry.get('claude-code').sendMessage('sess-2', 'hi', {}));
    await flush();
    expect(signinRows()).toHaveLength(1);
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

    let caught: unknown;
    try {
      for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    } catch (err) {
      caught = err;
    }
    await flush();

    // The SAME error object, not merely one with the same message: the watch
    // observes a turn and may never substitute what a caller sees.
    expect(caught).toBe(THROWN_AUTH_ERROR);
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

/**
 * The relay leg, driven through the REAL {@link ClaudeCodeAdapter}.
 *
 * Being registered is not by itself enough — this is the case that proved it.
 * `index.ts` kept its own reference to the `ClaudeCodeRuntime` it constructed
 * (`relayAgentRuntime`) and appended it to the relay's runtime map AFTER the
 * registry's entries, so last-write-wins put the RAW runtime under
 * `claude-code`. From there it became `deps.agentManager` (`defaultRuntimeFor`
 * reads that same map) and was re-forced over the map by the adapter's own
 * constructor, so every Telegram/Slack-bridged turn ran unwatched.
 *
 * These two cases are deliberately a matched pair: the first pins the fix, the
 * second pins the bug it fixes. Together they show the first can fail — the
 * only difference between them is which object the map holds.
 *
 * They build the map themselves, so neither reads `index.ts` and neither would
 * notice the composition root going back to the raw reference. That half is
 * pinned where every other claim about that wiring already lives:
 * `apps/server/src/__tests__/relay-agent-manager-binding.test.ts`, which has
 * the extraction helper to scope it to the `new AdapterManager(...)` call
 * rather than the whole 2000-line file.
 */
describe('a relay-delivered turn on an expired claude-code sign-in', () => {
  /** Everything the adapter needs beyond its runtimes. */
  function adapterDeps(runtimes: Map<string, AgentRuntimeLike>): ClaudeCodeAdapterDeps {
    const agentManager = runtimes.get('claude-code');
    if (!agentManager) throw new Error('the fixture must put claude-code in the map');
    return {
      // Exactly how `adapter-factory.ts`'s `defaultRuntimeFor` picks it: off
      // this very map. That is why fixing the map fixes `agentManager` too.
      agentManager,
      agentRuntimes: runtimes,
      approvalAuthorizer: () => true,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
      resolveExecutionSettings: vi.fn().mockResolvedValue({}),
    };
  }

  /** A relay envelope addressed to a claude-code agent session. */
  function envelope(): RelayEnvelope {
    return {
      id: 'msg-001',
      subject: 'relay.agent.claude-code.session-1',
      from: 'adapter:telegram',
      replyTo: 'relay.human.telegram.tg-main.42',
      budget: {
        hopCount: 1,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 300_000,
        callBudgetRemaining: 10,
      },
      createdAt: new Date().toISOString(),
      payload: { content: 'are you there?' },
    } as unknown as RelayEnvelope;
  }

  /** Drive one relay message through a real adapter over the given map. */
  async function deliverThrough(runtimes: Map<string, AgentRuntimeLike>): Promise<void> {
    const adapter = new ClaudeCodeAdapter('claude-code', {}, adapterDeps(runtimes));
    await adapter.start({
      publish: vi.fn().mockResolvedValue({ messageId: 'r-1', deliveredTo: 1 }),
      onSignal: vi.fn().mockReturnValue(() => {}),
      subscribe: vi.fn().mockReturnValue(() => {}),
    } as unknown as RelayPublisher);
    await adapter.deliver(envelope().subject, envelope());
    await flush();
  }

  /** A registry holding one claude-code runtime whose next turn dies on auth. */
  function registryWithDeadSignin(): { registry: RuntimeRegistry; raw: FakeAgentRuntime } {
    const registry = new RuntimeRegistry();
    const raw = new FakeAgentRuntime('claude-code');
    raw.withScenarios([authErrorTurn]);
    registry.register(raw);
    return { registry, raw };
  }

  it('tells the operator, because the relay map holds the WATCHED runtime', async () => {
    const { registry, raw } = registryWithDeadSignin();

    // The map exactly as `index.ts` builds it, `watchedRelayRuntime` and all.
    await deliverThrough(
      new Map<string, AgentRuntimeLike>([
        ...registry.listRuntimes().map((r): [string, AgentRuntimeLike] => [r.type, r]),
        [raw.type, registry.get(raw.type)],
      ])
    );

    expect(signinRows()).toHaveLength(1);
    expect(signinRows()[0].title).toBe('Claude needs you to sign in again');
  });

  it('is silent when the map holds the raw runtime — the regression this covers', async () => {
    const { registry, raw } = registryWithDeadSignin();

    // The map as it was built BEFORE the fix: the host's own reference wins.
    await deliverThrough(
      new Map<string, AgentRuntimeLike>([
        ...registry.listRuntimes().map((r): [string, AgentRuntimeLike] => [r.type, r]),
        [raw.type, raw],
      ])
    );

    expect(signinRows()).toHaveLength(0);
  });
});
