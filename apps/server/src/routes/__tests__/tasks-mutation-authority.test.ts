/**
 * Who may DELETE a schedule or CANCEL a run (DOR-1574).
 *
 * DOR-1569 guarded the create/update door — the "how a scheduled task runs"
 * path — so an API key read off `~/.dork` can no longer arm a live cron under
 * login-on. It left DELETE and cancel unguarded, because neither is a
 * power-grant. They are still worth guarding as nuisance/DoS protection: under
 * login-on a caller holding a per-user API key but no session cookie should not
 * be able to remove a person's schedule or stop their run on their behalf.
 *
 * So both doors now run `requireOperatorCookieUnderLogin`, exactly as the config
 * and extension-approval routes do. The bar only bites under login-on; under the
 * default login-off posture a credential-free loopback request is
 * cryptographically indistinguishable from the cockpit (the DOR-505 residual),
 * so the guard is a deliberate no-op and behavior there is unchanged.
 *
 * @module routes/__tests__/tasks-mutation-authority
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';

/** Mutable posture the mocked config manager reports. */
const state = vi.hoisted(() => ({ authEnabled: false }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.authEnabled } : undefined),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { OPERATOR_COOKIE_REQUIRED_CODE } from '../../lib/caller-authority.js';

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    // Default: a real, stoppable run — so a case that reaches the cancel is a
    // 200, and a refusal is unambiguously the bar and not a 404.
    cancelRun: vi.fn().mockResolvedValue({ state: 'stopping' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('Task mutation authority — DELETE and cancel (DOR-1574)', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let schedule: Task;
  let runId: string;
  let scheduler: TaskSchedulerService;
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

  beforeEach(() => {
    state.authEnabled = false;
    signedInUser = undefined;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    schedule = store.createTask({
      name: 'nightly',
      description: 'approved and running',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    runId = store.createRun(schedule.id, 'scheduled').id;

    app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInUser) res.locals.user = signedInUser;
      next();
    });
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
  });

  afterEach(() => {
    store.close();
  });

  describe('with login OFF — the accepted DOR-505 residual, unchanged', () => {
    it('lets a credential-free caller delete a schedule', async () => {
      const res = await request(app).delete(`/api/tasks/${schedule.id}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(store.getTask(schedule.id)).toBeNull();
    });

    it('lets a credential-free caller cancel a run', async () => {
      const res = await request(app).post(`/api/tasks/runs/${runId}/cancel`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(scheduler.cancelRun).toHaveBeenCalledWith(runId);
    });
  });

  describe('with login ON — an API key is not a person in the cockpit', () => {
    beforeEach(() => {
      state.authEnabled = true;
    });

    it('refuses a DELETE from a caller with no session cookie', async () => {
      // The exploit shape: an agent reads a per-user API key off `~/.dork`,
      // which `sessionGate` accepts as an identity, and drops its agent header.
      // Only a browser cookie separates it from the cockpit.
      signedInUser = { userId: 'user_key', credential: 'api-key' };

      const res = await request(app).delete(`/api/tasks/${schedule.id}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
      // The bar fired before anything happened: the schedule is still there.
      expect(store.getTask(schedule.id)).not.toBeNull();
    });

    it('refuses a DELETE from a caller with no credential at all', async () => {
      signedInUser = undefined;

      const res = await request(app).delete(`/api/tasks/${schedule.id}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
      expect(store.getTask(schedule.id)).not.toBeNull();
    });

    it('refuses a cancel from a caller with no session cookie', async () => {
      signedInUser = { userId: 'user_key', credential: 'api-key' };

      const res = await request(app).post(`/api/tasks/runs/${runId}/cancel`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
      // Refused before the run was ever touched.
      expect(scheduler.cancelRun).not.toHaveBeenCalled();
    });

    it('lets a signed-in person delete a schedule', async () => {
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const res = await request(app).delete(`/api/tasks/${schedule.id}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(store.getTask(schedule.id)).toBeNull();
    });

    it('lets a signed-in person cancel a run', async () => {
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const res = await request(app).post(`/api/tasks/runs/${runId}/cancel`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(scheduler.cancelRun).toHaveBeenCalledWith(runId);
    });
  });
});
