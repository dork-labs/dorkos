/**
 * Any skill can be a scheduled task — and none of them arms itself.
 *
 * Drives the whole discovery seam with a real filesystem, a real `TaskStore`, a
 * real `TaskRegistrar` and a real `TaskSchedulerService` over croner: a
 * `schedule:` block in a skills root becomes a parked row carrying a reason,
 * and a person's approval — and only that — turns it into a live cron job.
 *
 * The reconciler rather than chokidar drives these cases (the same
 * `readTaskRootFile` door, reached synchronously); the watcher's own path is
 * covered by `task-file-watcher.integration.test.ts`. Nothing waits for a cron
 * to fire: every schedule used is hours away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService } from '../task-scheduler-service.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { attachAgentRoots } from '../attach-task-roots.js';
import { agentSkillsRoot, agentTaskRoots, globalTaskRoots } from '../skills-roots.js';
import { readTaskRootFile } from '../skills-root-discovery.js';
import { skillsRoot } from './task-root-fixtures.js';
import {
  describeArmBlocker,
  isPackageOwned,
  packageOwnershipContext,
  planTaskFileUpdate,
  touchesFile,
} from '../task-file-update.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { onRuntime, type RuntimeDouble } from './support/runtime-task-turns.js';

/** A skill whose frontmatter carries a `schedule:` block. */
function scheduledSkill(
  name: string,
  schedule: Record<string, string | boolean>,
  body = 'Do the thing.'
): string {
  const lines = Object.entries(schedule).map(([k, v]) =>
    typeof v === 'boolean' ? `  ${k}: ${v}` : `  ${k}: '${v}'`
  );
  return `---\nname: ${name}\ndescription: A skill named ${name}\nschedule:\n${lines.join('\n')}\n---\n${body}`;
}

/** A skill with no `schedule:` block at all — the ordinary case in a skills root. */
function plainSkill(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\n---\nJust a skill.`;
}

/** An agent manager that would run a turn, if anything here ever fired one. */
function silentAgentManager(): RuntimeDouble {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as RuntimeDouble;
}

describe('schedules discovered in skills roots', () => {
  const AGENT_ID = 'agent-1';
  let dorkHome: string;
  let projectPath: string;
  let skillsDir: string;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let registrar: TaskRegistrar;
  let reconciler: TaskReconciler;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'skills-discovery-'));
    projectPath = path.join(dorkHome, 'project');
    skillsDir = agentSkillsRoot(projectPath);
    await mkdir(skillsDir, { recursive: true });
    store = new TaskStore(createTestDb());
    scheduler = new TaskSchedulerService({
      store: store,
      ...onRuntime(silentAgentManager()),
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
    });
    registrar = new TaskRegistrar({ store, scheduler });
    reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    reconciler.addRoot(skillsRoot(skillsDir, 'project', projectPath, AGENT_ID));
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `<root>/<name>/SKILL.md`. */
  async function writeSkill(name: string, content: string, root = skillsDir): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /** The operator saying yes — the `status: 'active'` write `PATCH /api/tasks/:id` performs. */
  function approve(taskId: string): void {
    store.updateTask(taskId, { status: 'active' });
    registrar.syncTask(taskId);
  }

  /** The one row, by the name of the skill that produced it. */
  function rowFor(name: string) {
    const row = store.getTasks().find((t) => t.name === name);
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }

  /** A written schedule, discovered and approved. */
  async function approvedSkill(name: string, cron = '0 2 * * *') {
    const filePath = await writeSkill(name, scheduledSkill(name, { cron }));
    await reconciler.reconcile();
    const row = rowFor(name);
    approve(row.id);
    return { filePath, id: row.id };
  }

  /** A row an operator made through the app (or an older build left), at `filePath`. */
  function operatorRow(name: string, filePath: string, cron: string) {
    return store.createTask({
      name,
      description: `A skill named ${name}`,
      prompt: 'Do the thing.',
      cron,
      timezone: 'UTC',
      filePath,
    });
  }

  describe('the end-to-end door', () => {
    it('parks a dropped-in skill with a reason, then arms it on approval', async () => {
      await writeSkill(
        'daily-health-check',
        scheduledSkill('daily-health-check', { cron: '0 9 * * *' })
      );

      await reconciler.reconcile();

      const parked = rowFor('daily-health-check');
      expect(parked).toMatchObject({
        status: 'pending_approval',
        origin: 'file',
        cron: '0 9 * * *',
      });
      expect(parked.reason).toBeTruthy();
      expect(scheduler.isRegistered(parked.id)).toBe(false);

      approve(parked.id);

      expect(scheduler.isRegistered(parked.id)).toBe(true);
      expect(scheduler.getNextRun(parked.id)?.getUTCHours()).toBe(9);
    });

    it('uses the schedule prompt over the body when the block sets one', async () => {
      await writeSkill(
        'two-audiences',
        scheduledSkill(
          'two-audiences',
          { cron: '0 9 * * *', prompt: 'Run the nightly sweep.' },
          'How a person should use this skill.'
        )
      );

      await reconciler.reconcile();

      expect(rowFor('two-audiences').prompt).toBe('Run the nightly sweep.');
    });
  });

  describe('what is and is not a schedule', () => {
    it('ignores a skill with no schedule block — no row, no complaint', async () => {
      await writeSkill('just-a-skill', plainSkill('just-a-skill'));

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });
      expect(store.getTasks()).toEqual([]);
    });

    it('ignores a file still written in the retired top-level shape (DOR-1486)', async () => {
      // The unified schema drops keys it does not know, so a top-level `cron:`
      // is a valid PLAIN skill, and a plain skill is not a schedule.
      await writeSkill(
        'old-timer',
        `---\nname: old-timer\ndescription: A task\ncron: '0 2 * * *'\ntimezone: UTC\n---\nDo it.`
      );

      await expect(reconciler.reconcile()).resolves.toMatchObject({ upserted: 0 });
      expect(store.getTasks()).toHaveLength(0);
    });

    it('retires an approved schedule whose block was removed while nobody watched (DOR-1485 B3)', async () => {
      const { filePath, id } = await approvedSkill('was-scheduled');

      await writeFile(filePath, plainSkill('was-scheduled'), 'utf-8');
      await reconciler.reconcile();

      // Paused, never deleted: the run history is the person's, not the block's.
      expect(store.getTask(id)?.status).toBe('paused');
      expect(scheduler.isRegistered(id)).toBe(false);
    });

    it('parks a skill whose schedule block does not parse, naming the problem', async () => {
      await writeSkill('broken-block', scheduledSkill('broken-block', { permissions: 'yolo' }));

      await reconciler.reconcile();

      const row = rowFor('broken-block');
      expect(row).toMatchObject({ status: 'pending_approval', cron: '', enabled: false });
      expect(row.reason).toContain('permissions');
    });

    it.each([
      ['cron', { cron: 'banana' }, 'banana'],
      ['timezone', { cron: '0 9 * * *', timezone: 'Mars/Olympus_Mons' }, 'Mars/Olympus_Mons'],
    ])('parks a schedule whose %s croner refuses, naming it', async (_what, schedule, named) => {
      await writeSkill('bad', scheduledSkill('bad', schedule));

      await reconciler.reconcile();

      expect(rowFor('bad').status).toBe('pending_approval');
      expect(rowFor('bad').reason).toContain(named);
    });

    it('treats a never-firing cron as a real schedule, not a typo', async () => {
      // `0 0 31 2 *` is how DorkOS's own browser suite writes a by-hand-only task.
      await writeSkill('never-fires', scheduledSkill('never-fires', { cron: '0 0 31 2 *' }));

      await reconciler.reconcile();

      const row = rowFor('never-fires');
      expect(row.status).toBe('pending_approval');
      expect(row.reason).not.toContain('31 2');
      approve(row.id);
      expect(scheduler.isRegistered(row.id)).toBe(true);
      expect(scheduler.getNextRun(row.id)).toBeNull();
    });

    it('parks a schedule the file switched off, and one it switched on, alike', async () => {
      // `enabled` is the author's intent. Intent is not permission.
      await writeSkill('off', scheduledSkill('off', { cron: '0 9 * * *', enabled: false }));
      await writeSkill('on', scheduledSkill('on', { cron: '0 9 * * *', enabled: true }));

      await reconciler.reconcile();

      expect(rowFor('off')).toMatchObject({ status: 'pending_approval', enabled: false });
      expect(rowFor('on')).toMatchObject({ status: 'pending_approval', enabled: true });
    });
  });

  // The file is the person's, and DorkOS is a guest in it (DOR-1485 review, B1),
  // driven through `planTaskFileUpdate`, the decision the route makes.
  describe('editing a schedule never damages its file', () => {
    it('does not consider the file touched by an approval', () => {
      expect(touchesFile({ status: 'active', reason: 'because' })).toBe(false);
      // `permissionMode` is `permissions:` in the frontmatter, so it counts.
      expect(touchesFile({ permissionMode: 'acceptEdits' })).toBe(true);
      expect(touchesFile({ cron: '0 9 * * *' })).toBe(true);
    });

    it('writes an edit into the schedule block, the size the author wrote it', () => {
      const content = scheduledSkill('nightly', { cron: '0 9 * * *' });

      const cronPlan = planTaskFileUpdate('/skills/nightly/SKILL.md', content, {
        cron: '0 21 * * *',
      });
      if (cronPlan.kind !== 'write') throw new Error('expected a write');
      expect(cronPlan.frontmatter.schedule).toEqual({ cron: '0 21 * * *' });
      // A top-level key too would leave the file disagreeing with itself forever.
      expect(cronPlan.frontmatter.cron).toBeUndefined();

      const namePlan = planTaskFileUpdate('/skills/nightly/SKILL.md', content, {
        displayName: 'Nightly sweep',
      });
      if (namePlan.kind !== 'write') throw new Error('expected a write');
      // No `timezone`, `enabled` or `permissions` materialized.
      expect(namePlan.frontmatter.schedule).toEqual({ cron: '0 9 * * *' });
    });

    it('refuses to rewrite a file whose block it cannot read', () => {
      // Spreading the PARSED meta back lost the author's schedule for good.
      const content = scheduledSkill('broken', { permissions: 'yolo' });
      const plan = planTaskFileUpdate('/skills/broken/SKILL.md', content, {
        displayName: 'Broken',
      });

      expect(plan.kind).toBe('refuse');
    });

    it('refuses to arm a schedule whose file does not read, naming the problem', () => {
      expect(
        describeArmBlocker('/skills/bad/SKILL.md', scheduledSkill('bad', { cron: 'banana' }))
      ).toMatch(/banana/);
      expect(
        describeArmBlocker('/skills/ok/SKILL.md', scheduledSkill('ok', { cron: '0 9 * * *' }))
      ).toBeNull();
    });

    it('treats an installed plugin’s or Shape’s skill as not ours to write (DOR-1789)', async () => {
      const roots = packageOwnershipContext(dorkHome, projectPath);
      const pluginSkill = path.join(dorkHome, 'plugins', 'pack', 'skills', 'x', 'SKILL.md');
      const shapeSkill = path.join(dorkHome, 'shapes', 'studio', 'skills', 'z', 'SKILL.md');
      const projectSkill = path.join(
        projectPath,
        '.dork',
        'plugins',
        'p',
        'skills',
        'y',
        'SKILL.md'
      );
      for (const file of [pluginSkill, shapeSkill, projectSkill]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, scheduledSkill('x', { cron: '0 9 * * *' }), 'utf-8');
        expect(await isPackageOwned(file, roots), file).toBe(true);
      }
      // Reached through the symlink an install leaves in `.agents/skills/`.
      const link = path.join(skillsDir, 'pack__x');
      await symlink(path.dirname(pluginSkill), link);
      expect(await isPackageOwned(path.join(link, 'SKILL.md'), roots)).toBe(true);

      // A person's own skill is theirs, and so is a path that merely says "plugins".
      expect(await isPackageOwned(path.join(skillsDir, 'mine', 'SKILL.md'), roots)).toBe(false);
      expect(
        await isPackageOwned(path.join(projectPath, 'src', 'plugins', 'a', 'SKILL.md'), roots)
      ).toBe(false);
    });
  });

  // A discovery sync must never overwrite provenance it did not create
  // (DOR-1485 review, B2). The row is keyed on the REAL path discovery produces:
  // macOS temp dirs sit under a symlinked `/var`.
  describe('provenance discovery did not create', () => {
    let filePath: string;

    beforeEach(async () => {
      filePath = await realpath(
        await writeSkill('proposed', scheduledSkill('proposed', { cron: '0 4 * * *' }))
      );
    });

    it('leaves an agent’s parked proposal exactly as the agent left it', async () => {
      const seeded = operatorRow('proposed', filePath, '0 4 * * *');
      store.updateTask(seeded.id, { status: 'pending_approval' });
      store.recordProposal(seeded.id, {
        reason: 'The backlog piles up overnight and nobody sees it.',
        proposedByAgentPath: '/Users/dev/agents/dorkbot',
      });

      await reconciler.reconcile();
      await reconciler.reconcile();

      expect(store.getTask(seeded.id)).toMatchObject({
        reason: 'The backlog piles up overnight and nobody sees it.',
        proposedByAgentPath: '/Users/dev/agents/dorkbot',
        origin: null,
        status: 'pending_approval',
      });
    });

    it('never stamps origin file on a schedule the operator made', async () => {
      const seeded = operatorRow('proposed', filePath, '0 4 * * *');

      await reconciler.reconcile();

      expect(store.getTask(seeded.id)).toMatchObject({
        status: 'active',
        origin: null,
        reason: null,
      });
    });
  });

  // The arm grant is a STORED key, not something inferred from `status`
  // (DOR-1485 review, N1).
  describe('the arm grant cannot be forged by writing a status', () => {
    it('does not arm a parked schedule when its agent is unregistered and registered again', async () => {
      await writeSkill('planted', scheduledSkill('planted', { cron: '0 2 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('planted');
      expect(store.approvals.backfillApprovalGrants()).toBe(0);

      store.disableTasksByAgentId(AGENT_ID);
      expect(store.getTask(row.id)?.status).toBe('paused');
      // Neither a parked row nor a paused one is evidence of a decision.
      expect(store.approvals.backfillApprovalGrants()).toBe(0);

      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('pending_approval');
      expect(scheduler.isRegistered(row.id)).toBe(false);
    });

    it('does not arm a parked schedule that is deleted and restored', async () => {
      const filePath = await writeSkill(
        'planted',
        scheduledSkill('planted', { cron: '0 2 * * *' })
      );
      await reconciler.reconcile();
      const row = rowFor('planted');

      await rm(filePath);
      await reconciler.reconcile();
      await writeFile(filePath, scheduledSkill('planted', { cron: '0 2 * * *' }), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('pending_approval');
    });

    it('re-arms an APPROVED schedule that is deleted and restored unchanged', async () => {
      // What an atomic-rename save, and a package update, look like from here.
      const { filePath, id } = await approvedSkill('saved');

      await rm(filePath);
      await reconciler.reconcile();
      await writeFile(filePath, scheduledSkill('saved', { cron: '0 2 * * *' }), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(id)?.status).toBe('active');
      expect(scheduler.isRegistered(id)).toBe(true);
    });

    it('withdraws the grant when the content drifts, and says so in our own words', async () => {
      const { filePath, id } = await approvedSkill('drifter');

      await writeFile(filePath, scheduledSkill('drifter', { cron: '0 5 * * *' }), 'utf-8');
      await reconciler.reconcile();

      const after = store.getTask(id)!;
      expect(after.status).toBe('pending_approval');
      expect(scheduler.isRegistered(id)).toBe(false);
      expect(after.reason).toMatch(/changed since/i);
      expect(after.reasonSource).toBe('dorkos');
      // Approving again grants the NEW content, so the next sync leaves it alone.
      approve(id);
      await reconciler.reconcile();
      expect(store.getTask(id)?.status).toBe('active');
    });

    it('does not re-arm when a drifted file is reverted to the approved content', async () => {
      // The park clears the grant; without that, editing away and back re-arms.
      const { filePath, id } = await approvedSkill('reverted', '0 6 * * *');

      await writeFile(filePath, scheduledSkill('reverted', { cron: '0 23 * * *' }), 'utf-8');
      await reconciler.reconcile();
      await writeFile(filePath, scheduledSkill('reverted', { cron: '0 6 * * *' }), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(id)?.status).toBe('pending_approval');
      expect(scheduler.isRegistered(id)).toBe(false);
    });

    it('keeps schedules that were already live approved across the upgrade', async () => {
      // A row exactly as an older build left it: active, no grant.
      const filePath = await writeSkill(
        'legacy-live',
        scheduledSkill('legacy-live', { cron: '0 8 * * *' })
      );
      const seeded = operatorRow('legacy-live', await realpath(filePath), '0 8 * * *');
      store.approvals.withdrawApproval(seeded.id);

      expect(store.approvals.backfillApprovalGrants()).toBe(1);
      expect(store.approvals.backfillApprovalGrants()).toBe(0);
      await reconciler.reconcile();

      expect(store.getTask(seeded.id)?.status).toBe('active');
    });

    it('arms an un-paused operator write WITH a grant, not without one (R2)', async () => {
      // Never approved — the case that discriminates.
      const filePath = await writeSkill('shaped', scheduledSkill('shaped', { cron: '0 6 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('shaped');
      await rm(filePath);
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('paused');

      // An install writes the same path again, as an operator action.
      await writeFile(filePath, scheduledSkill('shaped', { cron: '0 6 * * *' }), 'utf-8');
      const seen = await readTaskRootFile(
        filePath,
        scheduledSkill('shaped', { cron: '0 6 * * *' }),
        skillsRoot(skillsDir, 'project', projectPath, AGENT_ID)
      );
      if (seen.kind !== 'schedule') throw new Error('expected a schedule');
      store.fileSync.upsertFromFile(seen.discovered.def, AGENT_ID);
      expect(store.getTask(row.id)?.status).toBe('active');

      // Without a grant the next sync would park what the install stood up.
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('active');
    });
  });

  describe('one real file is one schedule', () => {
    it('collapses a symlinked skill and its target into a single row (DOR-1485 N2)', async () => {
      // Harness Sync's real shape: a NAMESPACED link (`pack__shared-sweep`) to a
      // file that says `name: shared-sweep`, reached from two agents' roots.
      const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'shared-sweep');
      await mkdir(realDir, { recursive: true });
      const realFile = path.join(realDir, 'SKILL.md');
      await writeFile(realFile, scheduledSkill('shared-sweep', { cron: '0 3 * * *' }), 'utf-8');
      const otherProject = path.join(dorkHome, 'other');
      const otherSkills = agentSkillsRoot(otherProject);
      await mkdir(otherSkills, { recursive: true });
      await symlink(realDir, path.join(otherSkills, 'pack__shared-sweep'));
      await symlink(realDir, path.join(skillsDir, 'pack__shared-sweep'));
      reconciler.addRoot(skillsRoot(otherSkills, 'project', otherProject, 'agent-2'));

      await reconciler.reconcile();
      await reconciler.reconcile();

      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTasks()[0]).toMatchObject({
        filePath: await realpath(realFile),
        agentId: AGENT_ID,
        name: 'shared-sweep',
      });
    });

    it('retires a plugin schedule when its target is uninstalled (DOR-1485 I3)', async () => {
      const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'sweep');
      await writeSkill(
        'sweep',
        scheduledSkill('sweep', { cron: '0 3 * * *' }),
        path.dirname(realDir)
      );
      await symlink(realDir, path.join(skillsDir, 'pack__sweep'));
      await reconciler.reconcile();
      const row = rowFor('sweep');
      approve(row.id);

      // The uninstall: the package's own directory goes, the link dangles.
      await rm(realDir, { recursive: true, force: true });
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('paused');
      expect(scheduler.isRegistered(row.id)).toBe(false);
    });

    it('never watches .claude/skills — the projection mirror', () => {
      const roots = [...agentTaskRoots(projectPath, AGENT_ID), ...globalTaskRoots(dorkHome)];

      for (const root of roots) expect(root.dir).not.toContain('.claude');
      expect(roots.map((r) => r.dir)).toContain(path.join(projectPath, '.agents', 'skills'));
    });
  });

  describe('agents that register after boot', () => {
    it('discovers a schedule in a project whose agent registered late', async () => {
      const lateReconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
      const lateProject = path.join(dorkHome, 'late-project');
      const lateSkills = agentSkillsRoot(lateProject);
      await writeSkill(
        'late-riser',
        scheduledSkill('late-riser', { cron: '0 5 * * *' }),
        lateSkills
      );

      await lateReconciler.reconcile();
      expect(store.getTasks()).toEqual([]);

      attachAgentRoots({ reconciler: lateReconciler }, lateProject, 'agent-late');
      await lateReconciler.reconcile();

      expect(rowFor('late-riser')).toMatchObject({
        agentId: 'agent-late',
        status: 'pending_approval',
      });
    });

    it('does not scan a root twice when an agent is attached twice', async () => {
      const lateReconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
      await writeSkill('once-only', scheduledSkill('once-only', { cron: '0 5 * * *' }));

      attachAgentRoots({ reconciler: lateReconciler }, projectPath, AGENT_ID);
      attachAgentRoots({ reconciler: lateReconciler }, projectPath, AGENT_ID);

      await expect(lateReconciler.reconcile()).resolves.toMatchObject({ upserted: 1 });
    });
  });
});
