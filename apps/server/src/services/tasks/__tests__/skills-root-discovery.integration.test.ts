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
import { legacyRoot, skillsRoot } from './task-root-fixtures.js';
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

  describe('one real file is one schedule', () => {
    it('collapses a symlinked skill and its target into a single row', async () => {
      // The shape an installed marketplace plugin takes: `pkg__name` in
      // `.agents/skills/` is a symlink into `.dork/plugins/`.
      const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'shared-sweep');
      await mkdir(realDir, { recursive: true });
      const realFile = path.join(realDir, 'SKILL.md');
      await writeFile(realFile, scheduledSkill('shared-sweep', { cron: '0 3 * * *' }), 'utf-8');

      // A second agent's skills root reaches the same real file by symlink.
      const otherProject = path.join(dorkHome, 'other');
      const otherSkills = agentSkillsRoot(otherProject);
      await mkdir(otherSkills, { recursive: true });
      await symlink(realDir, path.join(otherSkills, 'shared-sweep'));
      await symlink(realDir, path.join(skillsDir, 'shared-sweep'));
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

  describe('legacy task directories keep working', () => {
    it('still discovers a schedule under .dork/tasks/, unchanged', async () => {
      const legacyDir = path.join(projectPath, '.dork', 'tasks');
      await mkdir(path.join(legacyDir, 'old-timer'), { recursive: true });
      const filePath = path.join(legacyDir, 'old-timer', 'SKILL.md');
      await writeFile(filePath, legacyTaskFile('old-timer', '0 2 * * *'), 'utf-8');
      reconciler.addRoot(legacyRoot(legacyDir, 'project', projectPath, AGENT_ID));

      await reconciler.reconcile();

      const row = rowFor('old-timer');
      expect(row.cron).toBe('0 2 * * *');
      // Legacy paths are NOT realpath-resolved: their rows already exist keyed
      // on the unresolved path, and resolving now would duplicate every
      // schedule belonging to anyone whose home sits under a symlink.
      expect(row.filePath).toBe(filePath);

      approve(row.id);
      expect(scheduler.getNextRun(row.id)?.getUTCHours()).toBe(2);
    });

    // The upgrade case. Every alpha user has active rows already; they must not
    // all re-park the first time this build reads their files.
    it('leaves an already-active row alone when its file has not changed', async () => {
      const legacyDir = path.join(projectPath, '.dork', 'tasks');
      await mkdir(path.join(legacyDir, 'grandfathered'), { recursive: true });
      const filePath = path.join(legacyDir, 'grandfathered', 'SKILL.md');
      await writeFile(filePath, legacyTaskFile('grandfathered', '0 1 * * *'), 'utf-8');
      reconciler.addRoot(legacyRoot(legacyDir, 'project', projectPath, AGENT_ID));

      // Stand in for the row an older build wrote: active, matching the file.
      const seeded = store.createTask({
        name: 'grandfathered',
        description: 'A task named grandfathered',
        prompt: 'Do the thing.',
        cron: '0 1 * * *',
        timezone: 'UTC',
        filePath,
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
