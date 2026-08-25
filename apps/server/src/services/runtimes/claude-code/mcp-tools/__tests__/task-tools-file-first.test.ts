/**
 * `tasks_*` writes a real file, files it under a real agent, and stops dropping
 * fields (DOR-1568).
 *
 * The bug these pin was reported from a live session, not from review. An agent
 * asked `tasks_create` for a schedule and got one: a row with `filePath: ''` and
 * `agentId: null`, backed by no SKILL.md at all. Nothing reconciles such a row,
 * no agent owns it, and its runs happen in the server's own working directory.
 * The agent then tried to attach the task to itself and was told that worked too —
 * `tasks_update` has no field for it, so the argument was stripped in silence.
 *
 * So these tests are deliberately about the FILE and the OWNER rather than about
 * the response: "the tool returned a schedule" was true the whole time it was
 * broken. Everything here runs against a real temp directory and a real
 * `TaskStore`; nothing about the filesystem is mocked, because the filesystem is
 * the thing that was missing.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-file-first
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../task-tools.js';

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  inputSchema: Record<string, { description?: string; isOptional?: () => boolean }>;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/** Whether a path exists, asked without caring why it does not. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('tasks_create writes a file and files the task under an agent', () => {
  let db: Db;
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let dorkHome: string;
  let projectPath: string;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-file-first-'));
    dorkHome = path.join(root, 'dork');
    projectPath = path.join(root, 'project');
    await fs.mkdir(dorkHome, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      dorkHome,
      // Only `nightly-bot` is registered. Everything else is an agent DorkOS has
      // never heard of, which is what the "refuse rather than orphan" case needs.
      meshCore: { getProjectPath: (id: string) => (id === 'nightly-bot' ? projectPath : null) },
    } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
  });

  afterEach(async () => {
    store.close();
    await fs.rm(path.dirname(dorkHome), { recursive: true, force: true });
  });

  /** Call a tool and parse its single JSON content block. */
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tools[name]!.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  const BASE = {
    name: 'nightly-sweep',
    prompt: 'sweep the backlog',
    cron: '0 3 * * *',
    reason: 'The overnight backlog needs sweeping before you start.',
  };

  it('asks where the task goes, and will not guess', () => {
    // Required in the ADVERTISED schema, which is what the SDK enforces before the
    // handler is ever reached — the same mechanism that makes `reason` unskippable.
    // A default would be the bug in a politer form: `global` files an agent's own
    // work where it does not belong.
    expect(tools.tasks_create!.inputSchema.target?.isOptional?.()).not.toBe(true);
    expect(tools.tasks_create!.inputSchema.target?.description).toContain('Required');
  });

  it('writes a SKILL.md under the agent and points the row at it', async () => {
    const { isError, payload } = await call('tasks_create', { ...BASE, target: 'nightly-bot' });
    expect(isError).toBe(false);

    const created = payload.schedule as Task;
    // The two fields that were empty on every task this tool made.
    expect(created.filePath, 'a task with no file is an orphan').not.toBe('');
    expect(created.agentId).toBe('nightly-bot');

    const expected = path.join(projectPath, '.agents', 'skills', 'nightly-sweep', 'SKILL.md');
    expect(await exists(expected), `expected a SKILL.md at ${expected}`).toBe(true);
    const content = await fs.readFile(expected, 'utf-8');
    expect(content).toContain('sweep the backlog');
    expect(content).toContain('0 3 * * *');
  });

  it('writes a global task into the DorkOS skills root, owned by nobody', async () => {
    const { isError, payload } = await call('tasks_create', { ...BASE, target: 'global' });
    expect(isError).toBe(false);

    const created = payload.schedule as Task;
    expect(created.agentId).toBeNull();
    expect(await exists(path.join(dorkHome, 'skills', 'nightly-sweep', 'SKILL.md'))).toBe(true);
  });

  it('refuses an agent nobody registered, and creates nothing at all', async () => {
    const before = store.getTasks().length;
    const { isError, payload } = await call('tasks_create', {
      ...BASE,
      target: 'who-even-is-this',
    });

    expect(isError).toBe(true);
    expect(String(payload.error)).toContain('not found in registry');
    // The point of refusing: an unresolvable target used to become an orphan.
    expect(store.getTasks()).toHaveLength(before);
  });

  it('keeps the maxRuntime it was given, in the row and in the file', async () => {
    // It used to accept the argument and hardcode `null` in its place, so every
    // agent-scheduled task ran with no time limit whatever it asked for.
    const { isError, payload } = await call('tasks_create', {
      ...BASE,
      target: 'global',
      maxRuntime: '15m',
    });
    expect(isError).toBe(false);

    const created = payload.schedule as Task;
    expect(created.maxRuntime).toBe(15 * 60 * 1000);

    const content = await fs.readFile(
      path.join(dorkHome, 'skills', 'nightly-sweep', 'SKILL.md'),
      'utf-8'
    );
    expect(content).toContain('15m');
  });

  it('still parks the task at pending_approval, file or no file', async () => {
    const { payload } = await call('tasks_create', { ...BASE, target: 'global' });
    const created = payload.schedule as Task;
    expect(created.status).toBe('pending_approval');
    expect(created.reason).toBe(BASE.reason);
  });

  it('refuses a cron nothing can read, before writing anything', async () => {
    const { isError, payload } = await call('tasks_create', {
      ...BASE,
      target: 'global',
      cron: 'every other tuesday',
    });
    expect(isError).toBe(true);
    expect(String(payload.error).length).toBeGreaterThan(0);
    expect(store.getTasks()).toHaveLength(0);
    expect(await exists(path.join(dorkHome, 'skills', 'nightly-sweep'))).toBe(false);
  });

  it('refuses `agentId` rather than dropping it, and points at `target`', async () => {
    const before = store.getTasks().length;
    const { isError, payload } = await call('tasks_create', {
      ...BASE,
      target: 'global',
      agentId: 'nightly-bot',
    });
    expect(isError).toBe(true);
    expect(payload.fields).toEqual(['agentId']);
    expect(String(payload.message)).toContain('target');
    expect(store.getTasks()).toHaveLength(before);
  });

  it('deletes the file too, so a deleted task stays deleted', async () => {
    // Deleting the row alone is undone by the next reconcile, which re-reads every
    // skills root and upserts what it finds — the task came back minutes after the
    // agent was told it was gone.
    const { payload } = await call('tasks_create', { ...BASE, target: 'global' });
    const created = payload.schedule as Task;
    const dir = path.join(dorkHome, 'skills', 'nightly-sweep');
    expect(await exists(dir)).toBe(true);

    const deleted = await call('tasks_delete', { id: created.id });
    expect(deleted.isError).toBe(false);
    expect(store.getTask(created.id)).toBeNull();
    expect(await exists(dir), 'the SKILL.md must go with the row').toBe(false);
  });
});

describe('tasks_update refuses to re-home a task instead of pretending', () => {
  let db: Db;
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let existing: Task;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    const deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      dorkHome: '/tmp/dorkos-rehome-test',
    } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
  });

  afterEach(() => {
    store.close();
  });

  /** Call a tool and parse its single JSON content block. */
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tools[name]!.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  it('advertises target and agentId so the SDK cannot strip them first', () => {
    // The whole mechanism: an argument the schema does not declare is dropped
    // before the handler runs, and the caller is told the call succeeded. Declaring
    // them is what lets the refusal happen at all.
    for (const field of ['target', 'agentId']) {
      expect(tools.tasks_update!.inputSchema[field]?.description ?? '').toContain('Not');
    }
  });

  for (const field of ['target', 'agentId']) {
    it(`refuses \`${field}\` and writes nothing else from the same call`, async () => {
      const { isError, payload } = await call('tasks_update', {
        id: existing.id,
        prompt: 'a different prompt',
        [field]: 'some-other-agent',
      });

      expect(isError).toBe(true);
      expect(payload.code).toBe('unknown_task_field');
      expect(payload.fields).toEqual([field]);
      // Says what to do instead, because a model told only "no" tries again.
      expect(String(payload.message)).toContain('delete this task and create it again');

      // Refused WHOLE: the legitimate field did not land either.
      const after = store.getTask(existing.id)!;
      expect(after.prompt).toBe('the prompt the person approved');
      expect(after.updatedAt).toBe(existing.updatedAt);
    });
  }

  it('leaves the fields an agent may write working', async () => {
    // The guard has to be provably narrow, or every test above would pass on a
    // handler that refused everything.
    const { isError } = await call('tasks_update', {
      id: existing.id,
      prompt: 'an updated prompt',
    });
    expect(isError).toBe(false);
    expect(store.getTask(existing.id)!.prompt).toBe('an updated prompt');
  });
});
