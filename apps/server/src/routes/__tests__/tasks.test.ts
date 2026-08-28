import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore, type CreateTaskStoreInput } from '../../services/tasks/task-store.js';
import {
  TaskSchedulerService,
  type SchedulerAgentManager,
} from '../../services/tasks/task-scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { RelayCore } from '@dorkos/relay';
import {
  EscalationService,
  setEscalationService,
} from '../../services/notifications/escalation-service.js';
import type { NotificationStore } from '../../services/notifications/notification-store.js';
import type { WebPushChannel } from '../../services/notifications/channels/web-push.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/index.js';

/** The directory a proposing agent lives in — the key its identity is stored under. */
const AGENT_PATH = '/tmp/agents/nightly-bot';

/**
 * The data directory this suite mounts its router on, and the prefix its
 * `fs.readFile` mock treats as "a file the route just wrote".
 *
 * One constant because the two MUST agree. The mock answers a path under this
 * prefix with empty content and every other path with ENOENT, and the update
 * route reads those as two different worlds — "a file that is there" versus
 * "a legacy row with no file" (DOR-1481). If the prefix and the `dorkHome`
 * argument ever drifted apart, fixtures would quietly cross into the other
 * branch and the tests would still pass, for the wrong reason.
 *
 * `vi.hoisted` because the `vi.mock` factories below are hoisted above ordinary
 * module scope and could not otherwise see it.
 */
const DORK_HOME = vi.hoisted(() => '/tmp/dork-test');

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

/**
 * Stand in for the config manager, so these tests run in the default posture
 * (login off) rather than the fail-closed one.
 *
 * Without this the singleton is `undefined` here, and `resolveDecisionAuthority`
 * FAILS CLOSED by design: `if (!manager) return true` reports login as ENABLED,
 * so no caller is trusted, every created task parks at `pending_approval`, and
 * every operator-only write is refused (DOR-504).
 *
 * That branch is the actual guarantee, and it is worth stating in preference to
 * the boot order. `index.ts` does call `initConfigManager` before any router
 * mounts, but nothing here rests on that: if somebody reordered boot, the
 * failure would be a visibly broken cockpit that refuses its own writes, never a
 * caller slipping through as trusted. The fail-closed branch is unconditional;
 * the line numbers are what rot.
 */
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

vi.mock('@dorkos/skills/writer', () => ({
  writeSkillFile: vi.fn().mockResolvedValue(`${DORK_HOME}/tasks/test/SKILL.md`),
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
      // A path the POST path just "wrote" reads back empty; every other path is
      // a row fixture with no file behind it, and the honest answer for those is
      // ENOENT. The update route now tells that apart from a file it cannot read
      // or parse, and only ENOENT means "legacy DB-only task, edit the row alone"
      // (DOR-1481) — so a blanket empty read would make every fixture here look
      // like a file whose contents are unparseable garbage.
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.startsWith(`${DORK_HOME}/`)) return '';
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
          code: 'ENOENT',
        });
      }),
    },
  };
});

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

function createMockScheduler(): TaskSchedulerService {
  return {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    previewNextRuns: vi.fn().mockReturnValue([...PREVIEWED_RUNS]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

/**
 * What the mocked scheduler's cron preview answers.
 *
 * Deliberately different from `getNextRun`'s fixed date, so a route that
 * confused the two — or dropped one — cannot pass by returning the other. The
 * cron math itself is proved against real expressions in
 * `services/tasks/__tests__/task-scheduler-service.test.ts`; what these route
 * tests prove is that the answer is asked for and carried.
 */
const PREVIEWED_RUNS = [
  '2026-04-01T02:00:00.000Z',
  '2026-04-02T02:00:00.000Z',
  '2026-04-03T02:00:00.000Z',
];

/**
 * Install a real escalation ladder for the cases that assert one is armed.
 *
 * Not wired in `beforeEach`, because every OTHER case here should run with no
 * ladder at all — `armEscalation` is a no-op then, which is exactly the
 * boot-order posture the routes have to survive.
 */
function wireEscalationService(): EscalationService {
  const service = new EscalationService({
    store: {
      hasEscalated: () => false,
      wasAcknowledged: () => false,
      recordDelivery: () => {},
    } as unknown as NotificationStore,
    push: { sendToAll: vi.fn() } as unknown as WebPushChannel,
    readDelay: () => 2,
  });
  setEscalationService(service);
  return service;
}

describe('Tasks routes', () => {
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
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), DORK_HOME)
    );
    // Error handler to surface errors instead of hanging
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      }
    );
  });

  afterEach(() => {
    store.close();
    // Whether or not a case wired one, so a ladder never leaks into the next.
    setEscalationService(null);
    // Likewise the identity singleton: a case that minted one must not leave a
    // later case resolving a name it never asked for.
    resetAgentIdentityService();
  });

  describe('GET /api/tasks', () => {
    it('returns empty array when no schedules', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns schedules with nextRun', async () => {
      store.createTask(taskInput({ name: 'Test', prompt: 'p', cron: '0 * * * *' }));

      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Test');
      expect(res.body[0].nextRun).toBe('2026-03-01T00:00:00.000Z');
    });

    it('previews a parked schedule’s next runs, from its own cron and timezone (DOR-1394)', async () => {
      const parked = store.createTask(
        taskInput({ name: 'Parked', prompt: 'p', cron: '0 3 * * *', timezone: 'Asia/Tokyo' })
      );
      store.updateTask(parked.id, { status: 'pending_approval' });

      const res = await request(app).get('/api/tasks');

      expect(res.body[0].nextRuns).toEqual(PREVIEWED_RUNS);
      // Asked with what the task actually says, not with a default — a preview
      // computed from the wrong timezone is worse than none.
      expect(scheduler.previewNextRuns).toHaveBeenCalledWith('0 3 * * *', 'Asia/Tokyo', 3);
    });

    it('gives a schedule waiting for approval a nextRun, which the scheduler cannot', async () => {
      const parked = store.createTask(
        taskInput({ name: 'Parked', prompt: 'p', cron: '0 3 * * *' })
      );
      store.updateTask(parked.id, { status: 'pending_approval' });
      // A parked schedule is never registered, so the live job has no answer —
      // this is exactly the row where nextRun used to be null.
      vi.mocked(scheduler.getNextRun).mockReturnValue(null);

      const res = await request(app).get('/api/tasks');

      expect(res.body[0].nextRun).toBe(PREVIEWED_RUNS[0]);
      expect(res.body[0].nextRuns).toEqual(PREVIEWED_RUNS);
    });

    it('does not read the cron of a task nobody is being asked to approve', async () => {
      // Reading a cron builds a throwaway job and asks it for three occurrences,
      // and this route runs over every task on every cockpit poll. Only the
      // approval card consumes `nextRuns`, and it only ever shows parked rows —
      // so an active task must not pay for an answer nothing reads (DOR-1394).
      store.createTask(taskInput({ name: 'Active', prompt: 'p', cron: '0 3 * * *' }));

      const res = await request(app).get('/api/tasks');

      expect(res.body[0].nextRuns).toEqual([]);
      expect(scheduler.previewNextRuns).not.toHaveBeenCalled();
      // The live job still answers, exactly as it always did.
      expect(res.body[0].nextRun).toBe('2026-03-01T00:00:00.000Z');
    });

    it('still says nothing about when a paused schedule runs', async () => {
      const paused = store.createTask(
        taskInput({ name: 'Paused', prompt: 'p', cron: '0 3 * * *', enabled: false })
      );
      store.updateTask(paused.id, { enabled: false });
      vi.mocked(scheduler.getNextRun).mockReturnValue(null);

      const res = await request(app).get('/api/tasks');

      // Home reads `nextRun` to say what happens next. A time here would be a
      // promise nothing is keeping.
      expect(res.body[0].nextRun).toBeNull();
      expect(res.body[0].nextRuns).toEqual([]);
    });

    it('carries an agent proposal’s reason and provenance through to the operator', async () => {
      store.createTask(
        taskInput({
          name: 'Proposed',
          prompt: 'p',
          cron: '0 3 * * *',
          reason: 'The overnight backlog needs sweeping before you start.',
          proposedBySessionId: 'ses-42',
          proposedByAgentPath: AGENT_PATH,
        })
      );

      const res = await request(app).get('/api/tasks');

      expect(res.body[0].reason).toBe('The overnight backlog needs sweeping before you start.');
      expect(res.body[0].proposedBySessionId).toBe('ses-42');
      expect(res.body[0].proposedByAgentPath).toBe(AGENT_PATH);
    });

    it('names the proposer, resolved from the live agent identity', async () => {
      // A real identity service with a real minted token, because the point is
      // that the route RESOLVES the name — asserting `null` in an app where null
      // is the only possible answer would pass whether or not it did (DOR-1394
      // review).
      const identity = initAgentIdentityService(db);
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      store.createTask(
        taskInput({
          name: 'Proposed',
          prompt: 'p',
          cron: '0 3 * * *',
          proposedByAgentPath: AGENT_PATH,
        })
      );

      const res = await request(app).get('/api/tasks');

      expect(res.body[0].proposedByName).toBe('Nightly Bot');
    });

    it('says nothing about a proposer whose agent has been revoked', async () => {
      const identity = initAgentIdentityService(db);
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      await identity.revoke(AGENT_PATH);
      store.createTask(
        taskInput({
          name: 'Proposed',
          prompt: 'p',
          cron: '0 3 * * *',
          proposedByAgentPath: AGENT_PATH,
        })
      );

      const res = await request(app).get('/api/tasks');

      // The name is never stored, so switching an agent off stops crediting it.
      expect(res.body[0].proposedByName).toBeNull();
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a schedule', async () => {
      const res = await request(app).post('/api/tasks').send({
        name: 'New',
        description: 'do stuff',
        prompt: 'do stuff',
        cron: '0 2 * * *',
        target: 'global',
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('new');
      expect(res.body.id).toBeDefined();
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/tasks').send({ name: 'No cron' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('refuses a name that slugifies to the reserved templates folder', async () => {
      const res = await request(app).post('/api/tasks').send({
        name: 'Templates',
        description: 'clashes with the templates container',
        prompt: 'do stuff',
        cron: '0 2 * * *',
        target: 'global',
      });

      // Allowing it would write a file the reconciler skips by name, and then
      // retire the row the watcher created for it.
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reserved');
      expect(store.getTasks()).toHaveLength(0);
    });

    it('registers cron job for enabled active schedule', async () => {
      await request(app).post('/api/tasks').send({
        name: 'Active',
        description: 'p',
        prompt: 'p',
        cron: '0 * * * *',
        target: 'global',
      });

      expect(scheduler.registerTask).toHaveBeenCalled();
    });

    it('returns nextRun in the creation response, matching the list endpoint', async () => {
      const res = await request(app).post('/api/tasks').send({
        name: 'Next Run',
        description: 'p',
        prompt: 'p',
        cron: '0 * * * *',
        target: 'global',
      });

      expect(res.status).toBe(201);
      // The mocked scheduler.getNextRun() always resolves to this fixed date —
      // the create response must carry it, not the store's default null.
      expect(res.body.nextRun).toBe('2026-03-01T00:00:00.000Z');
      // No preview: this caller cleared the agent bar, so the task is `active`
      // and nobody is being asked to approve it.
      expect(res.body.nextRuns).toEqual([]);
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates a schedule', async () => {
      const sched = store.createTask(taskInput({ name: 'old', prompt: 'p', cron: '0 * * * *' }));

      // `name` on an update must be a slug — it is written straight into the
      // SKILL.md frontmatter, which enforces that rule (`UpdateTaskRequest.name`).
      const res = await request(app).patch(`/api/tasks/${sched.id}`).send({ name: 'updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('updated');
      // The patch response is a task like any other, so it carries the same
      // derived fields the list does — and for an active task that means no
      // preview, exactly as the list reports.
      expect(res.body.nextRuns).toEqual([]);
    });

    it('sends back the preview when the patch is what parked the schedule', async () => {
      // The approval card reads this reply: a schedule PATCHed into
      // `pending_approval` has to come back carrying the times it would fire,
      // or the card that renders from this response has nothing to show until a
      // full list refetch.
      const sched = store.createTask(taskInput({ name: 'ToPark', prompt: 'p', cron: '0 3 * * *' }));
      vi.mocked(scheduler.getNextRun).mockReturnValue(null);

      const res = await request(app)
        .patch(`/api/tasks/${sched.id}`)
        .send({ status: 'pending_approval' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_approval');
      expect(res.body.nextRuns).toEqual(PREVIEWED_RUNS);
      expect(res.body.nextRun).toBe(PREVIEWED_RUNS[0]);
    });

    it('names the proposer in its own reply, not only in the list', async () => {
      // The single-task path (`present`) and the list path (`presentAll`) are
      // two functions, and a probe proved the list tests alone leave the first
      // one free to stop resolving names entirely (DOR-1394 review). The
      // approval card renders from THIS reply after an approve or a park.
      const identity = initAgentIdentityService(db);
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      const sched = store.createTask(
        taskInput({
          name: 'Proposed',
          prompt: 'p',
          cron: '0 3 * * *',
          proposedByAgentPath: AGENT_PATH,
        })
      );

      const res = await request(app).patch(`/api/tasks/${sched.id}`).send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.proposedByName).toBe('Nightly Bot');
    });

    it('keeps a reason sent with a park', async () => {
      const sched = store.createTask(taskInput({ name: 'ToPark', prompt: 'p', cron: '0 3 * * *' }));

      const res = await request(app)
        .patch(`/api/tasks/${sched.id}`)
        .send({ status: 'pending_approval', reason: 'Parking this until I check the cron.' });

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('Parking this until I check the cron.');
      expect(store.getTask(sched.id)!.reason).toBe('Parking this until I check the cron.');
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app).patch('/api/tasks/nonexistent').send({ name: 'x' });

      expect(res.status).toBe(404);
    });

    it('unregisters cron when disabling', async () => {
      const sched = store.createTask(taskInput({ name: 'Dis', prompt: 'p', cron: '0 * * * *' }));

      await request(app).patch(`/api/tasks/${sched.id}`).send({ enabled: false });

      expect(scheduler.unregisterTask).toHaveBeenCalledWith(sched.id);
    });

    /**
     * This route handled only the way OUT of `pending_approval` until the
     * DOR-1387 review. A schedule parked by an update is a condition that has
     * just started standing, so it needs the same clock the two create sites
     * start — otherwise it could wait indefinitely with no escalation behind it.
     */
    it('starts the escalation clock when a schedule is parked by an update', async () => {
      const escalation = wireEscalationService();
      const sched = store.createTask(taskInput({ name: 'Park', prompt: 'p', cron: '0 * * * *' }));

      await request(app).patch(`/api/tasks/${sched.id}`).send({ status: 'pending_approval' });

      expect(escalation.armedSubjects()).toEqual([`schedule:${sched.id}`]);
    });

    it('does not re-arm a schedule that was already parked', async () => {
      const escalation = wireEscalationService();
      const sched = store.createTask(taskInput({ name: 'Park', prompt: 'p', cron: '0 * * * *' }));
      store.updateTask(sched.id, { status: 'pending_approval' });

      await request(app).patch(`/api/tasks/${sched.id}`).send({ status: 'pending_approval' });

      // Nothing armed it on the way in (this test never called the create
      // path), and an update that does not CHANGE the status is not a new
      // condition — so the transition guard, not the service's idempotency, is
      // what has to keep this empty.
      expect(escalation.armedSubjects()).toEqual([]);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a schedule', async () => {
      const sched = store.createTask(taskInput({ name: 'Del', prompt: 'p', cron: '0 * * * *' }));

      const res = await request(app).delete(`/api/tasks/${sched.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(scheduler.unregisterTask).toHaveBeenCalledWith(sched.id);
    });

    it('deletes a schedule that has already run', async () => {
      const sched = store.createTask(taskInput({ name: 'Ran', prompt: 'p', cron: '0 * * * *' }));
      store.createRun(sched.id, 'scheduled');

      const res = await request(app).delete(`/api/tasks/${sched.id}`);
      expect(res.status).toBe(200);
      expect(store.getTask(sched.id)).toBeNull();
    });

    it('returns 404 for nonexistent schedule', async () => {
      const res = await request(app).delete('/api/tasks/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/trigger', () => {
    it('returns 404 when schedule not found', async () => {
      const res = await request(app).post('/api/tasks/nope/trigger');
      expect(res.status).toBe(404);
    });

    it('returns run ID on success', async () => {
      vi.mocked(scheduler.triggerManualRun).mockResolvedValue({
        id: 'run-1',
        scheduleId: 'sched-1',
        status: 'running',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        outputSummary: null,
        error: null,
        sessionId: null,
        trigger: 'manual',
        createdAt: new Date().toISOString(),
      });

      const res = await request(app).post('/api/tasks/sched-1/trigger');
      expect(res.status).toBe(201);
      expect(res.body.runId).toBe('run-1');
    });
  });

  describe('GET /api/tasks/runs', () => {
    it('returns empty array when no runs', async () => {
      const res = await request(app).get('/api/tasks/runs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns runs with pagination', async () => {
      const sched = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');
      store.createRun(sched.id, 'scheduled');

      const res = await request(app).get('/api/tasks/runs?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('filters by scheduleId', async () => {
      const s1 = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      const s2 = store.createTask(taskInput({ name: 'S2', prompt: 'p', cron: '0 * * * *' }));
      store.createRun(s1.id, 'scheduled');
      store.createRun(s2.id, 'scheduled');

      const res = await request(app).get(`/api/tasks/runs?scheduleId=${s1.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scheduleId).toBe(s1.id);
    });
  });

  describe('GET /api/tasks/runs/:id', () => {
    it('returns a run', async () => {
      const sched = store.createTask(taskInput({ name: 'S1', prompt: 'p', cron: '0 * * * *' }));
      const run = store.createRun(sched.id, 'scheduled');
      const res = await request(app).get(`/api/tasks/runs/${run.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(run.id);
    });

    it('returns 404 for missing run', async () => {
      const res = await request(app).get('/api/tasks/runs/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/tasks/runs/:id/cancel', () => {
    it('returns 404 when there is no such run', async () => {
      const res = await request(app).post('/api/tasks/runs/nope/cancel');
      expect(res.status).toBe(404);
    });

    it('cancels an active run', async () => {
      vi.mocked(scheduler.cancelRun).mockResolvedValue({ state: 'stopping' });

      const res = await request(app).post('/api/tasks/runs/run-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.state).toBe('stopping');
    });

    it('answers 200 for a run that had already finished', async () => {
      vi.mocked(scheduler.cancelRun).mockResolvedValue({ state: 'already_finished' });

      const res = await request(app).post('/api/tasks/runs/run-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('already_finished');
    });

    it('says so — and does not claim success — when the stop could not be confirmed', async () => {
      vi.mocked(scheduler.cancelRun).mockResolvedValue({
        state: 'unconfirmed',
        reason: 'nothing picked it up',
      });

      const res = await request(app).post('/api/tasks/runs/run-1/cancel');
      expect(res.status).toBe(502);
      expect(res.body.error).toContain('nothing picked it up');
    });
  });
});

/**
 * The cockpit's Stop button against a run the scheduler handed to the relay
 * (DOR-808).
 *
 * Mounted on the REAL {@link TaskSchedulerService}, because the bug lived in
 * exactly the seam a mocked scheduler hides: a relay-dispatched run is never
 * held in the scheduler's in-process `activeRuns`, so `cancelRun` answered
 * "not active" and the route turned that into a 404 on a run that was very
 * much alive.
 */
describe('POST /api/tasks/runs/:id/cancel — relay-dispatched run', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let relay: { publish: ReturnType<typeof vi.fn> };
  let scheduler: TaskSchedulerService;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    relay = { publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }) };
    scheduler = new TaskSchedulerService({
      store,
      agentManager: {
        ensureSession: vi.fn(),
        sendMessage: vi.fn(),
        interruptQuery: vi.fn().mockResolvedValue(true),
      } as unknown as SchedulerAgentManager,
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
      relay: relay as unknown as RelayCore,
    });
    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), DORK_HOME)
    );
  });

  afterEach(() => {
    store.close();
  });

  it('stops a run the relay is carrying', async () => {
    const task = store.createTask(taskInput({ name: 'Relay Run', prompt: 'p', cron: '0 * * * *' }));
    const run = store.createRun(task.id, 'scheduled');

    const res = await request(app).post(`/api/tasks/runs/${run.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(relay.publish).toHaveBeenCalledOnce();
    const [subject, payload] = relay.publish.mock.calls[0];
    expect(subject).toBe(`relay.control.task-cancel.${run.id}`);
    expect(payload).toEqual({ type: 'task_cancel', runId: run.id });
  });

  it('does not pretend to have stopped a run nothing was listening for', async () => {
    relay.publish.mockResolvedValue({ messageId: 'msg-2', deliveredTo: 0 });
    const task = store.createTask(taskInput({ name: 'Orphan', prompt: 'p', cron: '0 * * * *' }));
    const run = store.createRun(task.id, 'scheduled');

    const res = await request(app).post(`/api/tasks/runs/${run.id}/cancel`);

    expect(res.status).toBe(502);
    // The run is left alone: nobody confirmed it stopped, so claiming a
    // terminal status here would be a guess written to the record.
    expect(store.getRun(run.id)!.status).toBe('running');
  });

  it('is a no-op the second time — the run has already finished', async () => {
    const task = store.createTask(taskInput({ name: 'Twice', prompt: 'p', cron: '0 * * * *' }));
    const run = store.createRun(task.id, 'scheduled');
    store.updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString() });

    const res = await request(app).post(`/api/tasks/runs/${run.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('already_finished');
    expect(relay.publish).not.toHaveBeenCalled();
  });
});
