/**
 * A dead runtime sign-in reaches the operator from a turn nobody is watching,
 * reaches their PHONE when nobody deals with it, and clears itself the moment
 * signing in works again (DOR-1654, DOR-1657).
 *
 * The gap DOR-1654 pinned: every runtime already tags a credential failure
 * `category: 'auth_error'`, and an interactive chat draws a "Fix sign-in" card
 * off that tag — but a scheduled run, a room turn and a relay delivery each
 * consume `sendMessage` themselves, with no projector and no reader for the
 * category, so the tag was computed and dropped. A 3am task that died on an
 * expired token reached nobody.
 *
 * The gap DOR-1657 closes: it reached the inbox and stopped there. Push fires
 * only through the escalation ladder, and the ladder only carries STANDING
 * conditions — which need a store that answers "is this still waiting?" and a
 * resolution edge. Both now exist: the watch below is that store, and the next
 * turn on that runtime that does not fail on its sign-in is that edge.
 *
 * Driven through the REAL {@link RuntimeRegistry}, the REAL
 * {@link NotificationService} and the REAL {@link EscalationService}, not fakes
 * of any of them, because the property under test is the wiring: the watch has
 * to be installed at the one seam every caller resolves its runtime through, it
 * has to stand exactly once however many turns trip over the same credential,
 * and the ladder has to be armed and disarmed by the same key.
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
import type {
  NotificationDTO,
  StandingPendingEvent,
  StandingResolvedEvent,
} from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import { EscalationService, setEscalationService } from '../escalation-service.js';
import type { WebPushChannel } from '../channels/web-push.js';
import { resetSigninEpisodes, setRuntimeSigninSink } from '../../observability/index.js';
import { watchRuntimeSigninFailures } from '../emitters/runtime-signin.js';

/** How long the ladder waits before it reaches a phone, in these tests. */
const ESCALATION_MINUTES = 2;
const ONE_MINUTE_MS = 60 * 1000;

let db: Db;
let store: NotificationStore;
let sendToAll: ReturnType<typeof vi.fn>;
let broadcasts: Array<{ event: string; data: unknown }>;

/** Let the emitter's fire-and-forget notification calls settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Every `signin.required` row the store holds. There is one only on resolution. */
function signinRows(): NotificationDTO[] {
  return store
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'signin.required');
}

/** Every standing condition announced as having STARTED. */
function announced(): StandingPendingEvent[] {
  return broadcasts
    .filter((b) => b.event === 'standing_pending')
    .map((b) => b.data as StandingPendingEvent);
}

/** The rows written when a sign-in broke — one per episode. */
function raisedRows(): NotificationDTO[] {
  return signinRows().filter((row) => row.resolvedAt === undefined);
}

/** The rows written when a sign-in started working again. */
function clearedRows(): NotificationDTO[] {
  return signinRows().filter((row) => row.resolvedAt !== undefined);
}

/** Every standing condition announced as having ENDED. */
function retired(): StandingResolvedEvent[] {
  return broadcasts
    .filter((b) => b.event === 'standing_resolved')
    .map((b) => b.data as StandingResolvedEvent);
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

/** A turn that works. */
async function* cleanTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'here you go' } } as StreamEvent;
}

/**
 * A turn that fails for an ordinary reason — nothing to do with credentials.
 *
 * **Shaped like the real thing, which is the point.** claude-code catches a
 * pre-stream throw and YIELDS this, returning normally, so a turn that never
 * reached the provider is indistinguishable from a finished one by completion
 * alone (`runtimes/claude-code/messaging/message-sender.ts`).
 */
async function* executionErrorTurn(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'error',
    data: { message: 'The tool exited with code 1', category: 'execution_error' },
  } as StreamEvent;
}

/** A turn that says nothing but runs a tool — still proof the sign-in worked. */
async function* toolOnlyTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'tool_call_start', data: { id: 't-1', name: 'Bash' } } as StreamEvent;
  yield { type: 'done', data: { sessionId: 'sess' } } as StreamEvent;
}

/** A turn whose only output is the terminal marker, which rides failures too. */
async function* doneOnlyTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'done', data: { sessionId: 'sess' } } as StreamEvent;
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

/** Drain one turn on a registered runtime, then let the notification settle. */
async function drain(registry: RuntimeRegistry, runtimeType: string, session: string) {
  for await (const _ of registry.get(runtimeType).sendMessage(session, 'hi', {}));
  await flush();
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

/** A registry holding one runtime that will run the given turns, in order. */
function registryRunning(
  runtimeType: string,
  scenarios: Array<() => AsyncGenerator<StreamEvent>>
): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  const runtime = new FakeAgentRuntime(runtimeType);
  runtime.withScenarios(scenarios);
  registry.register(runtime);
  return registry;
}

beforeEach(() => {
  // Fake time throughout: an episode's identity is the moment it began, and both
  // the escalation delay and the "already in flight" guard are answered against
  // the clock. Microtasks are untouched by this, so `flush()` still works.
  vi.useFakeTimers();
  db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));

  sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
  setEscalationService(
    new EscalationService({
      store,
      push: { sendToAll } as unknown as WebPushChannel,
      // No chat integration on this install, which is the stock state — the push
      // leg alone has to carry it.
      relay: () => undefined,
      readDelay: () => ESCALATION_MINUTES,
    })
  );

  resetSigninEpisodes();
  // The REAL boot wiring, not a stand-in: `index.ts` calls exactly this, so a
  // change that leaves the watch reporting into nothing fails here.
  watchRuntimeSigninFailures();

  broadcasts = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((event: string, data: unknown) => {
    broadcasts.push({ event, data });
  });
});

afterEach(() => {
  setNotificationService(null);
  setEscalationService(null);
  setRuntimeSigninSink(null);
  resetSigninEpisodes();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a runtime turn that fails on its sign-in', () => {
  it('writes a durable row, in words that stay true after the fix', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);

    const [row, ...rest] = raisedRows();
    expect(rest).toEqual([]);
    expect(row.kind).toBe('signin.required');
    // Past tense, because a stored row outlives the condition it describes. It
    // is still in the inbox tomorrow, and telling somebody to sign in when they
    // already did is exactly the staleness that argued against storing at all.
    expect(row.title).toBe('Your Claude sign-in stopped working');
    expect(row.body).toBe('Scheduled tasks and agent replies cannot run until you sign in.');
    // `blocking` because it IS a condition a person can end — the difference
    // that puts it on the escalation ladder.
    expect(row.tier).toBe('blocking');
    expect(row.subject).toEqual({ type: 'system', id: 'claude-code' });
    // Unread, so the bell lights and the desktop draws a banner.
    expect(row.readAt).toBeUndefined();
  });

  it('leaves the record behind when the process forgets everything', async () => {
    // The whole reason this kind stores at the RAISE edge rather than only on
    // resolution. Its standing state is in memory, so an overnight restart
    // forgets it — and with resolution-only storage a 3am failure would leave
    // no push, no row and nothing at all to find in the morning.
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);
    resetSigninEpisodes();

    expect(raisedRows()).toHaveLength(1);
  });

  it('does not also announce a standing arrival, which would be a second banner', async () => {
    // The desktop draws one banner from the row and another from
    // `standing_pending`, with no dedupe between them — one is keyed on
    // notification id, the other on `subjectKey`. Doing both puts two banners
    // on screen for one dead credential.
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);

    expect(announced()).toEqual([]);
  });

  it('stands once however many turns trip over the same dead credential', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, authErrorTurn, authErrorTurn]);

    // Three turns in flight together — the shape a nightly schedule actually
    // has, and the one a store-only dedupe cannot catch, because all three ask
    // "have I said this?" before any of them has written anything.
    await Promise.all([0, 1, 2].map((i) => drain(registry, 'claude-code', `sess-${i}`)));

    expect(raisedRows()).toHaveLength(1);
  });

  it('keeps each runtime separate — one dead sign-in is not the other', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);
    await runTurn(registry, 'codex', authErrorTurn);

    const titles = raisedRows().map((c) => c.title);
    expect(titles).toHaveLength(2);
    expect(titles).toContain('Your Claude sign-in stopped working');
    expect(titles).toContain('Your Codex sign-in stopped working');
  });

  it('reports a credential failure the runtime THREW rather than yielded', async () => {
    const registry = registryRunning('claude-code', [thrownAuthTurn]);

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
    expect(raisedRows()).toHaveLength(1);
  });

  it('does not latch a runtime nothing can be told about', async () => {
    // The episode is claimed BEFORE the sink runs — it has to be, or the
    // concurrent case above is unfixable. So a runtime claimed while no sink is
    // installed would stand forever with nobody ever told, and every later
    // failure would find it already standing.
    setRuntimeSigninSink(null);
    const registry = registryRunning('claude-code', [authErrorTurn, authErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');
    expect(raisedRows()).toHaveLength(0);

    watchRuntimeSigninFailures();
    await drain(registry, 'claude-code', 'sess-2');
    expect(raisedRows()).toHaveLength(1);
  });
});

describe('a runtime turn that fails for any other reason', () => {
  it('says nothing about signing in', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', executionErrorTurn);

    expect(raisedRows()).toEqual([]);
  });

  it('says nothing about signing in when it throws', async () => {
    const registry = registryRunning('claude-code', [thrownExecutionTurn]);

    await expect(async () => {
      for await (const _ of registry.get('claude-code').sendMessage('sess-1', 'hi', {}));
    }).rejects.toThrow('spawn ENOENT');
    await flush();

    expect(raisedRows()).toEqual([]);
  });
});

describe('nobody signs in', () => {
  it('reaches the phone once the ladder runs out of patience', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    await vi.advanceTimersByTimeAsync((ESCALATION_MINUTES + 1) * ONE_MINUTE_MS);

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Your Claude sign-in stopped working',
        body: 'Scheduled tasks and agent replies cannot run until you sign in.',
        deepLink: '/?settings=runtimes',
        tier: 'blocking',
      })
    );
  });
});

describe('the next clean turn on that runtime', () => {
  it('clears the condition and records how it ended', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, cleanTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-2');

    // Retired under this episode's own key — the identity the ladder armed on,
    // so the disarm reaches the timer that was actually set.
    expect(retired()).toHaveLength(1);
    expect(retired()[0].subjectKey).toMatch(/^signin:claude-code:/);

    // A second row, worded differently, so the inbox reads as a true log rather
    // than the same sentence twice.
    const cleared = clearedRows();
    expect(cleared).toHaveLength(1);
    expect(cleared[0].title).toBe('Your Claude sign-in is working again');
    expect(cleared[0].outcome).toBe('cleared');
    // Already read: nobody needs a bell for a thing they just fixed themselves.
    expect(cleared[0].readAt).toBeTruthy();
    expect(raisedRows()).toHaveLength(1);
  });

  it('stops the phone ping that had not fired yet', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, cleanTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-2');
    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE_MS);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('does not clear another runtime that is also stuck', async () => {
    const registry = new RuntimeRegistry();
    const claude = new FakeAgentRuntime('claude-code');
    claude.withScenarios([authErrorTurn]);
    registry.register(claude);
    const codex = new FakeAgentRuntime('codex');
    codex.withScenarios([authErrorTurn, cleanTurn]);
    registry.register(codex);

    await drain(registry, 'claude-code', 'sess-1');
    await drain(registry, 'codex', 'sess-2');
    expect(raisedRows()).toHaveLength(2);

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'codex', 'sess-3');

    // Only Codex's. A working sign-in on one runtime says nothing whatsoever
    // about a different runtime's own credential.
    expect(retired()).toHaveLength(1);
    expect(retired()[0].subjectKey).toMatch(/^signin:codex:/);
    expect(clearedRows().map((r) => r.title)).toEqual(['Your Codex sign-in is working again']);
  });

  it('does not count a turn that was already running when the sign-in failed', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** A working turn that hangs until the test lets it finish. */
    async function* heldCleanTurn(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      await gate;
    }

    const registry = registryRunning('claude-code', [heldCleanTurn, authErrorTurn]);

    // The held turn starts first, and is still open when the credential dies.
    const held = (async () => {
      for await (const _ of registry.get('claude-code').sendMessage('sess-held', 'hi', {}));
    })();
    await flush();

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-fail');
    expect(raisedRows()).toHaveLength(1);

    release();
    await held;
    await flush();

    // It authenticated BEFORE the credential died, so its success is evidence
    // about a moment that has already passed. Clearing on it would take the
    // banner down while the sign-in is still dead.
    expect(retired()).toEqual([]);
  });

  it('does not count a turn that never reached the provider', async () => {
    // **The case that made "ran to the end" the wrong test.** claude-code
    // CATCHES a pre-stream failure and yields a typed `execution_error`, then
    // returns normally (`runtimes/claude-code/messaging/message-sender.ts`) — so
    // a `spawn ENOENT`, a dead sidecar, or any failure before the provider was
    // ever contacted looks bit-for-bit like a completed turn from here. It says
    // nothing whatsoever about the credential, and clearing on it took the
    // banner down and cancelled the phone ping while the sign-in was still dead.
    const registry = registryRunning('claude-code', [authErrorTurn, executionErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-2');

    expect(retired()).toEqual([]);
  });

  it('still reaches the phone after a turn that never reached the provider', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, executionErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');
    await drain(registry, 'claude-code', 'sess-2');

    await vi.advanceTimersByTimeAsync((ESCALATION_MINUTES + 1) * ONE_MINUTE_MS);

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it('counts a turn whose only output was a tool call', async () => {
    // Evidence of provider contact is not the same as evidence of TEXT. A turn
    // that only ran a tool still got past the sign-in, and the condition has to
    // be able to end on one — otherwise a banner outlives the fix.
    const registry = registryRunning('claude-code', [authErrorTurn, toolOnlyTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-2');

    expect(retired()).toHaveLength(1);
  });

  it('does not count a turn whose only output was a done marker', async () => {
    // `done` rides the FAILURE path too — codex's mapper emits `error` then
    // `done`, and keeps `done` even when it suppresses a duplicate error
    // (`runtimes/codex/event-mapper.ts`). A terminal marker is not contact.
    const registry = registryRunning('claude-code', [authErrorTurn, doneOnlyTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-2');

    expect(retired()).toEqual([]);
  });

  it('does not count a turn the caller walked away from', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, cleanTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    for await (const _ of registry.get('claude-code').sendMessage('sess-2', 'hi', {})) break;
    await flush();

    // An abandoned turn never reached its end, so nothing about it says the
    // credential works.
    expect(retired()).toEqual([]);
  });
});

describe('a sign-in that dies again after being fixed', () => {
  it('stands again and reaches the phone again', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, cleanTurn, authErrorTurn]);

    // The first episode is left long enough to actually reach the phone, which
    // is what puts a row in the escalation ledger — without one, the second
    // ping could not be shown to have survived the ledger's suppression check.
    await drain(registry, 'claude-code', 'sess-1');
    await vi.advanceTimersByTimeAsync((ESCALATION_MINUTES + 1) * ONE_MINUTE_MS);
    expect(sendToAll).toHaveBeenCalledTimes(1);

    await drain(registry, 'claude-code', 'sess-2');
    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-3');

    expect(raisedRows()).toHaveLength(2);
    expect(clearedRows()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync((ESCALATION_MINUTES + 1) * ONE_MINUTE_MS);

    // The second episode reaches the phone on its OWN key. On a runtime-only
    // key the ledger's "has this subject already been escalated?" check would
    // answer yes forever and swallow every later ping (the DOR-1387 shape) —
    // and the first episode's ping did fire, so the ledger has a row to answer
    // from.
    expect(sendToAll).toHaveBeenCalledTimes(2);
    const keys = sendToAll.mock.calls.map((call) => call[0].notificationId as string);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key).toMatch(/^signin:claude-code:/);
  });

  it('does not wait out a quiet window before saying so', async () => {
    // The old race guard expired on a clock, so a credential fixed at 3.10 and
    // dead again at 3.30 stayed silent until 4.00. The episode is now released
    // by the RESOLUTION rather than by time, so the second failure is heard the
    // moment it happens.
    const registry = registryRunning('claude-code', [authErrorTurn, cleanTurn, authErrorTurn]);

    await drain(registry, 'claude-code', 'sess-1');
    vi.advanceTimersByTime(1000);
    await drain(registry, 'claude-code', 'sess-2');
    vi.advanceTimersByTime(1000);
    await drain(registry, 'claude-code', 'sess-3');

    expect(raisedRows()).toHaveLength(2);
  });
});

describe('the watch itself', () => {
  it('passes every event through untouched', async () => {
    const registry = new RuntimeRegistry();
    const seen = await runTurn(registry, 'claude-code', authErrorTurn);

    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'error']);
    expect((seen[1].data as { category: string }).category).toBe('auth_error');
  });

  it('gives the episode back when nobody could be told about it', async () => {
    // The claim is made BEFORE the sink runs, so it is optimistic. Since an
    // episode is now released by a resolution rather than by a clock, a runtime
    // latched on an announcement that never happened would stay silent until
    // the server restarted.
    setRuntimeSigninSink(() => {
      throw new Error('the notification pipeline is down');
    });
    const registry = registryRunning('claude-code', [authErrorTurn, authErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');

    watchRuntimeSigninFailures();
    await drain(registry, 'claude-code', 'sess-2');

    expect(raisedRows()).toHaveLength(1);
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

    expect(raisedRows()).toHaveLength(1);
    expect(raisedRows()[0].title).toBe('Your Claude sign-in stopped working');
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

    expect(raisedRows()).toEqual([]);
  });
});
