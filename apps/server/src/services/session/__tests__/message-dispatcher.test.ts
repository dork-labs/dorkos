/**
 * What the single ingress decides, driven directly (spec
 * `persistent-session-runtime` tasks 2.3 and 2.4).
 *
 * These sit BELOW the routes on purpose. The route suites pin the HTTP shape of
 * the answer; every rule here is a rule about a session's state rather than
 * about a request:
 *
 * - a message arriving while a turn runs is accepted and WAITS, whichever
 *   window sent it, and the sender is told so straight away rather than held,
 * - it moves when the turn ENDS, and not when the turn merely produced output,
 * - it does not move into an open permission ask,
 * - a turn that FAILED still frees the queue behind it,
 * - and a launch the write-lock refuses leaves the words where they were.
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
import { isDispatchId } from '@dorkos/shared/dispatch-id';

// The neutral context bag is assembled off the real filesystem (git status);
// these cases care about dispatch order, not context, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  adoptQueuedMessages,
  deliverStage,
  deliverSteer,
  dispatchMessage,
  dispatchCommandIntent,
  listQueuedMessages,
  noteSessionOrphaned,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../message-dispatcher.js';
import { resetStagedContextStore } from '../staged-context-store.js';
import { assembleAdditionalContext } from '../context-assembler.js';
import type { DispatchContext } from '../../../lib/dispatch-context.js';
import { currentDispatch, currentDispatchId } from '../../../lib/dispatch-context.js';
import { recentDispatches, resetDispatchBuffers } from '../../observability/dispatch-buffers.js';
// The routes' mutation API, driven here because what it changes is what the
// dispatcher then RUNS — the edit and the turn are one promise, not two.
import { cancelQueuedMessage, editQueuedMessage } from '../queued-message-edits.js';
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

/** What the session's projector says it is doing right now. */
function projectorStatus(): string {
  return getOrCreateProjector(session).getStatus().lifecycle;
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
  resetStagedContextStore();
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

    // Accepted long ago — this await returns whether or not the turn ahead has
    // ended (task 2.4). What the gate releases is the DISPATCH, not the answer.
    expect((await second).queued).toBe(true);
    first.open();
    await settle();

    expect(order).toEqual(['turn-1:start', 'turn-1:end', 'turn-2:start']);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
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
    await settle();
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

    expect((await second).queued).toBe(true);
    first.open();
    await settle();

    // A failed turn still ends like any other — status_change(error), the typed
    // error, one turn_end(error) — so the message behind it runs rather than
    // being eaten by the failure.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchMessage — a busy session is a queue, not a refusal (task 2.4)', () => {
  it('takes a SECOND window’s message and runs it when the first turn ends', async () => {
    // The behavior this task retires: a second window used to be told 409 and
    // its words stayed in its own composer or were lost. The lock still exists —
    // it is the mutex one turn window holds, and its inactivity TTL still
    // reclaims a turn that went dark (DOR-782) — but it is no longer an answer
    // anybody gets for having sent a message while the agent was working.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const second = await send('from the other window', { clientId: 'window-b' });

    expect(second.accepted).toBe(true);
    expect(second.queued).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(listQueuedMessages(session)).toMatchObject([
      { content: 'from the other window', enqueuedBy: 'window-b' },
    ]);

    first.open();
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      session,
      'from the other window',
      expect.anything()
    );
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('answers at ACCEPTANCE, while the turn ahead is still running', async () => {
    // The DOR-1088 held socket, retired. This `await` returning at all is the
    // measurement: the turn ahead is parked on a gate this test has not opened,
    // so a dispatch that waited for it could not resolve here.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const queued = await send('typed while it worked');

    expect(queued.queued).toBe(true);
    expect(queued.queuePosition).toBe(1);
    expect(projectorStatus()).toBe('streaming');
  });

  it('refuses instead of queueing for a caller that asked to (whenBusy: refuse)', async () => {
    // Rooms and the MCP sign-in nudge: a trigger a machine generated on
    // somebody's behalf, where firing it late is worse than not firing it.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const refused = await send('a room turn', { whenBusy: 'refuse' });

    expect(refused.accepted).toBe(false);
    expect(refused.queued).toBe(false);
    // Refused means refused: nothing was written, so nothing runs later either.
    expect(listQueuedMessages(session)).toEqual([]);
    expect(store.list(session)).toEqual([]);
    first.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing behind when the write-lock refuses a whenBusy: refuse caller', async () => {
    // The other way a refuse-caller can fail: the session looks free, so the
    // message is written, and the lock turns it down at the launch. Its row has
    // to go with it — a room's prompt left sitting in somebody's composer is a
    // message nobody typed and nobody can explain.
    runtime.acquireLock.mockReturnValue(false);

    const refused = await send('a room turn', { whenBusy: 'refuse' });

    expect(refused.accepted).toBe(false);
    expect(store.list(session)).toEqual([]);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the words when the write-lock refuses the launch', async () => {
    // A lock held by something this module does not track (a crashed turn
    // inside its TTL). The message was accepted, so it must not evaporate —
    // that is the loss DOR-480 named. It stays queued and runs when the lock
    // frees up.
    runtime.acquireLock.mockReturnValue(false);

    const result = await send('nobody must lose this');

    expect(result.accepted).toBe(true);
    expect(result.queued).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(store.list(session).map((row) => row.content)).toEqual(['nobody must lose this']);
  });
});

describe('editing and removing what is waiting', () => {
  it('runs the words as EDITED, not as first typed', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const queued = await send('frist draft');

    const edited = editQueuedMessage(session, queued.outcome.messageId, {
      content: 'first draft, spelled properly',
    });
    expect(edited?.content).toBe('first draft, spelled properly');

    first.open();
    await settle();

    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      session,
      'first draft, spelled properly',
      expect.anything()
    );
  });

  it('a removed message does not run later', async () => {
    // The pending dispatch has to go with the row. Left armed, the message the
    // person removed would fire anyway the moment the turn ahead ended.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const queued = await send('never mind');

    expect(cancelQueuedMessage(session, queued.outcome.messageId)?.content).toBe('never mind');
    expect(listQueuedMessages(session)).toEqual([]);

    first.open();
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('will not reach into another session’s queue', async () => {
    const other = `${session}-other`;
    extraProjectors.push(other);
    const row = store.enqueue({ sessionId: other, content: 'not yours', clientId: TAB });

    expect(editQueuedMessage(session, row.id, { content: 'hijacked' })).toBeUndefined();
    expect(cancelQueuedMessage(session, row.id)).toBeUndefined();
    expect(store.list(other).map((r) => r.content)).toEqual(['not yours']);
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
    expect((await second).queued).toBe(true);
    projector.resolveInteraction('call-1', 'approved');
    await settle();
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

describe('deliverSteer — a steer is a write, authorized like a send (task 4.1)', () => {
  it('lets the client that OWNS the live write-lock steer it, reaching the runtime', async () => {
    // The real write-lock is the authority: `isLocked(key, cid)` is false for the
    // owner. TAB holds it, so TAB may inject into the running turn.
    runtime.isLocked.mockImplementation((_sid, cid) => cid !== undefined && cid !== TAB);

    const result = await deliverSteer({
      sessionId: session,
      clientId: TAB,
      content: 'also check the tests',
      messageId: 'steer-1',
      runtime,
    });

    expect(result.authorized).toBe(true);
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      session,
      'also check the tests',
      expect.objectContaining({ mode: 'steer', messageId: 'steer-1' })
    );
    // The FakeAgentRuntime answers `{ delivered: true }`.
    expect(result.delivered).toBe(true);
  });

  it('refuses a DIFFERENT client, and never reaches the runtime (AC6)', async () => {
    // The lock is held by TAB. window-b could not START a turn on this session
    // now — the lock is held against it, `isLocked(key, 'window-b') === true` —
    // so it may not steer the running one either. Refused before the runtime is
    // ever asked.
    runtime.isLocked.mockImplementation((_sid, cid) => cid !== undefined && cid !== TAB);

    const result = await deliverSteer({
      sessionId: session,
      clientId: 'window-b',
      content: 'let me in',
      messageId: 'steer-2',
      runtime,
    });

    expect(result).toEqual({ authorized: false, delivered: false });
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
  });

  it('refuses a non-owner even when inFlight is EMPTY but the lock is held (finding 1)', async () => {
    // The budget-exhausted hole: a launch that ran past its wait budget holds
    // the REAL write-lock without ever claiming the dispatcher's `inFlight`
    // mirror. So `inFlight` is empty here (no dispatch has run in this test) while
    // a steerable turn is live and owned by TAB. Gating on `inFlight` would see
    // no owner and authorize ANYONE; gating on the lock refuses window-b. This is
    // the exact case the lossy mirror got wrong.
    runtime.isLocked.mockImplementation((_sid, cid) => cid !== undefined && cid !== TAB);

    const result = await deliverSteer({
      sessionId: session,
      clientId: 'window-b',
      content: 'sneak in through the empty mirror',
      messageId: 'steer-3',
      runtime,
    });

    expect(result).toEqual({ authorized: false, delivered: false });
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
    // Proof the check consulted the real authority, not the mirror.
    expect(runtime.isLocked).toHaveBeenCalledWith(session, 'window-b');
  });
});

describe('deliverSteer — a delivered steer emits one turn_input into the open turn (task 4.3)', () => {
  /** Open a turn and hold it, so the projector has a live turn to steer into. */
  async function openHeldTurn(): Promise<() => void> {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait)]);
    await send('long turn');
    await settle();
    // Sanity: the turn is genuinely open, so there is something to steer.
    expect(projectorStatus()).toBe('streaming');
    return first.open;
  }

  it('emits exactly one turn_input, riding the OPEN turn, per delivered steer (AC1)', async () => {
    await openHeldTurn();

    const result = await deliverSteer({
      sessionId: session,
      clientId: TAB,
      content: 'actually, check the tests too',
      messageId: 'steer-a',
      runtime,
    });

    expect(result).toEqual({ authorized: true, delivered: true });
    const events = getOrCreateProjector(session).replayFrom(0);
    const inputs = events.filter((e) => e.type === 'turn_input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      type: 'turn_input',
      content: 'actually, check the tests too',
      disposition: 'steer',
      messageId: 'steer-a',
    });
    // Ingested into the open turn, not opening or closing one: it lands INSIDE
    // the live window (after turn_start, before any turn_end), which is exactly
    // what makes it render inline where it arrived.
    const live = getOrCreateProjector(session).peekInProgressTurn();
    expect(live?.some((e) => e.type === 'turn_input')).toBe(true);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
  });

  it('replays the turn_input gap-free from a mid-turn cursor, in position (AC3)', async () => {
    // A client reconnecting with Last-Event-ID resumes off the durable stream's
    // replay, which is exactly `projector.replayFrom(cursor)` (the /events route
    // serves it). A steer ingested mid-turn must replay in its true slot with a
    // contiguous seq — no gap, no reorder.
    await openHeldTurn();
    const projector = getOrCreateProjector(session);

    // Where a client that has seen the turn so far would resume from.
    const beforeSteer = projector.replayFrom(0);
    const cursor = beforeSteer[beforeSteer.length - 1]!.seq;

    await deliverSteer({
      sessionId: session,
      clientId: TAB,
      content: 'mid-turn steer',
      messageId: 'steer-r',
      runtime,
    });

    // A cold replay shows it inline, in order, inside the open turn — the steer
    // sits after the assistant text it followed. (`queue_update` bookkeeping from
    // the send also rides the stream; it is not part of the turn's transcript.)
    const turnContent = projector
      .replayFrom(0)
      .filter((e) => e.type !== 'queue_update')
      .map((e) => e.type);
    expect(turnContent).toEqual(['turn_start', 'text_delta', 'turn_input']);
    // A mid-turn resume returns only the tail, gap-free: the turn_input's seq is
    // exactly one past the cursor, nothing skipped.
    const tail = projector.replayFrom(cursor);
    expect(tail.map((e) => e.seq)).toEqual(tail.map((_, i) => cursor + 1 + i));
    expect(tail[0]).toMatchObject({ type: 'turn_input', content: 'mid-turn steer' });
  });

  it('leaves turn_start and turn_end at one each, however many steers it took (AC2)', async () => {
    const open = await openHeldTurn();

    for (const id of ['s1', 's2', 's3']) {
      const r = await deliverSteer({
        sessionId: session,
        clientId: TAB,
        content: `steer ${id}`,
        messageId: id,
        runtime,
      });
      expect(r.delivered).toBe(true);
    }
    // Close the turn: the three steers must not have added or removed a boundary.
    open();
    await settle();

    const types = getOrCreateProjector(session)
      .replayFrom(0)
      .map((e) => e.type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn_input')).toHaveLength(3);
  });

  it('emits NO turn_input when the runtime did not deliver the steer', async () => {
    await openHeldTurn();
    // A steer that reached no open window comes back undelivered — the degrade
    // ladder (task 4.4) queues it instead, so there is nothing to render inside
    // a turn and no carrier must be minted.
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'no-open-turn' });

    const result = await deliverSteer({
      sessionId: session,
      clientId: TAB,
      content: 'this one missed',
      messageId: 'steer-miss',
      runtime,
    });

    expect(result.delivered).toBe(false);
    const inputs = getOrCreateProjector(session)
      .replayFrom(0)
      .filter((e) => e.type === 'turn_input');
    expect(inputs).toHaveLength(0);
  });
});

describe('deliverStage — a stage is a write, and folds into the next when unsupported (task 4.2)', () => {
  it('lets the owner stage natively and emits the context_staged receipt (AC3)', async () => {
    // No turn is open — a stage needs none — so the lock is free and the owner
    // may write. The FakeAgentRuntime answers `{ delivered: true }` natively.
    runtime.isLocked.mockReturnValue(false);
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const result = await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'use the staging bucket',
      messageId: 'stage-1',
      runtime,
    });

    expect(result).toEqual({ authorized: true, delivered: true });
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      session,
      'use the staging bucket',
      expect.objectContaining({ mode: 'stage', messageId: 'stage-1' })
    );
    // AC3: the receipt lands on the durable stream as its OWN event, never a
    // turn_start — a staged message is not a user turn.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_staged',
        content: 'use the staging bucket',
        messageId: 'stage-1',
      })
    );
  });

  it('refuses a DIFFERENT client, and never reaches the runtime', async () => {
    // TAB owns the live turn; window-b could not send now, so it may not stage —
    // the SAME authorization a steer and a send pass.
    runtime.isLocked.mockImplementation((_sid, cid) => cid !== undefined && cid !== TAB);

    const result = await deliverStage({
      sessionId: session,
      clientId: 'window-b',
      content: 'let me in',
      messageId: 'stage-x',
      runtime,
    });

    expect(result).toEqual({ authorized: false, delivered: false });
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
  });

  it('proceeds on a FREE lock — a stage needs no open turn (unlike a steer)', async () => {
    // Nobody holds the lock. A steer here would report `no-open-turn`; a stage
    // does not need one, so it reaches the runtime and lands.
    runtime.isLocked.mockReturnValue(false);
    getOrCreateProjector(session);

    const result = await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'attach this',
      messageId: 'stage-2',
      runtime,
    });

    expect(result.authorized).toBe(true);
    expect(result.delivered).toBe(true);
    expect(runtime.deliverIntoTurn).toHaveBeenCalled();
  });

  it('folds into the NEXT dispatch when the runtime cannot stage, content pristine (AC4)', async () => {
    runtime.isLocked.mockReturnValue(false);
    // This runtime has no native staging — the fallback carries the note.
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const staged = await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'use the staging bucket',
      messageId: 'stage-1',
      runtime,
    });
    expect(staged).toEqual({ authorized: true, delivered: true, viaFallback: true });

    // The fallback emits the SAME context_staged receipt the native path does —
    // a silent hold is indistinguishable from a dropped message, and the person
    // cannot tell which path carried their note (AC3 holds on both paths).
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_staged',
        content: 'use the staging bucket',
        messageId: 'stage-1',
      })
    );

    // The NEXT dispatched message carries the staged text as a `staged_context`
    // entry in the neutral bag, and the person's own content for THAT message is
    // untouched (ADR-0273).
    runtime.withScenarios([quickTurn()]);
    await send('now do the thing');
    await settle();

    const call = runtime.sendMessage.mock.calls.find(
      ([, content]) => content === 'now do the thing'
    );
    expect(call).toBeDefined();
    const [, sentContent, opts] = call!;
    expect(sentContent).toBe('now do the thing');
    expect(opts?.additionalContext).toContainEqual({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'use the staging bucket' },
    });
  });

  it('folds two staged notes into the next dispatch, in order (AC5, fallback)', async () => {
    runtime.isLocked.mockReturnValue(false);
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    getOrCreateProjector(session);

    await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'first',
      messageId: 's1',
      runtime,
    });
    await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'second',
      messageId: 's2',
      runtime,
    });

    runtime.withScenarios([quickTurn()]);
    await send('go');
    await settle();

    const call = runtime.sendMessage.mock.calls.find(([, content]) => content === 'go');
    const stagedEntries = (call?.[2]?.additionalContext ?? []).filter(
      (e) => e.kind === 'staged_context'
    );
    expect(stagedEntries.map((e) => (e.kind === 'staged_context' ? e.data.text : ''))).toEqual([
      'first',
      'second',
    ]);
    // Only one dispatch consumed the hold — a later turn carries nothing.
    runtime.withScenarios([quickTurn()]);
    await send('again');
    await settle();
    const second = runtime.sendMessage.mock.calls.find(([, content]) => content === 'again');
    expect((second?.[2]?.additionalContext ?? []).some((e) => e.kind === 'staged_context')).toBe(
      false
    );
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

  it('files a message typed AFTER the rename with the ones typed before it', async () => {
    // One queue, one key. The rows move to the canonical id at the rename while
    // the dispatcher's own state deliberately stays filed under the id the
    // session was born with — so a store call made with the in-memory key after
    // the rename writes a SECOND queue nothing reads. The person types two
    // messages either side of a rename they cannot see and only one shows up.
    const first = gate();
    const canonical = `${session}-canonical`;
    extraProjectors.push(canonical);
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn()]);

    await send('long turn');
    await send('typed before the rename');
    await settle();
    rekeyProjector(session, canonical);
    await send('typed after the rename');

    expect(listQueuedMessages(session).map((m) => m.content)).toEqual([
      'typed before the rename',
      'typed after the rename',
    ]);
    expect(store.list(canonical)).toHaveLength(2);
    expect(store.list(session)).toEqual([]);
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

describe('a row recovered after a restart', () => {
  it('runs under a dispatch of its own, marked as queue recovery', async () => {
    // An adopted row has no accepting request behind it — the process that took
    // it is gone — so before DOR-1159 its turn ran under whatever context the
    // pump happened to be called from, or under none at all. A turn nobody can
    // name in the log is a turn nobody can reconstruct during an incident.
    resetDispatchBuffers();
    const seen: Array<DispatchContext | undefined> = [];
    runtime.withScenarios([
      async function* () {
        seen.push(currentDispatch());
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    // Written straight to the store, with no pending entry behind it: exactly
    // what a previous process leaves on disk.
    store.enqueue({ sessionId: session, content: 'survived the restart', clientId: TAB });

    const adopted = adoptQueuedMessages({
      sessionId: session,
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();

    expect(adopted).toBe(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const context = seen[0];
    expect(context?.origin).toBe('queue-recovery');
    expect(isDispatchId(context?.dispatchId ?? '')).toBe(true);
    // And it is a dispatch the debug buffer knows about, opened and closed.
    const row = recentDispatches(10).find((d) => d.dispatchId === context?.dispatchId);
    expect(row?.origin).toBe('queue-recovery');
    expect(row?.outcome).toBe('answered');
  });

  it('leaves alone a row whose turn is already on its way', async () => {
    // The window adoption must not step into: the message has left the pending
    // set and its turn is assembling context, so the row is on disk with
    // nothing visibly behind it — indistinguishable from a restart survivor
    // unless the launch itself is tracked. Adopting here sends the person's
    // words a second time and reports a recovery on a server that never
    // restarted, in the very buffer somebody reads during an incident.
    resetDispatchBuffers();
    const assembling = gate();
    vi.mocked(assembleAdditionalContext).mockImplementationOnce(async () => {
      await assembling.wait;
      return [];
    });
    runtime.withScenarios([quickTurn(), quickTurn()]);

    const sent = send('the one and only message');
    await settle();
    const adopted = adoptQueuedMessages({
      sessionId: session,
      projector: getOrCreateProjector(session),
      runtime,
    });
    assembling.open();
    await sent;
    await settle();

    expect(adopted).toBe(0);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(recentDispatches(10).filter((d) => d.origin === 'queue-recovery')).toEqual([]);
  });

  it('gives two recovered rows two different dispatch ids', async () => {
    resetDispatchBuffers();
    const seen: string[] = [];
    const held = gate();
    runtime.withScenarios([
      async function* () {
        seen.push(currentDispatchId() ?? 'none');
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await held.wait;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        seen.push(currentDispatchId() ?? 'none');
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    store.enqueue({ sessionId: session, content: 'first', clientId: TAB });
    store.enqueue({ sessionId: session, content: 'second', clientId: TAB });

    expect(
      adoptQueuedMessages({
        sessionId: session,
        projector: getOrCreateProjector(session),
        runtime,
      })
    ).toBe(2);
    await settle();
    held.open();
    await settle();

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every(isDispatchId)).toBe(true);
  });
});
