/**
 * Operations that spend money (DOR-4204): a separate mark beside the
 * read/write/destructive class, so no access level, and so no Read grant,
 * ever covers one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../connector-schemas.js';
import { isPaidOperation, PAID_BY_DEFAULT_TOOLKITS } from '../paid-operations.js';

/** What Composio's catalog answered for each listed toolkit, on the date it records. */
const catalog = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'composio-paid-toolkits.json'), 'utf8')
) as { toolkits: Array<{ slug: string; name: string }> };

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

describe('pay-per-use apps, by their Composio toolkit names (DOR-4597)', () => {
  // Each name checked against the Composio catalog on 2026-11-17. GroqCloud is
  // `groqcloud` there, Browserbase is `browserbase_tool` and `browserbase_mcp`,
  // and Stability AI's API is `dreamstudio`.
  const MISSED = [
    'gemini',
    'mistral_ai',
    'groqcloud',
    'cohere',
    'brightdata',
    'heygen',
    'zenrows',
    'runway',
    'scrapingdog',
    'browserbase_tool',
    'browserbase_mcp',
    'dreamstudio',
  ];

  it.each(MISSED)('marks a %s read paid, so no level covers it', (toolkit) => {
    const slug = `${toolkit.toUpperCase()}_GET_RESULT`;
    expect(isPaidOperation({ toolkit, operationSlug: slug })).toBe(true);
    const read = {
      operationRevisionId: slug,
      toolkit,
      operationSlug: slug,
      capabilityClassification: 'read' as const,
      supported: true,
    };
    expect(accessLevelRevisionIds([read], 'read')).toEqual([]);
  });

  it('spells every entry the way the check compares it: lowercase toolkit names', () => {
    for (const toolkit of PAID_BY_DEFAULT_TOOLKITS) expect(toolkit).toMatch(/^[a-z0-9_]+$/);
  });

  it('names only toolkits found in the Composio catalog, since a misspelt one reads as free', () => {
    // Older names Composio doesn't use, kept on purpose so a matching name never reads as free.
    const keptOffCatalog = [
      'anthropic',
      'browserbase',
      'clearbit',
      'messagebird',
      'stabilityai',
      'vonage',
    ];
    const known = new Set([...catalog.toolkits.map((t) => t.slug), ...keptOffCatalog]);
    expect([...PAID_BY_DEFAULT_TOOLKITS].filter((toolkit) => !known.has(toolkit))).toEqual([]);
  });

  it('keeps every toolkit the catalog snapshot records as paid', () => {
    const dropped = catalog.toolkits.filter((t) => !PAID_BY_DEFAULT_TOOLKITS.has(t.slug));
    expect(dropped.map((t) => t.slug)).toEqual([]);
  });
});

describe('accessLevelRevisionIds with a paid operation', () => {
  it.each([...PAID_BY_DEFAULT_TOOLKITS])(
    'never grants a clean %s create under a level',
    (toolkit) => {
      // Synthetic create action, classed `write` directly so the paid mark is checked
      // independently of the name families (`diffbot` contains BOT, which reads destructive).
      const slug = `${toolkit.toUpperCase()}_CREATE_ITEM`;
      const operations = [
        {
          operationRevisionId: slug,
          toolkit,
          operationSlug: slug,
          capabilityClassification: 'write' as const,
          supported: true,
        },
      ];
      expect(accessLevelRevisionIds(operations, 'read')).toEqual([]);
      expect(accessLevelRevisionIds(operations, 'read-write')).toEqual([]);
    }
  );

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
