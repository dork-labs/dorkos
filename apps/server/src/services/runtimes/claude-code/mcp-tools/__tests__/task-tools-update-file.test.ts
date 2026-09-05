/**
 * `tasks_update` rewrites the SKILL.md, so an agent's edit survives the next
 * reconciler sweep (DOR-1625).
 *
 * The bug this pins was a lie-on-success, not a crash. A scheduled task is a
 * SKILL.md with a derived row, and the reconciler re-reads every skills root
 * every five minutes and upserts what it finds. This handler wrote the ROW ALONE
 * and answered with the updated schedule — so `prompt`, `cron`, `name`,
 * `timezone` and the runtime/model/effort trio all went back to their old values
 * within five minutes, after the agent had been told the change landed.
 *
 * So the headline case does not assert the response, and does not assert the row
 * straight after the write either: both were true the whole time it was broken.
 * It runs a REAL {@link TaskReconciler} over a real temp directory and asks what
 * the row holds afterwards, which is the only question the bug ever answered
 * wrong.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-update-file
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';
import { TaskStore } from '../../../../tasks/task-store.js';
import { TaskRegistrar } from '../../../../tasks/task-registrar.js';
import { TaskReconciler } from '../../../../tasks/task-reconciler.js';
import { ScheduleIdentityRegistry } from '../../../../tasks/schedule-identity.js';
import { FakeScheduler } from '../../../../tasks/__tests__/fake-scheduler.js';
import { skillsRoot } from '../../../../tasks/__tests__/task-root-fixtures.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../task-tools.js';

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

describe('tasks_update writes the SKILL.md, not just the row', () => {
  let db: Db;
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let root: string;
  let dorkHome: string;
  let skillsDir: string;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    // Resolved, because the create path stores each row's REAL path and the
    // reconciler below scans the root it is handed: on macOS every temp
    // directory is a symlink, and an unresolved root would key a SECOND row for
    // the same file rather than updating the one under test.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-update-file-')));
    dorkHome = path.join(root, 'dork');
    skillsDir = path.join(dorkHome, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

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
  const skillPath = () => path.join(skillsDir, 'nightly-sweep', 'SKILL.md');

  /** Create the base task through the tool and hand back its id. */
  async function createTask(extra: Record<string, unknown> = {}): Promise<string> {
    const { isError, payload } = await call('tasks_create', { ...BASE, ...extra });
    expect(isError).toBe(false);
    return (payload.schedule as Task).id;
  }

  /** One real reconciler pass over the global skills root. */
  async function reconcile(): Promise<{ upserted: number; orphaned: number }> {
    const reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler: new FakeScheduler() }),
      new ScheduleIdentityRegistry()
    );
    reconciler.addRoot(skillsRoot(skillsDir, 'global'));
    try {
      return await reconciler.reconcile();
    } finally {
      reconciler.stop();
    }
  }

  it('an edited prompt and cron survive a real reconciler sweep', async () => {
    // THE bug. Before this, the row held the new values for up to five minutes
    // and then the sweep read the untouched file and put the old ones back.
    const id = await createTask();

    const updated = await call('tasks_update', {
      id,
      prompt: 'sweep the backlog and file what is left',
      cron: '0 5 * * *',
    });
    expect(updated.isError).toBe(false);

    await reconcile();

    const row = store.getTask(id)!;
    expect(row.prompt).toBe('sweep the backlog and file what is left');
    expect(row.cron).toBe('0 5 * * *');
  });

  /** Create the base task and put it through the person's approval. */
  async function createApprovedTask(): Promise<string> {
    const id = await createTask();
    // The transition IS the approval, and it stamps the content key the arm gate
    // reads later (`TaskStore.recordApproval`).
    store.updateTask(id, { status: 'active' });
    return id;
  }

  it('SAYS an edit costs the schedule its approval, and it really does', async () => {
    // Writing the file is what makes the arm gate see new content, so the fix
    // above brought this consequence with it: the person approved a prompt, this
    // is a different one, and the next sync parks the task until they read it.
    // Correct, and silent until now — the reply handed back a row still saying
    // `active`, so an agent reported a live schedule that was about to stop.
    const id = await createApprovedTask();

    const { isError, payload } = await call('tasks_update', { id, prompt: 'do something else' });

    expect(isError).toBe(false);
    expect(payload.needsReapproval).toBe(true);
    expect(String(payload.note)).toContain('approve it again');
    // The row the reply carries still says active, which is exactly why the note
    // has to be there.
    expect((payload.schedule as Task).status).toBe('active');

    // And the note is TRUE: this is the sweep it warns about.
    await reconcile();
    expect(store.getTask(id)!.status).toBe('pending_approval');
  });

  it('says nothing of the sort for an edit that keeps the approved work', async () => {
    // The negative control, and it is the half that makes the disclosure worth
    // anything: a note on every update is a note nobody reads. `maxRuntime` is
    // written to the file but is not part of the content key, so the grant holds.
    const id = await createApprovedTask();

    const { isError, payload } = await call('tasks_update', { id, maxRuntime: '15m' });

    expect(isError).toBe(false);
    expect(payload.needsReapproval).toBeUndefined();
    expect(payload.note).toBeUndefined();

    await reconcile();
    expect(store.getTask(id)!.status).toBe('active');
  });

  it('writes the prompt into the body and the cron into the schedule block', async () => {
    const id = await createTask();
    await call('tasks_update', { id, prompt: 'a different job', cron: '30 4 * * 1' });

    const content = await fs.readFile(skillPath(), 'utf-8');
    expect(content).toContain('a different job');
    expect(content).not.toContain('sweep the backlog');
    // Inside the block, never at the top level — a top-level `cron:` is the
    // legacy shape DOR-1486 retired, and it would shadow nothing.
    expect(content).toMatch(/^ {2}cron: 30 4 \* \* 1$/m);
  });

  it('an edited timezone survives the sweep too, and the file stays readable', async () => {
    // The other half of a cron. A file the frontmatter schema cannot read stops
    // syncing for good, so the rewrite is also asked not to leave a literal
    // `null` behind — the shape that breaks it.
    const id = await createTask({ timezone: 'America/New_York' });

    const updated = await call('tasks_update', { id, timezone: 'Europe/Berlin' });
    expect(updated.isError).toBe(false);

    const content = await fs.readFile(skillPath(), 'utf-8');
    expect(content).toMatch(/^ {2}timezone: Europe\/Berlin$/m);
    // Anchored on the field rather than on the word: `null` anywhere in a body a
    // person wrote is none of this test's business, and a merge that wrote
    // `timezone: null` is the shape that makes the file unreadable for good.
    expect(content).not.toMatch(/^\s*timezone:\s*(null|~)\s*$/m);

    await reconcile();
    expect(store.getTask(id)!.timezone).toBe('Europe/Berlin');
  });

  it('refuses a cron nothing can read, and writes neither the file nor the row', async () => {
    const id = await createTask();

    const { isError, payload } = await call('tasks_update', { id, cron: 'every other tuesday' });

    expect(isError).toBe(true);
    // Pinned on the wording, not on "some error": the agent reads this sentence
    // and either writes a real cron next or asks the person.
    expect(String(payload.error)).toContain('is not a schedule DorkOS can read');
    expect(String(payload.error)).toContain('every other tuesday');
    expect(store.getTask(id)!.cron).toBe('0 3 * * *');
    expect(await fs.readFile(skillPath(), 'utf-8')).not.toContain('every other tuesday');
  });

  it('refuses a file it cannot read, and changes NOTHING — not even the row', async () => {
    // The silent-success shape one branch over: a file that reads but does not
    // parse used to be skipped, the row updated, and the caller told it worked.
    const id = await createTask();
    await fs.writeFile(skillPath(), '---\nname: nightly-sweep\n---\nBody', 'utf-8');

    const { isError, payload } = await call('tasks_update', { id, prompt: 'a different job' });

    expect(isError).toBe(true);
    expect(String(payload.error)).toContain('could not make sense of');
    expect(store.getTask(id)!.prompt).toBe('sweep the backlog');
  });

  it('refuses to rewrite a file an installed package owns', async () => {
    // Editing through the symlink writes into the package's own checkout: the
    // change is shared by every agent that installed it and the next package
    // update overwrites it.
    const packageDir = path.join(dorkHome, 'plugins', 'nightly-pack', 'skills', 'nightly-sweep');
    await fs.mkdir(packageDir, { recursive: true });
    const filePath = path.join(packageDir, 'SKILL.md');
    await fs.writeFile(
      filePath,
      "---\nname: nightly-sweep\ndescription: packaged\nschedule:\n  cron: '0 3 * * *'\n---\npackaged prompt",
      'utf-8'
    );
    const task = store.createTask({
      name: 'nightly-sweep',
      description: 'packaged',
      prompt: 'packaged prompt',
      cron: '0 3 * * *',
      filePath,
    });

    const { isError, payload } = await call('tasks_update', {
      id: task.id,
      prompt: 'a different job',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('schedule_package_owned');
    expect(store.getTask(task.id)!.prompt).toBe('packaged prompt');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });

  it('refuses to rewrite a file an installed AGENT package owns', async () => {
    // A `skillRef` schedule lands in the skill the package ships, wherever that
    // package installed — `agents/` for an agent package, `shapes/` for a Shape.
    // The ownership check read `plugins/` alone, so an edit here wrote straight
    // into the checkout the next package update overwrites (DOR-1789).
    const packageDir = path.join(dorkHome, 'agents', 'researcher');
    await fs.mkdir(path.join(packageDir, '.dork'), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, '.dork', 'manifest.json'),
      JSON.stringify({ name: 'researcher', version: '1.0.0', type: 'agent' }),
      'utf-8'
    );
    const filePath = path.join(packageDir, '.agents', 'skills', 'nightly-sweep', 'SKILL.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      "---\nname: nightly-sweep\ndescription: packaged\nschedule:\n  cron: '0 3 * * *'\n---\npackaged prompt",
      'utf-8'
    );
    const task = store.createTask({
      name: 'nightly-sweep',
      description: 'packaged',
      prompt: 'packaged prompt',
      cron: '0 3 * * *',
      filePath,
    });

    const { isError, payload } = await call('tasks_update', {
      id: task.id,
      prompt: 'a different job',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('schedule_package_owned');
    expect(store.getTask(task.id)!.prompt).toBe('packaged prompt');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });

  it('still edits the schedule of an agent the person made', async () => {
    // The other direction of the same rule: `agents/` also holds every agent
    // DorkOS creates, and their schedules are the person's to edit. Only an
    // install marker makes a directory there a package checkout.
    const agentDir = path.join(dorkHome, 'agents', 'dorkbot');
    const filePath = path.join(agentDir, '.agents', 'skills', 'nightly-sweep', 'SKILL.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.mkdir(path.join(agentDir, '.dork'), { recursive: true });
    await fs.writeFile(path.join(agentDir, '.dork', 'agent.json'), '{}', 'utf-8');
    await fs.writeFile(
      filePath,
      "---\nname: nightly-sweep\ndescription: mine\nschedule:\n  cron: '0 3 * * *'\n---\nmy own prompt",
      'utf-8'
    );
    const task = store.createTask({
      name: 'nightly-sweep',
      description: 'mine',
      prompt: 'my own prompt',
      cron: '0 3 * * *',
      filePath,
    });

    const { isError } = await call('tasks_update', { id: task.id, prompt: 'a different job' });

    expect(isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('a different job');
  });

  it('still edits the row of a task whose file was deleted outside DorkOS', async () => {
    // The one error that means "there is no file, edit the row alone". Every
    // other read failure is a real failure and is reported as one.
    const id = await createTask();
    await fs.rm(path.dirname(skillPath()), { recursive: true, force: true });

    const { isError } = await call('tasks_update', { id, prompt: 'a different job' });

    expect(isError).toBe(false);
    expect(store.getTask(id)!.prompt).toBe('a different job');
  });

  it('does not open the file for an edit that changes nothing in it', async () => {
    // `enabled` lives in the file, so a request that MENTIONS it looks
    // file-worthy; re-sent at its current value it is not a change, and a
    // read-merge-write of somebody's SKILL.md is not free of risk.
    const id = await createTask();
    const before = await fs.readFile(skillPath(), 'utf-8');
    const beforeStat = await fs.stat(skillPath());

    const { isError } = await call('tasks_update', { id, enabled: store.getTask(id)!.enabled });
    expect(isError).toBe(false);

    expect(await fs.readFile(skillPath(), 'utf-8')).toBe(before);
    expect((await fs.stat(skillPath())).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
