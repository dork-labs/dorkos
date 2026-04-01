import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTasksRouter } from '../tasks.js';
import { TaskStore, type CreateTaskStoreInput } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

vi.mock('@dorkos/skills/writer', () => ({
  writeSkillFile: vi.fn().mockResolvedValue('/tmp/dork-test/tasks/test/SKILL.md'),
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
      readFile: vi.fn().mockResolvedValue(''),
    },
  };
});

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

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockReturnValue(false),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('Tasks routes', () => {
  let app: express.Application;
  let store: TaskStore;
  let scheduler: ReturnType<typeof createMockScheduler>;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = createMockScheduler();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter(store, scheduler, '/tmp/dork-test'));
    // Error handler to surface errors instead of hanging
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      }
    );
  });

  afterEach(() => {
    store.close();
  });

  describe('GET /api/tasks', () => {
    it('returns empty array when no schedules', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns schedules with nextRun', async () => {
      store.createTask(taskInput({ name: 'Test', prompt: 'p', cron: '0 * * * *' }));

      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Test');
      expect(res.body[0].nextRun).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a schedule', async () => {
      const res = await request(app).post('/api/tasks').send({
        name: 'New',
        description: 'do stuff',
        prompt: 'do stuff',
        cron: '0 2 * * *',
        target: 'global',
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('new');
      expect(res.body.id).toBeDefined();
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/tasks').send({ name: 'No cron' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('registers cron job for enabled active schedule', async () => {
      await request(app).post('/api/tasks').send({
        name: 'Active',
        description: 'p',
        prompt: 'p',
        cron: '0 * * * *',
        target: 'global',
      });

      expect(scheduler.registerTask).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates a schedule', async () => {
      const sched = store.createTask(taskInput({ name: 'Old', prompt: 'p', cron: '0 * * * *' }));

      const res = await request(app).patch(`/api/tasks/${sched.id}`).send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app).patch('/api/tasks/nonexistent').send({ name: 'X' });

      expect(res.status).toBe(404);
    });

    it('unregisters cron when disabling', async () => {
      const sched = store.createTask(taskInput({ name: 'Dis', prompt: 'p', cron: '0 * * * *' }));

      await request(app).patch(`/api/tasks/${sched.id}`).send({ enabled: false });

      expect(scheduler.unregisterTask).toHaveBeenCalledWith(sched.id);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a schedule', async () => {
      const sched = store.createTask(taskInput({ name: 'Del', prompt: 'p', cron: '0 * * * *' }));

      const res = await request(app).delete(`/api/tasks/${sched.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(scheduler.unregisterTask).toHaveBeenCalledWith(sched.id);
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app).delete('/api/tasks/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/trigger', () => {
    it('returns 404 when schedule not found', async () => {
      const res = await request(app).post('/api/tasks/nope/trigger');
      expect(res.status).toBe(404);
    });

    it('returns run ID on success', async () => {
      vi.mocked(scheduler.triggerManualRun).mockResolvedValue({
        id: 'run-1',
        scheduleId: 'sched-1',
        status: 'running',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        outputSummary: null,
        error: null,
        sessionId: null,
        trigger: 'manual',
        createdAt: new Date().toISOString(),
      });

      const res = await request(app).post('/api/tasks/sched-1/trigger');
      expect(res.status).toBe(201);
      expect(res.body.runId).toBe('run-1');
    });
  });

  describe('GET /api/tasks/runs', () => {
    it('returns empty array when no runs', async () => {
      const res = await request(app).get('/api/tasks/runs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns runs with pagination', async () => {
      const sched = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');

      const res = await request(app).get('/api/tasks/runs?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('filters by scheduleId', async () => {
      const s1 = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      const s2 = store.createTask(taskInput({ name: 'S2', prompt: 'p', cron: '0 * * * *' }));
      store.createRun(s1.id, 'scheduled');
      store.createRun(s2.id, 'scheduled');

      const res = await request(app).get(`/api/tasks/runs?scheduleId=${s1.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scheduleId).toBe(s1.id);
    });
  });

  describe('GET /api/tasks/runs/:id', () => {
    it('returns a run', async () => {
      const sched = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      const run = store.createRun(sched.id, 'scheduled');
      const res = await request(app).get(`/api/tasks/runs/${run.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(run.id);
    });

    it('returns 404 for missing run', async () => {
      const res = await request(app).get('/api/tasks/runs/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/tasks/runs/:id/cancel', () => {
    it('returns 404 when run not active', async () => {
      const res = await request(app).post('/api/tasks/runs/nope/cancel');
      expect(res.status).toBe(404);
    });

    it('cancels an active run', async () => {
      vi.mocked(scheduler.cancelRun).mockReturnValue(true);

      const res = await request(app).post('/api/tasks/runs/run-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
