/**
 * Project-only schedules from a global package (DOR-3376).
 *
 * A skill in the global root (`<dorkHome>/skills`) whose `schedule:` block says
 * `scope: project` never becomes a global schedule. Each registered project
 * gets its own copy instead: switched off, parked without a card, running as
 * that project's agent, with its own switch. From a project's own root the key
 * changes nothing.
 *
 * Drives the real reconciler over real files; nothing fires.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/schemas';
import { TaskStore } from '../task-store.js';
import { TaskReconciler } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import type { TaskRegistrar } from '../task-registrar.js';
import { agentTaskRoots, globalSkillsRoot, globalTaskRoots } from '../skills-roots.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import { needsScheduleApprovalAttention } from '../schedule-permission-clamp.js';

/** The file a project holds when it uses the package: what `/flow:init` writes. */
const MARKER = '.agents/flow/config.json';

/**
 * A scheduled skill, optionally marked project-only. A project-only one names
 * {@link MARKER} as its `projectFile` unless the case says otherwise; `null`
 * leaves the key out.
 */
function skill(name: string, scope?: string, projectFile: string | null = MARKER): string {
  return [
    '---',
    `name: ${name}`,
    `description: A skill named ${name}`,
    'schedule:',
    "  cron: '0 * * * *'",
    ...(scope ? [`  scope: ${scope}`] : []),
    ...(scope && projectFile !== null ? [`  projectFile: '${projectFile}'`] : []),
    '---',
    'Drain the queue.',
  ].join('\n');
}

/** Make a project use the package, by giving it the marker file. */
async function useIn(projectPath: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(projectPath, MARKER)), { recursive: true });
  await fs.writeFile(path.join(projectPath, MARKER), '{}', 'utf-8');
}

let store: TaskStore;
let reconciler: TaskReconciler;
let root: string;
let dorkHome: string;
/** Two registered projects, each with its agent. */
let projects: { agentId: string; path: string }[];

const registrar = {
  syncTask: vi.fn(),
  syncTaskByFilePath: vi.fn(),
  repairTask: vi.fn(),
} as unknown as TaskRegistrar;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  // Resolved: a schedule's identity is its file's REAL path, and on macOS every
  // temp directory is a symlink.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-project-only-')));
  dorkHome = path.join(root, 'dork');
  projects = [
    { agentId: 'agent-alpha', path: path.join(root, 'alpha') },
    { agentId: 'agent-beta', path: path.join(root, 'beta') },
  ];
  reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
  await fs.mkdir(globalSkillsRoot(dorkHome), { recursive: true });
  for (const r of globalTaskRoots(dorkHome)) reconciler.addRoot(r);
  for (const project of projects) {
    for (const r of agentTaskRoots(project.path, project.agentId)) {
      await fs.mkdir(r.dir, { recursive: true });
      reconciler.addRoot(r);
    }
    // Both use the package unless a case removes the marker.
    await useIn(project.path);
  }
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a skill into a skills root, and return its file. */
async function put(dir: string, name: string, content: string): Promise<string> {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  const file = path.join(dir, name, 'SKILL.md');
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

/** PATCH a task the way `PATCH /api/tasks/:id` does: the file half, then the row. */
async function patch(existing: Task, data: UpdateTaskRequest) {
  const outcome = await applyTaskFileUpdate({ dorkHome } as never, { existing, data });
  if (!outcome.ok) return { ok: false as const, code: outcome.code, error: outcome.error };
  return {
    ok: true as const,
    task: store.updateTask(existing.id, data, { timingLandsOn: outcome.timingLandsOn }),
  };
}

describe('a project-only schedule in a global package', () => {
  it('makes no global schedule, and one switched-off copy per project with no card', async () => {
    const file = await put(
      globalSkillsRoot(dorkHome),
      'flow-drain',
      skill('flow-drain', 'project')
    );
    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows.filter((row) => row.agentId === null)).toEqual([]);
    expect(rows.map((row) => row.agentId).sort()).toEqual(['agent-alpha', 'agent-beta']);
    for (const row of rows) {
      expect(row.filePath).toBe(file);
      expect(row.projectOnly).toBe(true);
      expect(row.enabled).toBe(false);
      // Parked like every discovered schedule, but off, so nobody is asked.
      expect(row.status).toBe('pending_approval');
      expect(needsScheduleApprovalAttention(row)).toBe(false);
    }
  });

  it('takes away the global schedule it used to make', async () => {
    const file = await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain'));
    await reconciler.reconcile();
    expect(store.fileSync.getByFilePath(file)?.agentId).toBeNull();

    await fs.writeFile(file, skill('flow-drain', 'project'), 'utf-8');
    await reconciler.reconcile();

    expect(store.fileSync.getByFilePath(file)).toBeNull();
    expect(store.getTasks().every((row) => row.projectOnly)).toBe(true);
  });

  it("asks again, for that project only, when the shared file's work changes", async () => {
    // A package update, or an agent at Full, can rewrite the shared file. An
    // approval is of the work as it was, per copy, so it never carries over.
    const file = await put(
      globalSkillsRoot(dorkHome),
      'flow-drain',
      skill('flow-drain', 'project')
    );
    await reconciler.reconcile();
    const alpha = store.getTasks().find((row) => row.agentId === 'agent-alpha')!;
    expect((await patch(alpha, { status: 'active', enabled: true })).ok).toBe(true);
    expect(store.getTask(alpha.id)?.status).toBe('active');

    await fs.writeFile(
      file,
      skill('flow-drain', 'project').replace('Drain the queue.', 'Delete everything.'),
      'utf-8'
    );
    await reconciler.reconcile();

    const alphaAfter = store.getTask(alpha.id)!;
    // Parked again, so the clock will not fire the new text: the scheduler
    // runs a row only while it is `active` (`task-registrar.ts`).
    expect(alphaAfter.status).toBe('pending_approval');
    expect(alphaAfter.prompt).toBe('Delete everything.');
    // It was on, so the project is asked to look at the new work.
    expect(needsScheduleApprovalAttention(alphaAfter)).toBe(true);
    // The other project never approved anything and is still off and quiet.
    const beta = store.getTasks().find((row) => row.agentId === 'agent-beta')!;
    expect(beta.enabled).toBe(false);
    expect(needsScheduleApprovalAttention(beta)).toBe(false);

    // Approving the new work arms that copy again.
    expect((await patch(alphaAfter, { status: 'active' })).ok).toBe(true);
    await reconciler.reconcile();
    expect(store.getTask(alpha.id)?.status).toBe('active');
  });

  it('turns on for one project only, and stays on across the next sweep', async () => {
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project'));
    await reconciler.reconcile();
    const alpha = store.getTasks().find((row) => row.agentId === 'agent-alpha')!;

    // The same approval a package's opt-in schedule takes: no new path.
    const approved = await patch(alpha, { status: 'active', enabled: true });
    expect(approved.ok).toBe(true);
    await reconciler.reconcile();

    const after = store.getTasks();
    const alphaAfter = after.find((row) => row.agentId === 'agent-alpha')!;
    const betaAfter = after.find((row) => row.agentId === 'agent-beta')!;
    expect(alphaAfter.enabled).toBe(true);
    expect(alphaAfter.status).toBe('active');
    // It runs as that project's agent, which is what puts the run in that
    // project's folder (`resolveRunPlacement`).
    expect(alphaAfter.agentId).toBe('agent-alpha');
    expect(betaAfter.enabled).toBe(false);
    expect(betaAfter.status).toBe('pending_approval');
  });

  it("never writes the shared file for one project's edit", async () => {
    const file = await put(
      globalSkillsRoot(dorkHome),
      'flow-drain',
      skill('flow-drain', 'project')
    );
    await reconciler.reconcile();
    const alpha = store.getTasks().find((row) => row.agentId === 'agent-alpha')!;
    const before = await fs.readFile(file, 'utf-8');

    const timing = await patch(alpha, { cron: '30 6 * * *' });
    expect(timing.ok).toBe(true);
    expect(timing.ok && timing.task?.cron).toBe('30 6 * * *');

    const prompt = await patch(alpha, { prompt: 'Something else.' });
    expect(prompt).toMatchObject({ ok: false, code: 'schedule_project_copy' });
    expect(await fs.readFile(file, 'utf-8')).toBe(before);

    await reconciler.reconcile();
    // The project's own timing survives the sweep; the other project's does not move.
    expect(store.getTask(alpha.id)?.cron).toBe('30 6 * * *');
    const beta = store.getTasks().find((row) => row.agentId === 'agent-beta')!;
    expect(beta.cron).toBe('0 * * * *');
  });

  it('goes back to one schedule when the key is taken out', async () => {
    const file = await put(
      globalSkillsRoot(dorkHome),
      'flow-drain',
      skill('flow-drain', 'project')
    );
    await reconciler.reconcile();
    await fs.writeFile(file, skill('flow-drain'), 'utf-8');
    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBeNull();
    expect(rows[0]?.projectOnly).toBe(false);
  });

  it('parks a value it does not know as a global complaint, never a running schedule', async () => {
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'everywhere'));
    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending_approval');
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.reason).toContain('scope');
  });
});

describe('which projects get a copy: only the ones using the package', () => {
  /** Every copy's project, sorted. */
  const copyProjects = () =>
    store
      .getTasks()
      .map((row) => row.agentId)
      .sort();

  it('makes no copy at all when the block names no projectFile', async () => {
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project', null));
    await reconciler.reconcile();
    expect(store.getTasks()).toEqual([]);
  });

  it('makes a copy only in the project that holds the file', async () => {
    await fs.rm(path.join(projects[1]!.path, MARKER));
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project'));
    await reconciler.reconcile();
    expect(copyProjects()).toEqual(['agent-alpha']);
  });

  it('makes the copy on the next sync once a project adds the file', async () => {
    await fs.rm(path.join(projects[1]!.path, MARKER));
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project'));
    await reconciler.reconcile();
    expect(copyProjects()).toEqual(['agent-alpha']);

    await useIn(projects[1]!.path);
    await reconciler.reconcile();
    expect(copyProjects()).toEqual(['agent-alpha', 'agent-beta']);
  });

  it('keeps a copy that was ever switched on when the file goes, and drops one that never was', async () => {
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project'));
    await reconciler.reconcile();
    const alpha = store.getTasks().find((row) => row.agentId === 'agent-alpha')!;
    // Switched on, then back off: still a person's choice, so it stays.
    expect((await patch(alpha, { status: 'active', enabled: true })).ok).toBe(true);
    expect((await patch(store.getTask(alpha.id)!, { enabled: false })).ok).toBe(true);

    for (const project of projects) await fs.rm(path.join(project.path, MARKER));
    await reconciler.reconcile();

    expect(copyProjects()).toEqual(['agent-alpha']);
    expect(store.getTask(alpha.id)?.enabled).toBe(false);
  });

  it('still parks a kept copy when the shared file changes', async () => {
    const file = await put(
      globalSkillsRoot(dorkHome),
      'flow-drain',
      skill('flow-drain', 'project')
    );
    await reconciler.reconcile();
    const alpha = store.getTasks().find((row) => row.agentId === 'agent-alpha')!;
    expect((await patch(alpha, { status: 'active', enabled: true })).ok).toBe(true);
    await fs.rm(path.join(projects[0]!.path, MARKER));

    await fs.writeFile(
      file,
      skill('flow-drain', 'project').replace('Drain the queue.', 'Delete everything.'),
      'utf-8'
    );
    await reconciler.reconcile();
    expect(store.getTask(alpha.id)?.status).toBe('pending_approval');
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a path climbing out', '../outside/config.json'],
    ['a home path', '~/.dork/config.json'],
  ])('parks %s as a complaint and makes no copy', async (_label, value) => {
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project', value));
    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBeNull();
    expect(rows[0]?.status).toBe('pending_approval');
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.reason).toContain('projectFile');
  });

  it('treats a marker that links out of the project as missing', async () => {
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, '{}', 'utf-8');
    for (const project of projects) {
      await fs.rm(path.join(project.path, MARKER));
      await fs.symlink(outside, path.join(project.path, MARKER));
    }
    await put(globalSkillsRoot(dorkHome), 'flow-drain', skill('flow-drain', 'project'));
    await reconciler.reconcile();
    expect(store.getTasks()).toEqual([]);
  });
});

describe('a project-only schedule in a project', () => {
  it('behaves exactly as if the key were absent', async () => {
    const project = projects[0]!;
    const dir = agentTaskRoots(project.path, project.agentId)[0]!.dir;
    const file = await put(dir, 'local-sweep', skill('local-sweep', 'project'));
    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath: file,
      agentId: project.agentId,
      projectOnly: false,
      enabled: true,
    });
  });
});
