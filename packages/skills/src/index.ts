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
export {
  SkillFrontmatterSchema,
  SkillKindSchema,
  SkillNameSchema,
  isUserInvocable,
  isModelInvocable,
  readYamlBoolean,
} from './schema.js';
export type { SkillFrontmatter, SkillKind } from './schema.js';

export {
  ScheduleBlockSchema,
  TASK_PERMISSION_MODES,
  describeScheduleBlockProblem,
  hasSchedule,
  isInvalidSchedule,
  readScheduleField,
  scheduleProblem,
  scheduleToFrontmatter,
} from './schedule-schema.js';
export type { InvalidSchedule, ScheduleBlock, ScheduleField } from './schedule-schema.js';

export { TaskFrontmatterSchema, legacyTaskToSchedule } from './task-schema.js';
export type { TaskFrontmatter } from './task-schema.js';

export { CommandFrontmatterSchema } from './command-schema.js';
export type { CommandFrontmatter } from './command-schema.js';

export { WidgetTemplateSchema } from './ui-template.js';
export type { WidgetTemplate, WidgetDocumentTemplate } from './ui-template.js';

// Types
export type { ParseResult, SkillDefinition, TaskDefinition, CommandDefinition } from './types.js';
export { isTaskDefinition, isCommandDefinition } from './types.js';

// Re-export consumer-facing types from Node.js-only modules so callers
// can reference them without subpath imports for type annotations.
export type { ParsedSkill } from './parser.js';
export type { ValidationResult } from './validator.js';
export type { UiTemplateScanResult } from './scanner.js';

// Constants
export {
  SKILL_FILENAME,
  SKILL_SUBDIRS,
  WIDGET_TEMPLATE_SUFFIX,
  skillFilePath,
  skillDirPath,
} from './constants.js';

// Utilities
export { validateSlug, slugify, humanize } from './slug.js';
export { DurationSchema, parseDuration, formatDuration } from './duration.js';
