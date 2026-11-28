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
 * lock are under test. Only the runtime is a double.
 *
 * @module services/session/runtime-turns/__tests__/runtime-turn-burst
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { dispatchMessage, resetMessageDispatcher } from '../../message-dispatcher.js';
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

describe('several reports at once (DOR-2829)', () => {
  it('holds a message until the last turn the agent started has ended', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'answering you' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
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
    const sent = await dispatchMessage({
      origin: { kind: 'interactive' },
      sessionId: session,
      clientId: 'person',
      content: 'how is it going?',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();
    expect(sent.queued).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    finish(empty2, session);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    finish(answer, session, 'all three helpers are done');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // Each turn whole and in order: the agent's three, then the person's.
    const events = getOrCreateProjector(session).replayFrom(0);
    const origins = events
      .filter((event) => event.type === 'turn_start')
      .map((event) => (event as { origin?: string }).origin ?? 'person');
    expect(origins).toEqual(['runtime', 'runtime', 'runtime', 'person']);
    expect(getOrCreateProjector(session).getStatus().lifecycle).toBe('idle');
  });
});
