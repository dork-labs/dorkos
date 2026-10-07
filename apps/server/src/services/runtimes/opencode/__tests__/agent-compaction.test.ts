/**
 * RT-CMP-02 on OpenCode (DOR-2732): the agent asks for its own conversation
 * to be summarized, the sidecar's real summarize call runs once the asking
 * turn is over, and the chat keeps that the agent asked — live, in the
 * durable record, and on the reopened conversation (OpenCode's own store keeps
 * no compaction row, so the overlay adds one). OpenCode takes no focus note,
 * so the agent's note goes nowhere; the summary still runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { SessionEventStore, setSessionEventStore } from '../../../session/index.js';
import { resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import { AgentCompactionService } from '../../../session/agent-compaction/agent-compaction-service.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import {
  DIRECTORY,
  OC_SESSION_A,
  globalEvent,
  serverConnected,
  sessionCompacted,
  sessionIdle,
  sessionInfo,
} from './opencode-sse-fixtures.js';

vi.mock('../providers/check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(() => []),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
  getConnectedOpenCodeProvider: vi.fn(() => null),
}));

const SESSION = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

afterEach(() => {
  resetMessageDispatcher();
  disposeProjector(SESSION);
  setSessionEventStore(undefined);
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
      summarize: vi.fn(async () => ({ data: true })),
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

describe('OpenCode — agent-requested compaction', () => {
  it('RT-CMP-02: summarizes on the agent’s request and the reopened chat keeps that the agent asked', async () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const { client, provider, latest } = sidecar();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession(SESSION, {
      cwd: DIRECTORY,
      permissionMode: 'default',
      model: 'anthropic/claude-sonnet-4-5',
    });
    getOrCreateProjector(SESSION, DIRECTORY, { persist: 'history' }).seedStatus({
      contextUsage: {
        totalTokens: 180_000,
        maxTokens: 200_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    const compaction = new AgentCompactionService({ resolveRuntime: async () => runtime });

    const outcome = await compaction.request({ sessionId: SESSION, note: 'keep the plan' });
    expect(outcome.status).toBe('scheduled');

    // No turn is open, so the summary starts now: the sidecar's own call.
    await vi.waitFor(() => expect(client.global.event).toHaveBeenCalled());
    latest().push(globalEvent(DIRECTORY, serverConnected()));
    await vi.waitFor(() => expect(client.session.summarize).toHaveBeenCalledTimes(1));
    latest().push(globalEvent(DIRECTORY, sessionCompacted(OC_SESSION_A)));
    latest().push(globalEvent(DIRECTORY, sessionIdle(OC_SESSION_A)));

    const projector = getOrCreateProjector(SESSION, DIRECTORY, { persist: 'history' });
    await expect
      .poll(() => projector.replayFrom(0).some((event) => event.type === 'turn_end'))
      .toBe(true);
    expect(
      projector.replayFrom(0).find((event) => event.type === 'compact_boundary')
    ).toMatchObject({ requestedBy: 'agent', contextPercent: 90 });
    expect(runtime.isTurnOpen(SESSION)).toBe(false);

    // Reopened: OpenCode's store has no compaction row; the overlay adds one.
    disposeProjector(SESSION);
    const history = await runtime.getMessageHistory(DIRECTORY, SESSION);
    const row = history.find((message) => message.messageType === 'compaction');
    expect(row?.compactMetadata).toMatchObject({ requestedBy: 'agent', contextPercent: 90 });
  });
});
