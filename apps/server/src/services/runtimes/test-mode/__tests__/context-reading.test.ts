/**
 * RT-CMP-03 on test-mode, end to end (DOR-2732): the `context-reading`
 * scenario's reply reaches the session's projector as a reading with a
 * window, crosses the 80% line, and the next turn is owed the agent's note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import {
  noteContextReading,
  resetContextWarnings,
  takeContextWarning,
} from '../../../session/agent-compaction/context-warning.js';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CWD = '/projects/test';

afterEach(() => {
  scenarioStore.reset();
  disposeProjector(SESSION);
  resetContextWarnings();
});

describe('test-mode — how full the conversation is', () => {
  it('RT-CMP-03: the context-reading reply crosses 80% and owes the agent its note', async () => {
    scenarioStore.setDefault('context-reading');
    const runtime = new TestModeRuntime();
    runtime.ensureSession(SESSION, { cwd: CWD, permissionMode: 'default' });
    const projector = getOrCreateProjector(SESSION, CWD);
    await feedProjector(projector, runtime.sendMessage(SESSION, 'hello', { cwd: CWD }), {
      userMessage: 'hello',
    });

    const usage = projector.getStatus().contextUsage;
    expect(usage).toMatchObject({ totalTokens: 170_000, maxTokens: 200_000 });
    noteContextReading(SESSION, usage);
    expect(takeContextWarning(SESSION)).toBe(85);
  });

  it('reports no reading from the default reply, so nothing changes for other scenarios', async () => {
    const runtime = new TestModeRuntime();
    runtime.ensureSession(SESSION, { cwd: CWD, permissionMode: 'default' });
    const events = [];
    for await (const event of runtime.sendMessage(SESSION, 'hello', { cwd: CWD }))
      events.push(event);
    expect(
      events.some(
        (event) =>
          event.type === 'session_status' &&
          (event.data as { contextTokens?: number }).contextTokens !== undefined
      )
    ).toBe(false);
  });
});
