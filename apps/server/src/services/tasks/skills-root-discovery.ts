/**
 * The door between a skills root and the tasks subsystem.
 *
 * Every SKILL.md in a watched skills root passes through here, and exactly
 * three things can happen to it:
 *
 * - **Nothing.** No `schedule:` block means a plain skill. Not an error, not a
 *   log line, no row — most files in a skills root are this, and the tasks
 *   subsystem has no opinion about them at all.
 * - **A row.** A readable block becomes a schedule, parked or armed by the gate
 *   in `schedule-permission-clamp.ts`.
 * - **A row that says what is wrong.** A block DorkOS cannot read, or one whose
 *   cron croner refuses, still becomes a row — parked, carrying the complaint
 *   as its `reason`. This is the point of the whole arrangement: the skill
 *   keeps working everywhere else, and the one surface that cares about the
 *   schedule is the one that shows the problem (spec §User Experience).
 *
 * ## Why cron validation happens HERE
 *
 * `cron-validation.ts` describes itself as "the API's door, and only the API's
 * door" — a hand-edited SKILL.md never reached it. That was defensible while
 * the only way to author a schedule outside the API was to hand-place a file in
 * a blessed directory. Discovery over every skills root makes hand-authored the
 * ORDINARY case, so this is now the second door, and the spec's promise that
 * "an invalid cron fails at discovery time" is kept by asking croner right
 * here. The scheduler still catches croner's throw where it happens; that
 * containment is the backstop, not the message.
 *
 * ## Why a skills root does not require the name to match its directory
 *
 * `parseSkillFile` defaults to refusing a file whose frontmatter `name` differs
 * from its parent directory, which is right for content DorkOS writes itself.
 * It is wrong here, and was silently fatal: Harness Sync projects an installed
 * plugin's skill into `.agents/skills/` under a NAMESPACED link — `flow__drain`
 * pointing at a directory whose SKILL.md says `name: drain`. Under the default
 * every projected plugin skill parsed as invalid, which meant no plugin has ever
 * been discoverable as a schedule and the entire symlink path below was
 * unreachable in production (DOR-1485 review, N2).
 *
 * Relaxing it costs nothing here because a schedule's identity is its RESOLVED
 * PATH, never its name (`schedule-identity.ts`): two skills may share a name,
 * and the row that tells them apart was never keyed on it. The name a person
 * reads comes from the frontmatter, so a projected skill shows as `drain`
 * rather than `flow__drain`.
 *
 * ## Why there is no regex fast-reject
 *
 * The spec allows skipping full validation on files with no `schedule:` key.
 * The saving is a `gray-matter` parse of a small file, measured in
 * microseconds, on tens of files every five minutes — and the cost of getting
 * it wrong is the failure the ADR names as this design's worst case: a schedule
 * that silently does not exist because a scanner misread the frontmatter. The
 * cheap reject is the `hasSchedule` check below, after a real parse.
 *
 * @module services/tasks/skills-root-discovery
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasSchedule, scheduleProblem } from '@dorkos/skills';
import type { ScheduleBlock, SkillFrontmatter, TaskDefinition } from '@dorkos/skills';
import { parseSkillFile, type ParsedSkill } from '@dorkos/skills/parser';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import type { TaskFrontmatter } from '@dorkos/skills/task-schema';
import { describeScheduleProblem } from './cron-validation.js';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { reservedDirsFor, type TaskRoot } from './skills-roots.js';

/** A SKILL.md that carries a `schedule:` block, ready for the store. */
export interface DiscoveredSchedule {
  /**
   * The file, shaped the way `TaskStore.upsertFromFile` reads it.
   *
   * The store still takes the LEGACY frontmatter shape, with the scheduling
   * fields at the top level, because the legacy roots are still live and one
   * store path is better than two. This mapping is the inverse of
   * `legacyTaskToSchedule` and disappears with it in DOR-1486, when the block
   * becomes the only shape there is.
   */
  def: TaskDefinition;
  /**
   * What stops this schedule being usable as written, or `null` when nothing
   * does. A schedule with a problem parks and stays parked until the file is
   * fixed.
   */
  problem: string | null;
}

/** Where a discovered file sits, which the store records but cannot derive. */
export interface ScheduleLocation {
  /** Whether the root belongs to a project or to the install. */
  scope: 'project' | 'global';
  /** The project root, for project-scoped roots. */
  projectPath?: string;
  /**
   * The file's REAL path, symlinks resolved — the schedule's identity.
   *
   * Resolved by the caller rather than here because the caller is the one
   * holding the filesystem: an installed plugin skill appears in
   * `.agents/skills/` as a `pkg__name` symlink into `.dork/plugins/`, and two
   * roots can therefore reach one file. Keying the row on the resolved path is
   * what makes that one schedule instead of two.
   */
  resolvedPath: string;
}

/**
 * The permission mode a file gets when DorkOS could not read its schedule
 * block. The same value the block's own schema defaults to, so an unreadable
 * block lands exactly where an empty one would.
 */
const FALLBACK_PERMISSIONS = 'acceptEdits' as const;

/**
 * Build the legacy-shaped definition the store reads from a readable block.
 *
 * `prompt` is the one field that is not a rename: a schedule may override what
 * gets sent when it fires, and the body is the default. That is what lets one
 * file teach a person one thing and tell an unattended run another.
 */
function definitionFromBlock(
  skill: ParsedSkill<SkillFrontmatter>,
  block: ScheduleBlock,
  location: ScheduleLocation
): TaskDefinition {
  return {
    name: skill.meta.name,
    body: block.prompt ?? skill.body,
    filePath: location.resolvedPath,
    dirPath: skill.dirPath,
    scope: location.scope,
    projectPath: location.projectPath,
    meta: {
      ...skill.meta,
      cron: block.cron,
      timezone: block.timezone,
      enabled: block.enabled,
      'max-runtime': block['max-runtime'],
      permissions: block.permissions,
    },
    // `block.origin` / `block.shape` are deliberately not carried across: the
    // store reads neither, and the schedule row has no column for package
    // provenance yet. That arrives with the marketplace phase (spec §6), which
    // is also the first thing that will need it.
  };
}

/**
 * Build a definition for a file whose block did not parse.
 *
 * There is nothing to read, so nothing is claimed: no cron, and `enabled:
 * false`, because DorkOS does not know whether the author wanted this on and
 * must not guess "yes". The row exists only to carry the complaint to a person;
 * approving it as-is yields a schedule with no timer, which is the harmless
 * outcome. Fixing the file changes the content, which re-parks it for a real
 * look.
 */
function definitionFromUnreadableBlock(
  skill: ParsedSkill<SkillFrontmatter>,
  location: ScheduleLocation
): TaskDefinition {
  return {
    name: skill.meta.name,
    body: skill.body,
    filePath: location.resolvedPath,
    dirPath: skill.dirPath,
    scope: location.scope,
    projectPath: location.projectPath,
    meta: {
      ...skill.meta,
      cron: undefined,
      timezone: 'UTC',
      enabled: false,
      permissions: FALLBACK_PERMISSIONS,
    },
  };
}

/**
 * Decide what the tasks subsystem does with one parsed SKILL.md from a skills
 * root.
 *
 * @param skill - The file, parsed with the unified `SkillFrontmatterSchema`.
 * @param location - Where it sits and what its real path is.
 * @returns The schedule to sync, or `null` when this file is just a skill.
 */
export function readScheduleFromSkill(
  skill: ParsedSkill<SkillFrontmatter>,
  location: ScheduleLocation
): DiscoveredSchedule | null {
  const blockProblem = scheduleProblem(skill.meta);
  if (blockProblem !== null) {
    return { def: definitionFromUnreadableBlock(skill, location), problem: blockProblem };
  }

  // No block and no complaint: a plain skill, and none of this subsystem's
  // business. This is the common case in a skills root.
  if (!hasSchedule(skill.meta)) return null;

  const block = skill.meta.schedule;
  return {
    def: definitionFromBlock(skill, block, location),
    problem: describeScheduleProblem(block.cron ?? null, block.timezone),
  };
}

/**
 * A legacy task file is a schedule because of WHERE it is, so there is nothing
 * to decide — only its cron to check, at the same door the new files use.
 *
 * Deleted with the legacy roots in DOR-1486.
 */
function readLegacySchedule(
  task: ParsedSkill<TaskFrontmatter>,
  root: TaskRoot
): DiscoveredSchedule {
  return {
    def: { ...task, scope: root.scope, projectPath: root.projectPath },
    // A bad cron here could never fire anyway — the scheduler catches croner's
    // throw — so the only change is that a person now gets told which file to
    // fix instead of the failure living in a log line.
    problem: describeScheduleProblem(task.meta.cron, task.meta.timezone),
  };
}

/** What one file in a watched root turned out to be. */
export type ReadOutcome =
  /** On disk but unusable — unreadable, or frontmatter that does not parse. */
  | { kind: 'invalid'; filePath: string; error: string; fileMissing: boolean }
  /**
   * A plain skill. The ordinary case in a skills root, and a silent one.
   *
   * `resolvedPath` is the identity a row for this file would be keyed on, when
   * it is known. It matters for the one case where an ignored file is not
   * silent: a skill that USED to carry a `schedule:` block still has a row, and
   * retiring it means naming the path that row holds, not the path we walked in
   * on.
   */
  | { kind: 'ignored'; filePath: string; resolvedPath?: string }
  /**
   * A schedule, whether or not there is something wrong with it.
   *
   * `filePath` is where the file was SEEN — the symlink, for an installed
   * plugin skill. The schedule's IDENTITY is `discovered.def.filePath`, which is
   * that path resolved. Both are reported because the two are used for different
   * things: the row is keyed on the identity, while the sighting is what a
   * watcher will name when the file is later deleted.
   */
  | { kind: 'schedule'; filePath: string; discovered: DiscoveredSchedule };

/**
 * Read one SKILL.md the way its root says to read it.
 *
 * The single place the two root kinds diverge. Both the watcher (one file, on
 * a change event) and the reconciler (every file, on a timer) come through
 * here, so a rule added for one is automatically true of the other — which is
 * what the arm gate depends on, since a rule the reconciler enforced and the
 * watcher did not would arm a schedule for five minutes at a time.
 *
 * @param filePath - The path the file was found at, before symlinks.
 * @param content - Its bytes.
 * @param root - The root it was found in.
 */
export async function readTaskRootFile(
  filePath: string,
  content: string,
  root: TaskRoot
): Promise<ReadOutcome> {
  if (root.kind === 'legacy-tasks') {
    const result = parseSkillFile(filePath, content, TaskFrontmatterSchema);
    return result.ok
      ? { kind: 'schedule', filePath, discovered: readLegacySchedule(result.definition, root) }
      : { kind: 'invalid', filePath, error: result.error, fileMissing: false };
  }

  const result = parseSkillFile(filePath, content, SkillFrontmatterSchema, {
    requireNameMatch: false,
  });
  if (!result.ok) {
    return { kind: 'invalid', filePath, error: result.error, fileMissing: false };
  }

  // Identity is the REAL path: an installed plugin skill appears in
  // `.agents/skills/` as a symlink into `.dork/plugins/`, and two roots
  // reaching one file must be one schedule, not two.
  //
  // Legacy roots are deliberately NOT resolved. Their rows already exist, keyed
  // on the unresolved path, and resolving them now would key the same file
  // differently on the first sync after an upgrade — creating a duplicate row
  // for every schedule of anyone whose home or checkout sits under a symlink.
  const resolvedPath = await fs.realpath(filePath);
  const discovered = readScheduleFromSkill(result.definition, {
    scope: root.scope,
    projectPath: root.projectPath,
    resolvedPath,
  });
  return discovered === null
    ? { kind: 'ignored', filePath, resolvedPath }
    : { kind: 'schedule', filePath, discovered };
}

/**
 * The skills a directory scan cannot see, because they are symlinks.
 *
 * `scanSkillDirectory` skips any entry `readdir` does not report as a real
 * directory, and a symlink to one is not — which is precisely the shape an
 * installed marketplace plugin takes in `.agents/skills/` (`pkg__name` pointing
 * into `.dork/plugins/`). Without this the watcher would discover a plugin's
 * schedule (chokidar follows links) and the reconciler never would, so the
 * safety net had a hole exactly where the ecosystem case lives.
 *
 * Fixed here rather than in `scanSkillDirectory` deliberately: that scanner is
 * shared with harness projection, marketplace validation and the Codex palette,
 * and teaching it to follow links changes what every one of them enumerates.
 * This walk is local to the tasks subsystem and additive — it only ever looks at
 * entries the shared scan already declined.
 *
 * Every failure is per-entry and silent: a dangling link is a plugin mid-
 * uninstall, not a schedule to complain about.
 */
async function scanSymlinkedSkills<T>(
  dir: string,
  schema: Parameters<typeof parseSkillFile<T>>[2]
): Promise<{ filePath: string; result: ReturnType<typeof parseSkillFile<T>> }[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // The caller's own scan already threw or returned for this directory; a
    // second opinion about it is not this helper's to give.
    return [];
  }

  const found: { filePath: string; result: ReturnType<typeof parseSkillFile<T>> }[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || RESERVED_TASK_DIRNAMES.includes(entry.name)) continue;
    const filePath = path.join(dir, entry.name, SKILL_FILENAME);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      found.push({
        filePath,
        result: parseSkillFile(filePath, content, schema, { requireNameMatch: false }),
      });
    } catch {
      // A link to something that is not a skill directory, or one whose target
      // has gone. Neither is a schedule, and neither is news.
    }
  }
  return found;
}

/**
 * Read every SKILL.md in one root.
 *
 * Throws only when the DIRECTORY could not be enumerated — EACCES, EMFILE —
 * which the caller must tell apart from an empty one, because treating "could
 * not look" as "nothing there" retires every schedule inside it. A file that
 * individually fails comes back as an `invalid` outcome instead.
 *
 * `templates/` and friends are skipped: they are containers the tasks system
 * owns, and scanning one as a task reports a permanent bogus failure on every
 * pass.
 *
 * @param root - The root to scan.
 */
export async function scanTaskRoot(root: TaskRoot): Promise<ReadOutcome[]> {
  // A skills root is read with the UNIFIED schema. Reading it with the task
  // schema would report every ordinary skill in it as an invalid task, every
  // five minutes, forever.
  const results =
    root.kind === 'skills'
      ? [
          ...(await scanSkillDirectory(root.dir, SkillFrontmatterSchema, {
            ignoreDirs: reservedDirsFor(root.kind),
            requireNameMatch: false,
          })),
          // Installed plugin skills are symlinks, which the shared scan skips.
          ...(await scanSymlinkedSkills(root.dir, SkillFrontmatterSchema)).map((f) => f.result),
        ]
      : await scanSkillDirectory(root.dir, TaskFrontmatterSchema, {
          ignoreDirs: reservedDirsFor(root.kind),
        });

  const outcomes: ReadOutcome[] = [];
  for (const result of results) {
    if (!result.ok) {
      outcomes.push({
        kind: 'invalid',
        filePath: result.filePath,
        error: result.error,
        fileMissing: result.fileMissing ?? false,
      });
      continue;
    }
    if (root.kind === 'legacy-tasks') {
      const task = result.definition as ParsedSkill<TaskFrontmatter>;
      outcomes.push({
        kind: 'schedule',
        filePath: task.filePath,
        discovered: readLegacySchedule(task, root),
      });
      continue;
    }
    const skill = result.definition as ParsedSkill<SkillFrontmatter>;
    let resolvedPath: string;
    try {
      resolvedPath = await fs.realpath(skill.filePath);
    } catch {
      // The scan just listed it, so this is a symlink whose target went away
      // between the two reads. Nothing to sync, and reporting it as a deletion
      // would be a guess; the next pass settles it either way.
      outcomes.push({ kind: 'ignored', filePath: skill.filePath });
      continue;
    }
    const discovered = readScheduleFromSkill(skill, {
      scope: root.scope,
      projectPath: root.projectPath,
      resolvedPath,
    });
    outcomes.push(
      discovered === null
        ? { kind: 'ignored', filePath: skill.filePath, resolvedPath }
        : { kind: 'schedule', filePath: skill.filePath, discovered }
    );
  }
  return outcomes;
}

/**
 * The real directories that this root's symlinked entries point at, dangling
 * links included.
 *
 * The reconciler needs these to be allowed to retire a plugin's schedule. Its
 * retirement gate only acts on a directory the pass actually looked in, and a
 * row discovered through a `pkg__name` symlink is keyed on a path inside
 * `.dork/plugins/` — a directory that is not a root and never appears in the
 * scan. Uninstalling the package therefore left the schedule as a row nothing
 * could speak about, still on the clock (DOR-1485 review, I3).
 *
 * `readlink` rather than `realpath` is what makes this work: a link whose target
 * has just been deleted still tells you where it pointed, which is exactly the
 * situation an uninstall creates. Looking through the link IS looking in that
 * directory, so reporting it is honest testimony and not a widening of the gate.
 *
 * @param dir - The skills root to inspect.
 * @returns Absolute directories, possibly no longer present.
 */
export async function linkedSkillDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || RESERVED_TASK_DIRNAMES.includes(entry.name)) continue;
    try {
      const target = path.resolve(dir, await fs.readlink(path.join(dir, entry.name)));
      dirs.push(await resolveThroughAncestors(target));
    } catch {
      // Not readable as a link any more; nothing to testify about.
    }
  }
  return dirs;
}

/**
 * Resolve a path that may not exist, by resolving as much of it as does.
 *
 * `fs.realpath` is all-or-nothing: it throws on a path whose leaf has been
 * deleted, which is exactly the path an uninstall leaves behind. But the row we
 * need to name was keyed on the FULLY resolved path, so comparing against the
 * raw one silently matches nothing — and on macOS that is the ordinary case, not
 * an edge one, because every temp directory sits under a symlinked `/var`.
 *
 * So this resolves the deepest ancestor that still exists and re-attaches the
 * rest. The parts that no longer exist cannot themselves be symlinks any more,
 * so nothing is lost by carrying them through literally.
 *
 * @param target - An absolute path, possibly gone.
 * @returns The same path with every resolvable ancestor resolved.
 */
async function resolveThroughAncestors(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
