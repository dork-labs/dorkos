/**
 * Another agent's task (Security, Nov 2, DOR-3703): agent A's `tasks.set_mode`
 * on agent B's task is always the person's card, and only a person can answer
 * it. A, B, or anything in either's chat chain calls the answer route with its
 * agent token, and the route refuses every one of them.
 *
 * @module routes/__tests__/tasks-cross-agent-card
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { initAuth } from '../../services/core/auth/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../services/core/mcp-tool-gate.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import { registerAgentModeEscalators } from '../../services/tasks/agent-mode/agent-mode-escalation.js';
import type { AgentModeSources } from '../../services/tasks/agent-mode/agent-mode-decision.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { permissionGateSources } from '../../services/core/capabilities/permission-enforcement.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const A = '/agents/a';
const B = '/agents/b';

describe('agent A setting the mode of agent B’s task', () => {
  let tmpDir: string;
  let db: Db;
  let approvals: ApprovalService;
  let store: TaskStore;
  let unregister: () => void;
  const reached: unknown[] = [];

  const sources: AgentModeSources = {
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    agentLevelMode: async () => 'bypassPermissions',
    agentPathOf: (id) => ({ 'agent-a': A, 'agent-b': B })[id],
    readConfig: () => permissionGateSources().readConfig(),
    readAgentPermissions: async () => undefined,
    startedBy: () => null,
    turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dor3703-cross-agent-'));
    process.env.DORK_HOME = tmpDir;
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'cross-agent.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    approvals = new ApprovalService(db);
    initCapabilityTierGate({ approvals });
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    store = new TaskStore(db);
    unregister = registerAgentModeEscalators(
      {
        store,
        meshCore: {
          getProjectPath: (id: string) => sources.agentPathOf(id),
        } as unknown as MeshCore,
      },
      sources
    );
    fixtureTarget.mount(
      composedListener(new MainRequestAdmission(), {
        approvals: { service: approvals, options: {} },
      })
    );
  });

  afterAll(() => {
    unregister();
    resetCapabilityTierGate();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is the person’s card, and neither agent, by its own token, can answer it', async () => {
    const task = store.createTask({
      name: 'b-sweep',
      description: 'sweep',
      prompt: 'sweep',
      cron: '0 3 * * *',
      agentId: 'agent-b',
      permissionMode: 'acceptEdits',
      filePath: '',
    });
    const probe: SdkMcpTool = {
      name: 'tasks_update',
      description: 'probe',
      inputSchema: {},
      handler: async (args): Promise<CallToolResult> => {
        reached.push(args);
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    const [tool] = gateHandRegisteredMcpTools(
      [probe],
      async () => ({
        identity: { agentPath: A, displayName: 'A', createdAt: new Date().toISOString() },
      }),
      undefined,
      () => ({ sessionId: 'ses-a' })
    );
    const result = await tool!.handler({ id: task.id, permissionMode: 'plan' }, {});
    const card = JSON.parse((result.content[0] as { text: string }).text) as { approvalId: string };
    expect(card).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.set_mode' });
    expect(reached).toEqual([]);
    // The card names who asks, whose task it is, the task, and the old and new mode.
    const shown = approvals.listPending().find((row) => row.approvalId === card.approvalId)!;
    expect(shown.detail).toContain('Asked by: a');
    expect(shown.detail).toContain('Runs as: agent-b');
    expect(shown.detail).toContain('Task: b-sweep');
    expect(shown.detail).toContain('Mode: plan (was acceptEdits)');
    expect(shown.detail).toContain('Full prompt: bound to this approval');

    for (const token of ['token-of-agent-a', 'token-of-agent-b', 'token-of-a-spin-off']) {
      const res = await request(fixtureServer)
        .post(`/api/approvals/${card.approvalId}/grant`)
        .set(AGENT_IDENTITY_HEADER, token)
        .send({});
      expect(res.status, token).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
    }
    expect(approvals.listPending().some((row) => row.approvalId === card.approvalId)).toBe(true);
  });
});
