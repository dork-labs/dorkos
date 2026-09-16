/**
 * The queue and turns the AGENT started, driven through the real dispatcher
 * (spec `warm-process-lifecycle` D6, T10/T31/T38).
 *
 * What these pin is the incident itself. A warm process finishes a reply, a
 * background helper settles, and the report of it arrives as a segment of its
 * own. The session looks idle in that gap — the turn has ended and nothing
 * holds the in-flight slot — so a message the person types lands in the middle
 * of the helper's turn, and the two get jumbled into one reply.
 *
 * The real `dispatchMessage`, the real queue store on real SQLite and the real
 * `pumpLocked` are all under test; only the runtime is a double, because what
 * is being asserted is the ORDER the server puts turns in, not what a model
 * says inside one.
 *
 * @module services/session/__tests__/message-dispatcher-runtime-turns
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { Db } from '@dorkos/db';

// The neutral context bag is assembled off the real filesystem (git status);
// these cases care about dispatch order, not context, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  listQueuedMessages,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import { subscribeRuntimeTurns } from '../runtime-turns/runtime-turn.js';

const TAB = 'client-A';

let db: Db;
let store: MessageQueueStore;
let runtime: FakeAgentRuntime;
let session: string;
let sessionCounter = 0;
let unsubscribe: (() => void) | undefined;

/** A stream of events a test pushes by hand, with an explicit end. */
function pushable(): {
  push: (event: StreamEvent) => void;
  end: () => void;
  stream: AsyncIterable<StreamEvent>;
} {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* drain(): AsyncGenerator<StreamEvent> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    push: (event) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    end: () => {
      ended = true;
      wake?.();
      wake = undefined;
    },
    stream: drain(),
  };
}

/** A turn that ends immediately. */
function quickTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'answering' } } as StreamEvent;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** Dispatch with the fields these cases do not care about filled in. */
function send(content: string) {
  return dispatchMessage({
    sessionId: session,
    clientId: TAB,
    content,
    projector: getOrCreateProjector(session),
    runtime,
  });
}

/** Let queued microtasks and the pump's deferral drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** The durable stream's turn boundaries, in order. */
function turnStarts(): SessionEvent[] {
  return getOrCreateProjector(session)
    .replayFrom(0)
    .filter((event) => event.type === 'turn_start');
}

beforeEach(() => {
  sessionCounter += 1;
  session = `00000000-0000-4000-9000-${String(sessionCounter).padStart(12, '0')}`;
  db = createTestDb();
  store = new MessageQueueStore(db);
  setMessageQueueStore(store);
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  unsubscribe = subscribeRuntimeTurns(runtime);
});

afterEach(async () => {
  await settle();
  unsubscribe?.();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  vi.restoreAllMocks();
});

describe('a helper report and a person’s message never share a turn (T31)', () => {
  it('holds the message, runs the agent’s turn, then the person’s', async () => {
    runtime.withScenarios([quickTurn(), quickTurn()]);

    // One ordinary turn, which ends. The session is now idle as far as every
    // existing gate is concerned.
    await send('do the thing');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // A background helper settles: a report is owed, and its segment has not
    // opened yet. This is the gap the incident happened in.
    runtime.isSegmentPending.mockReturnValue(true);

    const queued = send('what did you find?');
    await settle();

    // Accepted and DURABLE, but not sent: launching now is what put a person's
    // words in the same turn as a helper's report.
    expect((await queued).queued).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.list(session).map((row) => row.content)).toEqual(['what did you find?']);

    // The report arrives, as a turn that is truthfully the agent's own.
    const report = pushable();
    runtime.emitRuntimeTurn(session, report.stream);
    await settle();
    report.push({ type: 'text_delta', data: { text: 'the helper finished' } } as StreamEvent);
    report.push({ type: 'done', data: { sessionId: session } } as StreamEvent);
    report.end();
    runtime.isSegmentPending.mockReturnValue(false);
    await settle();

    // Only now does the person's message run — behind it, in its own turn.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(listQueuedMessages(session)).toEqual([]);

    // The order on the durable stream is the whole point: the agent's turn
    // first, the person's second, and nothing dropped from either.
    const starts = turnStarts();
    expect(starts).toHaveLength(3);
    expect((starts[1] as { origin?: string }).origin).toBe('runtime');
    expect((starts[2] as { origin?: string }).origin).toBeUndefined();
    const stream = JSON.stringify(getOrCreateProjector(session).replayFrom(0));
    expect(stream).toContain('the helper finished');
    expect(stream).toContain('what did you find?');
  });

  it('keeps the helper’s words out of the person’s turn entirely (T11)', async () => {
    runtime.withScenarios([quickTurn(), quickTurn()]);

    await send('do the thing');
    await settle();
    runtime.isSegmentPending.mockReturnValue(true);
    void send('what did you find?');
    await settle();

    const report = pushable();
    runtime.emitRuntimeTurn(session, report.stream);
    await settle();
    report.push({ type: 'text_delta', data: { text: 'the helper finished' } } as StreamEvent);
    report.push({ type: 'done', data: { sessionId: session } } as StreamEvent);
    report.end();
    runtime.isSegmentPending.mockReturnValue(false);
    await settle();

    // Cut the durable stream at its turn boundaries and read each turn on its
    // own. A segment that began after a dispatched `result` belongs to the
    // agent, and none of it may appear inside a turn a person opened — that
    // attribution is the whole reason the runtime turn exists.
    const events = getOrCreateProjector(session).replayFrom(0);
    const turns: SessionEvent[][] = [];
    for (const event of events) {
      if (event.type === 'turn_start') turns.push([]);
      turns[turns.length - 1]?.push(event);
    }
    expect(turns).toHaveLength(3);
    for (const [index, events_] of turns.entries()) {
      const text = JSON.stringify(events_);
      const isAgentTurn = (events_[0] as { origin?: string }).origin === 'runtime';
      expect(isAgentTurn, `turn ${index} origin`).toBe(index === 1);
      expect(text.includes('the helper finished'), `turn ${index} carries the report`).toBe(
        isAgentTurn
      );
    }
  });
});

describe('a message waits out a turn the agent started (T10)', () => {
  it('sends nothing to the runtime until that turn closes', async () => {
    runtime.withScenarios([quickTurn()]);

    // The agent starts talking with nothing dispatched.
    const report = pushable();
    runtime.emitRuntimeTurn(session, report.stream);
    await settle();
    report.push({ type: 'text_delta', data: { text: 'picking my work back up' } } as StreamEvent);
    await settle();

    const queued = send('hello?');
    await settle();

    // Not a single write while the agent's own turn is open.
    expect((await queued).queued).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    report.push({ type: 'done', data: { sessionId: session } } as StreamEvent);
    report.end();
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('a turn that fails to project still hands the session back', () => {
  it('releases the claim when building the projection throws', async () => {
    runtime.withScenarios([quickTurn()]);

    // The subscriber claims the session synchronously, BEFORE the projection is
    // built. A throw while building it used to skip the release entirely, so the
    // slot was held for the life of the process and every later message on this
    // session was accepted, made durable, and never sent — with the throw
    // swallowed by the server's global handler, so nothing named the session.
    const healthy = runtime.getCapabilities.getMockImplementation();
    runtime.getCapabilities.mockImplementation(() => {
      throw new Error('the projection could not be built');
    });
    const report = pushable();
    runtime.emitRuntimeTurn(session, report.stream);
    await settle();
    if (healthy) runtime.getCapabilities.mockImplementation(healthy);

    const queued = send('is anyone there?');
    await settle();

    expect((await queued).accepted).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(listQueuedMessages(session)).toEqual([]);
  });
});

describe('a report that never arrives cannot wedge the queue (T38)', () => {
  it('runs the held message when the runtime says the hold has dropped', async () => {
    runtime.withScenarios([quickTurn(), quickTurn()]);

    await send('do the thing');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // Owed, with no segment ever following — the shape the owed-delivery clock
    // exists to bound.
    runtime.isSegmentPending.mockReturnValue(true);
    const queued = send('are you still there?');
    await settle();
    expect((await queued).queued).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // The runtime's clock gives up and says so. Without that release reaching
    // the queue, this message waits for a turn boundary that is never coming:
    // the session is idle, and nothing else will pump it.
    runtime.isSegmentPending.mockReturnValue(false);
    runtime.emitDispatchGateChange(session);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(listQueuedMessages(session)).toEqual([]);
  });
});
