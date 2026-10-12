/**
 * Match a plain task description ("let the team know the deploy is done") to
 * the catalog services that could do it, best first.
 *
 * Deliberately small and explainable: no model, no network. A service scores
 * when a word of the description names it (its id, or a whole word of its
 * name), and when the description's words point at the shelf it sits on
 * (`category`, set for the built-in popular apps). A description that names
 * nothing and points at no shelf matches nothing — the result is then empty,
 * never a padded guess.
 *
 * @module services/connectors/recommend/intent-match
 */
import type {
  ConnectorCatalogCategory,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';

/**
 * Words that point at a catalog shelf, in singular form (a description's words
 * lose a trailing `s` before lookup). Each word maps to one shelf, so a word
 * never lifts two unrelated kinds of app at once.
 */
export const INTENT_CATEGORY_KEYWORDS: Readonly<
  Record<ConnectorCatalogCategory, readonly string[]>
> = {
  email: ['email', 'mail', 'inbox', 'newsletter', 'unread'],
  calendar: ['calendar', 'meeting', 'schedule', 'event', 'appointment', 'availability', 'agenda'],
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
  docs: ['doc', 'document', 'note', 'wiki', 'page', 'spreadsheet', 'sheet', 'database', 'table'],
  files: ['file', 'folder', 'upload', 'download', 'storage', 'attachment', 'pdf'],
  code: ['code', 'repo', 'repository', 'commit', 'branch', 'pr', 'pull'],
  tasks: ['task', 'todo', 'ticket', 'issue', 'bug', 'project', 'backlog', 'sprint'],
  sales: ['crm', 'deal', 'lead', 'contact', 'customer', 'pipeline', 'prospect'],
  developer: [],
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

/** Points for each kind of match; a named service always beats a shelf hit. */
const SCORE = { slug: 4, nameWord: 3, category: 2 } as const;

/** Lower-case, letters and digits only, singular when it was a plain plural. */
function normalize(word: string): string {
  const plain = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  return plain.length > 3 && plain.endsWith('s') && !plain.endsWith('ss')
    ? plain.slice(0, -1)
    : plain;
}

/** The meaningful words of a text, normalized, in order. */
function words(text: string): string[] {
  return text
    .split(/[\s\-_/.,;:!?()'"]+/)
    .map(normalize)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

/** The shelf each keyword points at, built once from {@link INTENT_CATEGORY_KEYWORDS}. */
const CATEGORY_BY_KEYWORD: ReadonlyMap<string, ConnectorCatalogCategory> = new Map(
  (Object.entries(INTENT_CATEGORY_KEYWORDS) as Array<[ConnectorCatalogCategory, string[]]>).flatMap(
    ([category, keywords]) => keywords.map((keyword) => [keyword, category] as const)
  )
);

/** One catalog service the description points at, with why. */
export interface IntentMatch {
  /** The matched catalog service. */
  service: ConnectorCatalogService;
  /** Higher is a better match; only positive scores are returned. */
  score: number;
  /** What matched: the service's name, its shelf, or both. */
  matchedBy: Array<'name' | 'category'>;
}

/**
 * Score catalog services against a plain task description and return the best
 * few, best first. Ties keep catalog order, so the popular apps lead.
 *
 * @param intent - What the person wants done, in their own words.
 * @param services - Catalog services to choose from, in catalog order.
 * @param limit - The most matches to return.
 * @returns Matches with a positive score, at most `limit`; empty when nothing fits.
 */
export function matchServicesToIntent(
  intent: string,
  services: readonly ConnectorCatalogService[],
  limit: number
): IntentMatch[] {
  const tokens = words(intent);
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);
  // Adjacent pairs catch a two-word name written apart ("google calendar").
  const joined = new Set(tokens.slice(1).map((token, index) => `${tokens[index]}${token}`));
  const categories = new Set(
    tokens.flatMap((token) => {
      const category = CATEGORY_BY_KEYWORD.get(token);
      return category ? [category] : [];
    })
  );

  const matches: Array<IntentMatch & { order: number }> = [];
  services.forEach((service, order) => {
    const slug = normalize(service.serviceSlug);
    const nameWords = words(service.displayName).filter((word) => word.length >= 3);
    let score = 0;
    const matchedBy: IntentMatch['matchedBy'] = [];
    if (tokenSet.has(slug) || joined.has(slug)) score += SCORE.slug;
    else if (nameWords.some((word) => tokenSet.has(word))) score += SCORE.nameWord;
    if (score > 0) matchedBy.push('name');
    if (service.category && categories.has(service.category)) {
      score += SCORE.category;
      matchedBy.push('category');
    }
    if (score > 0) matches.push({ service, score, matchedBy, order });
  });

  return matches
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ service, score, matchedBy }) => ({ service, score, matchedBy }));
}
