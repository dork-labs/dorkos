import { z } from 'zod';
import { SkillFrontmatterSchema, readYamlBoolean } from './schema.js';

/**
 * Command frontmatter schema — a superset of the SKILL.md base.
 *
 * Aligns with Claude Code's slash command extensions on top of the
 * agentskills.io base spec.
 */
export const CommandFrontmatterSchema = SkillFrontmatterSchema.extend({
  /** Parameter hint shown in autocomplete (e.g., "[issue-number]"). */
  'argument-hint': z.string().optional(),

  /**
   * Whether this command appears in the `/` menu. Default: true.
   *
   * Narrows the base schema's optional field to a materialized default: a
   * command palette needs a concrete answer per entry, where a plain skill
   * read can leave "absent means yes" implicit. It reads the same YAML 1.1
   * boolean words the base does (`no`, `off`, a quoted `"false"`), so the two
   * dialects never disagree about the same file, and an unreadable value
   * falls back to visible rather than failing the parse.
   */
  'user-invocable': z
    .preprocess((v) => readYamlBoolean(v) ?? v, z.boolean())
    .default(true)
    .catch(true),

  /** Execution context. "fork" runs in an isolated subagent. */
  context: z.enum(['fork']).optional(),

  /** Subagent type when context is "fork". */
  agent: z.string().optional(),

  /** Model override for this command's execution. */
  model: z.string().optional(),

  /** Effort level override. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
});

export type CommandFrontmatter = z.infer<typeof CommandFrontmatterSchema>;
