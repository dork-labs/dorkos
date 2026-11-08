/**
 * A Full chat's cross-agent task write still meets its own Tasks permission first (DOR-3938,
 * Security): the real `tasks_create` and `tasks_update`, behind the real in-session tool gate,
 * are refused before they run when a person set the calling agent's Tasks area to Blocked.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { AgentPermissions } from '@dorkos/shared/permissions';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../../tasks/scheduled-run-power.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../tasks/scheduled-run-power.js')>();
  const { CLAUDE_CODE_CAPABILITIES } = await import('../../runtime-constants.js');
  return { ...actual, capabilitiesForTaskRuntime: () => CLAUDE_CODE_CAPABILITIES };
});

import { TaskStore } from '../../../../tasks/task-store.js';
import { getTasksTools } from '../tasks/task-tools.js';
import type { McpToolDeps } from '../types.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../../../core/mcp-tool-gate.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../../core/approvals/index.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';

let store: TaskStore;
let scratch: string;
let homeA: string;
let agentPermissions: AgentPermissions | undefined;

async function fullTurn(sessionId: string): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

beforeEach(async () => {
  agentPermissions = undefined;
  const db = createTestDb();
  store = new TaskStore(db);
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-cross-gate-')));
  homeA = path.join(scratch, 'a');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(path.join(scratch, 'b'), { recursive: true });
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(db) });
  initPermissionGate({
    readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => agentPermissions,
  });
});

afterEach(async () => {
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
  store.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Agent A's real task tools, behind the real in-session gate, from a Full chat. */
async function gatedToolsOfA() {
  const sessionId = `ses-gate-${Math.random()}`;
  await fullTurn(sessionId);
  const agents = [
    { id: 'agent-a', name: 'alpha', projectPath: homeA },
    { id: 'agent-b', name: 'bravo', projectPath: path.join(scratch, 'b') },
  ];
  const deps = {
    taskStore: store,
    defaultCwd: scratch,
    dorkHome: scratch,
    meshCore: {
      listWithPaths: () => agents,
      getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
    } as unknown as MeshCore,
  } as unknown as McpToolDeps;
  const raw = getTasksTools(deps, () => ({
    sessionId,
    agentPath: homeA,
  })) as unknown as SdkMcpTool[];
  const gated = gateHandRegisteredMcpTools(raw, async () => ({
    identity: { agentPath: homeA, displayName: 'alpha', createdAt: new Date().toISOString() },
  }));
  return Object.fromEntries(gated.map((t) => [t.name, t] as const));
}

const CREATE = {
  name: 'sweep',
  prompt: 'Sweep.',
  cron: '0 3 * * *',
  reason: 'Bravo asked.',
  target: 'agent-b',
};

describe('the caller’s own Tasks permission still applies at Full', () => {
  it('a Full caller whose Tasks area is Blocked is refused, and nothing is written', async () => {
    agentPermissions = { areas: { tasks: 'blocked' } } as AgentPermissions;
    const tools = await gatedToolsOfA();
    const result = await tools.tasks_create!.handler(CREATE as never, {});
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
    expect(JSON.parse(text)).toMatchObject({ reason: 'permission_blocked' });
    expect(store.getTasks()).toEqual([]);

    const theirs = store.createTask({
      name: 'b-nightly',
      description: 'b',
      prompt: 'B’s work.',
      cron: '0 2 * * *',
      agentId: 'agent-b',
      filePath: path.join(scratch, 'none', 'SKILL.md'),
    });
    const edit = await tools.tasks_update!.handler({ id: theirs.id, prompt: 'X.' } as never, {});
    const editText = edit.content[0]!.type === 'text' ? edit.content[0]!.text : '';
    expect(JSON.parse(editText)).toMatchObject({ reason: 'permission_blocked' });
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');
  });

  it('with Tasks not Blocked, the same Full call goes through', async () => {
    const tools = await gatedToolsOfA();
    const result = await tools.tasks_create!.handler(CREATE as never, {});
    expect(result.isError).not.toBe(true);
    expect(store.getTasks()[0]!.agentId).toBe('agent-b');
  });
});
