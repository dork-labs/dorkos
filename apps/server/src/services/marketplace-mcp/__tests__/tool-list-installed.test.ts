/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '@dorkos/shared/logger';
import { createListInstalledHandler, ListInstalledInputSchema } from '../tool-list-installed.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import { INSTALL_METADATA_PATH } from '../../marketplace/installed-metadata.js';
import { UpdateFlow } from '../../marketplace/flows/update.js';
import type { InstallRequest, LatestResolution } from '../../marketplace/types.js';

/**
 * Write a `.dork/manifest.json` to a package root, creating the directory tree
 * if needed. Mirrors what the install pipeline does for the manifest copy.
 */
async function writeManifest(
  packagePath: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const dir = join(packagePath, '.dork');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Write a `.dork/install-metadata.json` sidecar to a package root. Mirrors
 * the install pipeline's `writeInstallMetadata()` output.
 */
async function writeMetadata(
  packagePath: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await mkdir(join(packagePath, '.dork'), { recursive: true });
  await writeFile(
    join(packagePath, INSTALL_METADATA_PATH),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );
}

/** Build a noop logger so info/error calls are silent in tests. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Construct a `MarketplaceMcpDeps` bundle that only populates the fields
 * `tool-list-installed` actually reads (`dorkHome` + `logger`). The unused
 * fields are cast through `unknown` because the handler never touches them.
 */
function buildDeps(dorkHome: string): MarketplaceMcpDeps {
  return {
    dorkHome,
    logger: buildLogger(),
  } as unknown as MarketplaceMcpDeps;
}

/**
 * Like {@link buildDeps} but also wires `listAgentScopes` so the handler walks
 * each agent's `.dork/plugins` — the cross-scope path.
 */
function buildDepsWithAgents(
  dorkHome: string,
  agents: Array<{ projectPath: string; id?: string; name?: string }>
): MarketplaceMcpDeps {
  return {
    dorkHome,
    logger: buildLogger(),
    listAgentScopes: () => agents,
  } as unknown as MarketplaceMcpDeps;
}

/** Write a package manifest under `<projectPath>/.dork/plugins/<name>`. */
async function writeAgentPlugin(
  projectPath: string,
  name: string,
  manifest: Record<string, unknown>
): Promise<void> {
  await writeManifest(join(projectPath, '.dork', 'plugins', name), manifest);
}

/**
 * Parse the `text` payload of an MCP tool result back into a structured
 * object. Every marketplace tool returns a single `text` content block whose
 * body is JSON.
 */
interface ParsedInstalled {
  name: string;
  version: string;
  type: string;
  installPath: string;
  installedFrom?: string;
  installedAt?: string;
  scope?: string;
  agentPath?: string;
  agentId?: string;
  agentName?: string;
  integrity?: unknown;
}

function parseToolResult(result: { content: { type: 'text'; text: string }[] }): {
  installed: ParsedInstalled[];
} {
  return JSON.parse(result.content[0].text) as { installed: ParsedInstalled[] };
}

describe('ListInstalledInputSchema', () => {
  it('accepts an empty input object', () => {
    const schema = z.object(ListInstalledInputSchema);
    expect(() => schema.parse({})).not.toThrow();
  });

  it('accepts each PackageType enum value for the type filter', () => {
    const schema = z.object(ListInstalledInputSchema);
    for (const type of ['agent', 'plugin', 'skill-pack', 'adapter'] as const) {
      expect(() => schema.parse({ type })).not.toThrow();
    }
  });

  it('rejects unknown type values', () => {
    const schema = z.object(ListInstalledInputSchema);
    expect(() => schema.parse({ type: 'fake-type' })).toThrow();
  });
});

describe('createListInstalledHandler', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-tool-list-installed-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('returns an empty installed list when dorkHome is empty', async () => {
    const handler = createListInstalledHandler(buildDeps(dorkHome));
    const result = await handler({});
    expect(parseToolResult(result).installed).toEqual([]);
  });

  it('returns every plugin and agent when no filter is supplied', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'sentry-monitor');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.3',
    });
    await writeMetadata(pluginDir, {
      name: 'sentry-monitor',
      version: '1.2.3',
      type: 'plugin',
      installedFrom: 'community',
      installedAt: '2026-01-15T10:00:00.000Z',
    });

    const agentDir = join(dorkHome, 'agents', 'researcher');
    await writeManifest(agentDir, {
      schemaVersion: 1,
      type: 'agent',
      name: 'researcher',
      version: '0.5.0',
    });
    await writeMetadata(agentDir, {
      name: 'researcher',
      version: '0.5.0',
      type: 'agent',
      installedFrom: 'personal',
      installedAt: '2026-02-01T08:30:00.000Z',
    });

    const handler = createListInstalledHandler(buildDeps(dorkHome));
    const result = await handler({});
    const { installed } = parseToolResult(result);

    expect(installed).toHaveLength(2);
    const names = installed.map((p) => p.name).sort();
    expect(names).toEqual(['researcher', 'sentry-monitor']);
  });

  // Purpose (DOR-2197): with `verify` an agent can tell a person which
  // package was hand-edited; without it the list stays cheap and unchanged.
  it('adds integrity only with verify', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'sentry-monitor');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.3',
    });
    const handler = createListInstalledHandler(buildDeps(dorkHome));

    const plain = parseToolResult(await handler({}));
    expect(plain.installed[0]).not.toHaveProperty('integrity');

    const verified = parseToolResult(await handler({ verify: true }));
    expect(verified.installed[0].integrity).toEqual({ status: 'unknown', reason: 'no-record' });
  });

  it('filters by type when the `type` arg is supplied', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'sentry-monitor');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.3',
    });

    const agentDir = join(dorkHome, 'agents', 'researcher');
    await writeManifest(agentDir, {
      schemaVersion: 1,
      type: 'agent',
      name: 'researcher',
      version: '0.5.0',
    });

    const handler = createListInstalledHandler(buildDeps(dorkHome));
    const pluginsOnly = parseToolResult(await handler({ type: 'plugin' }));
    expect(pluginsOnly.installed).toHaveLength(1);
    expect(pluginsOnly.installed[0].name).toBe('sentry-monitor');
    expect(pluginsOnly.installed[0].type).toBe('plugin');

    const agentsOnly = parseToolResult(await handler({ type: 'agent' }));
    expect(agentsOnly.installed).toHaveLength(1);
    expect(agentsOnly.installed[0].name).toBe('researcher');
    expect(agentsOnly.installed[0].type).toBe('agent');
  });

  it('returns entries without provenance fields when the sidecar is missing', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'orphan-plugin');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'orphan-plugin',
      version: '0.1.0',
    });

    const handler = createListInstalledHandler(buildDeps(dorkHome));
    const { installed } = parseToolResult(await handler({}));
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe('orphan-plugin');
    expect(installed[0].installedFrom).toBeUndefined();
    expect(installed[0].installedAt).toBeUndefined();
  });

  it('tags a global-only install with scope "global"', async () => {
    await writeManifest(join(dorkHome, 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });

    const handler = createListInstalledHandler(buildDepsWithAgents(dorkHome, []));
    const { installed } = parseToolResult(await handler({}));
    expect(installed).toHaveLength(1);
    expect(installed[0].scope).toBe('global');
    expect(installed[0].agentId).toBeUndefined();
  });

  it('returns an agent-only install with scope "agent-local" and agent identity', async () => {
    const projectPath = join(dorkHome, 'projects', 'e2e-agent');
    await writeAgentPlugin(projectPath, 'flow', {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });

    const handler = createListInstalledHandler(
      buildDepsWithAgents(dorkHome, [{ projectPath, id: 'agent-1', name: 'E2E Test Agent' }])
    );
    const { installed } = parseToolResult(await handler({}));
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe('flow');
    expect(installed[0].scope).toBe('agent-local');
    expect(installed[0].agentId).toBe('agent-1');
    expect(installed[0].agentName).toBe('E2E Test Agent');
    expect(installed[0].agentPath).toBe(projectPath);
  });

  it('returns two entries and tags the agent copy "override" when a package is installed globally and on an agent', async () => {
    await writeManifest(join(dorkHome, 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });
    const projectPath = join(dorkHome, 'projects', 'e2e-agent');
    await writeAgentPlugin(projectPath, 'flow', {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '2.0.0',
    });

    const handler = createListInstalledHandler(
      buildDepsWithAgents(dorkHome, [{ projectPath, id: 'agent-1', name: 'E2E Test Agent' }])
    );
    const { installed } = parseToolResult(await handler({}));
    expect(installed).toHaveLength(2);

    const global = installed.find((p) => p.scope === 'global');
    const override = installed.find((p) => p.scope === 'override');
    expect(global?.version).toBe('1.0.0');
    expect(override?.version).toBe('2.0.0');
    expect(override?.agentName).toBe('E2E Test Agent');
  });
});

describe('createListInstalledHandler — checkUpdates', () => {
  let dorkHome: string;
  let resolveLatest: ReturnType<typeof vi.fn<(req: InstallRequest) => Promise<LatestResolution>>>;
  let network: ReturnType<typeof vi.fn>[];
  let deps: MarketplaceMcpDeps;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'mcp-list-installed-updates-'));
    for (const [name, type] of [
      ['flow', 'plugin'],
      ['helper', 'agent'],
    ] as const) {
      const root = join(dorkHome, type === 'plugin' ? 'plugins' : 'agents', name);
      await writeManifest(root, { schemaVersion: 1, type, name, version: '1.0.0' });
      await writeMetadata(root, { name, version: '1.0.0', type, installedFrom: 'fixture' });
    }
    const source = {
      name: 'fixture',
      source: 'https://example.com/marketplace',
      enabled: true,
      addedAt: '2025-01-01T00:00:00.000Z',
    };
    resolveLatest = vi.fn(async (req: InstallRequest): Promise<LatestResolution> => {
      if (req.name === 'helper') throw new Error('network is down');
      return { kind: 'resolved', declaredVersion: '1.2.0' };
    });
    const fetchMarketplaceJson = vi.fn(async () => ({
      name: 'fixture',
      owner: { name: 'Fixture' },
      plugins: [
        { name: 'flow', source: 'https://example.com/flow' },
        { name: 'helper', source: 'https://example.com/helper' },
      ],
    }));
    const lookupCommitSha = vi.fn(async () => 'a'.repeat(40));
    const list = vi.fn(async () => [source]);
    const get = vi.fn(async () => source);
    // Every way the update check can reach the network, or the marketplace
    // configuration it would read to get there.
    network = [resolveLatest, fetchMarketplaceJson, lookupCommitSha, list, get];
    deps = {
      dorkHome,
      logger: buildLogger(),
      updateFlow: new UpdateFlow({
        dorkHome,
        installer: { resolveLatest, update: vi.fn(), preview: vi.fn() },
        sourceManager: { list, get },
        fetcher: { fetchMarketplaceJson, lookupCommitSha },
        logger: buildLogger(),
      }),
    } as unknown as MarketplaceMcpDeps;
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('makes no network call, and adds nothing, without checkUpdates', async () => {
    // Purpose: the plain listing is on a hot path. It must never pay for a
    // marketplace fetch it was not asked for.
    const body = JSON.parse((await createListInstalledHandler(deps)({})).content[0].text) as {
      installed: Record<string, unknown>[];
    };

    expect(body.installed).toHaveLength(2);
    expect(body.installed.every((p) => !('update' in p))).toBe(true);
    for (const fn of network) expect(fn).not.toHaveBeenCalled();
  });

  it('says, per installation, what is stale, and why it could not tell', async () => {
    // Purpose: an agent can see what needs updating from the list it already
    // reads; a check that fails is `unknown` with the reason, not a dropped row.
    const body = JSON.parse(
      (await createListInstalledHandler(deps)({ checkUpdates: true })).content[0].text
    ) as { installed: Array<{ name: string; version: string; update: Record<string, unknown> }> };

    const byName = new Map(body.installed.map((p) => [p.name, p]));
    expect(byName.get('flow')).toMatchObject({
      version: '1.0.0',
      update: { status: 'update-available', latestVersion: '1.2.0', hasUpdate: true },
    });
    expect(byName.get('helper')!.update).toMatchObject({
      status: 'unknown',
      hasUpdate: false,
      note: expect.stringContaining('network is down'),
    });
  });

  it('checks only what the type filter keeps', async () => {
    // Purpose: filtering after checking would pay for checks nobody sees.
    const body = JSON.parse(
      (await createListInstalledHandler(deps)({ type: 'plugin', checkUpdates: true })).content[0]
        .text
    ) as { installed: Array<{ name: string }> };

    expect(body.installed.map((p) => p.name)).toEqual(['flow']);
    expect(resolveLatest.mock.calls.map(([req]) => req.name)).toEqual(['flow']);
  });
});
