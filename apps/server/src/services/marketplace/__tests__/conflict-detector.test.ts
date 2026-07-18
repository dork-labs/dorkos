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

/** Build a minimal shape package manifest for tests. */
function shapeManifest(name: string) {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'shape',
    description: 'A test shape package.',
    tags: [],
    layers: [],
    requires: [],
    activates: [],
    extensions: [],
    layout: { sidebarOpen: true, openPanels: [], focusDashboardSections: [] },
    agents: [],
    schedules: [],
    connections: [],
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

  it('reports a non-blocking reinstall warning when the same package is already installed', async () => {
    await installPluginSkeleton(dorkHome, 'duplicate-plugin');

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('duplicate-plugin'),
      dorkHome,
    });

    // ADR-0304 made overwrite installs atomic and safe, so a same-name reinstall
    // is a warning (a reinstall note), never an error that dead-ends the install.
    expect(result.filter((r) => r.level === 'error')).toEqual([]);
    const nameConflicts = result.filter((r) => r.type === 'package-name');
    expect(nameConflicts).toHaveLength(1);
    expect(nameConflicts[0]).toMatchObject({
      level: 'warning',
      type: 'package-name',
      conflictingPackage: 'duplicate-plugin',
    });
  });

  it('reports a reinstall warning when a Shape already owns the name under shapes/', async () => {
    await mkdir(join(dorkHome, 'shapes', 'linear-ops'), { recursive: true });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: shapeManifest('linear-ops'),
      dorkHome,
    });

    // A Shape installs under shapes/ — the reinstall must be detected there, not
    // missed because the check only looked at plugins/ (the pre-DOR-355 bug).
    expect(result.filter((r) => r.level === 'error')).toEqual([]);
    const nameConflicts = result.filter((r) => r.type === 'package-name');
    expect(nameConflicts).toHaveLength(1);
    expect(nameConflicts[0]).toMatchObject({
      level: 'warning',
      type: 'package-name',
      conflictingPackage: 'linear-ops',
    });
  });

  it('warns about cross-type coexistence when a plugin already owns a Shape name', async () => {
    await installPluginSkeleton(dorkHome, 'ambient');

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: shapeManifest('ambient'),
      dorkHome,
    });

    const nameConflicts = result.filter((r) => r.type === 'package-name');
    expect(nameConflicts).toHaveLength(1);
    expect(nameConflicts[0].description).toMatch(/plugins\//);
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

  it('does not raise a skill-name conflict against a crash-left install backup (DOR-175)', async () => {
    // A crash mid-reinstall leaves `<name>.dorkos-bak-<ts>-<uuid>` beside the
    // install target — a byte-for-byte copy of the previous installation, so
    // it carries the SAME skill names as the package being reinstalled.
    // Without the exclusion the detector would raise a blocking skill-name
    // error against the package's own crash residue.
    const backupRoot = await installPluginSkeleton(
      dorkHome,
      `staged-plugin.dorkos-bak-${Date.now()}-3fa85f64-5717-4562-b3fc-2c963f66afa6`
    );
    await writeSkill(backupRoot, 'shared-skill', { description: 'crash-left backup' });

    await writeSkill(stagedRoot, 'shared-skill', { description: 'staged' });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('staged-plugin'),
      dorkHome,
    });

    expect(result.filter((r) => r.type === 'skill-name')).toHaveLength(0);
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
    // Installed: a same-name plugin (reinstall → package-name warning) that also
    // ships a slot binding. A *separate* installed plugin owns a skill name that
    // the staged package collides with (skill-name error — from a foreign package,
    // so the self-comparison filter does not exclude it).
    const reinstallRoot = await installPluginSkeleton(dorkHome, 'multi-plugin');
    await writeExtension(reinstallRoot, 'installed-ext', [{ slot: 'header.right', priority: 5 }]);
    const otherRoot = await installPluginSkeleton(dorkHome, 'other-plugin');
    await writeSkill(otherRoot, 'shared-skill', { description: 'installed' });

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

  it('does not self-conflict when reinstalling a package that ships a task SKILL.md and an adapter', async () => {
    // Fix #2: the conflict gate runs before the transaction moves the old install
    // aside, so a package's OWN already-installed skills/adapters are still on
    // disk. They must not count as collisions with itself, or reinstall dead-ends.

    // The package's own task skill is already installed under its own plugin dir.
    const installedRoot = await installPluginSkeleton(dorkHome, 'shipper');
    await writeSkill(installedRoot, 'nightly-task', {
      description: 'installed',
      cron: '"0 3 * * *"',
    });
    // The same task ships in the staged reinstall (same name + same cron).
    await writeSkill(stagedRoot, 'nightly-task', {
      description: 'staged',
      cron: '"0 3 * * *"',
    });

    // The package is an adapter already registered under its own name (config.id).
    adapterManager = buildMockAdapterManager([{ id: 'shipper', type: 'shipper-type' }]);
    detector = new ConflictDetector(dorkHome, adapterManager);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: adapterManifest('shipper', 'shipper-type'),
      dorkHome,
    });

    // No error-level conflict remains — only the non-blocking reinstall warning.
    expect(result.filter((r) => r.level === 'error')).toEqual([]);
    expect(result.filter((r) => r.type === 'skill-name')).toEqual([]);
    expect(result.filter((r) => r.type === 'cron-collision')).toEqual([]);
    expect(result.filter((r) => r.type === 'adapter-id')).toEqual([]);
    const nameWarnings = result.filter((r) => r.type === 'package-name');
    expect(nameWarnings).toHaveLength(1);
    expect(nameWarnings[0]).toMatchObject({ level: 'warning', type: 'package-name' });
  });

  it('warns (does not error) when a same-name package of a different type exists in the other root', async () => {
    // Fix #5: a plugin `foo` and an agent `foo` would silently coexist. Surface the
    // cross-type collision as a non-blocking warning so it is not invisible.
    const agentRoot = join(dorkHome, 'agents', 'foo');
    await mkdir(agentRoot, { recursive: true });

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('foo'), // installs under plugins/, agent foo lives under agents/
      dorkHome,
    });

    const nameConflicts = result.filter((r) => r.type === 'package-name');
    expect(nameConflicts).toHaveLength(1);
    expect(nameConflicts[0]).toMatchObject({
      level: 'warning',
      type: 'package-name',
      conflictingPackage: 'foo',
    });
    expect(result.filter((r) => r.level === 'error')).toEqual([]);
  });

  it('detects an agent-local reinstall under projectPath/.dork/plugins', async () => {
    // Fix #12: agent-local packages live at `${projectPath}/.dork/plugins/<name>`.
    // The detector must probe the `.dork` segment, not `${projectPath}/plugins`.
    const projectPath = await mkdtemp(join(tmpdir(), 'conflict-detector-project-'));
    try {
      const localPluginDir = join(projectPath, '.dork', 'plugins', 'local-plugin');
      await mkdir(localPluginDir, { recursive: true });

      const result = await detector.detect({
        packagePath: stagedRoot,
        manifest: pluginManifest('local-plugin'),
        dorkHome,
        projectPath,
      });

      const nameConflicts = result.filter((r) => r.type === 'package-name');
      expect(nameConflicts).toHaveLength(1);
      expect(nameConflicts[0]).toMatchObject({
        level: 'warning',
        type: 'package-name',
        conflictingPackage: 'local-plugin',
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('warns (non-blocking) when an extension-bearing package is installed at agent scope', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'conflict-detector-project-'));
    try {
      await writeExtension(stagedRoot, 'staged-ext', [{ slot: 'sidebar.top', priority: 10 }]);

      const result = await detector.detect({
        packagePath: stagedRoot,
        manifest: pluginManifest('themed-plugin'),
        dorkHome,
        projectPath,
      });

      const extensionWarnings = result.filter((r) => r.type === 'extension-scope');
      expect(extensionWarnings).toHaveLength(1);
      expect(extensionWarnings[0]).toMatchObject({
        level: 'warning',
        type: 'extension-scope',
        conflictingPackage: 'themed-plugin',
      });
      // Non-blocking: the install proceeds because nothing is error-level.
      expect(result.filter((r) => r.level === 'error')).toEqual([]);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('does not warn about extension scope for a global install of the same package', async () => {
    await writeExtension(stagedRoot, 'staged-ext', [{ slot: 'sidebar.top', priority: 10 }]);

    const result = await detector.detect({
      packagePath: stagedRoot,
      manifest: pluginManifest('themed-plugin'),
      dorkHome,
      // no projectPath — global scope
    });

    expect(result.filter((r) => r.type === 'extension-scope')).toEqual([]);
  });

  it('does not warn about extension scope for an agent-scoped package with no extensions', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'conflict-detector-project-'));
    try {
      const result = await detector.detect({
        packagePath: stagedRoot,
        manifest: pluginManifest('plain-plugin'),
        dorkHome,
        projectPath,
      });

      expect(result.filter((r) => r.type === 'extension-scope')).toEqual([]);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
