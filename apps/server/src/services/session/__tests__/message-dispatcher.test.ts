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
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
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
  noteTurnBoundary,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../message-dispatcher.js';
import {
  StagedContextStore,
  holdStagedContext,
  resetStagedContextStore,
  setStagedContextStore,
} from '../staged-context-store.js';
import { assembleAdditionalContext } from '../context-assembler.js';
import { logger } from '../../../lib/logger.js';
import type { DispatchContext } from '../../../lib/dispatch-context.js';
import { currentDispatch, currentDispatchId } from '../../../lib/dispatch-context.js';
import { recentDispatches, resetDispatchBuffers } from '../../observability/dispatch-buffers.js';
// The routes' mutation API, driven here because what it changes is what the
// dispatcher then RUNS — the edit and the turn are one promise, not two.
import {
  cancelQueuedMessage,
  clearQueuedMessages,
  editQueuedMessage,
} from '../queued-message-edits.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { ROOMS } from '../../../config/constants.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../session-state-projector.js';

const TAB = 'window-a';

let db: Db;
let store: MessageQueueStore;
let stagedStore: StagedContextStore;
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

/**
 * A turn that ENDS and then keeps its stream open, the way a runtime draining
 * background work does: `done` closes the turn, and the iterator returns later.
 */
function drainingTurn(hold: Promise<void>, marks?: { order: string[]; label: string }) {
  return async function* (): AsyncGenerator<StreamEvent> {
    marks?.order.push(`${marks.label}:start`);
    yield { type: 'text_delta', data: { text: 'here is a widget' } } as StreamEvent;
    yield { type: 'done', data: {} } as StreamEvent;
    await hold;
    marks?.order.push(`${marks.label}:stream-closed`);
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
  stagedStore = new StagedContextStore(db);
  setStagedContextStore(stagedStore);
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
  setStagedContextStore(undefined);
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

  it('takes a refusing caller once the turn has ENDED, though the stream is still closing', async () => {
    // DOR-1239. claude-code keeps its subprocess alive past `done` so a finished
    // background task can wake the agent again, and the write-lock and the
    // in-flight slot are both released on that late signal — so for the whole
    // drain the session LOOKS busy while the agent has stopped and its reply
    // (widget buttons and all) is on screen. A click there was refused over a
    // session nothing was using.
    const drain = gate();
    runtime.withScenarios([drainingTurn(drain.wait), quickTurn()]);

    await send('render a widget');
    // The turn has closed on the projector; the stream behind it has not.
    await vi.waitFor(() => expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull());
    expect(projectorStatus()).toBe('idle');

    const clicked = await send('a widget click', { whenBusy: 'refuse' });

    expect(clicked.accepted).toBe(true);
    // And it waits in nobody's composer. A refusing caller's trigger must never
    // become a queue row: this one's content is a machine-generated block, and a
    // row is editable, removable, and what the launch would send.
    expect(clicked.queuePosition).toBe(0);
    expect(listQueuedMessages(session)).toEqual([]);
    expect(store.list(session)).toEqual([]);

    // It runs when the slot clears. Ordering holds — one turn at a time — but
    // ADJACENCY to the clicked turn is not promised: a self-woken window
    // (DOR-1100) can open and close inside the same stream first.
    drain.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      session,
      'a widget click',
      expect.anything()
    );
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('drops a refusing caller’s trigger rather than forcing it into a stream still open', async () => {
    // Fast, or never. The wait bound normally FORCE-launches what it is holding,
    // deliberately skipping the in-flight slot — which here would put a second
    // `sendMessage` on a session whose first stream has not closed. And a
    // re-park would hand it a fresh full budget and start the cycle again. So an
    // expired transient plan is dropped, and says so.
    const drain = gate();
    runtime.withScenarios([drainingTurn(drain.wait), quickTurn()]);

    await send('render a widget');
    await vi.waitFor(() => expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull());

    const clicked = await send('a widget click', { whenBusy: 'refuse', queueWaitMs: 20 });
    expect(clicked.accepted).toBe(true);

    // Past the bound, with the stream still open.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // And gone: the slot clearing finds nothing waiting behind it.
    drain.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.list(session)).toEqual([]);
  });

  it('drops a refusing caller’s waiting trigger when the lock refuses it, rather than saving it for a later turn', async () => {
    // The mirror of the refuse-foreign case above, and deliberately the opposite
    // answer. A room's message is a person's words, so it goes back in line; a
    // machine-generated trigger has no later moment worth running at. Put back,
    // it would sit in the pending set with nothing to show for it — no row, so
    // nobody can see it or take it back — until some LATER turn's boundary
    // pumped it into work it has nothing to do with.
    //
    // Driven with no queue store, which is every embedded host: with one wired
    // the store's own rear-view drops the message anyway, so this is the
    // configuration where the rule itself is what decides.
    setMessageQueueStore(undefined);
    const drain = gate();
    runtime.withScenarios([drainingTurn(drain.wait), quickTurn(), quickTurn()]);

    await send('render a widget');
    await vi.waitFor(() => expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull());

    const clicked = await send('a widget click', { whenBusy: 'refuse' });
    expect(clicked.accepted).toBe(true);

    // A stranger takes the session in the beat between acceptance and launch.
    runtime.acquireLock.mockReturnValue(false);
    drain.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // The session frees up and somebody types. The click must not ride in on
    // that turn's boundary.
    runtime.acquireLock.mockReturnValue(true);
    await send('a later message');
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      'render a widget',
      'a later message',
    ]);
  });

  it('names the turn a refusal was refused for, so a 409 cannot invent a holder', async () => {
    // The 409 body used to be built from a second authority (the runtime lock,
    // asked under the request's id rather than the canonical one), which could
    // report `lockedBy: "unknown"` for a refusal the dispatcher had just made.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('long turn');
    const refused = await send('a widget click', {
      clientId: 'window-b',
      whenBusy: 'refuse',
    });

    expect(refused.accepted).toBe(false);
    expect(refused.refusedBy?.clientId).toBe(TAB);
    expect(refused.refusedBy?.since).toBeGreaterThan(0);
  });

  it('names the LOCK holder when the write-lock is what refused the launch', async () => {
    // The other refusal path, and the reason the dispatcher answers this rather
    // than the route: the lock is keyed by the canonical id, which the caller
    // does not necessarily hold.
    runtime.getInternalSessionId.mockReturnValue('canonical-id');
    runtime.acquireLock.mockReturnValue(false);
    runtime.getLockInfo.mockImplementation((id: string) =>
      id === 'canonical-id' ? { clientId: 'somebody-else', acquiredAt: 1_700_000_000_000 } : null
    );

    const refused = await send('a widget click', { whenBusy: 'refuse' });

    expect(refused.accepted).toBe(false);
    expect(refused.refusedBy).toEqual({
      clientId: 'somebody-else',
      since: 1_700_000_000_000,
    });
  });

  it("waits out the caller's OWN turn rather than refusing it (whenBusy: refuse-foreign)", async () => {
    // DOR-1230. A room holds a re-mention until its agent's turn here ends and
    // then dispatches it — so what it meets is its own tail: the turn ahead has
    // closed on the projector and hands its slot back a beat later. Refusing
    // that beat is what made the room post "didn't pick this up, send it again"
    // over a message it was about to answer. The trigger waits and then runs.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('the turn the room is already running');
    const held = await send('re-mentioned mid-turn', { whenBusy: 'refuse-foreign' });

    expect(held.accepted).toBe(true);
    expect(held.queued).toBe(true);
    first.open();
    await settle();
    // Both ran, and nothing is left waiting to run a third time.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(store.list(session)).toEqual([]);
  });

  it('keeps a refuse-foreign trigger that already waited, when the lock then refuses it', async () => {
    // The narrow race the wait above opens: a stranger takes the session in the
    // beat between the trigger being accepted and its launch. The refusal the
    // caller asked for is gone by then — it is holding an `accepted: true` — so
    // giving up would leave it waiting on a turn nothing will start. It goes
    // back in line, which is what the acceptance promised.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('the turn the room is already running');
    const held = await send('re-mentioned mid-turn', { whenBusy: 'refuse-foreign' });
    expect(held.accepted).toBe(true);

    runtime.acquireLock.mockReturnValue(false);
    first.open();
    await settle();

    // Refused at the launch, so no second turn — and it waits IN MEMORY. There
    // is no row, because a room's trigger is not a person's words and has no
    // business sitting in their composer (DOR-1242).
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.list(session)).toEqual([]);

    // Still armed, which is the half the missing row must not have cost: the
    // stranger lets go, the next boundary re-arms it, and it runs.
    runtime.acquireLock.mockReturnValue(true);
    noteTurnBoundary(session);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      session,
      're-mentioned mid-turn',
      expect.anything()
    );
  });

  it('drops a refuse-foreign trigger ONCE when the stranger outlasts its whole budget', async () => {
    // DOR-1242, the other end of the wait above. Every re-park used to arm a
    // FRESH budget while `startedWaitingAt` stayed put, so a holder that never
    // let go kept the cycle turning for the life of the process — a trigger
    // whose whole point was not to run late, retrying forever. What is re-parked
    // is now what is LEFT of the original wait, and when nothing is left the
    // plan is dropped once and reported.
    const settled: string[] = [];
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('the turn the room is already running');
    const held = await send('re-mentioned mid-turn', {
      whenBusy: 'refuse-foreign',
      queueWaitMs: 60,
      onSettled: (outcome: string) => settled.push(outcome),
    });
    expect(held.accepted).toBe(true);

    // A stranger takes the session and keeps it.
    runtime.acquireLock.mockReturnValue(false);
    first.open();

    // The budget runs out while the holder is still there. One `failed`, not a
    // stream of them: this is the assertion that the retry stopped.
    await vi.waitFor(() => expect(settled).toEqual(['failed']), { timeout: 2_000 });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.list(session)).toEqual([]);

    // And it is GONE, not merely quiet. Were it still parked, the freed lock and
    // these boundaries would start its turn — which is exactly what the
    // unbounded requeue did, days later, into a conversation that had ended.
    runtime.acquireLock.mockReturnValue(true);
    noteTurnBoundary(session);
    await settle();
    noteTurnBoundary(session);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(settled).toEqual(['failed']);
  });

  it('writes no queue row for a refusing trigger, so a restart cannot adopt one', async () => {
    // The restart half of DOR-1242. A row outlives the process, and
    // `adoptQueuedMessages` re-arms whatever it finds as an ordinary
    // `whenBusy: 'queue'` plan — so a room prompt from a conversation that ended
    // days ago would fire into that session with nobody listening, and show in
    // the composer queue on the way. The fix is upstream of adoption: a refusing
    // caller never gets a row to leave behind.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    // One that RUNS: nothing in the composer while its turn is live either.
    const ran = await send('a room turn', { whenBusy: 'refuse' });
    expect(store.list(session)).toEqual([]);
    expect(listQueuedMessages(session)).toEqual([]);
    // On no queue at all, so there is no position to report (DOR-1242).
    expect(ran.queuePosition).toBe(0);

    // ...and one that WAITS, which is the plan that used to survive a restart.
    const held = await send('re-mentioned mid-turn', { whenBusy: 'refuse-foreign' });
    expect(held.accepted).toBe(true);
    expect(held.queued).toBe(true);
    expect(store.list(session)).toEqual([]);

    // The restart: in-memory state dies, the store is all that carries over.
    resetMessageDispatcher();
    expect(
      adoptQueuedMessages({ sessionId: session, projector: getOrCreateProjector(session), runtime })
    ).toBe(0);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    first.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sweeps a room row an earlier build persisted, rather than adopting it', async () => {
    // The population this fix is FOR (DOR-1242). A refusing caller gets no row
    // now, but builds before this wrote one, and adoption re-arms whatever it
    // finds as an ordinary `whenBusy: 'queue'` plan — so a room prompt from a
    // conversation that ended days ago would fire into this session with nobody
    // listening. Nothing is left that wants it, so it is removed.
    const stale = store.enqueue({
      sessionId: session,
      content: '@ada what did we decide about the importer?',
      clientId: ROOMS.CLIENT_ID,
    });
    // A person's own queued words, side by side, to prove the sweep is targeted
    // rather than a blanket clear of everything a restart found.
    const mine = store.enqueue({
      sessionId: session,
      content: 'my own words, still waiting',
      clientId: TAB,
    });

    // One adopted, not two: the room's row is gone from disk before anything is
    // armed around it, while the person's is still there waiting to run.
    expect(
      adoptQueuedMessages({ sessionId: session, projector: getOrCreateProjector(session), runtime })
    ).toBe(1);
    expect(store.get(stale.id)).toBeUndefined();
    expect(store.get(mine.id)).toBeDefined();

    await settle();

    // ...and what actually reached the model is the person's words, once. The
    // room's prompt was never sent, which is the whole point.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      session,
      'my own words, still waiting',
      expect.anything()
    );
  });

  it('reports a dropped refuse-foreign trigger to the caller that registered for it', async () => {
    // The BLOCKER the review caught: `returnToQueue` documents the drop as
    // "terminal and REPORTED", and rooms are the only refuse-foreign caller, so
    // if `onSettled` never reaches a registered callback the room waits on a turn
    // nothing will start — a late notice at its wait bound and "something went
    // wrong" at its ceiling, an hour later. This pins the dispatcher half: the
    // callback the caller passed is the one that fires.
    const settled: string[] = [];
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('the turn the room is already running');
    await send('re-mentioned mid-turn', {
      whenBusy: 'refuse-foreign',
      queueWaitMs: 60,
      onSettled: (outcome: string) => settled.push(outcome),
    });

    runtime.acquireLock.mockReturnValue(false);
    first.open();

    await vi.waitFor(() => expect(settled).toEqual(['failed']), { timeout: 2_000 });
  });

  it('still refuses a turn another client opened (whenBusy: refuse-foreign)', async () => {
    // The other half, and the one the busy notice was written for: somebody
    // typing into the very agent a room addressed. Nothing the room does will
    // finish that turn, so the trigger is dropped with its row exactly as a
    // blanket refusal drops it.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('somebody typing in the cockpit', { clientId: 'window-b' });
    const refused = await send('a room turn', { whenBusy: 'refuse-foreign' });

    expect(refused.accepted).toBe(false);
    expect(refused.queued).toBe(false);
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

describe('clearing the queue on Stop', () => {
  it('empties the queue, hands every message back in order, and tells every window', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn(), quickTurn()]);

    await send('long turn');
    await send('one');
    await send('two');
    await send('three');
    expect(listQueuedMessages(session).map((r) => r.content)).toEqual(['one', 'two', 'three']);

    const ingest = vi.spyOn(getOrCreateProjector(session), 'ingest');
    const returned = clearQueuedMessages(session);

    expect(returned.map((r) => r.content)).toEqual(['one', 'two', 'three']);
    expect(listQueuedMessages(session)).toEqual([]);
    // Every window learns the queue is empty on the durable stream.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'queue_update', queue: [] })
    );
  });

  it('disarms the pending dispatches so nothing runs when the turn ends', async () => {
    // The discriminating half: a store-only clear would leave the pending
    // entries armed, and the head would fire the moment the running turn ended.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn()]);

    await send('long turn');
    await send('one');
    await send('two');

    clearQueuedMessages(session);

    first.open();
    await settle();

    // Only the long turn ran; the two cleared messages never reached the model.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('is a no-op on an empty queue and emits no queue_update', async () => {
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const returned = clearQueuedMessages(session);

    expect(returned).toEqual([]);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('a Stop during a booting first turn clears the un-retired row so it does not re-run (DOR-1192)', async () => {
    // A first turn that booted but never reached the model leaves its row on the
    // queue: the row retires only on `turn_start`, which a boot stopped before
    // it opens never emits. A row in exactly that state is what a boot-Stop
    // leaves behind. Without the Stop clearing it, `adoptQueuedMessages` picks
    // it up on the very next dispatch and re-runs the stopped message.
    store.enqueue({ sessionId: session, content: 'the stopped first message', clientId: TAB });
    expect(listQueuedMessages(session).map((r) => r.content)).toEqual([
      'the stopped first message',
    ]);

    // Stop clears the queue — the same call the interrupt route makes.
    clearQueuedMessages(session);
    expect(listQueuedMessages(session)).toEqual([]);

    // The next dispatch's adoption must find nothing to resurrect.
    runtime.withScenarios([quickTurn()]);
    await send('a fresh message');
    await settle();

    const ran = runtime.sendMessage.mock.calls.map((c) => c[1]);
    expect(ran).not.toContain('the stopped first message');
    expect(ran).toContain('a fresh message');
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

describe('dispatchMessage — the degradation ladder (task 4.4)', () => {
  /** Re-declare the runtime's capabilities for one case. */
  function withCapabilities(overrides: Partial<RuntimeCapabilities>): void {
    runtime.getCapabilities.mockReturnValue({ ...runtime.getCapabilities(), ...overrides });
  }

  /** A scenario that parks a turn on an approval, then ends when `release`s. */
  function approvalTurn(release: Promise<void>) {
    return async function* (): AsyncGenerator<StreamEvent> {
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
      await release;
      yield { type: 'done', data: {} } as StreamEvent;
    };
  }

  it('steers natively when the runtime supports it and a turn is open (AC1)', async () => {
    withCapabilities({ supportsSteer: true });
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait)]);
    await send('long turn');
    await settle();
    expect(projectorStatus()).toBe('streaming');
    const turnsBefore = runtime.sendMessage.mock.calls.length;

    const result = await send('course-correct', { disposition: 'steer' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'steer',
      applied: 'steer',
    });
    expect(result.outcome.degradedBecause).toBeUndefined();
    expect(result.queued).toBe(false);
    // A steer JOINS the open turn — the runtime is asked to deliver into it, and
    // no second turn is ever started.
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      session,
      'course-correct',
      expect.objectContaining({ mode: 'steer' })
    );
    expect(runtime.sendMessage.mock.calls.length).toBe(turnsBefore);
    // It is not a queue row: it delivered, it did not wait.
    expect(listQueuedMessages(session)).toHaveLength(0);

    first.open();
    await settle();
  });

  it('queues a steer the runtime cannot take, and says why (AC2)', async () => {
    // Capabilities stay at the default (supportsSteer: false) — Codex/OpenCode.
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);
    await send('long turn');
    await settle();

    const result = await send('course-correct', { disposition: 'steer' });
    await settle();

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });
    expect(result.queued).toBe(true);
    // The flag is the routing authority: a runtime that cannot steer is never
    // asked to, so no native attempt is made behind a false declaration.
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
    expect(listQueuedMessages(session)).toHaveLength(1);

    first.open();
    await settle();
  });

  it('runs a steer on an idle session immediately, and stays quiet about it (AC3)', async () => {
    withCapabilities({ supportsSteer: true });
    // No turn is open, so the runtime reports there is nothing to join.
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'no-open-turn' });
    runtime.withScenarios([quickTurn()]);

    const result = await send('course-correct', { disposition: 'steer' });
    await settle();

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'session-idle',
    });
    // `session-idle` is the ONE downgrade the composer renders nothing for
    // (task 4.6): the message ran now, which lost nothing. The server records it
    // regardless, which is what this asserts.
    expect(result.queued).toBe(false);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('says a running turn could not be joined, rather than the silent session-idle (DOR-1268)', async () => {
    // The reported failure: claude-code declares `supportsSteer` for the
    // adapter, but a session on the resume path holds no process to push into.
    // The runtime answers `no-open-turn` for a turn that is plainly running, and
    // reporting that as `session-idle` — the one downgrade the composer stays
    // quiet about — told the person their cut-in landed when it did not.
    withCapabilities({ supportsSteer: true });
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);
    await send('long turn');
    await settle();
    expect(projectorStatus()).toBe('streaming');
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'no-open-turn' });

    const result = await send('course-correct', { disposition: 'steer' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'not-steerable',
    });
    // It really did go to the back of the line, which is why staying quiet was
    // a lie: nothing ran early.
    expect(result.queued).toBe(true);
    expect(listQueuedMessages(session)).toHaveLength(1);

    first.open();
    await settle();
  });

  it('still says session-idle when the turn ended between the click and the POST', async () => {
    // The other half of the same fork. `session-idle` keeps its meaning exactly
    // — the turn is over, the message runs now, nothing was lost — and the
    // session's own projection is what tells the two apart.
    withCapabilities({ supportsSteer: true });
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);
    await send('long turn');
    await settle();
    first.open();
    await settle();
    expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull();
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'no-open-turn' });

    const result = await send('course-correct', { disposition: 'steer' });
    await settle();

    expect(result.outcome.degradedBecause).toBe('session-idle');
    expect(result.queued).toBe(false);
  });

  it('publishes whether the session can be steered, once, before the ladder runs', async () => {
    // The composer offers Steer on this value (DOR-1268), so it has to be on the
    // session's own status before any turn a person could steer is open. The
    // fake implements no `canSteerSession`, so the runtime's static flag stands
    // — which is exactly the fallback a uniform runtime relies on.
    withCapabilities({ supportsSteer: false });
    runtime.withScenarios([quickTurn(), quickTurn()]);

    await send('first');
    await settle();
    const projector = getOrCreateProjector(session);
    expect(projector.getStatus().steerable).toBe(false);

    // BEFORE the turn — the ordering the whole design rests on. A window watching
    // this session learns it cannot cut in while the turn it would have steered
    // is still opening, not after. An announcement made later would reach the
    // composer only once the Steer row had already been offered.
    expect(projector.replayFrom(0)[0]).toMatchObject({
      type: 'status_change',
      status: { steerable: false },
    });

    // A second message re-asks and finds the same answer, so it announces
    // nothing: one event per session, not one per message.
    await send('second');
    await settle();
    const announcements = projector
      .replayFrom(0)
      .filter((e) => e.type === 'status_change' && e.status.steerable !== undefined);
    expect(announcements).toHaveLength(1);
  });

  it("re-publishes steerability when the runtime's per-session answer changes", async () => {
    // Turning the persistent-session setting on must reach an open window at the
    // session's next message rather than only at its next reload.
    withCapabilities({ supportsSteer: true });
    const canSteerSession = vi.fn(() => false);
    Object.assign(runtime, { canSteerSession });
    runtime.withScenarios([quickTurn(), quickTurn()]);

    await send('first');
    await settle();
    const projector = getOrCreateProjector(session);
    // The per-SESSION answer wins over the runtime's static `true`.
    expect(projector.getStatus().steerable).toBe(false);

    canSteerSession.mockReturnValue(true);
    await send('second');
    await settle();
    expect(projector.getStatus().steerable).toBe(true);
    // No teardown for the stub: the suite's `beforeEach` builds a fresh
    // `FakeAgentRuntime` for every case, so it cannot outlive this one. A
    // trailing `delete` here would look like cleanup while being skipped by any
    // assertion above it that failed.
  });

  it('queues a steer behind an open interaction and never fires it into the ask (AC4)', async () => {
    withCapabilities({ supportsSteer: true });
    const first = gate();
    runtime.withScenarios([approvalTurn(first.wait), quickTurn()]);

    await send('run something dangerous');
    await settle();
    const projector = getOrCreateProjector(session);
    expect(projector.hasPendingInteractions()).toBe(true);

    const result = await send('actually, stop that', { disposition: 'steer' });
    await settle();

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'pending-interaction',
    });
    expect(result.queued).toBe(true);
    // The steer was NEVER delivered into the running turn — firing it into the
    // open ask is the exact failure the gate exists for.
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();

    // The turn ENDS with the approval still unanswered: the queue must not move.
    first.open();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // Answered — now, and only now, the steered message runs.
    projector.resolveInteraction('call-1', 'approved');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('folds a stage the runtime cannot take into the next dispatch, and says so (AC5)', async () => {
    // Capabilities stay at the default (supportsContextStaging: false).
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const result = await send('use the staging bucket', { disposition: 'stage' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
      degradedBecause: 'unsupported',
    });
    expect(result.queued).toBe(false);
    // Folded WITHOUT a native attempt behind the false flag.
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
    // The fold emits the SAME context_staged receipt the native path does — a
    // silent hold is indistinguishable from a dropped message.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'context_staged', content: 'use the staging bucket' })
    );

    // The NEXT dispatch carries the staged text as a `staged_context` entry.
    runtime.withScenarios([quickTurn()]);
    await send('now do the thing');
    await settle();
    const call = runtime.sendMessage.mock.calls.find(
      ([, content]) => content === 'now do the thing'
    );
    expect(call?.[2]?.additionalContext).toContainEqual({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'use the staging bucket' },
    });
  });

  it('stages natively when the runtime supports it, no downgrade', async () => {
    withCapabilities({ supportsContextStaging: true });
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: true });
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const result = await send('attach this', { disposition: 'stage' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
    });
    expect(result.outcome.degradedBecause).toBeUndefined();
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      session,
      'attach this',
      expect.objectContaining({ mode: 'stage' })
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'context_staged', content: 'attach this' })
    );
  });

  it('folds a declared-but-undeliverable stage exactly once (no double-fold)', async () => {
    // The adapter-bug path: the runtime DECLARES staging but its deliverIntoTurn
    // comes back `unsupported`. deliverStage folds internally and reports
    // folded already; the ladder must NOT fold a second time.
    withCapabilities({ supportsContextStaging: true });
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');

    const result = await send('stage me', { disposition: 'stage' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
      degradedBecause: 'unsupported',
    });
    // Exactly ONE receipt — a double-fold would emit two.
    const receipts = ingest.mock.calls.filter(
      ([event]) => (event as { type?: string }).type === 'context_staged'
    );
    expect(receipts).toHaveLength(1);

    // And the next dispatch carries the staged text exactly ONCE, not twice.
    runtime.withScenarios([quickTurn()]);
    await send('go');
    await settle();
    const call = runtime.sendMessage.mock.calls.find(([, content]) => content === 'go');
    const staged = (call?.[2]?.additionalContext ?? []).filter((e) => e.kind === 'staged_context');
    expect(staged).toHaveLength(1);
    expect(staged[0]).toEqual({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'stage me' },
    });
  });

  // DOR-1307. `supportsContextStaging` is a claim about the ADAPTER, and reading
  // it as a claim about the session sent every stage down the native path. For
  // claude-code the native path is a held process, so the adapter's only way to
  // honour the ask was to START one — on a default install, with the setting off,
  // behind the operator's back. The session now answers for itself, exactly as it
  // does for a steer (DOR-1268), and a `false` routes to the fold instead.
  const ADAPTER_BUG_LOG = '[MessageDispatcher] runtime declares context staging but had to fold';

  it('folds a stage this session cannot take natively, and never calls that an adapter bug (DOR-1307)', async () => {
    withCapabilities({ supportsContextStaging: true });
    Object.assign(runtime, { canStageSession: vi.fn(() => false) });
    // Armed so that REMOVING the gate takes the adapter-bug path rather than
    // crashing on an unstubbed receipt: the mutation must fail these assertions
    // for the reason they are about, not by accident.
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    const projector = getOrCreateProjector(session);
    const ingest = vi.spyOn(projector, 'ingest');
    const logged = vi.spyOn(logger, 'error');

    const result = await send('use the staging bucket', { disposition: 'stage' });

    // `not-stageable`, never `unsupported`: the runtime DOES declare staging, and
    // a receipt saying otherwise would contradict its own capabilities on every
    // default install.
    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
      degradedBecause: 'not-stageable',
    });
    expect(result.queued).toBe(false);
    // Never asked natively. Asking is what booted the process.
    expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
    // A fold the design intends is not a defect, and logging it as one buries the
    // real adapter bugs under noise from every install.
    expect(logged).not.toHaveBeenCalledWith(ADAPTER_BUG_LOG, expect.anything());
    // The person still gets the one proof their words landed.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'context_staged', content: 'use the staging bucket' })
    );

    // And the words ride the NEXT turn, which is the promise the fold makes.
    runtime.withScenarios([quickTurn()]);
    await send('now do the thing');
    await settle();
    const call = runtime.sendMessage.mock.calls.find(
      ([, content]) => content === 'now do the thing'
    );
    expect(call?.[2]?.additionalContext).toContainEqual({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'use the staging bucket' },
    });
  });

  // DOR-1324. The receipt above is written to the DURABLE stream, so what it
  // points at has to be durable too — otherwise a restart in the gap leaves a
  // permanent "Added context for the next reply" over words nobody will ever get.
  it('still carries the folded words after a restart (DOR-1324)', async () => {
    withCapabilities({ supportsContextStaging: true });
    Object.assign(runtime, { canStageSession: vi.fn(() => false) });

    await send('remember the deploy key is rotated', { disposition: 'stage' });

    // The restart: process memory goes, and a new store opens over the same
    // database. Nothing else about the session is re-created, because nothing
    // else about it was ever in memory to begin with.
    resetStagedContextStore();
    setStagedContextStore(new StagedContextStore(db));

    runtime.withScenarios([quickTurn()]);
    await send('now ship it');
    await settle();
    const call = runtime.sendMessage.mock.calls.find(([, content]) => content === 'now ship it');
    expect(call?.[2]?.additionalContext).toContainEqual({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'remember the deploy key is rotated' },
    });
  });

  // DOR-1325. `canStageSession` is read BEFORE `deliverStage` takes the dispatch
  // mutex, and the idle reaper does not take that mutex at all — so a reap can
  // land in between and turn a yes into a no. The fold that follows is the one
  // the design intends; calling it an adapter bug both lies in the log and buries
  // the real bugs under noise from every install that ever reaps a process.
  it('does not call a reap between the gate and the delivery an adapter bug (DOR-1325)', async () => {
    withCapabilities({ supportsContextStaging: true });
    // Yes to the router's gate, no by the time the mutex is held: exactly what
    // an idle reap does to a warm process in that window.
    const canStage = vi.fn(() => canStage.mock.calls.length === 1);
    Object.assign(runtime, { canStageSession: canStage });
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    const logged = vi.spyOn(logger, 'error');

    const result = await send('the reaper got here first', { disposition: 'stage' });

    expect(logged).not.toHaveBeenCalledWith(ADAPTER_BUG_LOG, expect.anything());
    // And the receipt says what actually happened: the seam went away, which is
    // `not-stageable` — never `unsupported`, which would contradict a capability
    // the runtime openly declares.
    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
      degradedBecause: 'not-stageable',
    });
    // The words are held exactly once, and ride the next turn.
    runtime.withScenarios([quickTurn()]);
    await send('carry on');
    await settle();
    const call = runtime.sendMessage.mock.calls.find(([, content]) => content === 'carry on');
    const staged = (call?.[2]?.additionalContext ?? []).filter((e) => e.kind === 'staged_context');
    expect(staged).toEqual([
      { kind: 'staged_context', scope: 'per-turn', data: { text: 'the reaper got here first' } },
    ]);
  });

  it('takes the native path when the session says it can stage', async () => {
    // The other side of the same gate: turning the opt-in on must not cost the
    // native path, or the fix would have been a removal.
    withCapabilities({ supportsContextStaging: true });
    Object.assign(runtime, { canStageSession: vi.fn(() => true) });
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: true });

    const result = await send('attach this', { disposition: 'stage' });

    expect(result.outcome).toEqual({
      messageId: expect.any(String),
      requested: 'stage',
      applied: 'stage',
    });
    expect(result.outcome.degradedBecause).toBeUndefined();
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      session,
      'attach this',
      expect.objectContaining({ mode: 'stage' })
    );
  });

  it('still calls a declared-and-stageable-but-undeliverable stage an adapter bug', async () => {
    // The two folds must stay distinguishable in the logs. This one IS a defect:
    // the runtime said yes twice and then could not deliver.
    withCapabilities({ supportsContextStaging: true });
    Object.assign(runtime, { canStageSession: vi.fn(() => true) });
    runtime.deliverIntoTurn.mockResolvedValue({ delivered: false, reason: 'unsupported' });
    const logged = vi.spyOn(logger, 'error');

    const result = await send('stage me', { disposition: 'stage' });

    expect(result.outcome.degradedBecause).toBe('unsupported');
    expect(logged).toHaveBeenCalledWith(ADAPTER_BUG_LOG, expect.anything());
  });

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
    // sits after the assistant text it followed. (`queue_update` and
    // `status_change` bookkeeping from the send also ride the stream; neither is
    // part of the turn's transcript.)
    const turnContent = projector
      .replayFrom(0)
      .filter((e) => e.type !== 'queue_update' && e.type !== 'status_change')
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

  it('emits that receipt for a session that has GAINED its canonical id (DOR-1262 review)', async () => {
    // The receipt is ingested into the projector, which after the mid-first-turn
    // rename is registered under the CANONICAL id — while the dispatcher's own
    // state deliberately stays filed under the id the session was born with.
    // Resolved through the filing id, the lookup missed for every renamed
    // session and the early return read as "nobody is listening": a person
    // staged a message and the one proof it landed never went out.
    runtime.isLocked.mockReturnValue(false);
    const canonical = `${session}-canonical`;
    extraProjectors.push(canonical);
    getOrCreateProjector(session).ingest({ type: 'turn_start' });
    rekeyProjector(session, canonical);

    const result = await deliverStage({
      sessionId: session,
      clientId: TAB,
      content: 'read the deploy notes first',
      messageId: 'stage-rekeyed',
      runtime,
    });

    expect(result).toEqual({ authorized: true, delivered: true });
    // Read by the id the projector is REALLY keyed by, so this asserts the
    // receipt arrived rather than that some lookup happened to resolve.
    const receipts = getOrCreateProjector(canonical)
      .replayFrom(0)
      .filter((e) => e.type === 'context_staged');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      content: 'read the deploy notes first',
      messageId: 'stage-rekeyed',
    });
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
    // `unsupported` and not `not-stageable`: this runtime never claimed a
    // per-session seam, so nothing about it went away mid-flight (DOR-1325).
    expect(staged).toEqual({
      authorized: true,
      delivered: true,
      foldedBecause: 'unsupported',
    });

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

  // DOR-1324. The rows move onto the canonical id with the queue's, so the sweep
  // has to look for them THERE. Reading by the filing id deletes nothing and the
  // words of every renamed session sit in the table for the life of the install.
  it('deletes the staged hold of a RENAMED session that has gone', () => {
    const canonical = `${session}-canonical`;
    getOrCreateProjector(session);
    holdStagedContext(session, 'notes for a session that is about to vanish', 'stage-1');

    rekeyProjector(session, canonical);
    // The hold followed the rename — the precondition the sweep depends on.
    expect(stagedStore.take(canonical)).toHaveLength(1);
    holdStagedContext(session, 'and another', 'stage-2');

    disposeProjector(canonical);
    noteSessionOrphaned(session);
    sweepOrphanedMessageQueues();

    expect(stagedStore.take(canonical)).toEqual([]);
    expect(stagedStore.take(session)).toEqual([]);
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

// The wiring, not the mechanism (DOR-1295). `triggerTurn` and
// `triggerCommandIntent` settle any turn the runtime has left open BEFORE they
// open one of their own, and they reach the runtime through the narrow port the
// dispatcher builds. That port is two spreads in `turnDeps` and its command-intent
// twin, and deleting both left the whole suite green — a fix that exists and is
// not plugged in. These are what notice.
describe('the dispatcher asks the runtime to settle an open turn first (DOR-1295)', () => {
  /** Record the order the runtime's methods were reached in. */
  function recordOrder(): string[] {
    const order: string[] = [];
    runtime.settleOpenTurn.mockImplementation(async (id: string) => {
      order.push(`settle:${id}`);
      return false;
    });
    return order;
  }

  it('asks before sending a turn, and asks about this session', async () => {
    const order = recordOrder();
    runtime.sendMessage.mockImplementation(async function* (id: string) {
      order.push(`send:${id}`);
      yield { type: 'done', data: {} } as StreamEvent;
    });

    await send('hello');
    await settle();

    // ORDER, not merely presence: settling AFTER the send is exactly the bug —
    // the turn is already open by then and inherits the terminal.
    expect(order).toEqual([`settle:${session}`, `send:${session}`]);
  });

  it('asks before running a command intent, and asks about this session', async () => {
    const order = recordOrder();
    runtime.executeCommandIntent.mockImplementation(async function* (id: string) {
      order.push(`intent:${id}`);
      yield { type: 'done', data: {} } as StreamEvent;
    });

    await dispatchCommandIntent({
      sessionId: session,
      clientId: TAB,
      intent: 'compact',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();

    expect(order).toEqual([`settle:${session}`, `intent:${session}`]);
  });

  it('starts the turn anyway when the runtime throws trying to settle', async () => {
    // A repair may not be the thing that fails the next message — the interface
    // says so, conformance C8 holds the shipped runtimes to it, and this holds
    // the COMPOSER to it for a future adapter that reads neither.
    runtime.settleOpenTurn.mockRejectedValue(new Error('the adapter fell over'));
    runtime.withScenarios([quickTurn()]);

    const result = await send('hello');
    await settle();

    expect(result.accepted).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
