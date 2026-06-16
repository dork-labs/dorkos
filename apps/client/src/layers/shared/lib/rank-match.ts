/**
 * Tiered match-and-rank primitive for command palette and file palette filtering.
 *
 * A bare subsequence matcher treats "all query chars appear in order" as the
 * only signal, so an exact name buried in a long string can lose to a loose
 * subsequence hit. This matcher instead classifies each match into a tier —
 * `exact` > `prefix` > `word-boundary` > `substring` > `subsequence` — so strong,
 * intuitive matches always outrank weak ones. The returned `score` folds the
 * tier and a within-tier fine score into a single sortable number: single-field
 * consumers (file palette) can sort by `score` alone, while multi-field consumers
 * (command palette, via {@link ./rank-command}) read `tier` to apply field
 * weighting. `indices` marks the matched characters in `target` for highlighting.
 */

/** Match strength tiers, strongest first. */
export type MatchTier = 'exact' | 'prefix' | 'word-boundary' | 'substring' | 'subsequence';

export interface RankMatchResult {
  /** Whether the query matched the target. */
  match: boolean;
  /** Strongest tier the match satisfies; `null` for no match or an empty query. */
  tier: MatchTier | null;
  /** Sortable relevance score (higher is better); folds tier + within-tier fine score. */
  score: number;
  /** Indices of matched characters in `target`, for highlight rendering. */
  indices: number[];
}

/** Coarse score floor per tier; the fine score (in [0, 1)) ranks within a tier. */
const TIER_WEIGHT: Record<MatchTier, number> = {
  exact: 5,
  prefix: 4,
  'word-boundary': 3,
  substring: 2,
  subsequence: 1,
};

/** Characters that begin a new "word" inside a command or path token. */
const SEPARATORS = new Set(['/', ':', '-', '_', '.', ' ']);

/** True when `index` in `target` starts a new word (after a separator or at a camelCase hump). */
function isWordBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const prev = target[index - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase hump: a non-uppercase char followed by an uppercase letter.
  const cur = target[index];
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase();
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/**
 * Fine score in [0, 1) for contiguous matches: earlier position and higher query
 * coverage of the target rank higher within the same tier.
 */
function contiguousFine(target: string, matchIndex: number, queryLength: number): number {
  const positionScore = 1 / (1 + matchIndex);
  const coverageScore = queryLength / target.length;
  return (positionScore * 0.6 + coverageScore * 0.4) * 0.999;
}

interface Subsequence {
  indices: number[];
  maxRun: number;
}

/** Greedy left-to-right subsequence match (preserves legacy index semantics). */
function matchSubsequence(query: string, target: string): Subsequence | null {
  let qi = 0;
  let run = 0;
  let maxRun = 0;
  const indices: number[] = [];
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
      run++;
      if (run > maxRun) maxRun = run;
      indices.push(ti);
    } else {
      run = 0;
    }
  }
  return qi === query.length ? { indices, maxRun } : null;
}

/** Fine score in [0, 1) for subsequence matches: reward clustering and compactness. */
function subsequenceFine(target: string, sub: Subsequence): number {
  const span = sub.indices[sub.indices.length - 1] - sub.indices[0] + 1;
  const clusterScore = sub.maxRun / sub.indices.length;
  const compactness = sub.indices.length / span;
  const coverageScore = sub.indices.length / target.length;
  return (clusterScore * 0.4 + compactness * 0.3 + coverageScore * 0.3) * 0.999;
}

/**
 * Match `query` against `target` and classify the result into a ranking tier.
 *
 * Matching is case-insensitive; `indices` are positions in the original `target`.
 * An empty query matches everything with a neutral score (`tier: null`).
 *
 * @param query - The text to search for.
 * @param target - The string to search within.
 */
export function rankMatch(query: string, target: string): RankMatchResult {
  if (!query) return { match: true, tier: null, score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (t === q) {
    return {
      match: true,
      tier: 'exact',
      score: 5 + contiguousFine(target, 0, q.length),
      indices: range(0, q.length),
    };
  }

  if (t.startsWith(q)) {
    return {
      match: true,
      tier: 'prefix',
      score: 4 + contiguousFine(target, 0, q.length),
      indices: range(0, q.length),
    };
  }

  for (let i = 1; i <= t.length - q.length; i++) {
    if (isWordBoundary(target, i) && t.startsWith(q, i)) {
      return {
        match: true,
        tier: 'word-boundary',
        score: TIER_WEIGHT['word-boundary'] + contiguousFine(target, i, q.length),
        indices: range(i, q.length),
      };
    }
  }

  const substringIndex = t.indexOf(q);
  if (substringIndex >= 0) {
    return {
      match: true,
      tier: 'substring',
      score: TIER_WEIGHT.substring + contiguousFine(target, substringIndex, q.length),
      indices: range(substringIndex, q.length),
    };
  }

  const sub = matchSubsequence(q, t);
  if (sub) {
    return {
      match: true,
      tier: 'subsequence',
      score: TIER_WEIGHT.subsequence + subsequenceFine(target, sub),
      indices: sub.indices,
    };
  }

  return { match: false, tier: null, score: 0, indices: [] };
}
