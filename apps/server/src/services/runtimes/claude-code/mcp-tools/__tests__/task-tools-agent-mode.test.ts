/**
 * `tasks_create` and `tasks_update` with `tasks.agentModeControl` off and on
 * (DOR-3703).
 *
 * Off, the refusal is exactly today's, byte for byte. On, a mode or an
 * approval is written only when the decision allows it, an approval an agent
 * gave is bound to the work and the mode, any later edit that changes them
 * parks the task again (a model or account swap included), and a task a person
 * left looser than Don't ask parks on an agent's edit.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-agent-mode
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
import { PARKED_BECAUSE } from '../tasks/task-tool-mode.js';
import { undoAgentModeChange } from '../../../../tasks/agent-mode/agent-mode-undo.js';
import { shortHashOf } from '../../../../tasks/agent-mode/agent-mode-notice.js';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../../../session/origin/session-started-by-store.js';
import {
  noteChatTurnStarted,
  resetChatStartedTurns,
} from '../../../../session/chat-messages/chat-started-turns.js';
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

  describe('with the experiment off', () => {
    it('refuses both fields with today’s envelope, byte for byte, whatever a person allowed', async () => {
      allowBoth();
      const id = await ownTask();
      const tools = toolsOfA();
      const mode = await call(tools.tasks_update!, { id, permissionMode: 'dontAsk' });
      expect(mode.result).toEqual({
        content: [{ type: 'text', text: MODE_REFUSAL_TEXT }],
        isError: true,
      });
      const status = await call(tools.tasks_update!, { id, status: 'active' });
      expect(status.result).toEqual({
        content: [{ type: 'text', text: STATUS_REFUSAL_TEXT }],
        isError: true,
      });
      const create = await call(tools.tasks_create!, {
        name: 'other',
        prompt: 'x',
        cron: '0 4 * * *',
        target: 'agent-a',
        reason: 'r',
        permissionMode: 'dontAsk',
      });
      expect(create.result).toEqual({
        content: [{ type: 'text', text: MODE_REFUSAL_TEXT }],
        isError: true,
      });
    });

    it('keeps an agent’s timing edit live on a task left at Accept edits, as before', async () => {
      const id = await ownTask();
      expect(store.getTask(id)).toMatchObject({ status: 'active', permissionMode: 'acceptEdits' });
      await call(toolsOfA().tasks_update!, { id, cron: '0 5 * * *' });
      expect(store.getTask(id)?.status).toBe('active');
    });
  });

  describe('with the experiment on', () => {
    beforeEach(() => {
      flag.on = true;
    });

    it('sets its own task’s mode at the default, with no card', async () => {
      const id = await ownTask();
      const { isError } = await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      expect(isError).toBe(false);
      expect(store.getTask(id)?.permissionMode).toBe('dontAsk');
    });

    it('asks a person before arming a task, at the default', async () => {
      const id = await waitingOnA();
      const { payload } = await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(payload).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.approve' });
      expect(store.getTask(id)?.status).toBe('pending_approval');
    });

    it('refuses a call that reached the tool without the gate, even at Allowed (S4)', async () => {
      allowBoth();
      const id = await ownTask();
      const { isError, payload } = await call(ungatedToolsOfA().tasks_update!, {
        id,
        permissionMode: 'dontAsk',
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('needs_a_person');
      expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
    });

    it('sets an agent’s own task to Don’t ask once the action is Allowed, and records it', async () => {
      allowBoth();
      const id = await ownTask();
      const { isError } = await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      expect(isError).toBe(false);
      expect(store.getTask(id)?.permissionMode).toBe('dontAsk');
      const row = auditDb
        .select()
        .from(auditEvents)
        .all()
        .find((r) => r.action === 'tasks.set_mode');
      expect(row).toBeDefined();
      const change = JSON.parse(row!.change as string) as {
        field: string;
        before?: unknown;
        after: unknown;
      }[];
      expect(change).toEqual(
        expect.arrayContaining([
          { field: 'permissionMode', before: 'acceptEdits', after: 'dontAsk' },
          { field: 'reachedVia', after: 'in-session' },
          { field: 'decidedBy', after: 'allowed' },
          // Who set it, and how DorkOS knew it was them (C3).
          { field: 'setterAgentId', after: 'agent-a' },
          { field: 'identityResolvedVia', after: 'home' },
          expect.objectContaining({
            field: 'taskHash',
            after: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/),
          }),
        ])
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tasks.task_mode_changed',
          actorType: 'agent',
          linkPath: '/tasks?search=nightly-sweep',
        })
      );
      // The task itself says who set it, and from what (S8).
      expect(store.getTask(id)?.agentModeRecord).toMatchObject({
        kind: 'set_mode',
        agentPath: homeA,
        mode: 'dontAsk',
        previousMode: 'acceptEdits',
      });
    });

    it('keeps a Bypass agent’s own live task running when it sets Bypass from its own chat: no card, a notice (PM a)', async () => {
      const id = await ownTask();
      // Agent-proposed and live, and no person ever approved it: Dorian's own example.
      expect(store.approvals.personApprovedCurrent(id)).toBe(false);
      const vouchedContent = store.approvals.agentEditsOf(id)?.attestation?.contentHash ?? null;
      const set = await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(set.isError).toBe(false);
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
      expect(approvals.listPending()).toEqual([]);
      expect(notices.filter((n) => n.modeChange !== undefined)).toEqual([
        expect.objectContaining({
          taskId: id,
          modeChange: expect.objectContaining({ startedBy: 'you' }),
        }),
      ]);
      // Its own attestation, never a person's yes; a mode change vouches for no content (M1, M3).
      expect(store.approvals.personApprovedCurrent(id)).toBe(false);
      expect(store.approvals.agentEditsOf(id)?.attestation).toMatchObject({
        agentPath: homeA,
        sessionId: 'ses-a',
        startedBy: 'you',
        marked: false,
        // The mode change kept the content its create vouched for, and vouched for no more.
        contentHash: vouchedContent,
        mode: 'bypassPermissions',
        turnLevel: expect.objectContaining({ asks: 'never' }),
      });

      const other = await ownTaskNamed('second-sweep');
      hooks.level = 'acceptEdits';
      const { payload } = await call(toolsOfA().tasks_update!, {
        id: other,
        permissionMode: 'bypassPermissions',
      });
      expect(payload).toMatchObject({ code: 'above_ceiling', highestAllowed: 'acceptEdits' });
      expect(store.getTask(other)?.permissionMode).toBe('acceptEdits');
    });

    it('approves a task another agent last changed, bound to what it approved, and says so in Activity', async () => {
      allowBoth();
      const id = await waitingOnA();
      const { isError } = await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(isError).toBe(false);
      expect(store.getTask(id)?.status).toBe('active');
      expect(store.approvals.agentEditsOf(id)?.agentApprovalKey).toMatch(/^sha256:/);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tasks.task_approved',
          actorType: 'agent',
          metadata: expect.objectContaining({ decidedBy: 'allowed', reachedVia: 'in-session' }),
        })
      );
      // An approval is not an edit: the last editor is still agent B.
      expect(store.approvals.agentEditsOf(id)?.lastEditedByAgentPath).toBe(homeB);
      expect(store.getTask(id)?.agentModeRecord).toMatchObject({
        kind: 'approved',
        agentPath: homeA,
        mode: 'dontAsk',
      });
    });

    it('arms nothing when the audit row cannot be written (S5)', async () => {
      allowBoth();
      const id = await waitingOnA();
      resetAuditTrail();
      const { payload } = await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(payload.code).toBe('not_armed');
      expect(store.getTask(id)?.status).toBe('pending_approval');
      expect(store.approvals.agentEditsOf(id)?.agentApprovalKey).toBeNull();
    });

    it('rolls the approval back when its binding cannot be written (S5)', async () => {
      allowBoth();
      const id = await waitingOnA();
      vi.spyOn(store.approvals, 'recordAgentApproval').mockImplementation(() => {
        throw new Error('disk full');
      });
      const { payload } = await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(payload.code).toBe('not_armed');
      expect(store.getTask(id)?.status).toBe('pending_approval');
    });

    /** Start an approval and pause it inside the door's decision, after it read the task. */
    async function pausedApproval(id: string) {
      let reads = 0;
      let release!: () => void;
      let paused!: () => void;
      const reached = new Promise<void>((resolve) => (paused = resolve));
      hooks.onRead = async () => {
        reads += 1;
        if (reads === 2) {
          paused();
          await new Promise<void>((resolve) => (release = resolve));
        }
      };
      const approving = call(toolsOfA().tasks_update!, { id, status: 'active' });
      await reached;
      return { approving, release: () => release() };
    }

    it('arms nothing when an edit lands while the approval is in flight (M2)', async () => {
      allowBoth();
      const id = await waitingOnA();
      const { approving, release } = await pausedApproval(id);
      // Another call's row write lands meanwhile, and agent A becomes the last editor.
      store.updateTask(id, { model: 'opus' });
      store.approvals.recordAgentEdit(id, { agentPath: homeA, sessionId: 'ses-a' });
      release();
      const { payload } = await approving;
      expect(payload.code).toBe('not_armed');
      expect(store.getTask(id)?.status).toBe('pending_approval');
    });

    it('refuses an approval whose task was rewritten through the tool meanwhile', async () => {
      allowBoth();
      const id = await waitingOnA();
      const { approving, release } = await pausedApproval(id);
      await call(toolsOfA().tasks_update!, { id, prompt: 'something nobody approved' });
      release();
      const { payload } = await approving;
      expect(['task_changed', 'not_armed']).toContain(payload.code);
      expect(store.getTask(id)?.status).toBe('pending_approval');
    });

    it.each([
      ['a prompt change', { prompt: 'sweep everything' }],
      ['a model swap', { model: 'opus' }],
      ['an account swap', { account: 'acct-2' }],
      ['a timing change', { cron: '0 6 * * *' }],
      ['a lower mode', { permissionMode: 'plan' }],
    ])('parks an agent-approved task again after %s', async (_label, change) => {
      allowBoth();
      const id = await waitingOnA();
      await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(store.getTask(id)?.status).toBe('active');

      const { payload } = await call(toolsOfA().tasks_update!, { id, ...change });
      expect(store.getTask(id)?.status).toBe('pending_approval');
      expect(payload.needsReapproval).toBe(true);
      // The editor is now agent A, so agent A can no longer approve it.
      const again = await call(toolsOfA().tasks_update!, { id, status: 'active' });
      expect(again.payload.code).toBe('self_approval');
    });

    it('keeps an upgraded agent-proposed row running when its agent sets Bypass, vouching for no content (PM a, M3, M5)', async () => {
      // A row from before the upgrade: agent-proposed, live, never approved by a person.
      const legacy = store.createTask({
        name: 'mini-apps-program-hourly-drive',
        description: 'drive',
        prompt: 'drive the programme',
        cron: '0 * * * *',
        agentId: 'agent-a',
        filePath: '',
      });
      store.recordProposal(legacy.id, { proposedByAgentPath: homeA, proposedBySessionId: 'ses-a' });
      await call(toolsOfA().tasks_update!, { id: legacy.id, permissionMode: 'bypassPermissions' });
      expect(store.getTask(legacy.id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
      expect(store.approvals.agentEditsOf(legacy.id)?.attestation).toMatchObject({
        contentHash: null,
      });
    });

    it('keeps its own agent’s timing edit to its own Accept edits task running, and attests it (PM b)', async () => {
      const id = await ownTask();
      expect(store.getTask(id)).toMatchObject({ status: 'active', permissionMode: 'acceptEdits' });
      const { payload } = await call(toolsOfA().tasks_update!, { id, cron: '0 5 * * *' });
      expect(payload.needsReapproval).toBeUndefined();
      expect(store.getTask(id)).toMatchObject({ status: 'active', cron: '0 5 * * *' });
      expect(store.approvals.agentEditsOf(id)?.attestation?.contentHash).toEqual(
        expect.any(String)
      );
      // Not a raise and not a prompt edit: nothing to tell the person (M6).
      expect(notices.filter((n) => n.modeChange !== undefined)).toEqual([]);
    });

    it('parks a timing edit its own agent cannot vouch for, and says why in the same reply', async () => {
      const id = await ownTask();
      // Proposed by another agent: not this agent's own task (M5).
      store.recordProposal(id, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
      const { payload } = await call(toolsOfA().tasks_update!, { id, cron: '0 5 * * *' });
      expect(store.getTask(id)?.status).toBe('pending_approval');
      expect(payload).toMatchObject({ needsReapproval: true, note: expect.any(String) });
    });

    it('runs a new task its own agent creates at Bypass from its own chat, and attests it', async () => {
      const { isError, payload } = await call(toolsOfA().tasks_create!, {
        name: 'bypass-sweep',
        prompt: 'sweep',
        cron: '0 3 * * *',
        target: 'agent-a',
        reason: 'r',
        permissionMode: 'bypassPermissions',
      });
      expect(isError).toBe(false);
      const created = payload.schedule as { id: string };
      expect(payload.schedule).toMatchObject({
        permissionMode: 'bypassPermissions',
        status: 'active',
      });
      expect(store.approvals.agentEditsOf(created.id)?.attestation).toMatchObject({
        agentPath: homeA,
        contentHash: expect.any(String),
      });
      expect(store.approvals.personApprovedCurrent(created.id)).toBe(false);
    });

    /** Agent A's own task, which a person has approved as it is (S5). */
    async function personApproved(name = 'nightly-sweep'): Promise<string> {
      const id = await ownTaskNamed(name);
      expect(store.approvals.recordPersonApproval(id)).toBe(true);
      return id;
    }

    it('keeps the Don’t ask, then Bypass chain running with no step between (S5 control)', async () => {
      const id = await personApproved();
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
    });

    it('keeps the Don’t ask, then a timing change, then Bypass chain running on its own agent’s word (Nov 3, S5)', async () => {
      const id = await personApproved();
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      await call(toolsOfA().tasks_update!, { id, cron: '0 6 * * *' });
      expect(store.getTask(id)).toMatchObject({ status: 'active', permissionMode: 'dontAsk' });
      // No person saw the new timing; the task's own agent vouched for it.
      expect(store.approvals.personApprovedCurrent(id)).toBe(false);
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
    });

    it('parks the same chain from a chat that cannot vouch for the task: another agent proposed it (S5)', async () => {
      const id = await ownTask();
      store.recordProposal(id, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      expect(store.getTask(id)?.status).toBe('active');
      const { payload } = await call(toolsOfA().tasks_update!, {
        id,
        permissionMode: 'bypassPermissions',
      });
      expect(store.getTask(id)?.status).toBe('pending_approval');
      // Never silent: the same reply says why (PM).
      expect(payload).toMatchObject({ needsReapproval: true, note: PARKED_BECAUSE.unvouched });
    });

    it('keeps the Don’t ask, then a prompt change, then Bypass chain running on its own agent’s word (S5)', async () => {
      const id = await personApproved();
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      await call(toolsOfA().tasks_update!, { id, prompt: 'something the agent wrote' });
      expect(store.getTask(id)?.status).toBe('active');
      expect(store.approvals.personApprovedCurrent(id)).toBe(false);
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
    });

    it('keeps a task running when its agent sets Bypass on content a person approved (M-A switch on)', async () => {
      const id = await ownTask();
      store.approvals.recordPersonApproval(id);
      await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        permissionMode: 'bypassPermissions',
      });
    });

    it('caps a chat by the level its turn really ran at, read from the live record (S-B)', async () => {
      await ranTurn('ses-held', 'default');
      const id = await ownTask();
      const { payload } = await call(toolsOfA({ sessionId: 'ses-held' }).tasks_update!, {
        id,
        permissionMode: 'acceptEdits',
      });
      expect(payload).toMatchObject({ code: 'above_ceiling' });
      // A chat with no recorded turn at all gets the lowest level.
      const none = await call(toolsOfA({ sessionId: 'ses-never-ran' }).tasks_update!, {
        id,
        permissionMode: 'dontAsk',
      });
      expect(none.payload).toMatchObject({ code: 'above_ceiling', highestAllowed: 'plan' });
    });

    it('cards a chat that stands in a forged worktree of a Bypass agent’s repo, and audits that its folder vouches for no agent (S-A, C2)', async () => {
      const repo = path.join(dorkHome, 'agents', 'bypass');
      const forged = path.join(dorkHome, 'forged');
      const fakeGit = path.join(dorkHome, 'fake-gitdir');
      await fs.mkdir(path.join(repo, '.git'), { recursive: true });
      await fs.mkdir(forged);
      await fs.mkdir(fakeGit);
      await fs.writeFile(path.join(forged, '.git'), `gitdir: ${fakeGit}\n`);
      await fs.writeFile(path.join(fakeGit, 'gitdir'), `${path.join(forged, '.git')}\n`);
      await fs.writeFile(path.join(fakeGit, 'commondir'), `${path.join(repo, '.git')}\n`);
      agents.push({ id: 'agent-r', name: 'r', projectPath: repo });
      const created = await call(toolsOfA({ home: repo }).tasks_create!, {
        name: 'r-sweep',
        prompt: 'sweep',
        cron: '0 3 * * *',
        target: 'agent-r',
        reason: 'r',
      });
      const id = (created.payload.schedule as { id: string }).id;
      store.approvals.recordPersonApproval(id);
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => [homeA, homeB, repo].includes(dir),
        listRegisteredHomes: () => [homeA, homeB, repo],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
      const tools = toolsOfA({ home: repo, cwd: forged });
      const first = await call(tools.tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(first.payload).toMatchObject({
        status: 'approval_required',
        capabilityId: 'tasks.set_mode',
      });
      expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');

      approvals.grant(first.payload.approvalId as string);
      await call(tools.tasks_update!, {
        id,
        permissionMode: 'bypassPermissions',
        approvalToken: first.payload.approvalToken,
      });
      expect(store.getTask(id)?.permissionMode).toBe('bypassPermissions');
      const row = auditDb
        .select()
        .from(auditEvents)
        .all()
        .find((r) => r.action === 'tasks.set_mode');
      const change = JSON.parse(row!.change as string) as { field: string; after: unknown }[];
      expect(change).toEqual(
        expect.arrayContaining([
          // DOR-3706 refuses the forged pointer, so the folder maps to no agent at
          // all: only the dispatch named the Bypass agent, which still asks.
          { field: 'identityResolvedVia', after: 'dispatched' },
          { field: 'decidedBy', after: 'card' },
        ])
      );
    });

    it('cards a chat in a real linked worktree above Default, and audits it as a worktree (C2)', async () => {
      const repo = path.join(dorkHome, 'agents', 'linked');
      const worktree = path.join(dorkHome, 'linked-wt');
      const gitDir = path.join(repo, '.git', 'worktrees', 'linked-wt');
      await fs.mkdir(gitDir, { recursive: true });
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
      await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(worktree, '.git')}\n`);
      await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
      agents.push({ id: 'agent-l', name: 'l', projectPath: repo });
      const created = await call(toolsOfA({ home: repo }).tasks_create!, {
        name: 'l-sweep',
        prompt: 'sweep',
        cron: '0 3 * * *',
        target: 'agent-l',
        reason: 'l',
      });
      const id = (created.payload.schedule as { id: string }).id;
      store.approvals.recordPersonApproval(id);
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => [homeA, homeB, repo].includes(dir),
        listRegisteredHomes: () => [homeA, homeB, repo],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
      const tools = toolsOfA({ home: repo, cwd: worktree });
      const first = await call(tools.tasks_update!, { id, permissionMode: 'bypassPermissions' });
      expect(first.payload).toMatchObject({
        status: 'approval_required',
        capabilityId: 'tasks.set_mode',
      });
      expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
      approvals.grant(first.payload.approvalId as string);
      await call(tools.tasks_update!, {
        id,
        permissionMode: 'bypassPermissions',
        approvalToken: first.payload.approvalToken,
      });
      const row = auditDb
        .select()
        .from(auditEvents)
        .all()
        .find((r) => r.action === 'tasks.set_mode');
      const change = JSON.parse(row!.change as string) as { field: string; after: unknown }[];
      expect(change).toEqual(
        expect.arrayContaining([{ field: 'identityResolvedVia', after: 'worktree' }])
      );
    });

    it('treats a chat whose folder belongs to another agent as nobody DorkOS can name (C2)', async () => {
      const id = await ownTask();
      const before = store.getTask(id)?.permissionMode;
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => [homeA, homeB].includes(dir),
        listRegisteredHomes: () => [homeA, homeB],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
      // A's identity, standing in B's home folder: not A's own chat, so a card.
      const tools = toolsOfA({ home: homeA, cwd: homeB });
      const { payload } = await call(tools.tasks_update!, { id, permissionMode: 'plan' });
      expect(payload).toMatchObject({
        status: 'approval_required',
        capabilityId: 'tasks.set_mode',
      });
      expect(store.getTask(id)?.permissionMode).toBe(before);
    });

    it('leaves the mode as it was when an approval that names one cannot be armed (S-C)', async () => {
      allowBoth();
      const id = await waitingOnA('dontAsk');
      resetAuditTrail();
      const { payload } = await call(toolsOfA().tasks_update!, {
        id,
        status: 'active',
        permissionMode: 'plan',
      });
      expect(payload.code).toBe('not_armed');
      expect(store.getTask(id)).toMatchObject({
        status: 'pending_approval',
        permissionMode: 'dontAsk',
      });
    });

    it('changes no mode it could not audit first (S-D)', async () => {
      const id = await ownTask();
      resetAuditTrail();
      const { payload } = await call(toolsOfA().tasks_update!, { id, permissionMode: 'dontAsk' });
      expect(payload.code).toBe('not_recorded');
      expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
    });

    it('creates an agent’s own task at Don’t ask once the action is Allowed', async () => {
      allowBoth();
      const { isError, payload } = await call(toolsOfA().tasks_create!, {
        name: 'dont-ask-sweep',
        prompt: 'sweep',
        cron: '0 3 * * *',
        target: 'agent-a',
        reason: 'r',
        permissionMode: 'dontAsk',
      });
      expect(isError).toBe(false);
      expect(payload.schedule).toMatchObject({ permissionMode: 'dontAsk' });
    });

    it('refuses a new task that names its own status', async () => {
      allowBoth();
      const { payload } = await call(toolsOfA().tasks_create!, {
        name: 'self-armed',
        prompt: 'sweep',
        cron: '0 3 * * *',
        target: 'agent-a',
        reason: 'r',
        status: 'active',
      });
      expect(payload.code).toBe('self_approval');
    });

    /** The mode notices raised so far: `schedule.armed_by_agent` with a mode change. */
    const modeNotices = () => notices.filter((n) => n.modeChange !== undefined);
    const labelOf = (mode: string) =>
      CLAUDE_CODE_CAPABILITIES.permissionModes.values.find((m) => m.id === mode)!.label;

    describe('a mode-only change with no card runs only when all four hold (final rulings)', () => {
      it('(1) runs on content a person approved even when another agent proposed it, and parks when neither a person nor its own agent vouches', async () => {
        const id = await personApproved();
        store.recordProposal(id, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: 'bypassPermissions',
        });

        const other = await ownTaskNamed('second-sweep');
        store.recordProposal(other, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
        await call(toolsOfA().tasks_update!, { id: other, permissionMode: 'bypassPermissions' });
        expect(store.getTask(other)).toMatchObject({
          status: 'pending_approval',
          permissionMode: 'bypassPermissions',
        });
      });

      it('(2) runs a mode up to the agent’s own level, and refuses one looser', async () => {
        const id = await personApproved();
        const other = await personApproved('second-sweep');
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: 'bypassPermissions',
        });

        hooks.level = 'dontAsk';
        const { payload } = await call(toolsOfA().tasks_update!, {
          id: other,
          permissionMode: 'bypassPermissions',
        });
        expect(payload).toMatchObject({ code: 'above_ceiling' });
        expect(store.getTask(other)?.permissionMode).toBe('acceptEdits');
      });

      it('(3) runs for a turn with no outsider mark, and not for one that read outside words', async () => {
        const id = await personApproved();
        await ranTurn('ses-marked', 'bypassPermissions', { carriedMarks: { outsider: true } });
        const marked = await call(toolsOfA({ sessionId: 'ses-marked' }).tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
        });
        expect(marked.isError).toBe(true);
        expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
        expect(modeNotices()).toEqual([]);

        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: 'bypassPermissions',
        });
      });

      it('(4) is audited and posts the person a notice with Undo; a change that parks posts none', async () => {
        const id = await personApproved();
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        const audited = auditDb
          .select()
          .from(auditEvents)
          .all()
          .some((r) => r.action === 'tasks.set_mode');
        expect(audited).toBe(true);
        expect(modeNotices()).toEqual([
          expect.objectContaining({
            taskId: id,
            modeChange: expect.objectContaining({
              from: labelOf('acceptEdits'),
              to: labelOf('bypassPermissions'),
            }),
          }),
        ]);
        // On the notifications surface, never a "Needs you" row: notable, an event, with Undo.
        const entry = notificationEntry('schedule.armed_by_agent');
        expect(entry).toMatchObject({ tier: 'notable', storage: 'event' });
        const notice =
          modeNotices()[0] as unknown as NotificationPayload<'schedule.armed_by_agent'>;
        expect(entry.actions?.(notice).map((a) => a.id)).toEqual(['undo-mode', 'open']);
        expect(entry.title(notice)).toContain(labelOf('bypassPermissions'));

        const unapproved = await ownTaskNamed('second-sweep');
        store.recordProposal(unapproved, {
          proposedByAgentPath: homeB,
          proposedBySessionId: 'ses-b',
        });
        await call(toolsOfA().tasks_update!, {
          id: unapproved,
          permissionMode: 'bypassPermissions',
        });
        expect(store.getTask(unapproved)?.status).toBe('pending_approval');
        expect(modeNotices()).toHaveLength(1);
      });

      it('(4) changes no mode it could not audit, and tells nobody', async () => {
        const id = await personApproved();
        resetAuditTrail();
        const { payload } = await call(toolsOfA().tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
        });
        expect(payload.code).toBe('not_recorded');
        expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
        expect(modeNotices()).toEqual([]);
      });

      it('(4) puts the old mode back and says nothing changed when the person cannot be told', async () => {
        const id = await personApproved();
        hooks.noticeThrows = true;
        const { isError, payload } = await call(toolsOfA().tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
        });
        expect(isError).toBe(true);
        expect(payload.code).toBe('not_told');
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: 'acceptEdits',
        });
        const revert = auditDb
          .select()
          .from(auditEvents)
          .all()
          .find((r) => r.action === 'tasks.set_mode' && r.outcome === 'refused');
        expect(revert).toBeDefined();
        expect(JSON.parse(revert!.change as string)).toEqual(
          expect.arrayContaining([
            { field: 'permissionMode', before: 'bypassPermissions', after: 'acceptEdits' },
            { field: 'reverted', after: 'restored' },
            { field: 'reason', after: 'person_not_told' },
          ])
        );
      });

      it('parks the same change with the pending-ruling switch off, end to end (S6)', async () => {
        hooks.modeOnlyRuns = false;
        const id = await personApproved();
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.getTask(id)).toMatchObject({
          status: 'pending_approval',
          permissionMode: 'bypassPermissions',
        });
        expect(modeNotices()).toEqual([]);
      });
    });

    describe('a card shows the task as it is, and a yes approves only that (M1, round 3)', () => {
      it('refuses a carded mode sent with a timing change, before any card', async () => {
        config.defaults.actions['tasks.set_mode'] = 'ask';
        const id = await personApproved();
        store.updateTask(id, { permissionMode: 'dontAsk' });
        const { payload } = await call(toolsOfA().tasks_update!, {
          id,
          cron: '*/5 * * * *',
          permissionMode: 'bypassPermissions',
        });
        expect(payload.code).toBe('mode_alone');
        expect(approvals.listPending()).toEqual([]);
        expect(store.getTask(id)).toMatchObject({ cron: '0 3 * * *', permissionMode: 'dontAsk' });
      });

      it('does not record an edit that landed after the door read the task as the person’s', async () => {
        config.defaults.actions['tasks.set_mode'] = 'ask';
        const id = await personApproved();
        const tools = toolsOfA();
        const first = await call(tools.tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(first.payload).toMatchObject({ status: 'approval_required' });
        approvals.grant(first.payload.approvalId as string);
        let reads = 0;
        hooks.onRead = async () => {
          reads += 1;
          // The door's own read: another writer rewrites the prompt right after it.
          if (reads === 2) store.updateTask(id, { prompt: 'something nobody saw' });
        };
        await call(tools.tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
          approvalToken: first.payload.approvalToken,
        });
        expect(reads).toBe(2);
        expect(store.getTask(id)?.prompt).toBe('something nobody saw');
        expect(store.approvals.personApprovedCurrent(id)).toBe(false);
      });

      it('records the person’s yes for the content the card showed', async () => {
        config.defaults.actions['tasks.set_mode'] = 'ask';
        const id = await ownTask();
        const tools = toolsOfA();
        const first = await call(tools.tasks_update!, { id, permissionMode: 'bypassPermissions' });
        approvals.grant(first.payload.approvalId as string);
        await call(tools.tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
          approvalToken: first.payload.approvalToken,
        });
        expect(store.approvals.personApprovedCurrent(id)).toBe(true);
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: 'bypassPermissions',
        });
      });
    });

    describe('the Nov 3 ruling: what a scheduled run, a person’s Undo and a mark change', () => {
      /** A chat that is one of the task's own runs, which ran a turn at Full. */
      async function runChatOf(id: string, sessionId = 'ses-run'): Promise<string> {
        const run = store.createRun(id, 'scheduled');
        store.updateRun(run.id, { sessionId });
        await ranTurn(sessionId, 'bypassPermissions');
        return sessionId;
      }

      it('(Security 1, MUST-H) refuses a scheduled run’s raise, parks its prompt edit, and keeps its timing edit and its lowering', async () => {
        const id = await ownTask();
        const before = store.getTask(id)!;
        const run = toolsOfA({ sessionId: await runChatOf(id) });
        const raised = await call(run.tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(raised.payload).toMatchObject({ code: 'scheduled_raise' });
        expect(store.getTask(id)).toMatchObject({
          status: 'active',
          permissionMode: before.permissionMode,
        });

        const other = await ownTaskNamed('second-sweep');
        const otherRun = toolsOfA({ sessionId: await runChatOf(other, 'ses-run-2') });
        await call(otherRun.tasks_update!, { id: other, cron: '0 5 * * *' });
        await call(otherRun.tasks_update!, { id: other, permissionMode: 'default' });
        expect(store.getTask(other)).toMatchObject({ status: 'active', permissionMode: 'default' });
        await call(otherRun.tasks_update!, { id: other, prompt: 'the run rewrote this' });
        expect(store.getTask(other)?.status).toBe('pending_approval');
      });

      it('(M7) counts a spin-off a scheduled run started, and a chat its message started, as that run', async () => {
        const id = await ownTask();
        await runChatOf(id);
        // A message the run sent to agent A's own chat started that chat's turn.
        await ranTurn('ses-a-own', 'bypassPermissions');
        noteChatTurnStarted('ses-a-own', Date.now(), [{ fromSessionId: 'ses-run' }]);
        const raised = await call(toolsOfA({ sessionId: 'ses-a-own' }).tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
        });
        expect(raised.payload).toMatchObject({ code: 'scheduled_raise' });
        expect(store.getTask(id)?.status).toBe('active');
        resetChatStartedTurns();
      });

      it('(Security 3) asks a person before an agent raises again what a person put back with Undo', async () => {
        const id = await ownTask();
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.getTask(id)?.status).toBe('active');
        const named = notices.at(-1)!.modeChange as { at: string };
        const undone = await undoAgentModeChange(
          { store, dorkHome },
          id,
          { modeAt: named.at },
          true
        );
        expect(undone.ok).toBe(true);
        expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');

        const again = await call(toolsOfA().tasks_update!, {
          id,
          permissionMode: 'bypassPermissions',
        });
        expect(again.payload).toMatchObject({
          status: 'approval_required',
          capabilityId: 'tasks.set_mode',
        });
        expect(store.getTask(id)?.permissionMode).toBe('acceptEdits');
      });

      it('(Security 4) keeps an outsider’s mark through a same-content rewrite from an unmarked turn', async () => {
        const id = await ownTask();
        store.approvals.markOrigin(id, { outsider: true });
        expect(store.getTask(id)?.originMarks?.outsider).toBe(true);
        await call(toolsOfA().tasks_update!, { id, prompt: 'sweep the backlog' });
        expect(store.getTask(id)?.originMarks?.outsider).toBe(true);
        // And the agent cannot vouch for content an outsider wrote.
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        expect(store.approvals.agentEditsOf(id)?.attestation ?? null).toBeNull();
      });

      it('keeps its own agent’s prompt edit live, tells the person, and lets a person Undo it (DOR-3651 superseded)', async () => {
        const id = await ownTask();
        const { payload } = await call(toolsOfA().tasks_update!, { id, prompt: 'sweep and tidy' });
        expect(payload.needsReapproval).toBeUndefined();
        expect(store.getTask(id)).toMatchObject({ status: 'active', prompt: 'sweep and tidy' });
        expect(notices.filter((n) => n.promptChange !== undefined)).toEqual([
          expect.objectContaining({
            taskId: id,
            promptChange: expect.objectContaining({ startedBy: 'you' }),
          }),
        ]);
        const notice = notices.find((n) => n.promptChange !== undefined)!;
        const change = notice.promptChange as { at: string; fromHash: string; toHash: string };
        // The notice says the PROMPT changed, with the old and the new hash.
        expect(change.fromHash).toBe(shortHashOf('sweep the backlog'));
        expect(change.toHash).toBe(shortHashOf('sweep and tidy'));
        const undone = await undoAgentModeChange(
          { store, dorkHome },
          id,
          { promptAt: change.at },
          true
        );
        expect(undone.ok).toBe(true);
        // Undo restores that exact prompt.
        expect(store.getTask(id)?.prompt).toBe('sweep the backlog');
        // A person's Undo approves what it put back.
        expect(store.approvals.personApprovedCurrent(id)).toBe(true);
      });

      it('never vouches for a chat with no recorded turn, as after a restart mid-turn (M7 limit)', async () => {
        const id = await ownTask();
        await call(toolsOfA({ sessionId: 'ses-from-before-restart' }).tasks_update!, {
          id,
          cron: '0 5 * * *',
        });
        expect(store.getTask(id)?.status).toBe('pending_approval');
      });

      it('parks another agent’s prompt edit as before', async () => {
        const id = await ownTask();
        store.recordProposal(id, { proposedByAgentPath: homeB, proposedBySessionId: 'ses-b' });
        await call(toolsOfA().tasks_update!, { id, prompt: 'sweep and tidy' });
        expect(store.getTask(id)?.status).toBe('pending_approval');
      });

      it('puts the old prompt back and says nothing changed when the person cannot be told', async () => {
        const id = await ownTask();
        hooks.noticeThrows = true;
        const { isError, payload } = await call(toolsOfA().tasks_update!, {
          id,
          prompt: 'sweep and tidy',
        });
        expect(isError).toBe(true);
        expect(payload.code).toBe('not_told');
        expect(store.getTask(id)).toMatchObject({ status: 'active', prompt: 'sweep the backlog' });
      });

      it('(M9) refuses an old notice’s Undo once the agent changed the mode again, and never raises', async () => {
        const id = await ownTask();
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'bypassPermissions' });
        const named = notices.at(-1)!.modeChange as { at: string };
        // The agent lowers it again: a newer record the old notice did not name.
        await call(toolsOfA().tasks_update!, { id, permissionMode: 'default' });
        const out = await undoAgentModeChange({ store, dorkHome }, id, { modeAt: named.at }, true);
        expect(out).toMatchObject({ ok: false, status: 409 });
        expect(out.ok === false && out.body.message).toMatch(/changed since this notice/);
        expect(store.getTask(id)?.permissionMode).toBe('default');
        // Naming the lowering itself would put Bypass back: never a raise.
        const latest = store.getTask(id)!.agentModeRecord!.at;
        const raise = await undoAgentModeChange({ store, dorkHome }, id, { modeAt: latest }, true);
        expect(raise.ok).toBe(false);
        expect(store.getTask(id)?.permissionMode).toBe('default');
      });

      it('(e2e) a scheduled run’s session_start spin-off cannot launder a raise: it is refused, from the spin-off’s own chat', async () => {
        const startedBy = new SessionStartedByStore(createTestDb());
        setSessionStartedByStore(startedBy);
        try {
          const id = await ownTask();
          const run = store.createRun(id, 'scheduled');
          store.updateRun(run.id, { sessionId: 'ses-run' });
          // The run starts a spin-off, which runs its own turn at Full in agent A's home.
          startedBy.insert({
            sessionId: 'ses-spinoff',
            kind: 'chat',
            extensionId: null,
            startedBySessionId: 'ses-run',
            originExtensionId: null,
            reason: null,
            createdAt: new Date().toISOString(),
          });
          await ranTurn('ses-spinoff', 'bypassPermissions');
          const { payload } = await call(toolsOfA({ sessionId: 'ses-spinoff' }).tasks_update!, {
            id,
            permissionMode: 'bypassPermissions',
          });
          expect(store.getTask(id)?.status).toBe('active');
          expect(payload).toMatchObject({ code: 'scheduled_raise' });
        } finally {
          setSessionStartedByStore(undefined);
        }
      });

      it('(concurrency) two mode-only raises in flight at once land one record and one notice each, and the last stands', async () => {
        const id = await ownTask();
        const tools = toolsOfA();
        const [first, second] = await Promise.all([
          call(tools.tasks_update!, { id, permissionMode: 'dontAsk' }),
          call(tools.tasks_update!, { id, permissionMode: 'bypassPermissions' }),
        ]);
        expect(first.isError || second.isError).toBe(false);
        const task = store.getTask(id)!;
        expect(['dontAsk', 'bypassPermissions']).toContain(task.permissionMode);
        // The record names the mode the task runs at: dispatch holds that one.
        expect(task.agentModeRecord?.mode).toBe(task.permissionMode);
        expect(task.status).toBe('active');
      });
    });
  });
});
