/**
 * The ticket's "Done when" for hot reload (DOR-2696 task 3.1, spec
 * `marketplace-dev-link` §6 and Testing Strategy, Integration).
 *
 * Wires the REAL pieces: {@link ExtensionManager} (real discovery and esbuild
 * compile against a temp data directory), {@link DevLinkService},
 * {@link DevLinkWatcher} on a real chokidar watch, and Harness Sync's
 * `runAutoProjection` into a real project. Only `configManager` is held in
 * memory. What is asserted is what a person experiences: the extension's new
 * bundle, the approvals on record, the skill link in `.claude/skills`, and the
 * installed copy coming back.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';
import { initBoundary } from '../../../../lib/boundary.js';

/** The config the manager and the projection read, held in memory. */
interface StoredExtensions {
  enabled: string[];
  disabled: string[];
  approvedToRun: string[];
  approvedSources: Record<string, { path: string; plugin?: string; devLink?: string }>;
}
const stored = vi.hoisted(() => ({
  value: { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} } as StoredExtensions,
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'extensions') return stored.value;
      if (key === 'harness') return { autoSync: true };
      if (key === 'runtimes') return { default: 'claude-code' };
      return undefined;
    },
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as StoredExtensions;
    },
  },
}));

import { ExtensionManager } from '../../../extensions/extension-manager.js';
import { mayRunExtensionCode } from '../../../extensions/extension-load-policy.js';
import { runAutoProjection } from '../../../harness/auto-project.js';
import { DevLinkService } from '../dev-link-service.js';
import { devLinkExtensionsOf } from '../dev-link-extensions.js';
import { DevLinkWatcher } from '../dev-link-watcher.js';
import { memoryConsentStore } from './memory-consent-store.js';

const PLUGIN = 'flow';

/** Write a plugin folder: manifests, one extension, one skill. */
async function writePlugin(dir: string, version: string): Promise<void> {
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version, description: 'Dev link fixture' })
  );
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: PLUGIN,
      version,
      type: 'plugin',
      description: 'A plugin that carries an extension and a skill',
      author: 'DorkOS',
      license: 'MIT',
      layers: ['extensions', 'skills'],
      extensions: ['dash'],
    })
  );
  await writeExtension(dir, 'dash', version);
  await writeSkill(dir, 'first');
}

async function writeExtension(dir: string, id: string, version = '1.0.0'): Promise<void> {
  const extDir = path.join(dir, '.dork', 'extensions', id);
  await mkdir(extDir, { recursive: true });
  await writeFile(
    path.join(extDir, 'extension.json'),
    JSON.stringify({ id, name: id, version, entry: './index.ts' })
  );
  await writeFile(path.join(extDir, 'index.ts'), 'export const version = 1;\n');
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(path.join(dir, 'skills', name), { recursive: true });
  await writeFile(
    path.join(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill, for the dev link test.\n---\n\nDo the ${name} thing.\n`
  );
}

/** Every path under a folder with its size and modification time. */
async function treeOf(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const stats = await lstat(abs);
      out.set(path.relative(root, abs), `${stats.size}:${stats.mtimeMs}`);
      if (entry.isDirectory()) await walk(abs);
    }
  };
  await walk(root);
  return out;
}

/** Wait until `check` passes or the time runs out. */
async function eventually(check: () => void, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a dev link reloads when its folder changes', () => {
  let root: string;
  let dorkHome: string;
  let project: string;
  let work: string;
  let manager: ExtensionManager;
  let watcher: DevLinkWatcher;
  let service: DevLinkService;
  let announced: string[][];
  let events: DevLinkReloadedEvent[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-devlink-reload-')));
    dorkHome = path.join(root, 'dork');
    project = path.join(root, 'project');
    work = path.join(root, 'work', PLUGIN);
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    await mkdir(project, { recursive: true });
    await initBoundary(root);
    stored.value = { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} };
    announced = [];
    events = [];

    // The installed copy the dev link sets aside, approved and turned on.
    await writePlugin(path.join(project, '.dork', 'plugins', PLUGIN), '1.0.0');
    await writePlugin(work, '2.0.0');

    manager = new ExtensionManager(dorkHome);
    await manager.initialize(project);
    expect(await manager.enable('dash')).not.toBeNull();
    expect(await manager.approveToRun('dash')).not.toBeNull();

    watcher = new DevLinkWatcher({
      dorkHome,
      extensions: devLinkExtensionsOf(manager, {
        config: () => stored.value,
        announce: (ids) => announced.push(ids),
      }),
      refreshPlugins: () => undefined,
      reproject: (ctx) => runAutoProjection({ ...ctx, action: 'install' }, { dorkHome }),
      broadcast: (event) => events.push(event),
      quietMs: 150,
      rearmMs: 0,
    });
    service = new DevLinkService({
      dorkHome,
      approvals: {
        read: () => ({
          approvedToRun: [...stored.value.approvedToRun],
          approvedSources: { ...stored.value.approvedSources },
        }),
        write: (next) => {
          stored.value = { ...stored.value, ...next };
        },
      },
      consent: memoryConsentStore(),
      onPluginsChanged: (ctx) => void runAutoProjection(ctx, { dorkHome }),
      refreshExtensions: () => manager.requestRefresh(),
      boundary: () => root,
      reloads: watcher,
    });
    await watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Whether the load gate lets this extension's code run right now. */
  function runs(id: string): boolean {
    const record = manager.get(id);
    return record !== undefined && mayRunExtensionCode(record, stored.value);
  }

  it('rebuilds an edited extension on its existing yes, projects a new skill, asks about a new extension, and unlinks back', async () => {
    const installedApproval = stored.value.approvedSources.dash;
    expect(installedApproval?.devLink).toBeUndefined();

    const status = await service.link({
      path: work,
      scope: 'project',
      projectPath: project,
      replaceInstalled: true,
      via: 'app',
    });
    expect(status.state).toBe('active');
    expect(status.lastReloadAt).toBeUndefined();
    await manager.whenIdle();
    await watcher.ready();
    expect(manager.get('dash')?.devLink).toEqual({ path: work });
    expect(runs('dash')).toBe(true);
    const firstHash = manager.get('dash')?.sourceHash;
    expect(firstHash).toBeTruthy();
    const approvalsAfterLink = structuredClone(stored.value);
    // The link's own projection put the first skill in place.
    await eventually(() =>
      expect(existsSync(path.join(project, '.claude', 'skills', `${PLUGIN}__first`))).toBe(true)
    );

    // 1. Edit the extension's source: it rebuilds, with nothing to approve.
    const before = await treeOf(work);
    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const version = 2;\n'
    );
    await eventually(() => expect(announced).toContainEqual(['dash']));
    expect(manager.get('dash')?.sourceHash).toBeTruthy();
    expect(manager.get('dash')?.sourceHash).not.toBe(firstHash);
    expect(runs('dash')).toBe(true);
    expect(stored.value).toEqual(approvalsAfterLink);
    await eventually(() => expect(events.length).toBeGreaterThan(0));
    expect(events.at(-1)).toMatchObject({
      name: PLUGIN,
      scope: 'project',
      projectPath: project,
      actions: ['extension'],
    });
    expect((await service.list()).links[0]?.lastReloadAt).toBe(events.at(-1)?.at);

    // The reload wrote nothing in the folder (only the edit changed), so it
    // cannot set itself off: no further reload follows.
    const after = await treeOf(work);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...after].filter(([rel, sig]) => before.get(rel) !== sig).map(([rel]) => rel);
    const editedPaths = [
      path.join('.dork', 'extensions', 'dash'),
      path.join('.dork', 'extensions', 'dash', 'index.ts'),
    ];
    for (const rel of changed) expect(editedPaths).toContain(rel);
    expect(changed).toContain(path.join('.dork', 'extensions', 'dash', 'index.ts'));
    const settledCount = announced.length;
    const settledEvents = events.length;
    await sleep(1_000);
    expect(announced).toHaveLength(settledCount);
    expect(events).toHaveLength(settledEvents);

    // 2. Add a skill: it reaches Claude Code's skills folder in the project.
    await writeSkill(work, 'second');
    await eventually(() =>
      expect(existsSync(path.join(project, '.claude', 'skills', `${PLUGIN}__second`))).toBe(true)
    );

    // 3. Add an extension: it is discovered, and waits for a person.
    await writeExtension(work, 'sneaky');
    await eventually(() => expect(manager.get('sneaky')?.devLink).toEqual({ path: work }));
    await watcher.flush();
    expect(runs('sneaky')).toBe(false);
    expect(stored.value.approvedToRun).not.toContain('sneaky');
    expect(stored.value.approvedSources.sneaky).toBeUndefined();
    expect(announced.flat()).not.toContain('sneaky');

    // 4. Unlink: the installed copy is back, with its own approval.
    expect(await service.unlink({ name: PLUGIN, scope: 'project', projectPath: project })).toEqual({
      restored: 'installed',
    });
    await manager.whenIdle();
    expect(stored.value.approvedSources.dash).toEqual(installedApproval);
    expect(manager.get('dash')?.devLink).toBeUndefined();
    expect(runs('dash')).toBe(true);
    expect(watcher.watchedFolders()).toEqual([]);

    // And the folder no longer reloads anything.
    const announcedAtUnlink = announced.length;
    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const version = 3;\n'
    );
    await sleep(800);
    expect(announced).toHaveLength(announcedAtUnlink);
  }, 60_000);
});
