/**
 * A task run keeps the computer awake from start to finish, and counts ONCE:
 * its turn, which the registry wrapper also holds, is that task and not also a
 * chat. Pinned on both dispatch paths, because they pick the run's session in
 * different places (spec `keep-awake`, counting invariant).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { initBoundary } from '../../../lib/boundary.js';
import { TaskSchedulerService, singleRuntimeSource } from '../task-scheduler-service.js';
import { isTerminalRunStatus, TaskStore } from '../task-store.js';
import { holdAwakeDuringTurns, KeepAwakeService } from '../../core/keep-awake/index.js';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

import { isRelayEnabled } from '../../relay/relay-state.js';

vi.mock('../../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtimes/claude-code/claude-config-dir.js')>()),
  isRegisteredClaudeAccount: vi.fn(() => undefined),
}));

const CONFIG = { maxConcurrentRuns: 2, retentionCount: 100, mayFire: true, firingReason: 'test' };

/** A turn that emits one event, then waits for {@link Gate.open}. */
interface Gate {
  open: () => void;
  started: Promise<void>;
}

function gatedAgent(): { agent: AgentRuntime; gate: Gate } {
  let open!: () => void;
  let markStarted!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const agent = {
    type: 'claude-code',
    ensureSession: vi.fn(),
    sendMessage: async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      markStarted();
      await opened;
    },
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as AgentRuntime;
  return { agent, gate: { open, started } };
}

let store: TaskStore;
let keepAwake: KeepAwakeService;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  keepAwake = new KeepAwakeService();
  await initBoundary('/');
});

afterEach(() => {
  vi.mocked(isRelayEnabled).mockReturnValue(false);
});

function newTask(name: string) {
  return store.createTask({
    name,
    description: 'test',
    prompt: 'test',
    cron: '0 * * * *',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  });
}

describe('a task run holds the computer awake', () => {
  it('a direct run with its turn in flight counts as one task and no chat, then nothing', async () => {
    const { agent, gate } = gatedAgent();
    const wrapped = holdAwakeDuringTurns(agent, keepAwake);
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(wrapped as never),
      config: CONFIG,
      keepAwake,
    });
    const task = newTask('direct');

    const run = await service.triggerManualRun(task.id);
    await gate.started;
    expect(keepAwake.status().working).toEqual({ chats: 0, rooms: 0, tasks: 1, waking: false });

    gate.open();
    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));
    await vi.waitFor(() =>
      expect(keepAwake.status().working).toEqual({ chats: 0, rooms: 0, tasks: 0, waking: false })
    );
    await service.stop();
  });

  it('a relay-dispatched run counts once while the bus runs its turn', async () => {
    // In-process delivery runs the whole turn inside `publish()`, through the
    // registry-wrapped runtime, under the session the envelope names.
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    const { agent } = gatedAgent();
    const wrapped = holdAwakeDuringTurns(agent, keepAwake);
    let duringTurn: unknown = null;
    const relay = {
      publish: vi.fn(async (_subject: string, payload: TaskDispatchPayload) => {
        const stream = wrapped.sendMessage(payload.sessionId!, payload.prompt);
        await stream.next();
        duringTurn = keepAwake.status().working;
        await stream.return(undefined);
        return { messageId: 'msg-1', deliveredTo: 1 };
      }),
    };
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(wrapped as never),
      config: CONFIG,
      relay: relay as unknown as RelayCore,
      keepAwake,
    });
    const task = newTask('relay');

    await (service as unknown as { dispatch(t: unknown, when: Date): Promise<void> }).dispatch(
      task,
      new Date(1_700_000_000_000)
    );

    expect(relay.publish).toHaveBeenCalledOnce();
    expect(duringTurn).toEqual({ chats: 0, rooms: 0, tasks: 1, waking: false });
    expect(keepAwake.status().working).toEqual({ chats: 0, rooms: 0, tasks: 0, waking: false });
    await service.stop();
  });

  it('a run that cannot start still releases its hold', async () => {
    const { agent } = gatedAgent();
    const service = new TaskSchedulerService({
      store,
      runtimes: { ...singleRuntimeSource(agent as never), has: () => false },
      config: CONFIG,
      keepAwake,
    });
    const task = newTask('refused');

    const run = await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('failed'));
    expect(keepAwake.status().working.tasks).toBe(0);
    await service.stop();
  });
});
