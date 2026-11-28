/**
 * The launch gate and the pump change (spec `turns-survive-restarts` §7.5,
 * §8 K10 and F8; T15, DOR-5234), over the real dispatcher. Every path that
 * can launch a turn (the launch itself, adoption, the queue rearm and the
 * pump) holds a chat while a run a restart ended is undecided or its
 * continuation has not started; the continuation goes first, then the queue
 * in its own order. A row and a run without one never wait on each other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { dispatchMessage } from '../../session/message-dispatcher.js';
import { adoptQueuedMessages } from '../../session/message-dispatcher/adopt.js';
import { rearmChatQueues } from '../../session/message-dispatcher/queue-upkeep.js';
import { orderedWaiting, schedulePump } from '../../session/message-dispatcher/pump.js';
import { pending } from '../../session/message-dispatcher/state.js';
import { getMessageQueueStore } from '../../session/message-queue-store.js';
import { getOrCreateProjector } from '../../session/session-state-projector.js';
import { launchGateHolds } from '../../session/turn-port/launch-gate.js';
import { continuationWords } from '../recovery/continue-after-restart.js';
import {
  AGENT,
  boot,
  deadBoot,
  h,
  kill,
  pass,
  quick,
  runningRun,
  settle,
  setUpHarness,
  tearDownHarness,
} from './restart-harness.js';

/** A person's turn that works until released. */
let release: (() => void) | undefined;
async function* longTurn(content: string): AsyncGenerator<StreamEvent> {
  h.answered.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    release = resolve;
  });
  yield { type: 'done', data: {} };
}

/** A message to the chat, straight to the dispatcher, from one sender. */
function send(content: string, clientId = 'person-window') {
  return dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: h.sessionId,
    clientId,
    content,
    projector: getOrCreateProjector(h.sessionId, AGENT.home),
    runtime: runtimeRegistry.get(h.inner.type),
    cwd: AGENT.home,
  });
}

/** A row waiting in the chat's queue, written by a sender the queue knows. */
function queued(content: string, clientId: string): string {
  return getMessageQueueStore()!.enqueue({
    sessionId: h.sessionId,
    content,
    clientId,
    origin: { kind: clientId.startsWith('chat:') ? 'chat-message' : 'interactive' },
  }).id;
}

beforeEach(async () => {
  await setUpHarness();
  release = undefined;
});

afterEach(async () => {
  release?.();
  await vi.waitFor(() => expect(h.inner.isTurnOpen(h.sessionId)).toBe(false));
  await tearDownHarness();
});

describe('K10: a chat whose run a restart ended holds every launch path', () => {
  it('none of the four paths launches; the continuation goes first, then the queue in order', async () => {
    runningRun(deadBoot().store);
    kill();
    // The next process, its record installed and recovery not run yet: the
    // gate decides what it finds, and still holds the chat until the
    // continuation has started.
    boot({}, { recover: false });
    const peer = queued('from another chat', 'chat:01KPEERCHATXD0000000000000');

    // 1. The launch itself: a person's message into an idle chat.
    await send('from the person');
    await settle();
    // 2. Adoption, and 3. the queue rearm, which adopts through the same door.
    adoptQueuedMessages({
      sessionId: h.sessionId,
      projector: getOrCreateProjector(h.sessionId, AGENT.home),
      runtime: runtimeRegistry.get(h.inner.type),
    });
    await rearmChatQueues({
      resume: (id) => {
        adoptQueuedMessages({
          sessionId: id,
          projector: getOrCreateProjector(id, AGENT.home),
          runtime: runtimeRegistry.get(h.inner.type),
          onlyFromChats: true,
        });
      },
    });
    // 4. The pump, at a turn boundary.
    schedulePump(h.sessionId);
    await settle();

    expect(h.answered).toEqual([]);
    expect(launchGateHolds(h.sessionId)).toBe(true);
    expect(orderedWaiting(h.sessionId).map((entry) => entry.messageId)).toContain(peer);

    // The worker makes the continuation; it passes the gate and runs first,
    // and its settle lets the queue move, in the queue's own order.
    await pass();
    await vi.waitFor(() => expect(h.answered).toHaveLength(3));
    expect(h.answered).toEqual([continuationWords([]), 'from the person', 'from another chat']);
    expect(launchGateHolds(h.sessionId)).toBe(false);
  });
});

describe('F8: a row moved to the top while a run without a row waits', () => {
  it('starts rows in position order, the run without a row beside them, and nothing stalls', async () => {
    h.inner.withScenarios([longTurn, quick, quick, quick]);
    boot();
    await send('the person is working');
    await vi.waitFor(() => expect(h.inner.isTurnOpen(h.sessionId)).toBe(true));
    const first = (await send('first in line')).outcome.messageId;
    const second = (await send('second in line')).outcome.messageId;
    const { runId } = h.record!.port.start({
      sessionId: h.sessionId,
      cwd: AGENT.home,
      content: 'from the app: tally the votes',
      origin: { kind: 'resume' },
      tier: 'owner',
    });
    await pass();
    // The person moves the second row to the top.
    getMessageQueueStore()!.move(second, { before: first });

    release?.();
    for (let i = 0; i < 6 && h.answered.length < 4; i++) {
      h.now = Math.max(h.now, h.record!.effects.openStartOf(runId)?.availableAt ?? h.now);
      await pass();
    }
    await vi.waitFor(() => expect(h.answered).toHaveLength(4));
    const rowsInOrder = h.answered.filter((words) => words.endsWith('in line'));
    expect(rowsInOrder).toEqual(['second in line', 'first in line']);
    expect(h.answered).toContain('from the app: tally the votes');
  });

  it('the pump tries the oldest entry without a row when the head row cannot launch', async () => {
    boot();
    const held = queued('held for background work', 'person-window');
    adoptQueuedMessages({
      sessionId: h.sessionId,
      projector: getOrCreateProjector(h.sessionId, AGENT.home),
      runtime: runtimeRegistry.get(h.inner.type),
    });
    // The runtime held the head row for the agent's background work, before
    // the pump adoption scheduled could launch it.
    pending.get(held)!.held = { reason: 'background_work' } as never;
    await settle();
    expect(h.answered).toEqual([]);

    // A run without a row arrives: it parks behind the held row, and the pump
    // starts it rather than leave it behind a row that cannot go.
    h.record!.port.start({
      sessionId: h.sessionId,
      cwd: AGENT.home,
      content: 'from the app: a run without a row',
      origin: { kind: 'resume' },
      tier: 'owner',
    });
    await pass();
    schedulePump(h.sessionId);
    // The run without a row went first; the held row runs at that turn's
    // boundary, which tries a held row again.
    await vi.waitFor(() => expect(h.answered).toHaveLength(2));
    expect(h.answered).toEqual(['from the app: a run without a row', 'held for background work']);
  });
});
