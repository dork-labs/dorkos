/**
 * Operations that spend money (DOR-4204): a separate mark beside the
 * read/write/destructive class, so no access level, and so no Read grant,
 * ever covers one.
 */
import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../connector-schemas.js';
import { isPaidOperation } from '../paid-operations.js';

describe('isPaidOperation', () => {
  it('marks an Apify actor run as paid, though the service calls it read-only', () => {
    expect(isPaidOperation({ toolkit: 'apify', operationSlug: 'APIFY_SCRAPE_TWITTER_POSTS' })).toBe(
      true
    );
  });

  it('marks every operation of a pay-per-use service paid by default', () => {
    for (const toolkit of ['apify', 'openai', 'twilio']) {
      expect(isPaidOperation({ toolkit, operationSlug: `${toolkit.toUpperCase()}_ANYTHING` })).toBe(
        true
      );
    }
  });

  it('reads the service name the way providers write it', () => {
    expect(isPaidOperation({ toolkit: 'APIFY', operationSlug: 'APIFY_RUN_ACTOR' })).toBe(true);
  });

  it('leaves an ordinary service alone', () => {
    expect(isPaidOperation({ toolkit: 'gmail', operationSlug: 'GMAIL_FETCH_EMAILS' })).toBe(false);
    expect(isPaidOperation({ toolkit: 'linear', operationSlug: 'LINEAR_LIST_ISSUES' })).toBe(false);
  });
});

describe('accessLevelRevisionIds with a paid operation', () => {
  const candidates = [
    {
      operationRevisionId: 'apify-scrape',
      toolkit: 'apify',
      operationSlug: 'APIFY_SCRAPE_TWITTER_POSTS',
      capabilityClassification: 'read' as const,
      supported: true,
    },
    {
      operationRevisionId: 'gmail-read',
      toolkit: 'gmail',
      operationSlug: 'GMAIL_FETCH_EMAILS',
      capabilityClassification: 'read' as const,
      supported: true,
    },
  ];

  it('never puts a paid operation under Read or Read and write', () => {
    expect(accessLevelRevisionIds(candidates, 'read')).toEqual(['gmail-read']);
    expect(accessLevelRevisionIds(candidates, 'read-write')).toEqual(['gmail-read']);
  });
});
