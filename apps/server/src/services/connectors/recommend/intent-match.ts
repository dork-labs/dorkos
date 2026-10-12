/**
 * Match a plain task description ("let the team know the deploy is done") to
 * the catalog services that could do it, best first.
 *
 * Deliberately small and explainable: no model, no network. Two signals score
 * a service:
 *
 * - **its name** — a word of the description is its id, or a whole word of its
 *   name. A name word shared by many apps ("google", "microsoft") counts for
 *   less the more apps share it, and a name that is an everyday word ("Close",
 *   "Monday", "Help Scout") or one of the shelf words below only nudges: it can
 *   break a tie but never outweighs a shelf hit, so "close the ticket" finds a
 *   task tracker, not the Close CRM.
 * - **its shelf** (`category`, set for the built-in popular apps) — the
 *   description uses a word that points at that kind of app. Some words are
 *   too ambiguous to decide on their own ("file", "issue", "schedule") and count
 *   only beside a second word for the same shelf.
 *
 * A service needs {@link MIN_SCORE} to be returned at all. A description that
 * names nothing and points at no shelf matches nothing — the result is then
 * empty, never a padded guess.
 *
 * @module services/connectors/recommend/intent-match
 */
import type {
  ConnectorCatalogCategory,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';

/**
 * Words that point at a catalog shelf on their own, in singular form. Each
 * word maps to one shelf, so a word never lifts two kinds of app at once.
 */
export const INTENT_CATEGORY_KEYWORDS: Readonly<
  Record<ConnectorCatalogCategory, readonly string[]>
> = {
  email: ['email', 'mail', 'inbox', 'newsletter', 'unread'],
  calendar: ['calendar', 'meeting', 'appointment', 'availability', 'agenda'],
  chat: [
    'chat',
    'message',
    'messaging',
    'notify',
    'notification',
    'ping',
    'team',
    'channel',
    'dm',
    'announce',
    'announcement',
    'standup',
  ],
  docs: ['doc', 'document', 'note', 'wiki', 'spreadsheet', 'sheet', 'database'],
  files: ['folder', 'upload', 'download', 'storage', 'attachment', 'pdf'],
  code: ['code', 'repo', 'repository', 'commit', 'branch'],
  tasks: ['task', 'todo', 'ticket', 'bug', 'backlog', 'sprint'],
  sales: ['crm', 'deal', 'customer', 'prospect'],
  developer: [],
};

/**
 * Shelf words too ambiguous to decide alone ("file a bug", "an issue with the
 * invoice"): each counts half, so a shelf needs a second word to reach it.
 */
export const INTENT_WEAK_CATEGORY_KEYWORDS: Readonly<
  Partial<Record<ConnectorCatalogCategory, readonly string[]>>
> = {
  calendar: ['event', 'schedule'],
  docs: ['page', 'table'],
  files: ['file'],
  code: ['pull', 'pr'],
  tasks: ['issue', 'project'],
  sales: ['contact', 'lead', 'pipeline'],
};

/** Words too common to name a service on their own. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'done',
  'for',
  'from',
  'get',
  'i',
  'in',
  'is',
  'it',
  'know',
  'let',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'the',
  'this',
  'to',
  'up',
  'we',
  'with',
  'you',
  'your',
]);

/**
 * Everyday words that are also app names. A description using one is far more
 * likely to mean the word than the app, so they only nudge a score.
 */
const EVERYDAY_WORDS = new Set([
  ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  ...['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august'],
  ...['september', 'october', 'november', 'december', 'today', 'tomorrow', 'week'],
  ...['help', 'close', 'check', 'agent', 'report', 'update', 'status', 'write'],
  ...['read', 'send', 'post', 'box', 'front', 'buffer', 'call', 'share', 'list'],
  ...['time', 'work', 'plan', 'base', 'hub', 'flow', 'form', 'site'],
]);

/** Points for each signal; see the module doc for how they combine. */
const SCORE = { slug: 4, nameWord: 3, nudge: 1, category: 2, weakCategory: 1 } as const;

/** The least score a returned service needs: one shelf hit or one clear name. */
const MIN_SCORE = 2;

/**
 * Split text into lower-case letter-and-digit words.
 *
 * @param text - Any text.
 */
export function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A word in lookup form: singular when it was a plain plural (stopwords kept as they are). */
function normalize(word: string): string {
  if (STOPWORDS.has(word)) return word;
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** The meaningful words of a text, in lookup form, in order. */
function words(text: string): string[] {
  return splitWords(text)
    .map(normalize)
    .filter((word) => !STOPWORDS.has(word));
}

function shelfMap(
  table: Readonly<Partial<Record<ConnectorCatalogCategory, readonly string[]>>>
): ReadonlyMap<string, ConnectorCatalogCategory> {
  return new Map(
    (Object.entries(table) as Array<[ConnectorCatalogCategory, string[]]>).flatMap(
      ([category, keywords]) => keywords.map((keyword) => [keyword, category] as const)
    )
  );
}

const STRONG_SHELF = shelfMap(INTENT_CATEGORY_KEYWORDS);
const WEAK_SHELF = shelfMap(INTENT_WEAK_CATEGORY_KEYWORDS);

/** True for a word that names an app only by coincidence. */
function onlyNudges(word: string): boolean {
  return (
    STOPWORDS.has(word) ||
    EVERYDAY_WORDS.has(word) ||
    STRONG_SHELF.has(word) ||
    WEAK_SHELF.has(word)
  );
}

/** One catalog service the description points at, with why. */
export interface IntentMatch {
  /** The matched catalog service. */
  service: ConnectorCatalogService;
  /** Higher is a better match; at least {@link MIN_SCORE}. */
  score: number;
  /** What matched: the service's name, its shelf, or both. */
  matchedBy: Array<'name' | 'category'>;
}

/** Ranking hints beside the description itself. */
export interface IntentMatchOptions {
  /** Service ids to put first among equal scores, such as apps the caller already has. */
  preferred?: ReadonlySet<string>;
}

/** How much each shelf the description points at counts, at most a full shelf hit. */
function shelfScores(tokens: readonly string[]): Map<ConnectorCatalogCategory, number> {
  const scores = new Map<ConnectorCatalogCategory, number>();
  for (const token of new Set(tokens)) {
    const strong = STRONG_SHELF.get(token);
    const weak = WEAK_SHELF.get(token);
    const category = strong ?? weak;
    if (!category) continue;
    const add = strong ? SCORE.category : SCORE.weakCategory;
    scores.set(category, Math.min(SCORE.category, (scores.get(category) ?? 0) + add));
  }
  return scores;
}

/**
 * Score catalog services against a plain task description and return the best
 * few, best first. Equal scores go to preferred apps, then popular ones, then
 * catalog order.
 *
 * @param intent - What the person wants done, in their own words.
 * @param services - Catalog services to choose from, in catalog order.
 * @param limit - The most matches to return.
 * @param options - Ranking hints; see {@link IntentMatchOptions}.
 * @returns Matches scoring at least {@link MIN_SCORE}, at most `limit`; empty when nothing fits.
 */
export function matchServicesToIntent(
  intent: string,
  services: readonly ConnectorCatalogService[],
  limit: number,
  options: IntentMatchOptions = {}
): IntentMatch[] {
  const tokens = words(intent);
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);
  // Adjacent pairs catch a two-word name written apart ("google calendar").
  const joined = new Set(tokens.slice(1).map((token, index) => `${tokens[index]}${token}`));
  const shelves = shelfScores(tokens);

  const nameWordsOf = services.map((service) =>
    [...new Set(words(service.displayName))].filter((word) => word.length >= 3)
  );
  // How many apps share each name word: "google" names many, so it says little.
  const sharedBy = new Map<string, number>();
  for (const nameWords of nameWordsOf) {
    for (const word of nameWords) sharedBy.set(word, (sharedBy.get(word) ?? 0) + 1);
  }

  const matches: Array<IntentMatch & { order: number; preferred: boolean; popular: boolean }> = [];
  services.forEach((service, order) => {
    const slug = normalize(splitWords(service.serviceSlug).join(''));
    let name = 0;
    if (tokenSet.has(slug) || joined.has(slug)) {
      name = onlyNudges(slug) ? SCORE.nudge : SCORE.slug;
    } else {
      for (const word of nameWordsOf[order]!) {
        if (!tokenSet.has(word)) continue;
        const weight = onlyNudges(word) ? SCORE.nudge : SCORE.nameWord / (sharedBy.get(word) ?? 1);
        name = Math.max(name, weight);
      }
    }
    const shelf = service.category ? (shelves.get(service.category) ?? 0) : 0;
    const score = name + shelf;
    if (score < MIN_SCORE) return;
    const matchedBy: IntentMatch['matchedBy'] = [];
    if (name > 0) matchedBy.push('name');
    if (shelf > 0) matchedBy.push('category');
    matches.push({
      service,
      score,
      matchedBy,
      order,
      preferred: options.preferred?.has(service.serviceSlug.toLowerCase()) ?? false,
      popular: service.popular === true,
    });
  });

  return matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.preferred) - Number(a.preferred) ||
        Number(b.popular) - Number(a.popular) ||
        a.order - b.order
    )
    .slice(0, limit)
    .map(({ service, score, matchedBy }) => ({ service, score, matchedBy }));
}
