import { z } from 'zod';

/**
 * SKILL.md name field validation.
 *
 * Per the agentskills.io spec:
 * - 1-64 characters
 * - Lowercase alphanumeric and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 * - Must match the parent directory name (enforced at parse time, not in schema)
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen'
  )
  .refine((s) => !s.includes('--'), 'Must not contain consecutive hyphens');

/**
 * Discriminator values for SKILL.md frontmatter.
 *
 * Per ADR-0220 (addendum) and ADR-0229, marketplace package authors SHOULD
 * declare `kind` explicitly so installers and validators do not need to fall
 * back to location-based or shape-based inference. User-authored files MAY
 * omit this field — inference rules apply (cron → task, commands/ → command,
 * otherwise → skill).
 *
 * The enum is intentionally narrow today; future kinds (e.g., `mcp-tool`,
 * `hook`) can be added without breaking existing files because the field
 * remains optional.
 *
 * @see decisions/0220-adopt-skill-md-open-standard.md
 * @see decisions/0229-skill-md-kind-discriminator-field.md
 */
export const SkillKindSchema = z.enum(['skill', 'task', 'command']);

/** Discriminator value for SKILL.md frontmatter. */
export type SkillKind = z.infer<typeof SkillKindSchema>;

/**
 * Base SKILL.md frontmatter schema.
 *
 * Conforms to the agentskills.io open standard. All DorkOS-specific
 * schemas (tasks, commands) extend this base.
 *
 * @see https://agentskills.io/specification#skill-md-format
 */
export const SkillFrontmatterSchema = z.object({
  /** Kebab-case identifier. Must match the parent directory name. */
  name: SkillNameSchema,

  /** What the skill does and when to use it. 1-1024 characters. */
  description: z.string().min(1).max(1024),

  /** License name or reference to a bundled license file. */
  license: z.string().optional(),

  /** Environment requirements (intended product, system packages, network access). */
  compatibility: z.string().max(500).optional(),

  /** Arbitrary key-value metadata for client-specific extensions. */
  metadata: z.record(z.string(), z.string()).optional(),

  /** Space-delimited list of pre-approved tools. */
  'allowed-tools': z.string().optional(),

  /**
   * Optional discriminator declaring whether this file is a skill, task, or
   * command. Marketplace packages SHOULD set this explicitly; user-authored
   * files MAY omit it and rely on location-based inference. See ADR-0229.
   */
  kind: SkillKindSchema.optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
