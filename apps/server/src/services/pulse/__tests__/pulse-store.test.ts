import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PulseStore } from '../pulse-store.js';

describe('PulseStore', () => {
  let store: PulseStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-store-test-'));
    store = new PulseStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
      expect(schedule.timezone).toBeNull();
      expect(schedule.cwd).toBeNull();
      expect(schedule.maxRuntime).toBeNull();
      expect(schedule.nextRun).toBeNull();
    });

    it('persists schedules to disk', () => {
      store.createSchedule({
        name: 'Test',
        prompt: 'Run tests',
        cron: '*/5 * * * *',
      });

      const filePath = path.join(tmpDir, 'schedules.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('Test');
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

    it('uses atomic write (temp file rename)', () => {
      store.createSchedule({ name: 'Atomic', prompt: 'p', cron: '* * * * *' });
      // .tmp file should not exist after write
      expect(fs.existsSync(path.join(tmpDir, 'schedules.json.tmp'))).toBe(false);
      // Main file should exist
      expect(fs.existsSync(path.join(tmpDir, 'schedules.json'))).toBe(true);
    });
  });

  // === Run CRUD ===

  describe('run CRUD', () => {
    it('creates a run with running status', () => {
      const run = store.createRun('sched-1', 'scheduled');
      expect(run.id).toBeDefined();
      expect(run.scheduleId).toBe('sched-1');
      expect(run.status).toBe('running');
      expect(run.trigger).toBe('scheduled');
      expect(run.startedAt).toBeDefined();
      expect(run.finishedAt).toBeNull();
    });

    it('gets a run by ID', () => {
      const created = store.createRun('sched-1', 'manual');
      const found = store.getRun(created.id);
      expect(found).not.toBeNull();
      expect(found!.trigger).toBe('manual');
    });

    it('returns null for missing run', () => {
      expect(store.getRun('nonexistent')).toBeNull();
    });

    it('updates run fields', () => {
      const run = store.createRun('sched-1', 'scheduled');
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
      for (let i = 0; i < 5; i++) {
        store.createRun('sched-1', 'scheduled');
      }

      const all = store.listRuns({ limit: 10 });
      expect(all).toHaveLength(5);

      const page = store.listRuns({ limit: 2, offset: 0 });
      expect(page).toHaveLength(2);

      const page2 = store.listRuns({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
    });

    it('lists runs filtered by schedule', () => {
      store.createRun('sched-1', 'scheduled');
      store.createRun('sched-2', 'scheduled');
      store.createRun('sched-1', 'manual');

      const sched1Runs = store.listRuns({ scheduleId: 'sched-1' });
      expect(sched1Runs).toHaveLength(2);

      const sched2Runs = store.listRuns({ scheduleId: 'sched-2' });
      expect(sched2Runs).toHaveLength(1);
    });

    it('gets running runs', () => {
      const r1 = store.createRun('sched-1', 'scheduled');
      store.createRun('sched-1', 'scheduled');
      store.updateRun(r1.id, { status: 'completed' });

      const running = store.getRunningRuns();
      expect(running).toHaveLength(1);
    });

    it('counts runs', () => {
      store.createRun('sched-1', 'scheduled');
      store.createRun('sched-1', 'scheduled');
      store.createRun('sched-2', 'scheduled');

      expect(store.countRuns()).toBe(3);
      expect(store.countRuns('sched-1')).toBe(2);
      expect(store.countRuns('sched-2')).toBe(1);
    });
  });

  // === Retention pruning ===

  describe('pruneRuns', () => {
    it('prunes old runs keeping only retentionCount', () => {
      for (let i = 0; i < 5; i++) {
        store.createRun('sched-1', 'scheduled');
      }

      const pruned = store.pruneRuns('sched-1', 2);
      expect(pruned).toBe(3);
      expect(store.countRuns('sched-1')).toBe(2);
    });

    it('does not prune other schedules', () => {
      for (let i = 0; i < 3; i++) {
        store.createRun('sched-1', 'scheduled');
      }
      store.createRun('sched-2', 'scheduled');

      store.pruneRuns('sched-1', 1);
      expect(store.countRuns('sched-1')).toBe(1);
      expect(store.countRuns('sched-2')).toBe(1);
    });

    it('returns 0 when nothing to prune', () => {
      store.createRun('sched-1', 'scheduled');
      expect(store.pruneRuns('sched-1', 10)).toBe(0);
    });
  });

  // === Crash recovery ===

  describe('markRunningAsFailed', () => {
    it('marks running runs as failed', () => {
      store.createRun('sched-1', 'scheduled');
      store.createRun('sched-1', 'scheduled');

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(2);

      const running = store.getRunningRuns();
      expect(running).toHaveLength(0);

      const runs = store.listRuns();
      expect(runs.every((r) => r.status === 'failed')).toBe(true);
      expect(runs.every((r) => r.error === 'Interrupted by server restart')).toBe(true);
    });

    it('does not affect completed runs', () => {
      const run = store.createRun('sched-1', 'scheduled');
      store.updateRun(run.id, { status: 'completed' });

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(0);

      const found = store.getRun(run.id);
      expect(found!.status).toBe('completed');
    });
  });

  // === Schema migration ===

  describe('schema migration', () => {
    it('runs idempotently', () => {
      // Creating a second store instance against the same DB should not fail
      const store2 = new PulseStore(tmpDir);
      store2.createRun('sched-1', 'scheduled');
      expect(store2.countRuns()).toBe(1);
      store2.close();
    });
  });

  // === Graceful handling ===

  describe('missing schedules file', () => {
    it('returns empty array when file does not exist', () => {
      // Fresh store with no schedules.json yet
      expect(store.getSchedules()).toEqual([]);
    });
  });
});
