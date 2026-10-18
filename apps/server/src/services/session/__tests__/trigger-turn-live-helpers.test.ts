/**
 * A turn hands the runtime's live helpers to its stream-end sweep (FB-18): a
 * helper the runtime still names keeps running past the reply, and without
 * the runtime's answer every child is swept, as before.
 *
 * @module services/session/__tests__/trigger-turn-live-helpers
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import { triggerTurn, type TriggerTurnDeps } from '../trigger-turn.js';

const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Run one turn that starts a helper and ends, and answer what is still running. */
async function runningAfterTurn(extra: Partial<TriggerTurnDeps> = {}): Promise<string[]> {
  const projector = getOrCreateProjector(SESSION, '/projects/test');
  let ended = false;
  const result = await triggerTurn({
    sessionId: SESSION,
    clientId: 'test-client',
    content: 'start a helper',
    cwd: '/projects/test',
    projector,
    deps: {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: () =>
        (async function* (): AsyncGenerator<StreamEvent> {
          try {
            yield { type: 'background_task_started', data: { taskId: 'helper-1' } };
            yield { type: 'done', data: { sessionId: SESSION } };
          } finally {
            ended = true;
          }
        })(),
      interruptQuery: async () => ({ outcome: 'not-running', runtime: 'fake' }),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as never,
      ...extra,
    },
  });
  expect(result.accepted).toBe(true);
  await vi.waitFor(() => expect(ended).toBe(true));
  // The sweep runs in the turn's `finally`, just after the stream ends.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return projector.listRunningSubagents();
}

afterEach(() => {
  disposeProjector(SESSION);
});

describe('a turn whose helper outlives the reply', () => {
  it('keeps the helper the runtime still names as running', async () => {
    const asked: string[] = [];
    const running = await runningAfterTurn({
      liveHelperIds: (sid) => {
        asked.push(sid);
        return ['helper-1'];
      },
    });

    expect(running).toEqual(['helper-1']);
    expect(asked).toContain(SESSION);
  });

  it('sweeps it when the runtime cannot say what is still running', async () => {
    expect(await runningAfterTurn()).toEqual([]);
  });
});
