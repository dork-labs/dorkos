/**
 * `tasks.set_mode` and `tasks.approve` at the tool gate (DOR-3703): the card is
 * the standard one, and every caller but an agent's own tools in its own chat
 * gets it, at the default and at Allowed (Security ruling 1).
 *
 * The four callers the ruling names: an agent in its own chat, an agent token
 * on `/mcp`, a per-user key on `/mcp`, and `/mcp` with no header at all. The
 * HTTP door refuses the fields for every caller that is not a person
 * (`routes/__tests__/tasks-agent-mode.test.ts`), and `/api/capabilities` invoke
 * cannot reach either action (bottom of this file).
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-gate
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MeshCore } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'tasks' ? { agentModeControl: true } : undefined),
  },
}));
// A turn of chat `ses-marked` read words from outside; every other turn did not.
vi.mock('../../../core/turn-power/turn-levels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/turn-power/turn-levels.js')>()),
  marksOf: (sessionId: string | undefined) =>
    sessionId === 'ses-marked' ? { outsider: true } : {},
}));

import { ApprovalService } from '../../../core/approvals/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { escalatedGrantFor } from '../../../core/capabilities/tool-call-escalation.js';
import {
  gateHandRegisteredMcpTools,
  gatedToolRegistrar,
  type SdkMcpTool,
} from '../../../core/mcp-tool-gate.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { runWithAuditActor } from '../../../audit/audit-context.js';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import { permissionActions } from '../../../core/permissions/index.js';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import { TaskStore } from '../../task-store.js';
import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { registerAgentModeEscalators } from '../agent-mode-escalation.js';
import type { AgentModeSources } from '../agent-mode-decision.js';

const A = '/tmp/dor3703-gate/agent-a';
const B = '/tmp/dor3703-gate/agent-b';
const AGENT_A: AgentIdentity = {
  agentPath: A,
  displayName: 'Agent A',
  createdAt: new Date().toISOString(),
};

let config: PermissionConfigInput;
let store: TaskStore;
let approvals: ApprovalService;
let unregister: () => void;
let reached: Record<string, unknown>[];
/** Agent homes a test adds, by Mesh id. */
let extraHomes: Record<string, string> = {};

const sources: AgentModeSources = {
  declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
  agentLevelMode: async () => 'bypassPermissions',
  agentPathOf: (id) => ({ 'agent-a': A, 'agent-b': B, ...extraHomes })[id],
  readConfig: () => config,
  readAgentPermissions: async () => undefined,
  startedBy: () => null,
  // Every chat here ran a turn at Full.
  turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
};

/** A probe `tasks_update`: the real gate in front, a recorder behind. */
const probe: SdkMcpTool = {
  name: 'tasks_update',
  description: 'probe',
  inputSchema: {},
  handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
    reached.push(args);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
};

/** The probe on the in-session server, as agent A's own chat. */
function inSession(sessionId = 'ses-a', as: AgentIdentity = AGENT_A, cwd?: string) {
  const [tool] = gateHandRegisteredMcpTools(
    [probe],
    async () => ({ identity: as }),
    undefined,
    () => ({ sessionId, ...(cwd ? { cwd } : {}) })
  );
  return (args: Record<string, unknown>) => tool!.handler(args, {});
}

/** The probe on the external `/mcp` server, for a caller with or without a token. */
function external(identity?: AgentIdentity) {
  let callback: ((args: unknown, extra: unknown) => Promise<CallToolResult>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, cb: typeof callback) => {
      callback = cb;
    },
  } as unknown as McpServer;
  const registrar = gatedToolRegistrar(server, identity);
  registrar.registerTool('tasks_update', { description: 'probe', inputSchema: {} }, (async (
    args: Record<string, unknown>
  ) => probe.handler(args, {})) as never);
  return (args: Record<string, unknown>) => callback!(args, {});
}

function payloadOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

/** Agent B's proposal, filed under agent A, waiting for approval. */
function waitingTask(): string {
  const task = store.createTask({
    name: 'sweep',
    description: 'sweep',
    prompt: 'sweep',
    cron: '0 3 * * *',
    agentId: 'agent-a',
    permissionMode: 'default',
    filePath: '',
  });
  store.updateTask(task.id, { status: 'pending_approval' });
  store.recordProposal(task.id, { proposedByAgentPath: B, proposedBySessionId: 'ses-b' });
  store.approvals.recordAgentEdit(task.id, { agentPath: B, sessionId: 'ses-b' });
  return task.id;
}

beforeEach(() => {
  reached = [];
  extraHomes = {};
  config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
  store = new TaskStore(createTestDb());
  approvals = new ApprovalService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  initPermissionGate({ readConfig: () => config });
  unregister = registerAgentModeEscalators(
    {
      store,
      meshCore: { getProjectPath: (id: string) => sources.agentPathOf(id) } as unknown as MeshCore,
    },
    sources
  );
});

afterEach(() => {
  unregister();
  resetCapabilityTierGate();
  resetPermissionGate();
  store.close();
  vi.restoreAllMocks();
});

/** Allow both actions for everyone: the strongest setting a person can choose. */
function allowBoth(): void {
  config.defaults.actions['tasks.set_mode'] = 'allowed';
  config.defaults.actions['tasks.approve'] = 'allowed';
}

describe('the card for tasks.approve', () => {
  it('is raised for an agent in its own chat at the default, and the yes lets this exact call through', async () => {
    const id = waitingTask();
    const call = inSession();
    const first = payloadOf(await call({ id, status: 'active' }));
    expect(first).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.approve' });
    expect(reached).toEqual([]);

    approvals.grant(first.approvalId as string);
    await call({ id, status: 'active', approvalToken: first.approvalToken });
    expect(reached).toHaveLength(1);
    expect(escalatedGrantFor(reached[0])).toMatchObject({ actionId: 'tasks.approve', via: 'card' });

    // The yes covered that call only: a different mode is a new card.
    const other = payloadOf(
      await call({
        id,
        status: 'active',
        permissionMode: 'plan',
        approvalToken: first.approvalToken,
      })
    );
    expect(other).toMatchObject({ status: 'approval_required' });
  });

  it('is skipped for an agent in its own chat only once the action itself is Allowed', async () => {
    const id = waitingTask();
    allowBoth();
    await inSession()({ id, status: 'active' });
    expect(reached).toHaveLength(1);
    expect(escalatedGrantFor(reached[0])).toMatchObject({
      actionId: 'tasks.approve',
      via: 'allowed',
    });
  });

  it('is raised from a marked turn even at Allowed', async () => {
    const id = waitingTask();
    allowBoth();
    const result = payloadOf(await inSession('ses-marked')({ id, status: 'active' }));
    expect(result).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.approve' });
    expect(reached).toEqual([]);
  });

  describe.each([
    ['an agent token on /mcp', () => external(AGENT_A), undefined, 'dontAsk'],
    ['/mcp with no header', () => external(undefined), undefined, 'plan'],
    [
      'a per-user key on /mcp',
      () => external(undefined),
      {
        actor: { accountId: 'user:u1', kind: 'person' as const, name: 'Dorian' },
        surface: 'mcp' as const,
        credential: { kind: 'api-key', idHash: 'k1' },
      },
      'plan',
    ],
  ])('for %s', (_label, build, scope, fits) => {
    const run = (args: Record<string, unknown>) =>
      scope ? runWithAuditActor(scope, () => build()(args)) : build()(args);

    it('asks for a mode at the default and at Allowed, never letting it through as the person', async () => {
      const id = waitingTask();
      for (const allowed of [false, true]) {
        if (allowed) allowBoth();
        const setMode = payloadOf(await run({ id, permissionMode: fits }));
        expect(setMode).toMatchObject({
          status: 'approval_required',
          capabilityId: 'tasks.set_mode',
        });
      }
      expect(reached).toEqual([]);
    });

    it('never approves: with no chat its chain cannot be read, so nobody is asked and the tool refuses', async () => {
      const id = waitingTask();
      allowBoth();
      await run({ id, status: 'active' });
      expect(approvals.listPending()).toEqual([]);
      // Let through to the tool as the tool's own action, which the door refuses.
      expect(escalatedGrantFor(reached.at(-1))?.actionId).toBe('tasks_update');
    });
  });

  it('holds a caller with no header to the lowest level: Bypass is refused, not carded', async () => {
    const id = waitingTask();
    store.updateTask(id, { permissionMode: 'bypassPermissions', status: 'active' });
    allowBoth();
    await external(undefined)({ id, permissionMode: 'bypassPermissions' });
    expect(approvals.listPending()).toEqual([]);
    expect(escalatedGrantFor(reached.at(-1))?.actionId).toBe('tasks_update');
  });
});

describe('the card is bound to the task, not just the call (M1)', () => {
  it('shows the task and refuses the yes once the task changed while the card waited', async () => {
    const id = waitingTask();
    const call = inSession();
    const first = payloadOf(await call({ id, status: 'active' }));
    const pending = approvals.listPending()[0]!;
    expect(pending.detail).toContain('Task: sweep');
    expect(pending.detail).toContain('Runs: 0 3 * * *');
    expect(pending.detail).toContain('Mode: default');
    expect(pending.detail).toContain('Prompt: sweep');
    approvals.grant(first.approvalId as string);

    // The prompt is rewritten while the card waits.
    store.updateTask(id, { prompt: 'delete everything' });
    const retried = payloadOf(
      await call({ id, status: 'active', approvalToken: first.approvalToken })
    );
    expect(retried).toMatchObject({ status: 'approval_required' });
    expect(reached).toEqual([]);
  });
});

describe('a call the decision refuses', () => {
  it('reaches the tool with no card, so the tool refuses it whole', async () => {
    const id = waitingTask();
    // Agent B approving its own proposal: refused, never carded.
    const [tool] = gateHandRegisteredMcpTools(
      [probe],
      async () => ({ identity: { ...AGENT_A, agentPath: B } }),
      undefined,
      () => ({ sessionId: 'ses-b' })
    );
    await tool!.handler({ id, status: 'active' }, {});
    expect(approvals.listPending()).toEqual([]);
    expect(reached).toHaveLength(1);
    expect(escalatedGrantFor(reached[0])?.via).toBe('allowed');
  });
});

describe('where the two actions are reachable', () => {
  it('are listed for a person to set, with no tool of their own and no capability to invoke', () => {
    const listed = permissionActions(undefined).filter((a) => a.id.startsWith('tasks.'));
    expect(listed).toEqual([
      expect.objectContaining({ id: 'tasks.set_mode', area: 'tasks' }),
      expect.objectContaining({ id: 'tasks.approve', area: 'tasks', consent: 'standing-grant' }),
    ]);
    // Only the approval needs its own Allowed; a mode change follows its area.
    expect(listed[0]!.consent).toBeUndefined();
    // No tool name: a Blocked action refuses the call, it does not hide tasks_update.
    expect(listed.every((a) => a.toolName === undefined)).toBe(true);
    // No capability either, so `/api/capabilities/:id/invoke` has nothing to run
    // as the person: it answers 404 for both ids.
    const registry = composeCapabilityRegistryForDocs();
    expect(registry.get('tasks.set_mode')).toBeUndefined();
    expect(registry.get('tasks.approve')).toBeUndefined();
  });
});

describe('tasks.set_mode on the agent’s own task (Dorian’s rule)', () => {
  it('is allowed without a card at the default, in the agent’s own chat', async () => {
    const id = waitingTask();
    store.updateTask(id, { status: 'active' });
    await inSession()({ id, permissionMode: 'bypassPermissions' });
    expect(approvals.listPending()).toEqual([]);
    expect(escalatedGrantFor(reached.at(-1))).toMatchObject({
      actionId: 'tasks.set_mode',
      via: 'allowed',
    });
  });

  it('asks a chat whose identity came through a forged worktree pointer to a Bypass agent’s repo', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor3703-forged-')));
    const repo = path.join(root, 'bypass-agent');
    const forged = path.join(root, 'forged');
    const fakeGit = path.join(root, 'fake-gitdir');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(forged);
    fs.mkdirSync(fakeGit);
    // Every file the mapping reads is one the chat could have written.
    fs.writeFileSync(path.join(forged, '.git'), `gitdir: ${fakeGit}\n`);
    fs.writeFileSync(path.join(fakeGit, 'gitdir'), `${path.join(forged, '.git')}\n`);
    fs.writeFileSync(path.join(fakeGit, 'commondir'), `${path.join(repo, '.git')}\n`);
    setAgentHomeRegistry({
      isRegisteredHome: (dir) => dir === repo,
      listRegisteredHomes: () => [repo],
      managedWorkspaceOwner: () => null,
      roomsDir: null,
    });
    try {
      extraHomes['agent-bypass'] = repo;
      const task = store.createTask({
        name: 'bypass-sweep',
        description: 'sweep',
        prompt: 'sweep',
        cron: '0 3 * * *',
        agentId: 'agent-bypass',
        permissionMode: 'acceptEdits',
        filePath: '',
      });
      allowBoth();
      const asBypassAgent = { ...AGENT_A, agentPath: repo };
      const result = payloadOf(
        await inSession(
          'ses-forged',
          asBypassAgent,
          forged
        )({
          id: task.id,
          permissionMode: 'bypassPermissions',
        })
      );
      expect(result).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.set_mode' });
      expect(reached).toEqual([]);
      // From the repo itself, the same agent is allowed.
      await inSession(
        'ses-home',
        asBypassAgent,
        repo
      )({
        id: task.id,
        permissionMode: 'bypassPermissions',
      });
      expect(escalatedGrantFor(reached.at(-1))?.via).toBe('allowed');
    } finally {
      setAgentHomeRegistry(undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('another agent’s task (Security, Nov 2)', () => {
  it('always cards set_mode, at a looser and at a stricter mode, naming the task, the agent and the change', async () => {
    const task = store.createTask({
      name: 'b-sweep',
      description: 'sweep',
      prompt: 'sweep b',
      cron: '0 3 * * *',
      agentId: 'agent-b',
      permissionMode: 'acceptEdits',
      filePath: '',
    });
    allowBoth();
    for (const mode of ['bypassPermissions', 'plan']) {
      const result = payloadOf(await inSession()({ id: task.id, permissionMode: mode }));
      expect(result, mode).toMatchObject({
        status: 'approval_required',
        capabilityId: 'tasks.set_mode',
      });
    }
    expect(reached).toEqual([]);
    const card = approvals.listPending()[0]!;
    expect(card.requestedBy).toBe('Agent A');
    expect(card.detail).toContain('Task: b-sweep');
    expect(card.detail).toContain('Runs as: agent-b');
    expect(card.detail).toContain('Mode: bypassPermissions (was acceptEdits)');
  });
});
