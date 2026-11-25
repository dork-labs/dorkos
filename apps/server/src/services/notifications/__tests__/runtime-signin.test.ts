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
import type { NotificationDTO, StandingResolvedEvent } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { NotificationStore } from '../notification-store.js';
import {
  NotificationService,
  getNotificationService,
  setNotificationService,
} from '../notification-service.js';
import { EscalationService, setEscalationService } from '../escalation-service.js';
import type { WebPushChannel } from '../channels/web-push.js';
import {
  noteSigninRepaired,
  resetSigninEpisodes,
  setRuntimeSigninSink,
  setSigninRecheck,
  SIGNIN_RECHECK_WINDOW_MS,
} from '../../observability/index.js';
import { logger } from '../../../lib/logger.js';
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

/**
 * Let a single failure's re-check window run out, so the notice it held is
 * said (DOR-4424). Every case below that expects a banner from ONE failure
 * passes through here first.
 */
async function pastRecheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SIGNIN_RECHECK_WINDOW_MS);
  await flush();
}

/** Every `signin.required` row the store holds. There is one only on resolution. */
function signinRows(): NotificationDTO[] {
  return store
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'signin.required');
}

/** The rows written when a sign-in broke — one per episode. */
function raisedRows(): NotificationDTO[] {
  return signinRows().filter((row) => row.resolvedAt === undefined);
}

/** The rows written when a sign-in started working again. */
function clearedRows(): NotificationDTO[] {
  return signinRows().filter((row) => row.resolvedAt !== undefined);
}

/** The `since` each unresolved sign-in row carries: when its episode began. */
function standingSince(): Array<string | undefined> {
  const service = getNotificationService();
  if (!service) throw new Error('the harness must wire a service');
  return service
    .unresolvedStanding('signin.required')
    .map((row) => (row.payload as { since?: string } | undefined)?.since);
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

/**
 * A registry holding one runtime that CAN name the account each session runs
 * on — a machine with more than one Claude sign-in.
 *
 * `getSessionAccount` is assigned rather than built into `FakeAgentRuntime` on
 * purpose: the watch branches on whether the method EXISTS, and the absence is
 * the supported answer for every runtime with one set of credentials. A fake
 * that always defined it could never exercise that half.
 *
 * @param accounts - Which account each session id runs on. A session left out is
 *   one this runtime cannot place, which is a real state (a turn that failed
 *   before its launch resolved an account) and must not be a reason to say
 *   nothing.
 */
function registryWithAccounts(
  runtimeType: string,
  scenarios: Array<() => AsyncGenerator<StreamEvent>>,
  accounts: Record<string, string> | ((sessionId: string) => string | undefined)
): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  const runtime = new FakeAgentRuntime(runtimeType);
  runtime.withScenarios(scenarios);
  runtime.getSessionAccount =
    typeof accounts === 'function'
      ? accounts
      : (sessionId: string): string | undefined => accounts[sessionId];
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
  setSigninRecheck(null);
  resetSigninEpisodes();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a runtime turn that fails on its sign-in', () => {
  it('writes a durable row, in words that stay true after the fix', async () => {
    const registry = new RuntimeRegistry();
    await runTurn(registry, 'claude-code', authErrorTurn);
    await pastRecheck();

    const [row, ...rest] = raisedRows();
    expect(rest).toEqual([]);
    expect(row.kind).toBe('signin.required');
    // Past tense, because a stored row outlives the condition it describes. It
    // is still in the inbox tomorrow, and telling somebody to sign in when they
    // already did is exactly the staleness that argued against storing at all.
    expect(row.title).toBe('Your Claude Code sign-in stopped working');
    expect(row.body).toBe('Its tasks and replies wait until you sign in.');
    // `blocking` because it IS a condition a person can end — the difference
    // that puts it on the escalation ladder.
    expect(row.tier).toBe('blocking');
    expect(row.subject).toEqual({ type: 'system', id: 'claude-code' });
    // Unread, so the bell lights and the desktop draws a banner.
    expect(row.readAt).toBeUndefined();
  });

  it('stands once however many turns trip over the same dead credential', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn, authErrorTurn, authErrorTurn]);

    // Three turns in flight together — the shape a nightly schedule actually
    // has, and the one a store-only dedupe cannot catch, because all three ask
    // "have I said this?" before any of them has written anything.
    await Promise.all([0, 1, 2].map((i) => drain(registry, 'claude-code', `sess-${i}`)));
    await pastRecheck();

    expect(raisedRows()).toHaveLength(1);
  });
});

/**
 * One failure is not yet an alarm (DOR-4424). A sign-in can fail once and work
 * on the next try, so a single failure waits out a short window and gets one
 * re-check before anybody is told; a second failure in the window is no blip.
 */
describe('a single sign-in failure', () => {
  it('raises nothing for 30 s, then one banner dated from the failure', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn]);
    const failedAt = new Date(Date.now()).toISOString();
    await drain(registry, 'claude-code', 'sess-1');

    await vi.advanceTimersByTimeAsync(SIGNIN_RECHECK_WINDOW_MS - 1);
    await flush();
    expect(raisedRows()).toEqual([]);
    expect(sendToAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(raisedRows()).toHaveLength(1);
    // The episode began at the failure, not when the window ran out.
    expect(standingSince()).toEqual([failedAt]);
  });
});

/**
 * Every clear says in the log what cleared it (DOR-4425), so a banner that went
 * away can be traced to the turn, probe, login or accept that took it down.
 */
describe('the log line a clear writes', () => {
  /** The `Sign-in cleared` lines the logger was given. */
  function clearedLines(calls: unknown[][]): unknown[][] {
    return calls.filter(([message]) => message === '[Runtimes] Sign-in cleared');
  }

  it('says once what cleared a signed-out account', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const registry = registryWithAccounts('claude-code', [authErrorTurn], {
      'sess-dead': '/home/dev/.claude',
    });
    await drain(registry, 'claude-code', 'sess-dead');
    await pastRecheck();

    noteSigninRepaired('claude-code', '/home/dev/.claude', 'login');
    // Already fine by now, so a second word would be noise.
    noteSigninRepaired('claude-code', '/home/dev/.claude', 'login');

    expect(clearedLines(info.mock.calls)).toEqual([
      [
        '[Runtimes] Sign-in cleared',
        { runtime: 'claude-code', account: '/home/dev/.claude', cause: 'login' },
      ],
    ]);
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
        title: 'Your Claude Code sign-in stopped working',
        body: 'Its tasks and replies wait until you sign in.',
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
    expect(cleared[0].title).toBe('Your Claude Code sign-in is working again');
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
});

/**
 * A machine running more than one Claude account (DOR-1682).
 *
 * The condition is about a CREDENTIAL, and a credential belongs to an account
 * root — but the watch used to key its episodes on the runtime TYPE alone, so a
 * clean turn on a healthy account resolved a condition a DEAD one had raised.
 * Under ordinary traffic that all-clear lands within seconds of the failure and
 * keeps landing, which cancels the escalation ladder every time and means the
 * phone leg never runs at all.
 *
 * Driven through the same real registry and real notification stack as
 * everything above, with the runtime answering `getSessionAccount` — the one
 * seam that can say which of a runtime's own credentials a turn used.
 */
describe('a machine with more than one account on one runtime', () => {
  it('leaves the dead account standing however well the healthy one works', async () => {
    const registry = registryWithAccounts('claude-code', [authErrorTurn, cleanTurn, cleanTurn], {
      'sess-dead': '~/.claude',
      'sess-live-1': '~/.claude2',
      'sess-live-2': '~/.claude2',
    });

    await drain(registry, 'claude-code', 'sess-dead');
    await pastRecheck();
    expect(raisedRows()).toHaveLength(1);

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-live-1');
    vi.advanceTimersByTime(ONE_MINUTE_MS);
    await drain(registry, 'claude-code', 'sess-live-2');

    // Two turns that reached the provider and were let in — and neither says
    // anything whatsoever about the account that is actually broken.
    expect(retired()).toEqual([]);
    expect(clearedRows()).toEqual([]);
  });
});

/**
 * The operator signs back in, and the notice stands down (DOR-1910).
 *
 * The reported bug, exactly: the default Claude account's credential died, the
 * operator took the banner's own "Sign in" button, signed in, sent a message and
 * got a reply — and the banner stayed, through a browser reload, because that
 * message happened to run on a SECOND Claude account. Waiting for a turn on the
 * dead account was the only exit, and nothing guarantees one ever comes.
 *
 * Driven through {@link noteSigninRepaired} — the seam a completed vendor login
 * calls (`services/runtimes/connect/delegated-login.ts`) — into the same real
 * notification stack as everything above, because the property under test is
 * that a sign-in writes the `cleared` row the app's standing banner reads.
 */
describe('signing back in', () => {
  it('stands the notice down on the account that was signed in', async () => {
    const registry = registryWithAccounts('claude-code', [authErrorTurn], {
      'sess-dead': '/home/dev/.claude',
    });

    await drain(registry, 'claude-code', 'sess-dead');
    await pastRecheck();
    expect(raisedRows()).toHaveLength(1);
    expect(clearedRows()).toEqual([]);

    vi.advanceTimersByTime(ONE_MINUTE_MS);
    noteSigninRepaired('claude-code', '/home/dev/.claude', 'login');
    await flush();

    expect(retired()).toHaveLength(1);
    expect(clearedRows().map((row) => row.title)).toEqual(['Your Main sign-in is working again']);
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
    await pastRecheck();

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
});

/**
 * The restart hole, and the boot repair that closes it (DOR-1680).
 *
 * The episode store is in MEMORY, so a server killed between the two edges of
 * one episode leaves a raise row that nothing can ever resolve: the next clean
 * turn finds no episode and returns having written nothing. The Inbox survived
 * that — a row is a record, written in the past tense — but the web app's
 * standing banner reads the same rows as the present tense, so the row would
 * claim a dead sign-in for the rest of the install's life.
 *
 * Simulated by doing to this process exactly what a restart does: drop the sink,
 * clear the episode store, and run the boot wiring again over the same database.
 */
describe('a server restart that stranded an episode', () => {
  /** What a restart leaves behind: the same store, an empty memory. */
  function restart(): void {
    setRuntimeSigninSink(null);
    resetSigninEpisodes();
    watchRuntimeSigninFailures();
  }

  /**
   * A raise row exactly as DOR-1654 (PR #1409) wrote them: payload `{ runtime }`
   * and nothing else, because `since` did not exist yet.
   *
   * **These rows are real, on installs that exist.** `signin.required` shipped
   * as a plain event first and became standing-recorded in DOR-1657; every row
   * written in between — including on this repo's own dogfood install, which ran
   * that build for about seventeen hours — carries no episode stamp. They can
   * never be resolved by a turn (the kind was not standing when they were
   * written), so if the boot repair skips them they are permanent, and the
   * banner with them.
   */
  function seedLegacyRaiseRow(runtime: string): void {
    store.insert({
      kind: 'signin.required',
      tier: 'blocking',
      subjectType: 'system',
      subjectId: runtime,
      title: `Your ${runtime} sign-in stopped working`,
      payload: { runtime },
      dedupeKey: `signin:${runtime}`,
    });
  }

  it('closes a row from before episodes existed, which carries no `since` at all', async () => {
    // The rows DOR-1654 wrote (PR #1409). Nothing about them can ever be
    // resolved by a turn, so skipping them here makes the banner permanent on
    // exactly the installs that have one.
    seedLegacyRaiseRow('claude-code');
    expect(raisedRows()).toHaveLength(1);

    restart();
    await flush();

    const [closed, ...rest] = clearedRows();
    expect(rest).toEqual([]);
    expect(closed.outcome).toBe('cleared');
    // Stamped from the row's own `createdAt`, since its payload had nothing —
    // and the newest row for the runtime is now this one, which is what the
    // banner predicate reads.
    expect(signinRows()[0].id).toBe(closed.id);
  });

  it('closes the raise row nobody is left to answer', async () => {
    const registry = registryRunning('claude-code', [authErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');
    await pastRecheck();
    expect(raisedRows()).toHaveLength(1);
    expect(clearedRows()).toEqual([]);

    restart();
    await flush();

    const [closed, ...rest] = clearedRows();
    expect(rest).toEqual([]);
    expect(closed.outcome).toBe('cleared');
    // The newest row for this runtime is now a resolved one, which is the exact
    // question every reader asks — the Inbox, and the web app's standing banner
    // (`widgets/app-banner`, whose predicate is "newest row per runtime, live
    // while `outcome !== 'cleared'`").
    expect(signinRows()[0].id).toBe(closed.id);
  });

  it('boots the watch anyway when the repair read fails', async () => {
    // A locked database at exactly this moment (SQLITE_BUSY) must cost the
    // tidy-up, never the watch: a throw out of here would take the whole
    // installation with it and leave every runtime unwatched (DOR-584's shape).
    const service = getNotificationService();
    if (!service) throw new Error('the harness must wire a service');
    vi.spyOn(service, 'unresolvedStanding').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => restart()).not.toThrow();
    await flush();

    // And the sink really is installed: a failing turn still writes its row.
    const registry = registryRunning('claude-code', [authErrorTurn]);
    await drain(registry, 'claude-code', 'sess-1');
    await pastRecheck();
    expect(raisedRows()).toHaveLength(1);
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
    await pastRecheck();

    expect(raisedRows()).toHaveLength(1);
    expect(raisedRows()[0].title).toBe('Your Claude Code sign-in stopped working');
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
    await pastRecheck();

    expect(raisedRows()).toEqual([]);
  });
});
