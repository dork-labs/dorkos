/**
 * An agent's schedule whose own folder is home or the data folder (DOR-4067) follows the
 * DOR-4136 level rule: refused below Full, and allowed at Full, unmarked, as a person's would be.
 * The level is the one the calling turn really ran at, read from the server's own turn record.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
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

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
}

let store: TaskStore;
let root: string;
let home: string;
let dorkHome: string;
let agentFolder: string;
let serial = 0;

/** Run one turn stored at `mode`, so the server has a real level for the chat. */
async function ranTurn(mode: string, opts?: Record<string, unknown>): Promise<string> {
  const sessionId = `ses-own-folder-${++serial}`;
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => mode
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts as never)) {
    // drain
  }
  return sessionId;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-own-folder-')));
  home = path.join(root, 'home');
  dorkHome = path.join(home, '.dork');
  await fs.mkdir(dorkHome, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dorkHome);
  store = new TaskStore(createTestDb());
});

afterEach(async () => {
  store.close();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

/** The scout agent's in-session tools from chat `sessionId`, its folder set to `folder`. */
function toolsOf(folder: string, sessionId: string | undefined): Record<string, SessionTool> {
  agentFolder = folder;
  const agents = [{ id: 'scout', name: 'scout', projectPath: agentFolder }];
  const deps = {
    taskStore: store,
    defaultCwd: root,
    dorkHome,
    meshCore: {
      listWithPaths: () => agents,
      getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
    } as unknown as MeshCore,
  } as unknown as McpToolDeps;
  const tools = getTasksTools(deps, () => ({
    ...(sessionId !== undefined && { sessionId }),
    agentPath: agentFolder,
  }));
  return Object.fromEntries((tools as unknown as SessionTool[]).map((t) => [t.name, t] as const));
}

async function create(tools: Record<string, SessionTool>, target?: string) {
  const result = await tools.tasks_create!.handler(
    {
      name: 'sweep',
      prompt: 'Sweep.',
      cron: '0 3 * * *',
      reason: 'The backlog needs sweeping.',
      ...(target !== undefined && { target }),
    },
    undefined
  );
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

describe.each([
  ['home', () => home],
  ['the data folder', () => dorkHome],
])('an agent whose own folder is %s', (_label, folderOf) => {
  it.each(['default', 'acceptEdits', 'plan'])(
    'is refused from a turn at %s, and nothing is written',
    async (mode) => {
      const outcome = await create(toolsOf(folderOf(), await ranTurn(mode)), 'global');
      expect(outcome.isError).toBe(true);
      expect(outcome.payload.code).toBe('PROTECTED_FOLDER');
      expect(store.getTasks()).toEqual([]);
    }
  );

  it('is refused from a Full turn that read words from outside the team', async () => {
    const sessionId = await ranTurn('bypassPermissions', { carriedMarks: { outsider: true } });
    const outcome = await create(toolsOf(folderOf(), sessionId));
    expect(outcome.payload.code).toBe('PROTECTED_FOLDER');
    expect(store.getTasks()).toEqual([]);
  });

  it('is refused with no chat to read a level from', async () => {
    const outcome = await create(toolsOf(folderOf(), undefined));
    expect(outcome.payload.code).toBe('PROTECTED_FOLDER');
    expect(store.getTasks()).toEqual([]);
  });

  it.each([undefined, 'global', 'scout'])(
    'files target %s under itself from a Full, unmarked turn, as a person could',
    async (target) => {
      const outcome = await create(toolsOf(folderOf(), await ranTurn('bypassPermissions')), target);
      expect(outcome.isError).toBe(false);
      const [task] = store.getTasks();
      expect(task?.agentId).toBe('scout');
    }
  );
});

it('a Full agent with a safe folder still files a global schedule under itself', async () => {
  const folder = path.join(home, 'projects', 'scout');
  await fs.mkdir(folder, { recursive: true });
  const outcome = await create(toolsOf(folder, await ranTurn('bypassPermissions')), 'global');
  expect(outcome.isError).toBe(false);
  const [task] = store.getTasks();
  expect(task?.agentId).toBe('scout');
  expect(task?.filePath.startsWith(folder)).toBe(true);
});
