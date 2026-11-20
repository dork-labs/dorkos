/**
 * The dev link watcher on a real folder with the real chokidar watch
 * (DOR-2696 task 3.1): ignored paths never fire, and a folder that disappears
 * and comes back is watched again by the sweep.
 *
 * Every negative assertion here is paired with a positive one on the same
 * watch, so "nothing fired" cannot pass because the watch was never live.
 *
 * The watch POLLS (`watchWithPolling`): macOS drops native events under load,
 * and a case here reddened healthy code on exactly that (DOR-2021). chokidar,
 * production's options and ignore rule, and the watcher's handlers are all the
 * real ones; only how a change is noticed differs.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { DevLinkRecord, DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { watchWithPolling } from '../../../../__tests__/watch-with-polling.js';
import type { DevLinkExtensions } from '../dev-link-extensions.js';
import { chokidarDevLinkWatch } from '../dev-link-watch.js';
import { DevLinkWatcher, type DevLinkWatcherDeps } from '../dev-link-watcher.js';
import { updateDevLinks } from '../registry.js';

let base: string;
let home: string;
let work: string;
let watcher: DevLinkWatcher | undefined;
let events: DevLinkReloadedEvent[];
let reload: ReturnType<typeof vi.fn<DevLinkExtensions['reload']>>;
let refreshPlugins: Mock<DevLinkWatcherDeps['refreshPlugins']>;
/** Every event the real watch reported, as `<kind> <path relative to the folder>`. */
let reported: string[];

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

/** Wait until `check` passes, on a budget widened by the load as the wait starts. */
async function eventually(check: () => void, baseMs = 5_000): Promise<void> {
  const deadline = Date.now() + loadScaledMs(baseMs);
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
  const opened = watchWithPolling(50);
  // Registered per test, so a `stop` that throws in afterEach cannot leak the spy.
  onTestFinished(() => opened.restore());
  reported = [];
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
  refreshPlugins = vi.fn<DevLinkWatcherDeps['refreshPlugins']>(async () => undefined);
  watcher = new DevLinkWatcher({
    dorkHome: home,
    extensions: {
      carriedBy: () => [{ id: 'dash', dir: 'dash' }],
      refresh: async () => undefined,
      reload,
    },
    refreshPlugins,
    reproject: async () => undefined,
    refreshProjectCommands: () => undefined,
    broadcast: (event) => events.push(event),
    quietMs: 100,
    rearmMs: 0,
    // The real chokidar watch, wrapped only to see what it reports.
    watch: (folder, ignored, listeners) =>
      chokidarDevLinkWatch(folder, ignored, {
        ...listeners,
        onEvent: (kind, absPath) => {
          reported.push(`${kind} ${path.relative(folder, absPath)}`);
          listeners.onEvent(kind, absPath);
        },
      }),
  });
  await watcher.start();
  await watcher.ready();
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await rm(base, { recursive: true, force: true });
});

describe(
  'DevLinkWatcher on a real folder',
  { timeout: Math.min(loadCeilingMs(10_000), 60_000) },
  () => {
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
      await mkdir(path.join(work, 'dist'), { recursive: true });
      await writeFile(path.join(work, 'dist', 'server.js'), 'x');
      await writeFile(path.join(work, 'server.log'), 'started\n');
      // A bounded window for a NEGATIVE claim — there is no event to wait on for
      // "nothing fired". The watch re-stats every 50 ms, so this is many polls.
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

    it('watches a build-named folder inside skills', async () => {
      // Purpose: `skills/build/` is a skill, not build output; chokidar must
      // open it, so a new SKILL.md there refreshes plugins.
      await mkdir(path.join(work, 'skills', 'build'), { recursive: true });
      // The new folders are a change of their own; only what follows counts. Once
      // the watch has reported both, flushing acts on them, so no refresh they
      // cause can land after the clear below and pass the case on its own.
      await eventually(() =>
        expect(reported).toEqual(
          expect.arrayContaining(['addDir skills', `addDir ${path.join('skills', 'build')}`])
        )
      );
      await watcher!.flush();
      await watcher!.projectionsIdle();
      refreshPlugins.mockClear();
      await writeFile(
        path.join(work, 'skills', 'build', 'SKILL.md'),
        '---\nname: build\ndescription: Build things.\n---\n'
      );
      await eventually(() => expect(refreshPlugins).toHaveBeenCalled());
      expect(reported).toContain(`add ${path.join('skills', 'build', 'SKILL.md')}`);
    });

    it('catches a file the watch never reported deep inside a skill folder on the next sweep', async () => {
      // Purpose: the sweep lists declaration paths all the way down, so a file
      // a dropped event never reported inside an existing skill still reloads.
      await watcher!.stop();
      await mkdir(path.join(work, 'skills', 'a'), { recursive: true });
      watcher = new DevLinkWatcher({
        dorkHome: home,
        refreshPlugins,
        reproject: async () => undefined,
        refreshProjectCommands: () => undefined,
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
      await watcher.flush();
      await watcher.projectionsIdle();
      refreshPlugins.mockClear();
      await writeFile(path.join(work, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
      await watcher.sweep();
      await watcher.flush();
      await watcher.projectionsIdle();
      expect(refreshPlugins).toHaveBeenCalledTimes(1);
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
        refreshProjectCommands: () => undefined,
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
  }
);
