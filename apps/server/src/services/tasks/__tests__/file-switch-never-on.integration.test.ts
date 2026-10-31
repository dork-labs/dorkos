/**
 * A file change may switch a scheduled task off, never on (DOR-3309).
 *
 * Marketing switched off a file-backed task; a `git pull` put the old
 * `enabled: true` back, and the next sweep switched it on again. The rule now:
 * a file that starts saying on (explicitly, or by losing its `enabled` line,
 * whose default is on) leaves an off task off and offers "Turn on"; a file
 * that changes to off switches the task off.
 *
 * Covered for every place a file comes from: the agent's own skills, one
 * project's copy of a shared `scope: project` schedule, and a schedule an
 * installed package ships. Drives the real reconciler over real files, and the
 * PATCH the way `PATCH /api/tasks/:id` does (file half, then row); nothing fires.
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
import {
  agentSkillsRoot,
  agentTaskRoots,
  globalSkillsRoot,
  globalTaskRoots,
} from '../skills-roots.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';

const AGENT_ID = 'agent-1';
/** The file a project holds when it uses the shared package. */
const MARKER = '.agents/flow/config.json';

/** The `enabled` line a case writes, or `null` to leave it out (default on). */
type Switch = 'enabled: true' | 'enabled: false' | null;

/** A scheduled skill with the given switch line. */
function skill(name: string, line: Switch, extra: string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    `description: A skill named ${name}`,
    'schedule:',
    "  cron: '0 8 * * 1'",
    ...extra,
    ...(line ? [`  ${line}`] : []),
    '---',
    'Write the weekly report.',
  ].join('\n');
}

let store: TaskStore;
let reconciler: TaskReconciler;
let root: string;
let dorkHome: string;
let projectPath: string;

const registrar = {
  syncTask: vi.fn(),
  syncTaskByFilePath: vi.fn(),
  repairTask: vi.fn(),
} as unknown as TaskRegistrar;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  // Resolved: a schedule's identity is its file's REAL path.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-never-on-')));
  dorkHome = path.join(root, 'dork');
  projectPath = path.join(root, 'project');
  reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
  await fs.mkdir(globalSkillsRoot(dorkHome), { recursive: true });
  for (const r of globalTaskRoots(dorkHome)) reconciler.addRoot(r);
  for (const r of agentTaskRoots(projectPath, AGENT_ID)) {
    await fs.mkdir(r.dir, { recursive: true });
    reconciler.addRoot(r);
  }
  await fs.mkdir(path.dirname(path.join(projectPath, MARKER)), { recursive: true });
  await fs.writeFile(path.join(projectPath, MARKER), '{}', 'utf-8');
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** PATCH a task the way `PATCH /api/tasks/:id` does: the file half, then the row. */
async function patch(existing: Task, data: UpdateTaskRequest): Promise<Task> {
  const meshCore = { getProjectPath: () => projectPath };
  const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, { existing, data });
  if (!outcome.ok) throw new Error(`PATCH refused: ${outcome.error}`);
  return store.updateTask(existing.id, data, { timingLandsOn: outcome.timingLandsOn })!;
}

/** One place a schedule file can come from. */
interface Source {
  /** Write the file with this switch line. */
  write: (line: Switch) => Promise<void>;
  /** The row the file backs. */
  row: () => Task;
}

/** The agent's own skill, in its project's skills root. */
async function ownSource(): Promise<Source> {
  const dir = path.join(agentSkillsRoot(projectPath), 'weekly-report');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  return {
    write: (line) => fs.writeFile(file, skill('weekly-report', line), 'utf-8'),
    row: () => store.fileSync.getByFilePath(file)!,
  };
}

/** One project's copy of a shared `scope: project` schedule in the global root. */
async function projectOnlySource(): Promise<Source> {
  const dir = path.join(globalSkillsRoot(dorkHome), 'weekly-report');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const scope = ['  scope: project', `  projectFile: '${MARKER}'`];
  return {
    write: (line) => fs.writeFile(file, skill('weekly-report', line, scope), 'utf-8'),
    row: () => store.fileSync.projectCopiesOf(file)[0]!,
  };
}

/** A schedule an installed package ships, linked into the agent's skills root. */
async function packageSource(): Promise<Source> {
  const packageDir = path.join(projectPath, '.dork', 'plugins', 'flow');
  await fs.mkdir(path.join(packageDir, '.dork'), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version: '1.0.0', type: 'plugin' }),
    'utf-8'
  );
  const skillDir = path.join(packageDir, 'skills', 'flow-report');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.symlink(skillDir, path.join(agentSkillsRoot(projectPath), 'flow__flow-report'));
  const file = path.join(skillDir, 'SKILL.md');
  return {
    write: (line) => fs.writeFile(file, skill('flow-report', line), 'utf-8'),
    row: () => store.fileSync.getByFilePath(file)!,
  };
}

/** Write the file, then sweep it the way the five-minute pass does. */
async function syncWith(source: Source, line: Switch): Promise<Task> {
  await source.write(line);
  await reconciler.reconcile();
  return source.row();
}

describe.each([
  ['the agent’s own skill', ownSource],
  ['a project’s copy of a shared schedule', projectOnlySource],
  ['a schedule from an installed package', packageSource],
])('%s', (_label, makeSource) => {
  let source: Source;

  beforeEach(async () => {
    source = await makeSource();
  });

  /** A task approved and switched off, whose file says off. */
  async function approvedAndOff(): Promise<Task> {
    const found = await syncWith(source, 'enabled: false');
    expect(found.enabled).toBe(false);
    // Approving keeps it off (DOR-3309 part 1).
    const approved = await patch(found, { status: 'active' });
    expect(approved).toMatchObject({ status: 'active', enabled: false, offersTurnOn: false });
    return approved;
  }

  it.each([
    ['says enabled: true', 'enabled: true' as const],
    ['loses its enabled line', null],
  ])('stays off when its file %s, and offers Turn on', async (_case, line) => {
    await approvedAndOff();

    const after = await syncWith(source, line);

    expect(after).toMatchObject({ status: 'active', enabled: false, offersTurnOn: true });
    // A second sweep of the same file changes nothing and keeps the offer.
    await reconciler.reconcile();
    expect(source.row()).toMatchObject({ enabled: false, offersTurnOn: true });
  });

  it('turns on when a person takes the offer, and the offer goes', async () => {
    await approvedAndOff();
    const offered = await syncWith(source, 'enabled: true');

    const on = await patch(offered, { enabled: true });

    expect(on).toMatchObject({ enabled: true, offersTurnOn: false });
    await reconciler.reconcile();
    expect(source.row()).toMatchObject({ status: 'active', enabled: true, offersTurnOn: false });
  });

  it('withdraws the offer when the file says off again', async () => {
    await approvedAndOff();
    await syncWith(source, 'enabled: true');

    const after = await syncWith(source, 'enabled: false');

    expect(after).toMatchObject({ enabled: false, offersTurnOn: false });
  });

  it('switches off when its file changes to enabled: false', async () => {
    const found = await syncWith(source, 'enabled: true');
    const on = await patch(found, { status: 'active', enabled: true });
    expect(on).toMatchObject({ status: 'active', enabled: true });

    const after = await syncWith(source, 'enabled: false');

    expect(after.enabled).toBe(false);
  });
});
