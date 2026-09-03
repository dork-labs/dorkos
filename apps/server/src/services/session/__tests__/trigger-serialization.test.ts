/**
 * How the turn queue behaves against the REAL write-lock (DOR-1088 review).
 *
 * The queue and the lock answer different questions — "is it my turn yet?" and
 * "may I write?" — and the two have to agree, because either one alone lets a
 * second stream onto a session. These drive `triggerTurn` and
 * `triggerCommandIntent` directly against a real `SessionLockManager`, which is
 * the only way to see the seams the route-level tests sit above:
 *
 * - **G1c.** The lock expires after a TTL of silence; a chain has no TTL. So a
 *   turn that goes dark hands the session to a STRANGER one TTL later while its
 *   own client's queued turn is still politely waiting behind it. The wait is
 *   bounded so the owner is never the last to get in.
 * - **G7.** A command intent (`/compact`) shares the session's single writer with
 *   every turn, so it queues like one instead of taking the lock beside it.
 * - **DOR-1101.** The client abandons a command-intent request at 30s while the
 *   server used to keep the intent queued for the lock's full TTL. Aborting the
 *   fetch does not cancel the handler, so the person was shown a failure and the
 *   conversation was compacted minutes later anyway.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { RuntimeCapabilities, SseResponse } from '@dorkos/shared/agent-runtime';
import { COMMAND_INTENT_REQUEST_TIMEOUT_MS } from '@dorkos/shared/command-intents';

// The neutral context bag is assembled from the real filesystem (git status);
// these tests care about ordering, not context, so keep it inert and fast.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import { triggerTurn } from '../trigger-turn.js';
import type { TriggerTurnDeps } from '../trigger-turn.js';
import { triggerCommandIntent } from '../trigger-command-intent.js';
import type { TriggerCommandIntentDeps } from '../trigger-command-intent.js';
import { SessionLockManager } from '../session-lock.js';
import type { LockActivity } from '../session-lock.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';
import { SESSIONS } from '../../../config/constants.js';

const SESSION = '00000000-0000-4000-8000-0000000000cc';
const TAB = 'web-one-tab';
/** Short enough to keep the test fast; the production default is the lock TTL. */
const QUEUE_WAIT_MS = 30;

let lockManager: SessionLockManager;
/** The lifecycle each successful acquisition installed, newest last. */
let holders: Array<SseResponse & Partial<LockActivity>>;

/** A promise plus the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

beforeEach(() => {
  lockManager = new SessionLockManager();
  holders = [];
});

afterEach(() => {
  disposeProjector(SESSION);
  vi.restoreAllMocks();
});

/** The lock half of both ports, wired to the real manager. */
function lockDeps(): Pick<TriggerTurnDeps, 'acquireLock' | 'releaseLock'> {
  return {
    acquireLock: (sid, cid, res, token) => {
      const acquired = lockManager.acquireLock(sid, cid, res, token);
      if (acquired) holders.push(res);
      return acquired;
    },
    releaseLock: (sid, cid, token) => lockManager.releaseLock(sid, cid, token),
  };
}

describe('triggerTurn — a queued turn never waits longer than a stranger would (G1c)', () => {
  it('starts the queued turn once the turn ahead of it has gone dark', async () => {
    // Turn 1 emits one event and then never speaks again — the shape of a
    // subprocess that died without telling anyone. Before the bound, its own
    // client's next message waited on a slot that would never be released, while
    // any other client could have taken the abandoned lock at the TTL.
    const sends: string[] = [];
    const stuck = new Promise<void>(() => {});
    const scenarios: Array<() => AsyncGenerator<StreamEvent>> = [
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await stuck;
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'queued reply' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ];

    const deps: TriggerTurnDeps = {
      ...lockDeps(),
      sendMessage: (_sid, content) => {
        sends.push(content);
        return scenarios[sends.length - 1]!();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const projector = getOrCreateProjector(SESSION);

    const first = await triggerTurn({
      sessionId: SESSION,
      clientId: TAB,
      content: 'long turn',
      projector,
      deps,
      queueWaitMs: QUEUE_WAIT_MS,
      stallTimeoutMs: 60_000,
    });
    expect(first.accepted).toBe(true);

    // The holder falls silent: its last proof of life recedes past the TTL, so
    // the lock is now reclaimable — by anyone, including its owner. Both clocks
    // have to recede, because the manager measures from the LATER of the
    // holder's last word and the moment it took the lock. A fixed instant, not a
    // `Date.now()`-relative one: the manager samples `now` first and the probe a
    // moment later, and that drift once put a holder exactly ON the TTL rather
    // than past it (DOR-801).
    const holder = holders[0]!;
    expect(holder.lastActivityAt).toBeTypeOf('function');
    const wentDarkAt = Date.now() - SESSIONS.LOCK_TTL_MS - 1;
    holder.lastActivityAt = () => wentDarkAt;
    const locks = (lockManager as unknown as { locks: Map<string, { acquiredAt: number }> }).locks;
    locks.get(SESSION)!.acquiredAt = wentDarkAt;

    const second = await triggerTurn({
      sessionId: SESSION,
      clientId: TAB,
      content: 'queued message',
      projector,
      deps,
      queueWaitMs: QUEUE_WAIT_MS,
      stallTimeoutMs: 60_000,
    });

    expect(second.accepted).toBe(true);
    expect(sends).toEqual(['long turn', 'queued message']);
  });

  it('still refuses the queued turn while the turn ahead is demonstrably alive', async () => {
    // The bound releases the WAIT, not the lock. A turn that is still proving
    // liveness keeps the session, and its client is told so — the same answer a
    // stranger gets at the same moment, which is the point.
    const first = gate();
    const sends: string[] = [];
    const scenarios: Array<() => AsyncGenerator<StreamEvent>> = [
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await first.wait;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ];

    const deps: TriggerTurnDeps = {
      ...lockDeps(),
      sendMessage: (_sid, content) => {
        sends.push(content);
        return scenarios[sends.length - 1]!();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const projector = getOrCreateProjector(SESSION);

    expect(
      (
        await triggerTurn({
          sessionId: SESSION,
          clientId: TAB,
          content: 'long turn',
          projector,
          deps,
          queueWaitMs: QUEUE_WAIT_MS,
          stallTimeoutMs: 60_000,
        })
      ).accepted
    ).toBe(true);

    const second = await triggerTurn({
      sessionId: SESSION,
      clientId: TAB,
      content: 'queued message',
      projector,
      deps,
      queueWaitMs: QUEUE_WAIT_MS,
      stallTimeoutMs: 60_000,
    });

    expect(second.accepted).toBe(false);
    expect(sends).toEqual(['long turn']);
    first.open();
  });
});

describe('triggerCommandIntent — a compact queues like a turn (G7)', () => {
  it('waits for the same client’s live turn instead of taking the lock beside it', async () => {
    const turnGate = gate();
    const intentCalls: string[] = [];
    const sends: string[] = [];

    const turnDeps: TriggerTurnDeps = {
      ...lockDeps(),
      sendMessage: (_sid, content) => {
        sends.push(content);
        return (async function* () {
          yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
          await turnGate.wait;
          yield { type: 'done', data: {} } as StreamEvent;
        })();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const intentDeps: TriggerCommandIntentDeps = {
      ...lockDeps(),
      executeCommandIntent: (_sid, intent) => {
        intentCalls.push(intent);
        return (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
    };
    const projector = getOrCreateProjector(SESSION);

    expect(
      (
        await triggerTurn({
          sessionId: SESSION,
          clientId: TAB,
          content: 'long turn',
          projector,
          deps: turnDeps,
          queueWaitMs: 5_000,
          stallTimeoutMs: 60_000,
        })
      ).accepted
    ).toBe(true);

    let intentSettled = false;
    const intent = triggerCommandIntent({
      sessionId: SESSION,
      clientId: TAB,
      intent: 'compact',
      projector,
      deps: intentDeps,
      queueWaitMs: 5_000,
      stallTimeoutMs: 60_000,
    }).then((result) => {
      intentSettled = true;
      return result;
    });

    // The compact is waiting, not running and not refused.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(intentSettled).toBe(false);
    expect(intentCalls).toEqual([]);

    turnGate.open();
    expect((await intent).accepted).toBe(true);
    await vi.waitFor(() => expect(intentCalls).toEqual(['compact']));
    expect(sends).toEqual(['long turn']);
  });

  it('refuses a compact from a different client while the turn is alive', async () => {
    // Cross-client refusal stays the lock's answer, immediate and visible.
    const turnGate = gate();
    const intentCalls: string[] = [];

    const turnDeps: TriggerTurnDeps = {
      ...lockDeps(),
      sendMessage: () =>
        (async function* () {
          yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
          await turnGate.wait;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const intentDeps: TriggerCommandIntentDeps = {
      ...lockDeps(),
      executeCommandIntent: (_sid, intent) => {
        intentCalls.push(intent);
        return (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
    };
    const projector = getOrCreateProjector(SESSION);

    await triggerTurn({
      sessionId: SESSION,
      clientId: TAB,
      content: 'long turn',
      projector,
      deps: turnDeps,
      queueWaitMs: 5_000,
      stallTimeoutMs: 60_000,
    });

    const refused = await triggerCommandIntent({
      sessionId: SESSION,
      clientId: 'another-tab',
      intent: 'compact',
      projector,
      deps: intentDeps,
      queueWaitMs: 5_000,
      stallTimeoutMs: 60_000,
    });

    expect(refused.accepted).toBe(false);
    expect(intentCalls).toEqual([]);
    turnGate.open();
  });
});

describe('triggerCommandIntent — told it failed means it did not run (DOR-1101)', () => {
  /**
   * A session id per case. `sessionTurnQueue` is process-wide and these cases
   * deliberately leave a turn parked, so sharing one id would let a case that
   * fails mid-way wedge the next one on a chain it never released — which is a
   * timeout, not a finding.
   */
  let session: string;
  let caseIndex = 0;
  const sessionFor = (index: number): string =>
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

  /**
   * Start a long turn this client owns, then queue a compact behind it using the
   * PRODUCTION default wait — passing `queueWaitMs` here would hide the very
   * mismatch under test. Returns the levers each case needs.
   */
  function compactBehindALongTurn(): {
    turnStarted: Promise<boolean>;
    intent: Promise<{ accepted: boolean }>;
    intentCalls: string[];
    openTurn: () => void;
  } {
    const turnGate = gate();
    const intentCalls: string[] = [];
    const projector = getOrCreateProjector(session);

    const turnDeps: TriggerTurnDeps = {
      ...lockDeps(),
      sendMessage: () =>
        (async function* () {
          yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
          await turnGate.wait;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const intentDeps: TriggerCommandIntentDeps = {
      ...lockDeps(),
      executeCommandIntent: (_sid, intent) => {
        intentCalls.push(intent);
        return (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })();
      },
      interruptQuery: async () => mockInterruptReceipt('not-running'),
      getInternalSessionId: () => undefined,
    };

    const turnStarted = triggerTurn({
      sessionId: session,
      clientId: TAB,
      content: 'long turn',
      projector,
      deps: turnDeps,
      queueWaitMs: SESSIONS.LOCK_TTL_MS,
      stallTimeoutMs: SESSIONS.LOCK_TTL_MS,
    }).then((result) => result.accepted);

    const intent = turnStarted.then(() =>
      triggerCommandIntent({
        sessionId: session,
        clientId: TAB,
        intent: 'compact',
        projector,
        deps: intentDeps,
        stallTimeoutMs: SESSIONS.LOCK_TTL_MS,
      })
    );

    return { turnStarted, intent, intentCalls, openTurn: turnGate.open };
  }

  beforeEach(() => {
    caseIndex += 1;
    session = sessionFor(caseIndex);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    disposeProjector(session);
  });

  it('answers before the client abandons the request', async () => {
    const { turnStarted, intent, intentCalls, openTurn } = compactBehindALongTurn();
    expect(await turnStarted).toBe(true);

    let settled: { accepted: boolean } | undefined;
    void intent.then((result) => (settled = result));

    // The client arms `AbortSignal.timeout(COMMAND_INTENT_REQUEST_TIMEOUT_MS)`.
    // Once that elapses the person has an error on screen, so the server owes an
    // answer before it — otherwise the answer it eventually gives reaches nobody.
    await vi.advanceTimersByTimeAsync(COMMAND_INTENT_REQUEST_TIMEOUT_MS);

    expect(settled, 'the server must answer before the client gives up').toBeDefined();
    // The turn ahead is still demonstrably alive, so the honest answer is "busy".
    expect(settled?.accepted).toBe(false);
    expect(intentCalls).toEqual([]);

    // Let the parked turn finish so this case leaves the process-wide queue empty.
    openTurn();
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('never compacts after the person has been told it failed', async () => {
    const { turnStarted, intentCalls, openTurn } = compactBehindALongTurn();
    expect(await turnStarted).toBe(true);

    // Past the client's bound: the request is aborted and the person sees a
    // failure. Aborting a fetch does not cancel the handler, so whether the
    // intent still runs is entirely up to the server.
    await vi.advanceTimersByTimeAsync(COMMAND_INTENT_REQUEST_TIMEOUT_MS);

    // The long turn finally finishes and hands back the lock. THIS is the ghost:
    // an intent still parked in the queue wakes up here and compacts a
    // conversation the person was told would not be touched.
    openTurn();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(intentCalls, 'a failure the person saw must never execute later').toEqual([]);
  });
});
