import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import type { CoreExtensionInfo, ExtensionsConfig } from '../extension-enable-resolution.js';

/** No user overrides. */
const EMPTY_CONFIG: ExtensionsConfig = { enabled: [], disabled: [] };
/** No core extensions (everything resolves to origin 'user'). */
const EMPTY_CORE = new Map<string, CoreExtensionInfo>();

/** Build a core-extension tier map from a list of infos. */
function coreMap(...infos: CoreExtensionInfo[]): Map<string, CoreExtensionInfo> {
  return new Map(infos.map((i) => [i.id, i]));
}

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
    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(results).toEqual([]);
  });

  it('discovers a valid global extension', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'github-prs'), {
      id: 'github-prs',
      name: 'GitHub PR Dashboard',
      version: '1.0.0',
      description: 'Shows pending PR reviews',
    });

    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

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

    const results = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);

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

    const results = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);

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

    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

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

    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

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

    const results = await discovery.discover(
      null,
      { enabled: ['future-ext'], disabled: [] },
      EMPTY_CORE
    );

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

    const results = await discovery.discover(
      null,
      { enabled: ['enabled-ext'], disabled: [] },
      EMPTY_CORE
    );

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

    const results = await discovery.discover(
      null,
      { enabled: ['other-ext'], disabled: [] },
      EMPTY_CORE
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'some-ext',
      status: 'disabled',
    });
  });

  it('returns empty array when scanning a non-existent directory', async () => {
    const nonExistentHome = path.join(tmpDir, 'does-not-exist');
    const disc = new ExtensionDiscovery(nonExistentHome);

    const results = await disc.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(results).toEqual([]);
  });

  describe('server entry detection', () => {
    it('sets hasServerEntry false when no server file exists', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'client-only');
      await writeManifest(extDir, {
        id: 'client-only',
        name: 'Client Only',
        version: '1.0.0',
      });
      await fs.writeFile(path.join(extDir, 'index.ts'), 'export default {}');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'client-only',
        hasServerEntry: false,
        hasDataProxy: false,
      });
      expect(results[0].serverEntryPath).toBeUndefined();
    });

    it('detects server.ts and sets hasServerEntry true with serverEntryPath', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'with-server');
      await writeManifest(extDir, {
        id: 'with-server',
        name: 'With Server',
        version: '1.0.0',
      });
      await fs.writeFile(path.join(extDir, 'server.ts'), 'export default () => {}');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'with-server',
        hasServerEntry: true,
      });
      expect(results[0].serverEntryPath).toBe(path.join(extDir, 'server.ts'));
    });

    it('detects server.js as fallback when server.ts is absent', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'precompiled');
      await writeManifest(extDir, {
        id: 'precompiled',
        name: 'Precompiled',
        version: '1.0.0',
      });
      await fs.writeFile(path.join(extDir, 'server.js'), 'module.exports = {}');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'precompiled',
        hasServerEntry: true,
      });
      expect(results[0].serverEntryPath).toBe(path.join(extDir, 'server.js'));
    });

    it('resolves custom serverCapabilities.serverEntry path', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'custom-entry');
      await writeManifest(extDir, {
        id: 'custom-entry',
        name: 'Custom Entry',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './src/server.ts',
        },
      });
      await fs.mkdir(path.join(extDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(extDir, 'src', 'server.ts'), 'export default () => {}');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'custom-entry',
        hasServerEntry: true,
      });
      expect(results[0].serverEntryPath).toBe(path.join(extDir, 'src', 'server.ts'));
    });

    it('sets hasDataProxy true when manifest contains dataProxy', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'proxy-ext');
      await writeManifest(extDir, {
        id: 'proxy-ext',
        name: 'Proxy Extension',
        version: '1.0.0',
        dataProxy: {
          baseUrl: 'https://api.example.com',
          authSecret: 'api_key',
        },
      });

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'proxy-ext',
        hasServerEntry: false,
        hasDataProxy: true,
      });
    });

    it('detects both server entry and dataProxy when both present', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'full-ext');
      await writeManifest(extDir, {
        id: 'full-ext',
        name: 'Full Extension',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './server.ts',
        },
        dataProxy: {
          baseUrl: 'https://api.example.com',
          authSecret: 'api_key',
        },
      });
      await fs.writeFile(path.join(extDir, 'server.ts'), 'export default () => {}');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'full-ext',
        hasServerEntry: true,
        hasDataProxy: true,
      });
      expect(results[0].serverEntryPath).toBe(path.join(extDir, 'server.ts'));
    });

    it('sets hasServerEntry false for extensions without serverCapabilities', async () => {
      const extDir = path.join(dorkHome, 'extensions', 'legacy-ext');
      await writeManifest(extDir, {
        id: 'legacy-ext',
        name: 'Legacy Extension',
        version: '1.0.0',
        description: 'No server fields',
      });

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'legacy-ext',
        hasServerEntry: false,
        hasDataProxy: false,
      });
      expect(results[0].serverEntryPath).toBeUndefined();
    });
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

    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('real-ext');
  });

  describe('tier-aware status and origin', () => {
    it('marks a default-on core extension enabled when absent from disabled', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
      const results = await discovery.discover(null, EMPTY_CONFIG, core);

      expect(results[0]).toMatchObject({ id: 'marketplace', origin: 'core', status: 'enabled' });
    });

    it('marks a default-on core extension disabled when in the disabled list', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
      const results = await discovery.discover(
        null,
        { enabled: [], disabled: ['marketplace'] },
        core
      );

      expect(results[0]).toMatchObject({ id: 'marketplace', origin: 'core', status: 'disabled' });
    });

    it('marks a default-off core extension disabled when absent from enabled', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'hello-world'), {
        id: 'hello-world',
        name: 'Hello World',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'hello-world', defaultEnabled: false, canDisable: true });
      const results = await discovery.discover(null, EMPTY_CONFIG, core);

      expect(results[0]).toMatchObject({ id: 'hello-world', origin: 'core', status: 'disabled' });
    });

    it('marks a default-off core extension enabled when opted in via enabled', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'hello-world'), {
        id: 'hello-world',
        name: 'Hello World',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'hello-world', defaultEnabled: false, canDisable: true });
      const results = await discovery.discover(
        null,
        { enabled: ['hello-world'], disabled: [] },
        core
      );

      expect(results[0]).toMatchObject({ id: 'hello-world', origin: 'core', status: 'enabled' });
    });

    it('derives origin "user" for extensions absent from the core map', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'user-ext'), {
        id: 'user-ext',
        name: 'User Extension',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
      const results = await discovery.discover(null, { enabled: ['user-ext'], disabled: [] }, core);

      expect(results[0]).toMatchObject({ id: 'user-ext', origin: 'user', status: 'enabled' });
    });
  });
});
