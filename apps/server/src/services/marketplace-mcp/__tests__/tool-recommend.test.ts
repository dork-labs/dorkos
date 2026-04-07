import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson, MarketplaceJsonEntry } from '@dorkos/marketplace';

import { createRecommendHandler, RecommendInputSchema } from '../tool-recommend.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import type { MarketplaceSource } from '../../marketplace/types.js';

/** Build a noop logger so warn/info/error calls are silent during tests. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a marketplace.json plugin entry with sensible defaults for tests. */
function entry(overrides: Partial<MarketplaceJsonEntry> & { name: string }): MarketplaceJsonEntry {
  return {
    source: `https://example.com/${overrides.name}`,
    ...overrides,
  } as MarketplaceJsonEntry;
}

/** Build a marketplace.json envelope from a list of plugin entries. */
function marketplace(name: string, plugins: MarketplaceJsonEntry[]): MarketplaceJson {
  return { name, plugins } as MarketplaceJson;
}

/** Build a {@link MarketplaceSource} record for the source manager stub. */
function source(name: string, enabled = true): MarketplaceSource {
  return {
    name,
    source: `https://example.com/${name}`,
    enabled,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Build a {@link MarketplaceMcpDeps} bundle backed by stub source manager,
 * stub fetcher, and the supplied marketplace fixtures. Only the methods the
 * recommend handler reads (`sourceManager.list`, `fetcher.fetchMarketplaceJson`)
 * need to be implemented.
 */
function buildDeps(options: {
  sources: MarketplaceSource[];
  marketplaces: Record<string, MarketplaceJson | Error>;
  logger?: Logger;
}): MarketplaceMcpDeps {
  const list = vi.fn(async () => options.sources);
  const fetchMarketplaceJson = vi.fn(async (src: MarketplaceSource) => {
    const result = options.marketplaces[src.name];
    if (result === undefined) {
      throw new Error(`No fixture configured for marketplace '${src.name}'`);
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });

  return {
    dorkHome: '/tmp/.dork-test',
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: { list } as unknown as MarketplaceMcpDeps['sourceManager'],
    fetcher: {
      fetchMarketplaceJson,
    } as unknown as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: {} as MarketplaceMcpDeps['confirmationProvider'],
    logger: options.logger ?? buildLogger(),
  };
}

/**
 * Parse the JSON payload out of the MCP-style content envelope returned by
 * the recommend handler.
 */
function parseResponse(result: { content: { type: 'text'; text: string }[] }): {
  recommendations: Array<{
    name: string;
    type: string;
    description: string;
    marketplace: string;
    relevanceScore: number;
    reason: string;
  }>;
} {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return JSON.parse(result.content[0]!.text);
}

describe('RecommendInputSchema', () => {
  const schema = z.object(RecommendInputSchema);

  it('accepts a minimal valid input', () => {
    const parsed = schema.parse({ context: 'sentry errors' });
    expect(parsed.context).toBe('sentry errors');
    expect(parsed.limit).toBe(5);
    expect(parsed.type).toBeUndefined();
  });

  it('rejects empty context strings', () => {
    expect(() => schema.parse({ context: '' })).toThrow();
  });

  it('rejects context strings longer than 500 characters', () => {
    expect(() => schema.parse({ context: 'a'.repeat(501) })).toThrow();
  });

  it('accepts the four valid type values', () => {
    for (const t of ['agent', 'plugin', 'skill-pack', 'adapter'] as const) {
      expect(schema.parse({ context: 'foo', type: t }).type).toBe(t);
    }
  });

  it('rejects unknown type values', () => {
    expect(() => schema.parse({ context: 'foo', type: 'extension' })).toThrow();
  });

  it('clamps limit to the 1-20 range', () => {
    expect(() => schema.parse({ context: 'foo', limit: 0 })).toThrow();
    expect(() => schema.parse({ context: 'foo', limit: 21 })).toThrow();
    expect(schema.parse({ context: 'foo', limit: 1 }).limit).toBe(1);
    expect(schema.parse({ context: 'foo', limit: 20 }).limit).toBe(20);
  });

  it('rejects non-integer limits', () => {
    expect(() => schema.parse({ context: 'foo', limit: 1.5 })).toThrow();
  });
});

describe('createRecommendHandler', () => {
  let deps: MarketplaceMcpDeps;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty recommendations array when context tokenizes to nothing', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry-monitor' })]),
      },
    });
    const handler = createRecommendHandler(deps);

    // 'a the in on' is exclusively stopwords — tokenize() returns [], and
    // recommend() short-circuits to an empty array per spec.
    const result = await handler({ context: 'a the in on', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toEqual([]);
  });

  it('aggregates entries across every enabled marketplace', async () => {
    deps = buildDeps({
      sources: [source('community'), source('personal')],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry-community' })]),
        personal: marketplace('personal', [entry({ name: 'sentry-personal' })]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(2);
    const marketplaces = payload.recommendations.map((r) => r.marketplace).sort();
    expect(marketplaces).toEqual(['community', 'personal']);
  });

  it('skips disabled marketplaces', async () => {
    deps = buildDeps({
      sources: [source('community', true), source('personal', false)],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry-community' })]),
        // personal would throw if it were ever fetched
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]!.marketplace).toBe('community');
    // Confirm the disabled source was never fetched.
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
  });

  it('filters by type before scoring when supplied', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [
          entry({ name: 'sentry-agent', type: 'agent' }),
          entry({ name: 'sentry-plugin', type: 'plugin' }),
          // No explicit type — defaults to 'plugin' per the spec.
          entry({ name: 'sentry-default' }),
        ]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', type: 'agent', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]!.name).toBe('sentry-agent');
    expect(payload.recommendations[0]!.type).toBe('agent');
  });

  it('treats entries with no explicit type as plugin when filtering', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [
          entry({ name: 'sentry-default' }),
          entry({ name: 'sentry-agent', type: 'agent' }),
        ]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', type: 'plugin', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]!.name).toBe('sentry-default');
    expect(payload.recommendations[0]!.type).toBe('plugin');
  });

  it('truncates results to the supplied limit', async () => {
    const plugins = Array.from({ length: 10 }, (_, i) => entry({ name: `sentry-${i}` }));
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', plugins),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 3 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(3);
  });

  it('does not let one source fetch failure block recommendations from other sources', async () => {
    const logger = buildLogger();
    deps = buildDeps({
      sources: [source('community'), source('broken'), source('personal')],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry-community' })]),
        broken: new Error('boom'),
        personal: marketplace('personal', [entry({ name: 'sentry-personal' })]),
      },
      logger,
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 5 });
    const payload = parseResponse(result);

    const names = payload.recommendations.map((r) => r.name).sort();
    expect(names).toEqual(['sentry-community', 'sentry-personal']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('marketplace_recommend'),
      expect.objectContaining({ marketplace: 'broken' })
    );
  });

  it('returns the recommendation array shape from the spec', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [
          entry({
            name: 'sentry-monitor',
            description: 'Track errors and exceptions',
            tags: ['errors', 'monitoring'],
            type: 'plugin',
          }),
        ]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry errors', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations).toHaveLength(1);
    const rec = payload.recommendations[0]!;
    expect(rec).toEqual({
      name: 'sentry-monitor',
      type: 'plugin',
      description: 'Track errors and exceptions',
      marketplace: 'community',
      relevanceScore: expect.any(Number),
      reason: expect.any(String),
    });
    expect(rec.relevanceScore).toBeGreaterThan(0);
    expect(rec.reason.length).toBeGreaterThan(0);
  });

  it('defaults description to an empty string when missing', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry' })]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations[0]!.description).toBe('');
  });

  it('defaults type to plugin when entry has no explicit type', async () => {
    deps = buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [entry({ name: 'sentry' })]),
      },
    });
    const handler = createRecommendHandler(deps);

    const result = await handler({ context: 'sentry', limit: 5 });
    const payload = parseResponse(result);

    expect(payload.recommendations[0]!.type).toBe('plugin');
  });
});
