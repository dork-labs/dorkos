/**
 * A slow local model on OpenCode (FB-68): a turn whose model takes minutes to
 * answer must not be ended by the stall guard's 2-minute first-event window,
 * and a hung tool must still be.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import { withStallGuard } from '../../../session/stall-guard.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import { withModelWaitLiveness, type ModelWaitContext } from '../events/model-wait-liveness.js';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import {
  DIRECTORY,
  OC_SESSION_A,
  globalEvent,
  opencodeSimpleTurn,
  serverConnected,
  sessionInfo,
} from './opencode-sse-fixtures.js';

vi.mock('../providers/check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(() => []),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
  getConnectedOpenCodeProvider: vi.fn(() => null),
}));

afterEach(() => {
  vi.useRealTimers();
});

function sidecar() {
  const queues: TurnEventQueue<unknown>[] = [];
  const client = {
    global: {
      event: vi.fn(async (options?: { signal?: AbortSignal }) => {
        const queue = new TurnEventQueue<unknown>();
        options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
        queues.push(queue);
        return { stream: queue };
      }),
    },
    session: {
      create: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_A, DIRECTORY) })),
      get: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_A, DIRECTORY) })),
      list: vi.fn(async () => ({ data: [] })),
      messages: vi.fn(async () => ({ data: [] })),
      promptAsync: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({ data: true })),
      todo: vi.fn(async () => ({ data: [] })),
    },
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
    mcp: { status: vi.fn(async () => ({ data: {} })) },
    config: { get: vi.fn(async () => ({ data: {} })) },
  };
  const provider = {
    getClient: vi.fn(async () => client as unknown as OpencodeClient),
    peekClient: vi.fn(() => client as unknown as OpencodeClient),
  };
  return { client, provider, latest: () => queues[queues.length - 1]! };
}

describe('OpenCode — a model slow to answer (FB-68)', () => {
  it('is not cut off by the stall guard while the model takes 5 minutes to its first token', async () => {
    vi.useFakeTimers();
    const { client, provider, latest } = sidecar();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('s1', { cwd: DIRECTORY, permissionMode: 'default' });
    // The same guard every detached turn runs under (`trigger-turn.ts`).
    const guarded = withStallGuard(runtime.sendMessage('s1', 'hello', { cwd: DIRECTORY }), {
      sessionId: 's1',
      timeoutMs: SESSIONS.TURN_STALL_TIMEOUT_MS,
      firstEventTimeoutMs: SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS,
      isPaused: () => false,
      onStall: () => runtime.interruptQuery('s1'),
    });
    const events: StreamEvent[] = [];
    const finished = (async () => {
      for await (const event of guarded) events.push(event);
    })();
    await vi.waitFor(() => expect(client.global.event).toHaveBeenCalled());
    latest().push(globalEvent(DIRECTORY, serverConnected()));
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());

    // The sidecar takes the prompt and starts the reply, then the model is
    // silent: a local model loading and reading the prompt.
    const turn = opencodeSimpleTurn(OC_SESSION_A, 'hi', { prompt: 'hello' });
    const replyStarts = turn.findIndex((event) => event.type === 'message.part.updated');
    for (const event of turn.slice(0, replyStarts)) latest().push(globalEvent(DIRECTORY, event));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    for (const event of turn.slice(replyStarts)) latest().push(globalEvent(DIRECTORY, event));
    await finished;

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toEqual([]);
    expect(client.session.abort).not.toHaveBeenCalled();
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.data as { text: string }).text)
      .join('');
    expect(text).toBe('hi');
    expect(events.at(-1)?.type).toBe('done');
  });
});

/** A source the test feeds by hand, one event at a time. */
function handSource() {
  const queue = new TurnEventQueue<StreamEvent>();
  return { queue, source: queue as AsyncIterable<StreamEvent> };
}

function context(): ModelWaitContext & {
  startedToolCallIds: Set<string>;
  endedToolCallIds: Set<string>;
} {
  return { sessionId: 's1', startedToolCallIds: new Set(), endedToolCallIds: new Set() };
}

const status = { type: 'session_status', data: { sessionId: 's1' } } as const;
const text = (t: string): StreamEvent => ({ type: 'text_delta', data: { text: t } });

describe('withModelWaitLiveness', () => {
  it('passes events through in order and says it is alive each quiet interval', async () => {
    vi.useFakeTimers();
    const { queue, source } = handSource();
    const seen: StreamEvent[] = [];
    const done = (async () => {
      for await (const event of withModelWaitLiveness(source, context(), 1_000)) seen.push(event);
    })();
    queue.push(text('a'));
    await vi.advanceTimersByTimeAsync(2_500);
    queue.push(text('b'));
    queue.end();
    await done;
    expect(seen).toEqual([text('a'), status, status, text('b')]);
  });

  it('says nothing while a tool call is open, so a hung tool still meets the stall guard', async () => {
    vi.useFakeTimers();
    const { queue, source } = handSource();
    const ctx = context();
    ctx.startedToolCallIds.add('call_1');
    const seen: StreamEvent[] = [];
    const done = (async () => {
      for await (const event of withModelWaitLiveness(source, ctx, 1_000)) seen.push(event);
    })();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toEqual([]);
    ctx.endedToolCallIds.add('call_1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual([status]);
    queue.end();
    await done;
  });

  it('stops at once when the consumer stops while the source is still waiting', async () => {
    vi.useFakeTimers();
    const { source } = handSource();
    const wrapped = withModelWaitLiveness(source, context(), 1_000);
    const first = wrapped.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).value).toEqual(status);
    await expect(wrapped.return(undefined)).resolves.toEqual({ done: true, value: undefined });
  });
});
