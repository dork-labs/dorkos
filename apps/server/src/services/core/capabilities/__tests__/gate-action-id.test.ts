/**
 * `gateActionId` on Security's four terms (C9a, 2026-11-27): a closed list, one
 * lookup every consumer reads, an approval bound to the gate id and the
 * capability together, and, per moved tool, a stored old-name setting that
 * still decides the call on both MCP servers.
 *
 * @module services/core/capabilities/__tests__/gate-action-id
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';
import { ApprovalService, hashApprovalInput } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { TaskStore } from '../../../tasks/task-store.js';
import type { AgentToolDeps } from '../../agent-tool-kit/agent-tool-kit.js';
import { defineCapability, type CapabilityDefinition } from '../capability-definition.js';
import { composeRegistry } from '../registry.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import {
  approvalBindingInput,
  gateViewOf,
  LEGACY_GATE_ACTION_IDS,
} from '../declarations/gate-action.js';
import { permissionActions } from '../../permissions/index.js';
import { tasksAgentToolsDomain } from '../../../tasks/agent-tools/task-agent-capabilities.js';
import {
  gatedTaskTools,
  taskToolRegistry,
} from '../../../tasks/agent-tools/__tests__/gated-task-tools.js';

const AGENT = {
  agentPath: '/made-up/agents/ivo',
  displayName: 'Ivo',
  createdAt: '2026-11-01T00:00:00.000Z',
};

/** A fixture capability gated as `gateActionId`, with the MCP tool name `toolName`. */
function gated(gateActionId: string, toolName: string, id = 'probe.gated'): CapabilityDefinition {
  return defineCapability({
    id: id as `${string}.${string}`,
    gateActionId: gateActionId as never,
    title: 'Probe',
    description: 'probe',
    tier: 'observe',
    area: 'tasks',
    input: z.object({}),
    output: z.unknown(),
    surfaces: { mcp: { toolName, servers: ['in-session'] } },
    invoke: async () => ({}),
  });
}

describe('term 1: a closed list', () => {
  it('is the five tasks tools, frozen', () => {
    expect([...LEGACY_GATE_ACTION_IDS]).toEqual([
      'tasks_list',
      'tasks_create',
      'tasks_update',
      'tasks_delete',
      'tasks_get_run_history',
    ]);
    expect(Object.isFrozen(LEGACY_GATE_ACTION_IDS)).toBe(true);
  });

  it('refuses an id off the list', () => {
    expect(() =>
      composeRegistry(
        [{ name: 'probe', capabilities: [gated('mesh_unregister', 'mesh_unregister')] }],
        {
          logger: noopLogger,
        }
      )
    ).toThrow(/may not be gated as "mesh_unregister"/);
  });

  it('refuses an id that is not the capability’s own tool name', () => {
    expect(() =>
      composeRegistry([{ name: 'probe', capabilities: [gated('tasks_delete', 'probe_delete')] }], {
        logger: noopLogger,
      })
    ).toThrow(/only by its own MCP tool name/);
  });

  it('refuses two capabilities sharing one, so none borrows another’s setting', () => {
    expect(() =>
      composeRegistry(
        [
          {
            name: 'probe',
            capabilities: [
              gated('tasks_delete', 'tasks_delete', 'probe.one'),
              gated('tasks_delete', 'tasks_delete', 'probe.two'),
            ],
          },
        ],
        { logger: noopLogger }
      )
    ).toThrow(/duplicate MCP tool name "tasks_delete"/);
  });

  it('is declared by exactly the five moved tools', () => {
    expect(tasksAgentToolsDomain.capabilities.map((c) => [c.id, c.gateActionId])).toEqual([
      ['tasks.list_tasks', 'tasks_list'],
      ['tasks.create_task', 'tasks_create'],
      ['tasks.update_task', 'tasks_update'],
      ['tasks.delete_task', 'tasks_delete'],
      ['tasks.get_run_history', 'tasks_get_run_history'],
    ]);
  });
});

describe('term 2: one lookup', () => {
  it('is the registry’s first read of a capability in invoke, so every consumer below reads it', () => {
    const source = fs.readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');
    const invoke = source.slice(source.indexOf('    async invoke(id, input, context) {'));
    const firstRead = /const capability = (.+);/.exec(invoke)?.[1];
    expect(firstRead).toBe('gateViewOf(lookup(id))');
    // Nothing in invoke reads the capability around the view.
    expect(invoke.slice(0, invoke.indexOf('    catalog() {'))).not.toMatch(/lookup\(id\)(?!\))/);
  });

  it('is what the settings rows list each moved tool by', () => {
    const registry = taskToolRegistry({} as AgentToolDeps);
    const rows = permissionActions(registry).filter((row) => row.area === 'tasks');
    expect(rows.map((row) => row.id).sort()).toEqual([...LEGACY_GATE_ACTION_IDS].sort());
    for (const row of rows) expect(row.toolName).toBe(row.id);
  });

  it('keeps a capability that declares none exactly as it is', () => {
    const plain = { ...gated('tasks_list', 'tasks_list'), gateActionId: undefined };
    expect(gateViewOf(plain)).toBe(plain);
  });
});

describe('term 3: an approval binds to the gate id and the capability together', () => {
  it('hashes the capability’s own id beside the input', () => {
    const view = gateViewOf(tasksAgentToolsDomain.capabilities[3]!);
    const input = { id: 'task-1' };
    expect(hashApprovalInput(approvalBindingInput(view, input, undefined))).not.toBe(
      hashApprovalInput(input)
    );
    expect(approvalBindingInput({}, input, undefined)).toBe(input);
  });
});

describe('term 4: a stored old-name setting still decides each moved tool', () => {
  let store: TaskStore;
  let approvals: ApprovalService;
  let config: PermissionConfigInput;
  let deps: AgentToolDeps;
  let taskId: string;

  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    store = new TaskStore(createTestDb());
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
    config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
    initPermissionGate({ readConfig: () => config, readAgentPermissions: async () => undefined });
    deps = { taskStore: store, defaultCwd: '/tmp/test', dorkHome: '/tmp/test' } as never;
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
    tasks_create: () => ({
      name: 'another',
      prompt: 'x',
      cron: '0 4 * * *',
      reason: 'r',
    }),
    tasks_update: (id) => ({ id, prompt: 'changed' }),
    tasks_delete: (id) => ({ id }),
    tasks_get_run_history: (id) => ({ schedule_id: id }),
  };

  const servers = ['in-session', 'external'] as const;
  const rows = LEGACY_GATE_ACTION_IDS.flatMap((tool) =>
    servers.map((server) => [tool, server] as const)
  );

  it.each(rows)('%s on %s: a stored Blocked blocks, and nothing runs', async (tool, server) => {
    config.defaults.actions[tool] = 'blocked';
    const tools = gatedTaskTools(deps, { identity: AGENT, sessionId: 'ses-1', mcpServer: server });
    const result = await tools[tool]!.handler(ARGS[tool]!(taskId));
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ capabilityId: tool, reason: 'permission_blocked' });
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTask(taskId)?.prompt).toBe('sweep');
  });

  it.each(rows)('%s on %s: a stored Ask asks where the hand gate asked', async (tool, server) => {
    config.defaults.actions[tool] = 'ask';
    const tools = gatedTaskTools(deps, { identity: AGENT, sessionId: 'ses-1', mcpServer: server });
    const result = await tools[tool]!.handler(ARGS[tool]!(taskId));
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const capability = tasksAgentToolsDomain.capabilities.find((c) => c.gateActionId === tool)!;
    if (capability.tier === 'observe') {
      // A read runs under Ask, on either gate: Ask holds what changes something.
      expect(payload).not.toHaveProperty('status', 'approval_required');
      return;
    }
    expect(payload).toMatchObject({
      status: 'approval_required',
      capabilityId: tool,
      capabilityTitle: capability.title,
    });
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTask(taskId)?.prompt).toBe('sweep');
  });

  it('an approval the hand gate would have minted for tasks_delete does not let the capability run', async () => {
    const input = { id: taskId };
    const old = approvals.request({
      capabilityId: 'tasks_delete',
      inputHash: hashApprovalInput(input),
      summary: 'Delete a scheduled task',
    });
    approvals.grant(old.approvalId);
    const tools = gatedTaskTools(deps, { identity: AGENT, sessionId: 'ses-1' });
    const result = await tools.tasks_delete!.handler({ ...input, approvalToken: old.token });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ capabilityId: 'tasks_delete' });
    expect(payload.status).not.toBe('ok');
    expect(store.getTask(taskId)).not.toBeNull();
  });
});
