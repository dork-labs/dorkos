import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import type { HostVersion } from '../extension-host-version.js';
import { approvedSourceOf, mayRunExtensionCode } from '../extension-load-policy.js';
import {
  inspectCopy,
  readTrustedInstalls,
  trustedOriginOf,
  type TrustedInstalls,
} from '../extension-trusted-origin.js';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';
import { recordProjectInstall } from '../../marketplace/lib/project-install-index.js';
import { normalizeTrustedSource } from '../../marketplace/lib/trusted-source.js';
import type { CoreExtensionInfo, ExtensionsConfig } from '../extension-enable-resolution.js';
import { logger } from '../../../lib/logger.js';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';

/** No user overrides. */
const EMPTY_CONFIG: ExtensionsConfig = { enabled: [], disabled: [], approvedToRun: [] };
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

/** The whole-folder digest the installer records, as a string. */
async function digestOf(root: string): Promise<string> {
  const found = await installFolderDigest(root);
  if (found.kind !== 'digest') throw new Error(`no digest for ${root}: ${found.kind}`);
  return found.digest;
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
    vi.restoreAllMocks();
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

  describe('minHostVersion', () => {
    /** A released host at 0.88.0, the version the Flow extension asks for. */
    const RELEASED: HostVersion = { version: '0.88.0', isDevBuild: false };
    const ENABLED = (id: string): ExtensionsConfig => ({
      enabled: [id],
      disabled: [],
      approvedToRun: [],
    });

    async function statusOn(host: HostVersion, minHostVersion?: string): Promise<string> {
      await writeManifest(path.join(dorkHome, 'extensions', 'versioned-ext'), {
        id: 'versioned-ext',
        name: 'Versioned Extension',
        version: '1.0.0',
        ...(minHostVersion ? { minHostVersion } : {}),
      });
      const results = await new ExtensionDiscovery(dorkHome, host).discover(
        null,
        ENABLED('versioned-ext'),
        EMPTY_CORE
      );
      expect(results).toHaveLength(1);
      return results[0].status;
    }

    it('marks an extension incompatible when it needs a newer DorkOS', async () => {
      expect(await statusOn(RELEASED, '0.89.0')).toBe('incompatible');
    });

    it('loads an extension that needs exactly the running version', async () => {
      expect(await statusOn(RELEASED, '0.88.0')).toBe('enabled');
    });

    it('loads an extension that needs an older version than the running one', async () => {
      expect(await statusOn(RELEASED, '0.2.0')).toBe('enabled');
    });

    it('loads any extension on a development build', async () => {
      expect(await statusOn({ version: '0.0.0', isDevBuild: true }, '99.0.0')).toBe('enabled');
    });

    it('loads an extension with no minHostVersion', async () => {
      expect(await statusOn(RELEASED)).toBe('enabled');
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
      { enabled: ['enabled-ext'], disabled: [], approvedToRun: [] },
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
      { enabled: ['other-ext'], disabled: [], approvedToRun: [] },
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
        { enabled: [], disabled: ['marketplace'], approvedToRun: [] },
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
        { enabled: ['hello-world'], disabled: [], approvedToRun: [] },
        core
      );

      expect(results[0]).toMatchObject({ id: 'hello-world', origin: 'core', status: 'enabled' });
    });

    /**
     * `origin: 'core'` short-circuits the load approval entirely
     * (`extension-load-policy.ts`), so anything that can obtain that label runs
     * unasked. These are the ways a directory tried to obtain it by reusing a
     * bundled id, each reproduced as the attack rather than as the fix (DOR-516).
     */
    describe('reusing a core id does not make a directory core', () => {
      it('refuses core to a directory that claims a bundled id from its manifest', async () => {
        // A directory named something else, whose manifest claims a core id. Its
        // path is still UNDER the staging directory, so an origin check that asked
        // "does this path start with the staging dir?" would hand it the exemption.
        // Only "is this the staged copy of THIS id?" refuses it.
        await writeManifest(path.join(dorkHome, 'extensions', 'not-really'), {
          id: 'marketplace',
          name: 'Marketplace',
          version: '9.9.9',
        });

        const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
        const results = await discovery.discover(null, EMPTY_CONFIG, core);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          id: 'marketplace',
          origin: 'user',
          path: path.join(dorkHome, 'extensions', 'not-really'),
        });
        // And the load policy therefore asks about it, with an empty approval list.
        expect(mayRunExtensionCode(results[0], { approvedToRun: [] })).toBe(false);
      });

      it('refuses core to a SYMLINK at the staged path, on a reload with no restage', async () => {
        // The path comparison is lexical, and `scanDirectory` admits symlink
        // entries, so a link at `{dorkHome}/extensions/marketplace` matches the
        // staged path exactly while its contents live elsewhere.
        //
        // `ensureCoreExtensions` deletes such a link before staging, but that runs
        // once at boot. `ExtensionManager.reload()` calls exactly the `discover()`
        // below with NO re-staging, and it is reachable from `POST
        // /api/extensions/reload` and the `reload_extensions` tool — so this is the
        // window the boot-time repair does not cover.
        const staged = path.join(dorkHome, 'extensions', 'marketplace');
        await writeManifest(staged, { id: 'marketplace', name: 'Marketplace', version: '1.0.0' });
        const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });

        // Boot: the real staged copy is core, as it should be.
        const atBoot = await discovery.discover(null, EMPTY_CONFIG, core);
        expect(atBoot[0]).toMatchObject({ id: 'marketplace', origin: 'core' });

        // After boot, with a shell: swap the staged directory for a link to a
        // directory the attacker controls, carrying the same id.
        const attacker = path.join(tmpDir, 'attacker');
        await writeManifest(attacker, { id: 'marketplace', name: 'Marketplace', version: '1.0.0' });
        await fs.writeFile(path.join(attacker, 'server.ts'), 'PLANTED();\n', 'utf-8');
        await fs.rm(staged, { recursive: true, force: true });
        await fs.symlink(attacker, staged, 'dir');

        // Reload: same call, no restaging.
        const afterReload = await discovery.discover(null, EMPTY_CONFIG, core);

        expect(afterReload).toHaveLength(1);
        expect(afterReload[0]).toMatchObject({ id: 'marketplace', origin: 'user' });
        // So the planted `server.ts` is asked about instead of being run as DorkOS.
        expect(afterReload[0].hasServerEntry).toBe(true);
        expect(mayRunExtensionCode(afterReload[0], { approvedToRun: [] })).toBe(false);
      });

      it('ignores a project-tree copy of a core id and keeps the staged one', async () => {
        // The reproduction that started this: an agent in `acceptEdits` writes a
        // project file, no shell and no `~/.dork` access needed. `marketplace` is
        // `defaultEnabled`, so it is enabled at boot and its server entry is
        // initialized — as core, unasked, before the fix.
        await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
          id: 'marketplace',
          name: 'Marketplace',
          version: '1.0.0',
        });
        const cwd = path.join(tmpDir, 'project');
        const planted = path.join(cwd, '.dork', 'extensions', 'marketplace');
        await writeManifest(planted, { id: 'marketplace', name: 'Marketplace', version: '1.0.0' });
        await fs.writeFile(path.join(planted, 'server.ts'), 'PLANTED();\n', 'utf-8');

        const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
        const results = await discovery.discover(cwd, EMPTY_CONFIG, core);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          id: 'marketplace',
          scope: 'global',
          origin: 'core',
          path: path.join(dorkHome, 'extensions', 'marketplace'),
        });
        // The planted server entry is not what anything is about to run.
        expect(results[0].hasServerEntry).toBe(false);
      });

      it('gives origin "user" to a project-tree copy of a core id with nothing staged', async () => {
        // The same plant on a machine where the staged copy is missing. The record
        // survives the merge (there is nothing to keep instead), so the path check
        // is the only thing standing between it and the core exemption.
        const cwd = path.join(tmpDir, 'project');
        await writeManifest(path.join(cwd, '.dork', 'extensions', 'hello-world'), {
          id: 'hello-world',
          name: 'Hello World',
          version: '1.0.0',
        });

        const core = coreMap({ id: 'hello-world', defaultEnabled: true, canDisable: true });
        const results = await discovery.discover(cwd, { ...EMPTY_CONFIG }, core);

        expect(results).toHaveLength(0);
      });

      it('ignores a project-tree copy of an id the person already approved', async () => {
        // An approval is keyed to the id, so a project directory that reuses the id
        // of an approved extension would inherit the decision. Same adversary, same
        // no-prompt write, one step further along.
        await writeManifest(path.join(dorkHome, 'extensions', 'my-tool'), {
          id: 'my-tool',
          name: 'My Tool',
          version: '1.0.0',
        });
        const cwd = path.join(tmpDir, 'project');
        const planted = path.join(cwd, '.dork', 'extensions', 'my-tool');
        await writeManifest(planted, { id: 'my-tool', name: 'My Tool', version: '2.0.0' });
        await fs.writeFile(path.join(planted, 'server.ts'), 'PLANTED();\n', 'utf-8');

        const results = await discovery.discover(
          cwd,
          { enabled: ['my-tool'], disabled: [], approvedToRun: ['my-tool'] },
          EMPTY_CORE
        );

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          scope: 'global',
          path: path.join(dorkHome, 'extensions', 'my-tool'),
          manifest: { version: '1.0.0' },
        });
      });

      it('still lets a project copy override an ordinary global extension', async () => {
        // The local scope is not being taken away. Only an id whose standing is
        // already spoken for is off limits.
        await writeManifest(path.join(dorkHome, 'extensions', 'my-tool'), {
          id: 'my-tool',
          name: 'My Tool',
          version: '1.0.0',
        });
        const cwd = path.join(tmpDir, 'project');
        await writeManifest(path.join(cwd, '.dork', 'extensions', 'my-tool'), {
          id: 'my-tool',
          name: 'My Tool',
          version: '2.0.0',
        });

        const results = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ scope: 'local', manifest: { version: '2.0.0' } });
      });
    });

    it('derives origin "user" for extensions absent from the core map', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'user-ext'), {
        id: 'user-ext',
        name: 'User Extension',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
      const results = await discovery.discover(
        null,
        { enabled: ['user-ext'], disabled: [], approvedToRun: [] },
        core
      );

      expect(results[0]).toMatchObject({ id: 'user-ext', origin: 'user', status: 'enabled' });
    });
  });

  /**
   * The working directory is `$HOME` for a Finder-launched Mac app and for
   * `dorkos` started from `~`, which makes `{cwd}/.dork/extensions` the very
   * directory `{dorkHome}/extensions` names. Every installed extension was then
   * re-found as a "project copy" of itself and warned about (DOR-1336 / F10).
   */
  describe('when the project directory holds the DorkOS home itself', () => {
    it('finds each extension once, keeps it global and core, and warns about nothing', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });

      // `dorkHome` is `{tmpDir}/.dork`, so a cwd of `{tmpDir}` makes the local
      // extensions directory the global one.
      const results = await discovery.discover(tmpDir, EMPTY_CONFIG, core);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'marketplace',
        scope: 'global',
        origin: 'core',
        status: 'enabled',
        path: path.join(dorkHome, 'extensions', 'marketplace'),
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps an ordinary extension global rather than re-scoping it as local', async () => {
      // No core membership and no approval, so nothing warns either way — the
      // question here is only whether the same directory was listed twice.
      await writeManifest(path.join(dorkHome, 'extensions', 'my-tool'), {
        id: 'my-tool',
        name: 'My Tool',
        version: '1.0.0',
      });

      const results = await discovery.discover(tmpDir, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'my-tool', scope: 'global', origin: 'user' });
    });

    it('recognizes the global directory through a symlinked project .dork', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });
      const cwd = path.join(tmpDir, 'home-alias');
      await fs.mkdir(cwd, { recursive: true });
      await fs.symlink(dorkHome, path.join(cwd, '.dork'), 'dir');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });

      const results = await discovery.discover(cwd, EMPTY_CONFIG, core);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'marketplace', scope: 'global', origin: 'core' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('still ignores a project copy of a core id in a genuinely different directory', async () => {
      // The DOR-511 protection is not what is being relaxed: a project tree that
      // is NOT the DorkOS home still cannot take over a bundled id.
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });
      const cwd = path.join(tmpDir, 'project');
      const planted = path.join(cwd, '.dork', 'extensions', 'marketplace');
      await writeManifest(planted, { id: 'marketplace', name: 'Marketplace', version: '9.9.9' });
      await fs.writeFile(path.join(planted, 'server.ts'), 'PLANTED();\n', 'utf-8');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });

      const results = await discovery.discover(cwd, EMPTY_CONFIG, core);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'marketplace',
        scope: 'global',
        origin: 'core',
        path: path.join(dorkHome, 'extensions', 'marketplace'),
      });
      expect(results[0].hasServerEntry).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring the project copy of 'marketplace'")
      );
    });
  });

  describe('extensions carried inside an installed plugin (DOR-2383)', () => {
    /** Write `<pluginsRoot>/<plugin>/.dork/extensions/<id>/extension.json`. */
    async function writeCarried(
      pluginsRoot: string,
      plugin: string,
      id: string,
      version = '1.0.0'
    ): Promise<string> {
      const dir = path.join(pluginsRoot, plugin, '.dork', 'extensions', id);
      await writeManifest(dir, { id, name: id, version });
      return dir;
    }

    it('finds an extension a globally installed plugin carries, and names the plugin', async () => {
      const dir = await writeCarried(path.join(dorkHome, 'plugins'), 'flow', 'flow');

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'flow',
        scope: 'global',
        origin: 'user',
        path: dir,
        sourcePlugin: 'flow',
        // Off until a person turns it on, like every marketplace extension.
        status: 'disabled',
      });
    });

    it('finds an extension a plugin installed into the project carries', async () => {
      const cwd = path.join(tmpDir, 'project');
      const dir = await writeCarried(path.join(cwd, '.dork', 'plugins'), 'flow', 'flow');

      const results = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'flow',
        scope: 'local',
        origin: 'user',
        path: dir,
        sourcePlugin: 'flow',
      });
    });

    it('skips the install engine siblings beside a plugin, such as a backup', async () => {
      const plugins = path.join(dorkHome, 'plugins');
      const dir = await writeCarried(plugins, 'flow', 'flow');
      await writeCarried(plugins, `flow${MARKETPLACE_BACKUP_DIR_MARKER}20260926-abc`, 'flow');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ path: dir, sourcePlugin: 'flow' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('scans the plugins directory once when the project holds the DorkOS home', async () => {
      await writeCarried(path.join(dorkHome, 'plugins'), 'flow', 'flow');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const results = await discovery.discover(tmpDir, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ scope: 'global', sourcePlugin: 'flow' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('lets an extension installed directly win over a plugin copy of the same id', async () => {
      const direct = path.join(dorkHome, 'extensions', 'flow');
      await writeManifest(direct, { id: 'flow', name: 'Flow', version: '1.0.0' });
      await writeCarried(path.join(dorkHome, 'plugins'), 'flow', 'flow', '2.0.0');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ path: direct, manifest: { version: '1.0.0' } });
      expect(results[0].sourcePlugin).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring the copy of 'flow'"));
    });

    it('never lets a plugin copy take a core id', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'Marketplace',
        version: '1.0.0',
      });
      await writeCarried(path.join(dorkHome, 'plugins'), 'aaa', 'marketplace');
      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });

      const results = await discovery.discover(null, EMPTY_CONFIG, core);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        origin: 'core',
        path: path.join(dorkHome, 'extensions', 'marketplace'),
      });
    });

    it('resolves an id two plugins carry by sorted plugin name, with one warning', async () => {
      const plugins = path.join(dorkHome, 'plugins');
      await writeCarried(plugins, 'zeta', 'shared-ext', '2.0.0');
      const first = await writeCarried(plugins, 'alpha', 'shared-ext', '1.0.0');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ path: first, sourcePlugin: 'alpha' });
      const duplicateWarnings = warn.mock.calls.filter(([msg]) =>
        String(msg).includes("More than one installed plugin carries 'shared-ext'")
      );
      expect(duplicateWarnings).toHaveLength(1);
      expect(String(duplicateWarnings[0][0])).toContain('alpha, zeta');
    });

    it('keeps the copy a person approved when another plugin carries the same id', async () => {
      // `aaa-other` sorts first, so name order alone would hand it the id — and,
      // before approvals named their copy, the approval given to `flow` with it.
      const plugins = path.join(dorkHome, 'plugins');
      await writeCarried(plugins, 'aaa-other', 'flow');
      const approvedDir = await writeCarried(plugins, 'flow', 'flow');

      const results = await discovery.discover(
        null,
        {
          ...EMPTY_CONFIG,
          approvedToRun: ['flow'],
          approvedSources: { flow: { path: approvedDir, plugin: 'flow' } },
        },
        EMPTY_CORE
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ path: approvedDir, sourcePlugin: 'flow' });
    });

    it('ignores a project plugin copy of a core id', async () => {
      const cwd = path.join(tmpDir, 'project');
      await writeCarried(path.join(cwd, '.dork', 'plugins'), 'evil', 'hello-world');
      const core = coreMap({ id: 'hello-world', defaultEnabled: true, canDisable: true });

      const results = await discovery.discover(cwd, EMPTY_CONFIG, core);

      expect(results).toHaveLength(0);
    });

    it('ignores a project plugin copy of an id approved for another copy', async () => {
      // The approved copy is not on disk right now (its project is not open), so
      // nothing ahead of the project plugin holds the id. It still may not take it.
      const cwd = path.join(tmpDir, 'project');
      await writeCarried(path.join(cwd, '.dork', 'plugins'), 'evil', 'flow');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const results = await discovery.discover(
        cwd,
        {
          ...EMPTY_CONFIG,
          approvedToRun: ['flow'],
          approvedSources: {
            flow: { path: path.join(tmpDir, 'other', '.dork', 'plugins', 'flow'), plugin: 'flow' },
          },
        },
        EMPTY_CORE
      );

      expect(results).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring the project plugin copy of 'flow'")
      );
    });

    it('lets a project plugin copy stand when it is the copy a person approved', async () => {
      const cwd = path.join(tmpDir, 'project');
      const dir = await writeCarried(path.join(cwd, '.dork', 'plugins'), 'flow', 'flow');

      const results = await discovery.discover(
        cwd,
        {
          ...EMPTY_CONFIG,
          approvedToRun: ['flow'],
          approvedSources: { flow: { path: dir, plugin: 'flow' } },
        },
        EMPTY_CORE
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ path: dir, scope: 'local', sourcePlugin: 'flow' });
    });
  });

  describe('every known project, and copies from one trusted source (spec flow-multiproject §9)', () => {
    const SOURCE = 'dork-labs/marketplace';
    const ORIGIN = { plugin: 'flow', source: SOURCE };

    /** Write a plugin-carried copy under `pluginsRoot` and return its folder. */
    async function carried(
      pluginsRoot: string,
      version: string,
      { plugin = 'flow', id = 'flow' }: { plugin?: string; id?: string } = {}
    ): Promise<string> {
      const dir = path.join(pluginsRoot, plugin, '.dork', 'extensions', id);
      await writeManifest(dir, { id, name: 'Flow', version });
      return dir;
    }

    /** A project folder with `flow` installed at `version`, recorded by the installer. */
    async function installedProject(
      name: string,
      version: string,
      source: string | null = 'https://github.com/Dork-Labs/marketplace.git'
    ): Promise<{ root: string; dir: string }> {
      const root = path.join(tmpDir, name);
      const dir = await carried(path.join(root, '.dork', 'plugins'), version);
      const normalized = normalizeTrustedSource(source);
      const installRoot = path.join(root, '.dork', 'plugins', 'flow');
      await recordProjectInstall(dorkHome, {
        projectPath: root,
        installRoot,
        name: 'flow',
        ...(normalized ? { source: normalized } : {}),
        // What the installer records: each carried folder's digest.
        installDigest: await digestOf(installRoot),
      });
      return { root, dir };
    }

    /** A global plugin with its own install sidecar. */
    async function globalPlugin(
      version: string,
      sidecar: Record<string, unknown>,
      plugin = 'flow'
    ): Promise<string> {
      const dir = await carried(path.join(dorkHome, 'plugins'), version, { plugin });
      await fs.writeFile(
        path.join(dorkHome, 'plugins', plugin, '.dork', 'install-metadata.json'),
        JSON.stringify({
          name: plugin,
          version,
          type: 'plugin',
          installedAt: '2026-09-29T00:00:00.000Z',
          // Fetched at the default branch unless a test says otherwise.
          sourceKey: {
            cloneUrl: 'https://github.com/dork-labs/marketplace',
            subpath: '',
            ref: 'HEAD',
          },
          ...sidecar,
        })
      );
      return dir;
    }

    /** Approve `copy` the way `approveToRun` records it, origin included. */
    function approve(copy: {
      path: string;
      sourcePlugin?: string;
      trustedOrigin?: { plugin: string; source: string };
    }): ExtensionsConfig {
      return {
        enabled: ['flow'],
        disabled: [],
        approvedToRun: ['flow'],
        approvedSources: {
          flow: {
            path: copy.path,
            ...(copy.sourcePlugin ? { plugin: copy.sourcePlugin } : {}),
            ...(copy.trustedOrigin ? { origin: copy.trustedOrigin } : {}),
          },
        },
      };
    }

    beforeEach(() => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    });

    describe('trustedOriginOf', () => {
      const none: TrustedInstalls = { global: [], project: [] };

      it('reads a global plugin from its own sidecar, https and ssh alike', async () => {
        await globalPlugin('1.0.0', { sourceRepo: 'git@github.com:Dork-Labs/Marketplace.git' });
        const installs = await readTrustedInstalls(dorkHome);
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

        expect(trustedOriginOf(record!, installs, await inspectCopy(record!))).toEqual(ORIGIN);
        expect(record!.trustedOrigin).toEqual(ORIGIN);
      });

      it('gives an installedFrom-only install no trusted origin', async () => {
        await globalPlugin('1.0.0', { installedFrom: 'dork-labs' });
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

        expect(record!.trustedOrigin).toBeUndefined();
        expect(
          trustedOriginOf(record!, await readTrustedInstalls(dorkHome), await inspectCopy(record!))
        ).toBeNull();
      });

      it('trusts a project copy only through the install index', async () => {
        const recorded = await installedProject('recorded', '1.0.0');
        const recordedCopy = { path: recorded.dir, scope: 'local' as const, sourcePlugin: 'flow' };
        expect(
          trustedOriginOf(
            recordedCopy,
            await readTrustedInstalls(dorkHome),
            await inspectCopy(recordedCopy)
          )
        ).toEqual(ORIGIN);
        expect(trustedOriginOf(recordedCopy, none, await inspectCopy(recordedCopy))).toBeNull();
      });

      it('gives an unrecorded project copy none, whatever its own sidecar claims', async () => {
        const root = path.join(tmpDir, 'cloned');
        const dir = await carried(path.join(root, '.dork', 'plugins'), '9.9.9');
        await fs.writeFile(
          path.join(root, '.dork', 'plugins', 'flow', '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '9.9.9',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
          })
        );
        const copy = { path: dir, scope: 'local' as const, sourcePlugin: 'flow' };

        expect(
          trustedOriginOf(copy, await readTrustedInstalls(dorkHome), await inspectCopy(copy))
        ).toBeNull();
      });

      it('gives a record written before sources were recorded none (no backfill)', async () => {
        const { dir } = await installedProject('old', '1.0.0', null);
        const copy = { path: dir, scope: 'local' as const, sourcePlugin: 'flow' };

        expect(
          trustedOriginOf(copy, await readTrustedInstalls(dorkHome), await inspectCopy(copy))
        ).toBeNull();
      });
    });

    describe('precedence', () => {
      it('row 1: a core extension beats every project copy', async () => {
        const { root } = await installedProject('a', '5.0.0');
        const results = await discovery.discover(
          null,
          EMPTY_CONFIG,
          coreMap({ id: 'flow', defaultEnabled: true, canDisable: true }),
          [root]
        );

        expect(results.filter((r) => r.id === 'flow')).toHaveLength(0);
      });

      it('row 2: a direct copy in another known project is found, and loses to an approved one', async () => {
        const a = path.join(tmpDir, 'a');
        const b = path.join(tmpDir, 'b');
        const aDir = path.join(a, '.dork', 'extensions', 'notes');
        const bDir = path.join(b, '.dork', 'extensions', 'notes');
        await writeManifest(aDir, { id: 'notes', name: 'Notes', version: '1.0.0' });
        await writeManifest(bDir, { id: 'notes', name: 'Notes', version: '2.0.0' });

        const found = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [b, a]);
        expect(found.find((r) => r.id === 'notes')?.path).toBe(aDir);

        const approved: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          approvedToRun: ['notes'],
          approvedSources: { notes: { path: bDir } },
        };
        const withApproval = await discovery.discover(null, approved, EMPTY_CORE, [a, b]);
        expect(withApproval.find((r) => r.id === 'notes')?.path).toBe(bDir);
      });

      it('row 3: a copy approved by path wins when it is not part of the approved origin', async () => {
        const a = await installedProject('a', '1.0.0', null);
        const b = await installedProject('b', '2.0.0');

        const results = await discovery.discover(
          null,
          approve({ path: a.dir, sourcePlugin: 'flow' }),
          EMPTY_CORE,
          [a.root, b.root]
        );

        expect(results.find((r) => r.id === 'flow' && !r.shadowedBy)?.path).toBe(a.dir);
      });

      it('row 4: the newest copy of the approved origin wins, and the older reports shadowedBy', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.2.0');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);
        const running = results.filter((r) => !r.shadowedBy);
        const shadowed = results.filter((r) => r.shadowedBy);

        expect(running).toHaveLength(1);
        expect(running[0]).toMatchObject({ path: b.dir, trustedOrigin: ORIGIN });
        // No re-approval: it is the same approved source.
        expect(mayRunExtensionCode(running[0]!, config)).toBe(true);
        expect(shadowed).toEqual([expect.objectContaining({ path: a.dir, shadowedBy: b.dir })]);
      });

      it('row 4: a version tie goes to global, then the sorted project root', async () => {
        const globalDir = await globalPlugin('1.0.0', {
          sourceRepo: 'https://github.com/dork-labs/marketplace',
        });
        const z = await installedProject('z', '1.0.0');
        const config = approve({ path: z.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [z.root]);
        expect(results.find((r) => !r.shadowedBy)?.path).toBe(globalDir);

        await fs.rm(path.join(dorkHome, 'plugins'), { recursive: true });
        const y = await installedProject('y', '1.0.0');
        const again = await discovery.discover(null, config, EMPTY_CORE, [z.root, y.root]);
        expect(again.find((r) => !r.shadowedBy)?.path).toBe(y.dir);
      });

      it('row 5: with nothing approved, global before project, then the sorted root', async () => {
        const b = await installedProject('b', '3.0.0');
        const a = await installedProject('a', '1.0.0');

        const projectOnly = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [
          b.root,
          a.root,
        ]);
        expect(projectOnly.find((r) => r.id === 'flow')?.path).toBe(a.dir);
        expect(projectOnly.some((r) => r.shadowedBy)).toBe(false);

        const globalDir = await globalPlugin('0.1.0', {});
        const withGlobal = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [
          a.root,
          b.root,
        ]);
        expect(withGlobal.find((r) => r.id === 'flow')?.path).toBe(globalDir);
      });
    });

    describe('edge cases', () => {
      it('the chosen copy does not change with the working directory', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.3.0');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        for (const cwd of [a.root, b.root, null]) {
          const results = await discovery.discover(cwd, config, EMPTY_CORE, [a.root, b.root]);
          expect(results.find((r) => !r.shadowedBy)?.path).toBe(b.dir);
        }
      });

      it('a clone carrying a newer copy that claims the origin never runs unapproved', async () => {
        const a = await installedProject('a', '1.0.0');
        const cloneRoot = path.join(tmpDir, 'clone');
        const cloneDir = await carried(path.join(cloneRoot, '.dork', 'plugins'), '99.0.0');
        await fs.writeFile(
          path.join(cloneRoot, '.dork', 'plugins', 'flow', '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '99.0.0',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
          })
        );
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, cloneRoot]);
        const running = results.find((r) => !r.shadowedBy);
        expect(running?.path).toBe(a.dir);
        expect(results.some((r) => r.path === cloneDir)).toBe(false);

        // Alone, it is a row-5 candidate that must be approved by path.
        const alone = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [cloneRoot]);
        const clone = alone.find((r) => r.id === 'flow');
        expect(clone?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(clone!, config)).toBe(false);
        const trusting = { ...config, trustedSources: [{ source: SOURCE, trustedAt: 'now' }] };
        expect(mayRunExtensionCode(clone!, trusting)).toBe(false);
      });

      it('falls back to the next newest trusted copy, with no prompt, when the newest is deleted', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        const c = await installedProject('c', '1.2.0');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        await fs.rm(path.join(c.root, '.dork', 'plugins'), { recursive: true });
        const results = await discovery.discover(null, config, EMPTY_CORE, [
          a.root,
          b.root,
          c.root,
        ]);
        const running = results.find((r) => !r.shadowedBy);

        expect(running?.path).toBe(b.dir);
        expect(mayRunExtensionCode(running!, config)).toBe(true);
      });

      it('skips a known project whose folder is gone, silently', async () => {
        const a = await installedProject('a', '1.0.0');
        const gone = path.join(tmpDir, 'unplugged-drive');

        const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [gone, a.root]);

        expect(results.map((r) => r.path)).toEqual([a.dir]);
      });

      it('keeps different sources apart: approval stays bound to its own source', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '5.0.0', 'https://github.com/someone-else/flows');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => !r.shadowedBy)?.path).toBe(a.dir);
        expect(results.some((r) => r.shadowedBy)).toBe(false);
      });

      it('scans a root named twice, or naming the DorkOS home, once', async () => {
        const a = await installedProject('a', '1.0.0');
        const results = await discovery.discover(a.root, EMPTY_CONFIG, EMPTY_CORE, [
          a.root,
          `${a.root}/`,
          tmpDir,
        ]);
        expect(results.filter((r) => r.id === 'flow')).toHaveLength(1);
      });
    });

    describe('security review attacks (DOR-2527)', () => {
      it('a folder rewritten at a recorded project path never takes over the approved flow', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        // An agent, a `git pull` or a re-clone writes v99 over B's copy.
        await writeManifest(b.dir, { id: 'flow', name: 'Flow', version: '99.0.0' });
        await fs.writeFile(path.join(b.dir, 'server.ts'), 'export default () => {};\n');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);
        const running = results.find((r) => r.id === 'flow' && !r.shadowedBy);

        expect(running?.path).toBe(a.dir);
        expect(
          results.some((r) => r.path === b.dir && r.manifest.version === '99.0.0' && !r.shadowedBy)
        ).toBe(false);
      });

      it('says a recorded project copy changed since install, and gives it no origin', async () => {
        const b = await installedProject('b', '1.1.0');
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() {}\n');
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE, [b.root]);

        expect(record).toMatchObject({ path: b.dir, originProblem: 'changed' });
        expect(record?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('an edit to plugin-level code the extension imports takes the origin away (N1)', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        // Flow's extension imports `../../../../scripts/*`: outside its own folder.
        const scripts = path.join(b.root, '.dork', 'plugins', 'flow', 'scripts');
        await fs.mkdir(scripts, { recursive: true });
        await fs.writeFile(path.join(scripts, 'errors.ts'), 'export const x = 1;\n');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => r.id === 'flow' && !r.shadowedBy)?.path).toBe(a.dir);
        expect(results.some((r) => r.path === b.dir && r.trustedOrigin)).toBe(false);
      });

      it('a symbolic link anywhere in a recorded plugin folder takes the origin away (N2)', async () => {
        const b = await installedProject('b', '1.1.0');
        await fs.writeFile(path.join(tmpDir, 'evil.js'), 'export {};\n');
        await fs.symlink(path.join(tmpDir, 'evil.js'), path.join(b.dir, 'index.js'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE, [b.root]);

        expect(record?.trustedOrigin).toBeUndefined();
        expect(record?.originProblem).toBe('changed');
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('a symbolic link inside a global plugin takes the origin away and says so (N2)', async () => {
        const dir = await globalPlugin('1.0.0', {
          sourceRepo: 'https://github.com/dork-labs/marketplace',
        });
        await fs.writeFile(path.join(tmpDir, 'evil.js'), 'export {};\n');
        await fs.symlink(path.join(tmpDir, 'evil.js'), path.join(dir, 'index.js'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE);

        expect(record?.trustedOrigin).toBeUndefined();
        expect(record?.originProblem).toBe('linked');
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('a changed copy approved by path does not keep running; a yes to its files as they are does', async () => {
        const b = await installedProject('b', '1.1.0');
        const pathApproved = approve({ path: b.dir, sourcePlugin: 'flow' });
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() {}\n');

        const [changed] = await discovery.discover(null, pathApproved, EMPTY_CORE, [b.root]);
        expect(changed?.originProblem).toBe('changed');
        expect(mayRunExtensionCode(changed!, pathApproved)).toBe(false);

        // A fresh yes records the files as they are now, and pins the copy to them.
        const freshYes: ExtensionsConfig = {
          ...pathApproved,
          approvedSources: { flow: approvedSourceOf({ ...changed!, origin: 'user' }) },
        };
        expect(freshYes.approvedSources?.flow?.digest).toBe(changed?.currentDigest);
        const [again] = await discovery.discover(null, freshYes, EMPTY_CORE, [b.root]);
        expect(mayRunExtensionCode(again!, freshYes)).toBe(true);
        expect(again?.pinnedDigest).toBe(changed?.currentDigest);

        // Any further change asks again.
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() { 1; }\n');
        const [later] = await discovery.discover(null, freshYes, EMPTY_CORE, [b.root]);
        expect(mayRunExtensionCode(later!, freshYes)).toBe(false);
      });

      it('gives a symlinked global plugin no origin, whatever its linked sidecar says', async () => {
        const elsewhere = path.join(tmpDir, 'dev-checkout', 'flow');
        await writeManifest(path.join(elsewhere, '.dork', 'extensions', 'flow'), {
          id: 'flow',
          name: 'Flow',
          version: '9.0.0',
        });
        await fs.writeFile(
          path.join(elsewhere, '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '9.0.0',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
            sourceKey: {
              cloneUrl: 'https://github.com/dork-labs/marketplace',
              subpath: '',
              ref: 'HEAD',
            },
          })
        );
        await fs.mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
        await fs.symlink(elsewhere, path.join(dorkHome, 'plugins', 'flow'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE);

        expect(record?.sourcePlugin).toBe('flow');
        expect(record?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it.each([
        ['refs/pull/7/head', false],
        ['refs/remotes/origin/main', false],
        ['0123456789abcdef0123456789abcdef01234567', false],
        ['HEAD', true],
        ['main', true],
        ['refs/heads/release', true],
        ['refs/tags/v1.2.0', true],
      ])('a global install fetched at %s has a trusted origin: %s', async (ref, trusted) => {
        await globalPlugin('1.0.0', {
          sourceRepo: 'https://github.com/dork-labs/marketplace',
          sourceKey: { cloneUrl: 'https://github.com/dork-labs/marketplace', subpath: '', ref },
        });
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);
        expect(record?.trustedOrigin ?? null).toEqual(trusted ? ORIGIN : null);
      });
    });

    describe('trusted sources', () => {
      it("runs a trusted source's new extension with no approval", async () => {
        const a = await installedProject('a', '1.0.0');
        const config: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, config, EMPTY_CORE, [a.root]);

        expect(mayRunExtensionCode(record!, config)).toBe(true);
        expect(mayRunExtensionCode(record!, EMPTY_CONFIG)).toBe(false);
      });

      it('collapses copies from a trusted source to the newest', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '2.0.0');
        const config: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => !r.shadowedBy)?.path).toBe(b.dir);
        expect(results.find((r) => r.shadowedBy)?.path).toBe(a.dir);
      });
    });
  });
});
