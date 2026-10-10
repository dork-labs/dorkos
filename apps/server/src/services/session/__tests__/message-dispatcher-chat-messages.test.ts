/**
 * The two dispatcher rules chats messaging chats adds (spec `spin-off-chats`
 * §3), driven through the real dispatcher over a real SQLite queue with the
 * harness `message-dispatcher.test.ts` uses:
 *
 * - **The person first.** A message a person queues goes in front of every row
 *   another chat sent, as a real move, so the queue shows the order it runs.
 * - **The level ceiling at launch.** A row another chat sent launches under the
 *   ceiling the chat-message service resolves for it AT LAUNCH, and under the
 *   receiving runtime's default when nothing is wired (fails closed). A
 *   person's row carries no chat ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TurnPermissionCeiling, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';

vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  listQueuedMessages,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';

const PERSON = 'window-a';
const CHAT_A = 'chat:chat-a';
const CHAT_C = 'chat:chat-c';

const TIGHT: TurnPermissionLevel = { asks: 'always', reach: 'edit' };
const MIDDLE: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };

let runtime: FakeAgentRuntime;
let session: string;
let counter = 0;
let gates: Array<() => void>;

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
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

function heldTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

function quickTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** The `permissionCeiling` the runtime was handed on its nth turn, or the absence of one. */
function ceilingOfCall(n: number): { has: boolean; value?: TurnPermissionCeiling } {
  const opts = runtime.sendMessage.mock.calls[n]![2] as Record<string, unknown>;
  return 'permissionCeiling' in opts
    ? { has: true, value: opts.permissionCeiling as TurnPermissionCeiling }
    : { has: false };
}

beforeEach(() => {
  counter += 1;
  session = `00000000-0000-4000-8000-c4a7${String(counter).padStart(8, '0')}`;
  gates = [];
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
});

afterEach(async () => {
  for (const open of gates) open();
  await settle();
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  vi.restoreAllMocks();
});

describe('the person first', () => {
  it('moves a person’s message ahead of every row another chat queued', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn(), quickTurn()]);

    await send('the running turn', PERSON);
    await send('agent one', CHAT_A);
    await send('agent two', CHAT_C);
    await send('the person', PERSON);

    expect(listQueuedMessages(session).map((m) => m.content)).toEqual([
      'the person',
      'agent one',
      'agent two',
    ]);
  });

  it('keeps a chat’s row behind a person’s, and the person’s own order intact', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn(), quickTurn()]);

    await send('the running turn', PERSON);
    await send('person one', PERSON);
    await send('agent', CHAT_A);
    await send('person two', PERSON);

    expect(listQueuedMessages(session).map((m) => m.content)).toEqual([
      'person one',
      'person two',
      'agent',
    ]);
  });

  it('runs them in the order the queue shows', async () => {
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn(), quickTurn()]);

    await send('the running turn', PERSON);
    await send('agent', CHAT_A);
    await send('the person', PERSON);
    first.open();
    await settle();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(3));

    expect(runtime.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      'the running turn',
      'the person',
      'agent',
    ]);
  });
});

describe('the level ceiling of a row another chat sent', () => {
  it('launches under the ceiling the resolver gives for that message id', async () => {
    const resolver = vi.fn(() => TIGHT);
    setQueuedChatCeilingResolver(resolver);
    runtime.withScenarios([quickTurn()]);

    const result = await send('from another chat', CHAT_A);
    await settle();

    expect(resolver).toHaveBeenCalledWith(result.outcome.messageId);
    expect(ceilingOfCall(0)).toEqual({ has: true, value: TIGHT });
  });

  it('reads the ceiling when a queued row LAUNCHES, not when it was accepted', async () => {
    let current: TurnPermissionCeiling = MIDDLE;
    setQueuedChatCeilingResolver(() => current);
    const first = gate();
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    await send('the running turn', PERSON);
    await send('from another chat', CHAT_A);
    // A second sender batched in while it waited: its bound joins the row's.
    current = [MIDDLE, TIGHT];
    first.open();
    await settle();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));

    expect(ceilingOfCall(1)).toEqual({ has: true, value: [MIDDLE, TIGHT] });
  });

  it('launches at the runtime default when no resolver is wired (fails closed)', async () => {
    runtime.withScenarios([quickTurn()]);
    await send('from another chat', CHAT_A);
    await settle();
    expect(ceilingOfCall(0)).toEqual({ has: true, value: 'runtime-default' });
  });

  it('holds a row to both its own ceiling and the chat’s', async () => {
    setQueuedChatCeilingResolver(() => TIGHT);
    runtime.withScenarios([quickTurn()]);
    await send('from another chat', CHAT_A, { permissionCeiling: MIDDLE });
    await settle();
    expect(ceilingOfCall(0)).toEqual({ has: true, value: [MIDDLE, TIGHT] });
  });

  it('gives a person’s row no chat ceiling, and never asks the resolver about it', async () => {
    const resolver = vi.fn(() => TIGHT);
    setQueuedChatCeilingResolver(resolver);
    runtime.withScenarios([quickTurn()]);

    await send('the person', PERSON);
    await settle();

    expect(resolver).not.toHaveBeenCalled();
    expect(ceilingOfCall(0)).toEqual({ has: false });
  });
});
