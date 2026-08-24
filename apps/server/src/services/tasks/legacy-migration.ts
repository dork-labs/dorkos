/**
 * Moving every schedule written in the old shape onto the new one, once, on the
 * boot that finds it.
 *
 * ## What this is
 *
 * Before DOR-1485 a scheduled task was a SKILL.md in a blessed directory
 * (`<dorkHome>/tasks/`, `<project>/.dork/tasks/`) with its scheduling fields at
 * the TOP level of the frontmatter. Now it is any skill carrying a `schedule:`
 * block, anywhere the skills roots reach (ADR `260823-200724`). This module is
 * the bridge between those two worlds, and it is the ONLY thing in the codebase
 * that still knows the old one exists: the legacy schema and the mapping onto
 * the block are private to this file, so deleting the file deletes the legacy
 * shape entirely.
 *
 * ## How it decides to run
 *
 * On STATE, never on a version (ADR `260823-200729`). There is no stored "last
 * migrated version", no release gate, and nothing that has to be passed through:
 * it looks for legacy state, and when there is none — the ordinary case after
 * the first boot — it reads two directories that are not there and returns.
 * Someone upgrading from eight releases back hits exactly the same detector as
 * someone upgrading from the last one, which is the property that matters for a
 * pre-launch alpha where nobody can be told which release to install first.
 *
 * Two kinds of legacy state:
 *
 * 1. **A legacy root with skills in it** — a `SKILL.md` one level down inside
 *    `<dorkHome>/tasks/` or `<project>/.dork/tasks/`, for every registered
 *    agent. Everything in one of those was a schedule by virtue of where it sat.
 * 2. **A skills-root file carrying top-level task fields** — rare, and invisible
 *    without looking at the RAW frontmatter, because the unified schema simply
 *    drops keys it does not know. Such a file is a schedule its author believes
 *    in and DorkOS ignores.
 *
 * ## Order, and why it is load-bearing
 *
 * Runs at boot BEFORE the watcher and reconciler start, and BEFORE
 * `TaskStore.backfillApprovalGrants`. The first is obvious — discovery must not
 * race a file being rewritten under it. The second is subtler: the backfill
 * writes a grant for every already-live row from the row's own content, so it
 * has to see the final state of the migration, not the middle of it.
 *
 * ## Crash safety
 *
 * Per file, in this order: rewrite the SKILL.md in place, re-key the row, move
 * the directory. Every interruption lands on a state the NEXT boot detects and
 * finishes, because the file stays in the legacy root until the last step:
 *
 * - crashed after the rewrite → a legacy-root file that already has a block.
 *   Detected, not rewritten again, re-keyed and moved.
 * - crashed after the re-key → same detection; the re-key finds no row at the
 *   old path (it already moved) and says so; the move completes.
 * - crashed after the move → nothing left to detect. A second run is a no-op,
 *   which is also what makes running this on every boot free.
 *
 * The re-key itself is one transaction that either moves the row and keeps its
 * approval or does neither ({@link TaskStore.rekeyMigratedFile}). The direction
 * of every failure is the same: a schedule parks and waits for a person. Nothing
 * here can arm something nobody has read.
 *
 * ## SUNSET — delete this module, and its test, when either is true
 *
 * - **2027-02** (six months after ship), or
 * - **v1.0**, whichever comes first.
 *
 * Tracked by DOR-1491. At removal, the release notes state the MIGRATION FLOOR:
 * "coming from a version older than the one that shipped this? Install the
 * shipping version once, start it, then upgrade." After that, an install that
 * skipped the entire window keeps its legacy files where they are — they park
 * with a warning instead of migrating, and a person moves them by hand.
 *
 * @module services/tasks/legacy-migration
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ScheduleBlockSchema,
  TASK_PERMISSION_MODES,
  type ScheduleBlock,
  type SkillFrontmatter,
} from '@dorkos/skills';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { scheduleToFrontmatter } from '@dorkos/skills/schedule-schema';
import { DurationSchema } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { writeSkillFile } from '@dorkos/skills/writer';
import type { TaskStore } from './task-store.js';
import { agentSkillsRoot, globalSkillsRoot, resolveRootPath } from './skills-roots.js';
import { TASK_TEMPLATES_DIRNAME, resolveTemplatesDir } from './task-templates.js';
import { logger } from '../../lib/logger.js';

/**
 * The legacy scheduling fields: what a task file carried at the TOP level.
 *
 * A private copy of the half of `TaskFrontmatterSchema` that this module
 * actually relocates. It is private because keeping it exported kept it
 * reachable, and a shape two modules can read is a shape that grows a third
 * reader — the dual-parser world ADR `260823-200729` rejected. Nothing outside
 * this file may parse it, and when this file goes the shape goes with it.
 *
 * **It covers the scheduling fields only, and the base skill fields are checked
 * separately** ({@link readsAsSkill}). Not a shortcut: `@dorkos/skills` is on
 * zod v3 and this app is on v4, and nesting a v3 `ZodType` inside a v4
 * `z.object()` misbehaves silently rather than erroring (the boundary
 * `schedule-schema.ts` documents). Extending the v3 base schema here would be
 * exactly that mistake, so the two halves are asked one at a time — a runtime
 * `safeParse` call across the versions is fine; composing the schemas is not.
 *
 * Loose where the old shape was loose, deliberately. `cron: ''` was accepted
 * then, so it is accepted here; {@link legacyTaskToSchedule} is what turns it
 * into the absent cron the block schema requires.
 */
const LegacyScheduleFieldsSchema = z.object({
  /** Cron expression for scheduling. Absent means on-demand only. */
  cron: z.string().optional(),
  /** IANA timezone for cron evaluation. */
  timezone: z.string().default('UTC'),
  /** Whether the task is active. Disabled tasks are not scheduled. */
  enabled: z.boolean().default(true),
  /**
   * Maximum execution time, as `30s` / `10m` / `2h30m`.
   *
   * Delegated to `@dorkos/skills`' own `DurationSchema` by CALLING it, for the
   * version reason above — one rule, asked across the boundary rather than
   * copied over it.
   */
  'max-runtime': z
    .string()
    .refine((value) => DurationSchema.safeParse(value).success, {
      message: 'Expected a duration like 30s, 10m or 2h30m',
    })
    .optional(),
  /** Agent permission mode during task execution. */
  permissions: z.enum(TASK_PERMISSION_MODES).default('acceptEdits'),
  /** Provenance: `shape` = stood up by a Shape apply (DOR-355). */
  origin: z.enum(['shape']).optional(),
  /** The Shape (package name) that created this task. */
  shape: z.string().optional(),
});

/** The legacy scheduling fields, as parsed. */
type LegacyScheduleFields = z.infer<typeof LegacyScheduleFieldsSchema>;

/**
 * Whether this frontmatter is a readable SKILL.md at all, quite apart from its
 * schedule.
 *
 * The other half of "can DorkOS read this file". A legacy task whose `name` or
 * `description` the skill schema rejects will be rejected by discovery too the
 * moment it lands in a skills root — and it would land there silently, with no
 * row and no message. Asking here instead means the person gets told.
 *
 * @param data - Raw frontmatter.
 */
function readsAsSkill(data: Record<string, unknown>): boolean {
  return SkillFrontmatterSchema.safeParse(data).success;
}

/**
 * The top-level keys the migration relocates into the block.
 *
 * `display-name` is deliberately absent: it belongs to the SKILL and lives on
 * the base schema now, so it stays exactly where it is.
 */
const LEGACY_TOP_LEVEL_FIELDS = [
  'cron',
  'timezone',
  'enabled',
  'max-runtime',
  'permissions',
  'origin',
  'shape',
] as const;

/**
 * The keys whose presence in a SKILLS root means "this file was written in the
 * old shape".
 *
 * A narrower set than {@link LEGACY_TOP_LEVEL_FIELDS}, and narrower on purpose.
 * In a legacy root, location alone says the file is a schedule, so every field
 * comes along. In a skills root there is no location to go on and a false
 * positive is expensive — it turns an ordinary skill into a schedule that parks
 * and asks a person about itself. `enabled:` and `timezone:` are words an
 * unrelated skill can plausibly carry; `cron`, `max-runtime` and `permissions`
 * together with nothing else to explain them are not.
 */
const LEGACY_SIGNAL_FIELDS = ['cron', 'max-runtime', 'permissions'] as const;

/** The legacy global tasks root: `~/.dork/tasks/`. Gone with this module. */
function legacyGlobalTasksRoot(dorkHome: string): string {
  return path.join(dorkHome, 'tasks');
}

/** An agent's legacy tasks root: `<projectPath>/.dork/tasks/`. Gone with this module. */
function legacyAgentTasksRoot(projectPath: string): string {
  return path.join(projectPath, '.dork', 'tasks');
}

/**
 * Map a legacy file's top-level scheduling fields onto the block that replaces
 * them.
 *
 * Total and side-effect free — it never throws and never reads disk. Three
 * mappings are worth knowing:
 *
 * - **An empty `cron` becomes absent.** The legacy schema accepted `cron: ''`;
 *   the block does not, and both spellings mean the same thing — on-demand,
 *   nothing on a clock.
 * - **`display-name` does not move.** It belongs to the skill, not its schedule.
 * - **No `prompt` is produced.** Legacy tasks had no prompt override; the file's
 *   body was always what fired, and it still is. This is also why the migration
 *   never changes a schedule's content key: prompt and cron come out the far
 *   side identical.
 *
 * `origin`/`shape` carry over as the schedule's own provenance, including the
 * lopsided cases a hand-edited file can contain (a `shape:` with no `origin:`,
 * or the reverse) — the migration rewrites what it found rather than guessing at
 * what was meant.
 *
 * @param meta - Fields validated by {@link LegacyScheduleFieldsSchema}.
 * @returns The equivalent schedule block.
 */
export function legacyTaskToSchedule(meta: LegacyScheduleFields): ScheduleBlock {
  return {
    ...(meta.cron ? { cron: meta.cron } : {}),
    timezone: meta.timezone,
    enabled: meta.enabled,
    ...(meta['max-runtime'] !== undefined ? { 'max-runtime': meta['max-runtime'] } : {}),
    permissions: meta.permissions,
    ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
    ...(meta.shape !== undefined ? { shape: meta.shape } : {}),
  };
}

/** What one migration pass did, for the boot log and the tests. */
export interface LegacyMigrationReport {
  /** Schedules rewritten and moved out of a legacy root. */
  moved: number;
  /** Skills-root files whose stray top-level fields were folded into a block. */
  foldedInPlace: number;
  /** Migrated rows that kept the approval they already held. */
  keptApproved: number;
  /** Rows the migration parked — a name collision, or content that had drifted. */
  parked: number;
  /** Files left where they were because DorkOS could not read them. */
  unreadable: number;
  /** Template directories moved into the new gallery. */
  templates: number;
}

/** What {@link migrateLegacySchedules} needs to do its work. */
export interface LegacyMigrationDeps {
  /** The resolved data directory. */
  dorkHome: string;
  /** Every registered agent, so its project's legacy root is covered too. */
  agents: readonly { agentId: string; projectPath: string }[];
  /** The row half of the migration. */
  store: Pick<TaskStore, 'rekeyMigratedFile' | 'upsertFromFile'>;
}

/** A legacy root and the new root its contents belong in. */
interface RootPair {
  /** `<dorkHome>/tasks` or `<project>/.dork/tasks`. */
  from: string;
  /** `<dorkHome>/skills` or `<project>/.agents/skills`. */
  to: string;
  /** Whether schedules found here belong to a project or to the install. */
  scope: 'project' | 'global';
  /** The project root, for a project root. */
  projectPath?: string;
  /** The owning agent, for a project root. */
  agentId?: string;
}

/**
 * Move every legacy schedule onto the new shape and the new root.
 *
 * Safe to call on every boot: with no legacy state it reads a handful of missing
 * directories and returns zeros. Never throws — a migration that cannot finish
 * must not stop a server from starting, and everything it leaves behind is
 * detected again next time.
 *
 * @param deps - Where to look and what to write to.
 * @returns What it did.
 */
export async function migrateLegacySchedules(
  deps: LegacyMigrationDeps
): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = {
    moved: 0,
    foldedInPlace: 0,
    keptApproved: 0,
    parked: 0,
    unreadable: 0,
    templates: 0,
  };

  const pairs: RootPair[] = [
    {
      from: legacyGlobalTasksRoot(deps.dorkHome),
      to: globalSkillsRoot(deps.dorkHome),
      scope: 'global',
    },
    ...deps.agents.map((agent) => ({
      from: legacyAgentTasksRoot(agent.projectPath),
      to: agentSkillsRoot(agent.projectPath),
      scope: 'project' as const,
      projectPath: agent.projectPath,
      agentId: agent.agentId,
    })),
  ];

  try {
    report.templates = await migrateTemplateGallery(deps.dorkHome);
    for (const pair of pairs) await migrateLegacyRoot(pair, deps, report);
    for (const pair of pairs) await foldStrayLegacyFields(pair.to, pair.scope, report);
  } catch (err) {
    // Per-file failures are already contained below, so reaching here means
    // something structural — and a half-finished migration is a state the next
    // boot completes, whereas a server that will not start is not.
    logger.error('[Tasks] Legacy schedule migration stopped early', err);
  }

  if (report.moved + report.foldedInPlace + report.templates + report.unreadable > 0) {
    logger.info(
      `[Tasks] Moved ${report.moved} schedule(s) and ${report.templates} template(s) to their new home ` +
        `(${report.keptApproved} stayed approved, ${report.parked} need a look, ` +
        `${report.unreadable} could not be read, ${report.foldedInPlace} tidied in place)`
    );
  }
  return report;
}

/**
 * Move the template gallery from `<dorkHome>/tasks/templates` to
 * `<dorkHome>/skills/templates`.
 *
 * Per template directory rather than as one rename, because a person may have
 * written their own templates alongside the four DorkOS seeds and the
 * destination may already hold seeds from a fresh install. A name that exists at
 * the destination is left alone: the templates are starting points, and
 * overwriting one a person edited to install one they did not ask for is the
 * wrong trade.
 *
 * @param dorkHome - The resolved data directory.
 * @returns How many template directories moved.
 */
async function migrateTemplateGallery(dorkHome: string): Promise<number> {
  const from = path.join(legacyGlobalTasksRoot(dorkHome), TASK_TEMPLATES_DIRNAME);
  const to = resolveTemplatesDir(dorkHome);

  let entries;
  try {
    entries = await fs.readdir(from, { withFileTypes: true });
  } catch {
    return 0; // Nothing there: the ordinary case on every boot after the first.
  }

  let moved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      await fs.mkdir(to, { recursive: true });
      await fs.rename(path.join(from, entry.name), path.join(to, entry.name));
      moved++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') continue; // Already there.
      logger.warn(`[Tasks] Could not move the template ${entry.name} to ${to}`, err);
    }
  }

  // The old container goes only when it is empty — anything left is something
  // this pass could not move, and deleting it would be deleting a person's work.
  await fs.rmdir(from).catch(() => {});
  return moved;
}

/**
 * Migrate every schedule directory in one legacy root.
 *
 * @param pair - The legacy root and where its contents belong.
 * @param deps - Migration dependencies.
 * @param report - Counters to update in place.
 */
async function migrateLegacyRoot(
  pair: RootPair,
  deps: LegacyMigrationDeps,
  report: LegacyMigrationReport
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(pair.from, { withFileTypes: true });
  } catch {
    return; // No legacy root. The no-op this whole module is usually.
  }

  for (const entry of entries) {
    // `templates/` is the gallery, handled above; a symlink is somebody else's
    // file (an installed package's, most likely) and moving it would move a
    // pointer while leaving the schedule where it was.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name === TASK_TEMPLATES_DIRNAME && pair.scope === 'global') continue;
    try {
      await migrateOneSchedule(entry.name, pair, deps, report);
    } catch (err) {
      // Contained per file: one unreadable directory must not cost the rest of
      // a person's schedules their migration.
      logger.warn(`[Tasks] Could not migrate the schedule in ${entry.name}`, err);
    }
  }

  // Tidy an emptied `<project>/.dork/tasks` away. The GLOBAL legacy root is
  // deliberately left alone whatever is in it: `scheduler.lock` and
  // `presets.json` still live there, and the lock is written on a path this
  // process is about to take out.
  if (pair.scope === 'project') await fs.rmdir(pair.from).catch(() => {});
}

/**
 * Rewrite one legacy schedule, re-key its row, and move it to its new home.
 *
 * See the module header for why the three steps happen in this order.
 *
 * @param dirName - The schedule's directory name inside the legacy root.
 * @param pair - The legacy root and where its contents belong.
 * @param deps - Migration dependencies.
 * @param report - Counters to update in place.
 */
async function migrateOneSchedule(
  dirName: string,
  pair: RootPair,
  deps: LegacyMigrationDeps,
  report: LegacyMigrationReport
): Promise<void> {
  const oldDir = path.join(pair.from, dirName);
  const oldFile = path.join(oldDir, SKILL_FILENAME);

  let content: string;
  try {
    content = await fs.readFile(oldFile, 'utf-8');
  } catch {
    return; // A directory with no SKILL.md was never a schedule. Leave it.
  }

  const raw = readRawFrontmatter(content);
  const rewrite = raw === null ? null : buildRewrite(raw.data);
  if (raw === null || rewrite === null) {
    parkUnreadable(oldFile, dirName, pair, deps, report);
    return;
  }

  const destination = await resolveDestination(pair.to, dirName);
  if (destination === null) {
    parkUnreadable(oldFile, dirName, pair, deps, report);
    return;
  }

  // 1. Rewrite in place. Still in the legacy root, so a crash here leaves a file
  //    the next boot recognizes and finishes with.
  const frontmatter = { ...rewrite.frontmatter, name: destination.name };
  await writeSkillFile(pair.from, dirName, frontmatter, raw.body);

  // 2. Re-key the row onto where the file is about to be, resolved the way
  //    discovery will resolve it. The row is keyed on the file's REAL path in a
  //    skills root, and on macOS every temp directory — and many a home — sits
  //    under a symlink, so skipping this would leave the row pointing at a path
  //    discovery never produces and create a duplicate on the next scan.
  const newFile = path.join(
    await resolveRootPath(destination.parent),
    destination.name,
    SKILL_FILENAME
  );
  const collision = destination.collided
    ? collisionReason(path.join(pair.to, dirName), path.join(pair.to, destination.name))
    : null;
  const outcome = deps.store.rekeyMigratedFile(
    oldFile,
    newFile,
    { prompt: rewrite.block?.prompt ?? raw.body, cron: rewrite.block?.cron ?? '' },
    collision
  );

  // 3. Move. Last, because everything before it is recoverable and this is what
  //    makes the file invisible to the detector.
  try {
    await fs.rename(oldDir, path.join(destination.parent, destination.name));
  } catch (err) {
    // The row now names a file that is not there. Put it back and park it: an
    // inert row a person can see beats a live one firing from a path nothing
    // can read, and the next boot will try the move again.
    const reverted = deps.store.rekeyMigratedFile(
      newFile,
      oldFile,
      { prompt: rewrite.block?.prompt ?? raw.body, cron: rewrite.block?.cron ?? '' },
      moveFailedReason(oldDir, path.join(destination.parent, destination.name))
    );
    if (reverted !== 'no-row') report.parked++;
    logger.warn(`[Tasks] Could not move ${oldDir} to its new home — left it where it is`, err);
    return;
  }

  report.moved++;
  if (outcome === 'rekeyed') report.keptApproved++;
  if (outcome === 'reparked' || collision !== null) report.parked++;
}

/**
 * Fold stray top-level task fields on a file that is already in a skills root.
 *
 * The second, rarer half of detection: a file whose author wrote `cron:` at the
 * top level of a skill. The unified schema drops keys it does not know, so such
 * a file parses perfectly and is silently not a schedule — the failure mode ADR
 * `260823-200724` calls this design's worst case. Nothing moves, and no row is
 * touched: the path does not change, and neither do the prompt and cron a grant
 * is keyed on.
 *
 * @param dir - The skills root to sweep.
 * @param scope - Whether it is the global root (which reserves `templates/`).
 * @param report - Counters to update in place.
 */
async function foldStrayLegacyFields(
  dir: string,
  scope: 'project' | 'global',
  report: LegacyMigrationReport
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Symlinks are skipped for a reason worth stating: a `pkg__name` link is an
    // installed package's file, and rewriting through it edits the package's own
    // checkout — invisible in the cockpit, shared by every agent that installed
    // it, and overwritten by the next update.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (scope === 'global' && entry.name === TASK_TEMPLATES_DIRNAME) continue;

    const filePath = path.join(dir, entry.name, SKILL_FILENAME);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const raw = readRawFrontmatter(content);
      if (raw === null) continue; // Unreadable here is discovery's story to tell.
      if (!LEGACY_SIGNAL_FIELDS.some((field) => raw.data[field] !== undefined)) continue;

      const rewrite = buildRewrite(raw.data);
      if (rewrite === null) continue;
      await writeSkillFile(dir, entry.name, rewrite.frontmatter, raw.body);
      report.foldedInPlace++;
      logger.info(`[Tasks] Folded the schedule settings in ${filePath} into a schedule block`);
    } catch {
      // Not a skill directory, or not readable. Either way not this pass's news.
    }
  }
}

/** A rewritten frontmatter and the block it now carries, when that block reads. */
interface Rewrite {
  /** The frontmatter to write, with the legacy keys gone and a `schedule:` block. */
  frontmatter: Record<string, unknown>;
  /** The block, when it validates — `null` when a pre-existing one does not. */
  block: ScheduleBlock | null;
}

/**
 * Turn raw legacy frontmatter into the frontmatter that replaces it.
 *
 * Built from the RAW mapping, never a parsed one: parsing fills defaults in, so
 * rewriting from `meta` would materialize a `timezone`, `enabled` and
 * `permissions` the author never typed. `scheduleToFrontmatter` then drops
 * whatever is already the default on the way back out, so a file that said
 * `cron: '0 9 * * *'` and nothing else comes out saying
 * `schedule: {cron: '0 9 * * *'}` and nothing else.
 *
 * A file that ALREADY has a block keeps it. Only the stray top-level keys go —
 * they have had no effect since the unified schema shipped, so removing them
 * changes nothing except how honest the file is. That is also what makes an
 * interrupted run safe to re-run: the second pass cannot flatten a real block
 * into an empty one.
 *
 * @param data - The raw frontmatter mapping.
 * @returns The rewrite, or `null` when the legacy fields do not parse.
 */
function buildRewrite(data: Record<string, unknown>): Rewrite | null {
  const hasBlock = data.schedule !== undefined && data.schedule !== null;

  const stripped: Record<string, unknown> = { ...data };
  for (const field of LEGACY_TOP_LEVEL_FIELDS) delete stripped[field];

  if (hasBlock) {
    const parsed = ScheduleBlockSchema.safeParse(data.schedule);
    return { frontmatter: stripped, block: parsed.success ? parsed.data : null };
  }

  if (!readsAsSkill(data)) return null;
  const parsed = LegacyScheduleFieldsSchema.safeParse(data);
  if (!parsed.success) return null;
  const block = legacyTaskToSchedule(parsed.data);
  return { frontmatter: { ...stripped, schedule: scheduleToFrontmatter(block) }, block };
}

/** Where a migrated schedule is going, and whether it had to change its name. */
interface Destination {
  /** The skills root it lands in. */
  parent: string;
  /** The directory name inside it — suffixed when the first choice was taken. */
  name: string;
  /** Whether the name had to change. */
  collided: boolean;
}

/** How many suffixed names to try before giving up on a colliding schedule. */
const MAX_COLLISION_ATTEMPTS = 20;

/**
 * Pick the directory a migrated schedule lands in, avoiding anything already
 * there.
 *
 * A collision is a real possibility rather than a theoretical one: the same slug
 * could exist as a task in `.dork/tasks/` and as an ordinary skill in
 * `.agents/skills/`, and after this wave they want the same directory. The
 * skill that is already there wins its own name — it is the one every harness
 * has been reading — and the schedule arrives as `<name>-migrated`, parked, with
 * a row that says where it went.
 *
 * @param parent - The skills root.
 * @param name - The name the schedule had.
 * @returns The destination, or `null` when even the suffixes are taken.
 */
async function resolveDestination(parent: string, name: string): Promise<Destination | null> {
  await fs.mkdir(parent, { recursive: true });
  if (!(await exists(path.join(parent, name)))) return { parent, name, collided: false };

  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? `${name}-migrated` : `${name}-migrated-${attempt}`;
    if (!(await exists(path.join(parent, candidate)))) {
      return { parent, name: candidate, collided: true };
    }
  }
  return null;
}

/**
 * Leave an unreadable legacy file exactly where it is, and give a person a row
 * that names it.
 *
 * The row is the only surface that can carry the news: the legacy roots are not
 * scanned any more, so a file left behind is invisible unless something says so.
 * It goes through `upsertFromFile` as a discovery write, which means it can only
 * ever park — the same door every file-found schedule comes through, and the one
 * that guarantees this cannot arm anything.
 *
 * @param filePath - The file that could not be read.
 * @param dirName - Its directory name, which becomes the row's name.
 * @param pair - The root it was found in.
 * @param deps - Migration dependencies.
 * @param report - Counters to update in place.
 */
function parkUnreadable(
  filePath: string,
  dirName: string,
  pair: RootPair,
  deps: LegacyMigrationDeps,
  report: LegacyMigrationReport
): void {
  report.unreadable++;
  logger.warn(
    `[Tasks] Could not read the schedule at ${filePath}, so it stayed where it is and is not running`
  );

  const meta: SkillFrontmatter & { schedule: ScheduleBlock } = {
    name: dirName,
    description: 'A scheduled task DorkOS could not read.',
    // No cron and switched off: DorkOS does not know what this file wanted and
    // must not guess. The row exists to carry the complaint, not to run.
    schedule: { ...ScheduleBlockSchema.parse({}), enabled: false },
  };

  deps.store.upsertFromFile(
    {
      name: dirName,
      body: '',
      filePath,
      dirPath: path.dirname(filePath),
      scope: pair.scope,
      projectPath: pair.projectPath,
      meta,
    },
    pair.agentId,
    { source: 'discovery', problem: unreadableReason(filePath) }
  );
}

/** Why a schedule DorkOS could not read is sitting there doing nothing. */
function unreadableReason(filePath: string): string {
  return (
    `DorkOS could not read the settings at the top of ${filePath}, so it left the file alone ` +
    `and nothing is running from it. Fix that file — or delete it — and DorkOS will pick it up.`
  );
}

/** Why a migrated schedule ended up under a different name. */
function collisionReason(wanted: string, got: string): string {
  return (
    `DorkOS moved this schedule to ${got}, because something was already at ${wanted}. ` +
    `Check it is still what you want, then approve it.`
  );
}

/** Why a schedule is parked in its old home after a move that would not go through. */
function moveFailedReason(from: string, to: string): string {
  return (
    `DorkOS could not move this schedule from ${from} to ${to}, so it is switched off where it is. ` +
    `Move that folder yourself, or delete the schedule.`
  );
}

/** Whether a path exists at all — a broken symlink counts, because the name is taken. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
