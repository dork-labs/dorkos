/**
 * Tests for the `marketplace_search` MCP tool handler.
 *
 * Exercises the handler directly with stub `MarketplaceSourceManager` and
 * stub `PackageFetcher` so each filter path can be asserted in isolation
 * without spinning up the real `McpServer`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MarketplaceJson, MarketplaceJsonEntry } from '@dorkos/marketplace';
import { noopLogger } from '@dorkos/shared/logger';

import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import type { MarketplaceSource } from '../../marketplace/types.js';
import { createSearchHandler, SearchInputZodSchema } from '../tool-search.js';

/**
 * Build a minimal `MarketplaceSource` with sensible defaults. Tests only need
 * to override the fields they care about (`name`, `enabled`).
 */
function source(overrides: Partial<MarketplaceSource> & { name: string }): MarketplaceSource {
  return {
    source: `https://example.com/${overrides.name}`,
    enabled: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build a minimal `MarketplaceJsonEntry`. Only the fields the search handler
 * reads need to be specified by callers.
 */
function entry(overrides: Partial<MarketplaceJsonEntry> & { name: string }): MarketplaceJsonEntry {
  return {
    source: `https://example.com/${overrides.name}`,
    ...overrides,
  } as MarketplaceJsonEntry;
}

/** Wrap a list of entries in the `MarketplaceJson` envelope. */
function marketplaceJson(name: string, entries: MarketplaceJsonEntry[]): MarketplaceJson {
  return { name, plugins: entries };
}

/**
 * Build a `MarketplaceMcpDeps` stub bound to canned source/marketplace data.
 * Only the fields `createSearchHandler` reads (`sourceManager`, `fetcher`,
 * `logger`) are populated; the rest are left as `undefined as never` casts
 * because the handler does not touch them.
 */
function buildDeps(
  sources: MarketplaceSource[],
  marketplaces: Record<string, MarketplaceJson | Error>
): MarketplaceMcpDeps {
  const list = vi.fn().mockResolvedValue(sources);
  const fetchMarketplaceJson = vi.fn(async (src: MarketplaceSource) => {
    const result = marketplaces[src.name];
    if (result instanceof Error) throw result;
    if (!result) throw new Error(`No canned marketplace for '${src.name}'`);
    return result;
  });

  return {
    dorkHome: '/tmp/test-dork-home',
    sourceManager: { list } as unknown as MarketplaceMcpDeps['sourceManager'],
    fetcher: { fetchMarketplaceJson } as unknown as MarketplaceMcpDeps['fetcher'],
    cache: undefined as unknown as MarketplaceMcpDeps['cache'],
    installer: undefined as unknown as MarketplaceMcpDeps['installer'],
    uninstallFlow: undefined as unknown as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: undefined as unknown as MarketplaceMcpDeps['confirmationProvider'],
    logger: noopLogger,
  };
}

/** Parse the JSON payload out of the handler's MCP tool response. */
function parseResponse(response: { content: { type: 'text'; text: string }[] }): {
  results: { name: string; type: string; marketplace: string; description?: string }[];
  total: number;
} {
  return JSON.parse(response.content[0]!.text);
}

describe('createSearchHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns entries from multiple marketplaces with marketplace name attached', async () => {
    const deps = buildDeps([source({ name: 'community' }), source({ name: 'personal' })], {
      community: marketplaceJson('community', [entry({ name: 'a' })]),
      personal: marketplaceJson('personal', [entry({ name: 'b' })]),
    });
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({}));
    const payload = parseResponse(response);
    expect(payload.total).toBe(2);
    const byName = Object.fromEntries(payload.results.map((r) => [r.name, r.marketplace]));
    expect(byName['a']).toBe('community');
    expect(byName['b']).toBe('personal');
  });

  it('skips disabled marketplaces by default', async () => {
    const deps = buildDeps(
      [source({ name: 'community' }), source({ name: 'disabled', enabled: false })],
      {
        community: marketplaceJson('community', [entry({ name: 'a' })]),
        disabled: marketplaceJson('disabled', [entry({ name: 'b' })]),
      }
    );
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({}));
    const payload = parseResponse(response);
    expect(payload.results.map((r) => r.name)).toEqual(['a']);
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit marketplace arg even when the source is disabled', async () => {
    const deps = buildDeps(
      [source({ name: 'community' }), source({ name: 'disabled', enabled: false })],
      {
        community: marketplaceJson('community', [entry({ name: 'a' })]),
        disabled: marketplaceJson('disabled', [entry({ name: 'b' })]),
      }
    );
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({ marketplace: 'disabled' }));
    const payload = parseResponse(response);
    expect(payload.results.map((r) => r.name)).toEqual(['b']);
  });

  it('filters by type', async () => {
    const deps = buildDeps([source({ name: 'community' })], {
      community: marketplaceJson('community', [
        entry({ name: 'agent-one', type: 'agent' }),
        entry({ name: 'plugin-one', type: 'plugin' }),
        entry({ name: 'untyped' }),
      ]),
    });
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({ type: 'agent' }));
    const payload = parseResponse(response);
    expect(payload.results.map((r) => r.name)).toEqual(['agent-one']);
  });

  it('filters by free-text query across name, description, and tags', async () => {
    const deps = buildDeps([source({ name: 'community' })], {
      community: marketplaceJson('community', [
        entry({ name: 'sentry-monitor', description: 'unrelated' }),
        entry({ name: 'unrelated', description: 'sentry tracker' }),
        entry({ name: 'tagged', description: 'nothing', tags: ['sentry'] }),
        entry({ name: 'totally-different', description: 'nothing here' }),
      ]),
    });
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({ query: 'SENTRY' }));
    const payload = parseResponse(response);
    expect(payload.results.map((r) => r.name).sort()).toEqual([
      'sentry-monitor',
      'tagged',
      'unrelated',
    ]);
  });

  it('truncates results to limit but reports the full pre-truncation total', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ name: `pkg-${i}` }));
    const deps = buildDeps([source({ name: 'community' })], {
      community: marketplaceJson('community', entries),
    });
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({ limit: 2 }));
    const payload = parseResponse(response);
    expect(payload.results).toHaveLength(2);
    expect(payload.total).toBe(5);
  });

  it('continues with other marketplaces when one fetch fails', async () => {
    const warn = vi.fn();
    const deps = buildDeps([source({ name: 'broken' }), source({ name: 'community' })], {
      broken: new Error('connection refused'),
      community: marketplaceJson('community', [entry({ name: 'good' })]),
    });
    deps.logger = { ...noopLogger, warn };
    const handler = createSearchHandler(deps);
    const response = await handler(SearchInputZodSchema.parse({}));
    const payload = parseResponse(response);
    expect(payload.results.map((r) => r.name)).toEqual(['good']);
    expect(payload.total).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('marketplace_search');
  });
});
