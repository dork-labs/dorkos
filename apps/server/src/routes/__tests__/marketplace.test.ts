/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { MarketplaceJson, PluginPackageManifest } from '@dorkos/marketplace';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { MarketplaceSourceManager } from '../../services/marketplace/marketplace-source-manager.js';
import { MarketplaceCache } from '../../services/marketplace/marketplace-cache.js';
import type { PackageFetcher } from '../../services/marketplace/package-fetcher.js';
import {
  ConflictError,
  InvalidPackageError,
  type InstallerLike,
} from '../../services/marketplace/marketplace-installer.js';
import {
  PackageNotInstalledError,
  type UninstallFlow,
} from '../../services/marketplace/flows/uninstall.js';
import type { UpdateFlow } from '../../services/marketplace/flows/update.js';
import type { InstallResult, PermissionPreview } from '../../services/marketplace/types.js';
import { createMarketplaceRouter } from '../marketplace.js';

const SAMPLE_MARKETPLACE_JSON: MarketplaceJson = {
  name: 'dorkos-community',
  plugins: [
    {
      name: 'sample-plugin',
      source: 'https://github.com/dorkos/sample-plugin',
      description: 'A sample plugin',
      version: '1.0.0',
    },
  ],
};

/** Minimal PackageFetcher stub — only the methods the router touches. */
interface FakeFetcher extends Pick<PackageFetcher, 'fetchMarketplaceJson' | 'fetchDorkosSidecar'> {
  fetchMarketplaceJson: ReturnType<typeof vi.fn>;
  fetchDorkosSidecar: ReturnType<typeof vi.fn>;
}

function createFakeFetcher(): FakeFetcher {
  return {
    fetchMarketplaceJson: vi.fn().mockResolvedValue(SAMPLE_MARKETPLACE_JSON),
    fetchDorkosSidecar: vi.fn().mockResolvedValue(null),
  };
}

/** Minimal InstallerLike stub — `preview` and `install` are vi.fn spies. */
interface FakeInstaller extends InstallerLike {
  preview: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
}

function createFakeInstaller(): FakeInstaller {
  return {
    preview: vi.fn(),
    install: vi.fn(),
  };
}

/** Minimal UninstallFlow stub — only the `uninstall` method is mocked. */
interface FakeUninstallFlow {
  uninstall: ReturnType<typeof vi.fn>;
}

function createFakeUninstallFlow(): FakeUninstallFlow {
  return { uninstall: vi.fn() };
}

/** Minimal UpdateFlow stub — only the `run` method is mocked. */
interface FakeUpdateFlow {
  run: ReturnType<typeof vi.fn>;
}

function createFakeUpdateFlow(): FakeUpdateFlow {
  return { run: vi.fn() };
}

function buildSamplePluginManifest(): PluginPackageManifest {
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
  };
}

function buildEmptyPermissionPreview(): PermissionPreview {
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

function buildSampleInstallResult(): InstallResult {
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

function writePackageManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(join(dir, '.dork', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

describe('Marketplace Routes', () => {
  let dorkHome: string;
  let app: express.Express;
  let sourceManager: MarketplaceSourceManager;
  let cache: MarketplaceCache;
  let fetcher: FakeFetcher;
  let installer: FakeInstaller;
  let uninstallFlow: FakeUninstallFlow;
  let updateFlow: FakeUpdateFlow;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'dorkos-marketplace-routes-'));
    sourceManager = new MarketplaceSourceManager(dorkHome);
    cache = new MarketplaceCache(dorkHome);
    fetcher = createFakeFetcher();
    installer = createFakeInstaller();
    uninstallFlow = createFakeUninstallFlow();
    updateFlow = createFakeUpdateFlow();

    app = express();
    app.use(express.json());
    app.use(
      '/api/marketplace',
      createMarketplaceRouter({
        sourceManager,
        cache,
        fetcher: fetcher as unknown as PackageFetcher,
        installer,
        uninstallFlow: uninstallFlow as unknown as UninstallFlow,
        updateFlow: updateFlow as unknown as UpdateFlow,
        dorkHome,
      })
    );
  });

  afterEach(() => {
    rmSync(dorkHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('GET /sources', () => {
    it('returns seeded sources on first call', async () => {
      const res = await request(app).get('/api/marketplace/sources');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sources');
      expect(Array.isArray(res.body.sources)).toBe(true);
      expect(res.body.sources.length).toBeGreaterThan(0);
      expect(res.body.sources[0]).toHaveProperty('name');
      expect(res.body.sources[0]).toHaveProperty('source');
      expect(res.body.sources[0]).toHaveProperty('enabled');
    });
  });

  describe('POST /sources', () => {
    it('adds a new source and returns 201 with the created entry', async () => {
      const res = await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'my-custom', source: 'https://github.com/me/marketplace' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('my-custom');
      expect(res.body.source).toBe('https://github.com/me/marketplace');
      expect(res.body.enabled).toBe(true);
      expect(typeof res.body.addedAt).toBe('string');
    });

    it('returns 409 when adding a duplicate name', async () => {
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'dup', source: 'https://example.com/one' });

      const res = await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'dup', source: 'https://example.com/two' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBeTruthy();
    });

    it('returns 400 for invalid body', async () => {
      const res = await request(app).post('/api/marketplace/sources').send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('DELETE /sources/:name', () => {
    it('removes a source and returns 204', async () => {
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'removable', source: 'https://example.com/r' });

      const res = await request(app).delete('/api/marketplace/sources/removable');
      expect(res.status).toBe(204);

      const listRes = await request(app).get('/api/marketplace/sources');
      const names = listRes.body.sources.map((s: { name: string }) => s.name);
      expect(names).not.toContain('removable');
    });
  });

  describe('POST /sources/:name/refresh', () => {
    it('calls fetcher with the resolved source and returns marketplace JSON', async () => {
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'refreshable', source: 'https://example.com/refresh' });

      const res = await request(app).post('/api/marketplace/sources/refreshable/refresh');

      expect(res.status).toBe(200);
      expect(res.body.marketplace).toEqual(SAMPLE_MARKETPLACE_JSON);
      expect(typeof res.body.fetchedAt).toBe('string');
      expect(fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
      const arg = fetcher.fetchMarketplaceJson.mock.calls[0][0];
      expect(arg.name).toBe('refreshable');
      expect(arg.source).toBe('https://example.com/refresh');
    });

    it('returns 404 when the source does not exist', async () => {
      const res = await request(app).post('/api/marketplace/sources/missing/refresh');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /installed', () => {
    it('walks plugins and agents dirs and returns installed packages', async () => {
      const pluginDir = join(dorkHome, 'plugins', 'my-plugin');
      writePackageManifest(pluginDir, {
        manifest: 1,
        type: 'plugin',
        name: 'my-plugin',
        version: '1.2.3',
      });

      const agentDir = join(dorkHome, 'agents', 'my-agent');
      writePackageManifest(agentDir, {
        manifest: 1,
        type: 'agent',
        name: 'my-agent',
        version: '0.5.0',
      });

      const res = await request(app).get('/api/marketplace/installed');
      expect(res.status).toBe(200);
      expect(res.body.packages).toHaveLength(2);

      const names = res.body.packages.map((p: { name: string }) => p.name).sort();
      expect(names).toEqual(['my-agent', 'my-plugin']);

      const plugin = res.body.packages.find((p: { name: string }) => p.name === 'my-plugin');
      expect(plugin.type).toBe('plugin');
      expect(plugin.version).toBe('1.2.3');
      expect(plugin.installPath).toBe(pluginDir);
    });

    it('returns empty list when no packages installed', async () => {
      const res = await request(app).get('/api/marketplace/installed');
      expect(res.status).toBe(200);
      expect(res.body.packages).toEqual([]);
    });
  });

  describe('GET /installed/:name', () => {
    it('returns an installed package by name', async () => {
      const pluginDir = join(dorkHome, 'plugins', 'my-plugin');
      writePackageManifest(pluginDir, {
        manifest: 1,
        type: 'plugin',
        name: 'my-plugin',
        version: '1.2.3',
      });

      const res = await request(app).get('/api/marketplace/installed/my-plugin');
      expect(res.status).toBe(200);
      expect(res.body.package.name).toBe('my-plugin');
      expect(res.body.package.type).toBe('plugin');
    });

    it('returns 404 when not installed', async () => {
      const res = await request(app).get('/api/marketplace/installed/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /cache', () => {
    it('returns cache size info', async () => {
      const res = await request(app).get('/api/marketplace/cache');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('marketplaces');
      expect(res.body).toHaveProperty('packages');
      expect(res.body).toHaveProperty('totalSizeBytes');
      expect(typeof res.body.marketplaces).toBe('number');
      expect(typeof res.body.packages).toBe('number');
      expect(typeof res.body.totalSizeBytes).toBe('number');
    });

    it('counts cached marketplaces and packages', async () => {
      await cache.writeMarketplace('test-mp', SAMPLE_MARKETPLACE_JSON);
      await cache.putPackage('test-pkg', 'deadbeef');

      const res = await request(app).get('/api/marketplace/cache');
      expect(res.status).toBe(200);
      expect(res.body.marketplaces).toBe(1);
      expect(res.body.packages).toBe(1);
      expect(res.body.totalSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('DELETE /cache', () => {
    it('clears the cache and returns 204', async () => {
      await cache.writeMarketplace('test-mp', SAMPLE_MARKETPLACE_JSON);

      const res = await request(app).delete('/api/marketplace/cache');
      expect(res.status).toBe(204);

      const statusRes = await request(app).get('/api/marketplace/cache');
      expect(statusRes.body.marketplaces).toBe(0);
      expect(statusRes.body.packages).toBe(0);
    });
  });

  describe('POST /cache/prune', () => {
    it('prunes older package SHAs and reports freed bytes', async () => {
      // Seed two cached SHAs for the same package. `putPackage` only reserves
      // the directory, so drop a small file inside each so the freed-bytes
      // calculation has something to measure.
      const firstPath = await cache.putPackage('test-pkg', 'aaaaaaaa');
      writeFileSync(join(firstPath, 'payload.txt'), 'first');
      // Bump mtimes so the two entries have a stable ordering regardless
      // of filesystem timestamp granularity.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondPath = await cache.putPackage('test-pkg', 'bbbbbbbb');
      writeFileSync(join(secondPath, 'payload.txt'), 'second');

      const res = await request(app).post('/api/marketplace/cache/prune').send({ keepLastN: 1 });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.removed)).toBe(true);
      expect(res.body.removed).toHaveLength(1);
      expect(res.body.removed[0].packageName).toBe('test-pkg');
      expect(res.body.removed[0].commitSha).toBe('aaaaaaaa');
      expect(typeof res.body.freedBytes).toBe('number');
      expect(res.body.freedBytes).toBeGreaterThan(0);

      // The surviving SHA should still be discoverable via GET /cache.
      const statusRes = await request(app).get('/api/marketplace/cache');
      expect(statusRes.body.packages).toBe(1);
    });

    it('defaults keepLastN to 1 when the body is empty', async () => {
      const firstPath = await cache.putPackage('pkg', 'aaaa');
      writeFileSync(join(firstPath, 'f'), 'a');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondPath = await cache.putPackage('pkg', 'bbbb');
      writeFileSync(join(secondPath, 'f'), 'b');

      const res = await request(app).post('/api/marketplace/cache/prune').send({});
      expect(res.status).toBe(200);
      expect(res.body.removed).toHaveLength(1);
      expect(res.body.removed[0].commitSha).toBe('aaaa');
    });

    it('rejects invalid keepLastN payloads', async () => {
      const res = await request(app).post('/api/marketplace/cache/prune').send({ keepLastN: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('GET /packages', () => {
    it('aggregates packages from every enabled marketplace', async () => {
      // Seed two sources so the fetcher is called twice.
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'mp-one', source: 'https://example.com/one' });
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'mp-two', source: 'https://example.com/two' });

      fetcher.fetchMarketplaceJson.mockImplementation(
        async (source: { name: string }): Promise<MarketplaceJson> => ({
          name: source.name,
          plugins: [
            {
              name: `${source.name}-pkg`,
              source: `https://example.com/${source.name}-pkg`,
              version: '1.0.0',
            },
          ],
        })
      );

      const res = await request(app).get('/api/marketplace/packages');
      expect(res.status).toBe(200);
      const names = res.body.packages.map((p: { name: string }) => p.name).sort();
      // One entry per configured marketplace (seeded defaults + mp-one + mp-two).
      expect(names).toContain('mp-one-pkg');
      expect(names).toContain('mp-two-pkg');
      const mpOneEntry = res.body.packages.find(
        (p: { name: string; marketplace: string }) => p.name === 'mp-one-pkg'
      );
      expect(mpOneEntry.marketplace).toBe('mp-one');
    });

    it('skips a failing marketplace and returns entries from the others', async () => {
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'mp-one', source: 'https://example.com/one' });
      await request(app)
        .post('/api/marketplace/sources')
        .send({ name: 'mp-two', source: 'https://example.com/two' });

      fetcher.fetchMarketplaceJson.mockImplementation(
        async (source: { name: string }): Promise<MarketplaceJson> => {
          if (source.name === 'mp-two') {
            throw new Error('network down');
          }
          return {
            name: source.name,
            plugins: [
              {
                name: `${source.name}-pkg`,
                source: `https://example.com/${source.name}-pkg`,
                version: '1.0.0',
              },
            ],
          };
        }
      );

      const res = await request(app).get('/api/marketplace/packages');
      expect(res.status).toBe(200);
      const names = res.body.packages.map((p: { name: string }) => p.name);
      expect(names).toContain('mp-one-pkg');
      expect(names).not.toContain('mp-two-pkg');
    });

    it('populates DorkOS extension fields from the sidecar', async () => {
      fetcher.fetchDorkosSidecar.mockResolvedValue({
        schemaVersion: 1 as const,
        plugins: {
          'sample-plugin': {
            type: 'agent' as const,
            icon: '🤖',
            featured: true,
            layers: ['skills', 'tasks'],
          },
        },
      });

      const res = await request(app).get('/api/marketplace/packages');
      expect(res.status).toBe(200);
      const pkg = res.body.packages.find((p: { name: string }) => p.name === 'sample-plugin');
      expect(pkg).toBeDefined();
      expect(pkg.type).toBe('agent');
      expect(pkg.icon).toBe('🤖');
      expect(pkg.featured).toBe(true);
    });

    it('returns packages when sidecar is absent', async () => {
      fetcher.fetchDorkosSidecar.mockResolvedValue(null);

      const res = await request(app).get('/api/marketplace/packages');
      expect(res.status).toBe(200);
      expect(res.body.packages.length).toBeGreaterThan(0);
      const pkg = res.body.packages.find((p: { name: string }) => p.name === 'sample-plugin');
      expect(pkg).toBeDefined();
      expect(pkg.type).toBeUndefined();
      expect(pkg.icon).toBeUndefined();
      expect(pkg.featured).toBeUndefined();
    });
  });

  describe('GET /packages/:name', () => {
    it('returns manifest, preview, and packagePath from installer.preview', async () => {
      const manifest = buildSamplePluginManifest();
      const preview = buildEmptyPermissionPreview();
      installer.preview.mockResolvedValue({
        manifest,
        preview,
        packagePath: '/tmp/fake/pkg',
      });

      const res = await request(app)
        .get('/api/marketplace/packages/sample-plugin')
        .query({ marketplace: 'dorkos-community' });

      expect(res.status).toBe(200);
      expect(res.body.manifest.name).toBe('sample-plugin');
      expect(res.body.packagePath).toBe('/tmp/fake/pkg');
      expect(installer.preview).toHaveBeenCalledTimes(1);
      expect(installer.preview.mock.calls[0][0]).toEqual({
        name: 'sample-plugin',
        marketplace: 'dorkos-community',
      });
    });

    it('returns 400 when installer.preview throws InvalidPackageError', async () => {
      installer.preview.mockRejectedValue(new InvalidPackageError(['bad manifest']));
      const res = await request(app).get('/api/marketplace/packages/broken');
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(['bad manifest']);
    });
  });

  describe('POST /packages/:name/preview', () => {
    it('returns the preview shape on success', async () => {
      const manifest = buildSamplePluginManifest();
      const preview = buildEmptyPermissionPreview();
      installer.preview.mockResolvedValue({
        manifest,
        preview,
        packagePath: '/tmp/fake/pkg',
      });

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/preview')
        .send({ marketplace: 'dorkos-community' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('preview');
      expect(res.body).toHaveProperty('manifest');
      expect(res.body).toHaveProperty('packagePath');
      expect(installer.preview.mock.calls[0][0]).toEqual({
        name: 'sample-plugin',
        marketplace: 'dorkos-community',
      });
    });

    it('returns 400 when the body is invalid', async () => {
      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/preview')
        .send({ force: 'not-a-boolean' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('POST /packages/:name/install', () => {
    it('returns the InstallResult on happy path', async () => {
      const result = buildSampleInstallResult();
      installer.install.mockResolvedValue(result);

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/install')
        .send({ marketplace: 'dorkos-community', force: false });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.packageName).toBe('sample-plugin');
      expect(installer.install.mock.calls[0][0]).toEqual({
        name: 'sample-plugin',
        marketplace: 'dorkos-community',
        force: false,
      });
    });

    it('returns 409 when installer.install throws ConflictError', async () => {
      const conflicts = [
        {
          level: 'error' as const,
          type: 'package-name' as const,
          description: 'already installed',
        },
      ];
      installer.install.mockRejectedValue(new ConflictError(conflicts));

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/install')
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.conflicts).toEqual(conflicts);
    });

    it('returns 400 when installer.install throws InvalidPackageError', async () => {
      installer.install.mockRejectedValue(new InvalidPackageError(['manifest.version required']));

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/install')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(['manifest.version required']);
    });
  });

  describe('POST /packages/:name/uninstall', () => {
    it('returns the uninstall result on success', async () => {
      uninstallFlow.uninstall.mockResolvedValue({
        ok: true,
        packageName: 'sample-plugin',
        removedFiles: 4,
        preservedData: [],
      });

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/uninstall')
        .send({ purge: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.removedFiles).toBe(4);
      expect(uninstallFlow.uninstall.mock.calls[0][0]).toEqual({
        name: 'sample-plugin',
        purge: true,
      });
    });

    it('returns 404 when the package is not installed', async () => {
      uninstallFlow.uninstall.mockRejectedValue(new PackageNotInstalledError('missing-pkg'));

      const res = await request(app)
        .post('/api/marketplace/packages/missing-pkg/uninstall')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing-pkg');
    });
  });

  describe('POST /packages/:name/update', () => {
    it('returns the advisory check result when apply is omitted', async () => {
      updateFlow.run.mockResolvedValue({
        checks: [
          {
            packageName: 'sample-plugin',
            installedVersion: '1.0.0',
            latestVersion: '1.1.0',
            hasUpdate: true,
            marketplace: 'dorkos-community',
          },
        ],
        applied: [],
      });

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/update')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.checks).toHaveLength(1);
      expect(res.body.checks[0].hasUpdate).toBe(true);
      expect(res.body.applied).toEqual([]);
      expect(updateFlow.run.mock.calls[0][0]).toEqual({ name: 'sample-plugin' });
    });

    it('returns the applied list when apply is true', async () => {
      updateFlow.run.mockResolvedValue({
        checks: [
          {
            packageName: 'sample-plugin',
            installedVersion: '1.0.0',
            latestVersion: '1.1.0',
            hasUpdate: true,
            marketplace: 'dorkos-community',
          },
        ],
        applied: [buildSampleInstallResult()],
      });

      const res = await request(app)
        .post('/api/marketplace/packages/sample-plugin/update')
        .send({ apply: true });

      expect(res.status).toBe(200);
      expect(res.body.applied).toHaveLength(1);
      expect(updateFlow.run.mock.calls[0][0]).toEqual({
        name: 'sample-plugin',
        apply: true,
      });
    });
  });
});
