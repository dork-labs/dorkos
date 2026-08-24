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
 *   file got `max-runtime: null`, which the frontmatter schema rejects. From
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

import { parseSkillFile, readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskReconciler } from '../../services/tasks/task-reconciler.js';
import { ScheduleIdentityRegistry } from '../../services/tasks/schedule-identity.js';
import { skillsRoot } from '../../services/tasks/__tests__/task-root-fixtures.js';
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

  /** The SKILL.md a `target: 'global'` schedule lands at. */
  function skillPath(slug: string): string {
    return path.join(dorkHome, 'skills', slug, SKILL_FILENAME);
  }

  /**
   * The `schedule:` mapping exactly as it sits in the file.
   *
   * Read RAW rather than through the schema, because the whole question these
   * tests ask is which keys are PRESENT: the schema fills `timezone`, `enabled`
   * and `permissions` back in on the way past, so a parsed block can never show
   * that a cleared key is gone.
   */
  function rawSchedule(content: string): Record<string, unknown> {
    const raw = readRawFrontmatter(content);
    expect(raw, 'the file no longer has readable frontmatter').not.toBeNull();
    return (raw?.data.schedule ?? {}) as Record<string, unknown>;
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

      const parsed = parseSkillFile(skillPath('nightly-sweep'), raw, SkillFrontmatterSchema);
      expect(parsed.ok, `the file no longer parses: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;
      expect('max-runtime' in rawSchedule(raw)).toBe(false);
      expect(store.getTask(id)!.maxRuntime).toBeNull();
    });

    it('clears display-name, cron, and timezone the same way', async () => {
      const id = await createTask({ displayName: 'Nightly Sweep', timezone: 'Europe/Berlin' });

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ displayName: null, cron: null, timezone: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const raw = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');
      expect(raw).not.toContain('null');

      const parsed = parseSkillFile(skillPath('nightly-sweep'), raw, SkillFrontmatterSchema);
      expect(parsed.ok, `the file no longer parses: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;
      // `display-name` describes the SKILL and stays at the top level; the two
      // scheduling keys live in the block.
      expect('display-name' in (parsed.definition.meta as Record<string, unknown>)).toBe(false);
      for (const key of ['cron', 'timezone']) {
        expect(key in rawSchedule(raw), `${key} should be gone from the block`).toBe(false);
      }
      // A cleared timezone means the default, which the block writes by leaving
      // the key out — what matters is that it is not the literal null that made
      // the whole file unreadable.
      expect(store.getTask(id)!.timezone).toBe('UTC');
    });

    it('clears a cron all the way to the row, and lands the rest of the edit with it', async () => {
      // The cockpit's edit form sends `cron: cronTrimmed || null` on EVERY
      // save (`TaskFormInner.tsx`), so simply editing the prompt of an
      // on-demand task takes this path. The row's `cron` column is NOT NULL, so
      // a literal null threw out of `store.updateTask` AFTER the file had
      // already been rewritten — a 500 to the caller, and then the watcher
      // picking up the changed file seconds later and applying the "failed"
      // edit out of band. `''` is what "on demand" means in the column, exactly
      // as it does on create and on file sync.
      const id = await createTask({});

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ cron: null, prompt: 'sweep the backlog more gently' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const after = store.getTask(id)!;
      expect(after.cron).toBe('');
      expect(after.prompt).toBe('sweep the backlog more gently');

      const raw = await fs.readFile(skillPath('nightly-sweep'), 'utf-8');
      const parsed = parseSkillFile(skillPath('nightly-sweep'), raw, SkillFrontmatterSchema);
      expect(parsed.ok, `the file no longer parses: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;
      expect('cron' in rawSchedule(raw)).toBe(false);
      expect(parsed.definition.body).toBe('sweep the backlog more gently');
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

    it('answers 500 when the file cannot be READ for a reason other than "not there"', async () => {
      // ENOENT is the only read failure that means "legacy DB-only task". The
      // row here points at a directory, so the read fails with EISDIR — a real
      // failure, which must not be mistaken for a missing file and quietly
      // turned into a DB-only edit.
      const aDirectory = path.join(dorkHome, 'skills');
      await fs.mkdir(aDirectory, { recursive: true });
      const notAFile = store.createTask({
        name: 'unreadable',
        description: 'points at a directory',
        prompt: 'do a thing',
        cron: '0 5 * * *',
        filePath: aDirectory,
      });

      const res = await request(app)
        .patch(`/api/tasks/${notAFile.id}`)
        .send({ description: 'an edit that cannot be checked against the file' });

      expect(res.status).toBe(500);
      expect(String(res.body.error)).toMatch(/could not read/i);
      expect(store.getTask(notAFile.id)!.description).toBe('points at a directory');
    });

    it('answers 500 when the file reads but does not parse, and changes nothing', async () => {
      // The permanent path for any task already carrying the shipped
      // `max-runtime: null` corruption. The route used to fall straight through
      // an unparseable file to `store.updateTask` and answer 200 — the same
      // silent-success defect the write path had, one branch over, and the
      // reason a corrupted task had no symptom a person could see.
      const id = await createTask({});
      const before = store.getTask(id)!;
      await fs.writeFile(
        skillPath('nightly-sweep'),
        '---\nname: nightly-sweep\nmax-runtime: null\n---\nsweep the backlog\n',
        'utf-8'
      );

      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ description: 'an edit onto a broken file' });

      expect(res.status).toBe(500);
      expect(String(res.body.error)).toMatch(/could not make sense of/i);
      expect(String(res.body.error)).toContain('nightly-sweep');

      const after = store.getTask(id)!;
      expect(after.description).toBe(before.description);
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it('still updates a legacy DB-only task whose file is not there', async () => {
      // The behavior the broad catch was actually written for, kept: a row
      // pointing at a file that does not exist is edited in the DB alone.
      const legacy = store.createTask({
        name: 'legacy',
        description: 'from before the files',
        prompt: 'do a thing',
        cron: '0 4 * * *',
        filePath: path.join(dorkHome, 'skills', 'legacy', SKILL_FILENAME),
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

/**
 * Approving a schedule must not touch its file (DOR-1485 review, B1).
 *
 * Since schedulability became a frontmatter property, the route's read-merge-
 * write cycle could destroy the very thing it was reading: an unreadable
 * `schedule:` block parses to a complaint object, and merging that back replaced
 * the author's cron with `{invalid, problem}` — after which the next read saw a
 * valid EMPTY block, the schedule silently became on-demand, and the complaint
 * that explained why was gone. Every part of that was reachable by clicking
 * Approve, which changes nothing in the file at all.
 */
describe('PATCH /api/tasks/:id and a schedule-block file', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let dorkHome: string;
  let scheduler: TaskSchedulerService;

  /** A skill in the global skills root whose frontmatter carries a block. */
  async function writeBlockSkill(slug: string, block: string): Promise<string> {
    const dir = path.join(dorkHome, 'skills', slug);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, SKILL_FILENAME);
    await fs.writeFile(
      filePath,
      `---\nname: ${slug}\ndescription: A skill named ${slug}\nschedule:\n${block}\n---\nDo the thing.`,
      'utf-8'
    );
    return filePath;
  }

  /** Seed the row discovery would have made, parked and waiting. */
  function seedParked(slug: string, filePath: string, cron: string): string {
    const task = store.createTask({
      name: slug,
      description: `A skill named ${slug}`,
      prompt: 'Do the thing.',
      cron,
      timezone: 'UTC',
      filePath,
    });
    store.updateTask(task.id, { status: 'pending_approval' });
    return task.id;
  }

  beforeEach(async () => {
    state.writeFailure = null;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-tasks-block-'));

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

  it('leaves the file byte-identical when a schedule is approved', async () => {
    const filePath = await writeBlockSkill('nightly', "  cron: '0 9 * * *'");
    const before = await fs.readFile(filePath, 'utf-8');
    const id = seedParked('nightly', filePath, '0 9 * * *');

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: 'active', enabled: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
    expect(store.getTask(id)!.status).toBe('active');
  });

  it('refuses to arm a schedule whose block does not read, and says why', async () => {
    const filePath = await writeBlockSkill('broken', '  permissions: yolo');
    const before = await fs.readFile(filePath, 'utf-8');
    const id = seedParked('broken', filePath, '');

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: 'active', enabled: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('permissions');
    // Refused whole: the file is untouched and the schedule is still waiting,
    // where the person can see the complaint.
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
    expect(store.getTask(id)!.status).toBe('pending_approval');
  });

  it('writes a cron edit into the block, never at the top level', async () => {
    const filePath = await writeBlockSkill('nightly', "  cron: '0 9 * * *'");
    const id = seedParked('nightly', filePath, '0 9 * * *');

    const res = await request(app).patch(`/api/tasks/${id}`).send({ cron: '0 21 * * *' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const raw = await fs.readFile(filePath, 'utf-8');
    // The cron lives INSIDE the block — indented under `schedule:` — and there
    // is exactly one of it. A file carrying a second, top-level `cron:` beside
    // the block disagrees with itself forever: the row follows the block, so
    // every sync reverts the edit and re-parks the schedule.
    expect(raw).toMatch(/schedule:\n\s+cron: '?0 21 \* \* \*'?/);
    expect(raw.match(/cron:/g)).toHaveLength(1);
    expect(raw).not.toMatch(/^cron:/m);
  });

  it('never rewrites a skill an installed package owns', async () => {
    // Global installs live at `<dorkHome>/plugins` — the data directory IS the
    // scope root, the way `conflict-detector.ts` computes it.
    const dir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'owned');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, SKILL_FILENAME);
    await fs.writeFile(
      filePath,
      "---\nname: owned\ndescription: A packaged skill\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.",
      'utf-8'
    );
    const before = await fs.readFile(filePath, 'utf-8');
    const id = seedParked('owned', filePath, '0 9 * * *');

    const res = await request(app).patch(`/api/tasks/${id}`).send({ cron: '0 21 * * *' });

    expect(res.status).toBe(409);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  // The gap between the file write and the row write. A watcher event landing in
  // it syncs the NEW file against the OLD row, and the arm gate parks the row —
  // after which the route's own update would have written the caller's other
  // fields over a schedule that was now silently waiting (DOR-1485 review, I2).
  it('keeps the status the caller asked for when a sync parks the row mid-write', async () => {
    const filePath = await writeBlockSkill('racy', "  cron: '0 9 * * *'");
    const id = seedParked('racy', filePath, '0 9 * * *');
    store.updateTask(id, { status: 'active' });

    // Stand in for the watcher firing between the two writes.
    const realUpdate = store.updateTask.bind(store);
    let raced = false;
    vi.spyOn(store, 'updateTask').mockImplementation((taskId, data) => {
      if (!raced) {
        raced = true;
        realUpdate(taskId, { status: 'pending_approval' });
      }
      return realUpdate(taskId, data);
    });

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: 'active', cron: '0 21 * * *' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    vi.restoreAllMocks();
    expect(store.getTask(id)!.status).toBe('active');
  });
});

/**
 * Editing a live schedule must not quietly disarm it (DOR-1485 review, R1).
 *
 * The arm grant is keyed on the schedule's content, so any edit invalidates it.
 * That is right for a file DorkOS found and wrong for a person using the
 * cockpit: they changed the prompt, they are standing right there, and the next
 * sync five minutes later would park their own schedule and tell them its file
 * had changed. Re-issuing the grant is the route's job and only for a caller
 * that cleared the agent bar — an agent that rewrites an approved schedule must
 * still send it back for a look.
 */
describe('PATCH /api/tasks/:id and a live schedule’s approval', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let dorkHome: string;
  let scheduler: TaskSchedulerService;
  let registrar: TaskRegistrar;
  let reconciler: TaskReconciler;

  beforeEach(async () => {
    state.writeFailure = null;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    registrar = new TaskRegistrar({ store, scheduler });
    reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-tasks-approval-'));
    await fs.mkdir(path.join(dorkHome, 'skills'), { recursive: true });
    reconciler.addRoot(skillsRoot(path.join(dorkHome, 'skills'), 'global'));

    app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter(store, scheduler, registrar, dorkHome));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** An operator-created, already-live schedule. */
  async function liveSchedule(): Promise<string> {
    const res = await request(app).post('/api/tasks').send({
      name: 'nightly-sweep',
      description: 'sweeps the backlog',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      target: 'global',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('active');
    return res.body.id as string;
  }

  it('keeps a schedule armed when a person edits what it does', async () => {
    const id = await liveSchedule();

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ prompt: 'sweep the backlog and file anything stale' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('active');

    // The five minutes later that used to undo it.
    await reconciler.reconcile();

    expect(store.getTask(id)!.status).toBe('active');
    expect(store.getTask(id)!.reason).toBeNull();
  });

  it('keeps a schedule armed when a person edits when it runs', async () => {
    const id = await liveSchedule();

    await request(app).patch(`/api/tasks/${id}`).send({ cron: '0 21 * * *' });
    await reconciler.reconcile();

    expect(store.getTask(id)!.status).toBe('active');
    expect(store.getTask(id)!.cron).toBe('0 21 * * *');
  });

  // The other half, and the reason this lives in the route rather than in
  // `updateTask`: `prompt` and `cron` are agent-writable, so re-keying on every
  // content write would let an agent rewrite an approved schedule and keep it
  // armed — the substitution the bypass clamp exists to refuse.
  it('sends a schedule back for approval when an AGENT edits what it does', async () => {
    const id = await liveSchedule();

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ prompt: 'sweep the backlog and then delete everything' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await reconciler.reconcile();

    const after = store.getTask(id)!;
    expect(after.status).toBe('pending_approval');
    expect(after.reason).toMatch(/changed since/i);
  });

  it('does not re-approve a schedule that was already waiting', async () => {
    const id = await liveSchedule();
    await request(app).patch(`/api/tasks/${id}`).send({ status: 'pending_approval' });

    await request(app).patch(`/api/tasks/${id}`).send({ prompt: 'something else' });
    await reconciler.reconcile();

    expect(store.getTask(id)!.status).toBe('pending_approval');
  });
});
