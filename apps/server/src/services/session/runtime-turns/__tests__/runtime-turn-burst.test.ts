/**
 * Several turns the agent started, back to back, hold the session until the
 * last of them ends (DOR-2829).
 *
 * Several background helpers finishing at once make the Claude Code CLI open
 * one segment per report: every one but the last ends at once with nothing in
 * it, and the last carries the agent's answer to all of them (captured in
 * `runtimes/claude-code/sessions/__tests__/fixtures/helper-burst-between-sdk-0.3.304.jsonl`).
 * Each segment is a turn of the agent's own, so the server sees three turns
 * announced within milliseconds. Only the first used to claim the session, and
 * its end handed the session back while the answer was still being written, so
 * a message arriving then launched into the middle of it.
 *
 * The real `dispatchMessage`, queue store, runtime-turn projection and session
 * lock are under test. Only the runtime is a double. Fixed waits come only
 * before a "not sent" check; a send that must happen is waited for.
 *
 * @module services/session/runtime-turns/__tests__/runtime-turn-burst
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import {
  dispatchMessage,
  isTurnInFlight,
  noteRuntimeTurnClosed,
  noteRuntimeTurnOpen,
  resetMessageDispatcher,
} from '../../message-dispatcher.js';
import { inFlight } from '../../message-dispatcher/state.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import { SessionLockManager } from '../../session-lock.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import { subscribeRuntimeTurns } from '../runtime-turn.js';

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

/** End a pushed turn, saying `text` first when given. */
function finish(turn: ReturnType<typeof pushable>, sessionId: string, text?: string): void {
  if (text !== undefined) turn.push({ type: 'text_delta', data: { text } } as StreamEvent);
  turn.push({ type: 'done', data: { sessionId } } as StreamEvent);
  turn.end();
}

/** Let queued microtasks, the pump's deferral and the lock's retry interval run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

let sessionCounter = 0;
let session: string;
let runtime: FakeAgentRuntime;
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  sessionCounter += 1;
  session = `00000000-0000-4000-9000-${String(sessionCounter).padStart(12, '0')}`;
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  // The real lock, one holder at a time, as the runtime's own lock manager is.
  const locks = new SessionLockManager();
  runtime.acquireLock.mockImplementation((id, client, res, token) =>
    locks.acquireLock(id, client, res, token)
  );
  runtime.acquireRuntimeLock.mockImplementation((key, res, token) =>
    locks.acquireRuntimeLock(key, res, token)
  );
  runtime.releaseLock.mockImplementation((id, client, token) =>
    locks.releaseLock(id, client, token)
  );
  runtime.isLocked.mockImplementation((id, client) => locks.isLocked(id, client));
  // The context bag would read git status off the disk; a runtime that brings
  // its own leaves it out, and these cases are about turn order.
  const capabilities = runtime.getCapabilities();
  runtime.getCapabilities.mockReturnValue({ ...capabilities, nativeContext: ['git_status'] });
  unsubscribe = subscribeRuntimeTurns(runtime);
});

afterEach(async () => {
  await settle();
  unsubscribe?.();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
});

/** A turn that answers at once. */
async function* quickTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'answering you' } } as StreamEvent;
  yield { type: 'done', data: {} } as StreamEvent;
}

/** A person's message, as the chat sends it. */
function send(content: string) {
  return dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: session,
    clientId: 'person',
    content,
    projector: getOrCreateProjector(session),
    runtime,
  });
}

/** Who started each turn on the durable stream, in order. */
function turnOrigins(): string[] {
  return getOrCreateProjector(session)
    .replayFrom(0)
    .filter((event) => event.type === 'turn_start')
    .map((event) => (event as { origin?: string }).origin ?? 'person');
}

describe('several reports at once (DOR-2829)', () => {
  it('holds a message until the last turn the agent started has ended', async () => {
    runtime.withScenarios([quickTurn]);
    // Three helpers report together: two empty segments, then the answer.
    const empty1 = pushable();
    const empty2 = pushable();
    const answer = pushable();
    runtime.emitRuntimeTurn(session, empty1.stream);
    runtime.emitRuntimeTurn(session, empty2.stream);
    runtime.emitRuntimeTurn(session, answer.stream);
    finish(empty1, session);
    await settle();

    // The agent is still writing its answer to the reports.
    const sent = await send('how is it going?');
    await settle();
    expect(sent.queued).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    finish(empty2, session);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    finish(answer, session, 'all three helpers are done');
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));

    // Each turn whole and in order: the agent's three, then the person's.
    await vi.waitFor(() => expect(turnOrigins()).toHaveLength(4));
    expect(turnOrigins()).toEqual(['runtime', 'runtime', 'runtime', 'person']);
    await vi.waitFor(() =>
      expect(getOrCreateProjector(session).getStatus().lifecycle).toBe('idle')
    );
  });

  it('holds a queued message when the reports open while a person’s turn holds the session', async () => {
    const reply = pushable();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield* reply.stream;
      },
      quickTurn,
    ]);
    void send('start the helpers');
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    reply.push({ type: 'text_delta', data: { text: 'on it' } } as StreamEvent);

    // The reports arrive while that turn is still settling, and a second
    // message is queued behind it.
    const empty = pushable();
    const answer = pushable();
    runtime.emitRuntimeTurn(session, empty.stream);
    runtime.emitRuntimeTurn(session, answer.stream);
    finish(empty, session);
    const second = send('and now?');
    reply.push({ type: 'done', data: { sessionId: session } } as StreamEvent);
    reply.end();
    await settle();
    await settle();
    // The person's turn let the session go, and the answer is still open.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    finish(answer, session, 'all done');
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
    expect((await second).queued).toBe(true);
    await vi.waitFor(() => expect(turnOrigins()).toHaveLength(4));
    expect(turnOrigins()).toEqual(['person', 'runtime', 'runtime', 'person']);
  });

  it('takes the session back in the same step one of several ends, not a pump later', () => {
    // A person's turn holds the slot as two of the agent's turns open.
    const personal = Symbol('a person’s turn');
    inFlight.set(session, {
      clientId: 'person',
      token: personal,
      startedAt: 0,
      sawTurnStart: true,
    });
    noteRuntimeTurnOpen(session);
    noteRuntimeTurnOpen(session);
    // It lets go, and before the queue runs again one of the agent's ends.
    inFlight.delete(session);
    noteRuntimeTurnClosed(session, runtime);
    expect(isTurnInFlight(session, runtime)).toBe(true);
    noteRuntimeTurnClosed(session, runtime);
    expect(isTurnInFlight(session, runtime)).toBe(false);
  });

  it('says so, and lets the queue move, when the runtime disagrees at the last close', async () => {
    const warn = vi.spyOn(logger, 'warn');
    runtime.withScenarios([quickTurn]);
    const turn = pushable();
    runtime.emitRuntimeTurn(session, turn.stream);
    await settle();
    const sent = await send('anyone there?');
    await settle();
    expect(sent.queued).toBe(true);

    // The runtime still reports a turn open as the agent's last one ends.
    runtime.isTurnOpen.mockReturnValueOnce(true);
    finish(turn, session);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('a turn is still open on the runtime'),
        expect.objectContaining({ sessionId: session, resetTo: 0 })
      )
    );
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    warn.mockRestore();
  });

  it('holds a fresh message sent the moment a person’s turn lets go, before the answer takes the lock', async () => {
    const reply = pushable();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield* reply.stream;
      },
      quickTurn,
    ]);
    void send('start the helpers');
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    reply.push({ type: 'text_delta', data: { text: 'on it' } } as StreamEvent);
    const empty = pushable();
    const answer = pushable();
    runtime.emitRuntimeTurn(session, empty.stream);
    runtime.emitRuntimeTurn(session, answer.stream);
    finish(empty, session);
    reply.push({ type: 'done', data: { sessionId: session } } as StreamEvent);
    reply.end();
    // The person's turn has ended on the stream; the agent's projection is
    // still between lock retries.
    await vi.waitFor(
      () =>
        expect(
          getOrCreateProjector(session)
            .replayFrom(0)
            .filter((event) => event.type === 'turn_end')
        ).toHaveLength(1),
      { interval: 1 }
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Every reader that asks whether the session is busy is told yes, not only
    // the queue.
    expect(isTurnInFlight(session, runtime)).toBe(true);
    const fresh = await send('right now?');
    await settle();
    expect(fresh.queued).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    finish(answer, session, 'all done');
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
  });

  it('holds a fresh message the agent’s turns have not claimed the slot for yet', async () => {
    runtime.withScenarios([quickTurn]);
    // A person's turn held the slot as two of the agent's turns opened, and
    // has let it go; the queue has not run since.
    const personal = Symbol('a person’s turn');
    inFlight.set(session, {
      clientId: 'person',
      token: personal,
      startedAt: 0,
      sawTurnStart: true,
    });
    noteRuntimeTurnOpen(session);
    noteRuntimeTurnOpen(session);
    inFlight.delete(session);
    const fresh = await send('right now?');
    await settle();
    expect(fresh.queued).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteRuntimeTurnClosed(session, runtime);
    noteRuntimeTurnClosed(session, runtime);
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
  });
});
