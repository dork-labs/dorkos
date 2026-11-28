/**
 * Behaviour rows for `gateActionId` (Security on C9a, 2026-11-28): a reader that
 * is handed the old tool name, not the capability's own id, still finds the
 * capability. An agent's own Blocked still blocks, recorded under the gate id
 * and the capability's title; each approval's title reads the capability's
 * title; an approval minted through one door does not fit the other; and a chat
 * DorkOS cannot name carries the outsider mark.
 *
 * @module services/core/capabilities/__tests__/gate-action-id-behaviour
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityEvents } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { ActivityService } from '../../../activity/activity-service.js';
import { TaskStore } from '../../../tasks/task-store.js';
import type { AgentToolDeps } from '../../agent-tool-kit/agent-tool-kit.js';
import { defineCapability } from '../capability-definition.js';
import { composeRegistry } from '../registry.js';
import { invokeCapabilityAsMcpResult } from '../mcp-projection.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import { LEGACY_GATE_ACTION_IDS } from '../declarations/gate-action.js';
import { createCapabilityGateAuditObserver } from '../../agent-identity/capability-gate-audit.js';
import { composeDorkOsCapabilityRegistry } from '../../self-description/dorkos-registry.js';
import { tasksAgentToolsDomain } from '../../../tasks/agent-tools/task-agent-capabilities.js';
import { gatedTaskTools } from '../../../tasks/agent-tools/__tests__/gated-task-tools.js';
import { describeApprovalCapability } from '../../../../startup/describe-approval-capability.js';

const AGENT = {
  agentPath: '/made-up/agents/ivo',
  displayName: 'Ivo',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const capabilityOf = (gateId: string) =>
  tasksAgentToolsDomain.capabilities.find((c) => c.gateActionId === gateId)!;

const payloadOf = (result: { content: unknown[] }) =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

let store: TaskStore;
let approvals: ApprovalService;
let activityDb: ReturnType<typeof createTestDb>;
let deps: AgentToolDeps;
let taskId: string;
let agentActions: Record<string, 'blocked' | 'ask' | 'allowed'>;

beforeEach(() => {
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  store = new TaskStore(createTestDb());
  approvals = new ApprovalService(createTestDb());
  activityDb = createTestDb();
  initCapabilityTierGate({
    approvals,
    onAttempt: createCapabilityGateAuditObserver(new ActivityService(activityDb)),
  });
  agentActions = {};
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => ({ actions: agentActions }),
  });
  const home = mkdtempSync(path.join(os.tmpdir(), 'gate-action-id-'));
  deps = { taskStore: store, defaultCwd: home, dorkHome: home } as never;
  taskId = store.createTask({
    name: 'nightly',
    description: 'nightly',
    prompt: 'sweep',
    cron: '0 3 * * *',
    filePath: '',
  }).id;
});

afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
  store.close();
});

/** A valid call for each tool, so only the gate decides it. */
const ARGS: Record<string, (id: string) => Record<string, unknown>> = {
  tasks_list: () => ({}),
  tasks_create: () => ({ name: 'another', prompt: 'x', cron: '0 4 * * *', reason: 'r' }),
  tasks_update: (id) => ({ id, prompt: 'changed' }),
  tasks_delete: (id) => ({ id }),
  tasks_get_run_history: (id) => ({ schedule_id: id }),
};

const rows = LEGACY_GATE_ACTION_IDS.flatMap((tool) =>
  (['in-session', 'external'] as const).map((server) => [tool, server] as const)
);

describe('an agent’s own stored setting, under the old name', () => {
  it.each(rows)(
    '%s on %s: an agent-layer Blocked blocks, recorded as that name',
    async (tool, server) => {
      agentActions[tool] = 'blocked';
      const tools = gatedTaskTools(deps, {
        identity: AGENT,
        sessionId: 'ses-1',
        mcpServer: server,
      });
      const payload = payloadOf(await tools[tool]!.handler(ARGS[tool]!(taskId)));
      expect(payload).toMatchObject({ capabilityId: tool, reason: 'permission_blocked' });
      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTask(taskId)?.prompt).toBe('sweep');
      await new Promise((resolve) => setImmediate(resolve));
      const recorded = activityDb.select().from(activityEvents).all();
      expect(recorded.map((row) => [row.eventType, row.resourceId, row.resourceLabel])).toEqual([
        ['capability.denied', tool, capabilityOf(tool).title],
      ]);
    }
  );
});

describe('an approval’s title', () => {
  const registry = composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    operatorDeps: {} as never,
  });
  it.each(LEGACY_GATE_ACTION_IDS)('%s reads its human title, not its id', (tool) => {
    expect(describeApprovalCapability(registry, tool)?.title).toBe(capabilityOf(tool).title);
    expect(describeApprovalCapability(registry, tool)?.title).not.toBe(tool);
  });
});

describe('an approval minted through one door', () => {
  it('does not fit the other door with the same input, though both reach tasks.set_mode', async () => {
    const reached: string[] = [];
    const door = (gateActionId: 'tasks_create' | 'tasks_update') =>
      defineCapability({
        id: `probe.${gateActionId}` as `${string}.${string}`,
        gateActionId,
        title: gateActionId,
        description: 'probe',
        tier: 'act',
        area: 'tasks',
        approvalDisplayFields: ['mode'],
        input: z.object({ mode: z.string() }),
        output: z.unknown(),
        surfaces: { mcp: { toolName: gateActionId, servers: ['in-session'] } },
        // Both doors decide a mode as the one action that sets it, as the agent-mode escalators do.
        escalate: async (_deps, { action }) => ({
          action: { ...action, id: 'tasks.set_mode', title: 'Set a scheduled task’s mode' },
          permission: { area: 'tasks', state: 'ask', source: 'always-asks', layer: 'floor' },
        }),
        invoke: async () => {
          reached.push(gateActionId);
          return { ok: true };
        },
      });
    const registry = composeRegistry(
      [{ name: 'probe', capabilities: [door('tasks_create'), door('tasks_update')] }],
      { logger: noopLogger }
    );
    const context = { identity: AGENT, sessionId: 'ses-1', mcpServer: 'in-session' as const };
    const call = async (id: string, args: Record<string, unknown>) =>
      payloadOf(await invokeCapabilityAsMcpResult(registry, id, args, context));

    const asked = await call('probe.tasks_create', { mode: 'dontAsk' });
    expect(asked).toMatchObject({ status: 'approval_required', capabilityId: 'tasks.set_mode' });
    approvals.grant(asked.approvalId as string);

    const other = await call('probe.tasks_update', {
      mode: 'dontAsk',
      approvalToken: asked.approvalToken,
    });
    expect(other.status).toBe('approval_required');
    expect(reached).toEqual([]);

    await call('probe.tasks_create', { mode: 'dontAsk', approvalToken: asked.approvalToken });
    expect(reached).toEqual(['tasks_create']);
  });
});

describe('a chat DorkOS cannot name', () => {
  it('carries the outsider mark on the in-session server, as on the external one', async () => {
    const tools = gatedTaskTools(deps, { sessionId: 'ses-nameless', mcpServer: 'in-session' });
    const payload = payloadOf(
      await tools.tasks_create!.handler({
        name: 'Nameless nightly',
        prompt: 'check the build',
        cron: '0 3 * * *',
        target: 'global',
        reason: 'asked from a chat with no agent',
      })
    );
    const created = store.getTask((payload.schedule as { id: string }).id);
    expect(created).toMatchObject({ status: 'pending_approval', originMarks: { outsider: true } });
  });
});
