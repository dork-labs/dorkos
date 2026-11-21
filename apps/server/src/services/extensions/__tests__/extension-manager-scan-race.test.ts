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

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-4886-race-')));
  const dir = path.join(dorkHome, 'extensions', ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id: ID, name: 'Scan race', version: '1.0.0', description: 'A fixture' })
  );
  await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dorkHome, { recursive: true, force: true });
});

/** Whether the stored config has `ID` turned on. */
function enabledInConfig(config: ReturnType<typeof initConfigManager>): boolean {
  return config.get('extensions').enabled.includes(ID);
}

describe('a change made while a background re-scan runs', () => {
  it.each([
    { change: 'enable', from: false },
    { change: 'disable', from: true },
  ] as const)(
    'keeps a $change made mid-scan',
    async ({ change, from }) => {
      const config = initConfigManager(dorkHome);
      const extensions = config.get('extensions');
      config.set('extensions', {
        ...extensions,
        enabled: from ? [ID] : [],
        disabled: [],
      });
      const manager = new ExtensionManager(dorkHome, []);
      await manager.initialize(null);
      expect(manager.get(ID)?.status === 'disabled').toBe(!from);

      // Hold the watcher's re-scan open once it has read the config and discovered.
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
      manager.requestRefresh({ establishBaseline: false });
      await scanRead;

      const changing = change === 'enable' ? manager.enable(ID) : manager.disable(ID);
      // Give a change that does not wait for the scan time to land in the config.
      await vi
        .waitFor(() => expect(enabledInConfig(config)).toBe(!from), { timeout: 1_500 })
        .catch(() => undefined);
      release();
      await changing;
      await manager.whenIdle();

      expect(enabledInConfig(config)).toBe(!from);
      expect(manager.get(ID)?.status === 'disabled').toBe(from);
      expect(manager.listPublic().find((e) => e.id === ID)?.status === 'disabled').toBe(from);
    },
    30_000
  );
});
