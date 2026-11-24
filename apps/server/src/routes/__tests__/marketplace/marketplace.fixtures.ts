/**
 * The marketplace route group mounted on the real `/api` chain, with fake
 * fetcher, installer and flows, for the `marketplace.*.test.ts` files beside
 * this one. The capability registry, the tier gate, the approval service, the
 * source manager, the caches and the directory boundary are all real.
 *
 * `vi.mock` cannot live here (it is hoisted per test file), so each test file
 * declares only the mocks it needs itself.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { MarketplaceJson, PluginPackageManifest } from '@dorkos/marketplace';
import { initBoundary } from '../../../lib/boundary.js';
import { MarketplaceSourceManager } from '../../../services/marketplace/sources/marketplace-source-manager.js';
import { MarketplaceCache } from '../../../services/marketplace/cache/marketplace-cache.js';
import { PackageCacheRetention } from '../../../services/marketplace/cache/package-cache-retention.js';
import { PackageFetcher } from '../../../services/marketplace/package-fetcher.js';
import type { GitTreeSource } from '../../../services/marketplace/lib/git/git-tree.js';
import type { InstallerLike } from '../../../services/marketplace/installer/marketplace-installer.js';
import type { UninstallFlow } from '../../../services/marketplace/flows/uninstall/uninstall.js';
import type { UpdateFlow } from '../../../services/marketplace/flows/update.js';
import type { InstallResult, PermissionPreview } from '../../../services/marketplace/types.js';
import type { DisclosedEffects } from '../../../services/marketplace/preview/disclosed-effects.js';
import { createMarketplaceRoutes } from '../../marketplace.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  type CapabilityRegistry,
} from '../../../services/core/capabilities/index.js';
import { marketplaceDomain } from '../../../services/marketplace-mcp/marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../../../services/marketplace-mcp/marketplace-mcp-tools.js';
import { TokenConfirmationProvider } from '../../../services/marketplace-mcp/confirmation-provider.js';
import { ApprovalService } from '../../../services/core/approvals/index.js';
import { configManager, initConfigManager } from '../../../services/core/config-manager.js';

/** The listing the fake fetcher serves for every source. */
export const SAMPLE_MARKETPLACE_JSON: MarketplaceJson = {
  name: 'dorkos-community',
  owner: { name: 'Owner' },
  plugins: [
    {
      name: 'sample-plugin',
      source: 'https://github.com/dorkos/sample-plugin',
      description: 'A sample plugin',
      version: '1.0.0',
    },
  ],
};

/** A disclosure that runs nothing. */
export const RUNS_NOTHING: DisclosedEffects = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

/** A disclosure that runs one Stop hook with `command`. */
export function runs(command: string): DisclosedEffects {
  return { ...RUNS_NOTHING, hooks: [{ event: 'Stop', matcher: null, command, source: null }] };
}

/** The sample plugin's manifest. */
export function buildSamplePluginManifest(): PluginPackageManifest {
  return {
    schemaVersion: 1,
    name: 'sample-plugin',
    version: '1.0.0',
    type: 'plugin',
    description: 'Sample plugin fixture',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    schedules: [],
  };
}

/** A permission preview that lists nothing. */
export function buildEmptyPermissionPreview(): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    skillCommands: [],
    skippedLinks: [],
    unreadableDeclarations: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };
}

/** A successful install of the sample plugin. */
export function buildSampleInstallResult(): InstallResult {
  return {
    ok: true,
    packageName: 'sample-plugin',
    version: '1.0.0',
    type: 'plugin',
    installPath: '/fake/install/path',
    manifest: buildSamplePluginManifest(),
    warnings: [],
  };
}

/** A successful uninstall of `packageName`. */
export function uninstallResult(packageName = 'sample-plugin', removedFiles = 1) {
  return { ok: true, packageName, removedFiles, preservedData: [] };
}

/** Write `.dork/manifest.json` under `dir`, creating it. */
export function writePackageManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(join(dir, '.dork', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/** A registry where `marketplace.install` asks a person, as if its tier were raised. */
export function registryAskingForInstalls(): CapabilityRegistry {
  return composeRegistry(
    [
      {
        ...marketplaceDomain,
        capabilities: marketplaceDomain.capabilities.map((c) =>
          c.id === 'marketplace.install' ? { ...c, tier: 'destructive' as const } : c
        ),
      },
    ],
    { logger: noopLogger, marketplaceDeps: {} as MarketplaceMcpDeps }
  );
}

/** Turn local login on, as the owner would in settings. */
export function enableLogin(): void {
  configManager.set('auth', { enabled: true });
}

/** The fake package fetcher: only the methods the routes touch. */
export interface FakeFetcher {
  fetchMarketplaceJson: Mock;
  fetchDorkosSidecar: Mock;
  fetchAtCommit: Mock;
}

/** Everything a marketplace route test reads or steers. */
export interface MarketplaceHarness {
  /** The listening server the routes answer on. */
  server: Server;
  /** This test's data directory, canonical, and the directory boundary. */
  dorkHome: string;
  sourceManager: MarketplaceSourceManager;
  cache: MarketplaceCache;
  fetcher: FakeFetcher;
  installer: { preview: Mock; install: Mock };
  uninstallFlow: { uninstall: Mock };
  updateFlow: { run: Mock; planInstallations: Mock; applyPlan: Mock; clearMemos: Mock };
  onPluginsChanged: Mock;
  consent: { settle: Mock; removed: Mock };
  approvals: ApprovalService;
  /** The agents whose project folders the routes scan. */
  agentScopes: Array<{ projectPath: string; id?: string; name?: string }>;
  /** Set to make a request look like an agent's rather than the app's. */
  agentHeader: string | undefined;
  /** Stands in for what the session gate attaches once login is on. */
  signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
  /** The capability registry the tier gate reads. */
  gateRegistry: CapabilityRegistry;
  /** Remount the routes on a real `PackageFetcher` over this test's cache. */
  useRealFetcher(): void;
  /** `GET /api/marketplace<path>`. */
  get(path: string): ReturnType<ReturnType<typeof request>['get']>;
  /** `POST /api/marketplace<path>` with a JSON body. */
  post(path: string, body?: object): ReturnType<ReturnType<typeof request>['post']>;
  /** `DELETE /api/marketplace<path>`. */
  del(path: string): ReturnType<ReturnType<typeof request>['delete']>;
}

/**
 * Mount the marketplace routes afresh before every test of the calling file,
 * and clean up after it. Call once, at module scope.
 */
export function useMarketplaceRoutes(): MarketplaceHarness {
  const target = swappableServer();
  const h = { server: target.server } as MarketplaceHarness;

  function mount(routeFetcher: PackageFetcher): void {
    const routes = createMarketplaceRoutes({
      sourceManager: h.sourceManager,
      cache: h.cache,
      cacheRetention: new PackageCacheRetention({
        cache: h.cache,
        dorkHome: h.dorkHome,
        listAgentScopes: () => h.agentScopes,
        logger: noopLogger,
      }),
      fetcher: routeFetcher,
      installer: h.installer as unknown as InstallerLike,
      uninstallFlow: h.uninstallFlow as unknown as UninstallFlow,
      updateFlow: h.updateFlow as unknown as UpdateFlow,
      dorkHome: h.dorkHome,
      onPluginsChanged: h.onPluginsChanged,
      listAgentScopes: () => h.agentScopes,
      capabilityRegistry: () => h.gateRegistry,
      confirmationProvider: new TokenConfirmationProvider(h.approvals),
      consent: h.consent,
      heldBackCards: { approvals: h.approvals, onGranted: vi.fn() },
    });
    target.mount(
      honoGroupListener(
        { path: '/api/marketplace', routes },
        {
          before: async (c, next) => {
            // Stands in for the agent-identity middleware: with no agent
            // header the request is the app's own (DOR-467).
            if (h.agentHeader) c.env.incoming.headers['x-dorkos-agent'] = h.agentHeader;
            if (h.signedInUser) c.set('user', h.signedInUser);
            await next();
          },
        }
      )
    );
  }

  beforeEach(async () => {
    h.dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'dorkos-marketplace-routes-')));
    await initBoundary(h.dorkHome);
    h.sourceManager = new MarketplaceSourceManager(h.dorkHome);
    h.cache = new MarketplaceCache(h.dorkHome);
    h.fetcher = {
      fetchMarketplaceJson: vi.fn().mockResolvedValue(SAMPLE_MARKETPLACE_JSON),
      fetchDorkosSidecar: vi.fn().mockResolvedValue(null),
      fetchAtCommit: vi.fn().mockRejectedValue(new Error('no network in tests')),
    };
    h.installer = { preview: vi.fn(), install: vi.fn() };
    h.uninstallFlow = { uninstall: vi.fn() };
    h.updateFlow = {
      run: vi.fn(),
      planInstallations: vi.fn(),
      applyPlan: vi.fn(),
      clearMemos: vi.fn(),
    };
    h.onPluginsChanged = vi.fn();
    h.consent = { settle: vi.fn(async () => {}), removed: vi.fn() };
    h.agentScopes = [];
    h.agentHeader = undefined;
    h.signedInUser = undefined;
    // With no config manager the gate fails closed (assumes login on); these
    // tests run in the real default posture, login off.
    initConfigManager(h.dorkHome);
    h.gateRegistry = composeRegistry([marketplaceDomain], {
      logger: noopLogger,
      marketplaceDeps: {} as MarketplaceMcpDeps,
    });
    h.approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals: h.approvals });
    mount(h.fetcher as unknown as PackageFetcher);
  });

  afterEach(() => {
    rmSync(h.dorkHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  h.useRealFetcher = () => mount(new PackageFetcher(h.cache, {} as GitTreeSource, noopLogger));
  h.get = (path) => request(h.server).get(`/api/marketplace${path}`);
  h.post = (path, body) => request(h.server).post(`/api/marketplace${path}`).send(body);
  h.del = (path) => request(h.server).delete(`/api/marketplace${path}`);
  return h;
}

/** The names `GET /sources` lists, read as the app would (no agent header). */
export async function listSourceNames(h: MarketplaceHarness): Promise<string[]> {
  const saved = h.agentHeader;
  h.agentHeader = undefined;
  const res = await h.get('/sources');
  h.agentHeader = saved;
  return res.body.sources.map((s: { name: string }) => s.name);
}

/** Make a fresh temporary folder outside the data directory. */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Install a global plugin that runs one hook nobody approved, recorded with
 * its content hash as the installer records it.
 */
export async function installHeldBack(dorkHome: string, name: string): Promise<string> {
  const { packageContentHash } = await import('../../../services/marketplace/lib/content-hash.js');
  const root = join(dorkHome, 'plugins', name);
  writePackageManifest(root, { ...buildSamplePluginManifest(), name });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
  );
  writeFileSync(
    join(root, '.dork', 'install-metadata.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'plugin',
      installedAt: '2026-09-24T00:00:00Z',
      contentHash: await packageContentHash(root),
    })
  );
  return root;
}

/** The skill an update kept that nothing could sort. */
export const KEPT_SKILL = '---\nname: kept\ndescription: Kept.\n---\n\nKept.\n';

/**
 * A held-back global plugin whose update kept a skill nothing could sort, so
 * the kept skill also runs.
 */
export async function installWithKeptSkill(dorkHome: string, name = 'flow'): Promise<string> {
  const root = await installHeldBack(dorkHome, name);
  const { computeInstalledFiles, writeInstalledFiles } =
    await import('../../../services/marketplace/lib/records/installed-files.js');
  const record = await computeInstalledFiles(root, {
    identity: { name, type: 'plugin' },
    userEditable: [],
    npmRan: false,
  });
  mkdirSync(join(root, 'skills', 'old'), { recursive: true });
  writeFileSync(join(root, 'skills', 'old', 'SKILL.md'), KEPT_SKILL);
  await writeInstalledFiles(root, {
    ...record,
    unproven: { why: 'no-source', files: { 'skills/old/SKILL.md': 'skills/old/SKILL.md' } },
  });
  return root;
}

/** The keep key the Installed row shows for `name`'s kept files. */
export async function keepKeyOf(h: MarketplaceHarness, name = 'flow'): Promise<string> {
  const installed = await h.get('/installed?verify=true');
  const row = installed.body.packages.find((p: { name: string }) => p.name === name);
  return row.integrity.unproven.keepKey;
}

/** The kept-files record on disk under `root`, or undefined once kept. */
export async function unprovenOnDisk(root: string) {
  const { readInstalledFiles } =
    await import('../../../services/marketplace/lib/records/installed-files.js');
  return (await readInstalledFiles(root))?.unproven;
}
