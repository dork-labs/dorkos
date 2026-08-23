/**
 * What `PATCH /api/tasks/:id` writes to the SKILL.md on disk (DOR-1481).
 *
 * Tasks are file-first: the SKILL.md is the source of truth and the row is a
 * cache the watcher and the reconciler rebuild from it. That makes two failure
 * shapes on this route much worse than they look, and both are pinned here
 * against a REAL file on a real temp directory rather than a mocked writer,
 * because the whole defect is about what ends up in the bytes.
 *
 * - **A cleared field used to poison the file.** `maxRuntime: null` means
 *   "remove the cap". The route copied the value in on `!== undefined`, so the
 *   file got `max-runtime: null`, which `TaskFrontmatterSchema` rejects. From
 *   then on the watcher logged the file as invalid, the reconciler kept
 *   restoring the row from it, and every later PATCH silently skipped the file
 *   write — the route only rewrites a file that parsed. One cleared field, and
 *   the file and the row never agreed again.
 * - **A failed write used to answer 200.** Read and write shared one
 *   `try {} catch {}` whose comment claimed it was there for legacy DB-only
 *   tasks. It also swallowed `EACCES`/`ENOSPC`/`EROFS` from the write, after
 *   which the row was updated anyway and the route reported success — until the
 *   reconciler read the untouched file five minutes later and put the old
 *   values back.
 *
 * @module routes/__tests__/tasks-file-write
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: false } : undefined),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

/** The write failure the next `writeSkillFile` should raise, if any. */
const state = vi.hoisted(() => ({ writeFailure: null as NodeJS.ErrnoException | null }));

// Real writer by default — these cases are about the bytes on disk — with one
// switchable failure, so the "disk refused the write" path is exercised through
// exactly the same call the happy path takes.
vi.mock('@dorkos/skills/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/skills/writer')>();
  return {
    ...actual,
    writeSkillFile: async (...args: Parameters<typeof actual.writeSkillFile>) => {
      if (state.writeFailure) throw state.writeFailure;
      return actual.writeSkillFile(...args);
    },
  };
});

import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('PATCH /api/tasks/:id and the file on disk', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let dorkHome: string;
  let scheduler: TaskSchedulerService;

  /** The SKILL.md a `target: 'global'` task lands at. */
  function skillPath(slug: string): string {
    return path.join(dorkHome, 'tasks', slug, SKILL_FILENAME);
  }

  /** Create a task through the route, the way the cockpit does. */
  async function createTask(body: Record<string, unknown>): Promise<string> {
    const res = await request(app)
      .post('/api/tasks')
      .send({
        name: 'nightly-sweep',
        description: 'sweeps the backlog',
        prompt: 'sweep the backlog',
        cron: '0 3 * * *',
        target: 'global',
        ...body,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  beforeEach(async () => {
    state.writeFailure = null;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-tasks-file-write-'));

    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), dorkHome)
    );
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  describe('clearing a field', () => {
    it('leaves a file that still parses, and a frontmatter key that is simply gone', async () => {
      const id = await createTask({ maxRuntime: '30m' });

      const res = await request(app).patch(`/api/tasks/${id}`).send({ maxRuntime: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const raw = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');
      expect(raw).not.toContain('max-runtime: null');

      const parsed = parseSkillFile(skillPath('nightly-sweep'), raw, TaskFrontmatterSchema);
      expect(parsed.ok, `the file no longer parses: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;
      expect('max-runtime' in (parsed.definition.meta as Record<string, unknown>)).toBe(false);
      expect(store.getTask(id)!.maxRuntime).toBeNull();
    });

    it('clears display-name and timezone the same way', async () => {
      // `cron: null` is the fourth clearable field and is deliberately NOT
      // exercised here: `pulse_schedules.cron` is NOT NULL, so clearing a cron
      // throws out of `store.updateTask` before the row is written. That is a
      // separate defect from this one — the frontmatter merge handles `cron`
      // exactly like the other three — and fixing it means a schema or column
      // change, not a change to this route.
      const id = await createTask({ displayName: 'Nightly Sweep', timezone: 'Europe/Berlin' });

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ displayName: null, timezone: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const raw = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');
      expect(raw).not.toContain('null');

      const parsed = parseSkillFile(skillPath('nightly-sweep'), raw, TaskFrontmatterSchema);
      expect(parsed.ok, `the file no longer parses: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;
      const meta = parsed.definition.meta as Record<string, unknown>;
      expect('display-name' in meta, 'display-name should be gone').toBe(false);
      // `timezone` carries a schema default, so the key comes back as 'UTC'
      // rather than absent — what matters is that it is not the literal null
      // that made the whole file unreadable.
      expect(meta.timezone).toBe('UTC');
    });

    it('does not desync the file from the row for every write that follows', async () => {
      // The lasting damage, and the reason this is worth more than a parse
      // assertion: once the file was unreadable the route stopped writing it at
      // all, so later edits lived only in the row until the reconciler undid
      // them.
      const id = await createTask({ maxRuntime: '30m' });
      await request(app).patch(`/api/tasks/${id}`).send({ maxRuntime: null });

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ description: 'sweeps the backlog, twice as hard' });
      expect(res.status).toBe(200);

      const raw = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');
      expect(raw).toContain('sweeps the backlog, twice as hard');
    });
  });

  describe('when the disk refuses the write', () => {
    it('answers 500 and changes nothing', async () => {
      const id = await createTask({});
      const before = store.getTask(id)!;
      const fileBefore = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');

      state.writeFailure = Object.assign(new Error('EACCES: permission denied, open'), {
        code: 'EACCES',
      });

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ description: 'an edit the disk would not take' });

      expect(res.status).toBe(500);
      expect(String(res.body.error)).toMatch(/could not save/i);
      // A message a person can act on names the file it could not write.
      expect(String(res.body.error)).toContain('nightly-sweep');

      // The row must not have moved: the file is the source of truth, and a row
      // ahead of its file is reverted by the reconciler minutes later with no
      // trace of the edit the caller was told had landed.
      const after = store.getTask(id)!;
      expect(after.description).toBe(before.description);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await fs.readFile(skillPath('nightly-sweep'), 'utf-8')).toBe(fileBefore);
    });

    it('still updates a legacy DB-only task whose file is not there', async () => {
      // The behavior the broad catch was actually written for, kept: a row
      // pointing at a file that does not exist is edited in the DB alone.
      const legacy = store.createTask({
        name: 'legacy',
        description: 'from before the files',
        prompt: 'do a thing',
        cron: '0 4 * * *',
        filePath: path.join(dorkHome, 'tasks', 'legacy', SKILL_FILENAME),
      });

      const res = await request(app)
        .patch(`/api/tasks/${legacy.id}`)
        .send({ description: 'edited anyway' });

      expect(res.status).toBe(200);
      expect(store.getTask(legacy.id)!.description).toBe('edited anyway');
    });
  });

  describe('maxRuntime on update is validated exactly as it is on create', () => {
    it('refuses a duration it cannot read', async () => {
      // `parseDuration('10 minutes')` returns 0, which removes the run's time
      // limit entirely — and the same string written to the file makes the file
      // unreadable. A 400 is the only honest answer.
      const id = await createTask({ maxRuntime: '30m' });

      const res = await request(app).patch(`/api/tasks/${id}`).send({ maxRuntime: '10 minutes' });

      expect(res.status).toBe(400);
      expect(store.getTask(id)!.maxRuntime).toBe(1_800_000);
    });

    it('accepts a duration it can read', async () => {
      const id = await createTask({ maxRuntime: '30m' });

      const res = await request(app).patch(`/api/tasks/${id}`).send({ maxRuntime: '10m' });

      expect(res.status).toBe(200);
      expect(store.getTask(id)!.maxRuntime).toBe(600_000);
    });

    it('still accepts null, which is how a cap is removed', async () => {
      const id = await createTask({ maxRuntime: '30m' });

      const res = await request(app).patch(`/api/tasks/${id}`).send({ maxRuntime: null });

      expect(res.status).toBe(200);
      expect(store.getTask(id)!.maxRuntime).toBeNull();
    });
  });
});
