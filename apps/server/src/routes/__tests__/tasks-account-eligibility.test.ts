/**
 * Schedules hold to the account rules (spec `flow-multiproject` §8.4, the
 * three schedule rows) at the HTTP door:
 *
 * - a save naming an account that may not work where the runs start is
 *   refused `409 account_not_allowed_here` with the plain sentence, whoever
 *   saves it, an agent's proposal or a person's own pick (spec D7), and
 *   nothing is saved;
 * - the same answer on `PATCH`, with nothing changed.
 *
 * Real store, registrar and create lifecycle; the rules live in a stand-in
 * config, and every folder a run starts in is one project (`/work/project`),
 * so the rules alone decide.
 *
 * @module routes/__tests__/tasks-account-eligibility
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: false };
      if (key === 'runtimes') return { claudeCode: rules.claudeCode };
      return undefined;
    },
  },
}));

vi.mock('../../services/core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async () => ({ root: '/work/project', name: 'project' })),
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/types';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../../services/activity/activity-service.js';

const fixtureTarget = swappableServer();
const AGENT = ['x-dorkos-agent', 'agent-token-abc'] as const;

const SENTENCE =
  "Client Work can't be used in project. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes.";

let store: TaskStore;
let dorkHome: string;
let emit: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  rules.claudeCode = {
    accounts: [
      { id: 'work', path: '/accounts/work', label: 'Work', onlyProjects: null },
      {
        id: 'client',
        path: '/accounts/client',
        label: 'Client Work',
        onlyProjects: ['/clients/client-app'],
      },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
  const scheduler = {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
  store = new TaskStore(createTestDb());
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-task-acct-')));
  emit = vi.fn(async () => undefined);
  const app = express();
  app.use(express.json());
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
  name: 'nightly',
  description: 'Sweep the queue',
  prompt: 'sweep it',
  cron: '0 3 * * *',
  target: 'global',
};

/** An agent's proposal must say why the schedule should exist. */
const PROPOSAL_REASON = 'The queue backs up overnight.';

describe('POST /api/tasks — the account rule', () => {
  it("refuses an agent's proposal naming an account that may not work there, saving nothing", async () => {
    const res = await request(fixtureTarget.server)
      .post('/api/tasks')
      .set(...AGENT)
      .send({ ...BODY, reason: PROPOSAL_REASON, account: 'client' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: SENTENCE, code: 'account_not_allowed_here' });
    expect(store.getTasks()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("proposes an agent's schedule on an account that may work there (control)", async () => {
    const res = await request(fixtureTarget.server)
      .post('/api/tasks')
      .set(...AGENT)
      .send({ ...BODY, reason: PROPOSAL_REASON, account: 'work' });
    expect(res.status).toBe(201);
    expect(store.getTasks()).toHaveLength(1);
  });

  // Purpose: a person's own pick is held to the rule too (D7): refused with
  // the plain sentence the schedule dialog shows, and nothing is saved.
  it("refuses a person's save naming an account that may not work there", async () => {
    const res = await request(fixtureTarget.server)
      .post('/api/tasks')
      .send({ ...BODY, account: 'client' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: SENTENCE, code: 'account_not_allowed_here' });
    expect(store.getTasks()).toHaveLength(0);
  });

  it("saves a person's schedule on an allowed account (control)", async () => {
    const res = await request(fixtureTarget.server)
      .post('/api/tasks')
      .send({ ...BODY, account: 'work' });
    expect(res.status).toBe(201);
    expect(store.getTasks()).toHaveLength(1);
  });
});

describe('PATCH /api/tasks/:id — the account rule', () => {
  async function personTask(): Promise<Task> {
    const res = await request(fixtureTarget.server)
      .post('/api/tasks')
      .send({ ...BODY, account: 'work' });
    expect(res.status).toBe(201);
    emit.mockClear();
    return res.body as Task;
  }

  it('refuses an agent pointing a schedule at an account that may not work there', async () => {
    const task = await personTask();
    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .set(...AGENT)
      .send({ account: 'client' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: SENTENCE,
      code: 'account_not_allowed_here',
      accountId: 'client',
      project: { root: '/work/project', name: 'project' },
    });
    expect(store.getTask(task.id)?.account).toBe('work');
  });

  // Purpose: a person's edit is refused the same way, and nothing changes.
  it("refuses a person's edit to an account that may not work there", async () => {
    const task = await personTask();
    const res = await request(fixtureTarget.server)
      .patch(`/api/tasks/${task.id}`)
      .send({ account: 'client' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: SENTENCE, code: 'account_not_allowed_here' });
    expect(store.getTask(task.id)?.account).toBe('work');
  });
});
