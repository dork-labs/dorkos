/**
 * A schedule that came with an installed package can be approved and switched
 * on, and stays on (FB-26). The fixture is the `/flow` plugin installed at
 * project scope, its skill reached through the Harness Sync symlink; every step
 * goes through `TaskReconciler.reconcile` and {@link applyTaskFileUpdate} +
 * `TaskStore.updateTask`, as `PATCH /api/tasks/:id` calls them.
 *
 * @module services/tasks/__tests__/package-owned-approval.integration
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/schemas';
import { TaskStore } from '../task-store.js';
import { TaskReconciler } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import type { TaskRegistrar } from '../task-registrar.js';
import { agentSkillsRoot } from '../skills-roots.js';
import { skillsRoot } from './task-root-fixtures.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import { deleteOrDeclineTask, removeScheduledTaskFile } from '../lifecycle/delete-task.js';
import { createDeleteScheduleHandler } from '../../runtimes/claude-code/mcp-tools/tasks/task-delete-tool.js';
import { needsScheduleApprovalAttention } from '../schedule-permission-clamp.js';

/** The id the project's agent is registered under. */
const AGENT_ID = 'agent-1';

/** The packaged skill, shipped switched off the way `/flow` ships its two. */
const PACKAGED_SKILL = [
  '---',
  'name: flow-drain',
  'description: Claim the top-ranked eligible issue and carry it to its review gate.',
  'schedule:',
  "  cron: '0 * * * *'",
  '  enabled: false',
  '---',
  'Drain the queue.',
].join('\n');

let db: Db;
let store: TaskStore;
let reconciler: TaskReconciler;
let root: string;
let dorkHome: string;
let projectPath: string;
/** The package's own copy of the file — the one DorkOS must never write. */
let packagedFile: string;

/** A registrar that records the sync calls the reconciler makes and runs no cron. */
const registrar = {
  syncTask: vi.fn(),
  syncTaskByFilePath: vi.fn(),
  repairTask: vi.fn(),
} as unknown as TaskRegistrar;

beforeEach(async () => {
  db = createTestDb();
  store = new TaskStore(db);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-approve-')));
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
  await fs.writeFile(packagedFile, PACKAGED_SKILL, 'utf-8');

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

/** Mesh, answering for this task's agent exactly as the registry does. */
const meshCore = { getProjectPath: () => projectPath };

/** Discover what is on disk, the way the five-minute pass does. */
async function sweep(): Promise<Task> {
  await reconciler.reconcile();
  const task = store.fileSync.getByFilePath(packagedFile);
  expect(task).not.toBeNull();
  return task!;
}

/** What a PATCH answered, and the row it left behind. */
interface PatchResult {
  ok: boolean;
  code?: string;
  error?: string;
  task?: Task;
}

/**
 * PATCH a task the way `PATCH /api/tasks/:id` does: the file first, then the
 * row, and nothing at all to the row when the file half refuses.
 *
 * @param existing - The row as it stands.
 * @param data - The fields the request carries.
 */
async function patch(existing: Task, data: UpdateTaskRequest): Promise<PatchResult> {
  const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, { existing, data });
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  return {
    ok: true,
    task:
      store.updateTask(existing.id, data, { timingLandsOn: outcome.timingLandsOn }) ?? undefined,
  };
}

describe('declining a schedule that came with an installed package (DOR-2097)', () => {
  /** The package ships this one switched on, so it raises a card. */
  const ASKING_SKILL = PACKAGED_SKILL.replace('enabled: false', 'enabled: true');

  beforeEach(async () => {
    await fs.writeFile(packagedFile, ASKING_SKILL, 'utf-8');
  });

  it('never removes the package file, whatever the caller', async () => {
    await removeScheduledTaskFile(packagedFile, projectPath);

    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(ASKING_SKILL);
  });

  it('keeps the file and the row, stays quiet across a sweep, and asks again on a change', async () => {
    const task = await sweep();
    expect(needsScheduleApprovalAttention(task)).toBe(true);

    expect(await deleteOrDeclineTask(task, store, meshCore)).toBe('declined');
    const swept = await sweep();

    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(ASKING_SKILL);
    expect(swept.declined).toBe(true);
    expect(swept.status).toBe('pending_approval');
    expect(needsScheduleApprovalAttention(swept)).toBe(false);

    await fs.writeFile(packagedFile, ASKING_SKILL.replace('Drain the queue.', 'Drain it all.'));
    const changed = await sweep();
    expect(changed.declined).toBe(false);
    expect(needsScheduleApprovalAttention(changed)).toBe(true);
  });

  it('withdraws an approval, so a declined schedule cannot run', async () => {
    const approved = await patch(await sweep(), { status: 'active', enabled: true });

    store.approvals.recordDecline(approved.task!.id);
    const swept = await sweep();

    expect(swept.status).toBe('pending_approval');
    expect(swept.declined).toBe(true);
  });

  it('refuses tasks_delete, since declining is a person’s answer', async () => {
    const task = await sweep();

    const reply = await createDeleteScheduleHandler({
      taskStore: store,
      meshCore,
    } as never)({ id: task.id });

    expect(reply.isError).toBe(true);
    expect(store.getTask(task.id)?.declined).toBe(false);
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(ASKING_SKILL);
  });
});

describe('a schedule that came with an installed package', () => {
  it('can be APPROVED, which switches it on, and stays on across the next sweep (FB-26)', async () => {
    // The approval card sends `{status, enabled}` together, and the update door
    // answered 409 `schedule_package_owned` every time; then the sweep copied
    // the file's `enabled: false` back onto the row.
    const result = await patch(await sweep(), { status: 'active', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.task?.enabled).toBe(true);
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
    const after = await sweep();
    expect(after.status).toBe('active');
    expect(after.enabled).toBe(true);
  });

  it('stays switched on across the agent being unregistered and registered again (DOR-2082)', async () => {
    const approved = await patch(await sweep(), { status: 'active', enabled: true });
    expect(store.disableTasksByAgentId(AGENT_ID)).toBe(1);
    expect(store.getTask(approved.task!.id)?.status).toBe('paused');

    const back = await sweep();

    expect(back.status).toBe('active');
    expect(back.enabled).toBe(true);
  });

  it('is discovered parked, quiet while shipped off, and asks once the package ships it on (DOR-2059)', async () => {
    const off = await sweep();
    expect(off.status).toBe('pending_approval');
    expect(off.enabled).toBe(false);
    expect(needsScheduleApprovalAttention(off)).toBe(false);

    await fs.writeFile(packagedFile, PACKAGED_SKILL.replace('enabled: false', 'enabled: true'));
    const on = await sweep();

    expect(on.status).toBe('pending_approval');
    expect(needsScheduleApprovalAttention(on)).toBe(true);
  });

  it('is never armed by switching it on without approving it (DOR-607)', async () => {
    const switched = await patch(await sweep(), { enabled: true });
    expect(switched.ok).toBe(true);
    expect(switched.task?.status).toBe('pending_approval');

    const after = await sweep();
    expect(after.status).toBe('pending_approval');
    expect(after.enabled).toBe(false);
  });

  it('still refuses to approve a schedule whose file cannot run', async () => {
    await fs.writeFile(
      packagedFile,
      PACKAGED_SKILL.replace("cron: '0 * * * *'", "cron: 'not a cron'"),
      'utf-8'
    );
    const task = await sweep();

    const refused = await patch(task, { status: 'active', enabled: true });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('schedule_file_unreadable');
    expect(store.getTask(task.id)!.status).toBe('pending_approval');
  });

  it('keeps a bypass the package asks for clamped after it is approved and swept', async () => {
    await fs.writeFile(
      packagedFile,
      PACKAGED_SKILL.replace(
        '  enabled: false',
        '  enabled: false\n  permissions: bypassPermissions'
      ),
      'utf-8'
    );
    const task = await sweep();
    expect(task.permissionMode).not.toBe('bypassPermissions');

    await patch(task, { status: 'active', enabled: true });
    const after = await sweep();

    expect(after.status).toBe('active');
    expect(after.permissionMode).not.toBe('bypassPermissions');
  });

  it("parks again, taking the file's switch, when the package changes what the schedule does", async () => {
    await patch(await sweep(), { status: 'active', enabled: true });
    await fs.writeFile(
      packagedFile,
      PACKAGED_SKILL.replace("cron: '0 * * * *'", "cron: '0 4 * * *'"),
      'utf-8'
    );

    const changed = await sweep();

    expect(changed.status).toBe('pending_approval');
    expect(changed.enabled).toBe(false);
  });

  it('refuses a change to what it DOES, alone or riding with a switch, with nothing written', async () => {
    const task = await patch(await sweep(), { status: 'active', enabled: true });

    for (const data of [
      { name: 'something-else' },
      { prompt: 'do something else entirely' },
      { enabled: false, prompt: 'do something else' },
    ]) {
      const refused = await patch(task.task!, data);
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('schedule_package_owned');
    }
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
    const row = store.getTask(task.task!.id)!;
    expect(row.prompt).toBe('Drain the queue.');
    expect(row.enabled).toBe(true);
  });

  it('refuses a raised approval, in words about the LEVEL, and grants nothing (DOR-2100)', async () => {
    const task = await sweep();

    const refused = await patch(task, {
      status: 'active',
      enabled: true,
      permissionMode: 'bypassPermissions',
    });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('schedule_package_owned');
    expect(refused.error).toContain("didn't change how much it may do");
    const row = store.getTask(task.id)!;
    expect(row.status).toBe('pending_approval');
    expect(row.permissionMode).not.toBe('bypassPermissions');
  });
});
