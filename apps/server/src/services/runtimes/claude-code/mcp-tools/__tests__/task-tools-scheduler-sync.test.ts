/**
 * The `tasks_*` MCP tools keep the RUNNING cron jobs in step, not just the rows
 * (DOR-1493).
 *
 * A row is not a running job. Until this landed, an agent could change a
 * schedule's cron through `tasks_update`, be told it worked, and watch the task
 * go on firing at the old time until the next server restart; and `tasks_delete`
 * left a job firing against a row that no longer existed.
 *
 * The tasks here have a `filePath` pointing at a file that does not exist, which
 * is the legacy DB-only case: these handlers write the SKILL.md too since
 * DOR-1625, and the point of this suite is the SCHEDULER, so the file half is
 * deliberately out of the frame. `task-tools-update-file.test.ts` owns it.
 *
 * Driven through `getTasksTools`, the array a real session is handed, and against
 * a real {@link TaskRegistrar} over a stand-in scheduler that records what it was
 * asked to do — the registrar's own decision (register vs unregister) is part of
 * what is being tested.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-scheduler-sync
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore } from '../../../../tasks/task-store.js';
import {
  TaskRegistrar,
  type SchedulerRegistrationTarget,
} from '../../../../tasks/task-registrar.js';
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../task-tools.js';

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/** A scheduler that only records what the registrar asked of it. */
function recordingScheduler(): SchedulerRegistrationTarget & {
  registered: Task[];
  unregistered: string[];
} {
  const registered: Task[] = [];
  const unregistered: string[] = [];
  return {
    isStarted: true,
    registered,
    unregistered,
    registerTask(task: Task) {
      registered.push(task);
      return true;
    },
    unregisterTask(id: string) {
      unregistered.push(id);
    },
  };
}

describe('tasks_* tools sync the scheduler (DOR-1493)', () => {
  let db: Db;
  let store: TaskStore;
  let scheduler: ReturnType<typeof recordingScheduler>;
  let tools: Record<string, SessionTool>;
  let taskId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = recordingScheduler();
    const registrar = new TaskRegistrar({ store, scheduler });
    const deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      resolveTaskRegistrar: () => registrar,
    } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );

    const task = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'sweep the logs',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    taskId = task.id;
  });

  afterEach(() => {
    store.close();
  });

  it('an edited cron reaches the scheduler, not only the row', async () => {
    await tools.tasks_update!.handler({ id: taskId, cron: '0 5 * * *' }, {});

    expect(store.getTask(taskId)!.cron).toBe('0 5 * * *');
    expect(scheduler.registered.map((t) => t.cron)).toEqual(['0 5 * * *']);
  });

  it('disabling a task takes its job off the clock', async () => {
    await tools.tasks_update!.handler({ id: taskId, enabled: false }, {});

    expect(scheduler.unregistered).toEqual([taskId]);
    expect(scheduler.registered).toEqual([]);
  });

  it('a deleted task stops firing', async () => {
    await tools.tasks_delete!.handler({ id: taskId }, {});

    expect(store.getTask(taskId)).toBeNull();
    expect(scheduler.unregistered).toEqual([taskId]);
  });

  it('works when no scheduler exists yet, rather than throwing', async () => {
    // The tools are built during boot, before the scheduler is; and Tasks can be
    // enabled with no scheduler at all in some deployments. Neither is a reason
    // for an edit to fail.
    const bare = { taskStore: store, defaultCwd: '/tmp/test' } as unknown as McpToolDeps;
    const bareTools = Object.fromEntries(
      (getTasksTools(bare) as unknown as SessionTool[]).map((t) => [t.name, t])
    );

    const result = await bareTools.tasks_update!.handler({ id: taskId, cron: '0 6 * * *' }, {});

    expect(result.isError).toBeFalsy();
    expect(store.getTask(taskId)!.cron).toBe('0 6 * * *');
  });
});
