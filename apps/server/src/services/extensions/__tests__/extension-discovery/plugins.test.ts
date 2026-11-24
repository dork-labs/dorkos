import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { EMPTY_CONFIG, EMPTY_CORE, coreMap, writeManifest, makeDiscoveryHome } from './fixtures.js';
import { logger } from '../../../../lib/logger.js';

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
});
