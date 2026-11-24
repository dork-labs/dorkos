import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { EMPTY_CONFIG, EMPTY_CORE, coreMap, writeManifest, makeDiscoveryHome } from './fixtures.js';
import type { HostVersion } from '../../extension-host-version.js';
import { mayRunExtensionCode } from '../../extension-load-policy.js';
import { logger } from '../../../../lib/logger.js';
import { RESERVED_APP_NAME_CODE, RESERVED_APP_NAME_MESSAGE } from '@dorkos/extension-api';

describe('ExtensionDiscovery', () => {
  let tmpDir: string;
  let dorkHome: string;
  let discovery: ExtensionDiscovery;

  beforeEach(async () => {
    ({ tmpDir, dorkHome, discovery } = await makeDiscoveryHome());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('local extension overrides global when IDs match', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'my-ext'), {
      id: 'my-ext',
      name: 'Global Version',
      version: '1.0.0',
    });
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
      status: 'disabled',
      bundleReady: false,
      manifest: { name: 'Local Version', version: '2.0.0' },
    });
  });

  it.each([
    ['a manifest missing required fields', { name: 'No id' }, 'invalid_manifest'],
    ['a folder with no extension.json', null, 'manifest_read_error'],
  ])('marks %s invalid', async (_label, manifest, code) => {
    const dir = path.join(dorkHome, 'extensions', 'bad-ext');
    if (manifest) await writeManifest(dir, manifest);
    else await fs.mkdir(dir, { recursive: true });

    const results = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'bad-ext', status: 'invalid', error: { code } });
  });

  it.each([
    ['needs a newer DorkOS', { version: '0.88.0', isDevBuild: false }, '0.89.0', 'incompatible'],
    [
      'needs exactly the running version',
      { version: '0.88.0', isDevBuild: false },
      '0.88.0',
      'enabled',
    ],
    ['runs on a development build', { version: '0.0.0', isDevBuild: true }, '99.0.0', 'enabled'],
  ] as const)('minHostVersion: an enabled app that %s is %s', async (_l, host, min, status) => {
    await writeManifest(path.join(dorkHome, 'extensions', 'versioned-ext'), {
      id: 'versioned-ext',
      name: 'Versioned Extension',
      version: '1.0.0',
      minHostVersion: min,
    });
    const results = await new ExtensionDiscovery(dorkHome, host as HostVersion).discover(
      null,
      { enabled: ['versioned-ext'], disabled: [], approvedToRun: [] },
      EMPTY_CORE
    );
    expect(results[0].status).toBe(status);
  });

  it.each([
    ['server.ts', {}, ['server.ts']],
    ['server.js', {}, ['server.js']],
    [
      'a custom serverEntry',
      { serverCapabilities: { serverEntry: './src/server.ts' } },
      ['src', 'server.ts'],
    ],
  ])('finds the server entry at %s', async (_label, extra, entry) => {
    const extDir = path.join(dorkHome, 'extensions', 'with-server');
    await writeManifest(extDir, { id: 'with-server', name: 'S', version: '1.0.0', ...extra });
    await fs.mkdir(path.join(extDir, ...entry.slice(0, -1)), { recursive: true });
    await fs.writeFile(path.join(extDir, ...entry), 'export default () => {}');

    const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(record).toMatchObject({ hasServerEntry: true, hasDataProxy: false });
    expect(record.serverEntryPath).toBe(path.join(extDir, ...entry));
  });

  it('reports a data proxy, and no server entry when there is no server file', async () => {
    await writeManifest(path.join(dorkHome, 'extensions', 'proxy-ext'), {
      id: 'proxy-ext',
      name: 'Proxy Extension',
      version: '1.0.0',
      dataProxy: { baseUrl: 'https://api.example.com', authSecret: 'api_key' },
    });

    const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    expect(record).toMatchObject({ hasServerEntry: false, hasDataProxy: true });
    expect(record.serverEntryPath).toBeUndefined();
  });

  describe('names that are DorkOS’s own (DOR-4282)', () => {
    it.each([['DorkOS Helper'], ['Dork​OS'], ['DоrkOS'], ['Settings'], ['settings ']])(
      'does not load an app named %j, and says why',
      async (name) => {
        await writeManifest(path.join(dorkHome, 'extensions', 'lookalike'), {
          id: 'lookalike',
          name,
          version: '1.0.0',
        });

        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

        expect(record).toMatchObject({
          id: 'lookalike',
          origin: 'user',
          status: 'invalid',
          error: { code: RESERVED_APP_NAME_CODE, message: RESERVED_APP_NAME_MESSAGE },
        });
      }
    );

    it('lets DorkOS’s own staged app carry its name', async () => {
      await writeManifest(path.join(dorkHome, 'extensions', 'marketplace'), {
        id: 'marketplace',
        name: 'DorkOS Marketplace',
        version: '1.0.0',
      });

      const core = coreMap({ id: 'marketplace', defaultEnabled: true, canDisable: true });
      const [record] = await discovery.discover(null, EMPTY_CONFIG, core);

      expect(record).toMatchObject({ id: 'marketplace', origin: 'core', status: 'enabled' });
    });
  });

  describe('tier-aware status and origin', () => {
    it.each([
      [true, EMPTY_CONFIG, 'enabled'],
      [true, { enabled: [], disabled: ['core-ext'], approvedToRun: [] }, 'disabled'],
      [false, EMPTY_CONFIG, 'disabled'],
      [false, { enabled: ['core-ext'], disabled: [], approvedToRun: [] }, 'enabled'],
    ])(
      'a core extension with defaultEnabled %s and config %j is %s',
      async (on, config, status) => {
        await writeManifest(path.join(dorkHome, 'extensions', 'core-ext'), {
          id: 'core-ext',
          name: 'Core Ext',
          version: '1.0.0',
        });

        const core = coreMap({ id: 'core-ext', defaultEnabled: on, canDisable: true });
        const results = await discovery.discover(null, config, core);

        expect(results[0]).toMatchObject({ id: 'core-ext', origin: 'core', status });
      }
    );

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
});
