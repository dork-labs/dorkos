/**
 * `POST /api/tasks` and `PATCH /api/tasks/:id` and an agent's mode or approval
 * (DOR-3703).
 *
 * The HTTP door is never an agent's own tools in its own chat, so it is never
 * Allowed (Security ruling 1). It keeps today's refusal for every caller that is
 * not a person, an agent token, a per-user key or no header under login, with
 * the experiment off AND on, byte for byte: the decision's card lives on the
 * MCP tools only. What the door does gain is the record of who last changed a
 * schedule, which no agent may then approve.
 *
 * @module routes/__tests__/tasks-agent-mode
 */
import { taskRuntimeCapabilitiesFixture } from './fixtures/task-runtime-capabilities.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/schemas';

const state = vi.hoisted(() => ({ authEnabled: false, modeControl: false, wifi: false }));
vi.mock('../../services/core/auth/sessions/wifi-level.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/core/auth/sessions/wifi-level.js')>();
  return { ...actual, isFromWifi: vi.fn(() => state.wifi) };
});
const DORK_HOME = vi.hoisted(() => '/tmp/dork-test-agent-mode');
/** Stored notices by id, as the Undo route reads them back (M9). */
const notices = vi.hoisted(() => new Map<string, { kind: string; payload: unknown }>());
vi.mock('../../services/notifications/notification-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/notifications/notification-service.js')
  >()),
  storedNotificationPayload: (id: string) => notices.get(id) ?? null,
}));

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: state.authEnabled }
        : key === 'tasks'
          ? { agentModeControl: state.modeControl }
          : undefined,
  },
}));
vi.mock('../../lib/boundary.js', () => ({ isWithinBoundary: vi.fn().mockResolvedValue(true) }));
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
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.startsWith(`${DORK_HOME}/`)) return '';
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
          code: 'ENOENT',
        });
      }),
    },
  };
});

import { createTasksRoutes } from '../tasks.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { agentModeRecordText } from '../../services/tasks/agent-mode/agent-mode-record-field.js';

taskRuntimeCapabilitiesFixture();

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Today's refusal of one field, exactly as the route sends it. */
function refusalText(field: 'permissionMode' | 'status'): string {
  return JSON.stringify({
    error: 'Only a person can decide how a scheduled task runs',
    code: 'operator_only_task_field',
    fields: [field],
    message:
      'DorkOS changed nothing — not one field of this task. A scheduled task runs later, on its ' +
      "own, with nobody watching, so how much it may do without asking is the person's to choose, " +
      `not yours: ${field}. Send the rest of your changes again without that field and they will go ` +
      'through. To change it, ask the person to open the task in DorkOS.',
  });
}

describe('the HTTP door and an agent’s mode or approval', () => {
  let store: TaskStore;
  let existing: Task;
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
  let agent: { agentPath: string; displayName: string } | undefined;

  beforeEach(() => {
    state.authEnabled = false;
    state.modeControl = false;
    signedInUser = undefined;
    agent = undefined;
    store = new TaskStore(createTestDb());
    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    const scheduler = {
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue([]),
      isRegistered: vi.fn().mockReturnValue(false),
    } as unknown as TaskSchedulerService;
    fixtureTarget.mount(
      honoGroupListener(
        {
          path: '/api/tasks',
          routes: createTasksRoutes({
            store,
            scheduler,
            registrar: new TaskRegistrar({ store, scheduler }),
            dorkHome: DORK_HOME,
          }),
        },
        {
          before: (c, next) => {
            if (signedInUser) c.set('user', signedInUser);
            if (agent) c.set('agentIdentity', agent as AgentIdentity);
            return next();
          },
        }
      )
    );
  });

  afterEach(() => store.close());

  /** The three non-person callers the HTTP door can see. */
  const callers = [
    [
      'an agent token',
      () => {
        agent = { agentPath: '/projects/a', displayName: 'A' };
      },
      { 'x-dorkos-agent': 'agent-token-abc' },
    ],
    [
      'a per-user key, login on',
      () => {
        state.authEnabled = true;
        signedInUser = { userId: 'user_cli', credential: 'api-key' };
      },
      {},
    ],
    [
      'no header at all, login on',
      () => {
        state.authEnabled = true;
      },
      {},
    ],
  ] as const;

  for (const modeControl of [false, true]) {
    describe(`with the experiment ${modeControl ? 'on' : 'off'}`, () => {
      it.each(callers)(
        'refuses %s both fields, byte for byte as before',
        async (_l, as, headers) => {
          state.modeControl = modeControl;
          as();
          store.updateTask(existing.id, { status: 'pending_approval' });
          const mode = await request(fixtureServer)
            .patch(`/api/tasks/${existing.id}`)
            .set(headers)
            .send({ permissionMode: 'dontAsk' });
          expect(mode.status).toBe(403);
          expect(mode.text).toBe(refusalText('permissionMode'));
          const status = await request(fixtureServer)
            .patch(`/api/tasks/${existing.id}`)
            .set(headers)
            .send({ status: 'active' });
          expect(status.status).toBe(403);
          expect(status.text).toBe(refusalText('status'));
          const create = await request(fixtureServer).post('/api/tasks').set(headers).send({
            name: 'other',
            description: 'other',
            prompt: 'x',
            cron: '0 3 * * *',
            target: 'global',
            reason: 'r',
            permissionMode: 'dontAsk',
          });
          expect(create.status).toBe(403);
          expect(create.text).toBe(refusalText('permissionMode'));
          // Approving a changed SKILL file is the person's too, with the same words (M4).
          const file = await request(fixtureServer)
            .post(`/api/tasks/${existing.id}/approve-file`)
            .set(headers)
            .send({ capAt: '2026-11-03T03:00:00.000Z', hash: 'sha256:x' });
          expect(file.status).toBe(403);
          expect(file.text).toBe(refusalText('status'));
          expect(store.getTask(existing.id)).toMatchObject({
            status: 'pending_approval',
            permissionMode: 'acceptEdits',
          });
        }
      );
    });
  }

  it('records the agent that last changed a schedule, so it can never approve it', async () => {
    agent = { agentPath: '/projects/a', displayName: 'A' };
    expect(store.approvals.agentEditsOf(existing.id)?.lastEditedByAgentPath).toBeNull();
    const res = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(store.approvals.agentEditsOf(existing.id)).toMatchObject({
      lastEditedByAgentPath: '/projects/a',
    });
  });

  it('records a person’s approval of what a task runs, and an agent’s edit takes it away (M-A)', async () => {
    store.updateTask(existing.id, { status: 'pending_approval' });
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(false);
    const approved = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .send({ status: 'active' });
    expect(approved.status).toBe(200);
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(true);
    // A new prompt is content no person has seen.
    store.updateTask(existing.id, { prompt: 'an agent rewrote this' });
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(false);
  });

  it('records a person’s own new task as approved by them', async () => {
    const res = await request(fixtureServer).post('/api/tasks').send({
      name: 'person-made',
      description: 'person-made',
      prompt: 'x',
      cron: '0 3 * * *',
      target: 'global',
    });
    expect(res.status).toBe(201);
    expect(store.approvals.personApprovedCurrent(res.body.id as string)).toBe(true);
  });

  it('counts a person’s switch on or off as approving nothing, and their own prompt edit as approving it (S3)', async () => {
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(false);
    for (const enabled of [false, true]) {
      const res = await request(fixtureServer).patch(`/api/tasks/${existing.id}`).send({ enabled });
      expect(res.status).toBe(200);
      expect(store.approvals.personApprovedCurrent(existing.id)).toBe(false);
    }
    const edited = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .send({ prompt: 'the person wrote this' });
    expect(edited.status).toBe(200);
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(true);
  });

  it('records a person’s mode change in the Tasks panel as their approval, and holds a lowered mode against an agent’s raise (PM c, M2)', async () => {
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(false);
    const lowered = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .send({ permissionMode: 'default' });
    expect(lowered.status).toBe(200);
    expect(store.approvals.personApprovedCurrent(existing.id)).toBe(true);
    expect(store.approvals.agentEditsOf(existing.id)?.personFloor).toBe('default');
    // Raising it again lifts the hold.
    const raised = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .send({ permissionMode: 'acceptEdits' });
    expect(raised.status).toBe(200);
    expect(store.approvals.agentEditsOf(existing.id)?.personFloor ?? null).toBeNull();
  });

  describe('undoing a mode an agent set without asking (final rulings, condition 4)', () => {
    /** The task as an agent left it: Bypass, set over Accept edits, with its record. */
    function agentSetBypass(): void {
      const at = new Date().toISOString();
      store.updateTask(existing.id, { permissionMode: 'bypassPermissions' });
      store.approvals.recordAgentModeChange(
        existing.id,
        agentModeRecordText({
          kind: 'set_mode',
          agentPath: '/projects/a',
          at,
          mode: 'bypassPermissions',
          previousMode: 'acceptEdits',
        })
      );
      // The notice DorkOS posted for it, naming this change.
      notices.set('note-1', {
        kind: 'schedule.armed_by_agent',
        payload: { taskId: existing.id, modeChange: { at } },
      });
    }

    it('refuses an Undo that names no notice of this task', async () => {
      agentSetBypass();
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/undo-agent-mode`)
        .send({});
      expect(res.status).toBe(400);
      expect(store.getTask(existing.id)?.permissionMode).toBe('bypassPermissions');
    });

    it('refuses an agent, by its token, with the same words as the mode field', async () => {
      agentSetBypass();
      agent = { agentPath: '/projects/a', displayName: 'A' };
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/undo-agent-mode`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ notificationId: 'note-1' });
      expect(res.status).toBe(403);
      expect(res.text).toBe(refusalText('permissionMode'));
      expect(store.getTask(existing.id)?.permissionMode).toBe('bypassPermissions');
    });

    it('puts the old mode back for a person, once', async () => {
      agentSetBypass();
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/undo-agent-mode`)
        .send({ notificationId: 'note-1' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ permissionMode: 'acceptEdits' });
      expect(store.getTask(existing.id)?.permissionMode).toBe('acceptEdits');
      // The agent's change is undone, so the task no longer says an agent set it.
      expect(store.getTask(existing.id)?.agentModeRecord ?? null).toBeNull();
      // And a person put it there: an agent's raise above it asks them (M2).
      expect(store.approvals.agentEditsOf(existing.id)?.personFloor).toBe('acceptEdits');
      const again = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/undo-agent-mode`)
        .send({ notificationId: 'note-1' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('nothing_to_undo');
    });

    it('undoes nothing once the mode changed again since', async () => {
      agentSetBypass();
      store.updateTask(existing.id, { permissionMode: 'plan' });
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/undo-agent-mode`)
        .send({ notificationId: 'note-1' });
      expect(res.status).toBe(409);
      expect(store.getTask(existing.id)?.permissionMode).toBe('plan');
    });
  });

  describe('approving a changed SKILL file (M4)', () => {
    it('refuses an agent, by its token, with the same words as the status field', async () => {
      agent = { agentPath: '/projects/a', displayName: 'A' };
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/approve-file`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ capAt: '2026-11-03T03:00:00.000Z', hash: 'sha256:x' });
      expect(res.status).toBe(403);
      expect(res.text).toBe(refusalText('status'));
    });

    it('refuses a person’s request that names no cap', async () => {
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/approve-file`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('approve_needs_cap');
    });

    it('refuses a person on Wi-Fi: approving a file is approving a schedule (DOR-3037)', async () => {
      state.wifi = true;
      try {
        const res = await request(fixtureServer)
          .post(`/api/tasks/${existing.id}/approve-file`)
          .send({ capAt: '2026-11-03T03:00:00.000Z', hash: 'sha256:x' });
        expect(res.status).toBe(403);
      } finally {
        state.wifi = false;
      }
    });

    it('refuses a request that does not name the hash its diff showed', async () => {
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/approve-file`)
        .send({ capAt: '2026-11-03T03:00:00.000Z' });
      expect(res.status).toBe(400);
    });

    it('changes nothing for a cap the task does not hold', async () => {
      const res = await request(fixtureServer)
        .post(`/api/tasks/${existing.id}/approve-file`)
        .send({ capAt: '2026-11-03T03:00:00.000Z', hash: 'sha256:x' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('file_changed_since');
    });
  });

  it('refuses an agent the hash an approval card sends: approving a file is a person’s (M4)', async () => {
    agent = { agentPath: '/projects/a', displayName: 'A' };
    const res = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ approvedPromptHash: 'sha256:x' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'operator_only_task_field',
      fields: ['approvedPromptHash'],
    });
  });

  it('leaves the record alone for a person’s own edit', async () => {
    const res = await request(fixtureServer)
      .patch(`/api/tasks/${existing.id}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(store.approvals.agentEditsOf(existing.id)?.lastEditedByAgentPath).toBeNull();
  });
});
