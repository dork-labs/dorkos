/**
 * A person can change WHEN a package's schedule runs, and the change holds
 * (DOR-2302).
 *
 * The fixture is the one FB-26 pinned approval with (`package-owned-approval.
 * integration.test.ts`): the `/flow` plugin installed at project scope, its
 * `flow-drain` skill reached through the `flow__flow-drain` symlink Harness Sync
 * writes. Every step goes through the doors production uses — the reconciler
 * for discovery, and {@link applyTaskFileUpdate} + `updateTask` +
 * `settleApprovedWorkChange` in the order `PATCH /api/tasks/:id` calls them — because
 * the whole feature is a round trip: the edit lands on the row, and the next
 * sweep of a file DorkOS will not change must leave it there.
 *
 * @module services/tasks/__tests__/package-schedule-timing.integration
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
import { agentSkillsRoot } from '../skills-roots.js';
import { skillsRoot } from './task-root-fixtures.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import { scheduleContentKey, taskWorkOf } from '../schedule-permission-clamp.js';

const AGENT_ID = 'agent-1';

/** The packaged skill, hourly, as the package ships it. */
function packagedSkill(cron = '0 * * * *', body = 'Drain the queue.'): string {
  return [
    '---',
    'name: flow-drain',
    'description: Claim the top-ranked eligible issue and carry it to its review gate.',
    'schedule:',
    `  cron: '${cron}'`,
    '---',
    body,
  ].join('\n');
}

let store: TaskStore;
let reconciler: TaskReconciler;
let root: string;
let dorkHome: string;
let projectPath: string;
let packagedFile: string;

const registrar = { syncTask: vi.fn(), syncTaskByFilePath: vi.fn() } as unknown as TaskRegistrar;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-timing-')));
  dorkHome = path.join(root, 'dork');
  projectPath = path.join(root, 'project');
  await fs.mkdir(dorkHome, { recursive: true });

  const packageDir = path.join(projectPath, '.dork', 'plugins', 'flow');
  await fs.mkdir(path.join(packageDir, '.dork'), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version: '1.0.0', type: 'plugin' }),
    'utf-8'
  );
  const skillDir = path.join(packageDir, 'skills', 'flow-drain');
  await fs.mkdir(skillDir, { recursive: true });
  packagedFile = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(packagedFile, packagedSkill(), 'utf-8');

  const skillsDir = agentSkillsRoot(projectPath);
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(skillDir, path.join(skillsDir, 'flow__flow-drain'));

  reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
  reconciler.addRoot(skillsRoot(skillsDir, 'project', projectPath, AGENT_ID));
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

const meshCore = { getProjectPath: () => projectPath };

/** Discover what is on disk, the way the five-minute pass does. */
async function sweep(): Promise<Task> {
  await reconciler.reconcile();
  return store.getByFilePath(packagedFile)!;
}

/**
 * PATCH a task the way `PATCH /api/tasks/:id` does, as a person (`trusted`) or
 * an agent: the file step, the row, then the settle for a change that wrote no
 * file.
 */
async function patch(
  existing: Task,
  data: UpdateTaskRequest,
  trusted = true
): Promise<{ ok: boolean; code?: string; task?: Task }> {
  const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, { existing, data });
  if (!outcome.ok) return { ok: false, code: outcome.code };
  store.updateTask(existing.id, data, { timingLandsOn: outcome.timingLandsOn });
  if (!outcome.changesFile) {
    store.approvals.settleApprovedWorkChange(
      existing.id,
      { ...taskWorkOf(existing), status: 'active' },
      { trusted }
    );
  }
  return { ok: true, task: store.getTask(existing.id)! };
}

/** The package's schedule, approved and switched on by a person. */
async function approved(): Promise<Task> {
  return (await patch(await sweep(), { status: 'active', enabled: true })).task!;
}

describe('changing when a package’s schedule runs', () => {
  it('lands on the schedule, keeps it approved, and never writes the package’s file', async () => {
    // Purpose: the ticket itself — this answered 409 `schedule_package_owned`.
    const task = await approved();

    const result = await patch(task, { cron: '*/15 * * * *', timezone: 'Europe/Berlin' });

    expect(result.ok).toBe(true);
    expect(result.task).toMatchObject({
      cron: '*/15 * * * *',
      timezone: 'Europe/Berlin',
      defaultCron: '0 * * * *',
      timingOverridden: true,
      status: 'active',
    });
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(packagedSkill());
  });

  it('holds across the next sweep of the unchanged file', async () => {
    // Purpose: every sync copies the file's cron onto the row; if the person's
    // timing lived in that column it would be gone within five minutes.
    await patch(await approved(), { cron: '*/15 * * * *' });

    const after = await sweep();

    expect(after).toMatchObject({ cron: '*/15 * * * *', status: 'active' });
  });

  it('holds, still approved, across a package update that changes only the package’s timing', async () => {
    // Purpose: the default moving under a person's own timing is not new work
    // for them to approve.
    await patch(await approved(), { cron: '*/15 * * * *' });
    await fs.writeFile(packagedFile, packagedSkill('0 */6 * * *'), 'utf-8');

    const after = await sweep();

    expect(after).toMatchObject({
      cron: '*/15 * * * *',
      defaultCron: '0 */6 * * *',
      status: 'active',
    });
  });

  it('still asks again when a package update changes what the schedule does', async () => {
    // Purpose: a person's timing must never carry their approval across to a
    // prompt they have not read.
    await patch(await approved(), { cron: '*/15 * * * *' });
    await fs.writeFile(packagedFile, packagedSkill('0 * * * *', 'Do something new.'), 'utf-8');

    const after = await sweep();

    expect(after.status).toBe('pending_approval');
    expect(after.cron).toBe('*/15 * * * *');
  });

  it('goes back to the package’s timing on a reset, still approved', async () => {
    // Purpose: "Reset to the package's default" is a person's timing change
    // too, so it re-approves in the same act and the next sweep agrees.
    const retimed = (await patch(await approved(), { cron: '*/15 * * * *' })).task!;

    const reset = await patch(retimed, { resetTiming: true });
    const after = await sweep();

    expect(reset.task).toMatchObject({ cron: '0 * * * *', timingOverridden: false });
    expect(after).toMatchObject({ cron: '0 * * * *', status: 'active' });
  });

  it('stops at once, and stays stopped, when an agent changes the timing', async () => {
    // Purpose: no file is written, so nothing else would notice — the agent's
    // timing would run on an approved schedule until the next sweep.
    const task = await approved();

    const result = await patch(task, { cron: '* * * * *' }, false);
    const after = await sweep();

    expect(result.task?.status).toBe('pending_approval');
    expect(after.status).toBe('pending_approval');
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(packagedSkill());
  });
});
