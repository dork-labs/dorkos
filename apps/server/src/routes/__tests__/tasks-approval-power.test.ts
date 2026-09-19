/**
 * Approving an agent's proposal can also grant it the operator's own trust stop
 * (DOR-2100) — and only the operator, and only there.
 *
 * ## The bug this pins
 *
 * An agent proposes a schedule. `createScheduledTask` clamps it, because
 * nothing an agent says may arm an unattended run at full power (DOR-504,
 * DOR-607, DOR-823) — and that clamp stays. The operator, sitting at Full
 * autonomy, presses Approve. The approving PATCH carried `status` and nothing
 * else, so the schedule armed at `acceptEdits` and was refused its own first
 * shell call at 3am, with no screen anywhere naming the level. "Approve" meant
 * "yes, run it" and never "yes, run it at my level".
 *
 * ## What is asserted, and where
 *
 * The STORED ROW, always, because that is what the scheduler reads when it
 * fires — the same standard `tasks-permission-escalation.test.ts` sets, and for
 * the same reason. The other half of the chain, that the row's mode actually
 * reaches the run, is pinned in `tasks/__tests__/task-scheduler-service.test.ts`
 * ("a schedule approved at full autonomy launches at it").
 *
 * The writer, the parser and the filesystem are all real here: the grant has to
 * survive the SKILL.md round-trip, and a mocked writer would only re-state this
 * route's belief about that.
 *
 * @module routes/__tests__/tasks-approval-power
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, pulseSchedules, type Db } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../services/runtimes/codex/runtime-constants.js';

/** Mutable state the mocked config manager and registry report. */
const state = vi.hoisted(() => ({ runtimes: undefined as unknown }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: false };
      if (key === 'runtimes') return state.runtimes;
      return undefined;
    },
  },
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefaultType: () => 'claude-code',
    // Codex is registered so the feed label has a SECOND vocabulary to be
    // wrong in: both runtimes call the middle stop `acceptEdits` and name it
    // differently ("Accept edits" vs "Workspace write"), which is what makes
    // "did it read the agent's manifest?" an answerable question.
    has: (type: string) => type === 'claude-code' || type === 'codex',
    getAllCapabilities: () => ({
      'claude-code': CLAUDE_CODE_CAPABILITIES,
      codex: CODEX_CAPABILITIES,
    }),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

import { writeManifest } from '@dorkos/mesh';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../../services/activity/activity-service.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** The agent id the manifest-backed cases file their schedule under. */
const AGENT_ID = 'codex-agent';

/** A manifest with everything but the one field a case is about. */
function baseManifest() {
  return {
    id: AGENT_ID,
    name: AGENT_ID,
    description: '',
    runtime: 'codex',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
  };
}

/** The operator's `runtimes` block, sitting at full power. */
function autonomyRuntimes(): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, defaultTrustStop: 'autonomy' };
}

function createMockScheduler(): TaskSchedulerService {
  return {
    isStarted: true,
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

describe('approving a proposed schedule can carry the operator’s trust stop', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let dorkHome: string;
  let emit: ReturnType<typeof vi.fn>;
  /**
   * Where Mesh says {@link AGENT_ID} lives, or null for "no such agent".
   *
   * Mutable because only one case writes a manifest; every other case must see
   * the mesh answer nothing, which is the ordinary shape of a global task.
   */
  let meshProjectPath: string | null;

  beforeEach(() => {
    state.runtimes = autonomyRuntimes();
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approval-power-'));
    db = createTestDb();
    store = new TaskStore(db);
    emit = vi.fn();
    meshProjectPath = null;

    app = express();
    app.use(express.json());
    const scheduler = createMockScheduler();
    app.use(
      '/api/tasks',
      createTasksRouter(
        store,
        scheduler,
        new TaskRegistrar({ store, scheduler }),
        dorkHome,
        {
          getProjectPath: (id: string) => (id === AGENT_ID ? meshProjectPath : null),
        } as unknown as Parameters<typeof createTasksRouter>[4],
        { emit } as unknown as ActivityService
      )
    );

    fixtureTarget.mount(app);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  /** An agent proposes a schedule, which parks clamped. Returns the stored row. */
  async function proposedByAgent() {
    const res = await request(fixtureServer)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({
        name: 'mailroom-triage',
        description: 'triage the mailroom',
        prompt: 'Read the mailroom and file what came in.',
        cron: '0 3 * * *',
        target: 'global',
        reason: 'The mailroom piles up overnight.',
      });
    expect(res.status).toBe(201);
    const task = store.getTasks()[0]!;
    // The precondition the whole file rests on, asserted rather than assumed:
    // the operator IS at full power and the proposal was clamped anyway.
    expect((state.runtimes as UserConfig['runtimes']).defaultTrustStop).toBe('autonomy');
    expect(task.permissionMode).toBe('acceptEdits');
    expect(task.status).toBe('pending_approval');
    return task;
  }

  it('writes the granted mode un-clamped, to the row AND the file', async () => {
    const task = await proposedByAgent();

    const res = await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true, permissionMode: 'bypassPermissions' });

    expect(res.status).toBe(200);
    const approved = store.getTask(task.id)!;
    expect(approved.permissionMode).toBe('bypassPermissions');
    expect(approved.status).toBe('active');
    // The file too, or the next reconciler sweep puts `acceptEdits` back and
    // the grant evaporates five minutes after the person made it.
    expect(fs.readFileSync(approved.filePath, 'utf-8')).toContain('permissions: bypassPermissions');
  });

  it('records the approval so the grant survives the next file sync', async () => {
    const task = await proposedByAgent();
    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true, permissionMode: 'bypassPermissions' });

    // The arm grant is what `resolveFileArmStatus` and `keepsApprovedBypass`
    // both read. Without it the schedule re-parks — and loses its bypass — on
    // the reconciler's next pass over unchanged content.
    const synced = store.upsertFromFile(
      {
        filePath: store.getTask(task.id)!.filePath,
        body: 'Read the mailroom and file what came in.',
        meta: {
          name: 'mailroom-triage',
          description: 'triage the mailroom',
          schedule: {
            cron: '0 3 * * *',
            timezone: 'UTC',
            enabled: true,
            permissions: 'bypassPermissions',
          },
        },
      } as Parameters<TaskStore['upsertFromFile']>[0],
      undefined,
      { source: 'discovery' }
    );
    expect(synced.permissionMode).toBe('bypassPermissions');
    expect(synced.status).toBe('active');

    // The control that makes the assertion above mean something: the grant is
    // bound to the work a person read, not to the path. Rewrite the body and
    // the same sync clamps and re-parks.
    const rewritten = store.upsertFromFile(
      {
        filePath: store.getTask(task.id)!.filePath,
        body: 'Read the mailroom and then email everyone in it.',
        meta: {
          name: 'mailroom-triage',
          description: 'triage the mailroom',
          schedule: {
            cron: '0 3 * * *',
            timezone: 'UTC',
            enabled: true,
            permissions: 'bypassPermissions',
          },
        },
      } as Parameters<TaskStore['upsertFromFile']>[0],
      undefined,
      { source: 'discovery' }
    );
    expect(rewritten.permissionMode).toBe('acceptEdits');
    expect(rewritten.status).toBe('pending_approval');
  });

  it('refuses an agent that tries to approve itself at any level', async () => {
    const task = await proposedByAgent();

    const res = await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ status: 'active', enabled: true, permissionMode: 'bypassPermissions' });

    // 403 with both offending fields named — not dropped, not clamped, and the
    // whole call refused, so nothing about the schedule moved.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_task_field');
    expect(res.body.fields).toEqual(['permissionMode', 'status']);
    const untouched = store.getTask(task.id)!;
    expect(untouched.permissionMode).toBe('acceptEdits');
    expect(untouched.status).toBe('pending_approval');
  });

  it('refuses an agent that asks for the mode alone, on a transition that is not the approval', async () => {
    const task = await proposedByAgent();

    const res = await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ permissionMode: 'bypassPermissions' });

    expect(res.status).toBe(403);
    expect(res.body.fields).toEqual(['permissionMode']);
    expect(store.getTask(task.id)!.permissionMode).toBe('acceptEdits');
  });

  it('leaves a plain approval exactly where the clamp put it', async () => {
    const task = await proposedByAgent();

    const res = await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true });

    expect(res.status).toBe(200);
    // The default answer is still the safe one: an approval that names no level
    // grants none, however high the operator's own stop sits.
    expect(store.getTask(task.id)!.permissionMode).toBe('acceptEdits');
  });

  it('writes an activity row naming the level, and whether it was raised', async () => {
    const task = await proposedByAgent();
    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true, permissionMode: 'bypassPermissions' });

    const approval = emit.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.eventType === 'tasks.task_approved');
    expect(approval).toBeDefined();
    // The runtime's own WORD for the level, never the id. This line is read
    // months later by somebody asking who gave a 3am job that much power, and
    // `bypassPermissions` is an internal spelling (adversarial review). The id
    // is still on `metadata` below, for a machine reader.
    expect(approval!.summary).toContain('running as Bypass permissions');
    expect(approval!.summary).not.toContain('bypassPermissions');
    expect(approval!.metadata).toMatchObject({
      permissionMode: 'bypassPermissions',
      previousPermissionMode: 'acceptEdits',
      raised: true,
    });
  });

  it('records a plain approval too, so a raise reads as a raise', async () => {
    const task = await proposedByAgent();
    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true });

    const approval = emit.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.eventType === 'tasks.task_approved');
    expect(approval!.metadata).toMatchObject({ permissionMode: 'acceptEdits', raised: false });
  });

  it('names the level in the vocabulary of the agent’s OWN runtime', async () => {
    // The common shape of an agent-proposed schedule: no runtime of its own,
    // filed under an agent that is pinned to one. Both runtimes spell the
    // middle stop `acceptEdits`, so a label resolved through the DEFAULT
    // runtime would read "Accept edits" — Claude Code's word for a level this
    // task runs at under Codex (re-review).
    const task = await proposedByAgent();
    const agentDir = path.join(dorkHome, 'codex-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    await writeManifest(agentDir, baseManifest() as unknown as Parameters<typeof writeManifest>[1]);
    meshProjectPath = agentDir;
    db.update(pulseSchedules)
      .set({ agentId: AGENT_ID })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true });

    const approval = emit.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.eventType === 'tasks.task_approved');
    expect(approval!.summary).toContain('running as Workspace write');
    expect(approval!.summary).not.toContain('Accept edits');
  });

  it('uses the DEFAULT runtime’s word whenever the agent rung answers nothing', async () => {
    // Five ways to get nothing out of the agent rung, and none of them is a
    // reason to shrug: `resolveRuntimeType` falls through to the same registry
    // default on every one, so the run really does execute in these ids and
    // the label is the run's own vocabulary, not a guess (re-review probe).
    const unreadable = path.join(dorkHome, 'unreadable-agent');
    fs.mkdirSync(unreadable, { recursive: true });
    // Written raw, because `writeManifest` validates: `runtime` is required on
    // a manifest, so "names no runtime" only ever reaches disk as a file the
    // reader cannot use — a hand edit, or an older format.
    const corrupt = path.join(dorkHome, 'corrupt-agent', '.dork');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, 'agent.json'), '{ not json', 'utf-8');
    const unbuilt = path.join(dorkHome, 'unbuilt-runtime-agent');
    fs.mkdirSync(unbuilt, { recursive: true });
    await writeManifest(unbuilt, {
      ...baseManifest(),
      // A runtime with no adapter in THIS build. The fire path guards the
      // agent rung with `runtimes.has(...)` and falls to the default, so the
      // label has to do the same or it says "no idea" about a run that is
      // perfectly well named.
      runtime: 'opencode',
    } as unknown as Parameters<typeof writeManifest>[1]);

    const cases: Array<[string, string | null, boolean]> = [
      // label, meshProjectPath, whether the row carries an agentId at all
      ['no agent on the task', null, false],
      ['mesh cannot place the agent', null, true],
      ['agent folder holds no manifest', unreadable, true],
      ['manifest cannot be read', path.dirname(corrupt), true],
      ['manifest names a runtime this build has no adapter for', unbuilt, true],
    ];

    for (const [label, projectPath, filed] of cases) {
      emit.mockClear();
      meshProjectPath = projectPath;
      const task = await proposedByAgent();
      if (filed) {
        db.update(pulseSchedules)
          .set({ agentId: AGENT_ID })
          .where(eq(pulseSchedules.id, task.id))
          .run();
      }

      await request(fixtureServer)
        .patch(`/api/tasks/${task.id}`)
        .send({ status: 'active', enabled: true });

      const approval = emit.mock.calls
        .map(([event]) => event as Record<string, unknown>)
        .find((event) => event.eventType === 'tasks.task_approved');
      expect(approval!.summary, label).toContain('running as Accept edits');
      store.deleteTask(task.id);
      fs.rmSync(path.join(dorkHome, 'skills', 'mailroom-triage'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('falls back to a neutral phrase only when the TASK names a runtime this server lacks', async () => {
    // The one genuinely unnameable case, and the narrowness is the point. A
    // runtime the TASK names is not substituted at fire time — the resolver
    // refuses the run rather than picking another — so there is no vocabulary
    // this level could honestly be named in.
    const task = await proposedByAgent();
    db.update(pulseSchedules)
      .set({ runtime: 'not-installed' })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true });

    const approval = emit.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.eventType === 'tasks.task_approved');
    expect(approval!.summary).toContain('running as the level saved on it');
    // And the id is still recorded, so nothing is lost.
    expect(approval!.metadata).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it('still lets a person change the level on a schedule that is already live', async () => {
    // The regression guard. `permissionMode` is not confined to the approval:
    // the cockpit's own task edit form writes it on an ordinary save, and a
    // guard that allowed it only on `pending_approval → active` would break
    // that with nothing saying why.
    const task = await proposedByAgent();
    await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'active', enabled: true });

    const res = await request(fixtureServer)
      .patch(`/api/tasks/${task.id}`)
      .send({ permissionMode: 'bypassPermissions' });

    expect(res.status).toBe(200);
    expect(store.getTask(task.id)!.permissionMode).toBe('bypassPermissions');
  });
});
