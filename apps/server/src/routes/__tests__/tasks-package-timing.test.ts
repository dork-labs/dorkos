/**
 * `PATCH /api/tasks/:id` on a package's schedule: a new timing lands, and who
 * asked decides what happens to the approval (DOR-2302).
 *
 * Real filesystem, real skills parser, real store and registrar, a mocked
 * scheduler: the file is the package's, so the assertions that matter are
 * that it is never written, that the scheduler is handed the timing that runs,
 * and that the next sync of the unchanged file agrees with what the route left.
 *
 * @module routes/__tests__/tasks-package-timing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import type { Task } from '@dorkos/shared/types';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { AGENT_TIMING_CHANGE_REASON } from '../../services/tasks/timing/effective-timing.js';
import { raiseStanding } from '../../services/notifications/standing-events.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

vi.mock('../../services/notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));

const fixtureTarget = swappableServer();

const SKILL = [
  '---',
  'name: drain',
  'description: A packaged schedule',
  'schedule:',
  "  cron: '0 9 * * *'",
  '---',
  'Drain the queue.',
].join('\n');

describe('PATCH /api/tasks/:id — a package’s schedule’s timing', () => {
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let dorkHome: string;
  let filePath: string;

  /** Sync the file the way the watcher and the reconciler do. */
  async function resync(): Promise<Task> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    return store.upsertFromFile(
      {
        ...parsed.definition,
        meta: parsed.definition.meta,
        scope: 'global',
        projectPath: undefined,
      },
      undefined,
      { source: 'discovery', packageOwned: true }
    );
  }

  beforeEach(async () => {
    vi.mocked(raiseStanding).mockClear();
    scheduler = {
      isStarted: true,
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue(['2026-10-01T09:00:00.000Z']),
    } as unknown as TaskSchedulerService;
    store = new TaskStore(createTestDb());
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-pkg-timing-')));
    // A global plugin install: location alone makes it the package's.
    const dir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'drain');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), dorkHome)
    );
    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** The schedule, discovered and approved by a person. */
  async function approvedTask(): Promise<Task> {
    const found = await resync();
    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${found.id}`)
      .send({ status: 'active', enabled: true });
    expect(res.status).toBe(200);
    return res.body as Task;
  }

  it('takes a person’s new timing, keeps it approved, and runs it', async () => {
    // Purpose: the ticket — this answered 409. And the approval has to move with
    // the timing, or the next sync parks the schedule the person just edited.
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ cron: '30 7 * * 1-5', timezone: 'Europe/Berlin' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cron: '30 7 * * 1-5',
      timezone: 'Europe/Berlin',
      defaultCron: '0 9 * * *',
      defaultTimezone: 'UTC',
      timingOverridden: true,
      status: 'active',
    });
    expect(await fs.readFile(filePath, 'utf-8')).toBe(SKILL);
    // The scheduler is handed the timing that runs.
    expect(vi.mocked(scheduler.registerTask)).toHaveBeenLastCalledWith(
      expect.objectContaining({ cron: '30 7 * * 1-5', timezone: 'Europe/Berlin' })
    );
    expect((await resync()).status).toBe('active');
  });

  it('parks the schedule at once when an agent changes its timing, in DorkOS’s words', async () => {
    // Purpose: no file write means no watcher; without the park the agent's
    // timing would run on an approved schedule until the next sweep.
    const task = await approvedTask();
    vi.mocked(scheduler.unregisterTask).mockClear();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ cron: '* * * * *', reason: 'the agent’s own words' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cron: '* * * * *',
      status: 'pending_approval',
      reason: AGENT_TIMING_CHANGE_REASON,
      reasonSource: 'dorkos',
    });
    expect(vi.mocked(scheduler.unregisterTask)).toHaveBeenCalledWith(task.id);
    // The standing condition — the Inbox row and its escalation — starts here.
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledWith(
      'schedule.parked',
      expect.objectContaining({ taskId: task.id })
    );
    // The parked preview reads the timing that would run.
    expect(vi.mocked(scheduler.previewNextRuns)).toHaveBeenLastCalledWith('* * * * *', 'UTC', 3);
  });

  it('lets an agent retime a full-power package schedule, parking it rather than refusing', async () => {
    // Purpose: the route clamps a non-trusted edit to the approved work; on a
    // package's schedule that clamp must not become a permission change the
    // package's file refuses with a 409 about approval levels.
    const task = await approvedTask();
    store.updateTask(task.id, { permissionMode: 'bypassPermissions' });

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ cron: '*/5 * * * *' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cron: '*/5 * * * *', status: 'pending_approval' });
    expect(await fs.readFile(filePath, 'utf-8')).toBe(SKILL);
  });

  it('parks the schedule when an agent changes only its timezone (DOR-2307)', async () => {
    // Purpose: a timezone moves the real run time; an agent must not move it
    // on an approved schedule without a person seeing it.
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ timezone: 'Pacific/Kiritimati' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timezone: 'Pacific/Kiritimati', status: 'pending_approval' });
  });

  it('keeps a person’s own timezone change approved', async () => {
    // Purpose: the person changing it is the approval, as with the cron.
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ timezone: 'Asia/Tokyo' });

    expect(res.body).toMatchObject({ timezone: 'Asia/Tokyo', status: 'active' });
    expect((await resync()).status).toBe('active');
  });

  it('puts the package’s timing back on a reset, still approved', async () => {
    // Purpose: the Schedules page's "Reset to the package's default".
    const task = await approvedTask();
    await request(fixtureTarget.server).patch(`/api/tasks/${task.id}`).send({ cron: '30 7 * * *' });

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ resetTiming: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cron: '0 9 * * *',
      timingOverridden: false,
      status: 'active',
    });
    expect((await resync()).status).toBe('active');
  });

  it('refuses a reset sent with a new timing, and changes nothing', async () => {
    // Purpose: two different timings in one request; picking one silently is a
    // change the caller did not ask for.
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ resetTiming: true, cron: '30 7 * * *' });

    expect(res.status).toBe(400);
    expect(store.getTask(task.id)).toMatchObject({ cron: '0 9 * * *', timingOverridden: false });
  });
});
