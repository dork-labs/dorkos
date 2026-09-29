/**
 * A person's approval to run a plugin-carried extension, across the plugin's
 * lifecycle (DOR-2383, DOR-2388): an update from the same plugin keeps it, a
 * plain uninstall forgets it, and an extension a new version drops loses it, so
 * a later version that brings the extension back asks again.
 *
 * The per-flow tests (`flows/uninstall.test.ts`, `flows/install-plugin.test.ts`)
 * pin which ids each flow hands to a stub manager. This file wires the REAL
 * {@link ExtensionManager} (real discovery and compile against a temp
 * `dorkHome`, only `configManager` held in memory) into the real
 * {@link MarketplaceInstaller}, so what is asserted is the stored
 * `approvedToRun` and `approvedSources` and the load gate's verdict, the things
 * a person actually experiences.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../lib/boundary.js';
import { noopLogger } from '@dorkos/shared/logger';
import { UninstallFlow } from '../flows/uninstall/uninstall.js';
import { buildInstallerForTests } from './installer-harness.js';

/** The `extensions` config the manager reads and writes, held in memory. */
interface StoredExtensions {
  enabled: string[];
  disabled: string[];
  approvedToRun: string[];
  approvedSources?: Record<string, { path: string; plugin?: string }>;
}
const stored = vi.hoisted(() => ({
  value: { enabled: [], disabled: [], approvedToRun: [] } as StoredExtensions,
}));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as StoredExtensions;
    },
  },
}));

import { ExtensionManager } from '../../extensions/extension-manager.js';
import { mayRunExtensionCode } from '../../extensions/extension-load-policy.js';

const PLUGIN = 'flow-plugin';

describe('a plugin-carried extension approval across the plugin lifecycle', () => {
  let root: string;
  let dorkHome: string;
  let sources: string;
  let manager: ExtensionManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dorkos-plugin-ext-approval-'));
    dorkHome = path.join(root, 'dork');
    sources = path.join(root, 'sources');
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    await mkdir(sources, { recursive: true });
    await initBoundary(sources);
    stored.value = { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} };
    manager = new ExtensionManager(dorkHome);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /**
   * Write one version of the plugin to its own source folder (named after the
   * package, so a local-path install resolves the same package name each time),
   * carrying the given extensions.
   */
  async function writeVersion(version: string, extensionIds: string[]): Promise<string> {
    const dir = path.join(sources, version, PLUGIN);
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: PLUGIN, version, description: 'Flow plugin fixture' })
    );
    await mkdir(path.join(dir, '.dork'), { recursive: true });
    await writeFile(
      path.join(dir, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: PLUGIN,
        version,
        type: 'plugin',
        description: 'A plugin that carries extensions',
        author: 'DorkOS',
        license: 'MIT',
        layers: ['extensions'],
        extensions: extensionIds,
      })
    );
    for (const id of extensionIds) {
      const extDir = path.join(dir, '.dork', 'extensions', id);
      await mkdir(extDir, { recursive: true });
      await writeFile(
        path.join(extDir, 'extension.json'),
        JSON.stringify({ id, name: id, version, entry: './index.ts' })
      );
      await writeFile(path.join(extDir, 'index.ts'), 'export {};\n');
    }
    return dir;
  }

  /** Install v1 carrying `ids` and approve every one of them, as a person would. */
  async function installAndApprove(ids: string[]) {
    const harness = buildInstallerForTests(dorkHome, { extensionManager: manager });
    const first = await harness.installer.install({ name: await writeVersion('1.0.0', ids) });
    for (const id of ids) {
      expect(await manager.approveToRun(id)).not.toBeNull();
      expect(runs(id)).toBe(true);
    }
    return { installer: harness.installer, installRoot: first.installPath };
  }

  /** Whether the load gate lets this extension's code run right now. */
  function runs(id: string): boolean {
    const record = manager.get(id);
    return record !== undefined && mayRunExtensionCode(record, stored.value);
  }

  it('keeps the approval, and the extension running, when the same plugin updates', async () => {
    const { installer, installRoot } = await installAndApprove(['flow']);
    const approvedSource = stored.value.approvedSources?.flow;
    expect(approvedSource).toEqual({
      path: path.join(installRoot, '.dork', 'extensions', 'flow'),
      plugin: PLUGIN,
    });

    const result = await installer.update({ name: await writeVersion('2.0.0', ['flow']) });

    expect(result.installPath).toBe(installRoot);
    expect(stored.value.approvedToRun).toContain('flow');
    expect(stored.value.approvedSources?.flow).toEqual(approvedSource);
    expect(stored.value.enabled).toContain('flow');
    expect(runs('flow')).toBe(true);
  });

  it('forgets the approval on a plain uninstall', async () => {
    await installAndApprove(['flow']);
    const uninstallFlow = new UninstallFlow({
      dorkHome,
      extensionManager: manager,
      adapterManager: { removeAdapter: vi.fn() },
      logger: noopLogger,
    });

    await uninstallFlow.uninstall({ name: PLUGIN });

    expect(stored.value.approvedToRun).not.toContain('flow');
    expect(stored.value.approvedSources?.flow).toBeUndefined();
    expect(stored.value.enabled).not.toContain('flow');
  });

  it('turns off and forgets an extension an update drops, and asks again when a later version brings it back', async () => {
    const { installer, installRoot } = await installAndApprove(['flow', 'flow-old']);

    await installer.update({ name: await writeVersion('2.0.0', ['flow']) });

    expect(stored.value.enabled).not.toContain('flow-old');
    expect(stored.value.approvedToRun).not.toContain('flow-old');
    expect(stored.value.approvedSources?.['flow-old']).toBeUndefined();
    // The one it still carries is untouched.
    expect(runs('flow')).toBe(true);

    // v3 carries `flow-old` again, at the same folder: code that left and came
    // back is new to the person, so it is refused until approved.
    await installer.update({ name: await writeVersion('3.0.0', ['flow', 'flow-old']) });

    expect(stored.value.enabled).toContain('flow-old');
    expect(manager.get('flow-old')?.path).toBe(
      path.join(installRoot, '.dork', 'extensions', 'flow-old')
    );
    expect(runs('flow-old')).toBe(false);
    await manager.approveToRun('flow-old');
    expect(runs('flow-old')).toBe(true);
  });

  it('turns off and forgets an extension a forced reinstall drops', async () => {
    const { installer } = await installAndApprove(['flow', 'flow-old']);

    await installer.install({ name: await writeVersion('2.0.0', ['flow']), force: true });

    expect(stored.value.enabled).not.toContain('flow-old');
    expect(stored.value.approvedToRun).not.toContain('flow-old');
    expect(stored.value.approvedSources?.['flow-old']).toBeUndefined();
    expect(runs('flow')).toBe(true);
  });
});
