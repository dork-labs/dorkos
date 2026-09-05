import { createFromSource } from 'fumadocs-core/search/server';

/**
 * Options accepted by the docs search server.
 *
 * Derived from the library rather than hand-written so a fumadocs upgrade that
 * renames a knob fails typecheck instead of silently un-tuning search.
 */
type DocsSearchOptions = NonNullable<Parameters<typeof createFromSource>[1]>;

/**
 * One row of the search index: a page title, a heading, or a paragraph.
 *
 * The engine indexes a documentation page as many small rows and scores each on
 * its own, which is why `type` is the only thing that says whether a hit is the
 * page's own name or a sentence buried in it.
 */
interface IndexedRow {
  type?: unknown;
}

/**
 * English stop words, stripped from both the index and the query.
 *
 * The engine ships no list of its own and defaults to stripping nothing, so
 * every "how", "does" and "the" was a real, scoring word. That is why a
 * five-word question matched a large share of the docs.
 */
const ENGLISH_STOP_WORDS = [
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
];

/**
 * How many rows a search returns when the caller does not ask for a number.
 *
 * The engine groups rows by page and then flattens them, and that flattening
 * had no ceiling: a two-word keyword returned about 19 KB while a five-word
 * question returned about 320 KB. Every row carries a whole highlighted
 * paragraph, so the cap is what keeps an answer cheap on a phone and cheap in
 * an agent's context window.
 */
export const DEFAULT_SEARCH_LIMIT = 30;

/**
 * The most rows a caller may ask for with `?limit=`.
 */
export const MAX_SEARCH_LIMIT = 60;

/**
 * How many rows one page may contribute to a single answer.
 *
 * A long reference page mentions a term in a dozen places. Left uncapped, that
 * one page fills the answer and the page that actually explains the term never
 * gets a line.
 *
 * A page also always contributes its own title row, so the real ceiling per
 * page is this number plus one.
 */
export const MAX_ROWS_PER_PAGE = 3;

/**
 * Extra weight for a row that is a page's own title.
 *
 * A page called "Relay" is the answer to "relay"; a page that happens to say
 * "relay" in twenty paragraphs is not. Relevance scoring cannot tell the two
 * apart, because it scores each row alone and a long page simply gets more
 * chances to win.
 */
const TITLE_MATCH_WEIGHT = 6;

/** Extra weight for a row that is a heading inside a page. */
const HEADING_MATCH_WEIGHT = 2;

/**
 * Re-weight a row's relevance score by which part of a page it came from.
 *
 * @param score - The engine's relevance score for the row.
 * @param row - The indexed row the score belongs to.
 */
function weighRow(score: number, row: IndexedRow | undefined): number {
  if (row?.type === 'page') return score * TITLE_MATCH_WEIGHT;
  if (row?.type === 'heading') return score * HEADING_MATCH_WEIGHT;
  return score;
}

/**
 * Search settings for the documentation index.
 *
 * Everything here is a setting the engine already had and nobody had turned on:
 * stemming (so "scheduling" finds what "schedule" finds), a one-letter typo
 * budget, stop words, a per-page row cap, and title weighting so a concept page
 * can win its own topic.
 */
export const docsSearchOptions = {
  tokenizer: {
    language: 'english',
    stemming: true,
    stopWords: ENGLISH_STOP_WORDS,
  },
  search: {
    tolerance: 1,
    groupBy: {
      properties: ['page_id'],
      maxResult: MAX_ROWS_PER_PAGE,
    },
    sortBy: (a, b) => weighRow(b[1], b[2]) - weighRow(a[1], a[2]),
  },
} satisfies DocsSearchOptions;

/**
 * Resolve the `?limit=` query parameter into a row count.
 *
 * @param raw - The raw parameter value, or null when the caller omitted it.
 */
export function resolveSearchLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (raw === null || !Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(parsed, MAX_SEARCH_LIMIT);
}
