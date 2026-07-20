/**
 * Static, themed agent-name suggestions with a reroll (v1).
 *
 * Model-generated names are a later non-goal. For now each template resolves
 * to a themed pool of evocative agent names by keyword-matching its slug,
 * description, and tags; design-your-own falls back to a general pool. The
 * naming step shows a rotating window of the pool and rerolls by advancing the
 * offset.
 *
 * @module features/agent-creation/lib/name-suggestions
 */

/** Signals used to pick a themed suggestion pool for a template. */
export interface SuggestionContext {
  /** Package slug (e.g. `@dorkos/code-reviewer`). */
  name?: string;
  /** What the agent does. */
  description?: string;
  /** Primary category. */
  category?: string;
  /** Searchable tags/keywords. */
  tags?: string[];
}

/** A named theme whose pool of agent names shares a flavor. */
type SuggestionTheme = 'keeper' | 'scout' | 'guardian' | 'builder' | 'scribe' | 'default';

const POOLS: Record<SuggestionTheme, readonly string[]> = {
  keeper: ['Keeper', 'Warden', 'Steward', 'Curator', 'Archivist', 'Ledger', 'Tally', 'Sorter'],
  scout: ['Scout', 'Ranger', 'Pathfinder', 'Lookout', 'Recon', 'Probe', 'Tracer', 'Radar'],
  guardian: ['Sentinel', 'Guardian', 'Aegis', 'Bastion', 'Vigil', 'Auditor', 'Gatekeep', 'Warden'],
  builder: ['Forge', 'Smith', 'Builder', 'Mason', 'Wright', 'Maker', 'Anvil', 'Crafter'],
  scribe: ['Scribe', 'Quill', 'Muse', 'Author', 'Penn', 'Bard', 'Editor', 'Note'],
  default: ['Scout', 'Sage', 'Pilot', 'Beacon', 'Atlas', 'Nova', 'Ranger', 'Echo', 'Vera', 'Onyx'],
};

/** Keyword groups that map a template's signals onto a theme. First hit wins. */
const THEME_KEYWORDS: [SuggestionTheme, readonly string[]][] = [
  [
    'keeper',
    ['board', 'organize', 'tidy', 'manage', 'linear', 'jira', 'project', 'backlog', 'task'],
  ],
  [
    'scout',
    [
      'research',
      'search',
      'monitor',
      'watch',
      'discover',
      'scan',
      'find',
      'intel',
      'inbox',
      'email',
      'mail',
    ],
  ],
  [
    'guardian',
    ['review', 'security', 'audit', 'qa', 'test', 'lint', 'guard', 'protect', 'compliance'],
  ],
  ['builder', ['build', 'code', 'scaffold', 'deploy', 'engineer', 'refactor', 'ci', 'release']],
  ['scribe', ['doc', 'write', 'content', 'blog', 'summar', 'note', 'changelog', 'copy']],
];

/**
 * Resolve which themed pool best fits a template's signals. Design-your-own
 * (no context) resolves to the default pool.
 *
 * @param context - Template signals, or undefined for design-your-own.
 */
export function resolveSuggestionPool(context?: SuggestionContext): readonly string[] {
  if (!context) return POOLS.default;
  const haystack = [context.name, context.description, context.category, ...(context.tags ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  for (const [theme, keywords] of THEME_KEYWORDS) {
    if (keywords.some((kw) => haystack.includes(kw))) return POOLS[theme];
  }
  return POOLS.default;
}

/**
 * A rotating window of `count` suggestions from a pool. Wraps around so reroll
 * cycles through the whole pool without ever showing an empty list.
 *
 * @param pool - The resolved suggestion pool.
 * @param offset - How many reroll steps have advanced.
 * @param count - Window size (how many chips to show).
 */
export function suggestionWindow(pool: readonly string[], offset: number, count: number): string[] {
  if (pool.length === 0) return [];
  const size = Math.min(count, pool.length);
  const start = ((offset % pool.length) + pool.length) % pool.length;
  return Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]);
}
