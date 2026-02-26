import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPulseRouter } from '../pulse.js';
import { PulseStore } from '../../services/pulse/pulse-store.js';
import type { SchedulerService } from '../../services/pulse/scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

function createMockScheduler(): SchedulerService {
  return {
    registerSchedule: vi.fn(),
    unregisterSchedule: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockReturnValue(false),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as SchedulerService;
}

describe('Pulse routes', () => {
  let app: express.Application;
  let store: PulseStore;
  let scheduler: ReturnType<typeof createMockScheduler>;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new PulseStore(db);
    scheduler = createMockScheduler();
    app = express();
    app.use(express.json());
    app.use('/api/pulse', createPulseRouter(store, scheduler));
    // Error handler to surface errors instead of hanging
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
  });

  afterEach(() => {
    store.close();
  });

  describe('GET /api/pulse/schedules', () => {
    it('returns empty array when no schedules', async () => {
      const res = await request(app).get('/api/pulse/schedules');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns schedules with nextRun', async () => {
      store.createSchedule({ name: 'Test', prompt: 'p', cron: '0 * * * *' });

      const res = await request(app).get('/api/pulse/schedules');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Test');
      expect(res.body[0].nextRun).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('POST /api/pulse/schedules', () => {
    it('creates a schedule', async () => {
      const res = await request(app)
        .post('/api/pulse/schedules')
        .send({ name: 'New', prompt: 'do stuff', cron: '0 2 * * *' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New');
      expect(res.body.id).toBeDefined();
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/pulse/schedules').send({ name: 'No cron' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('registers cron job for enabled active schedule', async () => {
      await request(app)
        .post('/api/pulse/schedules')
        .send({ name: 'Active', prompt: 'p', cron: '0 * * * *' });

      expect(scheduler.registerSchedule).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/pulse/schedules/:id', () => {
    it('updates a schedule', async () => {
      const sched = store.createSchedule({ name: 'Old', prompt: 'p', cron: '0 * * * *' });

      const res = await request(app)
        .patch(`/api/pulse/schedules/${sched.id}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app)
        .patch('/api/pulse/schedules/nonexistent')
        .send({ name: 'X' });

      expect(res.status).toBe(404);
    });

    it('unregisters cron when disabling', async () => {
      const sched = store.createSchedule({ name: 'Dis', prompt: 'p', cron: '0 * * * *' });

      await request(app)
        .patch(`/api/pulse/schedules/${sched.id}`)
        .send({ enabled: false });

      expect(scheduler.unregisterSchedule).toHaveBeenCalledWith(sched.id);
    });
  });

  describe('DELETE /api/pulse/schedules/:id', () => {
    it('deletes a schedule', async () => {
      const sched = store.createSchedule({ name: 'Del', prompt: 'p', cron: '0 * * * *' });

      const res = await request(app).delete(`/api/pulse/schedules/${sched.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(scheduler.unregisterSchedule).toHaveBeenCalledWith(sched.id);
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app).delete('/api/pulse/schedules/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pulse/schedules/:id/trigger', () => {
    it('returns 404 when schedule not found', async () => {
      const res = await request(app).post('/api/pulse/schedules/nope/trigger');
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

      const res = await request(app).post('/api/pulse/schedules/sched-1/trigger');
      expect(res.status).toBe(201);
      expect(res.body.runId).toBe('run-1');
    });
  });

  describe('GET /api/pulse/runs', () => {
    it('returns empty array when no runs', async () => {
      const res = await request(app).get('/api/pulse/runs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns runs with pagination', async () => {
      const sched = store.createSchedule({ name: 'S1', prompt: 'p', cron: '0 * * * *' });
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');

      const res = await request(app).get('/api/pulse/runs?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('filters by scheduleId', async () => {
      const s1 = store.createSchedule({ name: 'S1', prompt: 'p', cron: '0 * * * *' });
      const s2 = store.createSchedule({ name: 'S2', prompt: 'p', cron: '0 * * * *' });
      store.createRun(s1.id, 'scheduled');
      store.createRun(s2.id, 'scheduled');

      const res = await request(app).get(`/api/pulse/runs?scheduleId=${s1.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scheduleId).toBe(s1.id);
    });
  });

  describe('GET /api/pulse/runs/:id', () => {
    it('returns a run', async () => {
      const sched = store.createSchedule({ name: 'S1', prompt: 'p', cron: '0 * * * *' });
      const run = store.createRun(sched.id, 'scheduled');
      const res = await request(app).get(`/api/pulse/runs/${run.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(run.id);
    });

    it('returns 404 for missing run', async () => {
      const res = await request(app).get('/api/pulse/runs/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pulse/runs/:id/cancel', () => {
    it('returns 404 when run not active', async () => {
      const res = await request(app).post('/api/pulse/runs/nope/cancel');
      expect(res.status).toBe(404);
    });

    it('cancels an active run', async () => {
      vi.mocked(scheduler.cancelRun).mockReturnValue(true);

      const res = await request(app).post('/api/pulse/runs/run-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
