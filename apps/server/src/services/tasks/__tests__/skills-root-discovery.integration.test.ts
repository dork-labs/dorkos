/**
 * Any skill can be a scheduled task — and none of them arms itself.
 *
 * Drives the whole discovery seam with a real filesystem, a real `TaskStore`, a
 * real `TaskRegistrar` and a real `TaskSchedulerService` over croner. The claim
 * under test spans all four: a `schedule:` block in a skills root becomes a
 * parked row carrying a reason, and a person's approval — and only that — turns
 * it into a live cron job.
 *
 * The reconciler rather than chokidar drives most cases here. It is the same
 * `readTaskRootFile` door, reached synchronously, so the tests read as
 * assertions instead of as polling; the watcher's own path is covered by
 * `task-file-watcher.integration.test.ts` and `task-registrar.integration.test.ts`.
 *
 * Nothing waits for a cron to fire: every schedule used is hours away, and the
 * assertions read the job's next run rather than its output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { attachAgentRoots } from '../attach-task-roots.js';
import { agentSkillsRoot, agentTaskRoots, globalTaskRoots } from '../skills-roots.js';
import { skillsRoot } from './task-root-fixtures.js';
import {
  describeArmBlocker,
  isPackageOwned,
  packageOwnershipContext,
  planTaskFileUpdate,
  touchesFile,
} from '../task-file-update.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

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

/** A legacy task file, with its scheduling fields at the top level. */
function legacyTaskFile(name: string, cron: string): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\ncron: '${cron}'\ntimezone: UTC\n---\nDo the thing.`;
}

/** An agent manager that would run a turn, if anything here ever fired one. */
function silentAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as SchedulerAgentManager;
}

describe('schedules discovered in skills roots', () => {
  const AGENT_ID = 'agent-1';
  let dorkHome: string;
  let projectPath: string;
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let registrar: TaskRegistrar;
  let reconciler: TaskReconciler;
  let identities: ScheduleIdentityRegistry;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'skills-discovery-'));
    projectPath = path.join(dorkHome, 'project');
    skillsDir = agentSkillsRoot(projectPath);
    await mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new TaskSchedulerService(store, silentAgentManager(), {
      maxConcurrentRuns: 1,
      retentionCount: 100,
      mayFire: true,
      firingReason: 'test',
    });
    registrar = new TaskRegistrar({ store, scheduler });
    identities = new ScheduleIdentityRegistry();
    reconciler = new TaskReconciler(store, registrar, identities);
    reconciler.addRoot(skillsRoot(skillsDir, 'project', projectPath, AGENT_ID));
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `<skillsDir>/<name>/SKILL.md`. */
  async function writeSkill(name: string, content: string, root = skillsDir): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * The operator saying yes — the same `status: 'active'` transition
   * `PATCH /api/tasks/:id` performs, which is what the route treats as the
   * approval (`task-write-policy.ts`).
   */
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

  describe('the end-to-end door', () => {
    it('parks a dropped-in skill with a reason, then arms it on approval', async () => {
      await writeSkill(
        'daily-health-check',
        scheduledSkill('daily-health-check', { cron: '0 9 * * *' })
      );

      await reconciler.reconcile();

      const parked = rowFor('daily-health-check');
      expect(parked.status).toBe('pending_approval');
      expect(parked.origin).toBe('file');
      expect(parked.reason).toBeTruthy();
      expect(parked.cron).toBe('0 9 * * *');
      // Parked means parked: nothing is on the clock.
      expect(scheduler.isRegistered(parked.id)).toBe(false);

      approve(parked.id);

      expect(scheduler.isRegistered(parked.id)).toBe(true);
      expect(scheduler.getNextRun(parked.id)?.getUTCHours()).toBe(9);
    });

    it('keeps an approved schedule armed across re-syncs of identical content', async () => {
      await writeSkill('steady', scheduledSkill('steady', { cron: '0 9 * * *' }));
      await reconciler.reconcile();
      const task = rowFor('steady');
      approve(task.id);

      await reconciler.reconcile();
      await reconciler.reconcile();

      expect(store.getTask(task.id)?.status).toBe('active');
      expect(scheduler.isRegistered(task.id)).toBe(true);
    });

    it('re-parks when the content changes under an approved schedule', async () => {
      const filePath = await writeSkill('drifts', scheduledSkill('drifts', { cron: '0 9 * * *' }));
      await reconciler.reconcile();
      const task = rowFor('drifts');
      approve(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(true);

      // Same file, same path, different work — exactly the substitution the
      // content key exists to catch.
      await writeFile(
        filePath,
        scheduledSkill('drifts', { cron: '0 9 * * *' }, 'Do something else entirely.'),
        'utf-8'
      );
      await reconciler.reconcile();

      expect(store.getTask(task.id)?.status).toBe('pending_approval');
      expect(scheduler.isRegistered(task.id)).toBe(false);
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

      await expect(reconciler.reconcile()).resolves.toMatchObject({ upserted: 0 });

      expect(store.getTasks()).toEqual([]);
    });

    // Removing the block is how a person turns a scheduled task back into an
    // ordinary skill. The watcher pauses the row when it sees that; the
    // reconciler exists for the changes the watcher did NOT see, and skipping
    // them there left an approved schedule firing forever off a file that no
    // longer claims to be a schedule (DOR-1485 review, B3).
    it('retires an approved schedule whose block was removed while nobody watched', async () => {
      const filePath = await writeSkill(
        'was-scheduled',
        scheduledSkill('was-scheduled', { cron: '0 9 * * *' })
      );
      await reconciler.reconcile();
      const row = rowFor('was-scheduled');
      approve(row.id);
      expect(scheduler.isRegistered(row.id)).toBe(true);

      // The block goes; the skill stays.
      await writeFile(filePath, plainSkill('was-scheduled'), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('paused');
      expect(store.getTask(row.id)?.enabled).toBe(false);
      expect(scheduler.isRegistered(row.id)).toBe(false);
      // Paused, never deleted: the file is still there and the run history is
      // the person's, not the block's.
      expect(store.getTask(row.id)).not.toBeNull();
    });

    it('says nothing about a plain skill that never had a row', async () => {
      await writeSkill('never-scheduled', plainSkill('never-scheduled'));

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });
    });

    it('parks a skill whose schedule block does not parse, naming the problem', async () => {
      await writeSkill('broken-block', scheduledSkill('broken-block', { permissions: 'yolo' }));

      await reconciler.reconcile();

      const row = rowFor('broken-block');
      expect(row.status).toBe('pending_approval');
      expect(row.reason).toContain('permissions');
      // The block claimed nothing DorkOS could read, so nothing is claimed for
      // it: no cron, and not enabled.
      expect(row.cron).toBe('');
      expect(row.enabled).toBe(false);
    });

    it('parks a schedule whose cron croner refuses, naming the cron', async () => {
      await writeSkill('bad-cron', scheduledSkill('bad-cron', { cron: 'banana' }));

      await reconciler.reconcile();

      const row = rowFor('bad-cron');
      expect(row.status).toBe('pending_approval');
      expect(row.reason).toContain('banana');
    });

    it('parks a schedule whose timezone croner refuses, naming the timezone', async () => {
      await writeSkill(
        'bad-tz',
        scheduledSkill('bad-tz', { cron: '0 9 * * *', timezone: 'Mars/Olympus_Mons' })
      );

      await reconciler.reconcile();

      expect(rowFor('bad-tz').reason).toContain('Mars/Olympus_Mons');
    });

    // A cron that never comes round is legal and deliberate — `0 0 31 2 *`,
    // February 31st, is how DorkOS's own browser suite writes a task that only
    // ever runs by hand. It parks like any other, and approving it works.
    it('treats a never-firing cron as a real schedule, not a typo', async () => {
      await writeSkill('never-fires', scheduledSkill('never-fires', { cron: '0 0 31 2 *' }));

      await reconciler.reconcile();

      const row = rowFor('never-fires');
      expect(row.status).toBe('pending_approval');
      // Parked by the arm gate, NOT by a validation complaint: nothing is wrong
      // with this file.
      expect(row.reason).not.toContain('31 2');

      approve(row.id);

      expect(scheduler.isRegistered(row.id)).toBe(true);
      expect(scheduler.getNextRun(row.id)).toBeNull();
    });

    // `enabled` is the author's intent. Intent is not permission.
    it('parks a schedule the file switched off, and one it switched on, alike', async () => {
      await writeSkill('off', scheduledSkill('off', { cron: '0 9 * * *', enabled: false }));
      await writeSkill('on', scheduledSkill('on', { cron: '0 9 * * *', enabled: true }));

      await reconciler.reconcile();

      expect(rowFor('off').status).toBe('pending_approval');
      expect(rowFor('on').status).toBe('pending_approval');
      // The intent still survives into the row; it just does not arm anything.
      expect(rowFor('off').enabled).toBe(false);
      expect(rowFor('on').enabled).toBe(true);
    });
  });

  // The file is the person's, and DorkOS is a guest in it. These are the cases
  // where the route used to write into it and should not have (DOR-1485 review,
  // B1) — driven through `planTaskFileUpdate`, which is the decision the route
  // makes, rather than through HTTP.
  describe('editing a schedule never damages its file', () => {
    it('does not consider the file touched by an approval', () => {
      // `status` lives only in the row, and approving sends it alone.
      expect(touchesFile({ status: 'active' })).toBe(false);
      expect(touchesFile({ status: 'active', reason: 'because' })).toBe(false);
      expect(touchesFile({})).toBe(false);
      // Everything that IS in the file still counts — `permissionMode` included.
      // It is operator-only, but it is also `permissions:` in the frontmatter,
      // and a row holding a mode its own file contradicts is a standing lie in
      // the source of truth that the next sync would revert.
      expect(touchesFile({ permissionMode: 'acceptEdits' })).toBe(true);
      expect(touchesFile({ cron: '0 9 * * *' })).toBe(true);
      expect(touchesFile({ prompt: 'Do something else' })).toBe(true);
      expect(touchesFile({ enabled: false })).toBe(true);
    });

    it('writes a cron edit into the schedule block, not at the top level', () => {
      const content = scheduledSkill('nightly', { cron: '0 9 * * *' });
      const plan = planTaskFileUpdate('/skills/nightly/SKILL.md', content, {
        cron: '0 21 * * *',
      });

      if (plan.kind !== 'write') throw new Error('expected a write');
      expect(plan.frontmatter.schedule).toEqual({ cron: '0 21 * * *' });
      // The top-level key is where the old code put it, and a file carrying both
      // disagrees with itself forever: the row follows the block, and every sync
      // reverts the edit and re-parks the schedule.
      expect(plan.frontmatter.cron).toBeUndefined();
    });

    it('keeps a hand-written block the size the author wrote it', () => {
      const content = scheduledSkill('nightly', { cron: '0 9 * * *' });
      const plan = planTaskFileUpdate('/skills/nightly/SKILL.md', content, {
        displayName: 'Nightly sweep',
      });

      if (plan.kind !== 'write') throw new Error('expected a write');
      // No `timezone`, `enabled` or `permissions` materialized into a file that
      // never mentioned them.
      expect(plan.frontmatter.schedule).toEqual({ cron: '0 9 * * *' });
      expect(plan.frontmatter['display-name']).toBe('Nightly sweep');
    });

    it('refuses to rewrite a file whose block it cannot read', () => {
      const content = scheduledSkill('broken', { permissions: 'yolo' });
      const plan = planTaskFileUpdate('/skills/broken/SKILL.md', content, {
        displayName: 'Broken',
      });

      // The old path spread the PARSED meta back, which replaced the author's
      // settings with the complaint object and lost their schedule for good.
      expect(plan.kind).toBe('refuse');
    });

    it('refuses to arm a schedule whose file does not read, naming the problem', () => {
      expect(
        describeArmBlocker('/skills/broken/SKILL.md', scheduledSkill('broken', { cron: '' }))
      ).toMatch(/"cron"/);
      expect(
        describeArmBlocker('/skills/bad/SKILL.md', scheduledSkill('bad', { cron: 'banana' }))
      ).toMatch(/banana/);
      // A file that reads has nothing to say.
      expect(
        describeArmBlocker('/skills/ok/SKILL.md', scheduledSkill('ok', { cron: '0 9 * * *' }))
      ).toBeNull();
    });

    it('treats an installed package’s skill as not ours to write', async () => {
      const roots = packageOwnershipContext(dorkHome, projectPath);
      const pluginSkill = path.join(dorkHome, 'plugins', 'pack', 'skills', 'x', 'SKILL.md');
      await mkdir(path.dirname(pluginSkill), { recursive: true });
      await writeFile(pluginSkill, scheduledSkill('x', { cron: '0 9 * * *' }), 'utf-8');

      expect(await isPackageOwned(pluginSkill, roots)).toBe(true);
      // Reached through the symlink an install leaves in `.agents/skills/`, the
      // answer has to be the same — that is the path the row actually holds.
      const link = path.join(skillsDir, 'pack__x');
      await symlink(path.dirname(pluginSkill), link);
      expect(await isPackageOwned(path.join(link, 'SKILL.md'), roots)).toBe(true);

      // A project-scoped install counts too.
      const projectSkill = path.join(
        projectPath,
        '.dork',
        'plugins',
        'p',
        'skills',
        'y',
        'SKILL.md'
      );
      await mkdir(path.dirname(projectSkill), { recursive: true });
      await writeFile(projectSkill, scheduledSkill('y', { cron: '0 9 * * *' }), 'utf-8');
      expect(await isPackageOwned(projectSkill, roots)).toBe(true);

      // A person's own skill is theirs, and so is a directory that merely has
      // the word in its path.
      expect(await isPackageOwned(path.join(skillsDir, 'mine', 'SKILL.md'), roots)).toBe(false);
      expect(
        await isPackageOwned(path.join(projectPath, 'src', 'plugins', 'a', 'SKILL.md'), roots)
      ).toBe(false);
    });

    it('treats an installed Shape’s skill as not ours to write', async () => {
      // `shapes/` is an install root like `plugins/`, and a Shape package ships
      // skills the same way — a plugins-only check answered `false` here and let
      // DorkOS edit a checkout the next update overwrites (DOR-1789).
      const roots = packageOwnershipContext(dorkHome, projectPath);
      const shapeSkill = path.join(dorkHome, 'shapes', 'studio', 'skills', 'z', 'SKILL.md');
      await mkdir(path.dirname(shapeSkill), { recursive: true });
      await writeFile(shapeSkill, scheduledSkill('z', { cron: '0 9 * * *' }), 'utf-8');

      expect(await isPackageOwned(shapeSkill, roots)).toBe(true);
    });

    it('does not claim a skill just for sitting under an agents/ root', async () => {
      // `agents/` holds every agent DorkOS creates, DorkBot included, so the
      // limb that walks it is marker-gated: an unmarked directory there is the
      // person's, and claiming it would be the DOR-1789 bug pointed the other
      // way.
      //
      // Scope note: this file asserts the ROOTS limbs directly, on a context
      // built by hand. It says nothing about what the routes pass — that is
      // exactly the gap that let the first fix ship broken — so the route-shaped
      // cases, including every one that depends on the agent-directory probe,
      // live in `lifecycle/__tests__/package-owned-agent.test.ts`, which drives
      // `applyTaskFileUpdate` and `createScheduledTask` with a real mesh seam.
      const roots = packageOwnershipContext(dorkHome, projectPath);
      const agentDir = path.join(dorkHome, 'agents', 'dorkbot');
      const ownSkill = path.join(agentDir, '.agents', 'skills', 'mine', 'SKILL.md');
      await mkdir(path.dirname(ownSkill), { recursive: true });
      await writeFile(ownSkill, scheduledSkill('mine', { cron: '0 9 * * *' }), 'utf-8');

      expect(await isPackageOwned(ownSkill, roots)).toBe(false);
    });
  });

  // A discovery sync must never overwrite provenance it did not create
  // (DOR-1485 review, B2). The legacy roots are full of rows discovery did not
  // create: agent proposals, and the operator's own schedules.
  describe('provenance discovery did not create', () => {
    /** The schedule's file, and the path a row for it is keyed on. */
    let filePath: string;

    beforeEach(async () => {
      // A REAL schedule in a watched root, and the row below is keyed on the
      // path discovery produces — both halves are load-bearing, and both were
      // wrong when this suite was mechanically converted off the legacy roots
      // (DOR-1486). The fixture used to write a legacy top-level-cron file into
      // `.dork/tasks` and register that as a skills root, which under the new
      // rules is not a schedule at all: discovery reads it as a plain skill and
      // RETIRES the row, which is correct behavior and tests none of the
      // provenance rules below.
      //
      // It passed anyway on macOS, and only there: the row was keyed on an
      // unresolved `/var/...` temp path while the retirement looks up the
      // resolved `/private/var/...` one, so the pause silently matched nothing
      // and every assertion held for the wrong reason. On Linux, where the
      // temp directory is not a symlink, the same pass paused the row and both
      // tests failed. A fixture that only works on one platform is not the
      // point — a fixture that exercises the thing it names is.
      filePath = await realPath(
        await writeSkill('proposed', scheduledSkill('proposed', { cron: '0 4 * * *' }))
      );
    });

    it('leaves an agent’s parked proposal exactly as the agent left it', async () => {
      const seeded = store.createTask({
        name: 'proposed',
        description: 'A task named proposed',
        prompt: 'Do the thing.',
        cron: '0 4 * * *',
        timezone: 'UTC',
        filePath,
      });
      store.updateTask(seeded.id, { status: 'pending_approval' });
      store.recordProposal(seeded.id, {
        reason: 'The backlog piles up overnight and nobody sees it.',
        proposedByAgentPath: '/Users/dev/agents/dorkbot',
      });
      const before = store.getTask(seeded.id)!;

      await reconciler.reconcile();
      await reconciler.reconcile();

      const after = store.getTask(seeded.id)!;
      // The agent's case, and who made it, survive every pass verbatim. The
      // approval card is built out of these three fields.
      expect(after.reason).toBe(before.reason);
      expect(after.proposedByAgentPath).toBe(before.proposedByAgentPath);
      expect(after.origin).toBeNull();
      expect(after.status).toBe('pending_approval');
    });

    it('never stamps origin file on a schedule the operator made', async () => {
      const seeded = store.createTask({
        name: 'proposed',
        description: 'A task named proposed',
        prompt: 'Do the thing.',
        cron: '0 4 * * *',
        timezone: 'UTC',
        filePath,
      });

      await reconciler.reconcile();

      const after = store.getTask(seeded.id)!;
      expect(after.status).toBe('active');
      // `origin: 'file'` means "nobody asked for this, DorkOS found it". Saying
      // it about a row a person created through the app is simply false.
      expect(after.origin).toBeNull();
      expect(after.reason).toBeNull();
    });
  });

  // The arm grant is a STORED key, not something inferred from `status`. Two
  // separate writers used to mint consent by writing a status for their own
  // reasons; these are the repros (DOR-1485 review, N1).
  describe('the arm grant cannot be forged by writing a status', () => {
    it('does not arm a parked schedule when its agent is unregistered and registered again', async () => {
      await writeSkill('planted', scheduledSkill('planted', { cron: '0 2 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('planted');
      expect(row.status).toBe('pending_approval');

      // Unregistering an agent pauses every one of its schedules — including the
      // ones nobody has approved. This is the second writer that used to mint
      // consent by writing a status, and the reason the grant is stored rather
      // than inferred: guarding writers one at a time was always going to miss
      // the next one.
      store.disableTasksByAgentId(AGENT_ID);
      expect(store.getTask(row.id)?.status).toBe('paused');

      // ...and registering it again re-syncs the same file.
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('pending_approval');
      expect(scheduler.isRegistered(row.id)).toBe(false);
      // Nothing anywhere recorded an approval, because nobody made one.
      expect(store.backfillApprovalGrants()).toBe(0);
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
      const filePath = await writeSkill('saved', scheduledSkill('saved', { cron: '0 2 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('saved');
      approve(row.id);

      // What an atomic-rename save, and a package update, look like from here.
      await rm(filePath);
      await reconciler.reconcile();
      await writeFile(filePath, scheduledSkill('saved', { cron: '0 2 * * *' }), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('active');
      expect(scheduler.isRegistered(row.id)).toBe(true);
    });

    it('withdraws the grant when the content drifts, and says so in our own words', async () => {
      const filePath = await writeSkill(
        'drifter',
        scheduledSkill('drifter', { cron: '0 2 * * *' })
      );
      await reconciler.reconcile();
      const row = rowFor('drifter');
      approve(row.id);

      await writeFile(filePath, scheduledSkill('drifter', { cron: '0 5 * * *' }), 'utf-8');
      await reconciler.reconcile();

      const after = store.getTask(row.id)!;
      expect(after.status).toBe('pending_approval');
      // The drift sentence, not the found-in-a-file one — this schedule was
      // approved once and is not news.
      expect(after.reason).toMatch(/changed since/i);
      expect(after.reasonSource).toBe('dorkos');
      // And approving it again re-issues a grant for the NEW content, so the
      // next sync leaves it alone.
      approve(after.id);
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('active');
    });

    // The upgrade path: every alpha user has active rows written before the
    // grant column existed.
    it('keeps schedules that were already live approved across the upgrade', async () => {
      const filePath = await writeSkill(
        'legacy-live',
        scheduledSkill('legacy-live', { cron: '0 8 * * *' })
      );
      // A row exactly as an older build left it: active, no grant.
      const seeded = store.createTask({
        name: 'legacy-live',
        description: 'A skill named legacy-live',
        prompt: 'Do the thing.',
        cron: '0 8 * * *',
        timezone: 'UTC',
        filePath: await realPath(filePath),
      });
      store.withdrawApproval(seeded.id);

      expect(store.backfillApprovalGrants()).toBe(1);
      // Idempotent: a second boot has nothing left to do.
      expect(store.backfillApprovalGrants()).toBe(0);

      await reconciler.reconcile();

      expect(store.getTask(seeded.id)?.status).toBe('active');
    });

    // R2: the operator branch of `upsertFromFile` un-pauses a row. That ARMS it,
    // so it has to carry a grant — otherwise the row is live and ungranted, and
    // the next sync parks the schedule an install just stood up. Reachable
    // through `shape-schedule-service` and through a route write over a path
    // whose file had been deleted.
    it('arms an un-paused operator write WITH a grant, not without one', async () => {
      // Never approved — which is the case that discriminates. A row that HAD
      // been approved still carries its key through a pause, so it would look
      // fine either way; a row with no grant is the one that goes live holding
      // nothing.
      const filePath = await writeSkill('shaped', scheduledSkill('shaped', { cron: '0 6 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('shaped');
      expect(store.getTask(row.id)?.status).toBe('pending_approval');

      // The file goes; the row is paused.
      await rm(filePath);
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('paused');

      // An install writes the same path again, as an operator action.
      await writeFile(filePath, scheduledSkill('shaped', { cron: '0 6 * * *' }), 'utf-8');
      const resolved = await realPath(filePath);
      store.upsertFromFile(
        {
          name: 'shaped',
          body: 'Do the thing.',
          filePath: resolved,
          dirPath: path.dirname(resolved),
          scope: 'project',
          projectPath,
          meta: {
            name: 'shaped',
            description: 'A skill named shaped',
            schedule: {
              cron: '0 6 * * *',
              timezone: 'UTC',
              enabled: true,
              sticky: false,
              permissions: 'acceptEdits',
            },
          },
        },
        AGENT_ID
      );
      expect(store.getTask(row.id)?.status).toBe('active');

      // The proof: a sync right afterwards leaves it alone. Without a grant the
      // row is live and ungranted — armed now, parked within five minutes — and
      // an install would stand up a schedule that switched itself off.
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('active');
    });

    // The park clears the grant, and that clearing is load-bearing: without it a
    // row keeps the key for content it was approved at, so editing a schedule
    // away and back again would silently re-arm it with nobody looking.
    it('does not re-arm when a drifted file is reverted to the approved content', async () => {
      const filePath = await writeSkill(
        'reverted',
        scheduledSkill('reverted', { cron: '0 6 * * *' })
      );
      await reconciler.reconcile();
      const row = rowFor('reverted');
      approve(row.id);

      // Drift to different content — the grant is withdrawn here.
      await writeFile(filePath, scheduledSkill('reverted', { cron: '0 23 * * *' }), 'utf-8');
      await reconciler.reconcile();
      expect(store.getTask(row.id)?.status).toBe('pending_approval');

      // Back to exactly what was approved. The row must NOT arm itself: the
      // approval ended when the content changed, and nobody has looked since.
      await writeFile(filePath, scheduledSkill('reverted', { cron: '0 6 * * *' }), 'utf-8');
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('pending_approval');
      expect(scheduler.isRegistered(row.id)).toBe(false);
    });

    it('gives no grant to a row that was merely parked or paused', async () => {
      await writeSkill('waiting', scheduledSkill('waiting', { cron: '0 8 * * *' }));
      await reconciler.reconcile();
      const row = rowFor('waiting');

      // Neither a parked row nor a paused one is evidence of a decision.
      expect(store.backfillApprovalGrants()).toBe(0);
      store.disableTasksByAgentId(AGENT_ID);
      expect(store.backfillApprovalGrants()).toBe(0);
      expect(store.getTask(row.id)?.status).not.toBe('active');
    });
  });

  describe('one real file is one schedule', () => {
    it('collapses a symlinked skill and its target into a single row', async () => {
      // The shape an installed marketplace plugin takes: `pkg__name` in
      // `.agents/skills/` is a symlink into `.dork/plugins/`.
      // The REAL shape Harness Sync projects: the link is NAMESPACED
      // (`pack__shared-sweep`) while the file it points at says `name:
      // shared-sweep`. Getting this wrong is what made every plugin skill parse
      // as invalid (DOR-1485 review, N2).
      const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'shared-sweep');
      await mkdir(realDir, { recursive: true });
      const realFile = path.join(realDir, 'SKILL.md');
      await writeFile(realFile, scheduledSkill('shared-sweep', { cron: '0 3 * * *' }), 'utf-8');

      // A second agent's skills root reaches the same real file by symlink.
      const otherProject = path.join(dorkHome, 'other');
      const otherSkills = agentSkillsRoot(otherProject);
      await mkdir(otherSkills, { recursive: true });
      await symlink(realDir, path.join(otherSkills, 'pack__shared-sweep'));
      await symlink(realDir, path.join(skillsDir, 'pack__shared-sweep'));
      reconciler.addRoot(skillsRoot(otherSkills, 'project', otherProject, 'agent-2'));

      await reconciler.reconcile();
      await reconciler.reconcile();

      // Two sightings through two roots, one schedule.
      expect(store.getTasks()).toHaveLength(1);
      const row = store.getTasks()[0];
      // Identity is the resolved real path, never the link that reached it.
      expect(row.filePath).toBe(await realPath(realFile));
      // First root wins the attribution, and keeps it across passes.
      expect(row.agentId).toBe(AGENT_ID);
      // The name a person reads is the skill's own, not the namespaced link.
      expect(row.name).toBe('shared-sweep');
    });

    // Uninstalling a package deletes the target; the link the watcher was
    // watching is what it reports. The row is keyed on the target, so a pause
    // that looked up the link matched nothing and the schedule kept firing for
    // a package that is no longer installed (DOR-1485 review, I3).
    it('retires a plugin schedule when its target is uninstalled', async () => {
      const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'sweep');
      await mkdir(realDir, { recursive: true });
      await writeFile(
        path.join(realDir, 'SKILL.md'),
        scheduledSkill('sweep', { cron: '0 3 * * *' }),
        'utf-8'
      );
      const link = path.join(skillsDir, 'pack__sweep');
      await symlink(realDir, link);

      await reconciler.reconcile();
      const row = rowFor('sweep');
      approve(row.id);
      expect(scheduler.isRegistered(row.id)).toBe(true);

      // The uninstall: the package's own directory goes, the link dangles.
      await rm(realDir, { recursive: true, force: true });
      await reconciler.reconcile();

      expect(store.getTask(row.id)?.status).toBe('paused');
      expect(scheduler.isRegistered(row.id)).toBe(false);
    });

    // The templates gallery is a container in the LEGACY task tree only, so a
    // skills root reserves nothing — a person may name a skill `templates` and
    // schedule it like any other.
    it('lets a skill be named templates in a skills root', async () => {
      await writeSkill('templates', scheduledSkill('templates', { cron: '0 7 * * *' }));

      await reconciler.reconcile();

      expect(rowFor('templates').cron).toBe('0 7 * * *');
    });

    it('never watches .claude/skills — the projection mirror', () => {
      const roots = [...agentTaskRoots(projectPath, AGENT_ID), ...globalTaskRoots(dorkHome)];

      expect(roots.map((r) => r.dir)).not.toContain(path.join(projectPath, '.claude', 'skills'));
      for (const root of roots) expect(root.dir).not.toContain('.claude');
      // And the one it does watch for an agent is `.agents/skills`.
      expect(roots.map((r) => r.dir)).toContain(path.join(projectPath, '.agents', 'skills'));
    });
  });

  describe('agents that register after boot', () => {
    it('discovers a schedule in a project whose agent registered late', async () => {
      // A fresh pair, as at boot: nothing knows about this project yet.
      const lateIdentities = new ScheduleIdentityRegistry();
      const lateReconciler = new TaskReconciler(store, registrar, lateIdentities);
      const lateProject = path.join(dorkHome, 'late-project');
      const lateSkills = agentSkillsRoot(lateProject);
      await mkdir(lateSkills, { recursive: true });
      await writeSkill(
        'late-riser',
        scheduledSkill('late-riser', { cron: '0 5 * * *' }),
        lateSkills
      );

      // Before registration the file is invisible — the gap this closes.
      await lateReconciler.reconcile();
      expect(store.getTasks()).toEqual([]);

      attachAgentRoots({ reconciler: lateReconciler }, lateProject, 'agent-late');
      await lateReconciler.reconcile();

      const row = rowFor('late-riser');
      expect(row.agentId).toBe('agent-late');
      expect(row.status).toBe('pending_approval');
    });

    it('does not scan a root twice when an agent is attached twice', async () => {
      const lateReconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
      await writeSkill('once-only', scheduledSkill('once-only', { cron: '0 5 * * *' }));

      attachAgentRoots({ reconciler: lateReconciler }, projectPath, AGENT_ID);
      attachAgentRoots({ reconciler: lateReconciler }, projectPath, AGENT_ID);

      // Two upserts would mean the root was scanned twice in one pass.
      await expect(lateReconciler.reconcile()).resolves.toMatchObject({ upserted: 1 });
    });
  });

  describe('the retired legacy shape', () => {
    it('ignores a file still written in the old top-level shape', async () => {
      // The clean break, stated as a test (DOR-1486, ADR `260823-200729`). The
      // unified schema drops keys it does not know, so a file with `cron:` at
      // the top level is a perfectly valid PLAIN SKILL — and a plain skill is
      // not a schedule. Nothing warns, nothing parks, no row appears.
      //
      // The boot migration is what stops this being a trap: it rewrites every
      // such file it can find before any watcher starts. What this pins is what
      // happens to one that arrives AFTERWARDS — nothing, for as long as this
      // process runs. (The next start's migration does move it: detection is by
      // location and unconditional. Not a live import path, but not a black hole
      // either — `skills-roots.ts` states the whole rule.)
      await mkdir(path.join(skillsDir, 'old-timer'), { recursive: true });
      const filePath = path.join(skillsDir, 'old-timer', 'SKILL.md');
      await writeFile(filePath, legacyTaskFile('old-timer', '0 2 * * *'), 'utf-8');

      await expect(reconciler.reconcile()).resolves.toMatchObject({ upserted: 0 });

      expect(store.getTasks()).toHaveLength(0);
    });

    it('never scans the legacy tasks directory at all', async () => {
      // Not merely "finds nothing in it" — it is not a root, so a schedule
      // written there in the NEW shape is invisible too. The person's cue is the
      // migration, which moved everything out of it on the boot it found it.
      const legacyDir = path.join(projectPath, '.dork', 'tasks');
      await mkdir(path.join(legacyDir, 'left-behind'), { recursive: true });
      await writeFile(
        path.join(legacyDir, 'left-behind', 'SKILL.md'),
        scheduledSkill('left-behind', { cron: '0 2 * * *' }),
        'utf-8'
      );

      await reconciler.reconcile();

      expect(store.getTasks()).toHaveLength(0);
    });

    // The upgrade case. Every alpha user has active rows already; they must not
    // all re-park the first time this build reads their files.
    it('leaves an already-active row alone when its file has not changed', async () => {
      await mkdir(path.join(skillsDir, 'grandfathered'), { recursive: true });
      const filePath = path.join(skillsDir, 'grandfathered', 'SKILL.md');
      await writeFile(filePath, scheduledSkill('grandfathered', { cron: '0 1 * * *' }), 'utf-8');

      // Stand in for the row an older build wrote: active, matching the file,
      // and keyed the way discovery keys one.
      const seeded = store.createTask({
        name: 'grandfathered',
        description: 'A skill named grandfathered',
        prompt: 'Do the thing.',
        cron: '0 1 * * *',
        timezone: 'UTC',
        filePath: await realPath(filePath),
      });
      expect(seeded.status).toBe('active');
      registrar.syncTask(seeded.id);

      await reconciler.reconcile();

      // Same row, still active, still on the clock — no backfill needed,
      // because the grant IS the row being active at unchanged content.
      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTask(seeded.id)?.status).toBe('active');
      expect(scheduler.isRegistered(seeded.id)).toBe(true);
    });
  });
});

/** `fs.realpath`, imported lazily so the helper reads where it is used. */
async function realPath(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}
