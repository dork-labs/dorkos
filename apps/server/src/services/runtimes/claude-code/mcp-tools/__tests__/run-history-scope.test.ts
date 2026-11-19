/**
 * `tasks_get_run_history` in a chat answers only for the calling agent's own schedules and global
 * ones (DOR-4600, Security on #3883): another agent's runs are refused, as its edits are, unless
 * the turn runs at Full autonomy unmarked. The sessionless external server keeps its answer.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/run-history-scope
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../../../tasks/task-store.js';
import { getTasksTools } from '../tasks/task-tools.js';
import { UNIDENTIFIED_RUNS_MESSAGE } from '../tasks/task-tool-parts.js';
import type { McpToolDeps } from '../types.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';

let store: TaskStore;
let scratch: string;
let homeA: string;
let deps: McpToolDeps;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'run-history-scope-')));
  homeA = path.join(scratch, 'a');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(path.join(scratch, 'b'), { recursive: true });
  const agents = [
    { id: 'agent-a', name: 'alpha', projectPath: homeA },
    { id: 'agent-b', name: 'bravo', projectPath: path.join(scratch, 'b') },
  ];
  deps = {
    taskStore: store,
    defaultCwd: scratch,
    dorkHome: scratch,
    meshCore: {
      listWithPaths: () => agents,
      getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
    } as unknown as MeshCore,
  } as unknown as McpToolDeps;
});

afterEach(async () => {
  store.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A chat whose last turn ran at `mode`, as the turn-level record keeps it. */
async function ranTurn(mode: string): Promise<string> {
  const sessionId = `ses-${Math.random()}`;
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
  return sessionId;
}

/** A schedule filed under `agentId` (or global), with one run on it. */
function taskWithRun(agentId: string | null): string {
  const task = store.createTask({
    name: `t-${agentId ?? 'global'}`,
    description: 'd',
    prompt: 'Do the thing.',
    cron: '0 2 * * *',
    agentId,
    filePath: path.join(scratch, 'none', 'SKILL.md'),
  });
  store.createRun(task.id, 'scheduled');
  return task.id;
}

/** Run history as agent A's chat `sessionId` reads it, or the external server when undefined. */
async function historyAs(sessionId: string | undefined, scheduleId: string) {
  const tools = getTasksTools(
    deps,
    sessionId === undefined ? undefined : () => ({ sessionId, agentPath: homeA })
  );
  const tool = tools.find((t) => t.name === 'tasks_get_run_history')!;
  const result = (await tool.handler({ schedule_id: scheduleId }, {})) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as {
      runs?: unknown[];
      code?: string;
      error?: string;
    },
  };
}

describe('tasks_get_run_history reads only the caller’s own schedules', () => {
  it('answers for its own schedule and a global one', async () => {
    const session = await ranTurn('default');
    for (const id of [taskWithRun('agent-a'), taskWithRun(null)]) {
      const { isError, payload } = await historyAs(session, id);
      expect(isError).toBe(false);
      expect(payload.runs).toHaveLength(1);
    }
  });

  it('refuses another agent’s schedule below Full, saying why', async () => {
    const session = await ranTurn('default');
    const { isError, payload } = await historyAs(session, taskWithRun('agent-b'));
    expect(isError).toBe(true);
    expect(payload.code).toBe('not_your_schedule');
    expect(payload.runs).toBeUndefined();
    expect(payload.error).toMatch(/another agent/);
  });

  it('answers for another agent’s schedule from a Full, unmarked turn', async () => {
    const session = await ranTurn('bypassPermissions');
    const { isError, payload } = await historyAs(session, taskWithRun('agent-b'));
    expect(isError).toBe(false);
    expect(payload.runs).toHaveLength(1);
  });

  it('refuses an agent’s schedule to a chat DorkOS can’t name, saying so', async () => {
    const tools = getTasksTools(deps, () => ({ sessionId: 'ses-nameless' }));
    const tool = tools.find((t) => t.name === 'tasks_get_run_history')!;
    const result = (await tool.handler({ schedule_id: taskWithRun('agent-a') }, {})) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toBe(UNIDENTIFIED_RUNS_MESSAGE);
  });

  it('leaves the sessionless external server’s answer as it was', async () => {
    const { isError, payload } = await historyAs(undefined, taskWithRun('agent-b'));
    expect(isError).toBe(false);
    expect(payload.runs).toHaveLength(1);
  });
});
