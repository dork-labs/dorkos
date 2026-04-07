/**
 * Pure keyword + tag recommendation engine for marketplace entries.
 *
 * Scores `marketplace.json` plugin entries against a free-text context
 * description. Used by the `marketplace_recommend` MCP tool to surface
 * relevant packages without ML or external infrastructure.
 *
 * Scoring is intentionally simple — keyword + tag matching for v1. Per the
 * spec non-goals, ML-based recommendations are deferred.
 *
 * @module services/marketplace-mcp/recommend-engine
 */

import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

/**
 * A single scored recommendation result returned by {@link recommend}.
 */
export interface ScoredRecommendation {
  /** The original marketplace entry that was scored. */
  entry: MarketplaceJsonEntry;
  /** Source marketplace name (e.g., `community`, `personal`). */
  marketplace: string;
  /** Aggregate relevance score; higher is more relevant. */
  score: number;
  /** Human-readable explanation of why the entry matched. */
  reason: string;
}

/**
 * Stopwords removed during tokenization. Kept intentionally small — the goal
 * is to drop function words that contribute no semantic signal, not to do
 * full NLP normalization.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'in',
  'on',
  'of',
  'for',
  'and',
  'to',
  'my',
  'is',
  'it',
  'with',
  'that',
  'this',
  'i',
  'me',
  'we',
  'us',
  'or',
  'be',
  'as',
  'at',
]);

/** Minimum length for a token to be retained. */
const MIN_TOKEN_LENGTH = 3;

/** Score awarded when a context token appears in an entry's name. */
const NAME_MATCH_WEIGHT = 10;

/** Score awarded when a context token appears in an entry's description. */
const DESCRIPTION_MATCH_WEIGHT = 3;

/** Score awarded when a context token exactly equals one of an entry's tags. */
const TAG_MATCH_WEIGHT = 5;

/** Boost applied when an entry is marked `featured: true`. */
const FEATURED_BOOST = 2;

/** Maximum number of reason fragments concatenated into the result. */
const MAX_REASON_FRAGMENTS = 3;

/**
 * Tokenize a free-text context string into lowercase keywords. Strips
 * punctuation, removes stopwords, and drops tokens shorter than three
 * characters. Hyphenated tokens (e.g., `next-js`) and alphanumeric tokens
 * (e.g., `v16`) are preserved as single units.
 *
 * @param context - Free-text input to tokenize
 * @returns Ordered list of normalized tokens
 */
export function tokenize(context: string): string[] {
  return context
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
}

/**
 * Score marketplace entries against a free-text context. Higher score means
 * more relevant. Returns at most `limit` entries sorted by score descending;
 * entries with score zero are filtered out.
 *
 * Scoring weights:
 * - Name token match: +10 per token
 * - Description token match: +3 per token
 * - Exact tag match: +5 per match
 * - Featured boost: +2
 *
 * @param entries - Marketplace entries paired with their source marketplace name
 * @param context - Free-text description of the user's need
 * @param limit - Maximum number of recommendations to return
 * @returns Scored recommendations sorted by descending relevance
 */
export function recommend(
  entries: { entry: MarketplaceJsonEntry; marketplace: string }[],
  context: string,
  limit: number
): ScoredRecommendation[] {
  const tokens = tokenize(context);
  if (tokens.length === 0) return [];

  const scored = entries.map(({ entry, marketplace }) => scoreEntry(entry, marketplace, tokens));

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Score a single entry against the tokenized context. Extracted from
 * {@link recommend} to keep the public function under the complexity budget.
 */
function scoreEntry(
  entry: MarketplaceJsonEntry,
  marketplace: string,
  tokens: string[]
): ScoredRecommendation {
  let score = 0;
  const reasons: string[] = [];

  const name = entry.name.toLowerCase();
  for (const token of tokens) {
    if (name.includes(token)) {
      score += NAME_MATCH_WEIGHT;
      reasons.push(`name matches "${token}"`);
    }
  }

  const description = (entry.description ?? '').toLowerCase();
  for (const token of tokens) {
    if (description.includes(token)) {
      score += DESCRIPTION_MATCH_WEIGHT;
      reasons.push(`description matches "${token}"`);
    }
  }

  for (const tag of entry.tags ?? []) {
    const tagLower = tag.toLowerCase();
    for (const token of tokens) {
      if (tagLower === token) {
        score += TAG_MATCH_WEIGHT;
        reasons.push(`tag "${tag}"`);
      }
    }
  }

  if (entry.featured) {
    score += FEATURED_BOOST;
  }

  return {
    entry,
    marketplace,
    score,
    reason: reasons.slice(0, MAX_REASON_FRAGMENTS).join(', '),
  };
}
