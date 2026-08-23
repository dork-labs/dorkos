/**
 * Who may run a scheduled task on demand (DOR-1481).
 *
 * `POST /api/tasks/:id/trigger` was the one write door on this router with no
 * caller check at all, and it is the door that skips every other one. An agent
 * creates a schedule; the route correctly parks it at `pending_approval` so a
 * person can read what it proposes; the agent then POSTs to trigger with the
 * same identity header and the unapproved prompt runs immediately, at whatever
 * power the schedule carries. The approval it was made to wait for decided
 * nothing.
 *
 * The fix is the bar the create and update doors already run, and the case that
 * matters most is the second `describe`: running a proposal once, before
 * deciding on it, is the "Run it once" affordance in the approval card
 * (`services/tasks/__tests__/trigger-pending-schedule.test.ts`). An operator has
 * no other way to find out what a proposed schedule actually does, so that must
 * keep working — the refusal is about WHO is asking, never about the state the
 * schedule is in.
 *
 * @module routes/__tests__/tasks-trigger-authority
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
import { OPERATOR_ONLY_TASK_CODE } from '../../services/tasks/task-write-policy.js';

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('POST /api/tasks/:id/trigger', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let active: Task;
  let parked: Task;
  let scheduler: TaskSchedulerService;
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

  beforeEach(() => {
    state.authEnabled = false;
    signedInUser = undefined;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    active = store.createTask({
      name: 'nightly',
      description: 'approved and running',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    parked = store.updateTask(
      store.createTask({
        name: 'proposed',
        description: 'waiting on a person',
        prompt: 'the prompt nobody approved',
        cron: '0 3 * * *',
        filePath: '/tmp/tasks/proposed/SKILL.md',
      }).id,
      { status: 'pending_approval' }
    )!;

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

  describe('an agent that names itself', () => {
    it('cannot run a schedule that is still waiting for approval', async () => {
      // The escalation this closes: parking a proposal is worth nothing if the
      // proposer can run it anyway through the next door along.
      const res = await request(app)
        .post(`/api/tasks/${parked.id}/trigger`)
        .set('x-dorkos-agent', 'agent-token-abc');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(OPERATOR_ONLY_TASK_CODE);
      expect(scheduler.triggerManualRun).not.toHaveBeenCalled();
    });

    it('cannot run an approved schedule off-schedule either', async () => {
      // The bar is about who is asking, not about the schedule's state — an
      // approval says "run at 2am", not "run whenever an agent says so".
      const res = await request(app)
        .post(`/api/tasks/${active.id}/trigger`)
        .set('x-dorkos-agent', 'agent-token-abc');

      expect(res.status).toBe(403);
      expect(scheduler.triggerManualRun).not.toHaveBeenCalled();
    });

    it('is told what to do instead, not just refused', async () => {
      // This text lands in a model's context, and a model that is only told
      // "no" tries again.
      const res = await request(app)
        .post(`/api/tasks/${active.id}/trigger`)
        .set('x-dorkos-agent', 'agent-token-abc');

      expect(String(res.body.message)).toMatch(/ask the person/i);
    });
  });

  describe('a person in the cockpit', () => {
    it('runs an approved schedule on demand', async () => {
      const res = await request(app).post(`/api/tasks/${active.id}/trigger`);

      expect(res.status).toBe(201);
      expect(res.body.runId).toBe('run-1');
    });

    it('runs a proposal once, before deciding about it', async () => {
      // "Try it once and see" is the whole point of the approval card, and the
      // authorization fix must not take it away.
      const res = await request(app).post(`/api/tasks/${parked.id}/trigger`);

      expect(res.status).toBe(201);
      expect(scheduler.triggerManualRun).toHaveBeenCalledWith(parked.id);
      expect(store.getTask(parked.id)!.status).toBe('pending_approval');
    });

    it('still gets 404 for a schedule that does not exist', async () => {
      vi.mocked(scheduler.triggerManualRun).mockResolvedValueOnce(null);

      const res = await request(app).post('/api/tasks/nope/trigger');

      expect(res.status).toBe(404);
    });
  });

  describe('with login on, the check is positive proof and not header absence', () => {
    beforeEach(() => {
      state.authEnabled = true;
    });

    it('refuses a caller with no proven user, even with no agent header', async () => {
      signedInUser = undefined;

      const res = await request(app).post(`/api/tasks/${active.id}/trigger`);

      expect(res.status).toBe(403);
      expect(scheduler.triggerManualRun).not.toHaveBeenCalled();
    });

    it('allows a signed-in person', async () => {
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const res = await request(app).post(`/api/tasks/${active.id}/trigger`);

      expect(res.status).toBe(201);
    });
  });
});
