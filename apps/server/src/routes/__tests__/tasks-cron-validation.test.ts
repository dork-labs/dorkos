/**
 * A schedule the scheduler cannot read must be refused at the door.
 *
 * `POST`/`PATCH` write a SKILL.md to disk BEFORE anything asks croner whether
 * the cron or the timezone means anything. Without a check in front of that
 * write, a typo lands a permanent file on disk whose row can never be
 * registered — and, until the boot containment that ships alongside this,
 * stopped the whole server from starting on the next restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTasksRouter } from '../tasks.js';
import { TaskStore, type CreateTaskStoreInput } from '../../services/tasks/task-store.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

// Login off, so the caller is trusted and nothing parks — see the long note in
// `tasks.test.ts` for why the singleton has to be stood in for.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
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

import { writeSkillFile } from '@dorkos/skills/writer';

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name}/SKILL.md`,
    ...overrides,
  };
}

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn().mockReturnValue(true),
    unregisterTask: vi.fn(),
    isStarted: true,
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

/** The body `POST /api/tasks` needs, with the field under test overridden. */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nightly sweep',
    description: 'Sweeps things nightly',
    prompt: 'Sweep the thing',
    cron: '0 2 * * *',
    target: 'global',
    ...overrides,
  };
}

describe('Tasks routes — a schedule nothing can read is refused at the door', () => {
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
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      }
    );
  });

  afterEach(() => {
    store.close();
    vi.clearAllMocks();
  });

  describe('POST /api/tasks', () => {
    it('refuses a cron croner cannot parse — 400, and nothing is written', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send(createBody({ cron: 'banana' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('banana');
      // The whole point of validating BEFORE the write: no file, no row.
      expect(writeSkillFile).not.toHaveBeenCalled();
      expect(store.getTasks()).toHaveLength(0);
    });

    it('refuses a timezone croner cannot resolve — 400, and nothing is written', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send(createBody({ timezone: 'Mars/Phobos' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Mars/Phobos');
      expect(writeSkillFile).not.toHaveBeenCalled();
      expect(store.getTasks()).toHaveLength(0);
    });

    it('still accepts a schedule that reads', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send(createBody({ cron: '0 3 * * *', timezone: 'Asia/Tokyo' }));

      expect(res.status).toBe(201);
      expect(writeSkillFile).toHaveBeenCalled();
    });

    it('accepts an on-demand task, which has no cron to read', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send(createBody({ cron: null }));

      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('refuses a cron croner cannot parse — 400, and the row is untouched', async () => {
      const task = store.createTask(taskInput({ name: 'nightly', cron: '0 2 * * *' }));

      const res = await request(app).patch(`/api/tasks/${task.id}`).send({ cron: '99 * * * *' });

      expect(res.status).toBe(400);
      expect(store.getTask(task.id)?.cron).toBe('0 2 * * *');
    });

    it('refuses a timezone croner cannot resolve — 400, and the row is untouched', async () => {
      const task = store.createTask(
        taskInput({ name: 'nightly', cron: '0 2 * * *', timezone: 'UTC' })
      );

      const res = await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ timezone: 'Mars/Phobos' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Mars/Phobos');
      expect(store.getTask(task.id)?.timezone).toBe('UTC');
    });

    // The guard reads the MERGED schedule, so it has to be asked only when the
    // request touches one of its halves. A row that already holds an
    // unschedulable cron — hand-edited on disk, or written by a build that had
    // no check — must stay editable, or the one thing an operator would do about
    // it (pause it) is refused by the very state they are trying to escape.
    it('lets an unrelated edit through on a task whose stored cron is already bad', async () => {
      const task = store.createTask(taskInput({ name: 'legacy-broken', cron: 'banana' }));

      const res = await request(app).patch(`/api/tasks/${task.id}`).send({ enabled: false });

      expect(res.status).toBe(200);
      expect(store.getTask(task.id)?.enabled).toBe(false);
    });

    // …and the schedule itself is still fixable from that same state.
    it('accepts a repair to a cron that was already bad', async () => {
      const task = store.createTask(taskInput({ name: 'legacy-broken', cron: 'banana' }));

      const res = await request(app).patch(`/api/tasks/${task.id}`).send({ cron: '0 2 * * *' });

      expect(res.status).toBe(200);
      expect(store.getTask(task.id)?.cron).toBe('0 2 * * *');
    });

    // The pair that only a combined check catches: each half is fine on its own,
    // and croner still refuses the two together.
    it('reads the new cron against the timezone it will actually run in', async () => {
      const task = store.createTask(taskInput({ name: 'nightly', cron: '0 2 * * *' }));

      const res = await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ cron: '0 2 * * *', timezone: 'Asia/Tokyo' });

      expect(res.status).toBe(200);
      expect(store.getTask(task.id)?.timezone).toBe('Asia/Tokyo');
    });
  });
});
