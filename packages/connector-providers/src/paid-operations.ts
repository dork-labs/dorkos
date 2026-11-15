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
 * Whether an operation spends money: every operation of a pay-per-use service,
 * unless Security reviewed it as free.
 *
 * @param op - The service (toolkit) and operation, as the provider names them.
 */
export function isPaidOperation(op: { toolkit: string; operationSlug: string }): boolean {
  return (
    PAID_BY_DEFAULT_TOOLKITS.has(op.toolkit.toLowerCase()) &&
    !REVIEWED_FREE_OPERATIONS.has(op.operationSlug.toUpperCase())
  );
}

/** What an access level reads of one operation: its class, and whether it spends money. */
export type AccessLevelCandidate = Pick<
  ConnectorReconciliationCandidate,
  'operationRevisionId' | 'toolkit' | 'operationSlug' | 'capabilityClassification' | 'supported'
>;
