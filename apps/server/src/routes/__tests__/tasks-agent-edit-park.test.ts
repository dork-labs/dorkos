/**
 * `PATCH /api/tasks/:id` by an agent on a schedule whose SKILL.md DorkOS
 * writes: the edit lands, and the schedule parks in the same request, with a
 * sentence that says what the agent changed and that the next sync keeps
 * (DOR-2313).
 *
 * Before, the route wrote the file and the row and left the schedule `active`;
 * the park came from the file watcher a moment later, or the reconciler within
 * five minutes, and until then the agent's new prompt could fire unapproved.
 * And any park DorkOS wrote was reworded by the next sync to "DorkOS found this
 * schedule in a file", a sentence that was false.
 *
 * Real filesystem, real skills parser, real store and registrar, a mocked
 * scheduler. The sync is driven the way discovery drives it
 * (`upsertFromFile` with `source: 'discovery'`), including once in the middle
 * of the request, between the file write and the row write, the window a
 * watcher event can land in.
 *
 * @module routes/__tests__/tasks-agent-edit-park
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { sql } from 'drizzle-orm';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import type { Task } from '@dorkos/shared/types';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import {
  AGENT_CONTENT_CHANGE_REASON,
  AGENT_SETTINGS_CHANGE_REASON,
  AGENT_TIMING_CHANGE_REASON,
} from '../../services/tasks/timing/effective-timing.js';
import { raiseStanding } from '../../services/notifications/standing-events.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

vi.mock('../../services/notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));

const fixtureTarget = swappableServer();

const SKILL = [
  '---',
  'name: drain',
  'description: A person’s own schedule',
  'schedule:',
  "  cron: '0 9 * * *'",
  '---',
  'Drain the queue.',
].join('\n');

/** The header an agent's request carries. */
const AGENT = ['x-dorkos-agent', 'agent-token-abc'] as const;

describe('PATCH /api/tasks/:id — an agent edits a file-backed schedule (DOR-2313)', () => {
  let db: Db;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let dorkHome: string;
  let filePath: string;

  /** Parse the file as it stands, the way discovery does. */
  function parseFile() {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    return {
      ...parsed.definition,
      meta: parsed.definition.meta,
      scope: 'global' as const,
      projectPath: undefined,
    };
  }

  /** Sync the file the way the watcher and the reconciler do. */
  async function resync(): Promise<Task> {
    return store.fileSync.upsertFromFile(parseFile(), undefined, {
      source: 'discovery',
      packageOwned: null,
    });
  }

  beforeEach(async () => {
    vi.mocked(raiseStanding).mockClear();
    scheduler = {
      isStarted: true,
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue(['2026-10-01T09:00:00.000Z']),
    } as unknown as TaskSchedulerService;
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-agent-park-')));
    const dir = path.join(dorkHome, 'skills', 'drain');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), dorkHome)
    );
    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** The schedule, discovered and approved by a person. */
  async function approvedTask(): Promise<Task> {
    const found = await resync();
    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${found.id}`)
      .send({ status: 'active', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    vi.mocked(raiseStanding).mockClear();
    vi.mocked(scheduler.unregisterTask).mockClear();
    return res.body as Task;
  }

  /** Send an agent's edit. */
  const agentEdit = (id: string, body: Record<string, unknown>) =>
    request(fixtureTarget.server)
      .patch(`/api/tasks/${id}`)
      .set(...AGENT)
      .send(body);

  it('parks at once when an agent changes what it does, and says so', async () => {
    // Purpose: the ticket. The new prompt must not be able to fire between the
    // request and a sync; the park happens in the request itself, and the
    // sentence names what the agent did rather than a timing change.
    const task = await approvedTask();

    const res = await agentEdit(task.id, { prompt: 'Delete the queue.' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      prompt: 'Delete the queue.',
      status: 'pending_approval',
      reason: AGENT_CONTENT_CHANGE_REASON,
      reasonSource: 'dorkos',
    });
    expect(await fs.readFile(filePath, 'utf-8')).toContain('Delete the queue.');
    expect(vi.mocked(scheduler.unregisterTask)).toHaveBeenCalledWith(task.id);
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledWith(
      'schedule.parked',
      expect.objectContaining({ taskId: task.id })
    );
  });

  it('says it was the timing when only the timing changed', async () => {
    const task = await approvedTask();

    const res = await agentEdit(task.id, { cron: '* * * * *' });

    expect(res.body).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_TIMING_CHANGE_REASON,
    });
  });

  it.each([
    ['runtime', { runtime: 'codex' }],
    ['model', { model: 'claude-opus-4' }],
    ['effort', { effort: 'high' }],
    ['time limit', { maxRuntime: '2h' }],
    ['memory of earlier runs', { sticky: true }],
    ['name', { name: 'drain-everything' }],
  ])('parks when an agent changes the %s, and says what changed (DOR-2323)', async (_, change) => {
    // Purpose: each of these changes what an unattended run does or costs; an
    // agent changing one must put the schedule back in front of a person, and
    // the card must be able to show old → new.
    const task = await approvedTask();

    const res = await agentEdit(task.id, change);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_SETTINGS_CHANGE_REASON,
      reasonSource: 'dorkos',
    });
    const [field] = Object.keys(change);
    expect(res.body.approvalChanges).toEqual([
      expect.objectContaining({ field: field === 'maxRuntime' ? 'maxRuntime' : field }),
    ]);
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledTimes(1);
  });

  it('shows the old and the new model and runtime on the parked schedule', async () => {
    const task = await approvedTask();

    const res = await agentEdit(task.id, { runtime: 'codex', model: 'gpt-5' });

    expect(res.body.approvalChanges).toEqual([
      { field: 'runtime', from: null, to: 'codex', via: 'schedule' },
      { field: 'model', from: null, to: 'gpt-5', via: 'schedule' },
    ]);
    expect((await resync()).approvalChanges).toEqual(res.body.approvalChanges);
  });

  it('keeps a person’s own change to how it runs approved', async () => {
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ model: 'claude-opus-4', effort: 'high' });

    expect(res.body.status).toBe('active');
    expect((await resync()).status).toBe('active');
  });

  it('leaves an agent’s edit of the description alone', async () => {
    // Purpose: the description changes nothing a run does, so it is not part
    // of the approval; the over-parking direction.
    const task = await approvedTask();

    const res = await agentEdit(task.id, { description: 'Tidier words' });

    expect(res.body.status).toBe('active');
    expect((await resync()).status).toBe('active');
  });

  it('keeps the park and its sentence through the next sync', async () => {
    // Purpose: the sync used to reword DorkOS's own park to "found in a file",
    // which is false. The content is the same one that was parked, so the
    // sentence is still true and stays.
    const task = await approvedTask();
    await agentEdit(task.id, { prompt: 'Delete the queue.' });

    const synced = await resync();
    const again = await resync();

    expect(synced).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_CONTENT_CHANGE_REASON,
    });
    expect(again).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_CONTENT_CHANGE_REASON,
    });
  });

  it('lets the sync say something new once the file changes again', async () => {
    // Purpose: the kept sentence is about the agent's edit; a later change to
    // the file is new work, and the sync's own words take over.
    const task = await approvedTask();
    await agentEdit(task.id, { prompt: 'Delete the queue.' });
    const text = await fs.readFile(filePath, 'utf-8');
    await fs.writeFile(filePath, text.replace('Delete the queue.', 'Archive the queue.'), 'utf-8');

    const synced = await resync();

    expect(synced.status).toBe('pending_approval');
    expect(synced.reason).not.toBe(AGENT_CONTENT_CHANGE_REASON);
  });

  it('keeps "this file changed" through later syncs, too', async () => {
    // Purpose: the same rewording hit a sync's own park. A person's approved
    // schedule whose file was edited by hand parks with "changed since it was
    // last approved"; the next sync of the same file must not call it "found".
    const task = await approvedTask();
    const text = await fs.readFile(filePath, 'utf-8');
    await fs.writeFile(filePath, text.replace('Drain the queue.', 'Archive the queue.'), 'utf-8');

    const first = await resync();
    const second = await resync();

    expect(first.id).toBe(task.id);
    expect(first.reason).toMatch(/changed since it was last approved/);
    expect(second).toMatchObject({ status: 'pending_approval', reason: first.reason });
  });

  it('shows a problem the file now has instead of the kept sentence', async () => {
    // Purpose: a validation problem is about the file and the person has to
    // see it, even while the content that would run is unchanged.
    const task = await approvedTask();
    await agentEdit(task.id, { prompt: 'Delete the queue.' });
    const PROBLEM = 'The schedule block has a setting DorkOS cannot read.';

    const synced = store.fileSync.upsertFromFile(parseFile(), undefined, {
      source: 'discovery',
      packageOwned: null,
      problem: PROBLEM,
    });

    expect(synced).toMatchObject({ status: 'pending_approval', reason: PROBLEM });
  });

  it('does not keep any other sentence on the row', async () => {
    // Purpose: only the park sentences that stay true at the same content are
    // kept; anything else DorkOS wrote is the file's to re-answer each sync.
    const task = await approvedTask();
    await agentEdit(task.id, { prompt: 'Delete the queue.' });
    db.run(sql`UPDATE pulse_schedules SET reason = 'Something else entirely.'`);

    const synced = await resync();

    expect(synced.status).toBe('pending_approval');
    expect(synced.reason).not.toBe('Something else entirely.');
  });

  it('writes its own sentence when it is the sync that parks the row', async () => {
    // Purpose: a sentence is only kept on a row that is ALREADY parked. A
    // running row that this sync parks (here, one holding no grant) is a new
    // park, and a leftover sentence from an older one must not describe it.
    const task = await approvedTask();
    await agentEdit(task.id, { prompt: 'Delete the queue.' });
    db.run(
      sql`UPDATE pulse_schedules SET status = 'active', approved_content_key = NULL WHERE id = ${task.id}`
    );

    const synced = await resync();

    expect(synced.status).toBe('pending_approval');
    expect(synced.reason).not.toBe(AGENT_CONTENT_CHANGE_REASON);
  });

  it('parks with the agent’s sentence when a sync lands mid-request', async () => {
    // Purpose: a watcher event between the file write and the row write parks
    // the row first, with the sync's sentence. The request still ends parked,
    // saying what the agent did, and raises the condition once.
    const task = await approvedTask();
    // The route writes the file, then the row: run one discovery sync of the
    // new file at the moment the row is about to be written, once.
    const writeRow = store.updateTask.bind(store);
    let raced = false;
    vi.spyOn(store, 'updateTask').mockImplementation((...args) => {
      if (!raced) {
        raced = true;
        const midway = store.fileSync.upsertFromFile(parseFile(), undefined, {
          source: 'discovery',
          packageOwned: null,
        });
        expect(midway.status).toBe('pending_approval');
      }
      return writeRow(...args);
    });

    const res = await agentEdit(task.id, { prompt: 'Delete the queue.' });

    expect(raced).toBe(true);
    expect(res.body).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_CONTENT_CHANGE_REASON,
      reasonSource: 'dorkos',
    });
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledTimes(1);
    expect((await resync()).reason).toBe(AGENT_CONTENT_CHANGE_REASON);
  });

  it('never switches anything on: a switched-off schedule stays off, park and sync alike', async () => {
    // Purpose: parking changes the status and the grant, never the switch.
    const task = await approvedTask();
    await request(fixtureTarget.server).patch(`/api/tasks/${task.id}`).send({ enabled: false });

    const res = await agentEdit(task.id, { prompt: 'Delete the queue.' });

    expect(res.body).toMatchObject({ enabled: false, status: 'pending_approval' });
    expect((await resync()).enabled).toBe(false);
  });

  it('leaves a schedule nobody approved yet exactly as it was', async () => {
    // Purpose: a park is for approved work; one already waiting keeps the
    // sync's own account of why.
    const found = await resync();
    expect(found.status).toBe('pending_approval');

    const res = await agentEdit(found.id, { prompt: 'Delete the queue.' });

    expect(res.body.status).toBe('pending_approval');
    expect(res.body.reason).not.toBe(AGENT_CONTENT_CHANGE_REASON);
    expect(vi.mocked(raiseStanding)).not.toHaveBeenCalled();
  });

  it('keeps a person’s own edit approved', async () => {
    // Purpose: the over-parking direction; a person changing their schedule is
    // the approval.
    const task = await approvedTask();

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ prompt: 'Archive the queue.' });

    expect(res.body.status).toBe('active');
    expect((await resync()).status).toBe('active');
  });
});
