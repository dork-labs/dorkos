/**
 * Security's deep re-read proofs at 1cd399adcf (DOR-3703), kept with its names
 * and with the verdict changed to the fixed behaviour: MD (a live beat is a beat,
 * and a restart leaves it one) and ME (retention can't erase a spin-off's lineage), and its proofs at
 * e6c50c0ace: MUST-F (a run or a beat carried to another account stays one).
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/security-proofs-dor3703-1cd399a
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';

/** The experiment's switch, flipped per test. */
const flag = vi.hoisted(() => ({ on: false }));
/** A hook into the decision's settings read, so a test can pause a call in flight. */
const hooks = vi.hoisted(() => ({
  onRead: undefined as undefined | (() => Promise<void>),
  /** Every agent's unattended level, by mode id. */
  level: 'bypassPermissions',
  /** `MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS`, flipped per test (S6). */
  modeOnlyRuns: true,
  /** The notice poster throws, as a notification store that cannot write would. */
  noticeThrows: false,
}));
/** Every `schedule.armed_by_agent` notice raised, as its payload. */
const notices = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../../../notifications/emitters/schedule-armed.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../notifications/emitters/schedule-armed.js')
  >()),
  announceScheduleArmed: (payload: Record<string, unknown>) => notices.push(payload),
  postScheduleArmed: async (payload: Record<string, unknown>) => {
    if (hooks.noticeThrows) throw new Error('the notification store is full');
    notices.push(payload);
    return true;
  },
}));
// Read at call time, so a test can turn the pending-ruling switch off (S6).
vi.mock('../../../../tasks/agent-mode/agent-mode-actions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../tasks/agent-mode/agent-mode-actions.js')>();
  return {
    ...actual,
    get MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS() {
      return hooks.modeOnlyRuns;
    },
  };
});
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'permissions'
        ? { preset: 'trusted' }
        : key === 'tasks'
          ? { agentModeControl: flag.on }
          : undefined,
  },
}));
// Accounts are not what this file is about: every account may work everywhere.
vi.mock('../../../../tasks/lifecycle/schedule-account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../tasks/lifecycle/schedule-account-eligibility.js')
  >()),
  scheduleAccountRefusal: async () => null,
}));
vi.mock('../../../../tasks/agent-mode/agent-mode-sources.js', async () => {
  const { CLAUDE_CODE_CAPABILITIES } = await import('../../runtime-constants.js');
  const turnLevels = await import('../../../../core/turn-power/turn-levels.js');
  const { permissionGateSources } =
    await import('../../../../core/capabilities/permission-enforcement.js');
  return {
    liveAgentModeSources: (meshCore: { getProjectPath: (id: string) => string | undefined }) => ({
      declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
      agentLevelMode: async () => hooks.level,
      agentPathOf: (id: string) => meshCore?.getProjectPath(id),
      readConfig: () => permissionGateSources().readConfig(),
      readAgentPermissions: async () => {
        await hooks.onRead?.();
        return undefined;
      },
      startedBy: () => null,
      // The real record of each chat's turn level: tests run a turn to fill it (S-B).
      turnLevelOf: (sessionId: string) => turnLevels.lastTurnLevelOf(sessionId),
    }),
  };
});

import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../tasks/task-tools.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import { AuditLog } from '../../../../audit/audit-log.js';
import { AccountIds } from '../../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../../audit/audit-trail.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { gateHandRegisteredMcpTools } from '../../../../core/mcp-tool-gate.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../../core/capabilities/tier-enforcement.js';
import { ApprovalService } from '../../../../core/approvals/index.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { registerAgentModeEscalators } from '../../../../tasks/agent-mode/agent-mode-escalation.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/agent-home.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import {
  notificationEntry,
  type NotificationPayload,
} from '../../../../notifications/notification-registry.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';

beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/**
 * Run one turn in a chat set to `stored`, so the chat has a real recorded level
 * (S-B), and its marks when `opts` carries them.
 */
async function ranTurn(sessionId: string, stored: string, opts?: Record<string, unknown>) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts as never)) {
    // drain
  }
}

/** Today's refusal of `permissionMode`, exactly as the agent reads it. */
const MODE_REFUSAL_TEXT = `{
  "error": "Only a person can decide how a scheduled task runs",
  "code": "operator_only_task_field",
  "fields": [
    "permissionMode"
  ],
  "message": "DorkOS changed nothing — not one field of this task. A scheduled task runs later, on its own, with nobody watching, so how much it may do without asking is the person's to choose, not yours: permissionMode. Send the rest of your changes again without that field and they will go through. To change it, ask the person to open the task in DorkOS."
}`;

/** Today's refusal of `status`. */
const STATUS_REFUSAL_TEXT = MODE_REFUSAL_TEXT.replace(/permissionMode/g, 'status');

describe('tasks_* and an agent’s mode or approval', () => {
  let store: TaskStore;
  let deps: McpToolDeps;
  let emit: ReturnType<typeof vi.fn>;
  let dorkHome: string;
  let homeA: string;
  let homeB: string;
  let config: PermissionConfigInput;
  let auditDb: Db;
  let unregister: () => void;
  let approvals: ApprovalService;
  let agents: { id: string; name: string; projectPath: string }[];

  beforeEach(async () => {
    flag.on = false;
    store = new TaskStore(createTestDb());
    emit = vi.fn();
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor3703-tools-')));
    homeA = path.join(dorkHome, 'agents', 'a');
    homeB = path.join(dorkHome, 'agents', 'b');
    await fs.mkdir(homeA, { recursive: true });
    await fs.mkdir(homeB, { recursive: true });
    agents = [
      { id: 'agent-a', name: 'a', projectPath: homeA },
      { id: 'agent-b', name: 'b', projectPath: homeB },
    ];
    deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      dorkHome,
      activityService: { emit },
      meshCore: {
        listWithPaths: () => agents,
        getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
        getSubjectByPath: () => undefined,
      } as unknown as MeshCore,
    } as unknown as McpToolDeps;
    config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
    initPermissionGate({ readConfig: () => config });
    hooks.onRead = undefined;
    hooks.level = 'bypassPermissions';
    hooks.modeOnlyRuns = true;
    hooks.noticeThrows = false;
    notices.length = 0;
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
    // Agent A's chat ran a turn at Full, as a Trusted install's chats do.
    await ranTurn('ses-a', 'bypassPermissions');
    unregister = registerAgentModeEscalators({ store, meshCore: deps.meshCore! });
    auditDb = createTestDb();
    initAuditTrail({
      log: new AuditLog(auditDb),
      accounts: new AccountIds({
        db: auditDb,
        installId: 'inst-test',
        readOwnerAccount: () => null,
      }),
    });
  });

  afterEach(async () => {
    unregister();
    resetCapabilityTierGate();
    vi.restoreAllMocks();
    resetPermissionGate();
    resetAuditTrail();
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Agent A's tools in its own chat, behind the real tool gate. */
  function toolsOfA(as: { home?: string; cwd?: string; sessionId?: string } = {}) {
    const home = as.home ?? homeA;
    const sessionId = as.sessionId ?? 'ses-a';
    const raw = getTasksTools(deps, () => ({
      sessionId,
      agentPath: home,
      ...(as.cwd ? { cwd: as.cwd } : {}),
    }));
    const gated = gateHandRegisteredMcpTools(
      raw as never,
      async () => ({
        identity: { agentPath: home, displayName: 'A', createdAt: new Date().toISOString() },
      }),
      undefined,
      () => ({ sessionId, ...(as.cwd ? { cwd: as.cwd } : {}) })
    ) as unknown as SessionTool[];
    return Object.fromEntries(gated.map((t) => [t.name, t]));
  }

  /** The same tools with no gate in front, as nothing in DorkOS registers them. */
  function ungatedToolsOfA() {
    return Object.fromEntries(
      (
        getTasksTools(deps, () => ({
          sessionId: 'ses-a',
          agentPath: homeA,
        })) as unknown as SessionTool[]
      ).map((t) => [t.name, t])
    );
  }

  async function call(tool: SessionTool, args: Record<string, unknown>) {
    const result = await tool.handler(args, undefined);
    return {
      result,
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  /** Agent A's own task, armed (Trusted arms an agent's own schedule at once). */
  async function ownTask(): Promise<string> {
    return ownTaskNamed('nightly-sweep');
  }

  /** {@link ownTask} under another name. */
  async function ownTaskNamed(name: string): Promise<string> {
    const { payload } = await call(toolsOfA().tasks_create!, {
      name,
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      target: 'agent-a',
      reason: 'The backlog needs sweeping overnight.',
    });
    return (payload.schedule as { id: string }).id;
  }

  /** Agent A's task as if agent B had last changed it and it were waiting for approval. */
  async function waitingOnA(mode: 'dontAsk' | 'acceptEdits' = 'dontAsk'): Promise<string> {
    const id = await ownTask();
    store.updateTask(id, { permissionMode: mode, status: 'pending_approval' });
    store.recordProposal(id, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
    store.approvals.recordAgentEdit(id, { agentPath: homeB, sessionId: 'ses-b' });
    return id;
  }

  function allowBoth(): void {
    config.defaults.actions['tasks.set_mode'] = 'allowed';
    config.defaults.actions['tasks.approve'] = 'allowed';
  }

  // ---- Security re-review (DOR-3703 @ c49e3e9dd9), flipped: [PR, fixed …] = the fixed behaviour ----
  describe('security re-review proofs @ c49e3e9', () => {
    beforeEach(() => {
      flag.on = true;
    });

    async function personApproved(name = 'nightly-sweep'): Promise<string> {
      const id = await ownTaskNamed(name);
      expect(store.approvals.recordPersonApproval(id)).toBe(true);
      return id;
    }

    async function reconcilerFor(id: string) {
      const { TaskReconciler } = await import('../../../../tasks/task-reconciler.js');
      const { TaskRegistrar } = await import('../../../../tasks/task-registrar.js');
      const { ScheduleIdentityRegistry } = await import('../../../../tasks/schedule-identity.js');
      const { FakeScheduler } = await import('../../../../tasks/__tests__/fake-scheduler.js');
      const { skillsRoot } = await import('../../../../tasks/__tests__/task-root-fixtures.js');
      const dir = path.dirname(path.dirname(store.getTask(id)!.filePath!));
      return async () => {
        const rec = new TaskReconciler(
          store,
          new TaskRegistrar({ store, scheduler: new FakeScheduler() }),
          new ScheduleIdentityRegistry()
        );
        rec.addRoot(skillsRoot(dir, 'project', homeA, 'agent-a'));
        try {
          await rec.reconcile();
        } finally {
          rec.stop();
        }
      };
    }

    /**
     * A scheduled chat tried to raise this running task to Bypass: it is refused,
     * exactly nothing moved, and the person is told who asked (MUST-H).
     */
    async function raiseIsHeld(id: string, sessionId: string): Promise<void> {
      const before = store.getTask(id)!;
      expect(before.status).toBe('active');
      const told = notices.length;
      await ranTurn(sessionId, 'bypassPermissions');
      const out = await call(toolsOfA({ sessionId }).tasks_update!, {
        id,
        permissionMode: 'bypassPermissions',
      });
      expect(out.isError).toBe(true);
      expect(out.payload.code).toBe('scheduled_raise');
      const after = store.getTask(id)!;
      expect(after.status).toBe('active');
      expect(after.permissionMode).toBe(before.permissionMode);
      expect(after.agentModeRecord ?? null).toEqual(before.agentModeRecord ?? null);
      expect(store.approvals.agentModeColumnOf(id).attestation).toBeUndefined();
      expect(notices.slice(told)).toEqual([
        expect.objectContaining({
          taskId: id,
          refusedRaise: expect.objectContaining({ to: 'Bypass permissions' }),
        }),
      ]);
      const audited = auditDb.select().from(auditEvents).all();
      expect(JSON.stringify(audited)).toContain('scheduled_raise');
    }

    it('[PR, fixed MUST-H] after a steered run’s raise, the row’s Approve and the card’s have nothing to arm, and the sibling keeps running', async () => {
      const { noteRunSession, resetActiveRunSessions } =
        await import('../../../../tasks/session/active-run-sessions.js');
      try {
        const runTask = await personApproved('room-digest');
        const target = await personApproved('nightly-sweep');
        const run = store.createRun(runTask, 'scheduled');
        store.updateRun(run.id, { status: 'running' });
        noteRunSession(run.id, 'run-chat', undefined, store);
        await raiseIsHeld(target, 'run-chat');
        // No park, so no Approve to click, and the mode it asked for is on no row.
        expect(store.getTask(target)!.permissionMode).not.toBe('bypassPermissions');
      } finally {
        resetActiveRunSessions();
      }
    });

    /** The start service, as carry-over.ts calls it on a handoff or a person's Continue. */
    async function carriedFrom(source: string, carried: string, startedBy: unknown) {
      const { StartWorkService } = await import('../../../../extensions/start-work.js');
      const service = new StartWorkService({
        store: startedBy as never,
        projects: { rootWithin: vi.fn(), listForExtension: vi.fn(), list: vi.fn() } as never,
        extensionName: (id: string) => id,
        runningSessionIds: () => [],
        taskStore: () => store,
      });
      return service.reserveFromChat({ sessionId: carried, parentSessionId: source, carry: true });
    }

    it('[PR, fixed MUST-F] a RUN carried to another account mid-run: the carried chat counts as the run, and its raise waits', async () => {
      const { createTestDb: mk } = await import('@dorkos/test-utils/db');
      const { SessionStartedByStore, setSessionStartedByStore } =
        await import('../../../../session/origin/session-started-by-store.js');
      const { noteRunSession, endRunSessions, resetActiveRunSessions } =
        await import('../../../../tasks/session/active-run-sessions.js');
      const startedBy = new SessionStartedByStore(mk());
      setSessionStartedByStore(startedBy);
      try {
        const runTaskId = await personApproved('room-digest');
        const target = await personApproved('nightly-sweep');
        const run = store.createRun(runTaskId, 'scheduled');
        store.updateRun(run.id, { status: 'running' });
        noteRunSession(run.id, 'run-chat', undefined, store);
        const claimed = await carriedFrom('run-chat', 'carried', startedBy);
        expect(claimed.ok).toBe(true);
        expect(startedBy.get('carried')).toMatchObject({
          startedBySessionId: 'run-chat',
          scheduledOrigin: 'run',
          carried: true,
          reportBack: false,
        });
        await raiseIsHeld(target, 'carried');
        // A person's Continue, after the run ended: its row still names it.
        store.updateRun(run.id, { status: 'failed', finishedAt: new Date().toISOString() });
        endRunSessions(run.id);
        await carriedFrom('run-chat', 'continued', startedBy);
        expect(startedBy.get('continued')?.scheduledOrigin).toBe('run');
      } finally {
        setSessionStartedByStore(undefined);
        resetActiveRunSessions();
      }
    });

    it('[PR, fixed MUST-F] a BEAT carried to another account mid-turn counts as a beat, and its raise waits', async () => {
      const { createTestDb: mk } = await import('@dorkos/test-utils/db');
      const { SessionStartedByStore, setSessionStartedByStore } =
        await import('../../../../session/origin/session-started-by-store.js');
      const { HeartbeatStore } = await import('../../../../heartbeats/heartbeat-store.js');
      const { registerBeatTurn, resetBeatTurns } =
        await import('../../../../heartbeats/beat-turns.js');
      const { setBeatSessionSource, setBeatChatLookup } =
        await import('../../../../tasks/agent-mode/agent-mode-beats.js');
      const startedBy = new SessionStartedByStore(mk());
      setSessionStartedByStore(startedBy);
      const hb = new HeartbeatStore(mk());
      setBeatSessionSource((agentId) => hb.beatSessionIds(agentId));
      setBeatChatLookup((ids) => hb.beatSessionsAmong(ids));
      try {
        const id = await personApproved();
        hb.insertBeat({
          id: 'b1',
          agentId: 'agent-a',
          startedAt: new Date().toISOString(),
          kind: 'pulse',
          wake: 'timer',
        });
        registerBeatTurn('beat-chat', { agentId: 'agent-a', beatId: 'b1', messageId: 'm1' });
        hb.setBeatChat('b1', 'beat-chat');
        await carriedFrom('beat-chat', 'beat-carried', startedBy);
        expect(startedBy.get('beat-carried')?.scheduledOrigin).toBe('heartbeat');
        await raiseIsHeld(id, 'beat-carried');
      } finally {
        setBeatSessionSource(null);
        setBeatChatLookup(null);
        setSessionStartedByStore(undefined);
        resetBeatTurns();
      }
    });

    it('a person’s own chat carried to another account stays theirs: no row, no stamp', async () => {
      const { createTestDb: mk } = await import('@dorkos/test-utils/db');
      const { SessionStartedByStore, setSessionStartedByStore } =
        await import('../../../../session/origin/session-started-by-store.js');
      const startedBy = new SessionStartedByStore(mk());
      setSessionStartedByStore(startedBy);
      try {
        const claimed = await carriedFrom('person-chat', 'person-carried', startedBy);
        expect(claimed).toEqual({ ok: true, reservation: null });
        expect(startedBy.get('person-carried')).toBeNull();
      } finally {
        setSessionStartedByStore(undefined);
      }
    });

    it('[PR, fixed MUST-D] a LIVE heartbeat beat in a fresh beat chat is a beat while it runs, and after a restart cuts it short', async () => {
      const { createTestDb: mk } = await import('@dorkos/test-utils/db');
      const { HeartbeatStore } = await import('../../../../heartbeats/heartbeat-store.js');
      const { registerBeatTurn, isBeatTurn, resetBeatTurns } =
        await import('../../../../heartbeats/beat-turns.js');
      const { setBeatSessionSource, setBeatChatLookup } =
        await import('../../../../tasks/agent-mode/agent-mode-beats.js');
      const hb = new HeartbeatStore(mk());
      // Wired exactly as heartbeats-wiring.ts does.
      setBeatSessionSource((agentId) => hb.beatSessionIds(agentId));
      setBeatChatLookup((ids) => hb.beatSessionsAmong(ids));
      try {
        const id = await personApproved();
        // The live registry alone: nothing on the row yet.
        hb.insertBeat({
          id: 'beat-row-1',
          agentId: 'agent-a',
          startedAt: new Date().toISOString(),
          kind: 'pulse',
          wake: 'timer',
        });
        registerBeatTurn('beat-live', {
          agentId: 'agent-a',
          beatId: 'beat-row-1',
          messageId: 'm1',
        });
        expect(isBeatTurn('beat-live')).toBe(true);
        // FIXED: the raise waits for a person, and nothing says "you" started it.
        await raiseIsHeld(id, 'beat-live');

        // A restart: the registry is gone and the beat never finished. The row,
        // written before the turn started, still says what it was.
        hb.setBeatChat('beat-row-1', 'beat-restarted');
        resetBeatTurns();
        const id2 = await personApproved('second');
        await raiseIsHeld(id2, 'beat-restarted');
      } finally {
        setBeatSessionSource(null);
        setBeatChatLookup(null);
        resetBeatTurns();
      }
    });

    it('[PR, fixed MUST-E] no restart needed: once run retention prunes the run row, the run’s spin-off still cannot raise a sibling', async () => {
      const { createTestDb: mk } = await import('@dorkos/test-utils/db');
      const { SessionStartedByStore, setSessionStartedByStore } =
        await import('../../../../session/origin/session-started-by-store.js');
      const { noteRunSession, endRunSessions, resetActiveRunSessions } =
        await import('../../../../tasks/session/active-run-sessions.js');
      const { scheduledOriginStamp } =
        await import('../../../../tasks/agent-mode/agent-mode-run-origin.js');
      const startedBy = new SessionStartedByStore(mk());
      setSessionStartedByStore(startedBy);
      try {
        const runTaskId = await personApproved('room-digest');
        const target = await personApproved('nightly-sweep');
        const run = store.createRun(runTaskId, 'scheduled');
        store.updateRun(run.id, { status: 'running' });
        noteRunSession(run.id, 'run-chat', undefined, store);
        // session_start stamps the spin-off while the run is there to read.
        const stamp = scheduledOriginStamp('run-chat', store);
        expect(stamp).toBe('run');
        startedBy.insert({
          sessionId: 'spin',
          kind: 'chat',
          extensionId: null,
          startedBySessionId: 'run-chat',
          originExtensionId: null,
          reason: null,
          scheduledOrigin: stamp,
          createdAt: new Date().toISOString(),
        });
        // The run ends normally; the spin-off (a chat) lives on.
        store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
        endRunSessions(run.id);
        // Later runs of the same task finish; the hourly retention keeps the newest N (100 by default; 1 here).
        await new Promise((r) => setTimeout(r, 5));
        const later = store.createRun(runTaskId, 'scheduled');
        store.updateRun(later.id, { status: 'completed', finishedAt: new Date().toISOString() });
        expect(store.pruneRuns(runTaskId, 1)).toBe(1);
        expect(store.getRun(run.id)).toBeFalsy();
        // FIXED: the spin-off's next turn still counts as the run.
        await raiseIsHeld(target, 'spin');
      } finally {
        setSessionStartedByStore(undefined);
        resetActiveRunSessions();
      }
    });
  });
});
