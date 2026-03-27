import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';

/**
 * Creates a temporary directory tree for extension discovery tests.
 * Returns the base temp dir path for cleanup.
 */
async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ext-discovery-'));
}

/** Write a valid extension manifest to the given directory. */
async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest));
}

describe('ExtensionDiscovery', () => {
  let tmpDir: string;
  let dorkHome: string;
  let discovery: ExtensionDiscovery;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    dorkHome = path.join(tmpDir, '.dork');
    await fs.mkdir(path.join(dorkHome, 'extensions'), { recursive: true });
    discovery = new ExtensionDiscovery(dorkHome);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no extensions exist', async () => {
    const results = await discovery.discover(null, []);

    expect(results).toEqual([]);
  });

  it('discovers a valid global extension', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'github-prs'), {
      id: 'github-prs',
      name: 'GitHub PR Dashboard',
      version: '1.0.0',
      description: 'Shows pending PR reviews',
    });

    const results = await discovery.discover(null, []);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'github-prs',
      scope: 'global',
      status: 'disabled',
      manifest: {
        id: 'github-prs',
        name: 'GitHub PR Dashboard',
        version: '1.0.0',
      },
      bundleReady: false,
    });
  });

  it('discovers a valid local extension', async () => {
    const cwd = path.join(tmpDir, 'my-project');
    const localExtDir = path.join(cwd, '.dork', 'extensions', 'local-tool');
    await writeManifest(localExtDir, {
      id: 'local-tool',
      name: 'Local Tool',
      version: '0.1.0',
    });

    const results = await discovery.discover(cwd, []);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'local-tool',
      scope: 'local',
      status: 'disabled',
    });
  });

  it('local extension overrides global when IDs match', async () => {
    // Global version
    await writeManifest(path.join(dorkHome, 'extensions', 'my-ext'), {
      id: 'my-ext',
      name: 'Global Version',
      version: '1.0.0',
    });

    // Local version (same ID, different name)
    const cwd = path.join(tmpDir, 'project');
    await writeManifest(path.join(cwd, '.dork', 'extensions', 'my-ext'), {
      id: 'my-ext',
      name: 'Local Version',
      version: '2.0.0',
    });

    const results = await discovery.discover(cwd, []);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'my-ext',
      scope: 'local',
      manifest: { name: 'Local Version', version: '2.0.0' },
    });
  });

  it('produces status "invalid" for manifest with missing required fields', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'bad-ext'), {
      name: 'Missing ID and Version',
    });

    const results = await discovery.discover(null, []);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'bad-ext',
      status: 'invalid',
      error: {
        code: 'invalid_manifest',
        message: 'Manifest validation failed',
      },
    });
    expect(results[0].error?.details).toBeDefined();
  });

  it('produces status "invalid" for directory without extension.json', async () => {
    // Create a directory with no manifest file
    await fs.mkdir(path.join(dorkHome, 'extensions', 'no-manifest'), {
      recursive: true,
    });

    const results = await discovery.discover(null, []);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'no-manifest',
      status: 'invalid',
      error: {
        code: 'manifest_read_error',
      },
    });
  });

  it('produces status "incompatible" when minHostVersion exceeds host version', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'future-ext'), {
      id: 'future-ext',
      name: 'Future Extension',
      version: '1.0.0',
      minHostVersion: '99.0.0',
    });

    const results = await discovery.discover(null, ['future-ext']);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'future-ext',
      status: 'incompatible',
    });
  });

  it('produces status "enabled" when extension ID is in enabledIds', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'enabled-ext'), {
      id: 'enabled-ext',
      name: 'Enabled Extension',
      version: '1.0.0',
    });

    const results = await discovery.discover(null, ['enabled-ext']);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'enabled-ext',
      status: 'enabled',
    });
  });

  it('produces status "disabled" when extension ID is not in enabledIds', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'some-ext'), {
      id: 'some-ext',
      name: 'Some Extension',
      version: '1.0.0',
    });

    const results = await discovery.discover(null, ['other-ext']);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'some-ext',
      status: 'disabled',
    });
  });

  it('returns empty array when scanning a non-existent directory', async () => {
    const nonExistentHome = path.join(tmpDir, 'does-not-exist');
    const disc = new ExtensionDiscovery(nonExistentHome);

    const results = await disc.discover(null, []);

    expect(results).toEqual([]);
  });

  it('skips non-directory entries in the extensions folder', async () => {
    // Create a regular file (not a directory) in the extensions folder
    await fs.writeFile(path.join(dorkHome, 'extensions', 'readme.txt'), 'not a directory');

    // Also add a valid extension to ensure it's still found
    await writeManifest(path.join(dorkHome, 'extensions', 'real-ext'), {
      id: 'real-ext',
      name: 'Real Extension',
      version: '1.0.0',
    });

    const results = await discovery.discover(null, []);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('real-ext');
  });
});
