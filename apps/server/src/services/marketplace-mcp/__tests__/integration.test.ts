/**
 * End-to-end integration test for the marketplace MCP tool suite.
 *
 * Stands up a real `McpServer` with `registerMarketplaceTools()` against:
 *
 *   - real {@link MarketplaceSourceManager} rooted at an `mkdtemp` `dorkHome`
 *   - real {@link MarketplaceCache} rooted at the same `dorkHome`
 *   - real {@link PackageFetcher} backed by a stub `TemplateDownloader`
 *   - real {@link TokenConfirmationProvider} for the issue / approve / decline cycle
 *   - real {@link ensurePersonalMarketplace} bootstrap so the personal source is on disk
 *   - **stub** `InstallerLike` (preview / install / update spies) — never instantiates
 *     the real {@link MarketplaceInstaller} or {@link runTransaction}
 *   - **stub** `UninstallFlow` (uninstall spy)
 *
 * The community marketplace fixture is a second `mkdtemp` directory with a real
 * `marketplace.json` on disk, registered with the source manager via a
 * `file://` URL. Combined with task #1's `file://` support in
 * `PackageFetcher.fetchMarketplaceJson`, this lets the search/recommend/get
 * tools exercise the real fetch → cache → parse pipeline without any network
 * I/O.
 *
 * ⚠️ Safety: this test deliberately stubs the install + uninstall flows so
 * `runTransaction({ rollbackBranch: true })` is structurally unreachable. See
 * `contributing/marketplace-installs.md#5-transaction-lifecycle` and ADR-0231.
 * Any future iteration that wires the real `MarketplaceInstaller` MUST add
 * `vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false)` in
 * `beforeEach` to prevent destruction of uncommitted work.
 *
 * Tool handlers are invoked via the SDK's internal `_registeredTools` record so
 * the test exercises the same registration path used in production. The MCP
 * SDK does not yet expose a public "invoke registered tool" helper; if a
 * future SDK version adds one, switch to it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@dorkos/shared/logger';

import { MarketplaceSourceManager } from '../../marketplace/marketplace-source-manager.js';
import { MarketplaceCache } from '../../marketplace/marketplace-cache.js';
import { PackageFetcher } from '../../marketplace/package-fetcher.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import type { InstallerLike, PreviewResult } from '../../marketplace/marketplace-installer.js';
import type { InstallRequest, InstallResult, PermissionPreview } from '../../marketplace/types.js';
import type { UninstallFlow } from '../../marketplace/flows/uninstall.js';
import type { UninstallRequest, UninstallResult } from '../../marketplace/flows/uninstall.js';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';

import { registerMarketplaceTools, type MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import { TokenConfirmationProvider } from '../confirmation-provider.js';
import {
  ensurePersonalMarketplace,
  personalMarketplaceRoot,
  PERSONAL_MARKETPLACE_NAME,
} from '../personal-marketplace.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal SDK shape used to invoke a registered tool's handler. The MCP SDK
 * stores tools in a private `_registeredTools` record keyed by tool name; each
 * entry exposes a `handler(args, extra)` callable. Documented at
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (private
 * field) and exercised via the SDK's own request dispatcher in `mcp.js`.
 */
interface RegisteredToolEntry {
  handler: (
    args: unknown,
    extra: unknown
  ) => Promise<{
    content: { type: 'text'; text: string }[];
    isError?: boolean;
  }>;
}

/**
 * Reflective accessor for `_registeredTools`. Tests use it instead of touching
 * the private field inline so the cast lives in one place — if a future SDK
 * version moves the registry, only this helper needs updating.
 */
function getRegisteredTool(server: McpServer, name: string): RegisteredToolEntry {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredToolEntry> };
  const tool = internal._registeredTools[name];
  if (!tool) {
    throw new Error(`Tool '${name}' is not registered on the McpServer`);
  }
  return tool;
}

/**
 * Invoke a registered tool by name. Wraps {@link getRegisteredTool} so test
 * bodies read like "call this tool, parse the response" without any reflection
 * noise.
 *
 * @param server - The McpServer the tools are registered on.
 * @param name - The tool name (e.g. `marketplace_search`).
 * @param args - The tool's arguments (typed as `unknown` because each tool has
 *   its own argument shape).
 */
async function callTool(
  server: McpServer,
  name: string,
  args: unknown
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const tool = getRegisteredTool(server, name);
  return tool.handler(args, {} as unknown);
}

/**
 * Parse the JSON `text` payload out of an MCP tool result envelope. Mirrors
 * the shape every marketplace handler returns: `{ content: [{ type: 'text', text: '<json>' }] }`.
 */
function parsePayload<T = unknown>(result: { content: { type: 'text'; text: string }[] }): T {
  const block = result.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Expected first content block to be text');
  }
  return JSON.parse(block.text) as T;
}

/** Build a logger whose every method is a `vi.fn()` spy. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a stub `TemplateDownloader`. The integration test never reaches the
 * git-clone path because every fetch is `file://` based, so the stub throws
 * if it is ever invoked — that surfaces accidental network use as a test
 * failure rather than a silent skip.
 */
function buildStubDownloader(): TemplateDownloader {
  return {
    cloneRepository: vi.fn(async () => {
      throw new Error('TemplateDownloader.cloneRepository must not be called in this test');
    }),
  } as TemplateDownloader;
}

/**
 * Build a minimal valid `MarketplacePackageManifest` for canned preview
 * results returned by the stub installer. Tests override only the fields they
 * care about.
 */
function buildManifest(name: string, version = '1.0.0'): MarketplacePackageManifest {
  return {
    manifestVersion: 1,
    name,
    version,
    type: 'plugin',
    description: `${name} test package`,
  } as MarketplacePackageManifest;
}

/** Build an empty `PermissionPreview` shell. */
function emptyPreview(): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };
}

/**
 * Build a stub `InstallerLike` that records calls and returns canned data.
 * The stub never instantiates the real `MarketplaceInstaller`, so the
 * rollback-safe transaction engine is structurally unreachable from this
 * test — see the safety note at the top of the file.
 */
function buildStubInstaller(): InstallerLike & {
  preview: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const preview = vi.fn(async (req: InstallRequest): Promise<PreviewResult> => {
    return {
      preview: emptyPreview(),
      manifest: buildManifest(req.name),
      packagePath: `/tmp/staged/${req.name}`,
    };
  });
  const install = vi.fn(async (req: InstallRequest): Promise<InstallResult> => {
    return {
      ok: true,
      packageName: req.name,
      version: '1.0.0',
      type: 'plugin',
      installPath: `/tmp/installed/${req.name}`,
      manifest: buildManifest(req.name),
      warnings: [],
    };
  });
  const update = vi.fn(async () => {
    throw new Error('update() should not be called in the integration test');
  });
  return { preview, install, update };
}

/**
 * Build a stub `UninstallFlow` that records calls and returns a canned
 * success result. Cast through `unknown` to satisfy the `UninstallFlow` class
 * type without instantiating the real flow's deps.
 */
function buildStubUninstallFlow(): UninstallFlow & {
  uninstall: ReturnType<typeof vi.fn>;
} {
  const uninstall = vi.fn(async (req: UninstallRequest): Promise<UninstallResult> => {
    return {
      ok: true,
      packageName: req.name,
      removedFiles: 1,
      preservedData: [],
    };
  });
  return { uninstall } as unknown as UninstallFlow & { uninstall: ReturnType<typeof vi.fn> };
}

/**
 * Pre-seed `${dorkHome}/marketplaces.json` with a single `file://` source so
 * the source manager does not auto-seed the production HTTPS defaults
 * (`dorkos-community`, `claude-plugins-official`) which would attempt real
 * network calls during the integration test.
 *
 * @param dorkHome - Resolved DorkOS data directory for the test
 * @param communityRoot - Absolute filesystem path to the community marketplace
 *   fixture directory (the directory containing `marketplace.json`)
 */
async function seedSourcesFile(dorkHome: string, communityRoot: string): Promise<void> {
  const filePath = path.join(dorkHome, 'marketplaces.json');
  await mkdir(dorkHome, { recursive: true });
  const content = {
    version: 1 as const,
    sources: [
      {
        name: 'community',
        source: `file://${communityRoot}`,
        enabled: true,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
}

/**
 * Write a community marketplace fixture to disk: a `marketplace.json` envelope
 * with a handful of fake plugin entries spanning multiple types and tags so
 * search/recommend/get all have something to chew on.
 *
 * @returns Absolute path to the directory containing `marketplace.json`.
 */
async function writeCommunityFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-integration-community-'));
  const json = {
    name: 'community',
    description: 'Test community marketplace',
    plugins: [
      {
        name: 'sentry-monitor',
        source: `file://${dir}/sentry-monitor`,
        description: 'Track errors and exceptions across your Next.js app',
        type: 'plugin',
        category: 'observability',
        tags: ['errors', 'monitoring', 'nextjs'],
        featured: true,
      },
      {
        name: 'log-pretty',
        source: `file://${dir}/log-pretty`,
        description: 'Pretty-print structured logs in the terminal',
        type: 'plugin',
        category: 'devex',
        tags: ['logging', 'terminal'],
      },
      {
        name: 'planner-agent',
        source: `file://${dir}/planner-agent`,
        description: 'Autonomous planning agent for multi-step tasks',
        type: 'agent',
        category: 'productivity',
        tags: ['planning', 'autonomous'],
      },
    ],
  };
  await writeFile(
    path.join(dir, 'marketplace.json'),
    `${JSON.stringify(json, null, 2)}\n`,
    'utf-8'
  );
  return dir;
}

/**
 * Build a fully wired `MarketplaceMcpDeps` bundle for the integration test.
 * Real services for everything except the installer + uninstall flow, which
 * are stubs to keep the rollback transaction engine out of the picture.
 */
function buildIntegrationDeps(opts: {
  dorkHome: string;
  sourceManager: MarketplaceSourceManager;
  cache: MarketplaceCache;
  fetcher: PackageFetcher;
  installer: InstallerLike;
  uninstallFlow: UninstallFlow;
  confirmationProvider: TokenConfirmationProvider;
  logger: Logger;
}): MarketplaceMcpDeps {
  return {
    dorkHome: opts.dorkHome,
    installer: opts.installer,
    sourceManager: opts.sourceManager,
    fetcher: opts.fetcher,
    cache: opts.cache,
    uninstallFlow: opts.uninstallFlow,
    confirmationProvider: opts.confirmationProvider,
    logger: opts.logger,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('marketplace-mcp integration', () => {
  let dorkHome: string;
  let communityRoot: string;
  let server: McpServer;
  let installer: ReturnType<typeof buildStubInstaller>;
  let uninstallFlow: ReturnType<typeof buildStubUninstallFlow>;
  let confirmationProvider: TokenConfirmationProvider;
  let sourceManager: MarketplaceSourceManager;
  let logger: Logger;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'mcp-integration-dorkhome-'));
    communityRoot = await writeCommunityFixture();

    // Pre-seed marketplaces.json so the source manager skips its production
    // HTTPS default seed (dorkos-community + claude-plugins-official). The
    // integration test must never make real network calls.
    await seedSourcesFile(dorkHome, communityRoot);

    logger = buildLogger();
    sourceManager = new MarketplaceSourceManager(dorkHome);
    const cache = new MarketplaceCache(dorkHome);
    const downloader = buildStubDownloader();
    const fetcher = new PackageFetcher(cache, downloader, logger);

    // Bootstrap the personal marketplace so scenario 2 sees BOTH community
    // (file:// fixture) and personal sources.
    await ensurePersonalMarketplace({ dorkHome, sourceManager, logger });

    installer = buildStubInstaller();
    uninstallFlow = buildStubUninstallFlow();
    confirmationProvider = new TokenConfirmationProvider();

    server = new McpServer({ name: 'dorkos-marketplace-test', version: '1.0.0' });
    registerMarketplaceTools(
      server,
      buildIntegrationDeps({
        dorkHome,
        sourceManager,
        cache,
        fetcher,
        installer,
        uninstallFlow,
        confirmationProvider,
        logger,
      })
    );

    // Register a tiny `ping` tool inline alongside the marketplace tools so
    // scenario 8 can verify the marketplace registrations do not clobber
    // sibling tools on the same server instance. Inlined to avoid pulling
    // `@anthropic-ai/claude-agent-sdk` (forbidden by ESLint outside the
    // claude-code runtime) into the marketplace test surface.
    server.tool('ping', 'Health check stub', {}, async () => ({
      content: [{ type: 'text' as const, text: 'pong' }],
    }));
    server.tool('get_server_info', 'Server identity stub', {}, async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ name: 'dorkos-marketplace-test', version: '1.0.0' }),
        },
      ],
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
    await rm(communityRoot, { recursive: true, force: true });
  });

  // ── Scenario 1 ───────────────────────────────────────────────────────────
  it('search → returns matching results from the community fixture', async () => {
    const result = await callTool(server, 'marketplace_search', { query: 'errors', limit: 20 });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{
      results: { name: string; marketplace: string; type: string }[];
      total: number;
    }>(result);

    expect(payload.total).toBeGreaterThanOrEqual(1);
    const names = payload.results.map((r) => r.name);
    expect(names).toContain('sentry-monitor');
    // The matched entry must be tagged with its source marketplace.
    const sentry = payload.results.find((r) => r.name === 'sentry-monitor');
    expect(sentry?.marketplace).toBe('community');
    expect(sentry?.type).toBe('plugin');
  });

  // ── Scenario 2 ───────────────────────────────────────────────────────────
  it('list_marketplaces → reports both personal and community sources', async () => {
    const result = await callTool(server, 'marketplace_list_marketplaces', {});

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{
      sources: { name: string; source: string; enabled: boolean; packageCount: number }[];
    }>(result);

    const names = payload.sources.map((s) => s.name).sort();
    expect(names).toContain(PERSONAL_MARKETPLACE_NAME);
    expect(names).toContain('community');

    const community = payload.sources.find((s) => s.name === 'community');
    expect(community?.enabled).toBe(true);
    expect(community?.packageCount).toBe(3);

    const personal = payload.sources.find((s) => s.name === PERSONAL_MARKETPLACE_NAME);
    expect(personal?.enabled).toBe(true);
    expect(personal?.packageCount).toBe(0);
  });

  // ── Scenario 3 ───────────────────────────────────────────────────────────
  it('recommend → surfaces a relevant package for a free-text context', async () => {
    const result = await callTool(server, 'marketplace_recommend', {
      context: 'I need to track errors in my Next.js app',
      limit: 5,
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{
      recommendations: {
        name: string;
        marketplace: string;
        relevanceScore: number;
        reason: string;
      }[];
    }>(result);

    expect(payload.recommendations.length).toBeGreaterThan(0);
    const top = payload.recommendations[0];
    expect(top?.name).toBe('sentry-monitor');
    expect(top?.marketplace).toBe('community');
    expect(top?.relevanceScore).toBeGreaterThan(0);
    expect(top?.reason.length).toBeGreaterThan(0);
  });

  // ── Scenario 4 ───────────────────────────────────────────────────────────
  it('install → token round-trip: pending → approve → installed', async () => {
    // First call: no token. Should issue a fresh confirmation token and NOT
    // touch the install path.
    const first = await callTool(server, 'marketplace_install', {
      name: 'sentry-monitor',
      marketplace: 'community',
    });

    expect(first.isError).toBeUndefined();
    const firstPayload = parsePayload<{
      status: string;
      confirmationToken: string;
      preview: PermissionPreview;
      message: string;
    }>(first);
    expect(firstPayload.status).toBe('requires_confirmation');
    expect(firstPayload.confirmationToken).toMatch(/[0-9a-f-]{36}/);
    expect(firstPayload.preview).toBeDefined();
    expect(installer.install).not.toHaveBeenCalled();

    // Out-of-band approval — simulates the DorkOS UI clicking Approve.
    confirmationProvider.approve(firstPayload.confirmationToken);

    // Second call: re-call with the token. The handler must NOT request a
    // fresh confirmation; it must resolve the token and proceed with the
    // install.
    const requestSpy = vi.spyOn(confirmationProvider, 'requestInstallConfirmation');
    const second = await callTool(server, 'marketplace_install', {
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken: firstPayload.confirmationToken,
    });
    expect(requestSpy).not.toHaveBeenCalled();

    expect(second.isError).toBeUndefined();
    const secondPayload = parsePayload<{
      status: string;
      package: { name: string; version: string; type: string };
      installPath: string;
    }>(second);
    expect(secondPayload.status).toBe('installed');
    expect(secondPayload.package.name).toBe('sentry-monitor');
    expect(installer.install).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 5 ───────────────────────────────────────────────────────────
  it('install → token round-trip: pending → decline → declined with reason', async () => {
    const first = await callTool(server, 'marketplace_install', {
      name: 'sentry-monitor',
      marketplace: 'community',
    });
    const { confirmationToken } = parsePayload<{ confirmationToken: string }>(first);

    confirmationProvider.decline(confirmationToken, 'no thanks');

    const second = await callTool(server, 'marketplace_install', {
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken,
    });

    expect(second.isError).toBeUndefined();
    const payload = parsePayload<{ status: string; reason: string }>(second);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('no thanks');
    // The stub installer's install() must NOT have been called on the
    // declined path — the confirmation gate is the trust boundary.
    expect(installer.install).not.toHaveBeenCalled();
  });

  // ── Scenario 6 ───────────────────────────────────────────────────────────
  it('uninstall → token round-trip: pending → approve → uninstalled', async () => {
    const first = await callTool(server, 'marketplace_uninstall', { name: 'sentry-monitor' });
    expect(first.isError).toBeUndefined();
    const firstPayload = parsePayload<{ status: string; confirmationToken: string }>(first);
    expect(firstPayload.status).toBe('requires_confirmation');
    expect(uninstallFlow.uninstall).not.toHaveBeenCalled();

    confirmationProvider.approve(firstPayload.confirmationToken);

    const second = await callTool(server, 'marketplace_uninstall', {
      name: 'sentry-monitor',
      confirmationToken: firstPayload.confirmationToken,
    });
    expect(second.isError).toBeUndefined();
    const payload = parsePayload<{ status: string; package: { name: string } }>(second);
    expect(payload.status).toBe('uninstalled');
    expect(payload.package.name).toBe('sentry-monitor');
    expect(uninstallFlow.uninstall).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 7 ───────────────────────────────────────────────────────────
  it('create_package → end-to-end scaffold under personal marketplace', async () => {
    const first = await callTool(server, 'marketplace_create_package', {
      name: 'my-skill-pack',
      type: 'skill-pack',
      description: 'A test skill pack scaffolded by the integration test',
    });
    const firstPayload = parsePayload<{ status: string; confirmationToken: string }>(first);
    expect(firstPayload.status).toBe('requires_confirmation');

    // Confirmation gate fired BEFORE any disk write — the package directory
    // must not exist yet.
    const expectedPackagePath = path.join(
      personalMarketplaceRoot(dorkHome),
      'packages',
      'my-skill-pack'
    );
    await expect(access(expectedPackagePath)).rejects.toThrow();

    confirmationProvider.approve(firstPayload.confirmationToken);

    const second = await callTool(server, 'marketplace_create_package', {
      name: 'my-skill-pack',
      type: 'skill-pack',
      description: 'A test skill pack scaffolded by the integration test',
      confirmationToken: firstPayload.confirmationToken,
    });
    const secondPayload = parsePayload<{
      status: string;
      packagePath: string;
      filesCreated: string[];
    }>(second);
    expect(secondPayload.status).toBe('created');
    expect(secondPayload.packagePath).toBe(expectedPackagePath);
    expect(secondPayload.filesCreated.length).toBeGreaterThan(0);

    // Files exist on disk.
    await expect(
      access(path.join(expectedPackagePath, '.dork', 'manifest.json'))
    ).resolves.toBeUndefined();
    await expect(access(path.join(expectedPackagePath, 'README.md'))).resolves.toBeUndefined();

    // Personal marketplace.json was updated to include the new package so
    // search and list tools pick it up immediately.
    const list = await callTool(server, 'marketplace_list_marketplaces', {});
    const listPayload = parsePayload<{
      sources: { name: string; packageCount: number }[];
    }>(list);
    const personal = listPayload.sources.find((s) => s.name === PERSONAL_MARKETPLACE_NAME);
    expect(personal?.packageCount).toBe(1);
  });

  // ── Scenario 8 ───────────────────────────────────────────────────────────
  it('does not regress sibling tools registered on the same server', async () => {
    // The marketplace registrations must coexist with the existing core tools
    // (`ping`, `get_server_info`) on a shared `McpServer`. Both surfaces are
    // exercised here against the SAME server instance.

    // Marketplace surface still works.
    const search = await callTool(server, 'marketplace_search', { limit: 20 });
    expect(search.isError).toBeUndefined();

    // Core tools still work.
    const ping = await callTool(server, 'ping', {});
    expect(ping.isError).toBeUndefined();
    expect(ping.content[0]?.text).toBe('pong');

    const info = await callTool(server, 'get_server_info', {});
    expect(info.isError).toBeUndefined();
    const infoPayload = parsePayload<{ name: string; version: string }>(info);
    expect(infoPayload.name).toBe('dorkos-marketplace-test');
    expect(infoPayload.version).toBe('1.0.0');

    // No accidental tool name collisions: every expected tool is registered.
    for (const name of [
      'marketplace_search',
      'marketplace_get',
      'marketplace_list_marketplaces',
      'marketplace_list_installed',
      'marketplace_recommend',
      'marketplace_install',
      'marketplace_uninstall',
      'marketplace_create_package',
      'ping',
      'get_server_info',
    ]) {
      expect(() => getRegisteredTool(server, name)).not.toThrow();
    }
  });
});
