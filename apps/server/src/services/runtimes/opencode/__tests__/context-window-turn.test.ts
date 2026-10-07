/**
 * A reply's context reading on OpenCode (DOR-2732, RT-CMP-03): the window is
 * read from the sidecar's catalog, and a catalog that never answers costs the
 * reply nothing but the window — never its `done`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { TurnEventQueue } from '../events/global-event-hub.js';
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

function sidecar(list: () => Promise<unknown>) {
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
    provider: { list: vi.fn(list) },
    mcp: { status: vi.fn(async () => ({ data: {} })) },
    config: { get: vi.fn(async () => ({ data: {} })) },
  };
  const provider = {
    getClient: vi.fn(async () => client as unknown as OpencodeClient),
    peekClient: vi.fn(() => client as unknown as OpencodeClient),
  };
  return { client, provider, latest: () => queues[queues.length - 1]! };
}

async function reply(list: () => Promise<unknown>): Promise<StreamEvent[]> {
  const { client, provider, latest } = sidecar(list);
  const runtime = new OpenCodeRuntime({ provider });
  runtime.ensureSession('s1', { cwd: DIRECTORY, permissionMode: 'default' });
  const events: StreamEvent[] = [];
  const finished = (async () => {
    for await (const event of runtime.sendMessage('s1', 'hello', { cwd: DIRECTORY })) {
      events.push(event);
    }
  })();
  await vi.waitFor(() => expect(client.global.event).toHaveBeenCalled());
  latest().push(globalEvent(DIRECTORY, serverConnected()));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
  for (const event of opencodeSimpleTurn(OC_SESSION_A, 'hi', { prompt: 'hello' })) {
    latest().push(globalEvent(DIRECTORY, event));
  }
  await finished;
  return events;
}

const reading = (events: StreamEvent[]) =>
  events.find(
    (event) =>
      event.type === 'session_status' &&
      (event.data as { contextTokens?: number }).contextTokens !== undefined
  )?.data as { contextTokens: number; contextMaxTokens?: number } | undefined;

describe('OpenCode — the context reading of a reply', () => {
  it('RT-CMP-03: carries the window the sidecar’s catalog names for the reply’s model', async () => {
    const events = await reply(async () => ({
      data: {
        all: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-sonnet-4-5': {
                id: 'claude-sonnet-4-5',
                limit: { context: 200_000, output: 64_000 },
              },
            },
          },
        ],
        default: {},
        connected: ['anthropic'],
      },
    }));
    expect(reading(events)).toMatchObject({ contextMaxTokens: 200_000 });
  });

  it('still ends the reply, without a window, when the catalog read never answers', async () => {
    const events = await reply(() => new Promise(() => {}));
    expect(events.at(-1)?.type).toBe('done');
    expect(reading(events)).toBeDefined();
    expect(reading(events)!.contextMaxTokens).toBeUndefined();
  }, 10_000);
});
