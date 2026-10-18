/**
 * An agent computer installs only what works on a cloud agent (DOR-2940 part
 * 9): anything else is refused with the sentence the marketplace card shows,
 * before any flow writes a file. Every other role installs as before.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type {
  AdapterPackageManifest,
  AgentPackageManifest,
  MarketplacePackageManifest,
  PluginPackageManifest,
} from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { PermissionPreview } from '../../types.js';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('@dorkos/marketplace/package-validator', () => ({ validatePackage: vi.fn() }));
vi.mock('../../telemetry/telemetry-hook.js', () => ({
  reportInstallEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../installed-metadata.js', () => ({
  writeInstallMetadata: vi.fn().mockResolvedValue(undefined),
  readInstallMetadata: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../lib/project-install-index.js', () => ({
  recordProjectInstall: vi.fn().mockResolvedValue(undefined),
}));

import { validatePackage } from '@dorkos/marketplace/package-validator';
import { MarketplaceInstaller, type InstallerDeps } from '../marketplace-installer.js';
import { CloudAgentUnsupportedError } from '../errors.js';

const base = {
  schemaVersion: 1 as const,
  version: '1.0.0',
  description: 'Fixture',
  tags: [],
  layers: [],
  requires: [],
};

/** An empty preview, with what a test adds. */
function preview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
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
    ...overrides,
  };
}

let packageDir: string;
let flows: Record<
  'pluginFlow' | 'agentFlow' | 'adapterFlow',
  { install: ReturnType<typeof vi.fn> }
>;

/** An installer whose one package is `manifest`, previewed as `shown`. */
function installerFor(manifest: MarketplacePackageManifest, shown: PermissionPreview) {
  vi.mocked(validatePackage).mockResolvedValue({ ok: true, issues: [], manifest } as never);
  const result = {
    ok: true,
    packageName: manifest.name,
    version: manifest.version,
    type: manifest.type,
    installPath: nodePath.join(packageDir, 'installed'),
    manifest,
    warnings: [],
  };
  flows = {
    pluginFlow: { install: vi.fn().mockResolvedValue(result) },
    agentFlow: { install: vi.fn().mockResolvedValue(result) },
    adapterFlow: { install: vi.fn().mockResolvedValue(result) },
  };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    dorkHome: nodePath.join(packageDir, 'dork-home'),
    resolver: {
      resolve: vi.fn().mockResolvedValue({
        kind: 'local',
        packageName: manifest.name,
        localPath: packageDir,
      }),
    },
    fetcher: { fetchFromGit: vi.fn(), fetchPackage: vi.fn() },
    previewBuilder: { build: vi.fn().mockResolvedValue(shown) },
    pluginFlow: { ...flows.pluginFlow, refreshExtensionCopies: vi.fn() },
    agentFlow: flows.agentFlow,
    skillPackFlow: { install: vi.fn() },
    adapterFlow: flows.adapterFlow,
    shapeFlow: { install: vi.fn() },
    uninstallFlow: { uninstall: vi.fn() },
    logger,
  } as unknown as InstallerDeps;
  return new MarketplaceInstaller(deps);
}

const plugin: PluginPackageManifest = {
  ...base,
  name: 'some-plugin',
  type: 'plugin',
  extensions: [],
  schedules: [],
};
const agent: AgentPackageManifest = {
  ...base,
  name: 'some-agent',
  type: 'agent',
  schedules: [],
};
const relayAdapter: AdapterPackageManifest = {
  ...base,
  name: 'some-adapter',
  type: 'adapter',
  adapterType: 'slack',
};

/** Write the staged agent package's own `.dork/agent.json`. */
async function agentJsonNames(runtime: string): Promise<void> {
  await mkdir(nodePath.join(packageDir, '.dork'), { recursive: true });
  await writeFile(nodePath.join(packageDir, '.dork', 'agent.json'), JSON.stringify({ runtime }));
}

beforeEach(async () => {
  role.value = 'agent-computer';
  packageDir = await mkdtemp(nodePath.join(tmpdir(), 'dorkos-cloud-agent-install-'));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(packageDir, { recursive: true, force: true });
});

describe('installing on an agent computer', () => {
  it('refuses a plugin that ships hooks, with the card`s sentence, writing nothing', async () => {
    const hooks = preview({ hooks: [{ event: 'Stop', command: 'echo hi' }] });
    const install = installerFor(plugin, hooks).install({ name: plugin.name });
    await expect(install).rejects.toBeInstanceOf(CloudAgentUnsupportedError);
    await expect(install).rejects.toThrow("This doesn't work on cloud agents yet.");
    expect(flows.pluginFlow.install).not.toHaveBeenCalled();
  });

  it('refuses a relay adapter', async () => {
    await expect(
      installerFor(relayAdapter, preview()).install({ name: relayAdapter.name })
    ).rejects.toMatchObject({ reason: 'relay-adapter' });
    expect(flows.adapterFlow.install).not.toHaveBeenCalled();
  });

  it('refuses a local MCP server whose program is not in the image', async () => {
    const mcp = preview({ mcpServers: [{ name: 'db', transport: 'stdio', command: 'docker' }] });
    await expect(installerFor(plugin, mcp).install({ name: plugin.name })).rejects.toMatchObject({
      reason: 'mcp-program',
    });
  });

  it('refuses a package with a program declaration it could not read', async () => {
    const unreadable = preview({
      unreadableDeclarations: [{ path: '.mcp.json', message: 'not JSON' }] as never,
    });
    await expect(
      installerFor(plugin, unreadable).install({ name: plugin.name })
    ).rejects.toMatchObject({ reason: 'unreadable-declaration' });
  });

  it('installs an agent package that names no runtime', async () => {
    await installerFor(agent, preview()).install({ name: agent.name });
    expect(flows.agentFlow.install).toHaveBeenCalledTimes(1);
  });

  it('refuses an agent package whose agent.json names another runtime', async () => {
    await agentJsonNames('claude-code');
    await expect(
      installerFor(agent, preview()).install({ name: agent.name })
    ).rejects.toMatchObject({ reason: 'agent-runtime' });
    expect(flows.agentFlow.install).not.toHaveBeenCalled();
  });

  it('installs an agent package when OpenCode is the runtime chosen for it', async () => {
    await agentJsonNames('claude-code');
    await installerFor(agent, preview()).install({
      name: agent.name,
      agentIdentity: { runtime: 'opencode' },
    });
    expect(flows.agentFlow.install).toHaveBeenCalledTimes(1);
  });

  it('installs a package that works on a cloud agent', async () => {
    const inImage = preview({ mcpServers: [{ name: 'docs', transport: 'stdio', command: 'npx' }] });
    await installerFor(plugin, inImage).install({ name: plugin.name });
    expect(flows.pluginFlow.install).toHaveBeenCalledTimes(1);
  });
});

describe('installing anywhere else', () => {
  it('installs what an agent computer would refuse', async () => {
    for (const value of ['computer', 'hub'] as const) {
      role.value = value;
      const hooks = preview({ hooks: [{ event: 'Stop', command: 'echo hi' }] });
      await installerFor(plugin, hooks).install({ name: plugin.name });
      expect(flows.pluginFlow.install).toHaveBeenCalledTimes(1);
    }
  });
});
