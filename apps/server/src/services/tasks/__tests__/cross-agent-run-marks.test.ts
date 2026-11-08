/**
 * A run of a task another agent made records that agent and starts with its marks, the way a
 * `chat_send` hop carries the sender's (DOR-3938, Security's Must 3). Driven through the real
 * scheduler, so the run row and the turn's send options are the ones production writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import { recordedRunCreator } from '../approvals/cross-agent.js';
import type { MeshCore } from '@dorkos/mesh';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  TaskSchedulerService,
  singleRuntimeSource,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));

const HOME_A = '/home/u/agents/alpha';
const HOME_B = '/home/u/agents/bravo';

function agentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as SchedulerAgentManager;
}

const agents = [
  { id: 'agent-a', name: 'alpha', projectPath: HOME_A },
  { id: 'agent-b', name: 'bravo', projectPath: HOME_B },
];
const mesh = {
  listWithPaths: () => agents,
  getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
  get: (id: string) => agents.find((a) => a.id === id),
} as unknown as MeshCore;

describe('a run of a task another agent made', () => {
  let store: TaskStore;
  let db: Db;
  let manager: SchedulerAgentManager;
  let service: TaskSchedulerService;

  beforeEach(() => {
    registerTestHomes([HOME_A, HOME_B]);
    db = createTestDb();
    store = new TaskStore(db);
    manager = agentManager();
    service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(manager),
      config: { maxConcurrentRuns: 1, retentionCount: 100, mayFire: true, firingReason: 'test' },
      meshCore: mesh,
    });
  });

  afterEach(async () => {
    await service.stop();
    store.close();
    clearTestHomes();
  });

  /** A task filed under B that `proposer` made, with `writer` marks kept as another agent's write. */
  function task(
    proposer: string,
    writer?: Parameters<TaskStore['approvals']['recordCrossAgentWriter']>[1]
  ) {
    const made = store.createTask({
      name: 'b-sweep',
      description: 'b',
      prompt: 'Sweep.',
      agentId: 'agent-b',
      filePath: '/tmp/tasks/b-sweep/SKILL.md',
    });
    store.recordProposal(made.id, {
      reason: 'asked',
      proposedByAgentPath: proposer,
      proposedBySessionId: 'ses-made',
    });
    if (writer) store.approvals.recordCrossAgentWriter(made.id, writer);
    return store.getTask(made.id)!;
  }

  /** The creator a run recorded, read from its row. */
  function creatorOf(id: string) {
    return recordedRunCreator(db.select().from(pulseRuns).where(eq(pulseRuns.id, id)).get());
  }

  async function runNow(id: string) {
    const run = await service.triggerManualRun(id);
    await vi.waitFor(() => expect(vi.mocked(manager.sendMessage)).toHaveBeenCalled());
    return run!;
  }

  it('records the writer on the run and starts the turn with its outsider mark', async () => {
    const made = task(HOME_A, {
      agentPath: HOME_A,
      sessionId: 'ses-made',
      marks: { outsider: true },
    });
    const run = await runNow(made.id);
    const opts = vi.mocked(manager.sendMessage).mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.carriedMarks).toEqual({ outsider: true });
    expect(creatorOf(run.id)).toEqual({
      agentPath: HOME_A,
      sessionId: 'ses-made',
      marks: { outsider: true },
    });
  });

  it('starts the turn with a teammate chain the writer carried', async () => {
    const teammate = [{ roomId: 'room-1', authorId: 'author-1' }];
    const made = task(HOME_A, { agentPath: HOME_A, sessionId: 'ses-made', marks: { teammate } });
    await runNow(made.id);
    const opts = vi.mocked(manager.sendMessage).mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.permissionCeiling).toEqual({ asks: 'never', reach: 'everything', teammate });
    expect(opts.carriedMarks).toBeUndefined();
  });

  it('a task no other agent wrote records its proposer and carries no marks', async () => {
    const run = await runNow(task(HOME_B).id);
    const opts = vi.mocked(manager.sendMessage).mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.carriedMarks).toBeUndefined();
    expect(opts.permissionCeiling).toBeUndefined();
    expect(creatorOf(run.id)).toEqual({ agentPath: HOME_B, sessionId: 'ses-made', marks: {} });
  });
});
