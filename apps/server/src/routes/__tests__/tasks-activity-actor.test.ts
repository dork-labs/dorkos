/**
 * Who the Activity feed says created, paused, deleted or cancelled a task
 * (DOR-1829).
 *
 * This router has bars of its own, and none of them makes the person the only
 * possible caller — so the four hardcoded `actorType: 'user'` / `'You'` pairs it
 * carried were wrong in practice, not merely inconsistent with the extensions
 * router DOR-1801 fixed:
 *
 * - `POST /` PROPOSES an untrusted caller's schedule (parked and clamped) rather
 *   than refusing it, and writes the feed entry either way.
 * - `PATCH /:id` refuses only operator-only FIELDS; `enabled` is agent-writable,
 *   so an agent can pause somebody's schedule.
 * - `DELETE /:id` and `POST /runs/:id/cancel` run
 *   `requireOperatorCookieUnderLogin`, a deliberate no-op in the shipped
 *   login-off posture.
 *
 * Every case below runs in that shipped login-off posture, which is exactly where
 * the lie was reachable.
 *
 * @module routes/__tests__/tasks-activity-actor
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The one token the faked identity service knows about. */
const KNOWN_TOKEN = 'tok_known_agent';

/** A token in the shape agent identity actually mints — bare hex, no prefix. */
const REAL_SHAPED_TOKEN = 'a3f9c1e2b70d48a6915ce4d2f8b03c7e';

const IDENTITY = {
  agentPath: '/Users/dev/agents/researcher',
  displayName: 'Researcher',
  tierCeiling: 'act',
  createdAt: '2026-09-01T00:00:00.000Z',
};

vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) => (token === KNOWN_TOKEN ? IDENTITY : null),
  }),
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: false } : undefined),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../services/tasks/lifecycle/delete-task.js', () => ({
  removeScheduledTaskFile: vi.fn(async () => undefined),
}));

vi.mock('../../services/tasks/lifecycle/update-task-file.js', () => ({
  applyTaskFileUpdate: vi.fn(async () => ({ ok: true, changesFile: false })),
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { resolveAgentIdentity } from '../../middleware/agent-identity.js';
import { createScheduledTask } from '../../services/tasks/lifecycle/create-task.js';

vi.mock('../../services/tasks/lifecycle/create-task.js', () => ({
  createScheduledTask: vi.fn(),
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Every actor field an emitted event carried. */
interface EmittedActor {
  actorType: string;
  actorId?: string | null;
  actorLabel: string;
  summary: string;
}

let emitted: EmittedActor[];
let db: Db;
let store: TaskStore;
let schedule: Task;
let runId: string;

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue({ state: 'stopping' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

/** One write on this router, driven with whatever identity headers a test wants. */
type Drive = (headers: Record<string, string>) => Promise<{ status: number }>;

const ROUTES: Array<{ name: string; drive: Drive; expectStatus: number }> = [
  {
    name: 'POST /api/tasks',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/tasks')
        .set(headers)
        .send({ name: 'nightly-2', prompt: 'do the thing', cron: '0 3 * * *' }),
  },
  {
    name: 'PATCH /api/tasks/:id (pause)',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer)
        .patch(`/api/tasks/${schedule.id}`)
        .set(headers)
        .send({ enabled: false }),
  },
  {
    name: 'DELETE /api/tasks/:id',
    expectStatus: 200,
    drive: (headers) => request(fixtureServer).delete(`/api/tasks/${schedule.id}`).set(headers),
  },
  {
    name: 'POST /api/tasks/runs/:id/cancel',
    expectStatus: 200,
    drive: (headers) => request(fixtureServer).post(`/api/tasks/runs/${runId}/cancel`).set(headers),
  },
];

describe('who the Activity feed says changed a scheduled task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted = [];

    db = createTestDb();
    store = new TaskStore(db);
    schedule = store.createTask({
      name: 'nightly',
      description: 'approved and running',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    runId = store.createRun(schedule.id, 'scheduled').id;

    // The create path is a seam shared with the MCP tools; this router's share of
    // it is who asked and what the feed is told, so the lifecycle is a stub that
    // always succeeds.
    vi.mocked(createScheduledTask).mockResolvedValue({
      ok: true,
      task: store.createTask({
        name: 'nightly-2',
        description: 'freshly proposed',
        prompt: 'do the thing',
        cron: '0 3 * * *',
        filePath: '/tmp/tasks/nightly-2/SKILL.md',
      }),
    } as Awaited<ReturnType<typeof createScheduledTask>>);

    const activityService = {
      emit: vi.fn(async (event: EmittedActor) => {
        emitted.push(event);
      }),
    } as unknown as ActivityService;

    const scheduler = createMockScheduler();
    const app = express();
    app.use(express.json());
    app.use(resolveAgentIdentity);
    app.use(
      '/api/tasks',
      createTasksRouter(
        store,
        scheduler,
        new TaskRegistrar({ store, scheduler }),
        '/tmp/dork-test',
        undefined,
        activityService
      )
    );
    fixtureTarget.mount(app);
  });

  afterEach(() => {
    store.close();
  });

  describe.each(ROUTES)('$name', ({ drive, expectStatus }) => {
    it('records a browser write as the person', async () => {
      const res = await drive({});

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('records an identified agent as that agent, not as the person', async () => {
      const res = await drive({ 'x-dorkos-agent': KNOWN_TOKEN });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records a token that resolves to nothing as an unidentified caller', async () => {
      const res = await drive({ 'x-dorkos-agent': 'tok_nobody_knows' });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('never writes a real-shaped presented token into the feed', async () => {
      await drive({ 'x-dorkos-agent': REAL_SHAPED_TOKEN });

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(0, 16));
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(-16));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'system' });
    });
  });
});
