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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCapabilities, SseResponse } from '@dorkos/shared/agent-runtime';

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
      interruptQuery: async () => false,
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
      interruptQuery: async () => false,
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
      interruptQuery: async () => false,
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
      interruptQuery: async () => false,
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
      interruptQuery: async () => false,
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
      interruptQuery: async () => false,
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
