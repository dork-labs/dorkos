/**
 * A schedule on DorkOS credits spends the DorkOS account's money on every run,
 * so naming credits, approving a schedule that names them, and running one now
 * are the owner's alone (DOR-2652), the same bar `/api/cloud/*` runs.
 *
 * @module routes/__tests__/tasks-credits-owner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/schemas';

const state = vi.hoisted(() => ({ authEnabled: false }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.authEnabled } : undefined),
  },
}));
vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

const OWNER_ID = 'user_owner';
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: OWNER_ID, name: 'Owner' }),
}));

import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

const target = swappableServer();
const server = target.server;

const NOT_THE_OWNER = {
  error: 'Only the owner of this DorkOS can run a scheduled task on DorkOS credits.',
  code: 'owner_only',
};

describe('schedules on DorkOS credits are the owner’s alone', () => {
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let onCredits: Task;
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

  beforeEach(() => {
    state.authEnabled = false;
    signedInUser = undefined;
    scheduler = {
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      triggerManualRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue([]),
      getActiveRunCount: vi.fn().mockReturnValue(0),
      isRegistered: vi.fn().mockReturnValue(false),
    } as unknown as TaskSchedulerService;
    store = new TaskStore(createTestDb());
    onCredits = store.createTask({
      name: 'nightly',
      description: 'runs on credits',
      prompt: 'the prompt',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
      account: 'dorkos-credits',
    });

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInUser) res.locals.user = signedInUser;
      next();
    });
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
    target.mount(app);
  });

  afterEach(() => store.close());

  it('refuses an agent proposing a schedule on credits, before anything is made', async () => {
    const res = await request(server)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ name: 'x', prompt: 'p', cron: '0 3 * * *', account: 'dorkos-credits' })
      .expect(403);
    expect(res.body).toEqual({
      error: 'Only you can run a scheduled task on your DorkOS credits, from the DorkOS app.',
      code: 'person_only',
    });
    expect(store.getTasks()).toHaveLength(1);
  });

  it('refuses an agent moving a schedule onto credits', async () => {
    const other = store.createTask({
      name: 'weekly',
      description: 'runs on its own sign-in',
      prompt: 'p',
      cron: '0 4 * * 1',
      filePath: '/tmp/tasks/weekly/SKILL.md',
    });
    await request(server)
      .patch(`/api/tasks/${other.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ account: 'dorkos-credits' })
      .expect(403);
    expect(store.getTask(other.id)?.account).toBeNull();
  });

  describe('with login on', () => {
    beforeEach(() => {
      state.authEnabled = true;
    });

    it('refuses a signed-in person who does not own this DorkOS approving it', async () => {
      signedInUser = { userId: 'user_member', credential: 'cookie' };
      const res = await request(server)
        .patch(`/api/tasks/${onCredits.id}`)
        .send({ status: 'active' })
        .expect(403);
      expect(res.body).toEqual(NOT_THE_OWNER);
    });

    it('refuses them running it now, and runs nothing', async () => {
      signedInUser = { userId: 'user_member', credential: 'cookie' };
      const res = await request(server).post(`/api/tasks/${onCredits.id}/trigger`).expect(403);
      expect(res.body).toEqual(NOT_THE_OWNER);
      expect(scheduler.triggerManualRun).not.toHaveBeenCalled();
    });

    it('lets them run a schedule that does not run on credits', async () => {
      signedInUser = { userId: 'user_member', credential: 'cookie' };
      const other = store.createTask({
        name: 'weekly',
        description: 'runs on its own sign-in',
        prompt: 'p',
        cron: '0 4 * * 1',
        filePath: '/tmp/tasks/weekly/SKILL.md',
      });
      await request(server).post(`/api/tasks/${other.id}/trigger`).expect(201);
    });

    it('lets the owner signed in to the app run it', async () => {
      signedInUser = { userId: OWNER_ID, credential: 'cookie' };
      await request(server).post(`/api/tasks/${onCredits.id}/trigger`).expect(201);
      expect(scheduler.triggerManualRun).toHaveBeenCalledWith(onCredits.id);
    });

    it('lets the owner approve it', async () => {
      signedInUser = { userId: OWNER_ID, credential: 'cookie' };
      const res = await request(server)
        .patch(`/api/tasks/${onCredits.id}`)
        .send({ status: 'active' });
      expect(res.body.code).not.toBe('owner_only');
      expect(res.status).not.toBe(403);
    });
  });
});
