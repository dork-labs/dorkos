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
 * Every frontmatter key `SkillFrontmatterSchema` itself declares that is not a
 * base field — layer 2 plus `schedule` and `kind`.
 *
 * Read off the schema's own shape rather than spelled a second time, so a field
 * the schema gains tomorrow moves between the two refusal sentences on its own:
 * a key in here is one DorkOS can say only Claude Code understands, and a key
 * outside it — a typo, a third-party extension — is one DorkOS can say nothing
 * about at all.
 */
export const SCHEMA_DECLARED_NON_BASE_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(SkillFrontmatterSchema.shape).filter(
    (field) => !(AGENTSKILLS_BASE_FIELDS as readonly string[]).includes(field)
  )
);

/** Why a candidate is not safe to share, or that it is. */
export type AllowlistVerdict =
  | { readonly safe: true }
  /** The body carries a `${CLAUDE_…}` token. */
  | { readonly safe: false; readonly why: 'body-token' }
  /** Every offending key is one the schema declares, so it is Claude Code's dialect. */
  | { readonly safe: false; readonly why: 'claude-field'; readonly fields: readonly string[] }
  /** At least one offending key is one DorkOS has never heard of. */
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

  // Every offending key known to the schema means DorkOS can name the tool that
  // understands them. One it cannot name makes that claim false for the whole
  // list, so the weaker sentence — "DorkOS doesn't recognise" — is the honest one.
  const why = fields.every((field) => SCHEMA_DECLARED_NON_BASE_FIELDS.has(field))
    ? 'claude-field'
    : 'unknown-field';
  return { safe: false, why, fields };
}
