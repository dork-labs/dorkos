/**
 * The dev link watcher on a real folder with the real chokidar watch
 * (DOR-2696 task 3.1): ignored paths never fire, and a folder that disappears
 * and comes back is watched again by the sweep.
 *
 * Every negative assertion here is paired with a positive one on the same
 * watch, so "nothing fired" cannot pass because the watch was never live.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { DevLinkRecord, DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';
import type { DevLinkExtensions } from '../dev-link-extensions.js';
import { DevLinkWatcher, type DevLinkWatcherDeps } from '../dev-link-watcher.js';
import { updateDevLinks } from '../registry.js';

let base: string;
let home: string;
let work: string;
let watcher: DevLinkWatcher | undefined;
let events: DevLinkReloadedEvent[];
let reload: ReturnType<typeof vi.fn<DevLinkExtensions['reload']>>;
let refreshPlugins: Mock<DevLinkWatcherDeps['refreshPlugins']>;

/** Write a plugin folder carrying one extension. */
async function writePackage(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.dork', 'extensions', 'dash'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version: '1.0.0', type: 'plugin' })
  );
  await writeFile(
    path.join(dir, '.dork', 'extensions', 'dash', 'extension.json'),
    JSON.stringify({ id: 'dash', name: 'dash', version: '1.0.0' })
  );
  await writeFile(path.join(dir, '.dork', 'extensions', 'dash', 'index.ts'), 'export {}\n');
}

/** Wait until `check` passes or the time runs out. */
async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-watcher-fs-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  await mkdir(path.join(home, 'plugins'), { recursive: true });
  await writePackage(work);
  const slot = path.join(home, 'plugins', 'flow');
  await symlink(work, slot, 'dir');
  const record: DevLinkRecord = {
    name: 'flow',
    type: 'plugin',
    scope: 'global',
    slot,
    target: work,
    linkedAt: '2026-10-03T00:00:00.000Z',
    linkedVia: 'app',
  };
  await updateDevLinks(home, () => [record], { replaceUnreadable: true });
  events = [];
  reload = vi.fn<DevLinkExtensions['reload']>(async () => ({ outcome: 'reloaded' }));
  refreshPlugins = vi.fn<DevLinkWatcherDeps['refreshPlugins']>();
  watcher = new DevLinkWatcher({
    dorkHome: home,
    extensions: {
      carriedBy: () => [{ id: 'dash', dir: 'dash' }],
      refresh: async () => undefined,
      reload,
    },
    refreshPlugins,
    reproject: async () => undefined,
    broadcast: (event) => events.push(event),
    quietMs: 100,
    rearmMs: 0,
  });
  await watcher.start();
  await watcher.ready();
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await rm(base, { recursive: true, force: true });
});

describe('DevLinkWatcher on a real folder', () => {
  it('never fires for .git, node_modules or runtime state, and does for a real edit', async () => {
    // Purpose: a dependency install, a git operation or an extension saving
    // its data must not reload, and the watch must still be live to say so.
    await mkdir(path.join(work, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(work, 'node_modules', 'left-pad', 'index.js'), 'x');
    await mkdir(path.join(work, '.git', 'objects'), { recursive: true });
    await writeFile(path.join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(path.join(work, '.dork', 'data'), { recursive: true });
    await writeFile(path.join(work, '.dork', 'data', 'state.json'), '{}');
    await mkdir(path.join(work, '.dork', 'extensions', 'dash', 'node_modules'), {
      recursive: true,
    });
    await writeFile(path.join(work, '.dork', 'extensions', 'dash', 'node_modules', 'a.js'), 'x');
    await sleep(800);
    await watcher!.flush();
    expect(events).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();

    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const a = 1;\n'
    );
    await eventually(() => expect(reload).toHaveBeenCalledWith('dash'));
    await eventually(() => expect(events).toHaveLength(1));
  });

  it('closes the watch when the folder disappears, and the sweep re-arms it when it returns', async () => {
    // Purpose: a deleted working folder is folder-missing (no reloads), and
    // putting it back makes edits reload again without a restart.
    expect(watcher!.watchedFolders()).toEqual([work]);
    await rm(work, { recursive: true, force: true });
    await eventually(() => expect(watcher!.watchedFolders()).toEqual([]));
    expect(reload).not.toHaveBeenCalled();

    await writePackage(work);
    await watcher!.sweep();
    expect(watcher!.watchedFolders()).toEqual([work]);
    // What changed while it was gone is caught up once.
    await eventually(() => expect(reload).toHaveBeenCalledTimes(1));
    await watcher!.ready();
    await watcher!.flush();

    reload.mockClear();
    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const b = 2;\n'
    );
    await eventually(() => expect(reload).toHaveBeenCalledWith('dash'));
  });

  it('catches a change the watch never reported on the next sweep', async () => {
    // Purpose: chokidar can drop an event (right after a watch opens, or a
    // dead watch); the sweep's listing comparison still reloads.
    await watcher!.stop();
    // A fresh watcher whose watch reports nothing at all.
    watcher = new DevLinkWatcher({
      dorkHome: home,
      extensions: {
        carriedBy: () => [{ id: 'dash', dir: 'dash' }],
        refresh: async () => undefined,
        reload,
      },
      refreshPlugins,
      reproject: async () => undefined,
      broadcast: (event) => events.push(event),
      quietMs: 50,
      rearmMs: 0,
      settleMs: 0,
      watch: (_folder, _ignored, listeners) => {
        queueMicrotask(() => listeners.onReady());
        return { close: async () => undefined };
      },
    });
    await watcher.start();
    await watcher.ready();
    await sleep(20);
    await writeFile(path.join(work, '.dork', 'extensions', 'dash', 'new-file.ts'), 'export {}\n');
    await watcher.sweep();
    await watcher.flush();
    expect(reload).toHaveBeenCalledWith('dash');
  });
});
