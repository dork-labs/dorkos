/**
 * Whose schedule an agent may make or change over HTTP (DOR-3640 R1). A
 * schedule runs as the agent it is filed under, so an agent may file one only
 * under itself or `global`, and may change only its own (or a global one no
 * other agent made). A person is unchanged. Every change leaves an audit row
 * naming the fields it changed, and a prompt change only by its hashes.
 *
 * @module routes/__tests__/tasks-agent-owner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/schemas';

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: false }
        : key === 'permissions'
          ? { preset: 'trusted' }
          : undefined,
  },
}));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

import { createTasksRoutes } from '../tasks.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import { promptHashOf } from '../../services/tasks/approvals/schedule-owner.js';

const target = swappableServer();

let store: TaskStore;
let scratch: string;
let homeA: string;
let homeB: string;
let identity: AgentIdentity | undefined;
let ownedByB: Task;
let ownedByA: Task;

function mesh(): MeshCore {
  const agents = [
    { id: 'agent-a', name: 'a', projectPath: homeA },
    { id: 'agent-b', name: 'b', projectPath: homeB },
  ];
  return {
    listWithPaths: () => agents,
    getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
    get: (id: string) => agents.find((a) => a.id === id),
  } as unknown as MeshCore;
}

beforeEach(async () => {
  vi.mocked(recordAudit).mockClear();
  identity = undefined;
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-owner-')));
  homeA = path.join(scratch, 'a');
  homeB = path.join(scratch, 'b');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(homeB, { recursive: true });
  store = new TaskStore(createTestDb());
  const row = (name: string, agentId: string) =>
    store.createTask({
      name,
      description: name,
      prompt: `the prompt of ${name}`,
      cron: '0 2 * * *',
      agentId,
      filePath: path.join(scratch, 'no-file', name, 'SKILL.md'),
    });
  ownedByB = row('b-nightly', 'agent-b');
  ownedByA = row('a-nightly', 'agent-a');
  const scheduler = {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
  target.mount(
    honoGroupListener(
      {
        path: '/api/tasks',
        routes: createTasksRoutes({
          store,
          scheduler,
          registrar: new TaskRegistrar({ store, scheduler }),
          dorkHome: scratch,
          meshCore: mesh(),
        }),
      },
      {
        before: (c, next) => {
          if (identity) c.set('agentIdentity', identity);
          return next();
        },
      }
    )
  );
});

afterEach(async () => {
  store.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

const asA = () => {
  identity = { agentPath: homeA, displayName: 'Agent A', createdAt: '2026-11-01T00:00:00Z' };
};

const patch = (id: string, body: object, agent = true) => {
  const req = request(target.server).patch(`/api/tasks/${id}`);
  return (agent ? req.set('x-dorkos-agent', 'token-a') : req).send(body);
};

const create = (body: object) =>
  request(target.server)
    .post('/api/tasks')
    .set('x-dorkos-agent', 'token-a')
    .send({
      name: 'sweep',
      description: 'sweep',
      prompt: 'Sweep.',
      cron: '0 3 * * *',
      reason: 'The backlog needs it.',
      ...body,
    });

describe('POST /api/tasks from an agent', () => {
  it('refuses a schedule filed under another agent', async () => {
    asA();
    const res = await create({ target: 'agent-b' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_agent');
  });

  it('files one under itself, or a global one', async () => {
    asA();
    expect((await create({ target: 'agent-a' })).status).toBe(201);
    expect((await create({ target: 'global', name: 'sweep-2' })).status).toBe(201);
  });
});

describe('POST /api/tasks from a revoked agent token (DOR-3666)', () => {
  it('parks, never arms, and credits nobody', async () => {
    identity = {
      agentPath: homeA,
      displayName: 'Agent A',
      createdAt: '2026-11-01T00:00:00Z',
      inactive: 'revoked',
    };
    // Its own id: the one target a live token of A's would arm unasked on Trusted.
    const res = await create({ target: 'agent-a', name: 'revoked-sweep' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.proposedByAgentPath).toBeNull();
  });
});

describe('PATCH /api/tasks/:id from an agent', () => {
  it("refuses a change to another agent's schedule, and changes nothing", async () => {
    asA();
    const res = await patch(ownedByB.id, { prompt: 'Do something else.' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_schedule');
    expect(store.getTask(ownedByB.id)!.prompt).toBe('the prompt of b-nightly');
  });

  it("may still pause another agent's schedule, which only takes power away", async () => {
    asA();
    const res = await patch(ownedByB.id, { enabled: false });
    expect(res.status).toBe(200);
    expect(store.getTask(ownedByB.id)!.enabled).toBe(false);
  });

  it("refuses a caller DorkOS cannot name, changing an agent's schedule", async () => {
    // A token that resolves to nobody: the header says agent, the chain names none.
    const res = await patch(ownedByB.id, { enabled: true, prompt: 'Run as B.' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_schedule');
  });

  it('changes its own', async () => {
    asA();
    const res = await patch(ownedByA.id, { enabled: false });
    expect(res.status).toBe(200);
  });

  it('records which fields changed, and a prompt only by its hashes', async () => {
    asA();
    await patch(ownedByA.id, { enabled: false });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tasks.update',
        change: [{ field: 'enabled', before: true, after: false }],
      })
    );

    vi.mocked(recordAudit).mockClear();
    await patch(ownedByA.id, { prompt: 'A new prompt.' });
    const row = vi.mocked(recordAudit).mock.calls.find((c) => c[0].action === 'tasks.update')![0];
    expect(row.change).toEqual([
      {
        field: 'prompt',
        before: promptHashOf('the prompt of a-nightly'),
        after: promptHashOf('A new prompt.'),
      },
      { field: 'status', before: 'active', after: 'pending_approval' },
    ]);
    expect(JSON.stringify(row)).not.toContain('A new prompt.');
  });
});

describe('a person', () => {
  it("may change any agent's schedule, as before", async () => {
    const res = await patch(ownedByB.id, { enabled: false }, false);
    expect(res.status).toBe(200);
  });
});
