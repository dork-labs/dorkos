/**
 * The app's task reads on the capability mount (DOR-4978): what each reader may
 * see. An agent reads only its own schedules' runs and global ones', as
 * `tasks_get_run_history` answers in a chat; a pending schedule's folder rules
 * go only to a caller that clears the agent bar.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { MeshCore } from '@dorkos/mesh';
import type { TaskRun } from '@dorkos/shared/schemas';
import { noopLogger } from '@dorkos/shared/logger';
import type {
  CapabilityHandlerContext,
  CapabilityRequestFacts,
} from '../../../core/capabilities/index.js';
import {
  setTaskViewReader,
  taskViewDomain,
  type TaskViewReader,
} from '../task-view-capabilities.js';

import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { taskViewReader } from '../../../../routes/task-view-reader.js';
import { initConfigManager } from '../../../core/config-manager.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { TaskStore } from '../../task-store.js';
import type { TaskRegistrar } from '../../task-registrar.js';
import type { TaskSchedulerService } from '../../task-scheduler-service.js';

const SCOUT_HOME = '/agents/scout';

/** A run of one schedule, with a summary. */
function run(id: string, scheduleId: string): TaskRun {
  return {
    id,
    scheduleId,
    status: 'completed',
    startedAt: '2026-11-25T00:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    outputSummary: `what ${id} wrote`,
    error: null,
    sessionId: `chat-${id}`,
    trigger: 'scheduled',
  } as TaskRun;
}

/** Scout's schedule, Atlas's schedule and a global one, one run each. */
function fakeReader(): TaskViewReader & { listRuns: ReturnType<typeof vi.fn> } {
  const runs = [run('r-scout', 's-scout'), run('r-atlas', 's-atlas'), run('r-global', 's-global')];
  return {
    listTasks: vi.fn(async () => []),
    scheduleOwners: () =>
      new Map([
        ['s-scout', 'scout'],
        ['s-atlas', 'atlas'],
        ['s-global', null],
      ]),
    listRuns: vi.fn((filter: { taskId?: string; taskIds?: readonly string[] }) =>
      runs.filter(
        (r) =>
          (filter.taskId === undefined || r.scheduleId === filter.taskId) &&
          (filter.taskIds === undefined || filter.taskIds.includes(r.scheduleId))
      )
    ),
    getRun: (id) => runs.find((r) => r.id === id) ?? null,
    agentIdOfHome: (path) => (path === SCOUT_HOME ? 'scout' : undefined),
  };
}

/** Invoke one of the reads' handlers directly, as the registry would after its gate. */
async function call(id: string, input: object, context: CapabilityHandlerContext = {}) {
  const capability = taskViewDomain.capabilities.find((c) => c.id === id)!;
  return capability.invoke({ logger: noopLogger }, capability.input.parse(input), context);
}

const SCOUT: CapabilityHandlerContext = {
  identity: { agentPath: SCOUT_HOME, displayName: 'Scout', createdAt: '2026-11-01' },
} as CapabilityHandlerContext;

afterEach(() => setTaskViewReader(undefined));

describe('tasks.view_runs and tasks.view_run', () => {
  it('give a person every run', async () => {
    setTaskViewReader(fakeReader());
    const runs = (await call('tasks.view_runs', {})) as TaskRun[];
    expect(runs.map((r) => r.id)).toEqual(['r-scout', 'r-atlas', 'r-global']);
  });

  it('give an agent its own schedules’ runs and global ones’, never another agent’s', async () => {
    setTaskViewReader(fakeReader());
    const runs = (await call('tasks.view_runs', {}, SCOUT)) as TaskRun[];
    expect(runs.map((r) => r.id)).toEqual(['r-scout', 'r-global']);
    expect(await call('tasks.view_runs', { scheduleId: 's-atlas' }, SCOUT)).toEqual([]);
    await expect(call('tasks.view_run', { id: 'r-atlas' }, SCOUT)).rejects.toMatchObject({
      payload: { code: 'TASK_RUN_NOT_FOUND', error: 'No run has that id.' },
    });
    expect(await call('tasks.view_run', { id: 'r-global' }, SCOUT)).toMatchObject({
      id: 'r-global',
    });
  });

  it('give an agent DorkOS cannot name only global schedules’ runs', async () => {
    setTaskViewReader(fakeReader());
    const unnamed = { agentIdentityPresented: true } as CapabilityHandlerContext;
    const runs = (await call('tasks.view_runs', {}, unnamed)) as TaskRun[];
    expect(runs.map((r) => r.id)).toEqual(['r-global']);
  });

  it('leave out each summary on a turn whose reads are narrowed', async () => {
    setTaskViewReader(fakeReader());
    const narrowed = { ...SCOUT, narrowedReads: true } as CapabilityHandlerContext;
    const [first] = (await call('tasks.view_runs', {}, narrowed)) as TaskRun[];
    expect(first?.outputSummary).toBeNull();
  });

  it('say Tasks is not running when it is not', async () => {
    await expect(call('tasks.view_runs', {})).rejects.toMatchObject({
      payload: { code: 'TASKS_UNAVAILABLE' },
    });
  });
});

describe('tasks.view_list', () => {
  it('adds folder rules only for a caller that clears the agent bar', async () => {
    const reader = fakeReader();
    setTaskViewReader(reader);
    const facts = (clearsAgentBar: boolean) =>
      ({ request: { clearsAgentBar } as CapabilityRequestFacts }) as CapabilityHandlerContext;
    await call('tasks.view_list', {}, facts(true));
    await call('tasks.view_list', {}, facts(false));
    await call('tasks.view_list', {});
    expect(vi.mocked(reader.listTasks).mock.calls).toEqual([[true], [false], [false]]);
  });
});

describe('GET /api/tasks/runs/{id} over the full /api chain', () => {
  const fixtureTarget = swappableServer();
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dorkos-task-view-'));
    initConfigManager(home);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  beforeEach(() => registerEveryFolderAsHome());
  afterEach(() => {
    clearTestHomes();
    resetAgentIdentityService();
  });

  it('answers an agent token asking for another agent’s run 404, "No run has that id."', async () => {
    const db = createTestDb();
    const store = new TaskStore(db);
    const atlas = store.createTask({
      name: 'atlas-nightly',
      description: 'Atlas',
      prompt: 'p',
      filePath: '/tmp/tasks/atlas-nightly/SKILL.md',
      agentId: 'atlas',
    });
    const atlasRun = store.createRun(atlas.id, 'scheduled');
    const meshCore = {
      listWithPaths: () => [
        { id: 'scout', projectPath: SCOUT_HOME },
        { id: 'atlas', projectPath: '/agents/atlas' },
      ],
    } as unknown as MeshCore;
    setTaskViewReader(
      taskViewReader({
        store,
        scheduler: {} as TaskSchedulerService,
        registrar: {} as TaskRegistrar,
        dorkHome: home,
        defaultTimezone: () => 'UTC',
        meshCore,
      })
    );
    const token = await initAgentIdentityService(db).mint({
      agentPath: SCOUT_HOME,
      displayName: 'Scout',
    });
    const server = fixtureTarget.mount(honoGroupListener(capabilityGroup(taskViewDomain)));

    const asScout = await request(server)
      .get(`/api/tasks/runs/${atlasRun.id}`)
      .set('X-DorkOS-Agent', token);
    expect(asScout.status).toBe(404);
    expect(asScout.body).toMatchObject({ code: 'not_found', detail: 'No run has that id.' });
    // The person still reads it.
    expect((await request(server).get(`/api/tasks/runs/${atlasRun.id}`)).status).toBe(200);
    store.close();
  });
});
