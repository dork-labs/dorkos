/**
 * A run's later words are credited to the run (DOR-2717).
 *
 * A run ends when its turn does. Under a warm process the agent may hand the
 * work to a background helper, end that turn, and give the real answer in a
 * turn it starts itself once the helper reports. That later turn reaches the
 * session; these pin that it reaches the run's record too — through the real
 * run-terminal hook and the real runtime-turn projection, with only the runtime
 * faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../task-store.js';
import { createRunTerminalListener } from '../../run-terminal-broadcaster.js';
import { subscribeRuntimeTurns } from '../../../session/runtime-turns/runtime-turn.js';
import { resetLateTurnFollowers } from '../../../session/runtime-turns/late-turns.js';
import { resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import { eventFanOut } from '../../../core/event-fan-out.js';

vi.mock('../../../notifications/emitters/run-completed.js', () => ({
  notifyRunCompleted: vi.fn().mockResolvedValue(undefined),
}));

/** Let microtasks and the detached projection settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** One finished turn's events, as a runtime hands them over. */
async function* turnSaying(text: string, sessionId: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text } } as StreamEvent;
  yield { type: 'done', data: { sessionId } } as StreamEvent;
}

let counter = 0;

describe('a run whose agent reports back after its turn ended', () => {
  let store: TaskStore;
  let runtime: FakeAgentRuntime;
  let sessionId: string;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    resetMessageDispatcher();
    counter += 1;
    sessionId = `late-run-session-${counter}`;
    store = new TaskStore(createTestDb());
    runtime = new FakeAgentRuntime();
    getOrCreateProjector(sessionId);
    unsubscribe = subscribeRuntimeTurns(runtime);
    store.setOnRunTerminal(
      createRunTerminalListener(null, {
        store,
        runtimeFor: (type) => (type === 'claude-code' ? runtime : undefined),
      })
    );
  });

  afterEach(() => {
    unsubscribe?.();
    resetLateTurnFollowers();
    resetMessageDispatcher();
  });

  /** Create a run and finish it the way both dispatch paths do. */
  function finishRun(status: 'completed' | 'cancelled' = 'completed'): string {
    const task = store.createTask({
      name: `late-${counter}`,
      description: 'test',
      prompt: 'check the build',
      filePath: `/tmp/tasks/late-${counter}/SKILL.md`,
    });
    const run = store.createRun(task.id, 'scheduled');
    store.recordRunExecution(run.id, { runtime: 'claude-code' });
    store.updateRun(run.id, {
      status,
      finishedAt: new Date().toISOString(),
      outputSummary: 'Started a helper on it; I will report back.',
      sessionId,
    });
    return run.id;
  }

  it('adds what the agent said later to the run it belongs to', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun();
    await flush();

    runtime.holdsBackgroundWork.mockReturnValue(false);
    runtime.emitRuntimeTurn(sessionId, turnSaying('The build is green.', sessionId));
    await flush();

    const output = store.getRun(runId)?.outputSummary ?? '';
    expect(output).toContain('Started a helper on it');
    expect(output).toContain('The build is green.');
    // The outcome the run settled to is not rewritten by a later turn.
    expect(store.getRun(runId)?.status).toBe('completed');
  });

  it('keeps following while the agent still holds work, and stops when it holds none', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun();
    await flush();

    runtime.emitRuntimeTurn(sessionId, turnSaying('Half done.', sessionId));
    await flush();
    runtime.holdsBackgroundWork.mockReturnValue(false);
    runtime.emitRuntimeTurn(sessionId, turnSaying('All done.', sessionId));
    await flush();
    runtime.emitRuntimeTurn(sessionId, turnSaying('Unrelated chatter.', sessionId));
    await flush();

    const output = store.getRun(runId)?.outputSummary ?? '';
    expect(output).toContain('Half done.');
    expect(output).toContain('All done.');
    expect(output).not.toContain('Unrelated chatter.');
  });

  it('credits nothing when the agent held no work at the end of its turn', async () => {
    const runId = finishRun();
    await flush();

    runtime.emitRuntimeTurn(sessionId, turnSaying('Something else entirely.', sessionId));
    await flush();

    expect(store.getRun(runId)?.outputSummary).toBe('Started a helper on it; I will report back.');
  });

  it('credits nothing to a run somebody cancelled', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun('cancelled');
    await flush();

    runtime.emitRuntimeTurn(sessionId, turnSaying('The build is green.', sessionId));
    await flush();

    expect(store.getRun(runId)?.outputSummary).not.toContain('The build is green.');
  });

  it('credits nothing said after somebody else gave the session new work', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun();
    await flush();

    // A person opens the run's conversation and asks something of their own.
    for await (const _event of runtime.sendMessage(sessionId, 'a question of my own')) {
      // drained
    }
    runtime.emitRuntimeTurn(sessionId, turnSaying('My answer to that person.', sessionId));
    await flush();

    expect(store.getRun(runId)?.outputSummary).not.toContain('My answer to that person.');
  });

  it('tells open apps the run changed, so its list re-reads', async () => {
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun();
    await flush();
    broadcast.mockClear();

    runtime.holdsBackgroundWork.mockReturnValue(false);
    runtime.emitRuntimeTurn(sessionId, turnSaying('The build is green.', sessionId));
    await flush();

    expect(broadcast).toHaveBeenCalledWith('task_run_updated', expect.objectContaining({ runId }));
    broadcast.mockRestore();
  });

  it('keeps no more than a bounded amount of later output, however much the agent says', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const runId = finishRun();
    await flush();
    const settled = store.getRun(runId)!.outputSummary!.length;

    for (let i = 0; i < 5; i += 1) {
      runtime.emitRuntimeTurn(sessionId, turnSaying('x'.repeat(800), sessionId));
      await flush();
    }

    const output = store.getRun(runId)!.outputSummary!;
    // Separators included: the bound is on everything added after the summary.
    expect(output.length - settled).toBe(1000);
    expect(output).toContain('Reported later: x');
  });
});
