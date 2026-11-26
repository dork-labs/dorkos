/**
 * @vitest-environment node
 *
 * The read routes: the installed list, the package cache, and browsing every
 * source's packages, plus how a listed package's source is resolved.
 */
import { describe, it, expect } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { MarketplaceJson, PluginSource } from '@dorkos/marketplace';
import { resolvePackageSource } from '../../../services/marketplace/aggregate-packages.js';
import {
  SAMPLE_MARKETPLACE_JSON,
  tempDir,
  useMarketplaceRoutes,
  writePackageManifest,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

const plugin = (name: string, version = '1.0.0') => ({
  manifest: 1,
  type: 'plugin',
  name,
  version,
});

describe('GET /installed', () => {
  it('walks plugins and agents dirs and returns installed packages', async () => {
    const pluginDir = join(h.dorkHome, 'plugins', 'my-plugin');
    writePackageManifest(pluginDir, plugin('my-plugin', '1.2.3'));
    writePackageManifest(join(h.dorkHome, 'agents', 'my-agent'), {
      manifest: 1,
      type: 'agent',
      name: 'my-agent',
      version: '0.5.0',
    });

    const res = await h.get('/installed');

    expect(res.status).toBe(200);
    expect(res.body.packages.map((p: { name: string }) => p.name).sort()).toEqual([
      'my-agent',
      'my-plugin',
    ]);
    expect(res.body.packages.find((p: { name: string }) => p.name === 'my-plugin')).toMatchObject({
      type: 'plugin',
      version: '1.2.3',
      installPath: pluginDir,
    });
  });

  it('adds integrity only when asked to verify (DOR-2197)', async () => {
    // Verification hashes files, so it is opt-in.
    const pluginDir = join(h.dorkHome, 'plugins', 'my-plugin');
    writePackageManifest(pluginDir, plugin('my-plugin'));
    const { computeInstalledFiles, writeInstalledFiles } =
      await import('../../../services/marketplace/lib/records/installed-files.js');
    await writeInstalledFiles(
      pluginDir,
      await computeInstalledFiles(pluginDir, {
        identity: { name: 'my-plugin', type: 'plugin' },
        userEditable: [],
        npmRan: false,
      })
    );
    writePackageManifest(join(h.dorkHome, 'plugins', 'old-plugin'), plugin('old-plugin'));

    const plain = await h.get('/installed');
    expect(plain.body.packages.every((p: object) => !('integrity' in p))).toBe(true);

    const verified = await h.get('/installed?verify=true');
    const byName = Object.fromEntries(
      verified.body.packages.map((p: { name: string; integrity: unknown }) => [p.name, p.integrity])
    );
    expect(byName['my-plugin']).toEqual({ status: 'clean', customized: [] });
    expect(byName['old-plugin']).toEqual({
      status: 'unknown',
      reason: 'no-record',
      check: { source: 'local' },
    });

    const one = await h.get('/installed/old-plugin?verify=true');
    expect(one.body.installations[0].integrity).toMatchObject({
      status: 'unknown',
      reason: 'no-record',
    });
  });

  it("lists an agent's own installs and its copies of global ones, tagged with the agent", async () => {
    // The global walk cannot see agent-scoped installs; the route hands the
    // scan the agents it knows, with their identities.
    writePackageManifest(join(h.dorkHome, 'plugins', 'both-plugin'), plugin('both-plugin'));
    const agentProject = tempDir('dorkos-agent-scope-');
    h.agentScopes = [{ projectPath: agentProject, id: 'agent-1', name: 'E2E Test Agent' }];
    const agentPlugins = join(agentProject, '.dork', 'plugins');
    writePackageManifest(join(agentPlugins, 'scoped-plugin'), plugin('scoped-plugin', '2.0.0'));
    writePackageManifest(join(agentPlugins, 'both-plugin'), plugin('both-plugin', '1.1.0'));

    try {
      const res = await h.get('/installed');
      expect(res.status).toBe(200);
      const scopeOf = (name: string) =>
        res.body.packages
          .filter((p: { name: string }) => p.name === name)
          .map((p: { scope: string }) => p.scope)
          .sort();
      expect(scopeOf('both-plugin')).toEqual(['global', 'override']);
      expect(
        res.body.packages.find((p: { name: string }) => p.name === 'scoped-plugin')
      ).toMatchObject({
        scope: 'agent-local',
        agentPath: agentProject,
        agentId: 'agent-1',
        agentName: 'E2E Test Agent',
      });

      const detail = await h.get('/installed/both-plugin');
      expect(detail.status).toBe(200);
      const byScope = Object.fromEntries(
        detail.body.installations.map((i: { scope: string }) => [i.scope, i])
      );
      expect(byScope.global).toMatchObject({
        provides: { commands: 0, skills: 0, hooks: false },
      });
      expect(byScope.override).toMatchObject({
        agentPath: agentProject,
        agentName: 'E2E Test Agent',
      });
    } finally {
      rmSync(agentProject, { recursive: true, force: true });
    }
  });

  it('GET /installed/:name returns 404 when not installed', async () => {
    expect((await h.get('/installed/nonexistent')).status).toBe(404);
  });
});

/** Put a verified tree for `name` at `commit` into the cache through its one write path. */
async function seedTree(name: string, commit: string, file = 'f', content = 'x'): Promise<void> {
  await h.cache.materializePackage(name, commit, '', async (dir) => {
    writeFileSync(join(dir, file), content);
    return commit;
  });
}

/** Mark every cached tree as last used an hour ago, past the in-use grace. */
async function ageAllTrees(): Promise<void> {
  const then = new Date(Date.now() - 60 * 60 * 1000);
  for (const entry of await h.cache.listPackages()) await utimes(entry.path, then, then);
}

describe('the package cache', () => {
  it('GET /cache counts cached marketplaces and packages, and DELETE /cache clears them', async () => {
    await h.cache.writeMarketplace('test-mp', SAMPLE_MARKETPLACE_JSON);
    await seedTree('test-pkg', 'd'.repeat(40));

    const res = await h.get('/cache');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ marketplaces: 1, packages: 1 });
    expect(res.body.totalSizeBytes).toBeGreaterThan(0);

    expect((await h.del('/cache')).status).toBe(204);
    expect((await h.get('/cache')).body).toMatchObject({ marketplaces: 0, packages: 0 });
  });

  it('GET /cache reports whether automatic cleanup is paused, and why', async () => {
    // A paused cleanup removes nothing and says so nowhere else a person
    // looks; `dorkos cache list` reads it from here.
    expect((await h.get('/cache')).body.cleanup).toEqual({
      paused: false,
      reason: null,
      since: null,
    });

    const missing = join(h.dorkHome, 'unplugged-drive', 'app');
    h.agentScopes = [{ projectPath: missing }];
    await h.post('/cache/prune', {});

    const after = await h.get('/cache');
    expect(after.body.cleanup).toMatchObject({
      paused: true,
      reason: `couldn't read ${missing} (the folder is missing)`,
      since: expect.any(String),
    });
  });

  it('POST /cache/prune removes what no install needs, keeps what one records, and reports freed bytes', async () => {
    await seedTree('test-pkg', 'a'.repeat(40), 'payload.txt', 'first');
    await seedTree('test-pkg', 'b'.repeat(40), 'payload.txt', 'second');
    const installRoot = join(h.dorkHome, 'plugins', 'kept-pkg');
    writePackageManifest(installRoot, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'kept-pkg',
      version: '1.0.0',
    });
    writeFileSync(
      join(installRoot, '.dork', 'install-metadata.json'),
      JSON.stringify({
        name: 'kept-pkg',
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2026-09-01T00:00:00.000Z',
        commitSha: 'c'.repeat(40),
      })
    );
    await seedTree('kept-pkg', 'c'.repeat(40));
    await ageAllTrees();

    const res = await h.post('/cache/prune', {});

    expect(res.status).toBe(200);
    expect(res.body.removed.map((e: { commitSha: string }) => e.commitSha).sort()).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
    ]);
    expect(typeof res.body.removed[0].lastUsedAt).toBe('string');
    expect(res.body.freedBytes).toBe('first'.length + 'second'.length);
    expect((await h.get('/cache')).body.packages).toBe(1);
  });

  it('POST /cache/prune accepts no body at all', async () => {
    const res = await h.post('/cache/prune');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: [], freedBytes: 0 });
  });

  it('POST /cache/prune answers 503 and removes nothing when an install cannot be read', async () => {
    // The person hears why nothing happened, without the path (it names
    // their home folder).
    await seedTree('test-pkg', 'a'.repeat(40));
    await ageAllTrees();
    h.agentScopes = [{ projectPath: join(h.dorkHome, 'unplugged-drive', 'app') }];

    const res = await h.post('/cache/prune', {});

    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/Nothing was removed/);
    expect(res.body.detail).not.toContain(h.dorkHome);
    expect((await h.get('/cache')).body.packages).toBe(1);
  });

  it('POST /cache/prune rejects the retired keepLastN option', async () => {
    // A per-name "keep N" deletes the commits installs record.
    const res = await h.post('/cache/prune', { keepLastN: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('GET /packages', () => {
  const listingNamed = (name: string): MarketplaceJson => ({
    name,
    owner: { name: 'Owner' },
    plugins: [{ name: `${name}-pkg`, source: `https://example.com/${name}-pkg`, version: '1.0.0' }],
  });

  it('aggregates packages from every enabled marketplace, skipping one that fails', async () => {
    await h.post('/sources', { name: 'mp-one', source: 'https://example.com/one' });
    await h.post('/sources', { name: 'mp-two', source: 'https://example.com/two' });
    await h.post('/sources', { name: 'mp-down', source: 'https://example.com/down' });
    h.fetcher.fetchMarketplaceJson.mockImplementation(async (source: { name: string }) => {
      if (source.name === 'mp-down') throw new Error('network down');
      return listingNamed(source.name);
    });

    const res = await h.get('/packages');

    expect(res.status).toBe(200);
    const names = res.body.packages.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['mp-one-pkg', 'mp-two-pkg']));
    expect(names).not.toContain('mp-down-pkg');
    expect(
      res.body.packages.find((p: { name: string }) => p.name === 'mp-one-pkg').marketplace
    ).toBe('mp-one');
  });

  it.each([
    [
      'populates DorkOS extension fields from the sidecar',
      { type: 'agent', displayName: 'Sample Agent', icon: '🤖', featured: true },
      { type: 'agent', displayName: 'Sample Agent', icon: '🤖', featured: true },
    ],
    [
      'surfaces the sidecar adapterType so connector adapters are discoverable',
      { type: 'adapter', adapterType: 'connector' },
      { type: 'adapter', adapterType: 'connector' },
    ],
    [
      'drops adapterType from non-adapter entries (contract: adapters only)',
      { type: 'plugin', adapterType: 'connector' },
      { type: 'plugin', adapterType: undefined },
    ],
    [
      'derives the primary category from the sidecar categories[0]',
      { categories: ['security', 'code-review'] },
      { categories: ['security', 'code-review'], category: 'security' },
    ],
  ])('%s', async (_name, sidecarEntry, expected) => {
    h.fetcher.fetchDorkosSidecar.mockResolvedValue({
      schemaVersion: 1,
      plugins: { 'sample-plugin': sidecarEntry },
    });

    const res = await h.get('/packages');

    expect(res.status).toBe(200);
    const pkg = res.body.packages.find((p: { name: string }) => p.name === 'sample-plugin');
    for (const [key, value] of Object.entries(expected)) expect(pkg[key]).toEqual(value);
  });

  it('with no sidecar, adds no DorkOS fields and keeps the inline singular category', async () => {
    h.fetcher.fetchMarketplaceJson.mockResolvedValue({
      ...SAMPLE_MARKETPLACE_JSON,
      plugins: [{ ...SAMPLE_MARKETPLACE_JSON.plugins[0], category: 'security' }],
    });

    const res = await h.get('/packages');

    expect(res.status).toBe(200);
    const pkg = res.body.packages.find((p: { name: string }) => p.name === 'sample-plugin');
    expect(pkg).toMatchObject({ category: 'security' });
    for (const key of ['type', 'displayName', 'icon', 'featured', 'categories']) {
      expect(pkg[key]).toBeUndefined();
    }
  });
});

describe('resolvePackageSource', () => {
  const gh = 'https://github.com/dork-labs/marketplace';

  it.each<[string, PluginSource, string, string]>([
    [
      'a relative path, against a GitHub marketplace',
      './plugins/sec',
      gh,
      'github:dork-labs/marketplace/plugins/sec',
    ],
    [
      'a relative path, against any other host',
      './plugins/foo',
      'https://gitlab.com/org/repo',
      './plugins/foo',
    ],
    ['a non-relative string', 'https://github.com/org/repo', gh, 'https://github.com/org/repo'],
    [
      'a GitHub object (ref not encoded)',
      { source: 'github', repo: 'me/starter', ref: 'main' },
      gh,
      'github:me/starter',
    ],
    [
      'a URL object',
      { source: 'url', url: 'https://gitlab.com/org/repo.git' },
      gh,
      'https://gitlab.com/org/repo.git',
    ],
    [
      'a git-subdir object, to its clone URL',
      { source: 'git-subdir', url: 'https://github.com/org/mono.git', path: 'packages/plugin' },
      gh,
      'https://github.com/org/mono.git',
    ],
    ['an npm object', { source: 'npm', package: '@scope/my-plugin' }, gh, 'npm:@scope/my-plugin'],
  ])('resolves %s', (_what, source, marketplaceUrl, expected) => {
    expect(resolvePackageSource(source, marketplaceUrl)).toBe(expected);
  });
});
