import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  MarketplaceJson,
  MarketplaceJsonEntry,
  MarketplacePackageManifest,
} from '@dorkos/marketplace';
import type { MarketplaceSource } from '../../marketplace/types.js';
import type { PreviewResult } from '../../marketplace/marketplace-installer.js';
import { createGetHandler, GetInputSchema } from '../tool-get.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

/**
 * Build a `MarketplaceSource` with sensible defaults. Tests override only the
 * fields they care about.
 */
function source(overrides: Partial<MarketplaceSource> & { name: string }): MarketplaceSource {
  return {
    source: `https://example.com/${overrides.name}`,
    enabled: true,
    addedAt: '2026-04-07T00:00:00Z',
    ...overrides,
  };
}

/**
 * Build a `MarketplaceJsonEntry` with sensible defaults. Tests override only
 * the fields they care about.
 */
function entry(overrides: Partial<MarketplaceJsonEntry> & { name: string }): MarketplaceJsonEntry {
  return {
    source: `https://example.com/${overrides.name}`,
    ...overrides,
  } as MarketplaceJsonEntry;
}

/**
 * Build a minimal valid `MarketplacePackageManifest` for the canned preview
 * results that the stub installer returns.
 */
function manifest(overrides: { name: string; version?: string }): MarketplacePackageManifest {
  return {
    manifestVersion: 1,
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    type: 'plugin',
    description: 'A package',
  } as MarketplacePackageManifest;
}

/**
 * Build a stub `MarketplaceMcpDeps` whose `sourceManager`, `fetcher`, and
 * `installer` are vi.fn()-backed and can be configured per test. Only the
 * fields `createGetHandler` reads are populated.
 */
function createStubDeps(opts: {
  sources: MarketplaceSource[];
  marketplaceJsonBySource: Record<string, MarketplaceJson | Error>;
  preview?: PreviewResult | Error;
}): MarketplaceMcpDeps {
  const list = vi.fn(async () => opts.sources);
  const fetchMarketplaceJson = vi.fn(async (src: MarketplaceSource) => {
    const result = opts.marketplaceJsonBySource[src.name];
    if (!result) {
      throw new Error(`No canned marketplace.json for '${src.name}'`);
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const preview = vi.fn(async () => {
    if (!opts.preview) {
      throw new Error('No canned preview() result configured');
    }
    if (opts.preview instanceof Error) {
      throw opts.preview;
    }
    return opts.preview;
  });

  return {
    dorkHome: '/tmp/.dork-test',
    installer: {
      preview,
      install: vi.fn(),
      update: vi.fn(),
    } as unknown as MarketplaceMcpDeps['installer'],
    sourceManager: { list } as unknown as MarketplaceMcpDeps['sourceManager'],
    fetcher: {
      fetchMarketplaceJson,
    } as unknown as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: {
      requestInstallConfirmation: vi.fn(),
      resolveToken: vi.fn(),
    } as unknown as MarketplaceMcpDeps['confirmationProvider'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

/**
 * Parse the JSON payload out of an MCP `text` content block — every handler
 * in this directory wraps its response in `{ content: [{ type: 'text', text }] }`.
 */
function parseToolPayload<T = unknown>(result: { content: { type: 'text'; text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe('GetInputSchema', () => {
  it('exports a Zod-compatible shape with `name` and optional `marketplace`', () => {
    expect(GetInputSchema).toHaveProperty('name');
    expect(GetInputSchema).toHaveProperty('marketplace');
  });
});

describe('createGetHandler', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /**
   * Stage a fake package directory with an optional README.md so the handler
   * can read it back through the canned `preview()` result.
   */
  async function stagePackage(opts: { readme?: string }): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'tool-get-test-'));
    tempDirs.push(dir);
    if (opts.readme !== undefined) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'README.md'), opts.readme, 'utf-8');
    }
    return dir;
  }

  it('returns the full package payload when found in an enabled marketplace (README present)', async () => {
    const packagePath = await stagePackage({ readme: '# my-pkg\n\nHello world.' });
    const deps = createStubDeps({
      sources: [source({ name: 'community' })],
      marketplaceJsonBySource: {
        community: {
          name: 'community',
          plugins: [
            entry({
              name: 'my-pkg',
              description: 'cool',
              type: 'plugin',
              category: 'tools',
              tags: ['cool', 'beans'],
            }),
          ],
        },
      },
      preview: {
        manifest: manifest({ name: 'my-pkg' }),
        packagePath,
      } as PreviewResult,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'my-pkg' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      package: {
        name: string;
        type: string;
        description?: string;
        category?: string;
        tags?: string[];
        marketplace: string;
        manifest: MarketplacePackageManifest | null;
        readme?: string;
      };
    }>(result);
    expect(payload.package.name).toBe('my-pkg');
    expect(payload.package.type).toBe('plugin');
    expect(payload.package.description).toBe('cool');
    expect(payload.package.category).toBe('tools');
    expect(payload.package.tags).toEqual(['cool', 'beans']);
    expect(payload.package.marketplace).toBe('community');
    expect(payload.package.manifest).toMatchObject({ name: 'my-pkg', version: '1.0.0' });
    expect(payload.package.readme).toBe('# my-pkg\n\nHello world.');
  });

  it('returns `readme: undefined` when README.md is missing on the staged package', async () => {
    const packagePath = await stagePackage({});
    const deps = createStubDeps({
      sources: [source({ name: 'community' })],
      marketplaceJsonBySource: {
        community: {
          name: 'community',
          plugins: [entry({ name: 'no-readme' })],
        },
      },
      preview: {
        manifest: manifest({ name: 'no-readme' }),
        packagePath,
      } as PreviewResult,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'no-readme' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ package: { readme?: string } }>(result);
    expect(payload.package.readme).toBeUndefined();
  });

  it('returns isError + PACKAGE_NOT_FOUND when no marketplace contains the package', async () => {
    const deps = createStubDeps({
      sources: [source({ name: 'community' }), source({ name: 'official' })],
      marketplaceJsonBySource: {
        community: { name: 'community', plugins: [entry({ name: 'other-pkg' })] },
        official: { name: 'official', plugins: [] },
      },
      preview: undefined,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'missing-pkg' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string }>(result);
    expect(payload.code).toBe('PACKAGE_NOT_FOUND');
    expect(payload.error).toContain('missing-pkg');
  });

  it('honors the explicit `marketplace` arg and skips other sources', async () => {
    const packagePath = await stagePackage({ readme: 'readme' });
    const deps = createStubDeps({
      sources: [source({ name: 'community' }), source({ name: 'official' })],
      marketplaceJsonBySource: {
        // Both contain the package — but with `marketplace: 'official'` the
        // handler must only consult `official`.
        community: { name: 'community', plugins: [entry({ name: 'shared-pkg' })] },
        official: {
          name: 'official',
          plugins: [entry({ name: 'shared-pkg', description: 'official copy' })],
        },
      },
      preview: {
        manifest: manifest({ name: 'shared-pkg' }),
        packagePath,
      } as PreviewResult,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'shared-pkg', marketplace: 'official' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ package: { marketplace: string; description?: string } }>(
      result
    );
    expect(payload.package.marketplace).toBe('official');
    expect(payload.package.description).toBe('official copy');
    // The fetcher should have been called only for the explicit marketplace.
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'official' })
    );
  });

  it('skips disabled marketplaces when no explicit marketplace is provided', async () => {
    const packagePath = await stagePackage({ readme: 'r' });
    const deps = createStubDeps({
      sources: [
        source({ name: 'disabled-mp', enabled: false }),
        source({ name: 'enabled-mp', enabled: true }),
      ],
      marketplaceJsonBySource: {
        // The handler must NOT call the disabled source — provide an Error so
        // the test fails loudly if it does.
        'disabled-mp': new Error('should not have been called'),
        'enabled-mp': {
          name: 'enabled-mp',
          plugins: [entry({ name: 'pkg-a' })],
        },
      },
      preview: {
        manifest: manifest({ name: 'pkg-a' }),
        packagePath,
      } as PreviewResult,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'pkg-a' });

    expect(result.isError).toBeUndefined();
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    expect(deps.fetcher.fetchMarketplaceJson).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'enabled-mp' })
    );
  });

  it('falls back to the marketplace.json entry when installer.preview() throws', async () => {
    const deps = createStubDeps({
      sources: [source({ name: 'community' })],
      marketplaceJsonBySource: {
        community: {
          name: 'community',
          plugins: [
            entry({
              name: 'broken-pkg',
              description: 'fallback description',
              category: 'tools',
              tags: ['t1'],
            }),
          ],
        },
      },
      preview: new Error('boom: clone failed'),
    });
    const warnSpy = vi.spyOn(deps.logger, 'warn');

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'broken-pkg' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      package: {
        name: string;
        description?: string;
        category?: string;
        tags?: string[];
        marketplace: string;
        manifest: MarketplacePackageManifest | null;
        readme?: string;
      };
    }>(result);
    expect(payload.package.name).toBe('broken-pkg');
    expect(payload.package.description).toBe('fallback description');
    expect(payload.package.category).toBe('tools');
    expect(payload.package.tags).toEqual(['t1']);
    expect(payload.package.marketplace).toBe('community');
    // Manifest is null because preview failed; readme is undefined for the
    // same reason. The handler must NOT throw.
    expect(payload.package.manifest).toBeNull();
    expect(payload.package.readme).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('logs a warning and continues when one marketplace.json fetch fails', async () => {
    const packagePath = await stagePackage({ readme: 'r' });
    const deps = createStubDeps({
      sources: [source({ name: 'broken-mp' }), source({ name: 'good-mp' })],
      marketplaceJsonBySource: {
        'broken-mp': new Error('network is down'),
        'good-mp': {
          name: 'good-mp',
          plugins: [entry({ name: 'pkg-b' })],
        },
      },
      preview: {
        manifest: manifest({ name: 'pkg-b' }),
        packagePath,
      } as PreviewResult,
    });
    const warnSpy = vi.spyOn(deps.logger, 'warn');

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'pkg-b' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ package: { marketplace: string } }>(result);
    expect(payload.package.marketplace).toBe('good-mp');
    expect(warnSpy).toHaveBeenCalled();
  });

  it("defaults `type` to 'plugin' when the marketplace.json entry omits it", async () => {
    const packagePath = await stagePackage({ readme: 'r' });
    const deps = createStubDeps({
      sources: [source({ name: 'community' })],
      marketplaceJsonBySource: {
        community: {
          name: 'community',
          plugins: [entry({ name: 'untyped-pkg' })],
        },
      },
      preview: {
        manifest: manifest({ name: 'untyped-pkg' }),
        packagePath,
      } as PreviewResult,
    });

    const handler = createGetHandler(deps);
    const result = await handler({ name: 'untyped-pkg' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ package: { type: string } }>(result);
    expect(payload.package.type).toBe('plugin');
  });
});
