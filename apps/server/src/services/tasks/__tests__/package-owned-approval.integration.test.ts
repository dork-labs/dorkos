/**
 * A schedule that came with an installed package can be approved and switched
 * on — and stays on (FB-26).
 *
 * ## Why this drives the real doors rather than the ownership helper
 *
 * The bug was not in {@link isPackageOwned}, which answered correctly the whole
 * time. It was in what the two halves of the system did with that answer: the
 * update door treated `enabled` as a file-backed field, so approving a packaged
 * schedule tried to REWRITE the package's own SKILL.md and was refused 409 by
 * the very message that promises "you can switch this schedule on or off here";
 * and the discovery sweep re-read `enabled: false` from that same unwritable
 * file, so a row that did get switched on would have been switched off again
 * within five minutes.
 *
 * So the fixture here is the shape a person actually has on disk — the `/flow`
 * plugin installed at project scope, its `flow-drain` skill reached through the
 * `flow__flow-drain` symlink Harness Sync writes into `.agents/skills/` — and
 * every step goes through the door production uses: `TaskReconciler.reconcile`
 * for discovery, and {@link applyTaskFileUpdate} + `TaskStore.updateTask` for
 * the PATCH, in that order, exactly as `PATCH /api/tasks/:id` calls them.
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
} as unknown as TaskRegistrar;

beforeEach(async () => {
  db = createTestDb();
  store = new TaskStore(db);
  // Resolved: on macOS every temp directory is a symlink, and a schedule's
  // identity is its file's REAL path.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-approve-')));
  dorkHome = path.join(root, 'dork');
  projectPath = path.join(root, 'project');
  await fs.mkdir(dorkHome, { recursive: true });

  // The project-scoped install: `<project>/.dork/plugins/flow`, carrying the
  // marketplace's own marker, with its skill inside it.
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

  // ...and the link Harness Sync projects into the agent's skills root, which
  // is the only way discovery ever sees the file.
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
  const task = store.getByFilePath(packagedFile);
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

describe('a schedule that came with an installed package', () => {
  it('is discovered parked and switched off, as its file says', async () => {
    const task = await sweep();

    expect(task.status).toBe('pending_approval');
    expect(task.enabled).toBe(false);
    expect(task.origin).toBe('file');
  });

  it('can be APPROVED, which switches it on', async () => {
    // The FB-26 report itself: the approval card sends `{status, enabled}`
    // together — a schedule approved but left off would never run — and the
    // update door answered 409 `schedule_package_owned` every time.
    const task = await sweep();

    const result = await patch(task, { status: 'active', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe('active');
    expect(result.task?.enabled).toBe(true);
    // Refusing to write the package's file is still the whole point.
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
  });

  it('can be switched OFF and back ON again', async () => {
    const approved = await patch(await sweep(), { status: 'active', enabled: true });

    const off = await patch(approved.task!, { enabled: false });
    expect(off.ok).toBe(true);
    expect(off.task?.enabled).toBe(false);

    const on = await patch(off.task!, { enabled: true });
    expect(on.ok).toBe(true);
    expect(on.task?.enabled).toBe(true);
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
  });

  it('stays approved and switched on across the next sweep of the unchanged file', async () => {
    // The other half of the bug, and the quieter one: the file still says
    // `enabled: false`, and DorkOS may not change that — so a sweep that copied
    // the file's switch onto the row would undo the approval within five
    // minutes, with nothing anywhere saying why.
    await patch(await sweep(), { status: 'active', enabled: true });

    const after = await sweep();

    expect(after.status).toBe('active');
    expect(after.enabled).toBe(true);
  });

  it('stays switched on across a package update, which looks like the file going away and coming back', async () => {
    // A marketplace update is a backup, an atomic rename and a restore: every
    // file under the package unlinks and reappears. The watcher's unlink handler
    // parks the row with `enabled: false`; the next sweep must not take that
    // server-written value for the person's decision, or an updated package's
    // schedule ends up active, off, and asking nobody (the reviewer's finding).
    await patch(await sweep(), { status: 'active', enabled: true });
    expect(store.markRemovedByFilePath(packagedFile)).toBe(1);
    expect(store.getByFilePath(packagedFile)?.status).toBe('paused');

    const back = await sweep();

    expect(back.status).toBe('active');
    expect(back.enabled).toBe(true);
  });

  it('stays switched on across the agent being unregistered and registered again (DOR-2082)', async () => {
    // The other writer that pauses a row for reasons that have nothing to do
    // with a person's decision: `disableTasksByAgentId`, run when the agent
    // that owns this schedule is unregistered from Mesh. Re-registering it
    // re-syncs the same file (`attachAgentTaskRoots` in `index.ts`), which
    // must land on the same approved-and-on row `markRemovedByFilePath`
    // produces above — not the package's shipped `enabled: false`.
    const approved = await patch(await sweep(), { status: 'active', enabled: true });
    expect(store.disableTasksByAgentId(AGENT_ID)).toBe(1);
    expect(store.getTask(approved.task!.id)?.status).toBe('paused');
    expect(store.getTask(approved.task!.id)?.enabled).toBe(true);

    const back = await sweep();

    expect(back.status).toBe('active');
    expect(back.enabled).toBe(true);
  });

  it('stays switched OFF across a package update when the person switched it off', async () => {
    // The mirror of the test above: the row keeps the person's switch, whichever
    // way they set it, and never takes the file's shipped value for theirs.
    const approved = await patch(await sweep(), { status: 'active', enabled: true });
    await patch(approved.task!, { enabled: false });
    store.markRemovedByFilePath(packagedFile);

    const back = await sweep();

    expect(back.status).toBe('active');
    expect(back.enabled).toBe(false);
  });

  it('stays approved and switched on across a server restart', async () => {
    await patch(await sweep(), { status: 'active', enabled: true });

    // A fresh store and reconciler over the same database, which is all a
    // restart keeps.
    store = new TaskStore(db);
    reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    reconciler.addRoot(skillsRoot(agentSkillsRoot(projectPath), 'project', projectPath, AGENT_ID));
    const after = await sweep();

    expect(after.status).toBe('active');
    expect(after.enabled).toBe(true);
  });

  it('is discovered switched off with nothing to escalate — no reason gate blocks a later approval (DOR-2059)', async () => {
    // The ticket: `flow-drain` and `flow-groom` both ship
    // `schedule.enabled: false`, and installing a package with N off-by-default
    // schedules must not cost N clicks. The row itself stays `pending_approval`
    // — the arm gate cannot skip a first sighting — but the schedule is
    // discovered clean, and a person switching it on later goes through the
    // FULL approval path with nothing standing in the way.
    const task = await sweep();
    expect(task.status).toBe('pending_approval');
    expect(task.enabled).toBe(false);
    // Fed a row REAL discovery produced, not a hand-written object — the two
    // halves of `needsScheduleApprovalAttention` (origin, enabled) have to
    // agree on a row `upsertFromFile` actually wrote, or a future change to
    // how either is stamped could pass its own unit test while breaking this.
    expect(needsScheduleApprovalAttention(task)).toBe(false);

    const approved = await patch(task, { status: 'active', enabled: true });

    expect(approved.ok).toBe(true);
    expect(approved.task?.status).toBe('active');
    expect(approved.task?.enabled).toBe(true);
    // The package's own file is still untouched — the arm blocker and
    // permission clamp ran on the same door every approval runs through.
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
  });

  it('is discovered switched off, then genuinely needs attention once the package ships it switched on', async () => {
    // The other half of the same real-discovery row: `needsScheduleApprovalAttention`
    // must not be permanently blind to a `file`-origin row — only to one that
    // still ships `enabled: false`. Fed the exact row discovery produces both
    // times, not a hand-written stand-in.
    const off = await sweep();
    expect(needsScheduleApprovalAttention(off)).toBe(false);

    await fs.writeFile(packagedFile, PACKAGED_SKILL.replace('enabled: false', 'enabled: true'));
    const on = await sweep();

    expect(on.status).toBe('pending_approval');
    expect(on.origin).toBe('file');
    expect(needsScheduleApprovalAttention(on)).toBe(true);
  });

  it('is never armed by switching it on without approving it (DOR-607)', async () => {
    // `enabled` lands on the row for a package-owned file, and `enabled` is
    // agent-writable. That must not become a way to start a package's job: the
    // row stays parked, and the sweep keeps the file's switch for a parked row.
    const task = await sweep();

    const switched = await patch(task, { enabled: true });
    expect(switched.ok).toBe(true);
    expect(switched.task?.status).toBe('pending_approval');

    const after = await sweep();
    expect(after.status).toBe('pending_approval');
    expect(after.enabled).toBe(false);
  });

  it('is discovered parked even when the package ships it switched on', async () => {
    await fs.writeFile(packagedFile, PACKAGED_SKILL.replace('enabled: false', 'enabled: true'));

    const task = await sweep();

    expect(task.status).toBe('pending_approval');
  });

  it('still refuses to approve a schedule whose file cannot run', async () => {
    // The arm blocker runs before the package-owned check, so the row-only path
    // cannot skip it.
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
    // The other direction: a person's approval covers the prompt and cron they
    // read. A package update that changes either re-parks the row, and the
    // file's own switch governs until they approve the new content.
    await patch(await sweep(), { status: 'active', enabled: true });
    await fs.writeFile(
      packagedFile,
      PACKAGED_SKILL.replace("cron: '0 * * * *'", "cron: '0 4 * * *'"),
      'utf-8'
    );

    const changed = await sweep();

    expect(changed.status).toBe('pending_approval');
    expect(changed.enabled).toBe(false);
    expect(changed.cron).toBe('0 4 * * *');
  });

  it('still refuses a change to what it DOES, with nothing written', async () => {
    // WHEN it runs is the person's to change since DOR-2302
    // (`package-schedule-timing.integration.test.ts`); WHAT it does stays the
    // package's.
    const task = await patch(await sweep(), { status: 'active', enabled: true });

    const renamed = await patch(task.task!, { name: 'something-else' });
    const rewritten = await patch(task.task!, { prompt: 'do something else entirely' });

    for (const refused of [renamed, rewritten]) {
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('schedule_package_owned');
    }
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);
    // The row is untouched too: the refusal comes before either write.
    const row = store.getTask(task.task!.id)!;
    expect(row.cron).toBe('0 * * * *');
    expect(row.prompt).toBe('Drain the queue.');
  });

  it('refuses a raised approval, in words about the LEVEL, and grants nothing (DOR-2100)', async () => {
    // Approving at the operator's own trust stop sends `permissionMode`
    // alongside `status`, and that field lives in the package's file. DorkOS
    // will not write it, and the row cannot hold it either — `file-sync-gates`
    // reads the level back off the file on every sweep, so a row-only grant
    // would be undone within five minutes with nothing saying why. Refusing is
    // the honest answer; what it must not do is talk only about editing a
    // package, which is not the question that was asked.
    const task = await sweep();

    const refused = await patch(task, {
      status: 'active',
      enabled: true,
      permissionMode: 'bypassPermissions',
    });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('schedule_package_owned');
    expect(refused.error).toContain('did not change how much it may do');
    expect(refused.error).toContain('You can still approve it as it stands');
    // Whole-request refusal: the approval did not half-land either.
    const row = store.getTask(task.id)!;
    expect(row.status).toBe('pending_approval');
    expect(row.permissionMode).not.toBe('bypassPermissions');
    expect(await fs.readFile(packagedFile, 'utf-8')).toBe(PACKAGED_SKILL);

    // ...and the plain approval the refusal promises still works.
    const plain = await patch(task, { status: 'active', enabled: true });
    expect(plain.ok).toBe(true);
    expect(plain.task?.status).toBe('active');
  });

  it('refuses a switch that rides along with a change to what it does', async () => {
    // The mixed request. `enabled` alone lands on the row, but it must not be a
    // way to smuggle a prompt edit into a package's checkout.
    const task = await patch(await sweep(), { status: 'active', enabled: true });

    const refused = await patch(task.task!, { enabled: false, prompt: 'do something else' });

    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('schedule_package_owned');
    expect(store.getTask(task.task!.id)!.enabled).toBe(true);
  });
});
