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
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../lib/boundary.js';
import { buildInstallerForTests } from './installer-harness.js';
import { noopLogger } from '@dorkos/shared/logger';
import { UninstallFlow } from '../flows/uninstall/uninstall.js';
import { readProjectInstalls } from '../lib/project-install-index.js';
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
  async function writeVersion(
    version: string,
    ids: string[] = ['flow'],
    opts: { server?: boolean } = {}
  ): Promise<string> {
    const dir = path.join(
      sources,
      `${version}-${ids.join('-')}${opts.server ? '-srv' : ''}`,
      PLUGIN
    );
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
      if (opts.server) {
        // Like flow: at RUNTIME the server half reads plugin-level code relative
        // to its own folder, long after the load was checked.
        await writeFile(
          path.join(extDir, 'server.ts'),
          [
            "import fs from 'node:fs';",
            "import path from 'node:path';",
            'export default function register(_router: unknown, ctx: { extensionDir: string }) {',
            '  (globalThis as Record<string, unknown>).__flowRunsScript = () =>',
            "    fs.readFileSync(path.join(ctx.extensionDir, '../../../scripts/config-files.ts'), 'utf8');",
            '}',
            '',
          ].join('\n')
        );
      }
    }
    if (opts.server) {
      await mkdir(path.join(dir, 'scripts'), { recursive: true });
      await writeFile(path.join(dir, 'scripts', 'config-files.ts'), `// v${version}, as shipped\n`);
    }
    return dir;
  }

  /** Install `version` into a new project folder from the GitHub source. */
  async function installInto(
    name: string,
    version: string,
    ids: string[] = ['flow'],
    opts: { server?: boolean } = {}
  ): Promise<string> {
    const projectPath = path.join(root, name);
    await mkdir(projectPath, { recursive: true });
    projects.push(projectPath);
    const fixture = await writeVersion(version, ids, opts);
    const harness = buildInstallerForTests(dorkHome, { extensionManager: manager });
    harness.spies.gitLookup.mockResolvedValue({
      kind: 'found',
      commitSha: commitFor(`${version}${ids.length}${opts.server ? 9 : 0}`),
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
    // The re-scan that picks up the new copy runs after the install answers.
    await manager.whenIdle();
    return path.join(result.installPath, '.dork', 'extensions', ids[0] ?? 'flow');
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
    await manager.whenIdle();
    expect(manager.trustOfferFor('flow')).toBeNull();
    expect(await manager.trustSource('dork-labs/marketplace')).toBe('already');

    // Stop trusting: what is on stays on; the approval it already had stands.
    expect(await manager.untrustSource('dork-labs/marketplace')).toBe(true);
    await manager.whenIdle();
    expect(stored.value.trustedSources).toEqual([]);
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);
  });

  it("runs a trusted source's new extension with no approval row; stopping keeps it on and asks for the next", async () => {
    await installInto('repo-a', '1.0.0');
    const flow = manager.get('flow')!;
    expect(isPendingApproval(flow, stored.value)).toBe(true);

    expect(await manager.trustSource('dork-labs/marketplace')).toBe('added');
    await manager.whenIdle();
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);
    expect(isPendingApproval(manager.get('flow')!, stored.value)).toBe(false);
    expect(stored.value.approvedToRun).toEqual([]);

    expect(await manager.untrustSource('dork-labs/marketplace')).toBe(true);
    await manager.whenIdle();
    // Already on, so it stays on: it now holds an approval of its own.
    expect(stored.value.approvedToRun).toEqual(['flow']);
    expect(mayRunExtensionCode(manager.get('flow')!, stored.value)).toBe(true);

    // A new extension from the same source asks again.
    await installInto('repo-c', '2.0.0', ['flow-extra']);
    const extra = manager.get('flow-extra')!;
    expect(extra.trustedOrigin?.source).toBe('dork-labs/marketplace');
    expect(isPendingApproval(extra, stored.value)).toBe(true);
  });

  it('forgets the install record on uninstall, so a folder written back at that path proves nothing', async () => {
    const aCopy = await installInto('repo-a', '1.0.0');
    await manager.approveToRun('flow');
    const bCopy = await installInto('repo-b', '1.2.0');
    expect(manager.get('flow')?.path).toBe(bCopy);

    const uninstall = new UninstallFlow({
      dorkHome,
      extensionManager: manager,
      adapterManager: { removeAdapter: vi.fn() },
      logger: noopLogger,
    });
    await uninstall.uninstall({ name: PLUGIN, projectPath: path.join(root, 'repo-b') });
    const records = await readProjectInstalls(dorkHome);
    expect(records.map((r) => r.projectPath)).toEqual([path.join(root, 'repo-a')]);

    // The same folder comes back (a re-clone, a `git pull`) carrying v99.
    await cp(await writeVersion('99.0.0'), path.dirname(path.dirname(path.dirname(bCopy))), {
      recursive: true,
    });
    await manager.reload();
    await manager.whenIdle();

    const running = manager.get('flow');
    expect(running?.path).toBe(aCopy);
    expect(mayRunExtensionCode(running!, stored.value)).toBe(true);
  });

  it('records no source for an install fetched at a pull-request ref', async () => {
    const projectPath = path.join(root, 'repo-pr');
    await mkdir(projectPath, { recursive: true });
    const fixture = await writeVersion('5.0.0');
    const harness = buildInstallerForTests(dorkHome, { extensionManager: manager });
    harness.spies.gitLookup.mockResolvedValue({
      kind: 'found',
      commitSha: commitFor('5.0.0pr'),
      refName: 'refs/pull/7/head',
    });
    harness.spies.gitFetch.mockImplementation(
      async (req: { destDir: string; commitSha: string }) => {
        await cp(fixture, req.destDir, { recursive: true });
        return req.commitSha;
      }
    );
    // A marketplace entry pinned to a pull request's head: GitHub serves it
    // through the parent repository's URL, whoever wrote it.
    vi.spyOn(harness.resolver, 'resolve').mockResolvedValue({
      kind: 'git',
      packageName: PLUGIN,
      pluginSource: {
        source: 'url',
        url: 'https://github.com/dork-labs/marketplace.git',
        ref: 'refs/pull/7/head',
      },
    });
    const result = await harness.installer.install({
      name: PLUGIN,
      source: 'https://github.com/dork-labs/marketplace.git',
      projectPath,
    });
    expect(result.ok).toBe(true);
    const record = (await readProjectInstalls(dorkHome)).find((r) => r.projectPath === projectPath);
    expect(record).toBeDefined();
    expect(record?.source).toBeUndefined();
  });

  it('runs a copy trusted by origin from a verified snapshot, so later edits in the project never run (R1)', async () => {
    await installInto('repo-a', '1.0.0', ['flow'], { server: true });
    await manager.approveToRun('flow');
    const bCopy = await installInto('repo-b', '1.2.0', ['flow'], { server: true });

    const running = manager.get('flow');
    expect(running?.path).toBe(bCopy);
    const snapshots = path.join(dorkHome, 'extension-snapshots');
    expect(running?.runPath?.startsWith(snapshots + path.sep)).toBe(true);

    // An agent in repo B edits the plugin-level script the server half runs.
    await writeFile(
      path.join(path.dirname(path.dirname(path.dirname(bCopy))), 'scripts', 'config-files.ts'),
      '// evil\n'
    );
    const runScript = (globalThis as Record<string, unknown>).__flowRunsScript as () => string;
    expect(runScript()).toBe('// v1.2.0, as shipped\n');

    // The next scan sees B changed: it loses its origin, and its snapshot goes.
    await manager.reload();
    expect(manager.get('flow')?.path).not.toBe(bCopy);
    expect(existsSync(running!.runPath!)).toBe(false);
  });

  it('"Stop trusting" pins a running copy to its digest: it keeps running from its snapshot, and a change asks again', async () => {
    const aCopy = await installInto('repo-a', '1.0.0', ['flow'], { server: true });
    expect(await manager.trustSource('dork-labs/marketplace')).toBe('added');
    await manager.whenIdle();
    const trusted = manager.get('flow');
    expect(trusted?.path).toBe(aCopy);
    expect(trusted?.runPath?.startsWith(path.join(dorkHome, 'extension-snapshots'))).toBe(true);

    expect(await manager.untrustSource('dork-labs/marketplace')).toBe(true);
    await manager.whenIdle();
    const pinned = stored.value.approvedSources?.flow;
    expect(pinned).toMatchObject({ path: aCopy, digest: expect.stringMatching(/^sha256:/) });
    expect(pinned).not.toHaveProperty('origin');
    const kept = manager.get('flow');
    expect(mayRunExtensionCode(kept!, stored.value)).toBe(true);
    expect(kept?.runPath?.startsWith(path.join(dorkHome, 'extension-snapshots'))).toBe(true);

    // An agent in repo A edits the script the server half runs.
    await writeFile(
      path.join(path.dirname(path.dirname(path.dirname(aCopy))), 'scripts', 'config-files.ts'),
      '// evil\n'
    );
    const runScript = (globalThis as Record<string, unknown>).__flowRunsScript as () => string;
    expect(runScript()).toBe('// v1.0.0, as shipped\n');

    // The next scan sees the change: the pinned yes no longer covers it, so it asks.
    await manager.reload();
    const changed = manager.get('flow');
    expect(mayRunExtensionCode(changed!, stored.value)).toBe(false);
    expect(isPendingApproval(changed!, stored.value)).toBe(true);
    expect(changed?.runPath).toBeUndefined();
  });
});
