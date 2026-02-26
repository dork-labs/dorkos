import { describe, it, expect, beforeEach } from 'vitest';
import { PulseStore } from '../pulse-store.js';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import { pulseSchedules } from '@dorkos/db';

describe('PulseStore', () => {
  let store: PulseStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new PulseStore(db);
  });

  // === Schedule CRUD ===

  describe('schedule CRUD', () => {
    it('starts with empty schedules', () => {
      expect(store.getSchedules()).toEqual([]);
    });

    it('creates a schedule', () => {
      const schedule = store.createSchedule({
        name: 'Daily cleanup',
        prompt: 'Clean up temp files',
        cron: '0 2 * * *',
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.name).toBe('Daily cleanup');
      expect(schedule.prompt).toBe('Clean up temp files');
      expect(schedule.cron).toBe('0 2 * * *');
      expect(schedule.enabled).toBe(true);
      expect(schedule.status).toBe('active');
      expect(schedule.permissionMode).toBe('acceptEdits');
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.cwd).toBeNull();
      expect(schedule.maxRuntime).toBeNull();
      expect(schedule.nextRun).toBeNull();
    });

    it('persists schedules in the database', () => {
      store.createSchedule({
        name: 'Test',
        prompt: 'Run tests',
        cron: '*/5 * * * *',
      });

      // Verify directly via Drizzle query
      const rows = db.select().from(pulseSchedules).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Test');
    });

    it('reads created schedules back', () => {
      store.createSchedule({ name: 'A', prompt: 'a', cron: '* * * * *' });
      store.createSchedule({ name: 'B', prompt: 'b', cron: '* * * * *' });

      const all = store.getSchedules();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.name)).toEqual(['A', 'B']);
    });

    it('gets a single schedule by ID', () => {
      const created = store.createSchedule({ name: 'One', prompt: 'p', cron: '* * * * *' });
      const found = store.getSchedule(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('One');
    });

    it('returns null for missing schedule', () => {
      expect(store.getSchedule('nonexistent')).toBeNull();
    });

    it('updates a schedule', () => {
      const created = store.createSchedule({ name: 'Old', prompt: 'p', cron: '* * * * *' });
      const updated = store.updateSchedule(created.id, { name: 'New', enabled: false });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New');
      expect(updated!.enabled).toBe(false);
      expect(updated!.prompt).toBe('p');
    });

    it('returns null when updating nonexistent schedule', () => {
      expect(store.updateSchedule('nope', { name: 'X' })).toBeNull();
    });

    it('deletes a schedule', () => {
      const created = store.createSchedule({ name: 'Del', prompt: 'p', cron: '* * * * *' });
      expect(store.deleteSchedule(created.id)).toBe(true);
      expect(store.getSchedules()).toHaveLength(0);
    });

    it('returns false when deleting nonexistent schedule', () => {
      expect(store.deleteSchedule('nope')).toBe(false);
    });
  });

  // === Run CRUD ===

  describe('run CRUD', () => {
    // Helper: create a schedule so FK constraint is satisfied
    function createTestSchedule(id?: string) {
      const schedule = store.createSchedule({
        name: `Schedule ${id ?? 'test'}`,
        prompt: 'test prompt',
        cron: '* * * * *',
      });
      return schedule.id;
    }

    it('creates a run with running status', () => {
      const schedId = createTestSchedule();
      const run = store.createRun(schedId, 'scheduled');
      expect(run.id).toBeDefined();
      expect(run.scheduleId).toBe(schedId);
      expect(run.status).toBe('running');
      expect(run.trigger).toBe('scheduled');
      expect(run.startedAt).toBeDefined();
      expect(run.finishedAt).toBeNull();
    });

    it('gets a run by ID', () => {
      const schedId = createTestSchedule();
      const created = store.createRun(schedId, 'manual');
      const found = store.getRun(created.id);
      expect(found).not.toBeNull();
      expect(found!.trigger).toBe('manual');
    });

    it('returns null for missing run', () => {
      expect(store.getRun('nonexistent')).toBeNull();
    });

    it('updates run fields', () => {
      const schedId = createTestSchedule();
      const run = store.createRun(schedId, 'scheduled');
      const updated = store.updateRun(run.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        durationMs: 5000,
        outputSummary: 'All good',
        sessionId: 'session-123',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.durationMs).toBe(5000);
      expect(updated!.outputSummary).toBe('All good');
      expect(updated!.sessionId).toBe('session-123');
    });

    it('returns null when updating nonexistent run', () => {
      expect(store.updateRun('nope', { status: 'failed' })).toBeNull();
    });

    it('lists runs with pagination', () => {
      const schedId = createTestSchedule();
      for (let i = 0; i < 5; i++) {
        store.createRun(schedId, 'scheduled');
      }

      const all = store.listRuns({ limit: 10 });
      expect(all).toHaveLength(5);

      const page = store.listRuns({ limit: 2, offset: 0 });
      expect(page).toHaveLength(2);

      const page2 = store.listRuns({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
    });

    it('lists runs filtered by schedule', () => {
      const schedId1 = createTestSchedule('1');
      const schedId2 = createTestSchedule('2');
      store.createRun(schedId1, 'scheduled');
      store.createRun(schedId2, 'scheduled');
      store.createRun(schedId1, 'manual');

      const sched1Runs = store.listRuns({ scheduleId: schedId1 });
      expect(sched1Runs).toHaveLength(2);

      const sched2Runs = store.listRuns({ scheduleId: schedId2 });
      expect(sched2Runs).toHaveLength(1);
    });

    it('gets running runs', () => {
      const schedId = createTestSchedule();
      const r1 = store.createRun(schedId, 'scheduled');
      store.createRun(schedId, 'scheduled');
      store.updateRun(r1.id, { status: 'completed' });

      const running = store.getRunningRuns();
      expect(running).toHaveLength(1);
    });

    it('counts runs', () => {
      const schedId1 = createTestSchedule('1');
      const schedId2 = createTestSchedule('2');
      store.createRun(schedId1, 'scheduled');
      store.createRun(schedId1, 'scheduled');
      store.createRun(schedId2, 'scheduled');

      expect(store.countRuns()).toBe(3);
      expect(store.countRuns(schedId1)).toBe(2);
      expect(store.countRuns(schedId2)).toBe(1);
    });
  });

  // === Retention pruning ===

  describe('pruneRuns', () => {
    function createTestSchedule() {
      return store.createSchedule({
        name: 'Prune Test',
        prompt: 'test',
        cron: '* * * * *',
      }).id;
    }

    it('prunes old runs keeping only retentionCount', () => {
      const schedId = createTestSchedule();
      for (let i = 0; i < 5; i++) {
        store.createRun(schedId, 'scheduled');
      }

      const pruned = store.pruneRuns(schedId, 2);
      expect(pruned).toBe(3);
      expect(store.countRuns(schedId)).toBe(2);
    });

    it('does not prune other schedules', () => {
      const schedId1 = createTestSchedule();
      const schedId2 = store.createSchedule({
        name: 'Other',
        prompt: 'test',
        cron: '* * * * *',
      }).id;

      for (let i = 0; i < 3; i++) {
        store.createRun(schedId1, 'scheduled');
      }
      store.createRun(schedId2, 'scheduled');

      store.pruneRuns(schedId1, 1);
      expect(store.countRuns(schedId1)).toBe(1);
      expect(store.countRuns(schedId2)).toBe(1);
    });

    it('returns 0 when nothing to prune', () => {
      const schedId = createTestSchedule();
      store.createRun(schedId, 'scheduled');
      expect(store.pruneRuns(schedId, 10)).toBe(0);
    });
  });

  // === Crash recovery ===

  describe('markRunningAsFailed', () => {
    function createTestSchedule() {
      return store.createSchedule({
        name: 'Recovery Test',
        prompt: 'test',
        cron: '* * * * *',
      }).id;
    }

    it('marks running runs as failed', () => {
      const schedId = createTestSchedule();
      store.createRun(schedId, 'scheduled');
      store.createRun(schedId, 'scheduled');

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(2);

      const running = store.getRunningRuns();
      expect(running).toHaveLength(0);

      const runs = store.listRuns();
      expect(runs.every((r) => r.status === 'failed')).toBe(true);
      expect(runs.every((r) => r.error === 'Interrupted by server restart')).toBe(true);
    });

    it('does not affect completed runs', () => {
      const schedId = createTestSchedule();
      const run = store.createRun(schedId, 'scheduled');
      store.updateRun(run.id, { status: 'completed' });

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(0);

      const found = store.getRun(run.id);
      expect(found!.status).toBe('completed');
    });
  });

  // === Shared Db lifecycle ===

  describe('shared database', () => {
    it('works with a second PulseStore sharing the same db', () => {
      const store2 = new PulseStore(db);
      store.createSchedule({ name: 'From store 1', prompt: 'p', cron: '* * * * *' });
      const schedules = store2.getSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0].name).toBe('From store 1');
    });
  });

  // === ULID IDs ===

  describe('ID generation', () => {
    it('generates ULID IDs (no UUID hyphens)', () => {
      const schedule = store.createSchedule({ name: 'ULID test', prompt: 'p', cron: '* * * * *' });
      expect(schedule.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(schedule.id).not.toContain('-');

      const run = store.createRun(schedule.id, 'manual');
      expect(run.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(run.id).not.toContain('-');
    });
  });

  // === ISO 8601 timestamps ===

  describe('timestamps', () => {
    it('stores ISO 8601 timestamps', () => {
      const schedule = store.createSchedule({ name: 'TS test', prompt: 'p', cron: '* * * * *' });
      expect(schedule.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(schedule.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      const run = store.createRun(schedule.id, 'scheduled');
      expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
