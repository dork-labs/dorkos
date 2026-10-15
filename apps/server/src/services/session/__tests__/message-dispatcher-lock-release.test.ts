/**
 * A waiting message starts when the session's write-lock is let go, not only
 * at the next turn boundary.
 *
 * The incident (2026-10-12): a chat ended its turn and looked done, but its
 * agent still had background work, so the turn's stream (and the write-lock)
 * stayed open for over an hour. Two `chat_send` messages to it came back
 * "queued, position 1" and nothing ran them, even after an interrupt closed
 * that stream. A plain message sent a moment later started at once.
 *
 * Two holes made that, and each case below pins one:
 *
 * 1. A message the write-lock refused waits with `waitingOnLock`, which only a
 *    turn boundary cleared. The boundary of a turn that drains background work
 *    fires at its `done`, long before it lets go of the lock, so the release
 *    found the message still marked and the pump stepped over it until its
 *    five-minute wait bound.
 * 2. A turn launched by that wait bound never claimed the session's in-flight
 *    slot. While it ran, the dispatcher read the session as idle, so the next
 *    message launched straight into it and waited inside the dispatch call, up
 *    to the lock TTL, before it was even reported as queued.
 *
 * The write-lock is modelled here the way `SessionLockManager` behaves: one
 * holder, refused to every other client, freed by a token-matched release.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  noteTurnBoundary,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';

const PERSON = 'window-a';
const OTHER_CHAT = 'chat-message:other-chat';

let runtime: FakeAgentRuntime;
let session: string;
let sessionCounter = 0;
let openGates: Array<() => void>;
/** The modelled write-lock: who holds it, under which token. */
let lock: { clientId: string; token?: symbol } | null;

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  openGates.push(open);
  return { wait, open };
}

function send(content: string, clientId: string, extra: Record<string, unknown> = {}) {
  return dispatchMessage({
    sessionId: session,
    clientId,
    content,
    projector: getOrCreateProjector(session),
    runtime,
    ...extra,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A turn that streams a token, parks on `hold`, then ends. */
function heldTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** A turn that ENDS, then keeps its stream (and the lock) open for background work. */
function drainingTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'done for now' } } as StreamEvent;
    yield { type: 'done', data: {} } as StreamEvent;
    await hold;
  };
}

function quickTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** Resolve within `ms`, or report that it did not. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([
    promise,
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

beforeEach(() => {
  sessionCounter += 1;
  session = `00000000-0000-4000-9000-${String(sessionCounter).padStart(12, '0')}`;
  openGates = [];
  lock = null;
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.acquireLock.mockImplementation((_sid, clientId, _res, token) => {
    if (lock && lock.clientId !== clientId) return false;
    lock = { clientId, ...(token ? { token } : {}) };
    return true;
  });
  runtime.releaseLock.mockImplementation((_sid, clientId, token) => {
    if (!lock || lock.clientId !== clientId) return;
    if (token && lock.token && token !== lock.token) return;
    lock = null;
  });
  runtime.isLocked.mockImplementation(
    (_sid, clientId) => lock !== null && (clientId === undefined || lock.clientId !== clientId)
  );
});

afterEach(async () => {
  for (const open of openGates) open();
  await settle();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  vi.restoreAllMocks();
});

describe('a message the write-lock refused', () => {
  it('starts as soon as the turn holding the lock lets go, after that turn already ended', async () => {
    const background = gate();
    runtime.withScenarios([drainingTurn(background.wait), quickTurn()]);

    // The person's turn ends (the chat looks done) but keeps its stream open
    // while background work finishes. The projector's turn_end is a boundary.
    await send('release the build', PERSON);
    await vi.waitFor(() => expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull());
    noteTurnBoundary(session);
    await settle();

    // Another chat's message waits out its budget behind that open stream,
    // and the lock refuses it: it is now waiting on the lock.
    const queued = await send('coordinator: are you done?', OTHER_CHAT, { queueWaitMs: 300 });
    expect(queued.queued).toBe(true);
    await vi.waitFor(() => expect(runtime.acquireLock).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // The background work ends (or an interrupt closes the stream): the lock
    // is free. No new boundary comes, because the turn ended long ago.
    background.open();

    // It runs now, not at its next wait bound 300 ms later.
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2), {
      timeout: 150,
      interval: 5,
    });
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      session,
      'coordinator: are you done?',
      expect.anything()
    );
  });
});

describe('a turn the wait bound launched', () => {
  it('holds the session, so the next message is queued at once and runs after it', async () => {
    const stuck = gate();
    const second = gate();
    runtime.withScenarios([drainingTurn(stuck.wait), heldTurn(second.wait), quickTurn()]);

    // A turn ends but its stream never closes, and its lock expires under it
    // (the lock TTL).
    await send('a turn whose stream goes dark', PERSON);
    await vi.waitFor(() => expect(getOrCreateProjector(session).peekInProgressTurn()).toBeNull());
    const waiting = await send('a message waiting behind it', OTHER_CHAT, { queueWaitMs: 40 });
    expect(waiting.queued).toBe(true);
    lock = null;

    // The wait bound launches the waiting message, and its turn runs.
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
    // The dark stream finally closes, handing back its own slot.
    stuck.open();
    await settle();

    // The session is busy with the bound-launched turn, so a message from the
    // same chat is told it is queued at once, rather than held inside the
    // dispatch call until that turn ends.
    const next = await within(send('a follow-up', OTHER_CHAT), 200);
    expect(next).not.toBe('still waiting');
    expect(next).toMatchObject({ accepted: true, queued: true });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);

    // And it runs when that turn ends.
    second.open();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(3), {
      timeout: 1_000,
    });
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(session, 'a follow-up', expect.anything());
  });
});
