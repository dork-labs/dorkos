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
  dispatchMessage,
  dispatchCommandIntent,
  listQueuedMessages,
  noteSessionOrphaned,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../message-dispatcher.js';
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
