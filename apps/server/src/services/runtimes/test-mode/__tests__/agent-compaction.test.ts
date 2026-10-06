/**
 * RT-CMP-02 on test-mode (DOR-2732): the agent asks for its own conversation to
 * be summarized, the runtime's real compaction runs, and the boundary says the
 * agent asked — live, in the durable record, and in history rebuilt after the
 * projector is gone (the restart case for a log-backed runtime).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { SessionEventStore, setSessionEventStore } from '../../../session/index.js';
import { resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import { AgentCompactionService } from '../../../session/agent-compaction/agent-compaction-service.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CWD = '/projects/test';

afterEach(() => {
  resetMessageDispatcher();
  disposeProjector(SESSION);
  setSessionEventStore(undefined);
});

describe('test-mode — agent-requested compaction', () => {
  it('RT-CMP-02: summarizes on the agent’s request and the chat keeps that the agent asked', async () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const runtime = new TestModeRuntime();
    runtime.ensureSession(SESSION, { cwd: CWD, permissionMode: 'default' });
    getOrCreateProjector(SESSION, CWD).seedStatus({
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

    // No turn is open, so the summary starts at the next free moment: now.
    const projector = getOrCreateProjector(SESSION, CWD);
    await expect
      .poll(() => projector.replayFrom(0).some((event) => event.type === 'turn_end'))
      .toBe(true);
    expect(
      projector.replayFrom(0).find((event) => event.type === 'compact_boundary')
    ).toMatchObject({ requestedBy: 'agent', contextPercent: 90, preTokens: 51_226 });

    // Gone from memory, as after a restart: history is rebuilt from the record.
    disposeProjector(SESSION);
    const history = await runtime.getMessageHistory(CWD, SESSION);
    const row = history.find((message) => message.messageType === 'compaction');
    expect(row?.compactMetadata).toMatchObject({ requestedBy: 'agent', contextPercent: 90 });
  });
});
