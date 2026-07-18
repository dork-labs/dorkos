/**
 * Tests for {@link forkShape} (DOR-355, spec §6.2).
 *
 * A fork clones an installed Shape into a new one, rewrites its `name`, and
 * stamps `lineage` — while leaving the ORIGINAL byte-identical. `captureCurrent`
 * snapshots the live arrangement (enabled extensions + client chrome) when
 * forking the active Shape. A fork of a missing Shape errors cleanly with zero
 * residue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { ShapeNotInstalledError } from '../apply-shape.js';
import { forkShape, ShapeForkConflictError, type ForkShapeDeps } from '../fork.js';

function buildLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A valid Linear-Ops-shaped manifest written to disk as the fork source. */
function sourceManifest() {
  return {
    schemaVersion: 1,
    name: 'linear-ops',
    version: '1.0.0',
    type: 'shape',
    description: 'Linear on the dashboard.',
    author: 'dorkos',
    layers: ['extensions', 'agents', 'tasks'],
    requires: [],
    activates: ['linear-issues', 'other-ext'],
    extensions: [],
    layout: {
      sidebarOpen: true,
      sidebarTab: 'overview',
      openPanels: [],
      focusDashboardSections: [],
    },
    agents: [
      {
        ref: 'tender',
        affinity: 'default',
        matchName: 'Tender',
        template: { displayName: 'Tender' },
      },
    ],
    schedules: [
      {
        name: 'tick',
        description: 'poll',
        prompt: 'go',
        cron: '*/15 * * * *',
        agentRef: 'tender',
        permissionMode: 'acceptEdits',
      },
    ],
    connections: [
      { kind: 'extension-secret', extension: 'linear-issues', secret: 'linear_api_key' },
    ],
  };
}

/**
 * Install a Shape on disk under `{dorkHome}/shapes/<name>` with a manifest and a
 * `.claude-plugin/plugin.json`. Returns the shape root.
 */
async function installShape(
  dorkHome: string,
  name: string,
  manifest: Record<string, unknown>,
  installedFrom?: string
): Promise<string> {
  const root = path.join(dorkHome, 'shapes', name);
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'x' }, null, 2),
    'utf-8'
  );
  if (installedFrom) {
    await writeFile(
      path.join(root, '.dork', 'install-metadata.json'),
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'shape',
          installedFrom,
          installedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf-8'
    );
  }
  return root;
}

describe('forkShape', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function makeHome(): Promise<{ dorkHome: string; deps: ForkShapeDeps }> {
    const dorkHome = await mkdtemp(path.join(tmpdir(), 'fork-shape-home-'));
    cleanupDirs.push(dorkHome);
    return { dorkHome, deps: { dorkHome, logger: buildLogger() } };
  }

  it('clones with a rewritten name + lineage and leaves the original byte-identical', async () => {
    const { dorkHome, deps } = await makeHome();
    const sourceRoot = await installShape(
      dorkHome,
      'linear-ops',
      sourceManifest(),
      'dorkos-community'
    );
    const originalBytes = await readFile(path.join(sourceRoot, '.dork', 'manifest.json'), 'utf-8');

    const result = await forkShape('linear-ops', {}, deps);

    expect(result.ok).toBe(true);
    expect(result.name).toBe('linear-ops-fork');
    expect(result.forkedFrom).toBe('linear-ops@dorkos-community');
    expect(result.installPath).toBe(path.join(dorkHome, 'shapes', 'linear-ops-fork'));

    // The fork's manifest carries the rewritten name + lineage.
    const forkManifest = JSON.parse(
      await readFile(
        path.join(dorkHome, 'shapes', 'linear-ops-fork', '.dork', 'manifest.json'),
        'utf-8'
      )
    );
    expect(forkManifest.name).toBe('linear-ops-fork');
    expect(forkManifest.lineage.forkedFrom).toBe('linear-ops@dorkos-community');
    expect(forkManifest.lineage.forkedFromVersion).toBe('1.0.0');
    expect(typeof forkManifest.lineage.forkedAt).toBe('string');
    // The fork's plugin.json name is rewritten too.
    const forkPlugin = JSON.parse(
      await readFile(
        path.join(dorkHome, 'shapes', 'linear-ops-fork', '.claude-plugin', 'plugin.json'),
        'utf-8'
      )
    );
    expect(forkPlugin.name).toBe('linear-ops-fork');

    // The ORIGINAL manifest is untouched, byte-for-byte.
    expect(await readFile(path.join(sourceRoot, '.dork', 'manifest.json'), 'utf-8')).toBe(
      originalBytes
    );
  });

  it('honors an explicit --as target name and falls back to local lineage source', async () => {
    const { dorkHome, deps } = await makeHome();
    await installShape(dorkHome, 'linear-ops', sourceManifest()); // no install-metadata

    const result = await forkShape('linear-ops', { as: 'my-ops' }, deps);
    expect(result.name).toBe('my-ops');
    expect(result.forkedFrom).toBe('linear-ops@local');
    expect(
      await pathExists(path.join(dorkHome, 'shapes', 'my-ops', '.dork', 'manifest.json'))
    ).toBe(true);
  });

  it('captureCurrent snapshots the enabled extensions + client chrome when forking the active Shape', async () => {
    const { dorkHome, deps: base } = await makeHome();
    await installShape(dorkHome, 'linear-ops', sourceManifest());

    const deps: ForkShapeDeps = {
      ...base,
      getActiveShape: () => 'linear-ops',
      // Only one of the two activates candidates is currently enabled.
      getEnabledExtensions: () => ['linear-issues'],
    };
    const liveLayout = {
      sidebarOpen: false,
      sidebarTab: 'schedules' as const,
      openPanels: ['tasks' as const],
      focusDashboardSections: ['a:b'],
    };

    const result = await forkShape('linear-ops', { captureCurrent: true, liveLayout }, deps);

    expect(result.manifest.activates).toEqual(['linear-issues']); // 'other-ext' dropped (disabled)
    expect(result.manifest.layout).toMatchObject({ sidebarOpen: false, sidebarTab: 'schedules' });
    // Shape-originated schedules are carried (Q2).
    expect(result.manifest.schedules.map((s) => s.name)).toEqual(['tick']);
  });

  it('ignores captureCurrent when the Shape is not the active one (plain clone)', async () => {
    const { dorkHome, deps: base } = await makeHome();
    await installShape(dorkHome, 'linear-ops', sourceManifest());
    const deps: ForkShapeDeps = {
      ...base,
      getActiveShape: () => 'something-else',
      getEnabledExtensions: () => [],
    };

    const result = await forkShape('linear-ops', { captureCurrent: true }, deps);
    // Not active → capture skipped → all activates preserved.
    expect(result.manifest.activates).toEqual(['linear-issues', 'other-ext']);
  });

  it('errors cleanly with zero residue when forking a Shape that is not installed', async () => {
    const { dorkHome, deps } = await makeHome();
    await mkdir(path.join(dorkHome, 'shapes'), { recursive: true });

    await expect(forkShape('ghost', {}, deps)).rejects.toBeInstanceOf(ShapeNotInstalledError);
    // No target directory was created.
    const shapeEntries = await readdir(path.join(dorkHome, 'shapes'));
    expect(shapeEntries).toEqual([]);
  });

  it('refuses to overwrite an existing Shape name', async () => {
    const { dorkHome, deps } = await makeHome();
    await installShape(dorkHome, 'linear-ops', sourceManifest());
    await installShape(dorkHome, 'taken', { ...sourceManifest(), name: 'taken' });

    await expect(forkShape('linear-ops', { as: 'taken' }, deps)).rejects.toBeInstanceOf(
      ShapeForkConflictError
    );
  });
});
