/**
 * The dev link watcher's sweep listing (DOR-2696 task 3.1): a burst never
 * walks the whole folder, a folder too big to list is left to its watch and
 * said once, and what a burst acted on is not acted on again by the sweep.
 *
 * `shapeOf` is wrapped in a spy so a test can count full walks.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevLinkRecord } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../../../lib/logger.js';
import type { DevLinkExtensions } from '../dev-link-extensions.js';
import type { DevLinkWatchListeners } from '../dev-link-watcher.js';
import { updateDevLinks } from '../registry.js';

const walks = vi.hoisted(() => ({ count: 0 }));
vi.mock('../dev-link-changes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev-link-changes.js')>();
  return {
    ...actual,
    shapeOf: (...args: Parameters<typeof actual.shapeOf>) => {
      walks.count += 1;
      return actual.shapeOf(...args);
    },
  };
});

const { shapeOf } = await import('../dev-link-changes.js');
const { DevLinkWatcher } = await import('../dev-link-watcher.js');

let base: string;
let home: string;
let work: string;
let listeners: DevLinkWatchListeners | undefined;
let watcher: InstanceType<typeof DevLinkWatcher> | undefined;
let reload: ReturnType<typeof vi.fn<DevLinkExtensions['reload']>>;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-sweep-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  await mkdir(path.join(work, '.dork', 'extensions', 'dash'), { recursive: true });
  await writeFile(path.join(work, '.dork', 'extensions', 'dash', 'index.ts'), 'export {}\n');
  await writeFile(path.join(work, '.dork', 'extensions', 'dash', 'a.ts'), 'export {}\n');
  await mkdir(path.join(home, 'plugins'), { recursive: true });
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
  reload = vi.fn<DevLinkExtensions['reload']>(async () => ({ outcome: 'reloaded' }));
  walks.count = 0;
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

async function start(sweepMaxEntries?: number) {
  watcher = new DevLinkWatcher({
    dorkHome: home,
    extensions: { carriedBy: () => [{ id: 'dash', dir: 'dash' }], refresh: async () => {}, reload },
    refreshPlugins: async () => undefined,
    reproject: async () => undefined,
    refreshProjectCommands: () => undefined,
    broadcast: () => undefined,
    quietMs: 10,
    rearmMs: 0,
    settleMs: 0,
    ...(sweepMaxEntries !== undefined && { sweepMaxEntries }),
    watch: (_folder, _ignored, given) => {
      listeners = given;
      queueMicrotask(() => given.onReady());
      return { close: async () => undefined };
    },
  });
  await watcher.start();
  await watcher.ready();
  await watcher.flush();
  return watcher;
}

describe('shapeOf', () => {
  it('gives no listing at all for a folder past the cap, rather than a cut one', async () => {
    // Purpose: a cut listing depends on walk order; comparing two would
    // report deletions that never happened.
    expect(await shapeOf(work, [], 3)).toBeNull();
    expect(await shapeOf(work)).not.toBeNull();
  });
});

describe('the sweep listing', () => {
  it('does not walk the whole folder for a burst, and the sweep does not act on it again', async () => {
    // Purpose: the full walk belongs to the sweep and to arming; a burst
    // updates only the paths it touched, which keeps the next sweep quiet.
    const w = await start();
    const afterArm = walks.count;
    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const a = 1;\n'
    );
    listeners!.onEvent('change', path.join(work, '.dork', 'extensions', 'dash', 'index.ts'));
    await w.flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(walks.count).toBe(afterArm);

    await w.sweep();
    await w.flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a folder too big to list to its watch, and says so once', async () => {
    // Purpose: past the cap the sweep compares nothing (no false reloads or
    // deletions), the live watch still works, and the log is not a stream.
    const warn = vi.spyOn(logger, 'warn');
    const w = await start(1);
    await writeFile(path.join(work, '.dork', 'extensions', 'dash', 'b.ts'), 'export {}\n');
    await w.sweep();
    await w.sweep();
    await w.flush();
    expect(reload).not.toHaveBeenCalled();
    const tooBig = warn.mock.calls.filter(([message]) => String(message).includes('too big'));
    expect(tooBig).toHaveLength(1);
    expect(tooBig[0]?.[1]).toEqual({ folder: work });

    listeners!.onEvent('add', path.join(work, '.dork', 'extensions', 'dash', 'b.ts'));
    await w.flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
