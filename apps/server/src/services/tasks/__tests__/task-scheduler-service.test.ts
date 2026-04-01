import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TaskSchedulerService,
  buildTaskAppend,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

import { isRelayEnabled } from '../../relay/relay-state.js';

function createMockAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {
      // Default: no events (immediate completion)
    }),
  } as SchedulerAgentManager;
}

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  timezone: null,
};

describe('TaskSchedulerService', () => {
  let store: TaskStore;
  let db: Db;
  let mockAgent: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    mockAgent = createMockAgentManager();
  });

  describe('start()', () => {
    it('marks interrupted running runs as failed on startup', async () => {
      // Create a task + "running" run that simulates a crash
      const task = store.createTask(
        taskInput({ name: 'Crash', prompt: 'test', cron: '0 * * * *' })
      );
      store.createRun(task.id, 'scheduled');

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const runs = store.listRuns();
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error).toBe('Interrupted by server restart');

      await service.stop();
    });

    it('registers cron jobs for enabled active tasks', async () => {
      store.createTask(taskInput({ name: 'Active', prompt: 'test', cron: '0 * * * *' }));
      store.createTask(
        taskInput({ name: 'Disabled', prompt: 'test', cron: '0 * * * *', enabled: false })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const tasks = store.getTasks();
      expect(service.isRegistered(tasks[0].id)).toBe(true);
      expect(service.isRegistered(tasks[1].id)).toBe(false);

      await service.stop();
    });

    it('skips tasks with pending_approval status', async () => {
      const task = store.createTask(
        taskInput({ name: 'Pending', prompt: 'test', cron: '0 * * * *' })
      );
      store.updateTask(task.id, { status: 'pending_approval' });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      expect(service.isRegistered(task.id)).toBe(false);

      await service.stop();
    });
  });

  describe('triggerManualRun()', () => {
    it('creates a run with manual trigger', async () => {
      const task = store.createTask(
        taskInput({ name: 'Manual', prompt: 'do stuff', cron: '0 * * * *' })
      );

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'Done!' } };
      });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);

      expect(run).not.toBeNull();
      expect(run!.trigger).toBe('manual');
      expect(run!.status).toBe('running');

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 100));

      await service.stop();
    });

    it('passes systemPromptAppend with task context to sendMessage', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Context Test',
          prompt: 'do stuff',
          cron: '0 * * * *',
        })
      );

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        // no events
      });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.triggerManualRun(task.id);

      // Wait for async execution to complete
      await new Promise((r) => setTimeout(r, 100));

      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();
      const [, , opts] = vi.mocked(mockAgent.sendMessage).mock.calls[0];
      expect(opts?.systemPromptAppend).toBeDefined();
      expect(opts?.systemPromptAppend).toContain('TASK SCHEDULER CONTEXT');
      expect(opts?.systemPromptAppend).toContain('Context Test');

      await service.stop();
    });

    it('returns null for nonexistent task', async () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun('nonexistent');
      expect(run).toBeNull();
      await service.stop();
    });
  });

  describe('cancelRun()', () => {
    it('returns false when run is not active', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.cancelRun('nonexistent')).toBe(false);
    });
  });

  describe('getActiveRunCount()', () => {
    it('returns 0 when no runs are active', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getActiveRunCount()).toBe(0);
    });
  });

  describe('getNextRun()', () => {
    it('returns null for unregistered task', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getNextRun('nonexistent')).toBeNull();
    });

    it('returns a date for registered task', async () => {
      const task = store.createTask(taskInput({ name: 'Next', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const next = service.getNextRun(task.id);
      expect(next).toBeInstanceOf(Date);

      await service.stop();
    });
  });

  describe('registerTask / unregisterTask', () => {
    it('can register and unregister a task', () => {
      const task = store.createTask(taskInput({ name: 'Reg', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerTask(task);
      expect(service.isRegistered(task.id)).toBe(true);

      service.unregisterTask(task.id);
      expect(service.isRegistered(task.id)).toBe(false);
    });

    it('replaces existing cron job on re-register', () => {
      const task = store.createTask(
        taskInput({ name: 'Re-reg', prompt: 'test', cron: '0 * * * *' })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerTask(task);
      service.registerTask(task); // Should not throw
      expect(service.isRegistered(task.id)).toBe(true);
    });
  });

  describe('executeRunViaRelay (via triggerManualRun)', () => {
    let mockRelay: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(true);
      mockRelay = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      };
    });

    afterEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(false);
    });

    it('publishes envelope with correct subject relay.system.tasks.{taskId}', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Relay Test',
          prompt: 'do relay stuff',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRelay.publish).toHaveBeenCalledOnce();
      const [subject] = mockRelay.publish.mock.calls[0];
      expect(subject).toBe(`relay.system.tasks.${task.id}`);

      await service.stop();
    });

    it('publishes TaskDispatchPayload with all expected fields', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Payload Test',
          prompt: 'run this task',
          cron: '30 2 * * *',
          permissionMode: 'acceptEdits',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, payload, options] = mockRelay.publish.mock.calls[0];
      const dispatch = payload as TaskDispatchPayload;

      expect(dispatch.type).toBe('task_dispatch');
      expect(dispatch.taskId).toBe(task.id);
      expect(dispatch.runId).toEqual(expect.any(String));
      expect(dispatch.prompt).toBe('run this task');
      expect(dispatch.cwd).toEqual(expect.any(String));
      expect(dispatch.permissionMode).toBe('acceptEdits');
      expect(dispatch.taskName).toBe('Payload Test');
      expect(dispatch.cron).toBe('30 2 * * *');
      expect(dispatch.trigger).toBe('manual');

      // Verify publish options
      expect(options.from).toBe('relay.system.tasks.scheduler');
      expect(options.replyTo).toBe(`relay.system.tasks.${task.id}.response`);
      expect(options.budget.maxHops).toBe(3);
      expect(options.budget.callBudgetRemaining).toBe(5);

      await service.stop();
    });

    it('marks run as failed when deliveredTo is 0', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-2', deliveredTo: 0 });

      const task = store.createTask(
        taskInput({
          name: 'No Receiver',
          prompt: 'orphan task',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ taskId: task.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('failed');
      expect(updatedRun?.error).toBe('No receiver for task dispatch');

      await service.stop();
    });

    it('marks run as running on successful delivery', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-3', deliveredTo: 2 });

      const task = store.createTask(
        taskInput({
          name: 'Success Delivery',
          prompt: 'delivered task',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ taskId: task.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('running');

      await service.stop();
    });

    it('sets budget TTL based on task.maxRuntime', async () => {
      const task = store.createTask(
        taskInput({
          name: 'TTL Test',
          prompt: 'timed task',
          cron: '0 * * * *',
          maxRuntime: 600_000, // 10 minutes
        })
      );

      const now = Date.now();
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // TTL should be roughly now + 600_000 (10 minutes)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 600_000 + 5000);

      await service.stop();
    });

    it('uses default TTL of 1 hour when maxRuntime is null', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Default TTL',
          prompt: 'no timeout task',
          cron: '0 * * * *',
        })
      );

      const now = Date.now();
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // Default TTL: 3_600_000 (1 hour)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 3_600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 3_600_000 + 5000);

      await service.stop();
    });
  });
});

/** Create a minimal MeshCore mock with getProjectPath. */
function createMockMeshCore(pathMap: Record<string, string | undefined> = {}): MeshCore {
  return {
    getProjectPath: vi.fn((agentId: string) => pathMap[agentId]),
  } as unknown as MeshCore;
}

/** Build a minimal CreateTaskStoreInput for the CWD resolution tests. */
function cwdTaskInput(
  overrides: Partial<import('../task-store.js').CreateTaskStoreInput> & { name: string }
): import('../task-store.js').CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

describe('agent CWD resolution (via triggerManualRun)', () => {
  let store: TaskStore;
  let db: Db;
  let mockAgent: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    mockAgent = createMockAgentManager();
    vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
      // no events
    });
  });

  it('records failed run when agent not found in registry', async () => {
    const task = store.createTask(
      cwdTaskInput({
        name: 'Agent CWD Test',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'missing-agent',
      })
    );

    const mockMesh = createMockMeshCore({});
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: mockMesh,
    });

    const run = await service.triggerManualRun(task.id);
    await new Promise((r) => setTimeout(r, 100));

    const updatedRun = store.getRun(run!.id);
    expect(updatedRun!.status).toBe('failed');
    expect(updatedRun!.error).toContain('not found in registry');

    await service.stop();
  });

  it('uses agent projectPath as CWD when agentId is set', async () => {
    const task = store.createTask(
      cwdTaskInput({
        name: 'Agent CWD Resolve',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'agent-123',
      })
    );

    const mockMesh = createMockMeshCore({ 'agent-123': '/projects/agent-dir' });
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: mockMesh,
    });

    await service.triggerManualRun(task.id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/projects/agent-dir' })
    );
    expect(mockAgent.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'test',
      expect.objectContaining({ cwd: '/projects/agent-dir' })
    );

    await service.stop();
  });

  it('falls back to process.cwd() when no agentId', async () => {
    store.createTask(
      cwdTaskInput({
        name: 'CWD Fallback',
        prompt: 'test',
        cron: '0 * * * *',
      })
    );

    const tasks = store.getTasks();
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: null,
    });

    await service.triggerManualRun(tasks[0].id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() })
    );

    await service.stop();
  });

  it('falls back to process.cwd() when meshCore is null even with agentId', async () => {
    store.createTask(
      cwdTaskInput({
        name: 'No Mesh',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'some-agent',
      })
    );

    const tasks = store.getTasks();
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: null,
    });

    await service.triggerManualRun(tasks[0].id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() })
    );

    await service.stop();
  });
});

describe('buildTaskAppend', () => {
  it('produces system prompt with task info', () => {
    const task: Task = {
      id: 'task-1',
      name: 'Daily Cleanup',
      displayName: null,
      description: 'Clean temp files',
      prompt: 'Clean temp files',
      cron: '0 2 * * *',
      timezone: null,
      agentId: null,
      enabled: true,
      maxRuntime: null,
      permissionMode: 'acceptEdits',
      status: 'active',
      filePath: '/tmp/tasks/daily-cleanup/SKILL.md',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nextRun: null,
    };

    const run: TaskRun = {
      id: 'run-1',
      scheduleId: 'task-1',
      status: 'running',
      startedAt: '2026-01-01T02:00:00Z',
      finishedAt: null,
      durationMs: null,
      outputSummary: null,
      error: null,
      sessionId: null,
      trigger: 'scheduled',
      createdAt: '2026-01-01T02:00:00Z',
    };

    const result = buildTaskAppend(task, run);
    expect(result).toContain('TASK SCHEDULER CONTEXT');
    expect(result).toContain('Daily Cleanup');
    expect(result).toContain('0 2 * * *');
    expect(result).toContain('run-1');
    expect(result).toContain('scheduled');
    expect(result).toContain('unattended');
  });
});
