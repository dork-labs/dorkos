/**
 * `POST` and `PATCH /api/tasks` from one of our agents on a Trusted install
 * (ADR 261006-225605, spec `trusted-by-default-flip` §5.4): the agent's
 * schedule is armed at once and recorded as `schedule.armed_by_agent`, and its
 * own later edit keeps it live. A schedule made from a file still parks on an
 * agent's edit, a caller the server cannot identify still parks, and Careful
 * parks everything an agent makes.
 *
 * Real filesystem, real skills parser, real store and registrar, a mocked
 * scheduler. The agent's identity is set the way the identity middleware sets
 * it (`res.locals.agentIdentity`), only when the request carries the header.
 *
 * @module routes/__tests__/tasks-trusted-agent
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
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import type { Task } from '@dorkos/shared/types';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { raiseStanding } from '../../services/notifications/standing-events.js';

const posture = vi.hoisted(() => ({ preset: 'trusted' as 'trusted' | 'careful' }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: false }
        : key === 'permissions'
          ? { preset: posture.preset }
          : undefined,
  },
}));

vi.mock('../../services/notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));

const fixtureTarget = swappableServer();

/** The header an agent's request carries. */
const AGENT = ['x-dorkos-agent', 'agent-token-abc'] as const;

const SKILL = [
  '---',
  'name: drain',
  'description: A schedule discovery found in a file',
  'schedule:',
  "  cron: '0 9 * * *'",
  '---',
  'Drain the queue.',
].join('\n');

describe('tasks routes, one of our agents on a Trusted install', () => {
  let store: TaskStore;
  let dorkHome: string;
  let emit: ReturnType<typeof vi.fn>;

  /** Sync a SKILL.md the way the watcher and the reconciler do. */
  function resync(filePath: string): Task {
    const parsed = parseSkillFile(
      filePath,
      readFileSync(filePath, 'utf-8'),
      SkillFrontmatterSchema
    );
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    return store.fileSync.upsertFromFile(
      { ...parsed.definition, meta: parsed.definition.meta, scope: 'global' },
      undefined,
      { source: 'discovery', packageOwned: null }
    );
  }

  beforeEach(async () => {
    posture.preset = 'trusted';
    vi.mocked(raiseStanding).mockClear();
    emit = vi.fn();
    const scheduler = {
      isStarted: true,
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue([]),
    } as unknown as TaskSchedulerService;
    store = new TaskStore(createTestDb());
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-trusted-agent-')));

    const app = express();
    app.use(express.json());
    // What the identity middleware does for a live agent token.
    app.use((req, res, next) => {
      if (req.header(AGENT[0]) === AGENT[1]) {
        res.locals.agentIdentity = {
          agentPath: '/tmp/agents/nb',
          displayName: 'Nightly Bot',
          createdAt: '2026-10-01T00:00:00.000Z',
        };
      }
      next();
    });
    app.use(
      '/api/tasks',
      createTasksRouter(
        store,
        scheduler,
        new TaskRegistrar({ store, scheduler }),
        dorkHome,
        undefined,
        { emit } as unknown as ActivityService
      )
    );
    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  const BODY = {
    name: 'nightly-sweep',
    description: 'Sweep the backlog',
    prompt: 'Sweep the backlog.',
    cron: '0 3 * * *',
    target: 'global',
    reason: 'The overnight backlog needs sweeping before you start.',
  };

  /**
   * Create a schedule as the agent, or, when `identified` is false, as a caller
   * that claims to be an agent with a token that resolves to nobody.
   */
  const agentCreates = (identified = true) =>
    request(fixtureTarget.server)
      .post('/api/tasks')
      .set(AGENT[0], identified ? AGENT[1] : 'unknown-token')
      .send(BODY);

  it('arms an agent schedule at once and records it as armed by the agent', async () => {
    const res = await agentCreates();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(vi.mocked(raiseStanding)).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        eventType: 'schedule.armed_by_agent',
        resourceId: res.body.id,
      })
    );
  });

  it('keeps the agent’s own schedule live through its edit, and through the next sync', async () => {
    const created = (await agentCreates()).body as Task;

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${created.id}`)
      .set(...AGENT)
      .send({ prompt: 'Sweep the backlog and the inbox.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(vi.mocked(raiseStanding)).not.toHaveBeenCalled();
    // The grant moved with the edit, so discovery reading the new file agrees.
    expect(resync(created.filePath!).status).toBe('active');
  });

  it('still parks a schedule made from a file when the agent edits it', async () => {
    const dir = path.join(dorkHome, 'skills', 'drain');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');
    const found = resync(filePath);
    await request(fixtureTarget.server)
      .patch(`/api/tasks/${found.id}`)
      .send({ status: 'active', enabled: true });

    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${found.id}`)
      .set(...AGENT)
      .send({ prompt: 'Delete the queue.' });

    expect(res.body.status).toBe('pending_approval');
  });

  it('parks a schedule from a caller it cannot identify', async () => {
    const res = await agentCreates(false);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_approval');
  });

  it('parks an agent schedule on Careful', async () => {
    posture.preset = 'careful';

    const res = await agentCreates();

    expect(res.body.status).toBe('pending_approval');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'tasks.task_created' }));
  });
});
