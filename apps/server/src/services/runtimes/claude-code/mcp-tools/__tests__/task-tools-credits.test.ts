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
import { getTasksTools } from '../task-tools.js';
import { CREDITS_SCHEDULE_AGENT_REFUSAL } from '../../../../tasks/task-write-policy.js';

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

beforeEach(async () => {
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
  const deps = {
    taskStore: store,
    defaultCwd: '/tmp/test',
    dorkHome,
    meshCore: { getProjectPath: () => null },
  } as unknown as McpToolDeps;
  tools = Object.fromEntries(
    (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
  );
});

afterEach(async () => {
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
