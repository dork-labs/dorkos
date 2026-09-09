/**
 * The one place that decides what "safe to share" means.
 *
 * A skill moved into `.agents/skills` is read by every agent tool the moment it
 * lands there, and the move cannot be taken back by a manifest entry — SK-04
 * only fires while the skill is still in `.claude/skills`. So the question is
 * asked as an ALLOWLIST rather than as a denylist of Claude-only fields: a
 * denylist has to be extended every time a vendor ships a field on a Tuesday and
 * its failure direction when nobody does is *moved anyway*, while an allowlist's
 * is *reported and left alone* — which is the answer a person can still act on.
 *
 * Both clauses read the file **as written**. `SkillFrontmatterSchema` strips a
 * key it does not know and degrades a value it cannot read, and both are right
 * for their own callers — one unreadable enum must not delete a person's skill
 * from the product — and catastrophic here: a `hooks:` block in a `SKILL.md`
 * frontmatter is a real thing Claude Code runs and a real thing DorkOS's own
 * inventory reads (HK-12), and the parsed object does not have it. A predicate
 * built on the parsed object sees a clean six-key skill and moves a file that
 * runs shell commands.
 *
 * What this deliberately does NOT check is whether the body mentions
 * `/reload-plugins` or any other Claude-Code-only instruction in prose. That is
 * unbounded, and a substring hunt through English would refuse skills that
 * merely MENTION Claude Code. Both clauses here are mechanical facts about the
 * file; anything softer belongs to a person's judgement, which is what the
 * explicit command is for.
 *
 * @module adopt/allowlist
 */
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import type { AdoptCandidate } from './types.js';

/**
 * The agentskills.io base frontmatter fields — layer 1 of
 * `SkillFrontmatterSchema`.
 *
 * A skill whose frontmatter holds only these is one every agent tool can read
 * the same way. Layers 2 (Claude Code's dialect, adopted verbatim) and 3 (the
 * DorkOS `schedule:` block) are exactly the things a move would hand to a tool
 * that does not implement them.
 */
export const AGENTSKILLS_BASE_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;

/** The substring that makes a body Claude-Code-shaped, whatever the token is called. */
export const CLAUDE_TOKEN_PREFIX = '${CLAUDE_';

/**
 * The fields that are DorkOS's own — not part of the open standard, and not
 * Claude Code's either.
 *
 * Spelled out rather than derived, because the schema cannot tell them apart
 * from Claude Code's dialect: all three layers share one shape. `schedule` is
 * the one with a running consequence (the scheduler watches `.agents/skills`
 * and never `.claude/skills`, `services/tasks/skills-roots.ts`), and `kind` is
 * a marketplace-author discriminator (ADR-0229). Saying "only Claude Code
 * understands" about either would be false in the one direction that matters:
 * it is DorkOS, not Claude Code, that acts on them.
 */
export const DORKOS_OWN_FIELDS = ['schedule', 'kind'] as const;

/**
 * Claude Code frontmatter fields the DorkOS schema does not have at all.
 *
 * `hooks` is the whole reason this predicate reads RAW frontmatter: Claude Code
 * registers those hooks the moment the skill is invoked, DorkOS's own inventory
 * reads them (HK-12), and `SkillFrontmatterSchema` strips the key. A key the
 * schema never declares would otherwise fall through to "DorkOS doesn't
 * recognise it" — which is false about a field DorkOS demonstrably reads, and
 * which contradicted the manifest line the same run writes.
 */
export const CLAUDE_ONLY_EXTRA_FIELDS = ['hooks'] as const;

/**
 * Every frontmatter key that belongs to Claude Code's dialect — layer 2 of
 * `SkillFrontmatterSchema`, plus the keys the schema does not model.
 *
 * Layer 2 is read off the schema's own shape rather than spelled a second time,
 * so a dialect field the schema gains tomorrow classifies itself. The two
 * corrections around it are explicit because the shape gets them wrong in both
 * directions: {@link DORKOS_OWN_FIELDS} are in the shape and are not Claude
 * Code's, and {@link CLAUDE_ONLY_EXTRA_FIELDS} are Claude Code's and are not in
 * the shape.
 */
export const CLAUDE_DIALECT_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(SkillFrontmatterSchema.shape).filter(
    (field) =>
      !(AGENTSKILLS_BASE_FIELDS as readonly string[]).includes(field) &&
      !(DORKOS_OWN_FIELDS as readonly string[]).includes(field)
  ),
  ...CLAUDE_ONLY_EXTRA_FIELDS,
]);

/** Why a candidate is not safe to share, or that it is. */
export type AllowlistVerdict =
  | { readonly safe: true }
  /** The body carries a `${CLAUDE_…}` token. */
  | { readonly safe: false; readonly why: 'body-token' }
  /** Every offending key belongs to Claude Code's dialect. */
  | { readonly safe: false; readonly why: 'claude-field'; readonly fields: readonly string[] }
  /** Every offending key is one of DorkOS's own. */
  | { readonly safe: false; readonly why: 'dorkos-field'; readonly fields: readonly string[] }
  /** The offending keys are a mix, or at least one belongs to nobody DorkOS knows. */
  | { readonly safe: false; readonly why: 'unknown-field'; readonly fields: readonly string[] };

/**
 * Whether a skill may be handed to every agent tool, and what makes it not.
 *
 * The body is asked first: a `${CLAUDE_…}` token is a fact about the text and
 * stays the answer whatever the frontmatter holds, because moving the file hands
 * five tools a path none of them fills in.
 *
 * @param candidate - the skill, as the reader read it off disk.
 * @returns the verdict, naming the offending keys in the order the author wrote
 *   them when the frontmatter is what is wrong.
 */
export function allowlistVerdict(
  candidate: Pick<AdoptCandidate, 'frontmatterKeys' | 'bodyHasClaudeToken'>
): AllowlistVerdict {
  if (candidate.bodyHasClaudeToken) return { safe: false, why: 'body-token' };

  const base: readonly string[] = AGENTSKILLS_BASE_FIELDS;
  const fields = candidate.frontmatterKeys.filter((key) => !base.includes(key));
  if (fields.length === 0) return { safe: true };

  // A sentence naming a tool is only honest when EVERY key it names belongs to
  // that tool. A mixed list gets the weaker one, which claims nothing about who
  // understands what and still names every key the person has to take out.
  const dorkos: readonly string[] = DORKOS_OWN_FIELDS;
  if (fields.every((field) => CLAUDE_DIALECT_FIELDS.has(field)))
    return { safe: false, why: 'claude-field', fields };
  if (fields.every((field) => dorkos.includes(field)))
    return { safe: false, why: 'dorkos-field', fields };
  return { safe: false, why: 'unknown-field', fields };
}
