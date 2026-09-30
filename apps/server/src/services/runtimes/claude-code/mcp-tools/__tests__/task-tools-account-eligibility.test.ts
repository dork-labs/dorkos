/**
 * `tasks_create` and `tasks_update` hold to the account rules (spec
 * `flow-multiproject` §8.4): an agent never gets to put a schedule on an
 * account the person kept to other projects. Both answer with the plain
 * sentence and `account_not_allowed_here`, and nothing is written.
 *
 * Real store, create lifecycle and SKILL.md writes; the rules live in a
 * stand-in config, and every folder a run starts in is one project
 * (`/work/project`), so the rules alone decide.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-account-eligibility
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

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

const SENTENCE =
  "Client Work can't be used in project. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes.";

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
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-task-tools-acct-')));
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

describe('tasks_create', () => {
  it('refuses a proposal naming an account that may not work there, and writes nothing', async () => {
    const { isError, payload } = await call('tasks_create', { ...BASE, account: 'client' });
    expect(isError).toBe(true);
    expect(payload).toMatchObject({ error: SENTENCE, code: 'account_not_allowed_here' });
    expect(store.getTasks()).toHaveLength(0);
  });

  it('proposes a schedule on an account that may work there (control)', async () => {
    const { isError } = await call('tasks_create', { ...BASE, account: 'work' });
    expect(isError).toBe(false);
    expect(store.getTasks()).toHaveLength(1);
  });
});

describe('tasks_update', () => {
  it('refuses pointing a schedule at an account that may not work there', async () => {
    const created = await call('tasks_create', { ...BASE, account: 'work' });
    expect(created.isError).toBe(false);
    const id = (created.payload.schedule as Task).id;

    const { isError, payload } = await call('tasks_update', { id, account: 'client' });

    expect(isError).toBe(true);
    expect(payload).toEqual({ error: SENTENCE, code: 'account_not_allowed_here' });
    expect(store.getTask(id)?.account).toBe('work');
  });

  it('moves a schedule to another allowed account (control)', async () => {
    rules.claudeCode.accounts = [
      ...(rules.claudeCode.accounts as unknown[]),
      { id: 'spare', path: '/accounts/spare', label: 'Spare', onlyProjects: null },
    ];
    const created = await call('tasks_create', { ...BASE, account: 'work' });
    const id = (created.payload.schedule as Task).id;
    const { isError } = await call('tasks_update', { id, account: 'spare' });
    expect(isError).toBe(false);
    expect(store.getTask(id)?.account).toBe('spare');
  });
});
