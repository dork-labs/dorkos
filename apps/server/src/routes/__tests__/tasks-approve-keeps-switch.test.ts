/**
 * Nothing turns a scheduled task on except a person turning it on (DOR-3309).
 *
 * Approving a parked schedule changes its status and nothing else: a schedule
 * switched off before or while it waited stays off, unless the same request
 * says `enabled: true`. And a file change may switch a person's own schedule
 * off, never on: a `git pull` that brings back `enabled: true` leaves the row
 * off and offers "Turn on" instead.
 *
 * Real filesystem, real skills parser, real store and registrar, a mocked
 * scheduler; the sync is driven the way discovery drives it.
 *
 * @module routes/__tests__/tasks-approve-keeps-switch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import type { Task } from '@dorkos/shared/types';
import { createTasksRoutes } from '../tasks.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

vi.mock('../../services/notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));

const fixtureTarget = swappableServer();

/** A person's own schedule; no `enabled` line, so it reads as on. */
const SKILL = [
  '---',
  'name: weekly-report',
  'description: A person’s own schedule',
  'schedule:',
  "  cron: '0 8 * * 1'",
  '---',
  'Write the weekly report.',
].join('\n');

/** The header an agent's request carries. */
const AGENT = ['x-dorkos-agent', 'agent-token-abc'] as const;

describe('PATCH /api/tasks/:id — only a person turns a task on (DOR-3309)', () => {
  let store: TaskStore;
  let dorkHome: string;
  let filePath: string;

  /** Sync the file the way the watcher and the reconciler do. */
  function resync(): Task {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    const def = {
      ...parsed.definition,
      meta: parsed.definition.meta,
      scope: 'global' as const,
      projectPath: undefined,
    };
    return store.fileSync.upsertFromFile(def, undefined, {
      source: 'discovery',
      packageOwned: null,
    });
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    request(fixtureTarget.server).patch(`/api/tasks/${id}`).send(body);

  beforeEach(async () => {
    const scheduler = {
      isStarted: true,
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue(['2026-11-02T08:00:00.000Z']),
    } as unknown as TaskSchedulerService;
    store = new TaskStore(createTestDb());
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-keeps-switch-')));
    const dir = path.join(dorkHome, 'skills', 'weekly-report');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');
    fixtureTarget.mount(
      honoGroupListener({
        path: '/api/tasks',
        routes: createTasksRoutes({
          store,
          scheduler,
          registrar: new TaskRegistrar({ store, scheduler }),
          dorkHome,
        }),
      })
    );
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Discovered, approved and on, then switched off by a person. */
  async function switchedOffTask(): Promise<Task> {
    const found = resync();
    expect((await patch(found.id, { status: 'active', enabled: true })).status).toBe(200);
    const off = await patch(found.id, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, status: 'active' });
    // The watcher reads the `enabled: false` the route just wrote.
    expect(resync()).toMatchObject({ enabled: false, status: 'active' });
    return off.body as Task;
  }

  /** Park it again the way an agent's edit does. */
  async function parkByAgentEdit(id: string): Promise<void> {
    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${id}`)
      .set(...AGENT)
      .send({ prompt: 'Write the weekly report, briefly.' });
    expect(res.body).toMatchObject({ status: 'pending_approval', enabled: false });
  }

  it('approving a task that was switched off while it waited keeps it off', async () => {
    const task = await switchedOffTask();
    await parkByAgentEdit(task.id);

    const res = await patch(task.id, { status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', enabled: false });
    expect(store.getTask(task.id)).toMatchObject({ status: 'active', enabled: false });
  });

  it('approving with enabled: true in the same request turns it on', async () => {
    const task = await switchedOffTask();
    await parkByAgentEdit(task.id);

    const res = await patch(task.id, { status: 'active', enabled: true });

    expect(res.body).toMatchObject({ status: 'active', enabled: true });
  });

  it('writes enabled: false into the file when a person switches the task off', async () => {
    await switchedOffTask();

    expect(readFileSync(filePath, 'utf-8')).toMatch(/enabled: false/);
  });

  it('keeps the task off when the file comes back saying on, and offers Turn on', async () => {
    const task = await switchedOffTask();
    // What a `git pull` does: the old file, with no `enabled` line, comes back.
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const synced = resync();

    expect(synced).toMatchObject({ enabled: false, offersTurnOn: true });
    // The person's own file is left as the sync found it.
    expect(readFileSync(filePath, 'utf-8')).toBe(SKILL);
    expect((await request(fixtureTarget.server).get('/api/tasks')).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, offersTurnOn: true })])
    );
  });

  it('a person PATCHing enabled: true still turns it on, and answers the offer', async () => {
    const task = await switchedOffTask();
    await fs.writeFile(filePath, SKILL, 'utf-8');
    resync();

    const res = await patch(task.id, { enabled: true });

    expect(res.body).toMatchObject({ enabled: true, status: 'active', offersTurnOn: false });
    expect(resync()).toMatchObject({ enabled: true, offersTurnOn: false });
  });
});
