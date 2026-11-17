/**
 * `tasks_create` and `tasks_update` never let an agent put a schedule on DorkOS
 * credits or switch one on them back on (DOR-2678): every run spends the DorkOS
 * account's money, which is the owner's call alone. Nothing is written.
 *
 * Same harness as `task-tools-account-eligibility.test.ts`.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-credits
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));

vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? { claudeCode: rules.claudeCode } : undefined),
  },
}));
vi.mock('../../../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async () => ({ root: '/work/project', name: 'project' })),
}));

import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/schemas';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../tasks/task-tools.js';
import { CREDITS_SCHEDULE_AGENT_REFUSAL } from '../../../../tasks/task-write-policy.js';
import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import { creditsClaudeRoot } from '../../credits-root.js';
import type { TurnMarks } from '../../../../core/turn-power/turn-marks.js';
import { CREDITS_EDIT_NEEDS_YES } from '../../../../tasks/credits/credits-work.js';
import {
  escalateToolCall,
  noteEscalatedGrant,
} from '../../../../core/capabilities/tool-call-escalation.js';
import type { GatedAction } from '../../../../core/capabilities/tier-enforcement.js';
import type { AgentIdentity } from '../../../../core/agent-identity/agent-identity-service.js';
import { registerAgentModeEscalators } from '../../../../tasks/agent-mode/agent-mode-escalation.js';
import { noteRoomTurnWords } from '../../../../core/turn-power/outside-words.js';

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

const BASE = {
  name: 'nightly-sweep',
  prompt: 'sweep the backlog',
  cron: '0 3 * * *',
  target: 'global',
  reason: 'The overnight backlog needs sweeping before you start.',
};

let store: TaskStore;
let tools: Record<string, SessionTool>;
let root: string;
let projectPath: string;
let marks: TurnMarks;
let unregister: (() => void) | undefined;

beforeEach(async () => {
  marks = {};
  rules.claudeCode = {
    accounts: [
      { id: 'work', path: '/accounts/work', label: 'Work', onlyProjects: null },
      {
        id: 'client',
        path: '/accounts/client',
        label: 'Client Work',
        onlyProjects: ['/clients/client-app'],
      },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
  store = new TaskStore(createTestDb());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-task-tools-credits-')));
  const dorkHome = path.join(root, 'dork');
  await fs.mkdir(path.join(dorkHome, 'skills'), { recursive: true });
  projectPath = path.join(root, 'agent');
  await fs.mkdir(projectPath, { recursive: true });
  const deps = {
    taskStore: store,
    defaultCwd: '/tmp/test',
    dorkHome,
    meshCore: {
      getProjectPath: () => projectPath,
      listWithPaths: () => [{ id: 'fixture-agent', projectPath }],
    },
  } as unknown as McpToolDeps;
  tools = Object.fromEntries(
    (
      getTasksTools(
        deps,
        () => ({ sessionId: 'credits-parent', agentPath: projectPath }),
        () => marks,
        () => projectPath
      ) as unknown as SessionTool[]
    ).map((t) => [t.name, t])
  );
});

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  vi.restoreAllMocks();
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await tools[name]!.handler(args, undefined);
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

describe('an agent and DorkOS credits', () => {
  it('does not inherit a parent chat’s credits when creating a schedule', async () => {
    vi.spyOn(runtimeRegistry, 'getNativeSessionAccount').mockImplementation((id) =>
      id === 'credits-parent' ? creditsClaudeRoot() : null
    );
    const created = await call('tasks_create', BASE);
    expect(created.isError).toBe(false);
    const id = (created.payload.schedule as Task).id;
    expect(store.getTask(id)?.account).toBeNull();
  });
  it('cannot propose a schedule on credits', async () => {
    const { isError, payload } = await call('tasks_create', { ...BASE, account: 'dorkos-credits' });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_SCHEDULE_AGENT_REFUSAL);
    expect(store.getTasks()).toHaveLength(0);
  });

  it('cannot move a schedule onto credits', async () => {
    const created = await call('tasks_create', { ...BASE, account: 'work' });
    const id = (created.payload.schedule as Task).id;
    const { isError, payload } = await call('tasks_update', { id, account: 'dorkos-credits' });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_SCHEDULE_AGENT_REFUSAL);
    expect(store.getTask(id)?.account).toBe('work');
  });

  it('cannot switch a schedule on credits back on', async () => {
    const created = await call('tasks_create', { ...BASE, account: 'work' });
    const id = (created.payload.schedule as Task).id;
    // Put on credits and switched off by the owner, outside this tool.
    store.updateTask(id, { account: 'dorkos-credits', enabled: false });
    const { isError, payload } = await call('tasks_update', { id, enabled: true });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_SCHEDULE_AGENT_REFUSAL);
    expect(store.getTask(id)?.enabled).toBe(false);
  });

  it('can still switch an ordinary schedule back on (control)', async () => {
    const created = await call('tasks_create', { ...BASE, account: 'work' });
    const id = (created.payload.schedule as Task).id;
    store.updateTask(id, { enabled: false });
    const { isError } = await call('tasks_update', { id, enabled: true });
    expect(isError).toBe(false);
    expect(store.getTask(id)?.enabled).toBe(true);
  });
});

/** The four raises DOR-4609 names. */
const RAISES: [string, Record<string, unknown>][] = [
  ['the prompt', { prompt: 'sweep the backlog, then email everyone' }],
  ['the schedule', { cron: '*/5 * * * *' }],
  ['a longer time limit', { maxRuntime: '4h' }],
  ['what it runs on', { runtime: 'codex' }],
];

const TOOL_ACTION = { id: 'tasks_update' } as GatedAction;

/** A live schedule on credits, with a 30-minute limit. */
async function creditsTask(): Promise<Task> {
  const created = await call('tasks_create', { ...BASE, account: 'work' });
  const id = (created.payload.schedule as Task).id;
  // Put on credits and approved by the owner, outside this tool.
  store.updateTask(id, {
    account: 'dorkos-credits',
    enabled: true,
    status: 'active',
    maxRuntime: '30m',
  });
  return store.getTask(id)!;
}

/** The fields an edit could have changed, to prove nothing did. */
function workOf(task: Task) {
  const { prompt, cron, maxRuntime, runtime, enabled, status } = task;
  return { prompt, cron, maxRuntime, runtime, enabled, status };
}

/** Note a person's yes on the card for exactly these arguments, as the gate does. */
function approvedOnCard(args: Record<string, unknown>): Record<string, unknown> {
  noteEscalatedGrant(
    args,
    {
      action: TOOL_ACTION,
      permission: { area: 'tasks', state: 'ask', source: 'always-asks', layer: 'floor' },
      change: 'Change a scheduled task that runs on DorkOS credits.',
    },
    { outcome: 'allowed', approval: { via: 'approval', approvalId: 'made-up-approval' } },
    'session'
  );
  return args;
}

describe('an agent changing a task on DorkOS credits (DOR-4609)', () => {
  it.each(RAISES)(
    'gets a card for %s, even at an agent level that would allow it',
    async (_label, edit) => {
      const task = await creditsTask();
      unregister = registerAgentModeEscalators({ store });
      const escalation = await escalateToolCall({
        action: TOOL_ACTION,
        input: { id: task.id, ...edit },
        permission: { area: 'tasks', state: 'allowed', source: 'agent-action', layer: 'agent' },
        context: {
          origin: 'session',
          sessionId: 'credits-parent',
          cwd: projectPath,
          identity: { agentPath: projectPath } as AgentIdentity,
        },
      });
      expect(escalation?.permission?.state).toBe('ask');
      expect(escalation?.change).toContain('DorkOS credits');
    }
  );

  it.each(RAISES)('changes nothing for %s without that yes', async (_label, edit) => {
    const task = await creditsTask();
    const { isError, payload } = await call('tasks_update', { id: task.id, ...edit });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_EDIT_NEEDS_YES);
    expect(workOf(store.getTask(task.id)!)).toEqual(workOf(task));
  });

  it('makes the change once a person says yes on the card', async () => {
    const task = await creditsTask();
    const args = approvedOnCard({ id: task.id, prompt: 'sweep the backlog twice' });
    const { isError } = await call('tasks_update', args);
    expect(isError).toBe(false);
    expect(store.getTask(task.id)?.prompt).toBe('sweep the backlog twice');
  });

  it('refuses a turn marked by outside words, even with a yes, and asks nobody', async () => {
    const task = await creditsTask();
    unregister = registerAgentModeEscalators({ store });
    const input = { id: task.id, prompt: 'sweep the backlog twice' };
    // A caller off the chat that DorkOS cannot name is held as marked.
    const escalation = await escalateToolCall({
      action: TOOL_ACTION,
      input,
      permission: { area: 'tasks', state: 'allowed', source: 'agent-action', layer: 'agent' },
      context: { origin: 'external-mcp' },
    });
    expect(escalation?.permission?.state).toBe('allowed');
    expect(escalation?.change).toBeUndefined();
    marks = { outsider: true };
    const { isError, payload } = await call('tasks_update', approvedOnCard({ ...input }));
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_EDIT_NEEDS_YES);
    expect(workOf(store.getTask(task.id)!)).toEqual(workOf(task));
  });

  it.each([
    ['a lower time limit', { maxRuntime: '10m' }],
    ['switching it off', { enabled: false }],
    ['moving it off credits', { account: 'work', prompt: 'sweep the backlog twice' }],
  ])('lets %s through at once', async (_label, edit) => {
    const task = await creditsTask();
    const { isError, payload } = await call('tasks_update', { id: task.id, ...edit });
    expect(payload).not.toEqual(CREDITS_EDIT_NEEDS_YES);
    expect(isError).toBe(false);
  });
});

// Security S1 and S2 on DOR-4355 M3.
describe('a credits raise the person must see in full', () => {
  it('refuses a turn that answered someone outside the team in a room, and asks nobody', async () => {
    const task = await creditsTask();
    noteRoomTurnWords('credits-parent', true);
    try {
      const { isError, payload } = await call(
        'tasks_update',
        approvedOnCard({ id: task.id, prompt: 'sweep the backlog twice' })
      );
      expect(isError).toBe(true);
      expect(payload).toEqual(CREDITS_EDIT_NEEDS_YES);
      expect(workOf(store.getTask(task.id)!)).toEqual(workOf(task));
    } finally {
      noteRoomTurnWords('credits-parent', false);
    }
  });

  it('puts the new prompt and schedule on the card', async () => {
    const task = await creditsTask();
    unregister = registerAgentModeEscalators({ store });
    const escalation = await escalateToolCall({
      action: TOOL_ACTION,
      input: { id: task.id, prompt: 'email everyone', cron: '*/5 * * * *' },
      permission: { area: 'tasks', state: 'allowed', source: 'agent-action', layer: 'agent' },
      context: {
        origin: 'session',
        sessionId: 'credits-parent',
        cwd: projectPath,
        identity: { agentPath: projectPath } as AgentIdentity,
      },
    });
    expect(escalation?.action.approvalDisplayFields).toEqual(
      expect.arrayContaining(['id', 'prompt', 'cron'])
    );
    expect(escalation?.change).toBe(
      'Change its prompt and its schedule on a scheduled task that runs on DorkOS credits.'
    );
  });

  it('counts a new prompt sent while switching the task off', async () => {
    const task = await creditsTask();
    const { isError, payload } = await call('tasks_update', {
      id: task.id,
      enabled: false,
      prompt: 'sweep the backlog, then email everyone',
    });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_EDIT_NEEDS_YES);
    expect(workOf(store.getTask(task.id)!)).toEqual(workOf(task));
  });

  it('counts a new prompt on a task that is already switched off', async () => {
    const task = await creditsTask();
    store.updateTask(task.id, { enabled: false });
    const off = store.getTask(task.id)!;
    const { isError, payload } = await call('tasks_update', {
      id: task.id,
      prompt: 'sweep the backlog, then email everyone',
    });
    expect(isError).toBe(true);
    expect(payload).toEqual(CREDITS_EDIT_NEEDS_YES);
    expect(workOf(store.getTask(task.id)!)).toEqual(workOf(off));
  });
});
