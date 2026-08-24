import { SkillFrontmatterSchema } from './schema.js';
import type { SkillFrontmatter } from './schema.js';

/**
 * @deprecated Commands merged into skills. Use `SkillFrontmatterSchema` from
 * `@dorkos/skills/schema` — it is the same object: every field this schema
 * used to add on its own (`argument-hint`, `context`, `agent`, `model`,
 * `effort`) now lives on the base, because a command *is* a skill (ADR
 * `260823-200728`). This alias exists so existing imports keep compiling and
 * will be removed once they move.
 *
 * One behavior went with the merge: this schema used to materialize
 * `user-invocable: true` when the field was absent. The base leaves it absent
 * and answers the question through `isUserInvocable()`, which reads absence as
 * yes. Its one consumer — `CommandRegistryService` — already reads the raw
 * frontmatter through that predicate (its `.partial()` parse stripped the
 * default anyway), so nothing a person can see changed.
 */
export const CommandFrontmatterSchema = SkillFrontmatterSchema;

/**
 * @deprecated Use `SkillFrontmatter` from `@dorkos/skills/schema`.
 * See {@link CommandFrontmatterSchema}.
 */
export type CommandFrontmatter = SkillFrontmatter;
