/**
 * A scheduled run whose account may not work in the folder the run starts in
 * fails with the plain sentence before either dispatch path starts anything
 * (spec `flow-multiproject` §8.4, the schedule "run" row): no turn on the
 * direct path, nothing published on the bus.
 *
 * The rules live in a stand-in config, and every folder is one project
 * (`/work/project`), so the rules alone decide.
 *
 * @module services/tasks/__tests__/scheduler-account-eligibility
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));

vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? { claudeCode: rules.claudeCode } : undefined),
  },
}));
vi.mock('../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async () => ({ root: '/work/project', name: 'project' })),
}));
vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));
vi.mock('../../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtimes/claude-code/claude-config-dir.js')>()),
  isRegisteredClaudeAccount: vi.fn(() => undefined),
}));

import { createTestDb } from '@dorkos/test-utils/db';
import type { RelayCore } from '@dorkos/relay';
import type { TaskRun } from '@dorkos/shared/types';
import { initBoundary } from '../../../lib/boundary.js';
import { isRelayEnabled } from '../../relay/relay-state.js';
import {
  TaskSchedulerService,
  type SchedulerAgentManager,
  type SchedulerRuntimes,
} from '../task-scheduler-service.js';
import { isTerminalRunStatus, TaskStore, type CreateTaskStoreInput } from '../task-store.js';

const SENTENCE =
  "Client Work can't be used in project. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes.";

const CONFIG = { maxConcurrentRuns: 1, retentionCount: 100, mayFire: true, firingReason: 'test' };

let store: TaskStore;
let agent: SchedulerAgentManager;

function taskInput(overrides: Partial<CreateTaskStoreInput> & { name: string }) {
  return {
    description: 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  } as CreateTaskStoreInput;
}

function scheduler(relay: RelayCore | null = null): TaskSchedulerService {
  const runtimes: SchedulerRuntimes = {
    has: (type) => type === 'claude-code',
    getDefaultType: () => 'claude-code',
    getAllCapabilities: () => ({}),
    get: () => agent,
  };
  return new TaskSchedulerService({ store, runtimes, config: { ...CONFIG }, relay });
}

async function runToCompletion(service: TaskSchedulerService, taskId: string): Promise<TaskRun> {
  const run = await service.triggerManualRun(taskId);
  await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));
  return store.getRun(run!.id)!;
}

beforeEach(async () => {
  rules.claudeCode = {
    accounts: [
      { id: 'work', path: '/accounts/work', label: 'Work', onlyProjects: null },
      {
        id: 'client',
        path: '/accounts/client',
        label: 'Client Work',
        onlyProjects: ['/clients/client-app'],
      },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
  store = new TaskStore(createTestDb());
  agent = {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as SchedulerAgentManager;
  await initBoundary('/');
});

afterEach(() => {
  vi.mocked(isRelayEnabled).mockReturnValue(false);
  store.close();
});

describe('a run on an account that may not work where it starts', () => {
  it('fails with the sentence and starts no turn (direct path)', async () => {
    const task = store.createTask(taskInput({ name: 'Client sweep', account: 'client' }));
    const service = scheduler();

    const run = await runToCompletion(service, task.id);

    expect(run.status).toBe('failed');
    expect(run.error).toBe(SENTENCE);
    expect(agent.ensureSession).not.toHaveBeenCalled();
    expect(agent.sendMessage).not.toHaveBeenCalled();
    await service.stop();
  });

  it('runs on an account that may work there (control)', async () => {
    const task = store.createTask(taskInput({ name: 'Work sweep', account: 'work' }));
    const service = scheduler();

    const run = await runToCompletion(service, task.id);

    expect(run.status).not.toBe('failed');
    expect(agent.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ accountHint: 'work' })
    );
    await service.stop();
  });

  it('fails a scheduled bus run the same way, publishing nothing', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    const relay = { publish: vi.fn().mockResolvedValue({ messageId: 'm-1', deliveredTo: 1 }) };
    const task = store.createTask(
      taskInput({ name: 'Bus sweep', runtime: 'claude-code', account: 'client' })
    );
    const service = scheduler(relay as unknown as RelayCore);

    await (
      service as unknown as { dispatch(t: typeof task, when?: Date | null): Promise<void> }
    ).dispatch(task, new Date(1_700_000_000_000));

    await vi.waitFor(() => {
      const [run] = store.listRuns({ taskId: task.id });
      expect(run?.status).toBe('failed');
    });
    const [run] = store.listRuns({ taskId: task.id });
    expect(run!.error).toBe(SENTENCE);
    expect(relay.publish).not.toHaveBeenCalled();
    expect(agent.sendMessage).not.toHaveBeenCalled();
    await service.stop();
  });
});
