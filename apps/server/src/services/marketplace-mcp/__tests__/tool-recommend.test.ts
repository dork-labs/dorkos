import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson, MarketplaceJsonEntry } from '@dorkos/marketplace';

import { createRecommendHandler } from '../tool-recommend.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import type { MarketplaceSource } from '../../marketplace/types.js';
import * as installedScanner from '../../marketplace/installed-scanner.js';

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
    updateFlow: {} as MarketplaceMcpDeps['updateFlow'],
    confirmationProvider: {} as MarketplaceMcpDeps['confirmationProvider'],
    onPluginsChanged: vi.fn(),
    consent: { settle: vi.fn(async () => {}), removed: vi.fn() },
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
    installed?: boolean;
  }>;
} {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return JSON.parse(result.content[0]!.text);
}

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
});

describe('createRecommendHandler — installed', () => {
  let dorkHome: string;
  let project: string;
  let otherProject: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-recommend-installed-'));
    project = await mkdtemp(join(tmpdir(), 'dorkos-recommend-project-'));
    otherProject = await mkdtemp(join(tmpdir(), 'dorkos-recommend-other-'));
  });

  afterEach(async () => {
    for (const dir of [dorkHome, project, otherProject]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Write an installed plugin under `<root>/plugins/<name>`, with its provenance when given. */
  async function install(root: string, name: string, installedFrom?: string): Promise<void> {
    const dir = join(root, 'plugins', name, '.dork');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, type: 'plugin', name, version: '1.0.0' })
    );
    if (installedFrom) {
      await writeFile(
        join(dir, 'install-metadata.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          type: 'plugin',
          installedFrom,
          installedAt: '2026-01-15T10:00:00.000Z',
        })
      );
    }
  }

  const depsFor = (logger = buildLogger()): MarketplaceMcpDeps => ({
    ...buildDeps({
      sources: [source('community')],
      marketplaces: {
        community: marketplace('community', [
          entry({ name: 'sentry-monitor', description: 'Track errors', tags: ['errors'] }),
          entry({ name: 'error-digest', description: 'Daily errors summary', tags: ['errors'] }),
          entry({ name: 'error-pager', description: 'Page on errors', tags: ['errors'] }),
        ]),
      },
      logger,
    }),
    dorkHome,
    // Another agent's project is registered; it must not count for this caller.
    listAgentScopes: () => [{ projectPath: otherProject }],
  });

  const flags = async (deps: MarketplaceMcpDeps, projectPath?: string) => {
    const payload = parseResponse(
      await createRecommendHandler(deps)(
        { context: 'errors', limit: 5 },
        projectPath ? { projectPath } : {}
      )
    );
    return Object.fromEntries(
      payload.recommendations.map((r) => [r.name, 'installed' in r ? r.installed : 'unknown'])
    );
  };

  it('counts a global install from the same marketplace, and nothing else', async () => {
    await install(dorkHome, 'sentry-monitor', 'community');
    expect(await flags(depsFor())).toEqual({
      'sentry-monitor': true,
      'error-digest': false,
      'error-pager': false,
    });
  });

  it("counts the caller's own project, never another agent's", async () => {
    await install(join(project, '.dork'), 'error-digest', 'community');
    await install(join(otherProject, '.dork'), 'error-pager', 'community');
    expect(await flags(depsFor(), project)).toMatchObject({
      'error-digest': true,
      'error-pager': false,
    });
    // Without a known project only the global scope is read.
    expect(await flags(depsFor())).toMatchObject({ 'error-digest': false });
  });

  it('says false for a same-named package from another marketplace', async () => {
    await install(dorkHome, 'sentry-monitor', 'someone-else');
    expect((await flags(depsFor()))['sentry-monitor']).toBe(false);
  });

  it('leaves installed out, never false, when the installed scan fails', async () => {
    const logger = buildLogger();
    await install(dorkHome, 'sentry-monitor', 'community');
    const deps = depsFor(logger);
    const scan = vi
      .spyOn(installedScanner, 'scanInstallationRecords')
      .mockRejectedValueOnce(new Error('disk unreadable'));

    const result = await flags(deps);

    expect(Object.values(result)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read installed packages'),
      expect.objectContaining({ error: 'disk unreadable' })
    );
    scan.mockRestore();
  });
});
