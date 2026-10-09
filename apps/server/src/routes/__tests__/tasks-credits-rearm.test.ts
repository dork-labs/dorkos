/**
 * An edit to a live schedule on DorkOS credits keeps it approved only for the
 * owner of this DorkOS (DOR-2678). A person's edit normally re-arms their own
 * schedule; with login on, another signed-in account's edit parks it for the
 * owner instead, the way an agent's does, and switching it back on is refused.
 *
 * Real filesystem, real store and registrar, a mocked scheduler, as in
 * `tasks-agent-edit-park.test.ts`.
 *
 * @module routes/__tests__/tasks-credits-rearm
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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

const posture = vi.hoisted(() => ({ loginOn: false }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: posture.loginOn } : undefined),
  },
}));
vi.mock('../../services/notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));
// Legacy-key startup migration is outside this owner-bar fixture. Keep its
// config-write import from loading the owner predicate before the account mock.
vi.mock('../../services/core/auth/seed-legacy-mcp-key.js', () => ({
  seedLegacyMcpApiKey: vi.fn(async () => undefined),
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner', name: 'Owner' }),
}));

const target = swappableServer();

const SKILL = [
  '---',
  'name: drain',
  'description: A schedule on DorkOS credits',
  'schedule:',
  "  cron: '0 9 * * *'",
  '---',
  'Drain the queue.',
].join('\n');

describe('PATCH /api/tasks/:id — a live schedule on DorkOS credits (DOR-2678)', () => {
  let store: TaskStore;
  let dorkHome: string;
  let filePath: string;
  let signedInAs: string | undefined;

  async function resync(): Promise<Task> {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    return store.fileSync.upsertFromFile(
      {
        ...parsed.definition,
        meta: parsed.definition.meta,
        scope: 'global',
        projectPath: undefined,
      },
      undefined,
      { source: 'discovery', packageOwned: null }
    );
  }

  beforeEach(async () => {
    posture.loginOn = false;
    signedInAs = undefined;
    const scheduler = {
      isStarted: true,
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue(['2026-10-01T09:00:00.000Z']),
    } as unknown as TaskSchedulerService;
    store = new TaskStore(createTestDb());
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-credits-rearm-')));
    const dir = path.join(dorkHome, 'skills', 'drain');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInAs) res.locals.user = { userId: signedInAs, credential: 'cookie' };
      next();
    });
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), dorkHome)
    );
    target.mount(app);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  const patch = (id: string, body: Record<string, unknown>) =>
    request(target.server).patch(`/api/tasks/${id}`).send(body);

  /** The schedule, discovered, put on credits and approved by the owner. */
  async function approvedOnCredits(): Promise<Task> {
    const found = await resync();
    posture.loginOn = true;
    signedInAs = 'user_owner';
    const res = await patch(found.id, {
      status: 'active',
      enabled: true,
      account: 'dorkos-credits',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', account: 'dorkos-credits' });
    return res.body as Task;
  }

  it('parks it for the owner when another signed-in account changes what it does', async () => {
    const task = await approvedOnCredits();
    signedInAs = 'user_member';
    const res = await patch(task.id, { prompt: 'Drain everything.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_approval');
  });

  it('parks it when another signed-in account changes when it runs', async () => {
    const task = await approvedOnCredits();
    signedInAs = 'user_member';
    const res = await patch(task.id, { cron: '* * * * *' });
    expect(res.body.status).toBe('pending_approval');
  });

  it('refuses another signed-in account switching it back on', async () => {
    const task = await approvedOnCredits();
    await patch(task.id, { enabled: false }).expect(200);
    signedInAs = 'user_member';
    const res = await patch(task.id, { enabled: true }).expect(403);
    expect(res.body).toEqual({
      error: 'Only the owner of this DorkOS can run a scheduled task on DorkOS credits.',
      code: 'owner_only',
    });
    expect(store.getTask(task.id)?.enabled).toBe(false);
  });

  it('refuses an agent switching it back on', async () => {
    const task = await approvedOnCredits();
    await patch(task.id, { enabled: false }).expect(200);
    const res = await request(target.server)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ enabled: true })
      .expect(403);
    expect(res.body.code).toBe('person_only');
    expect(store.getTask(task.id)?.enabled).toBe(false);
  });

  it('lets the owner switch it back on', async () => {
    const task = await approvedOnCredits();
    await patch(task.id, { enabled: false }).expect(200);
    const res = await patch(task.id, { enabled: true }).expect(200);
    expect(res.body.enabled).toBe(true);
  });

  it('still lets an agent switch an ordinary schedule back on', async () => {
    const found = await resync();
    posture.loginOn = true;
    signedInAs = 'user_owner';
    await patch(found.id, { status: 'active', enabled: true }).expect(200);
    await patch(found.id, { enabled: false }).expect(200);
    signedInAs = undefined;
    posture.loginOn = false;
    const res = await request(target.server)
      .patch(`/api/tasks/${found.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ enabled: true })
      .expect(200);
    expect(res.body.enabled).toBe(true);
  });

  it('keeps it approved when the owner edits it', async () => {
    const task = await approvedOnCredits();
    const res = await patch(task.id, { prompt: 'Drain everything.' });
    expect(res.body.status).toBe('active');
  });

  it('with login off, keeps it approved when the person edits it', async () => {
    const task = await approvedOnCredits();
    posture.loginOn = false;
    signedInAs = undefined;
    const res = await patch(task.id, { prompt: 'Drain everything.' });
    expect(res.body.status).toBe('active');
  });
});
