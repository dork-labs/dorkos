/**
 * An agent may choose WHICH runtime, model and effort a scheduled task runs on
 * (DOR-1615, DOR-1347, settled decision 10).
 *
 * Agent-writable on purpose: those fields pick the backend and how hard it
 * thinks, never how much power the run has — `permissionMode` and `status` stay
 * refused — and a caller that can already write the `prompt` can do far more
 * than pick a runtime.
 *
 * Driven through the real handler against a real `TaskStore` and a real temp
 * directory, and asserted on the FILE as well as the row: an argument this tool
 * accepts and then drops is the exact failure `tasks_update` shipped with before
 * DOR-1568, and "the tool returned a schedule" was true the whole time.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-execution-fields
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

describe('tasks_create / tasks_update carry runtime, model and effort', () => {
  let db: Db;
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let dorkHome: string;
  let root: string;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-task-exec-'));
    dorkHome = path.join(root, 'dork');
    await fs.mkdir(dorkHome, { recursive: true });
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
    target: 'global',
    reason: 'The overnight backlog needs sweeping before you start.',
  };

  /** The SKILL.md a global task with the base name is written to. */
  const skillPath = () => path.join(dorkHome, 'skills', 'nightly-sweep', 'SKILL.md');

  it('advertises all three as optional arguments on both tools', () => {
    // Optional is the contract: omitting them is the ordinary case and means
    // "whatever this task's agent runs on".
    for (const tool of ['tasks_create', 'tasks_update'] as const) {
      for (const field of ['runtime', 'model', 'effort'] as const) {
        expect(tools[tool]!.inputSchema[field], `${tool}.${field}`).toBeDefined();
        expect(tools[tool]!.inputSchema[field]?.isOptional?.(), `${tool}.${field}`).toBe(true);
      }
    }
  });

  it('writes all three onto the row AND into the file’s schedule block', async () => {
    const { isError, payload } = await call('tasks_create', {
      ...BASE,
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(isError).toBe(false);
    expect(payload.schedule as Task).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });

    const content = await fs.readFile(skillPath(), 'utf-8');
    // Inside the block, indented under `schedule:`. A top-level `model:` is the
    // Claude Code dialect a person's own invocation of the skill reads, so a
    // Codex model id there would be handed to Claude Code.
    expect(content).toMatch(/^ {2}runtime: codex$/m);
    expect(content).toMatch(/^ {2}model: gpt-5\.5$/m);
    expect(content).toMatch(/^ {2}effort: high$/m);
    expect(content).not.toMatch(/^model:/m);
  });

  it('leaves all three unset when the caller names none', async () => {
    const { payload } = await call('tasks_create', BASE);
    expect(payload.schedule as Task).toMatchObject({
      runtime: null,
      model: null,
      effort: null,
    });
    expect(await fs.readFile(skillPath(), 'utf-8')).not.toContain('runtime:');
  });

  it('changes them through tasks_update', async () => {
    // The ROW, which is what this handler writes — see the note below.
    const { payload } = await call('tasks_create', { ...BASE, runtime: 'codex' });
    const id = (payload.schedule as Task).id;

    const updated = await call('tasks_update', { id, runtime: 'opencode', model: 'zen' });
    expect(updated.isError).toBe(false);
    expect(store.getTask(id)).toMatchObject({ runtime: 'opencode', model: 'zen' });
  });

  it('CLEARS an override with null', async () => {
    const { payload } = await call('tasks_create', {
      ...BASE,
      runtime: 'codex',
      model: 'gpt-5.5',
    });
    const id = (payload.schedule as Task).id;

    await call('tasks_update', { id, runtime: null, model: null });

    expect(store.getTask(id)).toMatchObject({ runtime: null, model: null });
  });

  it('does NOT rewrite the SKILL.md — the whole tool is row-only, and that is a standing gap', async () => {
    // CHARACTERIZED, not endorsed. `createUpdateScheduleHandler` writes the row
    // and never the file — it says so in its own comment, in the paragraph about
    // the clamp window — and that is true of EVERY field it takes, `prompt` and
    // `cron` included, since long before these three. The reconciler re-reads
    // each skills root every five minutes and upserts what it finds, so any
    // `tasks_update` edit to a file-backed field is reverted inside that window.
    //
    // Left standing on purpose: closing it changes a shared handler PR1 does not
    // otherwise touch, and it would need the same package-owned and arm-blocker
    // checks `PATCH /api/tasks/:id` runs before it opens somebody's file. This
    // case makes the gap a recorded decision rather than a later discovery, and
    // it FAILS the day somebody closes it — which is the moment to delete it and
    // assert the file instead.
    const { payload } = await call('tasks_create', { ...BASE, runtime: 'codex' });
    const id = (payload.schedule as Task).id;
    await call('tasks_update', { id, runtime: 'opencode' });

    const content = await fs.readFile(skillPath(), 'utf-8');
    expect(content).toMatch(/^ {2}runtime: codex$/m);
    expect(content).not.toContain('opencode');
  });

  it('still refuses permissionMode and status alongside them', async () => {
    // The line the trio does not cross. Which backend runs the prompt is not how
    // much the run may do, and this is the assertion that says the widening did
    // not take the operator-only fields with it.
    const refused = await call('tasks_create', {
      ...BASE,
      runtime: 'codex',
      permissionMode: 'bypassPermissions',
    });
    expect(refused.isError).toBe(true);
    expect(store.getTasks()).toHaveLength(0);
  });
});
