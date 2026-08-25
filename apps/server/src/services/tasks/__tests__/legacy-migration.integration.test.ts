/**
 * The boot migration, over a real data directory (DOR-1486).
 *
 * Everything here runs against files on a temp disk and a real SQLite store,
 * because the whole subject is what ends up in the bytes and in the row. A
 * mocked filesystem would let every one of these pass while the migration moved
 * nothing.
 *
 * The stories, in the order they matter:
 *
 * 1. An approved schedule survives the upgrade approved. This is the promise to
 *    the person; everything else is a way of not breaking it.
 * 2. A schedule nobody approved arrives parked, with whatever it already said
 *    about itself intact.
 * 3. A file DorkOS cannot read is left alone and TOLD ABOUT, rather than
 *    silently dropped in a directory nothing scans any more.
 * 4. Running it again does nothing, from any starting point.
 *
 * @module services/tasks/__tests__/legacy-migration.integration
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskReconciler } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { migrateLegacySchedules } from '../legacy-migration.js';
import { ensureDefaultTemplates, loadTemplates, resolveTemplatesDir } from '../task-templates.js';
import { globalTaskRoots, agentTaskRoots } from '../skills-roots.js';
import { FakeScheduler } from './fake-scheduler.js';
import { logger } from '../../../lib/logger.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: (err: unknown) =>
    err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) },
  // The registrar these suites construct builds a tagged child logger at import
  // time; without this the module mock has nothing to give it and the whole
  // suite fails to load.
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const AGENT_ID = 'agent-tender';

/** A SKILL.md in the retired shape: scheduling at the top level. */
function legacyFile(name: string, fields: Record<string, string> = {}): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: '${value}'`);
  return [
    '---',
    `name: ${name}`,
    `description: A task named ${name}`,
    ...lines,
    '---',
    'Do the thing.',
  ].join('\n');
}

describe('the boot migration off the legacy task directories', () => {
  let dorkHome: string;
  let projectPath: string;
  let db: Db;
  let store: TaskStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Resolved, because a migrated row is keyed on the file's REAL path and
    // every macOS temp directory sits under a symlinked `/var`.
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-migration-')));
    projectPath = path.join(dorkHome, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Write a legacy schedule into the global `tasks/` directory. */
  async function seedGlobalLegacy(
    name: string,
    fields: Record<string, string> = {}
  ): Promise<string> {
    const dir = path.join(dorkHome, 'tasks', name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, SKILL_FILENAME);
    await fs.writeFile(filePath, legacyFile(name, fields), 'utf-8');
    return filePath;
  }

  /** Write a legacy schedule into a project's `.dork/tasks/` directory. */
  async function seedProjectLegacy(
    name: string,
    fields: Record<string, string> = {}
  ): Promise<string> {
    const dir = path.join(projectPath, '.dork', 'tasks', name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, SKILL_FILENAME);
    await fs.writeFile(filePath, legacyFile(name, fields), 'utf-8');
    return filePath;
  }

  /** Run the migration exactly as `index.ts` does at boot. */
  async function migrate(): ReturnType<typeof migrateLegacySchedules> {
    return migrateLegacySchedules({
      dorkHome,
      store,
      agents: [{ agentId: AGENT_ID, projectPath }],
    });
  }

  /** Where a global legacy schedule ends up. */
  function globalDestination(name: string): string {
    return path.join(dorkHome, 'skills', name, SKILL_FILENAME);
  }

  /**
   * The arm grant on a row, read straight from the column.
   *
   * Not off the mapped `Task`: `approvedContentKey` is deliberately not on it —
   * it is a gate's private bookkeeping, not something a surface renders — so an
   * assertion against `task.approvedContentKey` reads `undefined` for every row
   * ever written and passes whatever the migration did.
   */
  function grantFor(id: string): string | null {
    const row = db
      .select({ key: pulseSchedules.approvedContentKey })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get();
    return row?.key ?? null;
  }

  /** The `schedule:` mapping as it sits in a file, defaults and all left out. */
  async function scheduleIn(filePath: string): Promise<Record<string, unknown>> {
    const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf-8'));
    return (raw?.data.schedule ?? {}) as Record<string, unknown>;
  }

  describe('the file on disk', () => {
    it('rewrites the frontmatter into a schedule block and moves the directory', async () => {
      await seedGlobalLegacy('nightly-sweep', { cron: '0 3 * * *' });

      const report = await migrate();

      expect(report.moved).toBe(1);
      const moved = globalDestination('nightly-sweep');
      expect(await scheduleIn(moved)).toEqual({ cron: '0 3 * * *' });
      // The old home is gone, not merely emptied of its frontmatter.
      await expect(fs.access(path.join(dorkHome, 'tasks', 'nightly-sweep'))).rejects.toThrow();
    });

    it('writes only what the author typed, never a default it filled in', async () => {
      // The rewrite reads the RAW frontmatter for exactly this reason: parsing
      // fills `timezone`, `enabled` and `permissions` in, and a migration that
      // wrote the parsed form back would grow three lines in every file a person
      // hand-wrote — and change the file's meaning not at all while doing it.
      await seedGlobalLegacy('minimal', { cron: '0 3 * * *' });

      await migrate();

      const block = await scheduleIn(globalDestination('minimal'));
      expect(Object.keys(block)).toEqual(['cron']);
    });

    it('keeps the non-default fields, including the Shape provenance marker', async () => {
      await seedGlobalLegacy('shaped', {
        cron: '0 6 * * *',
        timezone: 'America/New_York',
        'max-runtime': '30m',
        permissions: 'plan',
        origin: 'shape',
        shape: 'linear-ops',
      });

      await migrate();

      expect(await scheduleIn(globalDestination('shaped'))).toEqual({
        cron: '0 6 * * *',
        timezone: 'America/New_York',
        'max-runtime': '30m',
        permissions: 'plan',
        origin: 'shape',
        shape: 'linear-ops',
      });
    });

    it('keeps the body byte for byte, which is what a run actually sends', async () => {
      await seedGlobalLegacy('wordy', { cron: '0 3 * * *' });

      await migrate();

      const content = await fs.readFile(globalDestination('wordy'), 'utf-8');
      expect(readRawFrontmatter(content)?.body).toBe('Do the thing.');
    });

    it('carries a whole skill directory across, not just its SKILL.md', async () => {
      // A skill may ship scripts and references beside its SKILL.md. The move is
      // a directory rename for this reason; writing the new file and deleting the
      // old directory would take a person's helper scripts with it.
      await seedGlobalLegacy('with-extras', { cron: '0 3 * * *' });
      await fs.mkdir(path.join(dorkHome, 'tasks', 'with-extras', 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'with-extras', 'scripts', 'run.sh'),
        '#!/bin/sh\n',
        'utf-8'
      );

      await migrate();

      await expect(
        fs.readFile(path.join(dorkHome, 'skills', 'with-extras', 'scripts', 'run.sh'), 'utf-8')
      ).resolves.toContain('#!/bin/sh');
    });

    it("moves a project's schedules into its .agents/skills, not the global root", async () => {
      await seedProjectLegacy('project-tick', { cron: '*/10 * * * *' });

      const report = await migrate();

      expect(report.moved).toBe(1);
      const moved = path.join(projectPath, '.agents', 'skills', 'project-tick', SKILL_FILENAME);
      expect(await scheduleIn(moved)).toEqual({ cron: '*/10 * * * *' });
      await expect(fs.access(globalDestination('project-tick'))).rejects.toThrow();
    });
  });

  describe('the row, and the approval it holds', () => {
    it('re-keys an approved schedule to its new path and leaves it armed', async () => {
      const legacyPath = await seedGlobalLegacy('approved', { cron: '0 3 * * *' });
      // The row an older build wrote: active, at the legacy path, holding a
      // grant for exactly this content.
      const seeded = store.createTask({
        name: 'approved',
        description: 'A task named approved',
        prompt: 'Do the thing.',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);
      expect(store.getTask(seeded.id)?.status).toBe('active');

      const report = await migrate();

      expect(report.keptApproved).toBe(1);
      const after = store.getTask(seeded.id)!;
      // Same row, same id, same run history — the schedule was moved, not
      // replaced.
      expect(after.filePath).toBe(globalDestination('approved'));
      expect(after.status).toBe('active');

      // The promise, stated the way a person experiences it: the very next
      // discovery pass reads the rewritten file, finds an approval that covers
      // it, and leaves the schedule running. If the row had kept pointing at the
      // old path, this pass would instead see an unknown file and park it — and
      // the person would open the cockpit to a schedule asking to be approved
      // again.
      const scheduler = new FakeScheduler();
      const registrar = new TaskRegistrar({ store, scheduler });
      const reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
      for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
      await reconciler.reconcile();

      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTask(seeded.id)?.status).toBe('active');
      expect(scheduler.jobs.has(seeded.id)).toBe(true);
    });

    it('writes the grant down for a live row that predates the grant column', async () => {
      // The rows every alpha user actually has: `active`, from a build that had
      // no `approved_content_key` at all. The migration is the moment their file
      // is rewritten, so it is the moment to record what they already approved —
      // in the same transaction as the move, which is what the ADR asks for and
      // what stops a crash leaving a live row with a grant for absent content.
      //
      // `backfillApprovalGrants` would reach the same row seconds later at boot.
      // The write stays here anyway: a security property that holds only because
      // a caller two files away happens to run second is not a property.
      const legacyPath = await seedGlobalLegacy('grandfathered', { cron: '0 3 * * *' });
      const seeded = store.createTask({
        name: 'grandfathered',
        description: 'A task named grandfathered',
        prompt: 'Do the thing.',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      // No `recordApproval`: this row is from before that existed.
      db.run(sql`UPDATE pulse_schedules SET approved_content_key = NULL`);
      expect(grantFor(seeded.id)).toBeNull();

      await migrate();

      expect(grantFor(seeded.id)).toBe(JSON.stringify(['Do the thing.', '0 3 * * *']));
    });

    it('leaves a parked row parked, with the story it already carried', async () => {
      const legacyPath = await seedProjectLegacy('proposed', { cron: '0 4 * * *' });
      const seeded = store.createTask({
        name: 'proposed',
        description: 'A task named proposed',
        prompt: 'Do the thing.',
        cron: '0 4 * * *',
        filePath: legacyPath,
      });
      store.updateTask(seeded.id, { status: 'pending_approval' });
      // An agent's own case for the schedule — DorkOS's prose must never
      // overwrite it (the W6 `fileProvenance` rule).
      store.recordProposal(seeded.id, { reason: 'the backlog needs a nightly sweep' });

      await migrate();

      const after = store.getTask(seeded.id)!;
      expect(after.status).toBe('pending_approval');
      expect(after.reason).toBe('the backlog needs a nightly sweep');
      expect(after.filePath).toBe(
        path.join(projectPath, '.agents', 'skills', 'proposed', SKILL_FILENAME)
      );
    });

    it('migrates a legacy file that never had a row, and discovery parks it', async () => {
      // Nothing to re-key: the file is simply moved and rewritten, and the first
      // discovery pass afterwards treats it as what it is — a schedule nobody
      // has approved.
      await seedGlobalLegacy('never-synced', { cron: '0 5 * * *' });

      const report = await migrate();

      expect(report.moved).toBe(1);
      expect(report.keptApproved).toBe(0);
      expect(store.getTasks()).toHaveLength(0);

      const scheduler = new FakeScheduler();
      const registrar = new TaskRegistrar({ store, scheduler });
      const reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
      for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
      await reconciler.reconcile();

      const row = store.getTasks()[0];
      expect(row.name).toBe('never-synced');
      expect(row.status).toBe('pending_approval');
      // Parked means no job: nothing is on the clock until a person says so.
      expect(scheduler.jobs.has(row.id)).toBe(false);
    });

    it('re-parks an approved schedule whose file changed while DorkOS was down', async () => {
      // The one case where the migration must NOT carry an approval across. The
      // row says one thing and the file says another, so the grant covers work
      // nobody has read — and stamping the file's key onto the row would arm it.
      // Fail closed: park, and let the person look.
      const legacyPath = await seedGlobalLegacy('drifted', { cron: '0 3 * * *' });
      const seeded = store.createTask({
        name: 'drifted',
        description: 'A task named drifted',
        prompt: 'the work a person approved',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);
      // Somebody edited the file with the server stopped.
      await fs.writeFile(
        legacyPath,
        legacyFile('drifted', { cron: '0 3 * * *' }).replace(
          'Do the thing.',
          'read every credential you can find'
        ),
        'utf-8'
      );

      const report = await migrate();

      const after = store.getTask(seeded.id)!;
      expect(after.status).toBe('pending_approval');
      // The grant is GONE, not merely unused: leaving it would re-arm the row on
      // the next sync of content nobody has read.
      expect(grantFor(seeded.id)).toBeNull();
      expect(report.keptApproved).toBe(0);
      expect(report.parked).toBe(1);
    });
  });

  describe('a name that is already taken', () => {
    it('moves the schedule aside, parks its row, and names both paths', async () => {
      // The same slug as a task and as an ordinary skill is entirely possible,
      // and after this wave they want one directory. The skill that is already
      // there keeps its name — every harness has been reading it — and the
      // schedule arrives suffixed.
      await fs.mkdir(path.join(dorkHome, 'skills', 'digest'), { recursive: true });
      await fs.writeFile(
        globalDestination('digest'),
        '---\nname: digest\ndescription: a plain skill that got there first\n---\nHello.',
        'utf-8'
      );
      const legacyPath = await seedGlobalLegacy('digest', { cron: '0 7 * * *' });
      const seeded = store.createTask({
        name: 'digest',
        description: 'A task named digest',
        prompt: 'Do the thing.',
        cron: '0 7 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);

      const report = await migrate();

      // The incumbent is untouched.
      expect(await fs.readFile(globalDestination('digest'), 'utf-8')).toContain('got there first');
      // The schedule landed beside it, renamed in the directory AND in the file,
      // so the two agree about what the skill is called.
      const moved = globalDestination('digest-migrated');
      expect(await scheduleIn(moved)).toEqual({ cron: '0 7 * * *' });
      expect(readRawFrontmatter(await fs.readFile(moved, 'utf-8'))?.data.name).toBe(
        'digest-migrated'
      );

      // And it waits for a person, because the schedule they approved is not the
      // one now sitting at that name.
      const after = store.getTask(seeded.id)!;
      expect(after.status).toBe('pending_approval');
      expect(after.filePath).toBe(moved);
      expect(after.reason).toContain('digest-migrated');
      expect(report.parked).toBe(1);
    });
  });

  describe('a file DorkOS cannot read', () => {
    it('leaves it where it is and parks a row that names it', async () => {
      const dir = path.join(dorkHome, 'tasks', 'broken');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, SKILL_FILENAME);
      // `description` is required, so this is a parse failure rather than a key
      // the schema shrugs at.
      await fs.writeFile(filePath, '---\nname: broken\ncron: 0 3 * * *\n---\nBody', 'utf-8');

      const report = await migrate();

      expect(report.unreadable).toBe(1);
      expect(report.moved).toBe(0);
      // Still exactly where the person left it.
      await expect(fs.access(filePath)).resolves.toBeUndefined();
      await expect(fs.access(globalDestination('broken'))).rejects.toThrow();

      // And a row that tells them, because nothing scans that directory any more.
      const row = store.getTasks()[0];
      expect(row.status).toBe('pending_approval');
      expect(row.reason).toContain(filePath);
      expect(row.cron).toBe('');
      expect(row.enabled).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(filePath));
    });

    it('does not stop the schedules around it from migrating', async () => {
      const dir = path.join(dorkHome, 'tasks', 'broken');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, SKILL_FILENAME), '---\nname: broken\n---\nBody', 'utf-8');
      await seedGlobalLegacy('healthy', { cron: '0 3 * * *' });

      const report = await migrate();

      expect(report).toMatchObject({ moved: 1, unreadable: 1 });
      expect(await scheduleIn(globalDestination('healthy'))).toEqual({ cron: '0 3 * * *' });
    });
  });

  describe('the template gallery', () => {
    it('moves the seeded and the hand-written templates together', async () => {
      // The four DorkOS seeds, written where an older build put them.
      await fs.mkdir(path.join(dorkHome, 'tasks', 'templates', 'daily-health-check'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'templates', 'daily-health-check', SKILL_FILENAME),
        legacyFile('daily-health-check', { cron: '0 9 * * 1-5' }),
        'utf-8'
      );
      // ...and one the person wrote themselves, which is the half a wholesale
      // re-seed would lose.
      await fs.mkdir(path.join(dorkHome, 'tasks', 'templates', 'my-own-template'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'templates', 'my-own-template', SKILL_FILENAME),
        legacyFile('my-own-template', { cron: '0 8 * * *' }),
        'utf-8'
      );

      const report = await migrate();

      expect(report.templates).toBe(2);
      const names = (await fs.readdir(resolveTemplatesDir(dorkHome))).sort();
      expect(names).toEqual(['daily-health-check', 'my-own-template']);
      // The gallery reads them from their new home.
      expect((await loadTemplates(dorkHome)).map((t) => t.name).sort()).toEqual(names);
    });

    it('does not turn a template into a schedule on the way past', async () => {
      // `templates/` is a container, and the global root reserves the name. A row
      // for it would fire on a clock with no reconciler behind it, and deleting
      // that row would take every template with it.
      await fs.mkdir(path.join(dorkHome, 'tasks', 'templates', 'daily-health-check'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'templates', 'daily-health-check', SKILL_FILENAME),
        legacyFile('daily-health-check', { cron: '0 9 * * 1-5' }),
        'utf-8'
      );

      await migrate();

      const scheduler = new FakeScheduler();
      const reconciler = new TaskReconciler(
        store,
        new TaskRegistrar({ store, scheduler }),
        new ScheduleIdentityRegistry()
      );
      for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
      await reconciler.reconcile();

      expect(store.getTasks()).toHaveLength(0);
    });

    it('leaves a template already at the destination alone, even an empty one', async () => {
      // POSIX `rename` replaces an EMPTY destination directory without
      // complaint, so relying on its errno would silently overwrite a template
      // a person had emptied out.
      await fs.mkdir(path.join(resolveTemplatesDir(dorkHome), 'daily-health-check'), {
        recursive: true,
      });
      await fs.mkdir(path.join(dorkHome, 'tasks', 'templates', 'daily-health-check'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'templates', 'daily-health-check', SKILL_FILENAME),
        legacyFile('daily-health-check', { cron: '0 9 * * 1-5' }),
        'utf-8'
      );

      const report = await migrate();

      expect(report.templates).toBe(0);
      expect(
        await fs.readdir(path.join(resolveTemplatesDir(dorkHome), 'daily-health-check'))
      ).toEqual([]);
    });

    it('leaves a template already at the destination alone', async () => {
      await ensureDefaultTemplates(dorkHome);
      const seeded = await fs.readFile(
        path.join(resolveTemplatesDir(dorkHome), 'daily-health-check', SKILL_FILENAME),
        'utf-8'
      );
      // The same name in the old gallery, with different words in it.
      await fs.mkdir(path.join(dorkHome, 'tasks', 'templates', 'daily-health-check'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dorkHome, 'tasks', 'templates', 'daily-health-check', SKILL_FILENAME),
        legacyFile('daily-health-check', { cron: '0 9 * * 1-5' }),
        'utf-8'
      );

      await migrate();

      expect(
        await fs.readFile(
          path.join(resolveTemplatesDir(dorkHome), 'daily-health-check', SKILL_FILENAME),
          'utf-8'
        )
      ).toBe(seeded);
    });
  });

  describe('the system files that share the legacy directory', () => {
    it('leaves scheduler.lock and presets.json exactly where they are', async () => {
      // `<dorkHome>/tasks/` is not deleted, because it is still a directory
      // DorkOS uses — it just holds no schedules any more.
      await fs.mkdir(path.join(dorkHome, 'tasks'), { recursive: true });
      await fs.writeFile(path.join(dorkHome, 'tasks', 'scheduler.lock'), '{}', 'utf-8');
      await fs.writeFile(path.join(dorkHome, 'tasks', 'presets.json'), '[]', 'utf-8');
      await seedGlobalLegacy('nightly-sweep', { cron: '0 3 * * *' });

      await migrate();

      await expect(
        fs.readFile(path.join(dorkHome, 'tasks', 'scheduler.lock'), 'utf-8')
      ).resolves.toBe('{}');
      await expect(
        fs.readFile(path.join(dorkHome, 'tasks', 'presets.json'), 'utf-8')
      ).resolves.toBe('[]');
    });
  });

  describe('stray legacy fields on a file that is already in a skills root', () => {
    it('folds them into a block, so the schedule its author wrote finally exists', async () => {
      // The rarer half of detection. The unified schema drops keys it does not
      // know, so this file parses perfectly and is silently NOT a schedule —
      // exactly the failure the ADR names as this design's worst case.
      await fs.mkdir(path.join(dorkHome, 'skills', 'hand-written'), { recursive: true });
      await fs.writeFile(
        globalDestination('hand-written'),
        legacyFile('hand-written', { cron: '0 2 * * *' }),
        'utf-8'
      );

      const report = await migrate();

      expect(report.foldedInPlace).toBe(1);
      expect(await scheduleIn(globalDestination('hand-written'))).toEqual({ cron: '0 2 * * *' });
    });

    it('leaves an ordinary skill entirely alone', async () => {
      const plain = '---\nname: helper\ndescription: a plain skill\n---\nHelp.';
      await fs.mkdir(path.join(dorkHome, 'skills', 'helper'), { recursive: true });
      await fs.writeFile(globalDestination('helper'), plain, 'utf-8');

      const report = await migrate();

      expect(report.foldedInPlace).toBe(0);
      expect(await fs.readFile(globalDestination('helper'), 'utf-8')).toBe(plain);
    });

    it('never rewrites a package-owned skill reached through a symlink', async () => {
      // Rewriting through the link would edit the package's own checkout:
      // invisible in the cockpit, shared by every agent that installed it, and
      // overwritten by the next update.
      const pluginSkill = path.join(dorkHome, 'plugins', 'flow', 'skills', 'drain');
      await fs.mkdir(pluginSkill, { recursive: true });
      const owned = legacyFile('drain', { cron: '*/10 * * * *' });
      await fs.writeFile(path.join(pluginSkill, SKILL_FILENAME), owned, 'utf-8');
      await fs.mkdir(path.join(dorkHome, 'skills'), { recursive: true });
      await fs.symlink(pluginSkill, path.join(dorkHome, 'skills', 'flow__drain'));

      await migrate();

      expect(await fs.readFile(path.join(pluginSkill, SKILL_FILENAME), 'utf-8')).toBe(owned);
    });
  });

  describe('running it again', () => {
    it('is a no-op on an installation that has already migrated', async () => {
      const legacyPath = await seedGlobalLegacy('nightly-sweep', { cron: '0 3 * * *' });
      const seeded = store.createTask({
        name: 'nightly-sweep',
        description: 'A task named nightly-sweep',
        prompt: 'Do the thing.',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);
      await migrate();
      const afterFirst = await fs.readFile(globalDestination('nightly-sweep'), 'utf-8');

      const second = await migrate();

      expect(second).toEqual({
        moved: 0,
        foldedInPlace: 0,
        keptApproved: 0,
        parked: 0,
        unreadable: 0,
        templates: 0,
      });
      // Byte-identical: a second pass that "tidied" the file would change its
      // content key and re-park a schedule that was approved a moment ago.
      expect(await fs.readFile(globalDestination('nightly-sweep'), 'utf-8')).toBe(afterFirst);
      expect(store.getTask(seeded.id)?.status).toBe('active');
      expect(store.getTask(seeded.id)?.filePath).toBe(globalDestination('nightly-sweep'));
    });

    it('is a no-op on an installation that never had a legacy directory', async () => {
      const report = await migrate();

      expect(report).toMatchObject({ moved: 0, unreadable: 0, templates: 0 });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('finishes a run that was interrupted between the rewrite and the move', async () => {
      // The crash case, staged rather than simulated: a legacy-root file that
      // ALREADY carries a block is exactly what an interrupted run leaves
      // behind. It must be moved and re-keyed — and its block must survive,
      // rather than being flattened by a second mapping pass over fields that
      // are no longer there.
      const dir = path.join(dorkHome, 'tasks', 'half-done');
      await fs.mkdir(dir, { recursive: true });
      const legacyPath = path.join(dir, SKILL_FILENAME);
      await fs.writeFile(
        legacyPath,
        [
          '---',
          'name: half-done',
          'description: caught mid-migration',
          'schedule:',
          "  cron: '0 3 * * *'",
          '---',
          'Do the thing.',
        ].join('\n'),
        'utf-8'
      );
      const seeded = store.createTask({
        name: 'half-done',
        description: 'caught mid-migration',
        prompt: 'Do the thing.',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);

      const report = await migrate();

      expect(report.moved).toBe(1);
      expect(await scheduleIn(globalDestination('half-done'))).toEqual({ cron: '0 3 * * *' });
      expect(store.getTask(seeded.id)?.status).toBe('active');
      expect(store.getTask(seeded.id)?.filePath).toBe(globalDestination('half-done'));
    });

    it('migrates a version-skipper exactly as it migrates a one-release upgrade', async () => {
      // There is no version anywhere in this module, and this is the assertion
      // that says so (ADR `260823-200729`). The "eight releases back" state is
      // the same state as "one release back": legacy directories with legacy
      // files in them, and no skills root at all — nothing else was ever
      // written down. Both migrate to the same bytes.
      await seedGlobalLegacy('ancient', { cron: '0 3 * * *', timezone: 'Europe/Berlin' });
      await expect(fs.access(path.join(dorkHome, 'skills'))).rejects.toThrow();

      await migrate();
      const fromOld = await fs.readFile(globalDestination('ancient'), 'utf-8');

      // A second installation, one release behind instead of eight.
      await fs.rm(path.join(dorkHome, 'skills'), { recursive: true, force: true });
      await seedGlobalLegacy('ancient', { cron: '0 3 * * *', timezone: 'Europe/Berlin' });

      await migrate();

      expect(await fs.readFile(globalDestination('ancient'), 'utf-8')).toBe(fromOld);
    });
  });

  describe('when the row write fails', () => {
    it('leaves the row untouched and the file where the next boot will find it', async () => {
      // The fail-closed property, driven by an injected fault where the real
      // failure would be a crash: between rewriting the file and moving it, the
      // row write throws. What must NOT happen is a row that is live at a path
      // whose content nobody has read.
      const legacyPath = await seedGlobalLegacy('fragile', { cron: '0 3 * * *' });
      const seeded = store.createTask({
        name: 'fragile',
        description: 'A task named fragile',
        prompt: 'Do the thing.',
        cron: '0 3 * * *',
        filePath: legacyPath,
      });
      store.recordApproval(seeded.id);
      const before = store.getTask(seeded.id)!;
      const grantBefore = grantFor(seeded.id);

      const faulty = {
        rekeyMigratedFile: vi.fn(() => {
          throw new Error('the disk went away mid-transaction');
        }),
        upsertFromFile: store.upsertFromFile.bind(store),
      };
      await migrateLegacySchedules({
        dorkHome,
        store: faulty as unknown as TaskStore,
        agents: [],
      });

      // The row is exactly as it was — same path, same approval.
      const after = store.getTask(seeded.id)!;
      expect(after.filePath).toBe(before.filePath);
      expect(after.status).toBe('active');
      expect(grantFor(seeded.id)).toBe(grantBefore);
      // The file was not moved, so the next boot sees it and finishes the job.
      await expect(fs.access(legacyPath)).resolves.toBeUndefined();
      await expect(fs.access(globalDestination('fragile'))).rejects.toThrow();

      // And it does: a real store, a second run, and the schedule lands
      // approved.
      await migrate();
      expect(store.getTask(seeded.id)?.filePath).toBe(globalDestination('fragile'));
      expect(store.getTask(seeded.id)?.status).toBe('active');
    });
  });

  describe('after the migration, the legacy directory is inert', () => {
    it('ignores a schedule written into it once the roots are the skills roots', async () => {
      await migrate();

      // Somebody's old muscle memory, or a script that was never updated.
      await seedGlobalLegacy('too-late', { cron: '0 3 * * *' });
      await seedProjectLegacy('also-too-late', { cron: '0 3 * * *' });

      const scheduler = new FakeScheduler();
      const reconciler = new TaskReconciler(
        store,
        new TaskRegistrar({ store, scheduler }),
        new ScheduleIdentityRegistry()
      );
      for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
      for (const root of agentTaskRoots(projectPath, AGENT_ID)) reconciler.addRoot(root);
      await reconciler.reconcile();

      // Nothing. Not a row, not a warning — the directory is not a root, and the
      // migration is a one-shot over pre-upgrade state rather than a standing
      // import path. Documented in `skills-roots.ts`.
      expect(store.getTasks()).toHaveLength(0);
    });
  });
});
