/**
 * Where DorkOS looks for scheduled work.
 *
 * Being scheduled is a property of a file, not a place on disk (ADR
 * `260823-200724`), so the scheduler owns no directory — it reads the SKILLS
 * roots and picks out the files carrying a `schedule:` block. One global root
 * plus one per registered agent.
 *
 * The legacy task directories (`<dorkHome>/tasks/`, `<project>/.dork/tasks/`)
 * were listed here and watched alongside these until DOR-1486. They are not any
 * more: `legacy-migration.ts` rewrites and moves what is in them on the boot it
 * finds them, and nothing scans them afterwards. `<dorkHome>/tasks/` still
 * exists, holding the two SYSTEM files that were always there and were never
 * schedules — `scheduler.lock` and `presets.json`.
 *
 * A SKILL.md that appears in one of those directories WHILE the server is
 * running is therefore not discovered at all — no row, no warning, nothing on a
 * clock. It is not lost, either: the migration is location-based and
 * unconditional, so the next start moves it like any other legacy file. That
 * remains true until the migration reaches its sunset, at which point dropping a
 * file there stops meaning anything at all. Either way it is not a live import
 * path, and nothing should be written there on purpose.
 *
 * @module services/tasks/skills-roots
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { logger } from '../../lib/logger.js';

/**
 * The global skills root: `~/.dork/skills/`.
 *
 * Created on boot so a person (or DorkBot) has somewhere obvious to put a
 * schedule that belongs to no project.
 *
 * @param dorkHome - The resolved data directory.
 */
export function globalSkillsRoot(dorkHome: string): string {
  return path.join(dorkHome, 'skills');
}

/**
 * An agent's skills root: `<projectPath>/.agents/skills/`.
 *
 * **Never `.claude/skills/`.** That directory is a projection Harness Sync
 * writes FROM `.agents/skills/`, so watching it would discover every schedule
 * twice and give a mirror a vote on what runs (spec §2).
 *
 * @param projectPath - The agent's project root.
 */
export function agentSkillsRoot(projectPath: string): string {
  return path.join(projectPath, '.agents', 'skills');
}

/** One root to watch and reconcile, with everything a sync needs to know about it. */
export interface TaskRoot {
  /** Absolute path to the directory. */
  dir: string;
  /** Whether tasks found here belong to a project or to the install. */
  scope: 'project' | 'global';
  /** The project root, for project-scoped roots. */
  projectPath?: string;
  /** The agent that owns a project-scoped root. */
  agentId?: string;
}

/**
 * The directory names a root treats as containers rather than schedules.
 *
 * Only the GLOBAL root has one: `templates/` is the schedule gallery, and since
 * DOR-1486 it lives at `<dorkHome>/skills/templates` (`task-templates.ts`). A
 * project's skills root has no such container, so nothing is reserved there —
 * reserving `templates` everywhere would make a project skill legitimately named
 * `templates` invisible to the tasks subsystem, hiding a real schedule to
 * protect a directory that is not in that tree (DOR-1485 review, minor).
 *
 * @param root - The root being scanned.
 * @returns Names to skip, empty for a project root.
 */
export function reservedDirsFor(root: Pick<TaskRoot, 'scope'>): readonly string[] {
  return root.scope === 'global' ? RESERVED_TASK_DIRNAMES : [];
}

/**
 * Every root that belongs to one registered agent.
 *
 * A list of one since DOR-1486 retired the legacy `.dork/tasks/` root beside it.
 * It stays a list because both callers iterate it, and because the shape is what
 * makes adding a second project root later a one-line change rather than a
 * signature change at four call sites.
 *
 * @param projectPath - The agent's project root.
 * @param agentId - The agent's id.
 */
export function agentTaskRoots(projectPath: string, agentId: string): TaskRoot[] {
  return [{ dir: agentSkillsRoot(projectPath), scope: 'project', projectPath, agentId }];
}

/**
 * The install-wide roots.
 *
 * @param dorkHome - The resolved data directory.
 */
export function globalTaskRoots(dorkHome: string): TaskRoot[] {
  return [{ dir: globalSkillsRoot(dorkHome), scope: 'global' }];
}

/**
 * Resolve a skills root's own path, symlinks and all, falling back to the path
 * itself when it cannot be resolved.
 *
 * Every writer that creates a schedule file has to key its row on the path
 * DISCOVERY will key it on, which is the file's REAL path — a data directory or
 * a checkout under a symlinked parent is ordinary rather than exotic (every
 * macOS temp directory is one), and a row keyed on the unresolved path is a
 * second row for one file the moment the watcher reads it.
 *
 * The ROOT is resolved rather than the file, on purpose. The root is stable and
 * has to exist for any of this to mean anything; the file was written a
 * microsecond ago and may be being replaced right now. And the fallback matters
 * more than it looks: resolving is a nicety, while failing a create that has
 * already written its file to disk is a real failure, so an unresolvable root
 * degrades to the literal path instead of throwing.
 *
 * @param dir - The root to resolve.
 * @returns The resolved path, or `dir` unchanged.
 */
export async function resolveRootPath(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return dir;
  }
}

/**
 * Make sure `~/.dork/skills/` exists before anything watches it.
 *
 * chokidar will happily watch a path that is not there yet and pick it up when
 * it appears, so this is not required for correctness — it is so that a person
 * looking for where to put a global schedule finds the directory already
 * waiting rather than having to know its name.
 *
 * Failure is logged and swallowed: a read-only or full home directory must not
 * take the server down, and everything downstream treats a missing root as an
 * empty one.
 *
 * @param dorkHome - The resolved data directory.
 * @returns The root's path, created or not.
 */
export async function ensureGlobalSkillsRoot(dorkHome: string): Promise<string> {
  const dir = globalSkillsRoot(dorkHome);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    logger.warn(`[Tasks] Could not create the global skills directory at ${dir}`, err);
  }
  return dir;
}
