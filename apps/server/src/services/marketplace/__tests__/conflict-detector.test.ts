import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';

/**
 * Build a minimal AdapterManager mock that exposes the `listAdapters()`
 * surface ConflictDetector consumes. The detector only needs `config.id`
 * and `config.type` from each entry, so we cast loosely after constructing
 * the shape with handcrafted values.
 */
function buildMockAdapterManager(
  installed: Array<{ id: string; type: string }> = []
): AdapterManager {
  const listAdapters = vi.fn().mockReturnValue(
    installed.map((entry) => ({
      config: {
        id: entry.id,
        type: entry.type,
        enabled: true,
        builtin: false,
        config: {},
      },
      status: {
        id: entry.id,
        type: entry.type,
        displayName: entry.type,
        state: 'connected',
      },
    }))
  );
  return { listAdapters } as unknown as AdapterManager;
}

/** Build a minimal plugin package manifest for tests. */
function pluginManifest(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'plugin',
    description: 'A test plugin package.',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    ...overrides,
  } as unknown as MarketplacePackageManifest;
}

/** Build a minimal adapter package manifest for tests. */
function adapterManifest(name: string, adapterType: string) {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'adapter',
    description: 'A test adapter package.',
    tags: [],
    layers: [],
    requires: [],
    adapterType,
  } as unknown as MarketplacePackageManifest;
}

/** Write a SKILL.md file with the given frontmatter into a directory. */
async function writeSkill(
  root: string,
  skillName: string,
  frontmatter: Record<string, string>
): Promise<string> {
  const dir = join(root, '.dork', 'tasks', skillName);
  await mkdir(dir, { recursive: true });
  const lines = ['---', `name: ${skillName}`];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '', `Body for ${skillName}.`, '');
  const filePath = join(dir, 'SKILL.md');
  await writeFile(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

/** Write an extension.json file with the given slot bindings. */
async function writeExtension(
  root: string,
  extensionId: string,
  slots: Array<{ slot: string; priority: number }>
): Promise<void> {
  const dir = join(root, '.dork', 'extensions', extensionId);
  await mkdir(dir, { recursive: true });
  const payload = {
    name: extensionId,
    version: '1.0.0',
    slots,
  };
  await writeFile(join(dir, 'extension.json'), JSON.stringify(payload), 'utf-8');
}

/** Lay down an installed plugin package skeleton under ${dorkHome}/plugins/{name}. */
async function installPluginSkeleton(dorkHome: string, name: string): Promise<string> {
  const pluginRoot = join(dorkHome, 'plugins', name);
  await mkdir(pluginRoot, { recursive: true });
  return pluginRoot;
}

describe('ConflictDetector', () => {
  let dorkHome: string;
  let stagedRoot: string;
  let adapterManager: AdapterManager;
  let detector: ConflictDetector;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'conflict-detector-dorkhome-'));
    stagedRoot = await mkdtemp(join(tmpdir(), 'conflict-detector-staged-'));
    adapterManager = buildMockAdapterManager();
    detector = new ConflictDetector(dorkHome, adapterManager);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(stagedRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns no conflicts on a clean dorkHome', async () => {
    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('fresh-plugin'),
      dorkHome,
    });
    expect(result).toEqual([]);
  });

  it('reports an error when a plugin with the same name is already installed', async () => {
    await installPluginSkeleton(dorkHome, 'duplicate-plugin');

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('duplicate-plugin'),
      dorkHome,
    });

    const errors = result.filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      level: 'error',
      type: 'package-name',
      conflictingPackage: 'duplicate-plugin',
    });
  });

  it('reports a warning when two extensions register the same slot at the same priority', async () => {
    // Installed plugin with a slot binding
    const installedRoot = await installPluginSkeleton(dorkHome, 'installed-plugin');
    await writeExtension(installedRoot, 'installed-ext', [{ slot: 'sidebar.top', priority: 10 }]);

    // Staged package binding to the same slot at the same priority
    await writeExtension(stagedRoot, 'staged-ext', [{ slot: 'sidebar.top', priority: 10 }]);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('staged-plugin'),
      dorkHome,
    });

    const slotConflicts = result.filter((r) => r.type === 'slot');
    expect(slotConflicts).toHaveLength(1);
    expect(slotConflicts[0]).toMatchObject({
      level: 'warning',
      type: 'slot',
      conflictingPackage: 'installed-plugin',
    });
  });

  it('does not report a slot conflict when priorities differ', async () => {
    const installedRoot = await installPluginSkeleton(dorkHome, 'installed-plugin');
    await writeExtension(installedRoot, 'installed-ext', [{ slot: 'sidebar.top', priority: 10 }]);

    await writeExtension(stagedRoot, 'staged-ext', [{ slot: 'sidebar.top', priority: 20 }]);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('staged-plugin'),
      dorkHome,
    });

    expect(result.filter((r) => r.type === 'slot')).toEqual([]);
  });

  it('reports an error when a skill with the same name is already installed', async () => {
    const installedRoot = await installPluginSkeleton(dorkHome, 'installed-plugin');
    await writeSkill(installedRoot, 'shared-skill', { description: 'installed' });

    await writeSkill(stagedRoot, 'shared-skill', { description: 'staged' });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('staged-plugin'),
      dorkHome,
    });

    const skillConflicts = result.filter((r) => r.type === 'skill-name');
    expect(skillConflicts).toHaveLength(1);
    expect(skillConflicts[0]).toMatchObject({
      level: 'error',
      type: 'skill-name',
      conflictingPackage: 'installed-plugin',
    });
  });

  it('reports a cron warning when two task SKILL.md files share the same minute field', async () => {
    const installedRoot = await installPluginSkeleton(dorkHome, 'installed-plugin');
    await writeSkill(installedRoot, 'installed-task', {
      description: 'installed',
      cron: '"0 9 * * *"',
    });

    await writeSkill(stagedRoot, 'staged-task', {
      description: 'staged',
      cron: '"0 17 * * *"',
    });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('staged-plugin'),
      dorkHome,
    });

    const cronWarnings = result.filter((r) => r.type === 'cron-collision');
    expect(cronWarnings).toHaveLength(1);
    expect(cronWarnings[0]).toMatchObject({
      level: 'warning',
      type: 'cron-collision',
      conflictingPackage: 'installed-plugin',
    });
  });

  it('reports an error when an adapter package collides with an installed adapter id', async () => {
    adapterManager = buildMockAdapterManager([{ id: 'discord', type: 'discord' }]);
    detector = new ConflictDetector(dorkHome, adapterManager);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: adapterManifest('discord-adapter', 'discord'),
      dorkHome,
    });

    const adapterConflicts = result.filter((r) => r.type === 'adapter-id');
    expect(adapterConflicts).toHaveLength(1);
    expect(adapterConflicts[0]).toMatchObject({
      level: 'error',
      type: 'adapter-id',
      conflictingPackage: 'discord',
    });
  });

  it('does not check adapter ids when the package type is not adapter', async () => {
    adapterManager = buildMockAdapterManager([{ id: 'slack', type: 'slack' }]);
    detector = new ConflictDetector(dorkHome, adapterManager);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('slack'), // Same name as adapter, but plugin type
      dorkHome,
    });

    expect(result.filter((r) => r.type === 'adapter-id')).toEqual([]);
  });

  it('reports multiple conflicts in the same run', async () => {
    // Already installed: a plugin with the same name as the staged one,
    // a slot binding, and a skill name.
    const installedRoot = await installPluginSkeleton(dorkHome, 'multi-plugin');
    await writeExtension(installedRoot, 'installed-ext', [{ slot: 'header.right', priority: 5 }]);
    await writeSkill(installedRoot, 'shared-skill', { description: 'installed' });

    // Staged package collides on all three axes.
    await writeExtension(stagedRoot, 'staged-ext', [{ slot: 'header.right', priority: 5 }]);
    await writeSkill(stagedRoot, 'shared-skill', { description: 'staged' });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('multi-plugin'),
      dorkHome,
    });

    const types = result.map((r) => r.type).sort();
    expect(types).toEqual(['package-name', 'skill-name', 'slot']);
  });
});
