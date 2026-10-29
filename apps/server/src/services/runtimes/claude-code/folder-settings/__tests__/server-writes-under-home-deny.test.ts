/**
 * The home deny stops the agent's own file tools, not DorkOS (DOR-3068).
 *
 * Every launch denies Edit, Write, MultiEdit and NotebookEdit the agent home's
 * `.claude/**`, `.mcp.json` and `.dork/agent.json` ({@link homeWriteDenyRules}).
 * Those are Claude Code permission rules, read by the agent's CLI. What DorkOS
 * itself writes into a home (a task's SKILL.md from `tasks_create` and
 * `tasks_update`, a marketplace install, SOUL.md and HEARTBEAT.md) is written by
 * the server's own file calls, so none of it may route through the agent's
 * tools. This pins the one an agent asks for most: it creates and edits a task
 * in its own home, with the deny that home's launch carries, and the file lands.
 *
 * @module services/runtimes/claude-code/folder-settings/__tests__/server-writes-under-home-deny
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../../mcp-tools/types.js';
import { getTasksTools } from '../../mcp-tools/task-tools.js';
import { homeWriteDenyRules } from '../launch-folder-config.js';

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

let root: string;
let home: string;
let store: TaskStore;
let tools: Record<string, SessionTool>;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home-deny-server-writes-')));
  home = path.join(root, 'dork', 'agents', 'nightly-bot');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  store = new TaskStore(createTestDb());
  const deps = {
    taskStore: store,
    defaultCwd: home,
    dorkHome: path.join(root, 'dork'),
    meshCore: { getProjectPath: (id: string) => (id === 'nightly-bot' ? home : null) },
  } as unknown as McpToolDeps;
  tools = Object.fromEntries(
    (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
  );
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** Call a tool and parse its single JSON content block. */
async function call(name: string, args: Record<string, unknown>) {
  const result = await tools[name]!.handler(args, undefined);
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

describe('what DorkOS writes into an agent home under its deny', () => {
  it('creates and edits a task SKILL.md in the home while its launch denies the self-grant files', async () => {
    const deny = homeWriteDenyRules(home);
    expect(deny).toContain(`Write(/${home}/.claude/**)`);

    const created = await call('tasks_create', {
      name: 'nightly-sweep',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      reason: 'The overnight backlog needs sweeping before you start.',
      target: 'nightly-bot',
    });
    expect(created.isError).toBe(false);
    const file = path.join(home, '.agents', 'skills', 'nightly-sweep', 'SKILL.md');
    expect(await fs.readFile(file, 'utf-8')).toContain('sweep the backlog');

    const id = (created.payload.schedule as { id: string }).id;
    const updated = await call('tasks_update', { id, prompt: 'sweep it twice' });
    expect(updated.isError).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toContain('sweep it twice');
  });
});
