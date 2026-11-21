/**
 * A change to an extension made while a background re-scan runs is kept (DOR-4886).
 *
 * A re-scan reads the config once, then replaces every record. The source-folder
 * watcher (DOR-4855) asks for one soon after every scan, so turning an extension
 * on or off often lands mid-scan. Before the fix the change was made to a record
 * the scan then threw away: an app turned on came back as off and its server
 * half never started, and one turned off came back as on. That is what ejected
 * the extension contract test from the merge queue on Linux, where the watcher
 * can open a watch on the temp folder.
 *
 * Nothing is faked: the config is real on a throwaway data directory, and
 * discovery and compile are real. The scan is only held open, right after it
 * read the config, until the change has had its chance to run.
 *
 * The data directory is the temp folder's real path. The watcher never watches a
 * folder reached through a link, and macOS's temp folder sits behind `/var` ->
 * `/private/var`, so a test that kept the linked path would never see the
 * watcher fire on a Mac and could not catch this there.
 *
 * @vitest-environment node
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { ExtensionManager } from '../extension-manager.js';
import { initConfigManager } from '../../core/config-manager.js';

const ID = 'scan-race';

let dorkHome: string;
let manager: ExtensionManager | undefined;

/** Write the fixture extension `id` into the data directory. */
async function writeExtension(id: string): Promise<void> {
  const dir = path.join(dorkHome, 'extensions', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id, name: 'Scan race', version: '1.0.0', description: 'A fixture' })
  );
  await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}\n');
}

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-4886-race-')));
  await writeExtension(ID);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await manager?.stopFileWatcher();
  await manager?.whenIdle();
  await manager?.whenSkillsSettled();
  manager = undefined;
  await fs.rm(dorkHome, { recursive: true, force: true });
});

/** A real config on the data directory, with `ID` turned on or off. */
function configWith(on: boolean): ReturnType<typeof initConfigManager> {
  const config = initConfigManager(dorkHome);
  config.set('extensions', { ...config.get('extensions'), enabled: on ? [ID] : [], disabled: [] });
  return config;
}

/** Whether the stored config has `ID` turned on. */
function enabledInConfig(config: ReturnType<typeof initConfigManager>): boolean {
  return config.get('extensions').enabled.includes(ID);
}

/**
 * Hold the next watcher-style re-scan open once it has read the config and
 * discovered, until `release` is called.
 */
function holdNextRecheck(): { scanRead: Promise<void>; release: () => void } {
  let read!: () => void;
  const scanRead = new Promise<void>((resolve) => (read = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const recheck = ExtensionDiscovery.prototype.recheck;
  vi.spyOn(ExtensionDiscovery.prototype, 'recheck').mockImplementation(async function (
    this: ExtensionDiscovery,
    ...args: Parameters<typeof recheck>
  ) {
    const found = await recheck.apply(this, args);
    read();
    await released;
    return found;
  });
  return { scanRead, release };
}

/** Make `change`, let a change that does not wait for the scan land, then let the scan go. */
async function changeMidScan(
  config: ReturnType<typeof initConfigManager>,
  release: () => void,
  change: 'enable' | 'disable'
): Promise<void> {
  const changing = change === 'enable' ? manager!.enable(ID) : manager!.disable(ID);
  await vi
    .waitFor(() => expect(enabledInConfig(config)).toBe(change === 'enable'), { timeout: 1_500 })
    .catch(() => undefined);
  release();
  await changing;
  await manager!.whenIdle();
}

/** The change stuck: in the config, on the record, and in what clients are shown. */
function expectStuck(config: ReturnType<typeof initConfigManager>, on: boolean): void {
  expect(enabledInConfig(config)).toBe(on);
  expect(manager!.get(ID)?.status === 'disabled').toBe(!on);
  expect(manager!.listPublic().find((e) => e.id === ID)?.status === 'disabled').toBe(!on);
}

describe('a change made while a background re-scan runs', () => {
  it.each([
    { change: 'enable', from: false },
    { change: 'disable', from: true },
  ] as const)(
    'keeps a $change made mid-scan',
    async ({ change, from }) => {
      const config = configWith(from);
      manager = new ExtensionManager(dorkHome, []);
      await manager.initialize(null);
      expect(manager.get(ID)?.status === 'disabled').toBe(!from);

      const { scanRead, release } = holdNextRecheck();
      manager.requestRefresh({ establishBaseline: false });
      await scanRead;
      await changeMidScan(config, release, change);

      expectStuck(config, !from);
    },
    30_000
  );

  it('keeps an enable made during the re-scan the source-folder watcher itself asks for', async () => {
    const config = configWith(false);
    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);

    // Fails here, not later, if the watcher never fires on this folder.
    const { scanRead, release } = holdNextRecheck();
    await manager.startFileWatcher();
    await scanRead;
    await changeMidScan(config, release, 'enable');

    expectStuck(config, true);
  }, 30_000);

  it('turns on an extension no scan has seen yet without waiting on itself', async () => {
    const config = configWith(false);
    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);
    // Arrives after the last scan: `enable` re-scans for it from inside the queue.
    await writeExtension('arrived-late');

    const enabled = await manager.enable('arrived-late');

    expect(enabled?.extension.id).toBe('arrived-late');
    expect(config.get('extensions').enabled).toContain('arrived-late');
    expect(manager.get('arrived-late')?.status).not.toBe('disabled');
  }, 30_000);
});
