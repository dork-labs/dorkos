/**
 * The same extension installed into several projects from one source (spec
 * `flow-multiproject` §9, N5): a person approves Flow in repo A once, then a
 * newer Flow is installed into repo B through the installer, and B's copy runs
 * with no new approval item, while A's older copy reports `shadowedBy`.
 *
 * Wires the REAL {@link ExtensionManager} (real discovery against a temp
 * `dorkHome` and temp projects, only `configManager` held in memory) into the
 * REAL {@link MarketplaceInstaller}. Only the git network boundary is stubbed,
 * the harness's designated seam: the fetch copies a local plugin folder and
 * reports a commit, so the installer records a GitHub source exactly as it
 * would for a real install.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../lib/boundary.js';
import { buildInstallerForTests } from './installer-harness.js';
import type { ExtensionsConfig } from '../../extensions/extension-enable-resolution.js';

/** The `extensions` config the manager reads and writes, held in memory. */
type StoredExtensions = ExtensionsConfig;
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
import { isPendingApproval } from '../../extensions/extension-approval-queue.js';

const PLUGIN = 'flow-plugin';
const SOURCE_URL = 'https://github.com/Dork-Labs/marketplace.git';
/** One commit per version: the package cache is content-addressed by commit. */
const commitFor = (version: string) => version.replace(/\D/g, '').padEnd(40, 'a');

describe('one extension across many projects, from one approved source', () => {
  let root: string;
  let dorkHome: string;
  let sources: string;
  let projects: string[];
  let manager: ExtensionManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dorkos-multi-project-ext-'));
    dorkHome = path.join(root, 'dork');
    sources = path.join(root, 'sources');
    projects = [];
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    await mkdir(sources, { recursive: true });
    await initBoundary(root);
    stored.value = { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} };
    manager = new ExtensionManager(dorkHome);
    manager.followProjects({ roots: async () => projects, onChange: () => () => undefined });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** One version of the plugin, carrying `flow`, in its own source folder. */
  async function writeVersion(version: string, ids: string[] = ['flow']): Promise<string> {
    const dir = path.join(sources, `${version}-${ids.join('-')}`, PLUGIN);
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
        description: 'A plugin that carries Flow',
        author: 'DorkOS',
        license: 'MIT',
        layers: ['extensions'],
        extensions: ids,
      })
    );
    for (const id of ids) {
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

  /** Install `version` into a new project folder from the GitHub source. */
  async function installInto(
    name: string,
    version: string,
    ids: string[] = ['flow']
  ): Promise<string> {
    const projectPath = path.join(root, name);
    await mkdir(projectPath, { recursive: true });
    projects.push(projectPath);
    const fixture = await writeVersion(version, ids);
    const harness = buildInstallerForTests(dorkHome, { extensionManager: manager });
    harness.spies.gitLookup.mockResolvedValue({
      kind: 'found',
      commitSha: commitFor(`${version}${ids.length}`),
      refName: 'HEAD',
    });
    harness.spies.gitFetch.mockImplementation(
      async (req: { destDir: string; commitSha: string }) => {
        await cp(fixture, req.destDir, { recursive: true });
        return req.commitSha;
      }
    );
    const result = await harness.installer.install({
      name: PLUGIN,
      source: SOURCE_URL,
      projectPath,
    });
    expect(result.ok).toBe(true);
    return path.join(result.installPath, '.dork', 'extensions', 'flow');
  }

  it("loads B's newer copy with no new approval item, and A's copy reports shadowedBy", async () => {
    const aCopy = await installInto('repo-a', '1.0.0');
    const flowA = manager.get('flow');
    expect(flowA?.path).toBe(aCopy);
    expect(flowA?.trustedOrigin).toEqual({ plugin: PLUGIN, source: 'dork-labs/marketplace' });
    expect(isPendingApproval(flowA!, stored.value)).toBe(true);

    await manager.approveToRun('flow');
    expect(stored.value.approvedSources?.flow).toMatchObject({
      path: aCopy,
      origin: { plugin: PLUGIN, source: 'dork-labs/marketplace' },
    });

    const bCopy = await installInto('repo-b', '1.2.0');

    const running = manager.get('flow');
    expect(running?.path).toBe(bCopy);
    expect(mayRunExtensionCode(running!, stored.value)).toBe(true);
    expect(isPendingApproval(running!, stored.value)).toBe(false);
    expect(manager.listShadowedPublic()).toEqual([
      expect.objectContaining({ id: 'flow', shadowedBy: bCopy, approvedToRun: true }),
    ]);
    expect(manager.listPublic()).toEqual([
      expect.objectContaining({ id: 'flow', shadowedBy: null, approvedToRun: true }),
    ]);
  });

  it('offers to trust the source once a person approves, and trusting it covers the next copy', async () => {
    await installInto('repo-a', '1.0.0');
    await manager.approveToRun('flow');
    expect(manager.trustOfferFor('flow')).toBe('dork-labs/marketplace');

    expect(await manager.trustSource('someone/else')).toBe('unproven');
    expect(await manager.trustSource('dork-labs/marketplace')).toBe('added');
    expect(manager.trustOfferFor('flow')).toBeNull();
    expect(await manager.trustSource('dork-labs/marketplace')).toBe('already');

    // Stop trusting: what is on stays on; the approval it already had stands.
    expect(await manager.untrustSource('dork-labs/marketplace')).toBe(true);
    expect(stored.value.trustedSources).toEqual([]);
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);
  });

  it("runs a trusted source's new extension with no approval row; stopping keeps it on and asks for the next", async () => {
    await installInto('repo-a', '1.0.0');
    const flow = manager.get('flow')!;
    expect(isPendingApproval(flow, stored.value)).toBe(true);

    expect(await manager.trustSource('dork-labs/marketplace')).toBe('added');
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);
    expect(isPendingApproval(manager.get('flow')!, stored.value)).toBe(false);
    expect(stored.value.approvedToRun).toEqual([]);

    expect(await manager.untrustSource('dork-labs/marketplace')).toBe(true);
    // Already on, so it stays on: it now holds an approval of its own.
    expect(stored.value.approvedToRun).toEqual(['flow']);
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);

    // A new extension from the same source asks again.
    await installInto('repo-c', '2.0.0', ['flow-extra']);
    const extra = manager.get('flow-extra')!;
    expect(extra.trustedOrigin?.source).toBe('dork-labs/marketplace');
    expect(isPendingApproval(extra, stored.value)).toBe(true);
  });
});
