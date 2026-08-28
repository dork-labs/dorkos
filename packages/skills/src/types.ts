import type { SkillFrontmatter } from './schema.js';
import type { ScheduleBlock } from './schedule-schema.js';
import type { CommandFrontmatter } from './command-schema.js';

/** Discriminated parse result. */
export type ParseResult<T> =
  | { ok: true; definition: T }
  | {
      ok: false;
      error: string;
      filePath: string;
      /**
       * Whether `filePath` is genuinely absent from disk, as opposed to
       * present but unusable (unreadable, or malformed frontmatter).
       *
       * Only {@link scanSkillDirectory} sets this, and only when the read
       * failed with ENOENT — it is the one failure that means "this skill is
       * gone". Every other failure, including every failure from
       * {@link parseSkillFile} (which is handed content the caller already
       * read), leaves it absent, because the file is still there.
       *
       * Callers that treat a failure as a deletion MUST check it: a task
       * reconciler that retires rows for missing files would otherwise delete
       * a task, and its whole run history, over a typo in its frontmatter.
       */
      fileMissing?: boolean;
    };

/** Base parsed skill definition. */
export interface SkillDefinition {
  /** Kebab-case identifier (matches directory name). */
  name: string;
  /** Validated frontmatter. */
  meta: SkillFrontmatter;
  /** Markdown body — the agent instructions. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  dirPath: string;
}

/**
 * Parsed scheduled task with location-derived context.
 *
 * The `meta` is an ordinary skill's frontmatter with its `schedule:` block
 * NARROWED to a readable one — which is the whole definition of a scheduled
 * task since DOR-1485: being scheduled is a property of the file, and the block
 * is the property. Before DOR-1486 this carried the legacy shape instead, with
 * the scheduling fields at the top level, and discovery flattened every block
 * back down into it so one store path could serve both roots. There is one
 * shape now, so nothing is flattened and nothing translates.
 */
export interface TaskDefinition extends Omit<SkillDefinition, 'meta'> {
  meta: SkillFrontmatter & { schedule: ScheduleBlock };
  /** Whether the task comes from a project or a global skills root. */
  scope: 'project' | 'global';
  /** Absolute path to the project root (present for project-scoped tasks). */
  projectPath?: string;
}

/** Parsed command definition with invocation metadata. */
export interface CommandDefinition extends Omit<SkillDefinition, 'meta'> {
  meta: CommandFrontmatter;
  /** Namespace prefix (from subdirectory name, if any). */
  namespace?: string;
  /** Full invocation string (e.g., "/frontend:deploy" or "/commit"). */
  fullCommand: string;
}

/**
 * Type guard: checks whether a definition is a TaskDefinition.
 *
 * @param def - Any skill-like definition object
 * @returns True if the definition has the `scope` field characteristic of tasks
 */
export function isTaskDefinition(
  def: SkillDefinition | TaskDefinition | CommandDefinition
): def is TaskDefinition {
  return 'scope' in def;
}

/**
 * Type guard: checks whether a definition is a CommandDefinition.
 *
 * @param def - Any skill-like definition object
 * @returns True if the definition has the `fullCommand` field characteristic of commands
 */
export function isCommandDefinition(
  def: SkillDefinition | TaskDefinition | CommandDefinition
): def is CommandDefinition {
  return 'fullCommand' in def;
}
