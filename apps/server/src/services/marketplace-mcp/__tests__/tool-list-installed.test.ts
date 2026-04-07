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
 * Parse the `text` payload of an MCP tool result back into a structured
 * object. Every marketplace tool returns a single `text` content block whose
 * body is JSON.
 */
function parseToolResult(result: { content: { type: 'text'; text: string }[] }): {
  installed: Array<{
    name: string;
    version: string;
    type: string;
    installPath: string;
    installedFrom?: string;
    installedAt?: string;
  }>;
} {
  return JSON.parse(result.content[0].text) as {
    installed: Array<{
      name: string;
      version: string;
      type: string;
      installPath: string;
      installedFrom?: string;
      installedAt?: string;
    }>;
  };
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
});
