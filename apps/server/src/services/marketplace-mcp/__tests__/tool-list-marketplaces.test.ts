import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson } from '@dorkos/marketplace';

import type { MarketplaceSource } from '../../marketplace/types.js';
import { createListMarketplacesHandler } from '../tool-list-marketplaces.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

/** Build a logger whose every method is a `vi.fn()` spy. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a marketplace.json document with `count` placeholder plugin entries. */
function buildMarketplaceJson(name: string, count: number): MarketplaceJson {
  return {
    name,
    plugins: Array.from({ length: count }, (_, idx) => ({
      name: `${name}-plugin-${idx}`,
      source: `https://example.com/${name}/${idx}`,
    })),
  } as MarketplaceJson;
}

/** Build a fully-typed `MarketplaceSource` with sensible defaults. */
function buildSource(overrides: Partial<MarketplaceSource> & { name: string }): MarketplaceSource {
  return {
    source: `https://example.com/${overrides.name}`,
    enabled: true,
    addedAt: '2026-04-07T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build a `MarketplaceMcpDeps` stub wired with `vi.fn()` spies for
 * `sourceManager.list()` and `fetcher.fetchMarketplaceJson()`. Only the
 * methods touched by `createListMarketplacesHandler` are populated; the
 * remaining fields are cast through `unknown` so the stub remains a valid
 * `MarketplaceMcpDeps` without pulling in unrelated marketplace services.
 */
function buildDeps(opts: {
  list: MarketplaceSource[];
  fetchImpl?: (source: MarketplaceSource) => Promise<MarketplaceJson>;
  logger?: Logger;
}): {
  deps: MarketplaceMcpDeps;
  list: ReturnType<typeof vi.fn>;
  fetchMarketplaceJson: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
  const list = vi.fn(async () => opts.list);
  const fetchMarketplaceJson = vi.fn(async (source: MarketplaceSource) => {
    if (opts.fetchImpl) return opts.fetchImpl(source);
    return buildMarketplaceJson(source.name, 0);
  });
  const logger = opts.logger ?? buildLogger();

  const deps = {
    dorkHome: '/tmp/test-dork-home',
    sourceManager: { list } as unknown as MarketplaceMcpDeps['sourceManager'],
    fetcher: {
      fetchMarketplaceJson,
    } as unknown as MarketplaceMcpDeps['fetcher'],
    installer: {} as MarketplaceMcpDeps['installer'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: {} as MarketplaceMcpDeps['confirmationProvider'],
    logger,
  } satisfies MarketplaceMcpDeps;

  return { deps, list, fetchMarketplaceJson, logger };
}

/** Parse the JSON `text` payload out of an MCP tool result. */
function parseResult(result: { content: { type: 'text'; text: string }[] }): {
  sources: { name: string; source: string; enabled: boolean; packageCount: number }[];
} {
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return JSON.parse(block?.text ?? '');
}

describe('createListMarketplacesHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty sources array when no marketplaces are configured', async () => {
    const { deps, list, fetchMarketplaceJson } = buildDeps({ list: [] });
    const handler = createListMarketplacesHandler(deps);

    const result = await handler();
    const payload = parseResult(result);

    expect(list).toHaveBeenCalledTimes(1);
    expect(fetchMarketplaceJson).not.toHaveBeenCalled();
    expect(payload.sources).toEqual([]);
  });

  it('returns a single source enriched with its package count', async () => {
    const source = buildSource({ name: 'dorkos-community' });
    const { deps, fetchMarketplaceJson } = buildDeps({
      list: [source],
      fetchImpl: async () => buildMarketplaceJson('dorkos-community', 3),
    });
    const handler = createListMarketplacesHandler(deps);

    const result = await handler();
    const payload = parseResult(result);

    expect(fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    expect(fetchMarketplaceJson).toHaveBeenCalledWith(source);
    expect(payload.sources).toEqual([
      {
        name: 'dorkos-community',
        source: source.source,
        enabled: true,
        packageCount: 3,
      },
    ]);
  });

  it('returns every configured source — enabled and disabled — with package counts', async () => {
    const community = buildSource({ name: 'dorkos-community' });
    const personal = buildSource({
      name: 'personal',
      source: 'file:///tmp/dork/personal-marketplace',
    });
    const disabled = buildSource({ name: 'archived', enabled: false });

    const counts: Record<string, number> = {
      'dorkos-community': 5,
      personal: 1,
      archived: 9,
    };

    const { deps, fetchMarketplaceJson } = buildDeps({
      list: [community, personal, disabled],
      fetchImpl: async (s) => buildMarketplaceJson(s.name, counts[s.name] ?? 0),
    });
    const handler = createListMarketplacesHandler(deps);

    const result = await handler();
    const payload = parseResult(result);

    expect(fetchMarketplaceJson).toHaveBeenCalledTimes(3);
    expect(payload.sources).toEqual([
      {
        name: 'dorkos-community',
        source: community.source,
        enabled: true,
        packageCount: 5,
      },
      {
        name: 'personal',
        source: personal.source,
        enabled: true,
        packageCount: 1,
      },
      {
        name: 'archived',
        source: disabled.source,
        enabled: false,
        packageCount: 9,
      },
    ]);
  });

  it('returns packageCount: 0 and logs a warning when fetch fails — and never throws', async () => {
    const good = buildSource({ name: 'good' });
    const broken = buildSource({ name: 'broken' });
    const logger = buildLogger();

    const { deps } = buildDeps({
      list: [good, broken],
      fetchImpl: async (s) => {
        if (s.name === 'broken') {
          throw new Error('network down');
        }
        return buildMarketplaceJson(s.name, 2);
      },
      logger,
    });
    const handler = createListMarketplacesHandler(deps);

    const result = await handler();
    const payload = parseResult(result);

    expect(payload.sources).toEqual([
      { name: 'good', source: good.source, enabled: true, packageCount: 2 },
      { name: 'broken', source: broken.source, enabled: true, packageCount: 0 },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(warnCall?.[0]).toContain('marketplace_list_marketplaces');
    expect(warnCall?.[1]).toMatchObject({
      marketplace: 'broken',
      error: 'network down',
    });
  });
});
