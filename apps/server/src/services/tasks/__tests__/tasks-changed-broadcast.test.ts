/**
 * Every writer that can change what the unattended-autonomy banner says, or
 * what the Tasks list shows, must say so on the global stream.
 *
 * ## Why this file exists
 *
 * `tasks_changed` has two readers with two different questions, and both
 * freshness contracts were undertested on the server half. The client halves —
 * "invalidate when `tasks_changed` arrives" — are pinned in
 * `entities/unattended-autonomy` and `entities/tasks`, but they MOCK the
 * subscription, so neither proves anyone emits the event. And
 * `eventFanOut.broadcast` is stringly-typed, so deleting every
 * `broadcastTasksChanged()` call in the repo left every other test green: the
 * banner would simply stop appearing when somebody dialled a task up to Full
 * autonomy, the Tasks list would simply stop updating when a schedule
 * appeared, and no test would notice either.
 *
 * So each writer gets its own case, and each case fails when its own call is
 * removed.
 *
 * ## Which writers, and why these six
 *
 * The unattended-autonomy banner's answer depends on a task's
 * `permissionMode`, `enabled` and `status`:
 *
 * - The three cockpit routes (`POST`, `PATCH`, `DELETE /api/tasks`) can change
 *   all three, `permissionMode` included — they are the only path an operator
 *   has to the autonomy stop.
 * - MCP `tasks_update` and `tasks_delete` are refused `permissionMode` by
 *   `task-write-policy`, but NOT `enabled`: an agent can re-enable a task a
 *   person had already granted bypass to, at act tier, with no approval card.
 *   That is the most important of the six to signal for the banner's sake.
 *
 * MCP `tasks_create` cannot move the banner's answer — it forces
 * `pending_approval` and is refused `permissionMode`, so nothing it produces
 * is a live autonomy driver. It broadcasts anyway (DOR-1380), because the
 * Tasks list is the other reader of this same event: an agent's proposed
 * schedule sat invisible until the next full reload, with no signal anywhere
 * that it was waiting on a person. A broadcast the banner's own computation
 * ignores is not noise once a second reader depends on it.
 *
 * The two writers that CANNOT broadcast — `upsertFromFile` and the reconciler —
 * are named honestly in the collector's module doc, along with the 60-second
 * staleness that covers them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

const broadcast = vi.fn();
/**
 * The data directory this suite mounts its router on, and the prefix its
 * `fs.readFile` mock treats as "a file the route just wrote".
 *
 * One constant because the two MUST agree. The mock answers a path under this
 * prefix with empty content and every other path with ENOENT, and the update
 * route reads those as two different worlds — "a file that is there" versus
 * "a legacy row with no file" (DOR-1481). If the prefix and the `dorkHome`
 * argument ever drifted apart, fixtures would quietly cross into the other
 * branch and the tests would still pass, for the wrong reason.
 *
 * `vi.hoisted` because the `vi.mock` factories below are hoisted above ordinary
 * module scope and could not otherwise see it.
 */
const DORK_HOME = vi.hoisted(() => '/tmp/dork-test');

vi.mock('../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: (...args: unknown[]) => broadcast(...args) },
}));

vi.mock('../../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

vi.mock('@dorkos/skills/writer', () => ({
  writeSkillFile: vi.fn().mockResolvedValue(`${DORK_HOME}/tasks/test/SKILL.md`),
  deleteSkillDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dorkos/skills/parser', () => ({
  parseSkillFile: vi.fn().mockReturnValue({ ok: false, errors: ['mocked'] }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      // A path the POST path just "wrote" reads back empty; every other path is
      // a row fixture with no file behind it, and the honest answer for those is
      // ENOENT. The update route now tells that apart from a file it cannot read
      // or parse, and only ENOENT means "legacy DB-only task, edit the row alone"
      // (DOR-1481) — so a blanket empty read would make every fixture here look
      // like a file whose contents are unparseable garbage.
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.startsWith(`${DORK_HOME}/`)) return '';
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
          code: 'ENOENT',
        });
      }),
    },
  };
});

import { createTasksRouter } from '../../../routes/tasks.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import type { TaskSchedulerService } from '../task-scheduler-service.js';
import { getTasksTools } from '../../runtimes/claude-code/mcp-tools/task-tools.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { ActivityService } from '../../activity/activity-service.js';
import { activityEvents } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';

/** The `tool()` shape, narrowed to what this file drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/** Whether `tasks_changed` was broadcast — by name, which is the thing that rots. */
function broadcastTasksChangedCount(): number {
  return broadcast.mock.calls.filter((call) => call[0] === 'tasks_changed').length;
}

/**
 * `ActivityService.emit()` is fire-and-forget (by design — callers must never
 * block on it), so its write lands after the handler's own promise settles.
 * One event-loop turn is enough to let it land before a test reads the table.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createMockScheduler(): TaskSchedulerService {
  return {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockReturnValue(false),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('a task write tells the world it happened', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let activityService: ActivityService;
  let tools: Record<string, SessionTool>;
  let existing: Task;

  beforeEach(() => {
    broadcast.mockClear();
    db = createTestDb();
    store = new TaskStore(db);
    activityService = new ActivityService(db);
    const scheduler = createMockScheduler();
    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(
        store,
        scheduler,
        new TaskRegistrar({ store, scheduler }),
        DORK_HOME,
        undefined,
        activityService
      )
    );

    const deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      // The MCP create writes a real SKILL.md now (DOR-1568), and `fs` is mocked
      // in this suite, so the path only has to be the one the mock recognises.
      dorkHome: DORK_HOME,
      activityService,
    } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );

    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
  });

  afterEach(() => {
    store.close();
  });

  it('POST /api/tasks broadcasts tasks_changed', async () => {
    const res = await request(app).post('/api/tasks').send({
      name: 'New',
      description: 'do stuff',
      prompt: 'do stuff',
      cron: '0 2 * * *',
      target: 'global',
    });

    expect(res.status).toBe(201);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('PATCH /api/tasks/:id broadcasts tasks_changed', async () => {
    const res = await request(app).patch(`/api/tasks/${existing.id}`).send({ enabled: false });

    expect(res.status).toBe(200);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('DELETE /api/tasks/:id broadcasts tasks_changed', async () => {
    const res = await request(app).delete(`/api/tasks/${existing.id}`);

    expect(res.status).toBe(200);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('MCP tasks_update broadcasts tasks_changed — the agent-reachable path', async () => {
    // `enabled` is NOT operator-only, so this is an agent switching a task the
    // person already granted bypass to back on. If any writer had to signal,
    // it is this one.
    const result = await tools['tasks_update']!.handler(
      { id: existing.id, enabled: true },
      undefined
    );

    expect(result.isError).not.toBe(true);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('MCP tasks_delete broadcasts tasks_changed', async () => {
    const result = await tools['tasks_delete']!.handler({ id: existing.id }, undefined);

    expect(result.isError).not.toBe(true);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('MCP tasks_create broadcasts tasks_changed too (DOR-1380)', async () => {
    // Reverses the earlier "deliberately absent" call: the Tasks list needs
    // this signal even though the autonomy banner never will.
    const result = await tools['tasks_create']!.handler(
      {
        name: 'agent-proposed',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        target: 'global',
        reason: 'The nightly sweep keeps the backlog honest.',
      },
      undefined
    );

    expect(result.isError).not.toBe(true);
    expect(broadcastTasksChangedCount()).toBe(1);
  });

  it('MCP tasks_create writes an activity event with the parked status attached', async () => {
    const result = await tools['tasks_create']!.handler(
      {
        name: 'agent-proposed',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        target: 'global',
        reason: 'The nightly sweep keeps the backlog honest.',
      },
      undefined
    );
    expect(result.isError).not.toBe(true);
    await flush();

    const rows = db.select().from(activityEvents).all();
    const created = rows.find((r) => r.eventType === 'tasks.task_created');
    expect(created).toBeDefined();
    expect(created!.actorType).toBe('agent');
    expect(created!.category).toBe('tasks');
    expect(JSON.parse(created!.metadata!) as Record<string, unknown>).toEqual({
      status: 'pending_approval',
    });

    // The REST route's own creation of a TRUSTED (immediately active) task
    // writes the same eventType with no status in its metadata — this is
    // the distinguishing signal a consumer needs to tell the two apart
    // without a second lookup.
    const restRes = await request(app).post('/api/tasks').send({
      name: 'Operator created',
      description: 'do stuff',
      prompt: 'do stuff',
      cron: '0 2 * * *',
      target: 'global',
    });
    expect(restRes.status).toBe(201);
    await flush();
    const restEvent = db
      .select()
      .from(activityEvents)
      .all()
      .find((r) => r.eventType === 'tasks.task_created' && r.resourceId === restRes.body.id);
    expect(restEvent).toBeDefined();
    expect(restEvent!.actorType).toBe('user');
    expect(restEvent!.metadata).toBeNull();
  });

  it('stays quiet when the write did not happen', async () => {
    // A 404 changes nothing, so it must announce nothing — otherwise every
    // assertion above would pass against a broadcast fired unconditionally at
    // the top of each handler.
    const res = await request(app).patch('/api/tasks/nope').send({ enabled: false });
    const mcp = await tools['tasks_delete']!.handler({ id: 'nope' }, undefined);

    expect(res.status).toBe(404);
    expect(mcp.isError).toBe(true);
    expect(broadcastTasksChangedCount()).toBe(0);
  });
});
