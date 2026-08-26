/**
 * The operator-only field guard on the TASK REST routes (DOR-504).
 *
 * The MCP tools are the surface everybody thinks of, and covering only them is
 * this program's most-repeated defect: `POST /api/tasks` and
 * `PATCH /api/tasks/:id` reach the same store, accept the same two fields, and
 * had no policy check at all. `PATCH` is also the wider hole of the two, because
 * it accepts `status` — which the cockpit's Approve button sends, so a caller
 * that can set it can approve its own pending task.
 *
 * These tests pin both directions of the check, and the second one is the one
 * that matters: the guard must not be satisfied merely by the ABSENCE of an agent
 * header. With login ON, a caller with no proven user is refused even though it
 * sent no agent header at all.
 *
 * @module routes/__tests__/tasks-write-policy
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';

/** Mutable posture the mocked config manager reports. */
const state = vi.hoisted(() => ({ authEnabled: false }));

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

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.authEnabled } : undefined),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
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

import { parseSkillFile } from '@dorkos/skills/parser';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

function createMockScheduler(): TaskSchedulerService {
  return {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('operator-only task fields on the REST routes', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let existing: Task;
  let scheduler: TaskSchedulerService;
  /** Stands in for `sessionGate`'s resolved user, when login is on. */
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
  /**
   * Stands in for what `resolveAgentIdentity` leaves on `res.locals` when a
   * caller presents a token that resolves to a live agent. Set directly rather
   * than by mounting the middleware, because the middleware's own job (hash the
   * token, read the table) is covered in `middleware/__tests__`; what these
   * cases need is the state it produces.
   */
  let resolvedAgentIdentity: { agentPath: string; displayName: string } | undefined;

  beforeEach(() => {
    state.authEnabled = false;
    signedInUser = undefined;
    resolvedAgentIdentity = undefined;
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);
    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });

    app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInUser) res.locals.user = signedInUser;
      if (resolvedAgentIdentity) res.locals.agentIdentity = resolvedAgentIdentity;
      next();
    });
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), DORK_HOME)
    );
  });

  afterEach(() => {
    store.close();
  });

  describe('an agent that names itself', () => {
    it('is refused permissionMode on PATCH, and NOTHING ELSE from the call lands', async () => {
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({
          prompt: 'a different prompt nobody approved',
          cron: '* * * * *',
          permissionMode: 'bypassPermissions',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_only_task_field');
      expect(res.body.fields).toEqual(['permissionMode']);

      const after = store.getTask(existing.id)!;
      expect(after.permissionMode).toBe('acceptEdits');
      expect(after.prompt).toBe('the prompt the person approved');
      expect(after.cron).toBe('0 2 * * *');
      expect(after.updatedAt).toBe(existing.updatedAt);
    });

    it('cannot approve its own pending task by setting status', async () => {
      const parked = store.updateTask(existing.id, { status: 'pending_approval' })!;
      const res = await request(app)
        .patch(`/api/tasks/${parked.id}`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ status: 'active', enabled: true });

      expect(res.status).toBe(403);
      expect(res.body.fields).toEqual(['status']);
      expect(store.getTask(parked.id)!.status).toBe('pending_approval');
    });

    it('is refused permissionMode on POST, and no task is created', async () => {
      const before = store.getTasks().length;
      const res = await request(app)
        .post('/api/tasks')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({
          name: 'sneaky',
          description: 'sneaky',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          permissionMode: 'bypassPermissions',
        });

      expect(res.status).toBe(403);
      expect(res.body.fields).toEqual(['permissionMode']);
      expect(store.getTasks()).toHaveLength(before);
    });

    it('cannot arm a live cron task through POST, even sending no status', async () => {
      // The reviewer's reproduction. `tasks_create` parks its schedules, but that
      // parking lived in the MCP HANDLER, not the store — and both store insert
      // paths hardcode `status: 'active'`, so this route (which is what
      // `dorkos task create` calls) armed a live cron task with no `status` field
      // sent at all. There is no field to refuse here; the task must simply park.
      const res = await request(app)
        .post('/api/tasks')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({
          name: 'nightly-persistence',
          description: 'fires later, unattended',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          // Required of this caller since DOR-1394 — see the reason cases below.
          reason: 'Nobody is watching the overnight run.',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending_approval');

      const created = store.getTasks().find((t) => t.name === 'nightly-persistence')!;
      expect(created.status).toBe('pending_approval');
      // And it must not have been handed to the scheduler on the way out.
      expect(scheduler.registerTask).not.toHaveBeenCalled();
    });

    it('cannot propose a schedule without saying why (DOR-1394)', async () => {
      // The REST door is the other way an agent proposes a schedule — it is what
      // `dorkos task create` calls — and until now it demanded nothing while the
      // MCP door demanded a reason. An operator would have got a card with
      // nothing to read on it, which is the thing this whole change exists to
      // stop.
      const before = store.getTasks().length;

      for (const reason of [undefined, '', '   ']) {
        const res = await request(app)
          .post('/api/tasks')
          .set('x-dorkos-agent', 'agent-token-abc')
          .send({
            name: 'reasonless',
            description: 'no case made',
            prompt: 'do a thing',
            cron: '0 3 * * *',
            target: 'global',
            ...(reason === undefined ? {} : { reason }),
          });

        expect(res.status, `reason ${JSON.stringify(reason)}`).toBe(400);
        expect(String(res.body.error)).toContain('needs a reason');
      }

      // Refused before the file is written, so nothing is left on disk or in the
      // table for the reconciler to resurrect.
      expect(store.getTasks()).toHaveLength(before);
    });

    it('keeps the reason it gave, on the parked row', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({
          name: 'nightly-sweep',
          description: 'sweeps',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          reason: 'The overnight backlog needs sweeping before you start.',
        });

      expect(res.status).toBe(201);
      expect(res.body.reason).toBe('The overnight backlog needs sweeping before you start.');

      const created = store.getTasks().find((t) => t.name === 'nightly-sweep')!;
      expect(created.reason).toBe('The overnight backlog needs sweeping before you start.');
      expect(created.status).toBe('pending_approval');
      // Nothing resolved the header to a live agent in this app, so the row
      // honestly records no path rather than trusting what the caller claimed.
      expect(created.proposedByAgentPath).toBeNull();
    });

    it('is credited by its RESOLVED identity, never by anything it sent', async () => {
      resolvedAgentIdentity = { agentPath: '/tmp/agents/nightly-bot', displayName: 'Nightly Bot' };

      const res = await request(app)
        .post('/api/tasks')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({
          name: 'credited',
          description: 'sweeps',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          reason: 'The overnight backlog needs sweeping.',
          // A caller naming its own path must not be believed: crediting a
          // proposal to an agent the operator trusts is exactly the lie the
          // approval card would carry to them.
          proposedByAgentPath: '/tmp/agents/somebody-else',
        });

      expect(res.status).toBe(201);
      const created = store.getTasks().find((t) => t.name === 'credited')!;
      expect(created.proposedByAgentPath).toBe('/tmp/agents/nightly-bot');
    });

    it('may still write the ordinary fields', async () => {
      // The guard has to be provably narrow, or refusing everything would pass
      // every test above.
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ prompt: 'an updated prompt', enabled: false });

      expect(res.status).toBe(200);
      const after = store.getTask(existing.id)!;
      expect(after.prompt).toBe('an updated prompt');
      expect(after.enabled).toBe(false);
      expect(after.permissionMode).toBe('acceptEdits');
    });
  });

  describe('the cockpit', () => {
    it('creates a task without giving any reason at all (DOR-1394)', async () => {
      // The asymmetry is the point. A reason is what an agent owes the person it
      // is asking; a person creating their own task is asking nobody, and their
      // task does not park. Requiring one here would be a form to fill in for
      // no reader.
      const res = await request(app).post('/api/tasks').send({
        name: 'my-own-task',
        description: 'mine',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        target: 'global',
      });

      expect(res.status).toBe(201);
      const created = store.getTasks().find((t) => t.name === 'my-own-task')!;
      expect(created.status).toBe('active');
      expect(created.reason).toBeNull();
    });

    it('still approves a task and sets its permission mode', async () => {
      // Under the default `local-trust` posture a caller presenting no agent
      // identity and no approval token clears `trustedCaller`, exactly as on
      // PATCH /api/config. This is the flow the Approve button drives.
      const parked = store.updateTask(existing.id, { status: 'pending_approval' })!;
      const res = await request(app)
        .patch(`/api/tasks/${parked.id}`)
        .send({ status: 'active', enabled: true, permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(200);
      const after = store.getTask(parked.id)!;
      expect(after.status).toBe('active');
      expect(after.permissionMode).toBe('bypassPermissions');
    });

    it('still gets the full-autonomy mode it chose, through the SKILL.md round trip', async () => {
      // The happy path this route normally takes: it writes the SKILL.md, then
      // syncs it back through `upsertFromFile` — which refuses a file-declared
      // `bypassPermissions`, because a file on disk is nobody's approval
      // (`services/tasks/schedule-permission-clamp.ts`). The mode here did not
      // come from the file; it came from the request body, and
      // `refusedOperatorOnlyTaskWrite` has already asked whether this caller may
      // set it. So the person's own choice has to survive the trip through disk,
      // or the cockpit's "Full autonomy" option would quietly do nothing.
      vi.mocked(parseSkillFile).mockReturnValueOnce({
        ok: true,
        definition: {
          name: 'full-autonomy',
          meta: {
            name: 'full-autonomy',
            description: 'mine',
            cron: '0 3 * * *',
            timezone: 'UTC',
            enabled: true,
            permissions: 'bypassPermissions',
          },
          body: 'do a thing',
          filePath: `${DORK_HOME}/tasks/full-autonomy/SKILL.md`,
          dirPath: `${DORK_HOME}/tasks/full-autonomy`,
        },
      } as unknown as ReturnType<typeof parseSkillFile>);

      const res = await request(app).post('/api/tasks').send({
        name: 'full-autonomy',
        description: 'mine',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        target: 'global',
        permissionMode: 'bypassPermissions',
      });

      expect(res.status).toBe(201);
      expect(res.body.permissionMode).toBe('bypassPermissions');
      const created = store.getTasks().find((t) => t.name === 'full-autonomy')!;
      expect(created.permissionMode).toBe('bypassPermissions');
    });

    it('creates a live task straight away, without the parking an agent gets', async () => {
      // The other half of the parking change: a person creating a task in their
      // own cockpit must not be made to approve their own request.
      const res = await request(app).post('/api/tasks').send({
        name: 'my-own-task',
        description: 'mine',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        target: 'global',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(scheduler.registerTask).toHaveBeenCalled();
    });
  });

  describe('with login on, the check is positive proof and not header absence', () => {
    beforeEach(() => {
      state.authEnabled = true;
    });

    it('refuses a caller with no proven user, even with no agent header', async () => {
      // The defect shape this exists to avoid: a guard that means "refuse when an
      // agent header is present" is bypassed by omitting the header. Here the
      // header is absent and the write is still refused, because with login on
      // `trustedCaller` requires an authenticated user rather than the absence of
      // a credential.
      signedInUser = undefined;
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(403);
      expect(res.body.fields).toEqual(['permissionMode']);
      expect(store.getTask(existing.id)!.permissionMode).toBe('acceptEdits');
    });

    it('allows a signed-in person', async () => {
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(200);
      expect(store.getTask(existing.id)!.permissionMode).toBe('bypassPermissions');
    });

    it('still refuses a signed-in caller that names itself an agent', async () => {
      // A per-user API key satisfies `sessionGate` exactly as a cookie does
      // (DOR-474), so the agent header is what separates an honest agent holding
      // a credential from the person. Both checks have to hold, not either one.
      signedInUser = { userId: 'user_cockpit', credential: 'api-key' };
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(403);
      expect(store.getTask(existing.id)!.permissionMode).toBe('acceptEdits');
    });

    describe('an API key is not a person, so it cannot self-approve a task (DOR-1569)', () => {
      /**
       * What an agent's own `curl` presents once it reads the operator's per-user
       * API key off `~/.dork` — and, identically, what `dorkos task create|update`
       * presents from the operator's terminal. Under login-on `sessionGate`
       * accepts an API key as the same identity a browser cookie proves (DOR-474),
       * so these two are byte-for-byte indistinguishable and MUST get the same
       * answer: the untrusted one.
       */
      const API_KEY_CALLER = { userId: 'user_cli', credential: 'api-key' as const };

      // The hole this closes: `clearsTheAgentBar` used to rest on
      // `resolveDecisionAuthority` alone, which an API key clears exactly as a
      // cookie does. An agent with a shell reads the operator's key off disk,
      // drops its `X-DorkOS-Agent` header, and is trusted to un-clamp
      // `bypassPermissions` and arm a live cron task with no approval. So the task
      // route now composes the SAME second bar the approval, config, and
      // extension-approval routes do (`requireOperatorCookieUnderLogin`): under
      // login-on only a session cookie clears the bar; an API key is treated as a
      // proposer. This is the DOR-553 question, answered for tasks by DOR-1569.
      //
      // It costs the operator's own login-on CLI an extra cockpit approval, which
      // is the deliberate, conservative trade in a security fix — never a live
      // full-power cron nobody looked at. Under the default login-OFF posture this
      // bar is a no-op and the CLI is unchanged; the residual there is the
      // documented DOR-505 one, closed only by turning login on.

      it('is refused an operator-only field on PATCH, exactly as a named agent is', async () => {
        signedInUser = API_KEY_CALLER;
        const res = await request(app)
          .patch(`/api/tasks/${existing.id}`)
          .send({ permissionMode: 'bypassPermissions' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only_task_field');
        expect(store.getTask(existing.id)!.permissionMode).toBe('acceptEdits');
      });

      it('cannot approve a parked task by setting status through an API key', async () => {
        signedInUser = API_KEY_CALLER;
        const parked = store.updateTask(existing.id, { status: 'pending_approval' })!;
        const res = await request(app)
          .patch(`/api/tasks/${parked.id}`)
          .send({ status: 'active', enabled: true });

        expect(res.status).toBe(403);
        expect(res.body.fields).toEqual(['status']);
        expect(store.getTask(parked.id)!.status).toBe('pending_approval');
      });

      it('is refused outright when it names bypassPermissions on POST', async () => {
        // The strongest outcome, and the most direct read of the exploit: naming
        // an operator-only field un-clamped a live cron before. Now the whole
        // create is refused at the field gate and nothing is written.
        signedInUser = API_KEY_CALLER;
        const before = store.getTasks().length;
        const res = await request(app).post('/api/tasks').send({
          name: 'from-a-stolen-key',
          description: 'fires later, unattended',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          permissionMode: 'bypassPermissions',
        });

        expect(res.status).toBe(403);
        expect(res.body.fields).toEqual(['permissionMode']);
        expect(store.getTasks()).toHaveLength(before);
      });

      it('creates a task that PARKS, unarmed, when it omits the power field', async () => {
        // The parking half, and the one a status assertion alone would miss: the
        // hole answered 201 "created" and armed the cron. Now an API-key caller
        // that names no operator-only field still cannot arm its own schedule — it
        // parks at `pending_approval` for a person to see, and is never handed to
        // the scheduler.
        signedInUser = API_KEY_CALLER;
        const res = await request(app).post('/api/tasks').send({
          name: 'from-a-stolen-key',
          description: 'fires later, unattended',
          prompt: 'do a thing',
          cron: '0 3 * * *',
          target: 'global',
          // An untrusted proposer must make its case (DOR-1394); without it the
          // create is refused a step earlier, on the missing reason.
          reason: 'The overnight run needs to happen.',
        });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('pending_approval');

        const created = store.getTasks().find((t) => t.name === 'from-a-stolen-key')!;
        expect(created.status).toBe('pending_approval');
        expect(created.permissionMode).not.toBe('bypassPermissions');
        expect(scheduler.registerTask).not.toHaveBeenCalled();
      });

      it('cannot trigger a run on demand through an API key', async () => {
        signedInUser = API_KEY_CALLER;
        const res = await request(app).post(`/api/tasks/${existing.id}/trigger`);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only_task_field');
        expect(scheduler.triggerManualRun).not.toHaveBeenCalled();
      });
    });
  });
  describe('a field this route cannot change is refused, never dropped (DOR-1568)', () => {
    // `parseBody` uses a non-strict `z.object`, so anything the update schema does
    // not name was stripped and the caller got a 200 with an unchanged task. An
    // agent that tried to file a task under itself was told that worked. It did not.

    it('refuses agentId by name, and applies nothing else from the call', async () => {
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .send({ prompt: 'an updated prompt', agentId: 'nightly-bot' });

      expect(res.status, 'a silent 200 is the bug').toBe(400);
      expect(res.body.code).toBe('unknown_task_field');
      expect(res.body.fields).toEqual(['agentId']);
      expect(String(res.body.message)).toContain('delete this task and create it again');

      const after = store.getTask(existing.id)!;
      expect(after.prompt).toBe('the prompt the person approved');
      expect(after.agentId).toBeNull();
      expect(after.updatedAt).toBe(existing.updatedAt);
    });

    it('refuses target, the create-only field, with the same answer', async () => {
      const res = await request(app).patch(`/api/tasks/${existing.id}`).send({ target: 'global' });

      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(['target']);
    });

    it('names every unknown field at once, and lists what does work', async () => {
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .send({ agentId: 'x', nonsense: 1 });

      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(['agentId', 'nonsense']);
      // The list of updatable fields is what turns a refusal into an instruction.
      expect(String(res.body.message)).toContain('prompt');
      expect(String(res.body.message)).toContain('cron');
    });

    it('applies to the operator too — a typo should be loud on their edits as well', async () => {
      // Not scoped to agents on purpose: the cockpit only ever sends
      // `UpdateTaskRequest` fields, so nothing legitimate is caught, and a
      // misspelled field silently doing nothing is a bad afternoon either way.
      state.authEnabled = true;
      signedInUser = { userId: 'user_1', credential: 'cookie' };

      const res = await request(app).patch(`/api/tasks/${existing.id}`).send({ promt: 'typo' });

      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(['promt']);
    });

    it('lets an ordinary partial edit straight through', async () => {
      // The guard has to be provably narrow: a PATCH of two real fields, and only
      // those, must still work exactly as it did.
      const res = await request(app)
        .patch(`/api/tasks/${existing.id}`)
        .send({ prompt: 'an updated prompt', enabled: false });

      expect(res.status).toBe(200);
      const after = store.getTask(existing.id)!;
      expect(after.prompt).toBe('an updated prompt');
      expect(after.enabled).toBe(false);
    });
  });
});
