/**
 * Operations that spend money (DOR-4204): a mark beside the read, write and
 * destructive class, because a service's own "read-only" label says nothing
 * about who pays. An Apify scrape is read-only to Apify and still bills the
 * account owner. No access level covers a paid operation, it is never shared
 * with every agent or handed on by another agent, and it runs only for an
 * agent a person gave it to on its own.
 *
 * @module connector-providers/paid-operations
 */
import { normalizeSlug } from './composio/slug.js';
import type { ConnectorReconciliationCandidate } from './connector-schemas.js';

/** Composio toolkits whose operations spend money unless Security reviewed an exception. */
export const PAID_BY_DEFAULT_TOOLKITS: ReadonlySet<string> = new Set([
  // Scraping actors.
  'apify',
  // AI model APIs.
  'openai',
  'anthropic',
  'perplexityai',
  'replicate',
  'elevenlabs',
  'stabilityai',
  'deepgram',
  'assemblyai',
  // SMS and phone.
  'twilio',
  'vonage',
  'plivo',
  'messagebird',
  // Search and enrichment.
  'serpapi',
  'firecrawl',
  'tavily',
  'exa',
  'browserbase',
  'scrapingbee',
  'hunter',
  'clearbit',
  'peopledatalabs',
  'apollo',
]);

/** Operations reviewed as free inside paid-by-default toolkits. Additions need Security review. */
export const REVIEWED_FREE_OPERATIONS: ReadonlySet<string> = new Set();

/**
 * Operations that spend money inside otherwise free toolkits (DOR-4460), by
 * toolkit and slug pattern. GitHub Models calls bill the account owner, and
 * Composio tags them `readOnlyHint`. A pattern, so a model call Composio adds
 * later is paid from its first catalog read; listing the model catalog runs
 * no model and stays free.
 */
export const PAID_OPERATION_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ['github', /^GITHUB_\w*INFERENCE/],
]);

/**
 * An app name with case, spaces and separators taken out, so "Perplexity AI",
 * "perplexity_ai" and "perplexityai" are one app (Security, #3863). A variant
 * spelling must never read as free.
 *
 * @param toolkit - The app's service id in any spelling.
 */
export function normalizeToolkit(toolkit: string): string {
  return toolkit.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** {@link PAID_BY_DEFAULT_TOOLKITS} and the pattern keys, in normalized spelling. */
const PAID_TOOLKITS_NORMALIZED: ReadonlySet<string> = new Set(
  [...PAID_BY_DEFAULT_TOOLKITS].map(normalizeToolkit)
);
const PAID_PATTERNS_NORMALIZED: ReadonlyMap<string, RegExp> = new Map(
  [...PAID_OPERATION_PATTERNS].map(([toolkit, pattern]) => [normalizeToolkit(toolkit), pattern])
);
const REVIEWED_FREE_NORMALIZED: ReadonlySet<string> = new Set(
  [...REVIEWED_FREE_OPERATIONS].map(normalizeSlug)
);

/**
 * Whether an operation spends money: every operation of a pay-per-use service,
 * unless Security reviewed it as free, and the paid operations of a free one.
 * Names match in normalized spelling, so a variant name is never free.
 *
 * @param op - The service (toolkit) and operation, as the provider names them.
 */
export function isPaidOperation(op: { toolkit: string; operationSlug: string }): boolean {
  const toolkit = normalizeToolkit(op.toolkit);
  const slug = normalizeSlug(op.operationSlug);
  // Both spellings: splitting camel case can break a pattern the plain one matches.
  const pattern = PAID_PATTERNS_NORMALIZED.get(toolkit);
  if (pattern?.test(slug) || pattern?.test(op.operationSlug.toUpperCase())) return true;
  return PAID_TOOLKITS_NORMALIZED.has(toolkit) && !REVIEWED_FREE_NORMALIZED.has(slug);
}

/** What an access level reads of one operation: its class, and whether it spends money. */
export type AccessLevelCandidate = Pick<
  ConnectorReconciliationCandidate,
  'operationRevisionId' | 'toolkit' | 'operationSlug' | 'capabilityClassification' | 'supported'
>;
