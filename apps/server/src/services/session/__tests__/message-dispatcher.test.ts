/**
 * What the single ingress decides, driven directly (spec
 * `persistent-session-runtime` task 2.3).
 *
 * These sit BELOW the routes on purpose. The route suites already pin the HTTP
 * answers this task deliberately leaves alone (202, 409, the held socket); what
 * is new here is the queue underneath them, and every one of its rules is a rule
 * about a session's state rather than about a request:
 *
 * - a message arriving while its own client's turn runs is accepted and WAITS,
 * - it moves when the turn ENDS, and not when the turn merely produced output,
 * - it does not move into an open permission ask,
 * - and a turn that FAILED still frees the queue behind it.
 *
 * The store is real SQLite, because "the message survives" is the promise and a
 * fake would be asserting the promise against itself.
 *
 * Each case gets its own session id. The turn chain underneath
 * (`SessionTurnQueue`, DOR-1088) is process-wide and has no reset, so a case
 * that leaves a turn parked would otherwise make the NEXT case wait out a lock
 * TTL and fail as a timeout somewhere unrelated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { Db } from '@dorkos/db';

// The neutral context bag is assembled off the real filesystem (git status);
// these cases care about dispatch order, not context, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  dispatchCommandIntent,
  listQueuedMessages,
  noteSessionOrphaned,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../session-state-projector.js';

const TAB = 'window-a';

let db: Db;
let store: MessageQueueStore;
let runtime: FakeAgentRuntime;
let session: string;
let sessionCounter = 0;
/** Every gate a case opened a turn behind, so `afterEach` can drain them. */
let openGates: Array<() => void>;
/** Projector ids to dispose, beyond the case's own session. */
let extraProjectors: string[];

/** A promise plus the function that resolves it; registered for teardown. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  openGates.push(open);
  return { wait, open };
}

/** Dispatch with the fields these cases do not care about filled in. */
function send(content: string, extra: Record<string, unknown> = {}) {
  return dispatchMessage({
    sessionId: session,
    clientId: TAB,
    content,
    projector: getOrCreateProjector(session),
    runtime,
    ...extra,
  });
}

/** Let queued microtasks and the pump's deferral drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A turn that streams a token, parks on `hold`, then ends cleanly. */
function heldTurn(hold: Promise<void>, marks?: { order: string[]; label: string }) {
  return async function* (): AsyncGenerator<StreamEvent> {
    marks?.order.push(`${marks.label}:start`);
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    marks?.order.push(`${marks.label}:end`);
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** A turn that ends immediately. */
function quickTurn(marks?: { order: string[]; label: string }) {
  return async function* (): AsyncGenerator<StreamEvent> {
    marks?.order.push(`${marks.label}:start`);
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

beforeEach(() => {
  sessionCounter += 1;
  session = `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
  openGates = [];
  extraProjectors = [];
  db = createTestDb();
  store = new MessageQueueStore(db);
  setMessageQueueStore(store);
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
});

afterEach(async () => {
  // Unpark anything the case left held so no generator (and no chain slot)
  // outlives it, then let the turns settle before the projector goes.
  for (const open of openGates) open();
  await settle();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  for (const id of extraProjectors) disposeProjector(id);
  vi.restoreAllMocks();
});

describe('dispatchMessage — an idle session runs the message now', () => {
  it('runs immediately and reports no degradation', async () => {
    runtime.withScenarios([quickTurn()]);

    const result = await send('hello');

    expect(result.accepted).toBe(true);
    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'queue',
      applied: 'queue',
    });
    expect(result.outcome.degradedBecause).toBeUndefined();
    expect(result.queuePosition).toBe(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    // Dequeued on dispatch: nothing is left waiting for a message that ran.
    await settle();
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('hands the runtime the message id, so a result can be correlated by id', async () => {
    runtime.withScenarios([quickTurn()]);

    const result = await send('hello');

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      session,
      'hello',
      expect.objectContaining({ messageId: result.outcome.messageId })
    );
  });
});

describe('dispatchMessage — a busy session queues the message', () => {
  it('accepts it, keeps it durable, and dispatches on the running turn’s turn_end', async () => {
    const first = gate();
    const order: string[] = [];
    runtime.withScenarios([
      heldTurn(first.wait, { order, label: 'turn-1' }),
      quickTurn({ order, label: 'turn-2' }),
    ]);

    await send('long turn');
    const second = send('queued message');
    await settle();

    // Accepted and persisted, not running: the words survive a refresh from the
    // moment the sender was told yes.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const queued = listQueuedMessages(session);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('queued message');
    expect(queued[0]?.enqueuedBy).toBe(TAB);
    // The row is in SQLite, not merely in memory.
    expect(store.list(session).map((row) => row.content)).toEqual(['queued message']);

    first.open();
    const result = await second;

    expect(result.accepted).toBe(true);
    expect(order).toEqual(['turn-1:start', 'turn-1:end', 'turn-2:start']);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    await settle();
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('dispatches queued messages in queue order, one at a time', async () => {
    const gates = [gate(), gate(), gate()];
    const order: string[] = [];
    runtime.withScenarios(gates.map((g, i) => heldTurn(g.wait, { order, label: `turn-${i + 1}` })));

    await send('first');
    const second = send('second');
    const third = send('third');
    await settle();

    expect(listQueuedMessages(session).map((m) => m.content)).toEqual(['second', 'third']);

    gates[0]!.open();
    await second;
    await settle();
    expect(order).toEqual(['turn-1:start', 'turn-1:end', 'turn-2:start']);
    expect(listQueuedMessages(session).map((m) => m.content)).toEqual(['third']);

    gates[1]!.open();
    await third;
    expect(order).toContain('turn-3:start');
  });

  it('still dispatches the queue behind a turn that FAILED', async () => {
    const first = gate();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await first.wait;
        throw new Error('the runtime fell over');
      },
      quickTurn(),
    ]);

    await send('long turn');
    const second = send('queued behind a failure');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    first.open();
    const result = await second;

    // A failed turn still ends like any other — status_change(error), the typed
    // error, one turn_end(error) — so the message behind it runs rather than
    // being eaten by the failure.
    expect(result.accepted).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchMessage — never into an open permission ask', () => {
  it('holds the queue while an interaction is pending and releases it on resolution', async () => {
    const first = gate();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield {
          type: 'approval_required',
          data: {
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: '{}',
            timeoutMs: 60_000,
            remainingMs: 60_000,
          },
        } as unknown as StreamEvent;
        await first.wait;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      quickTurn(),
    ]);

    await send('run something dangerous');
    const second = send('queued behind an approval');
    await settle();

    const projector = getOrCreateProjector(session);
    expect(projector.hasPendingInteractions()).toBe(true);

    // The turn ENDS with the approval still unanswered — a stall, an interrupt,
    // a crash. The queue must not move: nobody answered the ask, and the next
    // prompt would be read as the person's reply to it.
    first.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(listQueuedMessages(session)).toHaveLength(1);

    // Answered. Now, and only now, the queue moves.
    projector.resolveInteraction('call-1', 'approved');
    const result = await second;
    expect(result.accepted).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchMessage — the disposition ladder', () => {
  it.each(['steer', 'stage'] as const)(
    'degrades %s to queue, and says why',
    async (disposition) => {
      runtime.withScenarios([quickTurn()]);

      const result = await send('course-correct', { disposition });

      expect(result.outcome).toEqual({
        messageId: expect.any(String),
        requested: disposition,
        applied: 'queue',
        degradedBecause: 'unsupported',
      });
    }
  );

  it('records what was REQUESTED on the row, never what was applied', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const second = send('steer me', { disposition: 'steer' });
    await settle();

    expect(store.list(session)[0]?.disposition).toBe('steer');
    first.open();
    await second;
  });
});

describe('dispatchCommandIntent — a compact contends like a turn', () => {
  it('waits for the same client’s live turn rather than running beside it', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait)]);

    await send('long turn');
    const compacting = dispatchCommandIntent({
      sessionId: session,
      clientId: TAB,
      intent: 'compact',
      projector: getOrCreateProjector(session),
      runtime,
      queueWaitMs: 5_000,
    });
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    first.open();
    expect((await compacting).accepted).toBe(true);
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
  });

  it('hands the session back when the compact finishes, so the next message runs', async () => {
    // The failure this pins: a compact holds the session's single writer, and a
    // dispatcher that never learns the run ENDED goes on believing the session
    // busy. Every later message from that client then waits for a turn that
    // finished minutes ago — a session that silently stops answering.
    runtime.withScenarios([quickTurn()]);

    await dispatchCommandIntent({
      sessionId: session,
      clientId: TAB,
      intent: 'compact',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();

    const after = await send('and now a normal message');

    expect(after.accepted).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not put a command intent into somebody’s message queue', async () => {
    await dispatchCommandIntent({
      sessionId: session,
      clientId: TAB,
      intent: 'compact',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();
    // A queue row is a person's words waiting to be said. `/compact` is neither.
    expect(listQueuedMessages(session)).toEqual([]);
  });
});

describe('the queue follows a session that gains its canonical id', () => {
  it('moves every queued row across the mid-first-turn rename', async () => {
    const first = gate();
    const canonical = `${session}-canonical`;
    extraProjectors.push(canonical);
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const second = send('typed while the id was still a request uuid');
    await settle();
    expect(store.list(session)).toHaveLength(1);

    // The rename the adapter performs mid-first-turn, driven through the one
    // choke point every id-keyed subsystem hangs off.
    rekeyProjector(session, canonical);

    expect(store.list(session)).toEqual([]);
    expect(store.list(canonical).map((row) => row.content)).toEqual([
      'typed while the id was still a request uuid',
    ]);
    // And it still runs: the in-memory half followed the rows.
    first.open();
    expect((await second).accepted).toBe(true);
  });
});

describe('the orphan sweep', () => {
  it('deletes the queue of a session the fleet reported gone, and spares a live one', () => {
    const gone = `${session}-gone`;
    store.enqueue({ sessionId: session, content: 'still wanted', clientId: TAB });
    store.enqueue({ sessionId: gone, content: 'gone', clientId: TAB });
    // A live projector is what "this session still exists" means here.
    getOrCreateProjector(session);

    noteSessionOrphaned(session);
    noteSessionOrphaned(gone);
    const removed = sweepOrphanedMessageQueues();

    expect(removed).toBe(1);
    expect(store.list(gone)).toEqual([]);
    expect(store.list(session).map((row) => row.content)).toEqual(['still wanted']);
  });

  it('does nothing at all until a session is actually reported gone', () => {
    const untouched = `${session}-untouched`;
    store.enqueue({ sessionId: untouched, content: 'nobody said this was gone', clientId: TAB });
    expect(sweepOrphanedMessageQueues()).toBe(0);
    expect(store.list(untouched)).toHaveLength(1);
  });
});
