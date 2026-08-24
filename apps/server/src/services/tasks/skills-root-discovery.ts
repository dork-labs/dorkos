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
import { hasSchedule, scheduleProblem } from '@dorkos/skills';
import type { ScheduleBlock, SkillFrontmatter, TaskDefinition } from '@dorkos/skills';
import { parseSkillFile, type ParsedSkill } from '@dorkos/skills/parser';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import type { TaskFrontmatter } from '@dorkos/skills/task-schema';
import { describeScheduleProblem } from './cron-validation.js';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import type { TaskRoot } from './skills-roots.js';

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
    name: skill.name,
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
    name: skill.name,
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
  /** A plain skill. The ordinary case in a skills root, and a silent one. */
  | { kind: 'ignored'; filePath: string }
  /** A schedule, whether or not there is something wrong with it. */
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

  const result = parseSkillFile(filePath, content, SkillFrontmatterSchema);
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
    ? { kind: 'ignored', filePath }
    : { kind: 'schedule', filePath: resolvedPath, discovered };
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
      ? await scanSkillDirectory(root.dir, SkillFrontmatterSchema, {
          ignoreDirs: RESERVED_TASK_DIRNAMES,
        })
      : await scanSkillDirectory(root.dir, TaskFrontmatterSchema, {
          ignoreDirs: RESERVED_TASK_DIRNAMES,
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
        ? { kind: 'ignored', filePath: skill.filePath }
        : { kind: 'schedule', filePath: resolvedPath, discovered }
    );
  }
  return outcomes;
}
