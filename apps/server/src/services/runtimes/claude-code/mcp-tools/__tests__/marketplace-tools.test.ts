/**
 * Tests for the in-session marketplace tools (`getMarketplaceTools`).
 *
 * These prove the same eight marketplace tools that back the external `/mcp`
 * server are registered on the in-session `dorkos` server, and that they run
 * end-to-end through the in-session registration path — covering one read tool
 * (`marketplace_search`) and the install confirmation-token flow, whose trust
 * boundary must be preserved regardless of transport.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/marketplace-tools
 */
import { describe, it, expect, vi } from 'vitest';

import { getMarketplaceTools } from '../marketplace-tools.js';
import type { MarketplaceMcpDeps } from '../../../../marketplace-mcp/marketplace-mcp-tools.js';
import {
  TokenConfirmationProvider,
  type ConfirmationProvider,
} from '../../../../marketplace-mcp/confirmation-provider.js';
import {
  type InstallerLike,
  type PreviewResult,
} from '../../../../marketplace/marketplace-installer.js';
import type {
  InstallRequest,
  InstallResult,
  PermissionPreview,
} from '../../../../marketplace/types.js';
import type { MarketplaceSource } from '../../../../marketplace/marketplace-source-manager.js';

/** The eight marketplace tools the in-session server must expose. */
const EXPECTED_TOOLS = [
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_marketplaces',
  'marketplace_list_installed',
  'marketplace_recommend',
  'marketplace_install',
  'marketplace_uninstall',
  'marketplace_create_package',
] as const;

/** Minimal SDK tool-definition shape exercised by these tests. */
interface SdkTool {
  name: string;
  description: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{
    content: { type: 'text'; text: string }[];
    isError?: boolean;
  }>;
}

/** Parse the JSON payload out of an MCP text-content tool result. */
function parsePayload<T = unknown>(result: { content: { type: 'text'; text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

/** A logger stub whose methods are inert spies. */
function stubLogger(): MarketplaceMcpDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Build a deps bundle populated only with the fields a given test exercises.
 * Unused collaborators are cast through `unknown` so the cast stays local.
 */
function buildDeps(overrides: Partial<MarketplaceMcpDeps> = {}): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/.dork-test-insession',
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: {} as MarketplaceMcpDeps['confirmationProvider'],
    logger: stubLogger(),
    ...overrides,
  };
}

/** Find a registered in-session tool by name, failing loudly if absent. */
function toolByName(tools: SdkTool[], name: string): SdkTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool '${name}' not registered`);
  return found;
}

describe('getMarketplaceTools — registration', () => {
  it('returns an empty array when marketplace deps are unavailable', () => {
    expect(getMarketplaceTools(undefined)).toEqual([]);
  });

  it('registers all eight marketplace tools with the shared descriptors', () => {
    const tools = getMarketplaceTools(buildDeps()) as unknown as SdkTool[];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('carries a non-empty description on every tool', () => {
    const tools = getMarketplaceTools(buildDeps()) as unknown as SdkTool[];
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe('getMarketplaceTools — marketplace_search (read tool)', () => {
  it('aggregates and returns matching entries through the in-session handler', async () => {
    const source: MarketplaceSource = {
      name: 'dorkos-community',
      source: 'https://example.com/marketplace',
      enabled: true,
    } as MarketplaceSource;

    const deps = buildDeps({
      sourceManager: {
        list: vi.fn(async () => [source]),
      } as unknown as MarketplaceMcpDeps['sourceManager'],
      fetcher: {
        fetchMarketplaceJson: vi.fn(async () => ({
          plugins: [
            { name: 'sentry', type: 'plugin', description: 'Error tracking', tags: ['errors'] },
            { name: 'linear', type: 'plugin', description: 'Issue tracking', tags: ['tasks'] },
          ],
        })),
      } as unknown as MarketplaceMcpDeps['fetcher'],
    });

    const tools = getMarketplaceTools(deps) as unknown as SdkTool[];
    const search = toolByName(tools, 'marketplace_search');
    const result = await search.handler({ query: 'sentry' }, undefined);

    const payload = parsePayload<{ results: { name: string }[]; total: number }>(result);
    expect(payload.total).toBe(1);
    expect(payload.results[0].name).toBe('sentry');
  });
});

describe('getMarketplaceTools — marketplace_install confirmation flow', () => {
  const preview: PermissionPreview = {
    fileChanges: [],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };

  function previewResult(name: string): PreviewResult {
    return {
      preview,
      manifest: {
        manifestVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: 'A package',
      } as PreviewResult['manifest'],
      packagePath: `/tmp/.dork-test-insession/cache/${name}`,
    };
  }

  function installResult(name: string): InstallResult {
    return {
      ok: true,
      packageName: name,
      version: '1.0.0',
      type: 'plugin',
      installPath: `/tmp/.dork-test-insession/plugins/${name}`,
      manifest: previewResult(name).manifest,
      warnings: [],
    };
  }

  function stubInstaller(): InstallerLike {
    return {
      preview: vi.fn(async (_req: InstallRequest) => previewResult('sentry')),
      install: vi.fn(async (_req: InstallRequest) => installResult('sentry')),
      update: vi.fn(async () => {
        throw new Error('update() should not be called');
      }),
    } as unknown as InstallerLike;
  }

  it('gates the first call behind a confirmation token, then installs on resume', async () => {
    const tokenProvider: ConfirmationProvider = new TokenConfirmationProvider();
    const installer = stubInstaller();
    const deps = buildDeps({ installer, confirmationProvider: tokenProvider });

    const tools = getMarketplaceTools(deps) as unknown as SdkTool[];
    const install = toolByName(tools, 'marketplace_install');

    // First call → requires_confirmation with a token; no install yet.
    const first = await install.handler({ name: 'sentry' }, undefined);
    const firstPayload = parsePayload<{ status: string; confirmationToken: string }>(first);
    expect(firstPayload.status).toBe('requires_confirmation');
    expect(firstPayload.confirmationToken).toMatch(/[0-9a-f-]{36}/);
    expect(installer.install).not.toHaveBeenCalled();

    // Out-of-band approval (as the DorkOS UI would do).
    (tokenProvider as TokenConfirmationProvider).approve(firstPayload.confirmationToken);

    // Resume with the token → install proceeds.
    const second = await install.handler(
      { name: 'sentry', confirmationToken: firstPayload.confirmationToken },
      undefined
    );
    const secondPayload = parsePayload<{ status: string; package: { name: string } }>(second);
    expect(secondPayload.status).toBe('installed');
    expect(secondPayload.package.name).toBe('sentry');
    expect(installer.install).toHaveBeenCalledTimes(1);
  });
});
