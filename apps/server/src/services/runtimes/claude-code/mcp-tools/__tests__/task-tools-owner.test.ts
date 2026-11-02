/**
 * Whose schedule an agent may make or change through `tasks_create` and
 * `tasks_update` (DOR-3640 R1), on the in-session server and over the external
 * `/mcp` server: only its own, or a global one; never another agent's. Every
 * change leaves an audit row naming what it changed.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../../audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

import { TaskStore } from '../../../../tasks/task-store.js';
import { getTasksTools } from '../tasks/task-tools.js';
import type { McpToolDeps } from '../types.js';
import { recordAudit } from '../../../../audit/audit-trail.js';

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
}

let store: TaskStore;
let scratch: string;
let homeA: string;
let homeB: string;
let deps: McpToolDeps;

beforeEach(async () => {
  vi.mocked(recordAudit).mockClear();
  store = new TaskStore(createTestDb());
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-tools-owner-')));
  homeA = path.join(scratch, 'a');
  homeB = path.join(scratch, 'b');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(homeB, { recursive: true });
  const agents = [
    { id: 'agent-a', projectPath: homeA },
    { id: 'agent-b', projectPath: homeB },
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

/** A's tools, in session or over the external server. */
function toolsOfA(surface: 'in-session' | 'external'): Record<string, SessionTool> {
  const tools =
    surface === 'in-session'
      ? getTasksTools(deps, () => ({ sessionId: 'ses-a', agentPath: homeA }))
      : getTasksTools(
          deps,
          undefined,
          () => ({}),
          () => homeA
        );
  return Object.fromEntries((tools as unknown as SessionTool[]).map((t) => [t.name, t] as const));
}

async function call(tools: Record<string, SessionTool>, name: string, args: object) {
  const result = await tools[name]!.handler(args as Record<string, unknown>, undefined);
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

const ARGS = {
  name: 'sweep',
  prompt: 'Sweep.',
  cron: '0 3 * * *',
  reason: 'The backlog needs it.',
};

describe.each(['in-session', 'external'] as const)('over the %s server', (surface) => {
  it('refuses tasks_create filed under another agent', async () => {
    const { isError, payload } = await call(toolsOfA(surface), 'tasks_create', {
      ...ARGS,
      target: 'agent-b',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('not_your_agent');
    expect(store.getTasks()).toEqual([]);
  });

  it('lets tasks_create file one under itself, or a global one', async () => {
    const tools = toolsOfA(surface);
    expect((await call(tools, 'tasks_create', { ...ARGS, target: 'agent-a' })).isError).toBe(false);
    expect(
      (await call(tools, 'tasks_create', { ...ARGS, name: 'sweep-2', target: 'global' })).isError
    ).toBe(false);
  });

  it("refuses tasks_update on another agent's schedule, and changes nothing", async () => {
    const theirs = store.createTask({
      name: 'b-nightly',
      description: 'b',
      prompt: 'B’s work.',
      cron: '0 2 * * *',
      agentId: 'agent-b',
      filePath: path.join(scratch, 'none', 'SKILL.md'),
    });
    const { isError, payload } = await call(toolsOfA(surface), 'tasks_update', {
      id: theirs.id,
      prompt: 'Something else.',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('not_your_schedule');
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');
  });

  it('lets tasks_update change its own, and records which fields changed', async () => {
    const mine = store.createTask({
      name: 'a-nightly',
      description: 'a',
      prompt: 'A’s work.',
      cron: '0 2 * * *',
      agentId: 'agent-a',
      filePath: path.join(scratch, 'none', 'SKILL.md'),
    });
    const { isError } = await call(toolsOfA(surface), 'tasks_update', {
      id: mine.id,
      enabled: false,
    });
    expect(isError).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tasks.update',
        change: [{ field: 'enabled', before: true, after: false }],
      })
    );
  });
});

describe('an in-session chat DorkOS cannot name', () => {
  it("may not change an agent's schedule, but may pause it", async () => {
    const theirs = store.createTask({
      name: 'b-nightly',
      description: 'b',
      prompt: 'B’s work.',
      cron: '0 2 * * *',
      agentId: 'agent-b',
      filePath: path.join(scratch, 'none', 'SKILL.md'),
    });
    const tools = Object.fromEntries(
      (getTasksTools(deps, () => ({ sessionId: 'ses-x' })) as unknown as SessionTool[]).map(
        (t) => [t.name, t] as const
      )
    );
    const edit = await call(tools, 'tasks_update', { id: theirs.id, prompt: 'Run as B.' });
    expect(edit.isError).toBe(true);
    expect(edit.payload.code).toBe('not_your_schedule');
    const pause = await call(tools, 'tasks_update', { id: theirs.id, enabled: false });
    expect(pause.isError).toBe(false);
  });
});
