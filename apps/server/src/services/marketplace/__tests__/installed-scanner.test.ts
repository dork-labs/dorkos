/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanInstalledPackages,
  scanInstallationsAcrossScopes,
  scanInstallationRecords,
  computeProvides,
  readInstalledIdentity,
} from '../installed-scanner.js';
import { INSTALL_METADATA_PATH } from '../installed-metadata.js';

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
  const target = join(packagePath, INSTALL_METADATA_PATH);
  await mkdir(join(packagePath, '.dork'), { recursive: true });
  await writeFile(target, JSON.stringify(metadata, null, 2), 'utf-8');
}

describe('scanInstalledPackages', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-installed-scanner-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('returns empty list when dorkHome has no plugins or agents', async () => {
    const result = await scanInstalledPackages(dorkHome);
    expect(result).toEqual([]);
  });

  it('walks plugins and agents directories and returns merged list', async () => {
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

    const result = await scanInstalledPackages(dorkHome);
    const sorted = [...result].sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted).toHaveLength(2);
    expect(sorted[0]).toEqual({
      name: 'researcher',
      version: '0.5.0',
      type: 'agent',
      installPath: agentDir,
      installedFrom: 'personal',
      installedAt: '2026-02-01T08:30:00.000Z',
      scope: 'global',
    });
    expect(sorted[1]).toEqual({
      name: 'sentry-monitor',
      version: '1.2.3',
      type: 'plugin',
      installPath: pluginDir,
      installedFrom: 'community',
      installedAt: '2026-01-15T10:00:00.000Z',
      scope: 'global',
    });
  });

  it('surfaces a dependency warning the sidecar recorded, so it outlives the toast (DOR-1341)', async () => {
    // A package whose npm libraries failed to install is on disk and usable but
    // incomplete. The install toast said so once; this is the surface that can
    // still say it tomorrow.
    const pluginDir = join(dorkHome, 'plugins', 'needs-zod');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'needs-zod',
      version: '1.0.0',
    });
    await writeMetadata(pluginDir, {
      name: 'needs-zod',
      version: '1.0.0',
      installedAt: '2026-08-18T12:00:00.000Z',
      type: 'plugin',
      dependencyWarnings: ["DorkOS could not install this package's npm libraries."],
    });

    const [installed] = await scanInstalledPackages(dorkHome);

    expect(installed?.dependencyWarnings).toEqual([
      "DorkOS could not install this package's npm libraries.",
    ]);
  });

  it('reports no dependencyWarnings key at all for a clean install', async () => {
    // Absence is the common case and must not render as an empty warning row.
    const pluginDir = join(dorkHome, 'plugins', 'clean');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'clean',
      version: '1.0.0',
    });
    await writeMetadata(pluginDir, {
      name: 'clean',
      version: '1.0.0',
      installedAt: '2026-08-18T12:00:00.000Z',
      type: 'plugin',
      dependencyWarnings: [],
    });

    const [installed] = await scanInstalledPackages(dorkHome);

    expect(installed).not.toHaveProperty('dependencyWarnings');
  });

  it('walks the shapes directory so installed Shapes are visible (DOR-355 regression)', async () => {
    // A Shape installs to `<dorkHome>/shapes/<name>`, a root the scanner
    // originally never walked — so installed Shapes never appeared at
    // /marketplace?view=installed even though the install succeeded.
    const shapeDir = join(dorkHome, 'shapes', 'linear-ops');
    await writeManifest(shapeDir, {
      schemaVersion: 1,
      type: 'shape',
      name: 'linear-ops',
      version: '2.0.0',
    });
    await writeMetadata(shapeDir, {
      name: 'linear-ops',
      version: '2.0.0',
      type: 'shape',
      installedFrom: 'dorkos-community',
      installedAt: '2026-07-17T12:00:00.000Z',
    });

    const result = await scanInstalledPackages(dorkHome);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'linear-ops',
      version: '2.0.0',
      type: 'shape',
      installPath: shapeDir,
      installedFrom: 'dorkos-community',
      installedAt: '2026-07-17T12:00:00.000Z',
      scope: 'global',
    });
  });

  it('surfaces all five package types together across every install root', async () => {
    // One install per type, each at its real install root (skill-packs and
    // adapters share plugins/ with plugins; agents and shapes have their own
    // roots) — the load-bearing "no type is invisible to the scan" contract.
    await writeManifest(join(dorkHome, 'plugins', 'p'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'p',
      version: '1.0.0',
    });
    await writeManifest(join(dorkHome, 'plugins', 'sp'), {
      schemaVersion: 1,
      type: 'skill-pack',
      name: 'sp',
      version: '1.0.0',
    });
    await writeManifest(join(dorkHome, 'plugins', 'ad'), {
      schemaVersion: 1,
      type: 'adapter',
      name: 'ad',
      version: '1.0.0',
    });
    await writeManifest(join(dorkHome, 'agents', 'a'), {
      schemaVersion: 1,
      type: 'agent',
      name: 'a',
      version: '1.0.0',
    });
    await writeManifest(join(dorkHome, 'shapes', 's'), {
      schemaVersion: 1,
      type: 'shape',
      name: 's',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    const byType = Object.fromEntries(result.map((p) => [p.type, p.name]));
    expect(byType).toEqual({
      plugin: 'p',
      'skill-pack': 'sp',
      adapter: 'ad',
      agent: 'a',
      shape: 's',
    });
  });

  it('omits provenance fields when the install-metadata sidecar is missing', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'orphan-plugin');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'orphan-plugin',
      version: '0.1.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'orphan-plugin',
      version: '0.1.0',
      type: 'plugin',
      installPath: pluginDir,
      scope: 'global',
    });
    expect(result[0].installedFrom).toBeUndefined();
    expect(result[0].installedAt).toBeUndefined();
  });

  it('surfaces adapterType for an installed connector adapter, matching what Browse shows (DOR-710)', async () => {
    const connectorDir = join(dorkHome, 'plugins', 'slack-connector');
    await writeManifest(connectorDir, {
      schemaVersion: 1,
      type: 'adapter',
      adapterType: 'connector',
      name: 'slack-connector',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0].adapterType).toBe('connector');
  });

  it('never leaks adapterType onto a non-adapter package, even if the manifest carries the field', async () => {
    // The same gate `flattenMergedEntry` applies for Browse: adapterType is
    // meaningful only for `type: 'adapter'`, so it must not leak through for
    // any other type even if present on disk.
    const pluginDir = join(dorkHome, 'plugins', 'odd-plugin');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      adapterType: 'connector',
      name: 'odd-plugin',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0].adapterType).toBeUndefined();
  });

  it('sees a CC-NATIVE package (only .claude-plugin/plugin.json, no .dork/manifest.json) — DOR-264', async () => {
    // The installer copies Claude Code packages verbatim, so a CC-native
    // install has no `.dork/manifest.json`. It must still be visible to
    // list/uninstall/update via the validator's CC-manifest synthesis.
    const pluginDir = join(dorkHome, 'plugins', 'commit-commands');
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'commit-commands', version: '2.0.0', description: 'CC native' }),
      'utf-8'
    );

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'commit-commands',
      version: '2.0.0',
      type: 'plugin',
      installPath: pluginDir,
    });
  });

  it('skips package directories with missing or unreadable manifests', async () => {
    // Directory exists with no manifest at all.
    await mkdir(join(dorkHome, 'plugins', 'empty-dir'), { recursive: true });

    // Valid plugin alongside the broken one.
    const goodDir = join(dorkHome, 'plugins', 'good-plugin');
    await writeManifest(goodDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'good-plugin',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('good-plugin');
  });

  it('only walks plugins/ and agents/, ignoring sibling directories', async () => {
    // Stash a "package-like" tree under an unrelated dir.
    const strayDir = join(dorkHome, 'somewhere-else', 'rogue');
    await writeManifest(strayDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'rogue',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toEqual([]);
  });

  it('never lists a crash-left install backup, even with a valid manifest (DOR-175)', async () => {
    // A crash mid-install leaves `<name>.dorkos-bak-<ts>-<uuid>` on disk — a
    // byte-for-byte move-aside of the previous installation, so it carries a
    // VALID manifest under the SAME package name. Without the exclusion the
    // scan would return a duplicate whose merged-by-name view could point
    // installPath at the backup.
    const realDir = join(dorkHome, 'plugins', 'sentry-monitor');
    await writeManifest(realDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.3',
    });
    const backupDir = join(
      dorkHome,
      'plugins',
      `sentry-monitor.dorkos-bak-${Date.now()}-3fa85f64-5717-4562-b3fc-2c963f66afa6`
    );
    await writeManifest(backupDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.2',
    });
    // Agent-root backups are excluded too.
    const agentBackupDir = join(dorkHome, 'agents', `researcher.dorkos-bak-${Date.now()}-deadbeef`);
    await writeManifest(agentBackupDir, {
      schemaVersion: 1,
      type: 'agent',
      name: 'researcher',
      version: '0.5.0',
    });

    const result = await scanInstalledPackages(dorkHome);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'sentry-monitor',
      version: '1.2.3',
      installPath: realDir,
    });
  });

  it('excludes backups from the merged single-project view as well (DOR-175)', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'dorkos-scanner-project-'));
    try {
      const localReal = join(projectPath, '.dork', 'plugins', 'flow');
      await writeManifest(localReal, {
        schemaVersion: 1,
        type: 'plugin',
        name: 'flow',
        version: '1.0.0',
      });
      const localBackup = join(
        projectPath,
        '.dork',
        'plugins',
        `flow.dorkos-bak-${Date.now()}-cafebabe`
      );
      await writeManifest(localBackup, {
        schemaVersion: 1,
        type: 'plugin',
        name: 'flow',
        version: '0.9.0',
      });

      const result = await scanInstalledPackages(dorkHome, projectPath);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'flow',
        version: '1.0.0',
        installPath: localReal,
        scope: 'agent-local',
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('readInstalledIdentity', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-installed-identity-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `.claude-plugin/plugin.json` to a package root. */
  async function writePluginJson(
    packagePath: string,
    plugin: Record<string, unknown>
  ): Promise<void> {
    await mkdir(join(packagePath, '.claude-plugin'), { recursive: true });
    await writeFile(join(packagePath, '.claude-plugin', 'plugin.json'), JSON.stringify(plugin));
  }

  it('lists a tree whose version files disagree, at the version Claude Code runs', async () => {
    // Purpose: flow's installs carry manifest 0.6.0 beside plugin.json 0.7.2.
    // They must stay listed (never gated on validity) and show 0.7.2, the
    // version the update check compares and Claude Code loads.
    const pluginDir = join(dorkHome, 'plugins', 'flow');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '0.6.0',
      description: 'Flow',
    });
    await writePluginJson(pluginDir, { name: 'flow', version: '0.7.2' });

    const [listed] = await scanInstalledPackages(dorkHome);
    expect(listed).toMatchObject({ name: 'flow', version: '0.7.2' });
    expect(await readInstalledIdentity(pluginDir)).toMatchObject({
      version: '0.7.2',
      declaredVersion: '0.7.2',
    });
  });

  it('keeps listing a Claude-Code-only install that fails validation for another reason', async () => {
    // Purpose: the installed side never gates on `ok`. A package already on
    // disk that today's rules refuse (here, a shipped agent.json declaring MCP
    // servers) must not vanish from the list, from uninstall, or from the
    // update check.
    const pluginDir = join(dorkHome, 'plugins', 'cc-broken');
    await writePluginJson(pluginDir, { name: 'cc-broken', version: '1.3.0' });
    await mkdir(join(pluginDir, '.dork'), { recursive: true });
    await writeFile(
      join(pluginDir, '.dork', 'agent.json'),
      JSON.stringify({ mcpServers: [{ name: 'x', command: 'x' }] })
    );

    const listed = await scanInstalledPackages(dorkHome);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'cc-broken', version: '1.3.0', type: 'plugin' });
  });

  it("reports a Claude-Code-only package's own version, and no declared version when it states none", async () => {
    // Purpose: "declares none" must not read as a real 0.0.0 to the update check.
    const withVersion = join(dorkHome, 'plugins', 'cc-versioned');
    await writePluginJson(withVersion, { name: 'cc-versioned', version: '2.0.0' });
    const without = join(dorkHome, 'plugins', 'cc-unversioned');
    await writePluginJson(without, { name: 'cc-unversioned' });

    expect(await readInstalledIdentity(withVersion)).toMatchObject({
      version: '2.0.0',
      declaredVersion: '2.0.0',
    });
    const identity = await readInstalledIdentity(without);
    expect(identity).toMatchObject({ name: 'cc-unversioned', version: '0.0.0' });
    expect(identity?.declaredVersion).toBeUndefined();
  });

  it('returns null rather than throwing for a directory it cannot read', async () => {
    // Purpose: it sits on the installed-list and update-check paths, where
    // one unreadable package must cost only its own entry.
    expect(await readInstalledIdentity(join(dorkHome, 'does', 'not', 'exist'))).toBeNull();
  });
});

describe('scanInstallationsAcrossScopes', () => {
  let dorkHome: string;
  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-cross-scope-'));
    agentA = await mkdtemp(join(tmpdir(), 'dorkos-agent-a-'));
    agentB = await mkdtemp(join(tmpdir(), 'dorkos-agent-b-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(agentA, { recursive: true, force: true });
    await rm(agentB, { recursive: true, force: true });
  });

  // Purpose: one entry PER INSTALLATION — the core contract that lets the UI
  // show and manage each scope independently.
  it('returns global plus one entry per agent installation, agents sorted by name', async () => {
    await writeManifest(join(dorkHome, 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });
    await writeManifest(join(agentA, '.dork', 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });
    await writeManifest(join(agentB, '.dork', 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '0.9.0',
    });

    const result = await scanInstallationsAcrossScopes(dorkHome, [
      { projectPath: agentB, id: 'b', name: 'Zeta Agent' },
      { projectPath: agentA, id: 'a', name: 'Alpha Agent' },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ name: 'flow', scope: 'global' });
    // Agent entries sorted by display name regardless of input order.
    expect(result[1]).toMatchObject({
      scope: 'override',
      agentPath: agentA,
      agentId: 'a',
      agentName: 'Alpha Agent',
    });
    expect(result[2]).toMatchObject({
      scope: 'override',
      agentPath: agentB,
      agentName: 'Zeta Agent',
      version: '0.9.0',
    });
  });

  // Purpose: agent-only installs (no global copy) are plain agent-local, not
  // overrides.
  it('tags agent-only installs as agent-local', async () => {
    await writeManifest(join(agentA, '.dork', 'plugins', 'solo'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'solo',
      version: '1.0.0',
    });

    const result = await scanInstallationsAcrossScopes(dorkHome, [
      { projectPath: agentA, id: 'a', name: 'Alpha Agent' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].scope).toBe('agent-local');
  });

  // Purpose: a crash-left backup inside an agent's .dork/plugins/ must not
  // surface as a phantom installation row (DOR-175).
  it('excludes crash-left backups from the cross-scope walk', async () => {
    await writeManifest(join(agentA, '.dork', 'plugins', 'solo'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'solo',
      version: '1.0.0',
    });
    await writeManifest(
      join(agentA, '.dork', 'plugins', `solo.dorkos-bak-${Date.now()}-3fa85f64`),
      {
        schemaVersion: 1,
        type: 'plugin',
        name: 'solo',
        version: '0.9.0',
      }
    );

    const result = await scanInstallationsAcrossScopes(dorkHome, [
      { projectPath: agentA, id: 'a', name: 'Alpha Agent' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'solo', version: '1.0.0', scope: 'agent-local' });
  });

  // Purpose: two registry entries can point at one directory (re-registration);
  // the scan must not produce duplicate rows for them.
  it('dedupes agents sharing a project path and skips unreadable agent dirs', async () => {
    await writeManifest(join(agentA, '.dork', 'plugins', 'solo'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'solo',
      version: '1.0.0',
    });

    const result = await scanInstallationsAcrossScopes(dorkHome, [
      { projectPath: agentA, id: 'a', name: 'Alpha Agent' },
      { projectPath: agentA, id: 'a2', name: 'Alpha Clone' },
      { projectPath: join(agentB, 'does-not-exist'), id: 'ghost', name: 'Ghost' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('a');
  });
});

describe('scanInstallationRecords', () => {
  let dorkHome: string;
  let agentA: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-records-'));
    agentA = await mkdtemp(join(tmpdir(), 'dorkos-records-agent-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(agentA, { recursive: true, force: true });
  });

  it('keeps the declared version and the whole sidecar the update check needs', async () => {
    // Purpose: the listing used to read both and throw them away, so the
    // update check had to walk every scope a second time to get them back.
    const pluginDir = join(dorkHome, 'plugins', 'flow');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '0.6.0',
    });
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'flow', version: '0.7.2' })
    );
    await writeMetadata(pluginDir, {
      name: 'flow',
      version: '0.7.2',
      type: 'plugin',
      installedFrom: 'dorkos-community',
      installedAt: '2026-09-01T00:00:00.000Z',
      commitSha: 'a'.repeat(40),
      entryVersion: '0.7.2',
    });

    const [record] = await scanInstallationRecords(dorkHome, { agents: [] });

    expect(record).toMatchObject({
      kind: 'plugins',
      declaredVersion: '0.7.2',
      metadata: { commitSha: 'a'.repeat(40), entryVersion: '0.7.2' },
      package: { name: 'flow', version: '0.7.2', scope: 'global', installPath: pluginDir },
    });
  });

  it('reports no declared version for a Claude-Code-only package that states none', async () => {
    // Purpose: a synthesized 0.0.0 must never read as a real version, or the
    // check would compare against a number nobody declared.
    const pluginDir = join(dorkHome, 'plugins', 'bare');
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bare', description: 'no version here' })
    );

    const [record] = await scanInstallationRecords(dorkHome, { agents: [] });

    expect(record?.package.name).toBe('bare');
    expect(record?.declaredVersion).toBeUndefined();
    expect(record?.metadata).toBeNull();
  });

  it('gives one record per installation across scopes, with the agent identity', async () => {
    // Purpose: the all-packages update door checks exactly what the installed
    // list shows, so the same package in two places is two records.
    for (const root of [
      join(dorkHome, 'plugins', 'flow'),
      join(agentA, '.dork', 'plugins', 'flow'),
    ]) {
      await writeManifest(root, {
        schemaVersion: 1,
        type: 'plugin',
        name: 'flow',
        version: '1.0.0',
      });
    }

    const records = await scanInstallationRecords(dorkHome, {
      agents: [{ projectPath: agentA, id: 'a', name: 'Alpha' }],
    });

    expect(records.map((r) => r.package.scope)).toEqual(['global', 'override']);
    expect(records[1]?.package).toMatchObject({
      agentPath: agentA,
      agentId: 'a',
      agentName: 'Alpha',
    });
  });

  it('marks a symlinked install as linked, and a fetched one as not', async () => {
    // Purpose: a developer's working copy linked into place must be told apart
    // from a checkout, so an update can never replace it with a fresh fetch.
    const source = join(agentA, 'working-copy');
    await writeManifest(source, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'dev',
      version: '1.0.0',
    });
    await mkdir(join(dorkHome, 'plugins'), { recursive: true });
    await symlink(source, join(dorkHome, 'plugins', 'dev'));
    await writeManifest(join(dorkHome, 'plugins', 'fetched'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'fetched',
      version: '1.0.0',
    });

    const records = await scanInstallationRecords(dorkHome, { agents: [] });

    expect(Object.fromEntries(records.map((r) => [r.package.name, r.linked]))).toEqual({
      dev: true,
      fetched: false,
    });
  });

  it("gives one project's merged view when asked for a project", async () => {
    // Purpose: with a project, a project install shadows the global one in the
    // same root, exactly as the installed list's project view does.
    await writeManifest(join(dorkHome, 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });
    await writeManifest(join(dorkHome, 'plugins', 'other'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'other',
      version: '1.0.0',
    });
    await writeManifest(join(agentA, '.dork', 'plugins', 'flow'), {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '2.0.0',
    });

    const records = await scanInstallationRecords(dorkHome, { projectPath: agentA });

    expect(records.map((r) => [r.package.name, r.package.scope, r.package.version])).toEqual([
      ['flow', 'override', '2.0.0'],
      ['other', 'global', '1.0.0'],
    ]);
    expect(records[0]?.package.agentPath).toBe(agentA);
  });
});

describe('computeProvides', () => {
  let installPath: string;

  beforeEach(async () => {
    installPath = await mkdtemp(join(tmpdir(), 'dorkos-provides-'));
  });

  afterEach(async () => {
    await rm(installPath, { recursive: true, force: true });
  });

  it('counts top-level and namespaced command files, skills, and hooks presence', async () => {
    // 2 top-level commands + 1 namespaced command = 3.
    await mkdir(join(installPath, 'commands', 'sub'), { recursive: true });
    await writeFile(join(installPath, 'commands', 'a.md'), '# a', 'utf-8');
    await writeFile(join(installPath, 'commands', 'b.md'), '# b', 'utf-8');
    await writeFile(join(installPath, 'commands', 'sub', 'c.md'), '# c', 'utf-8');
    // 2 skills (each a directory).
    await mkdir(join(installPath, 'skills', 'one'), { recursive: true });
    await mkdir(join(installPath, 'skills', 'two'), { recursive: true });
    // hooks present.
    await mkdir(join(installPath, 'hooks'), { recursive: true });
    await writeFile(join(installPath, 'hooks', 'stop.md'), '# hook', 'utf-8');

    const provides = await computeProvides(installPath);
    expect(provides).toEqual({ commands: 3, skills: 2, hooks: true });
  });

  it('returns zeros and hooks:false when the package ships none of them', async () => {
    const provides = await computeProvides(installPath);
    expect(provides).toEqual({ commands: 0, skills: 0, hooks: false });
  });
});
