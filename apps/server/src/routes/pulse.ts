/**
 * Pulse scheduler routes — CRUD for schedules and runs.
 *
 * @module routes/pulse
 */
import { Router } from 'express';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  ListRunsQuerySchema,
} from '@dorkos/shared/schemas';
import type { PulseStore } from '../services/pulse/pulse-store.js';
import type { SchedulerService } from '../services/pulse/scheduler-service.js';
import { isWithinBoundary } from '../lib/boundary.js';

/**
 * Create the Pulse router with schedule and run management endpoints.
 *
 * @param store - PulseStore for data persistence
 * @param scheduler - SchedulerService for cron management and dispatch
 */
export function createPulseRouter(store: PulseStore, scheduler: SchedulerService): Router {
  const router = Router();

  // === Schedule endpoints ===

  router.get('/schedules', (_req, res) => {
    const schedules = store.getSchedules().map((s) => ({
      ...s,
      nextRun: scheduler.getNextRun(s.id)?.toISOString() ?? null,
    }));
    res.json(schedules);
  });

  router.post('/schedules', async (req, res) => {
    const result = CreateScheduleRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    if (result.data.cwd) {
      const withinBoundary = await isWithinBoundary(result.data.cwd);
      if (!withinBoundary) {
        return res.status(403).json({ error: 'CWD outside directory boundary' });
      }
    }

    const schedule = store.createSchedule(result.data);
    if (schedule.enabled && schedule.status === 'active') {
      scheduler.registerSchedule(schedule);
    }

    return res.status(201).json(schedule);
  });

  router.patch('/schedules/:id', async (req, res) => {
    const result = UpdateScheduleRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    if (result.data.cwd) {
      const withinBoundary = await isWithinBoundary(result.data.cwd);
      if (!withinBoundary) {
        return res.status(403).json({ error: 'CWD outside directory boundary' });
      }
    }

    const updated = store.updateSchedule(req.params.id, result.data);
    if (!updated) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Re-register or unregister cron job based on new state
    if (updated.enabled && updated.status === 'active') {
      scheduler.registerSchedule(updated);
    } else {
      scheduler.unregisterSchedule(updated.id);
    }

    return res.json(updated);
  });

  router.delete('/schedules/:id', (_req, res) => {
    const { id } = _req.params;
    scheduler.unregisterSchedule(id);
    const deleted = store.deleteSchedule(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    return res.json({ success: true });
  });

  router.post('/schedules/:id/trigger', async (_req, res) => {
    const run = await scheduler.triggerManualRun(_req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    return res.status(201).json({ runId: run.id });
  });

  // === Run endpoints ===

  router.get('/runs', (req, res) => {
    const result = ListRunsQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    const runs = store.listRuns({
      scheduleId: result.data.scheduleId,
      status: result.data.status,
      limit: result.data.limit,
      offset: result.data.offset,
    });
    return res.json(runs);
  });

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });

  router.post('/runs/:id/cancel', (req, res) => {
    const cancelled = scheduler.cancelRun(req.params.id);
    if (!cancelled) {
      return res.status(404).json({ error: 'Run not found or not active' });
    }
    return res.json({ success: true });
  });

  return router;
}
