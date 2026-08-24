/**
 * Where DorkOS looks for scheduled work.
 *
 * Being scheduled is a property of a file, not a place on disk (ADR
 * `260823-200724`), so the scheduler no longer owns any directory — it reads
 * the SKILLS roots and picks out the files carrying a `schedule:` block. One
 * global root plus one per registered agent, the same cardinality as before;
 * only the paths changed.
 *
 * The legacy task directories are still listed here and still watched. They are
 * removed by the migration wave (DOR-1486), which rewrites the files under them
 * into the new format and moves them; until then a person's existing schedules
 * have to keep working, so both sets of roots are scanned side by side.
 *
 * @module services/tasks/skills-roots
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../../lib/logger.js';

/**
 * What kind of root a directory is, which decides how its SKILL.md files are
 * read: a skills root parses with the unified schema and ignores anything
 * without a `schedule:` block, while a legacy tasks root parses every file with
 * the old top-level-fields schema.
 */
export type TaskRootKind = 'skills' | 'legacy-tasks';

/**
 * The global skills root: `~/.dork/skills/`.
 *
 * Created on boot so a person (or DorkBot) has somewhere obvious to put a
 * schedule that belongs to no project. `~/.dork/tasks/` survives alongside it
 * as a system directory — `scheduler.lock` and `presets.json` live there — and
 * keeps being scanned only until the migration wave empties it.
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

/**
 * The legacy global tasks root: `~/.dork/tasks/`. Removed by DOR-1486.
 *
 * @param dorkHome - The resolved data directory.
 */
export function legacyGlobalTasksRoot(dorkHome: string): string {
  return path.join(dorkHome, 'tasks');
}

/**
 * An agent's legacy tasks root: `<projectPath>/.dork/tasks/`. Removed by
 * DOR-1486.
 *
 * @param projectPath - The agent's project root.
 */
export function legacyAgentTasksRoot(projectPath: string): string {
  return path.join(projectPath, '.dork', 'tasks');
}

/** One root to watch and reconcile, with everything a sync needs to know about it. */
export interface TaskRoot {
  /** Absolute path to the directory. */
  dir: string;
  /** How its files are parsed. */
  kind: TaskRootKind;
  /** Whether tasks found here belong to a project or to the install. */
  scope: 'project' | 'global';
  /** The project root, for project-scoped roots. */
  projectPath?: string;
  /** The agent that owns a project-scoped root. */
  agentId?: string;
}

/**
 * Every root that belongs to one registered agent — its skills root and, until
 * DOR-1486, its legacy tasks root.
 *
 * Order matters: the skills root comes first so that when the same real
 * SKILL.md is reachable through both, the new location is the one that claims
 * it (see `schedule-identity.ts`).
 *
 * @param projectPath - The agent's project root.
 * @param agentId - The agent's id.
 */
export function agentTaskRoots(projectPath: string, agentId: string): TaskRoot[] {
  return [
    { dir: agentSkillsRoot(projectPath), kind: 'skills', scope: 'project', projectPath, agentId },
    {
      dir: legacyAgentTasksRoot(projectPath),
      kind: 'legacy-tasks',
      scope: 'project',
      projectPath,
      agentId,
    },
  ];
}

/**
 * The install-wide roots — the global skills root and, until DOR-1486, the
 * legacy global tasks root.
 *
 * @param dorkHome - The resolved data directory.
 */
export function globalTaskRoots(dorkHome: string): TaskRoot[] {
  return [
    { dir: globalSkillsRoot(dorkHome), kind: 'skills', scope: 'global' },
    { dir: legacyGlobalTasksRoot(dorkHome), kind: 'legacy-tasks', scope: 'global' },
  ];
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
