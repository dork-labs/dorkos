/**
 * @dorkos/skills — Browser-safe barrel export.
 *
 * Re-exports schemas, types, constants, and utilities that have no
 * Node.js dependencies. Node.js-only modules (parser, writer, scanner,
 * validator) must be imported via their subpath exports:
 *
 *   import { parseSkillFile } from '@dorkos/skills/parser';
 *   import { writeSkillFile } from '@dorkos/skills/writer';
 *   import { scanSkillDirectory } from '@dorkos/skills/scanner';
 *   import { validateSkillStructure } from '@dorkos/skills/validator';
 */

// Schemas
export { SkillFrontmatterSchema, SkillKindSchema, SkillNameSchema } from './schema.js';
export type { SkillFrontmatter, SkillKind } from './schema.js';

export { TaskFrontmatterSchema } from './task-schema.js';
export type { TaskFrontmatter } from './task-schema.js';

export { CommandFrontmatterSchema } from './command-schema.js';
export type { CommandFrontmatter } from './command-schema.js';

// Types
export type { ParseResult, SkillDefinition, TaskDefinition, CommandDefinition } from './types.js';
export { isTaskDefinition, isCommandDefinition } from './types.js';

// Re-export consumer-facing types from Node.js-only modules so callers
// can reference them without subpath imports for type annotations.
export type { ParsedSkill } from './parser.js';
export type { ValidationResult } from './validator.js';

// Constants
export { SKILL_FILENAME, SKILL_SUBDIRS, skillFilePath, skillDirPath } from './constants.js';

// Utilities
export { validateSlug, slugify, humanize } from './slug.js';
export { DurationSchema, parseDuration, formatDuration } from './duration.js';
