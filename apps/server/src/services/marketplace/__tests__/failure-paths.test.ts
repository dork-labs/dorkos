/**
 * Failure-path integration tests for the marketplace install pipeline.
 *
 * Proves that {@link MarketplaceInstaller} and its collaborators honour the
 * atomic-rollback contract on every kind of failure the pipeline can hit:
 *
 * 1. Network failure during `git clone` (fetcher throws before validation).
 * 2. Validation failure against a broken manifest (after resolve, pre-flow).
 * 3. Activation failure inside the plugin flow (post-validate, mid-activate).
 * 4. Conflict-detector error blocks install before any disk mutation.
 * 5. `force: true` bypasses the conflict gate and the install succeeds.
 *
 * Every test runs against a temp `dorkHome` under {@link os.tmpdir} and
 * mocks {@link transactionInternal.isGitRepo} → `false` so the transaction
 * engine's `git reset --hard <backup-branch>` rollback path never runs
 * against the live worktree. Both defences combined because the cost of
 * getting this wrong is destroying uncommitted work in the calling worktree.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@dorkos/shared/logger';
import type { Logger } from '@dorkos/shared/logger';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';
import { MarketplaceCache } from '../marketplace-cache.js';
import {
  ConflictError,
  InvalidPackageError,
  MarketplaceInstaller,
} from '../marketplace-installer.js';
import { MarketplaceSourceManager } from '../marketplace-source-manager.js';
import { PackageFetcher } from '../package-fetcher.js';
import { PackageResolver } from '../package-resolver.js';
import { PermissionPreviewBuilder } from '../permission-preview.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import { AdapterInstallFlow } from '../flows/install-adapter.js';
import { AgentInstallFlow } from '../flows/install-agent.js';
import { PluginInstallFlow } from '../flows/install-plugin.js';
import { SkillPackInstallFlow } from '../flows/install-skill-pack.js';
import { UninstallFlow } from '../flows/uninstall.js';
import { _internal as transactionInternal } from '../transaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the shipped fixtures directory. */
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/** Prefix applied to every staging directory by the transaction engine. */
const STAGING_DIR_PREFIX = 'dorkos-install-';

/** Spies exposed by {@link buildHarness}. */
interface HarnessSpies {
  extensionCompile: ReturnType<typeof vi.fn>;
  extensionEnable: ReturnType<typeof vi.fn>;
  createAgentWorkspace: ReturnType<typeof vi.fn>;
  adapterAdd: ReturnType<typeof vi.fn>;
  adapterRemove: ReturnType<typeof vi.fn>;
  templateClone: ReturnType<typeof vi.fn>;
}

/** Result of {@link buildHarness}. */
interface Harness {
  installer: MarketplaceInstaller;
  dorkHome: string;
  spies: HarnessSpies;
  logger: Logger;
  /** Exposed so tests can spy on `fetchFromGit` without reaching into private fields. */
  fetcher: PackageFetcher;
  /** Exposed so tests can stub `resolve` to return a git-kind descriptor. */
  resolver: PackageResolver;
}

/**
 * Wire a full {@link MarketplaceInstaller} with real collaborators rooted
 * at the supplied temp `dorkHome`. Only the four external side-effect
 * surfaces are stubbed: `templateDownloader.cloneRepository`,
 * `extensionCompiler.compile`, `extensionManager.enable`, and
 * `agentCreator.createAgentWorkspace`. `AdapterManager` is also faked —
 * the real class pulls in the whole relay subsystem which is out of
 * scope for an install-pipeline failure-path test.
 *
 * This helper intentionally mirrors `buildInstallerForTests` in
 * `integration.test.ts` (task #25) so the two files can be merged into a
 * shared `integration-helpers.ts` during cleanup.
 */
function buildHarness(dorkHome: string): Harness {
  const logger = noopLogger;

  const sourceManager = new MarketplaceSourceManager(dorkHome);
  const cache = new MarketplaceCache(dorkHome);

  const templateClone = vi.fn(async () => {
    throw new Error('templateDownloader.cloneRepository must not be called for local fixtures');
  });
  const templateDownloader = {
    cloneRepository: templateClone,
  } as unknown as TemplateDownloader;

  const fetcher = new PackageFetcher(cache, templateDownloader, logger);
  const resolver = new PackageResolver(sourceManager, cache);

  const adapterAdd = vi.fn().mockResolvedValue(undefined);
  const adapterRemove = vi.fn().mockResolvedValue(undefined);
  const adapterList = vi.fn().mockReturnValue([]);
  const adapterManager = {
    addAdapter: adapterAdd,
    removeAdapter: adapterRemove,
    listAdapters: adapterList,
  } as unknown as AdapterManager;

  const conflictDetector = new ConflictDetector(dorkHome, adapterManager);
  const previewBuilder = new PermissionPreviewBuilder(dorkHome, conflictDetector);

  const extensionCompile = vi
    .fn()
    .mockResolvedValue({ code: 'compiled', sourceHash: 'failure-path-test' });
  const extensionEnable = vi.fn().mockResolvedValue({ extension: {}, reloadRequired: false });
  const extensionCompiler = { compile: extensionCompile };
  const extensionManager = {
    enable: extensionEnable,
    disable: vi.fn().mockResolvedValue(undefined),
  };

  const createAgentWorkspace = vi.fn(async (input: { directory: string; name: string }) => {
    return {
      manifest: { id: 'failure-test-id', name: input.name },
      path: input.directory,
    };
  });
  const agentCreator = { createAgentWorkspace };

  const pluginFlow = new PluginInstallFlow({
    dorkHome,
    extensionCompiler,
    extensionManager,
    logger,
  });
  const agentFlow = new AgentInstallFlow({
    dorkHome,
    agentCreator,
    logger,
  });
  const skillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
  const adapterFlow = new AdapterInstallFlow({ dorkHome, adapterManager, logger });
  const uninstallFlow = new UninstallFlow({
    dorkHome,
    extensionManager,
    adapterManager,
    logger,
  });

  const installer = new MarketplaceInstaller({
    dorkHome,
    resolver,
    fetcher,
    previewBuilder,
    pluginFlow,
    agentFlow,
    skillPackFlow,
    adapterFlow,
    uninstallFlow,
    logger,
  });

  return {
    installer,
    dorkHome,
    logger,
    fetcher,
    resolver,
    spies: {
      extensionCompile,
      extensionEnable,
      createAgentWorkspace,
      adapterAdd,
      adapterRemove,
      templateClone,
    },
  };
}

/** Return every tmpdir entry whose basename starts with the staging prefix. */
async function listStagingDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(STAGING_DIR_PREFIX));
}

/** Returns true if `target` exists on disk (file or directory). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialise a plugin package under `tmp` that passes validation and has
 * exactly one fully-formed extension under `.dork/extensions/<id>/`. Unlike
 * the shipped `valid-plugin` fixture — whose `extension.json` intentionally
 * omits the `id` field so compile/enable never run — this package forces the
 * plugin flow all the way through the `enable` step. Tests that want to
 * prove an activation-time rollback use this.
 */
async function buildActivatableFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dorkos-fail-plugin-src-'));
  const pkgDir = path.join(root, name);
  await mkdir(path.join(pkgDir, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(pkgDir, '.dork', 'extensions', 'sample-ext'), { recursive: true });

  await writeFile(
    path.join(pkgDir, '.dork', 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: 'Activatable plugin fixture for failure-path tests',
        license: 'MIT',
        tags: ['test'],
        layers: ['extensions'],
        extensions: ['sample-ext'],
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(pkgDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'Activatable fixture' }, null, 2)
  );
  await writeFile(
    path.join(pkgDir, '.dork', 'extensions', 'sample-ext', 'extension.json'),
    JSON.stringify(
      { id: 'sample-ext', name: 'sample-ext', version: '1.0.0', entry: './index.ts' },
      null,
      2
    )
  );
  await writeFile(
    path.join(pkgDir, '.dork', 'extensions', 'sample-ext', 'index.ts'),
    'export const activate = () => {};\n'
  );

  return pkgDir;
}

describe('marketplace install pipeline — failure paths', () => {
  let dorkHome: string;
  const scratchDirs: string[] = [];

  beforeEach(async () => {
    // CRITICAL: neutralise the transaction engine's `git reset --hard`
    // rollback path. Combined with the temp dorkHome below, this prevents
    // any test failure from writing to the live worktree. Session 1 lost
    // hours of work by skipping this mock — do not skip it.
    vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);

    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-fail-home-'));
    // Pre-seed an empty `plugins/` so rename activation has a parent dir.
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rolls back cleanly when the fetcher throws during git clone', async () => {
    // Wire a harness whose fetcher is replaced with one whose clone
    // step throws immediately — simulates a network or auth failure
    // inside `templateDownloader.cloneRepository`.
    const harness = buildHarness(dorkHome);

    // Replace the resolver's output with a git-kind descriptor so the
    // installer routes through the fetcher (which in turn rejects to
    // simulate `templateDownloader.cloneRepository` blowing up on a
    // network / auth failure).
    const fetchSpy = vi
      .spyOn(harness.fetcher, 'fetchFromGit')
      .mockRejectedValue(new Error('simulated network failure: ECONNRESET'));
    vi.spyOn(harness.resolver, 'resolve').mockResolvedValue({
      kind: 'git',
      packageName: 'network-fail-plugin',
      gitUrl: 'https://example.invalid/network-fail-plugin.git',
    });

    const stagingBefore = await listStagingDirs();

    await expect(
      harness.installer.install({
        name: 'network-fail-plugin',
        source: 'https://example.invalid/network-fail-plugin.git',
      })
    ).rejects.toThrow(/simulated network failure/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No install root created.
    expect(await pathExists(path.join(dorkHome, 'plugins', 'network-fail-plugin'))).toBe(false);

    // No staging directories left behind for THIS test — the fetcher failed
    // before the transaction engine even opened its staging dir. Filter to
    // this test's package name so parallel test runs don't pollute the
    // snapshot.
    const stagingAfter = await listStagingDirs();
    const ownPrefix = `${STAGING_DIR_PREFIX}install-plugin-network-fail-plugin-`;
    expect(stagingAfter.filter((d) => d.startsWith(ownPrefix))).toEqual(
      stagingBefore.filter((d) => d.startsWith(ownPrefix))
    );

    // No side effects on any downstream flow collaborator.
    expect(harness.spies.extensionCompile).not.toHaveBeenCalled();
    expect(harness.spies.extensionEnable).not.toHaveBeenCalled();
  });

  it('throws InvalidPackageError and leaves no staging residue for a broken manifest', async () => {
    // Confirm the fixture is still where we expect before relying on it.
    const brokenFixture = path.join(FIXTURES_DIR, 'broken', 'invalid-manifest');
    expect(await pathExists(path.join(brokenFixture, '.dork', 'manifest.json'))).toBe(true);

    const harness = buildHarness(dorkHome);
    const stagingBefore = await listStagingDirs();

    await expect(harness.installer.install({ name: brokenFixture })).rejects.toBeInstanceOf(
      InvalidPackageError
    );

    // No install root at any of the plausible destinations. The broken
    // manifest declares `name: "BadName"` which would otherwise land at
    // `plugins/BadName`, so assert both candidates.
    expect(await pathExists(path.join(dorkHome, 'plugins', 'BadName'))).toBe(false);
    expect(await pathExists(path.join(dorkHome, 'plugins', 'invalid-manifest'))).toBe(false);

    // The validator fails before the transaction engine opens a staging
    // directory. Scope the snapshot to package names this test could have
    // produced so parallel runs don't pollute the comparison.
    const stagingAfter = await listStagingDirs();
    const ownPrefixes = [
      `${STAGING_DIR_PREFIX}install-plugin-BadName-`,
      `${STAGING_DIR_PREFIX}install-plugin-invalid-manifest-`,
    ];
    const matchesOwn = (d: string) => ownPrefixes.some((p) => d.startsWith(p));
    expect(stagingAfter.filter(matchesOwn)).toEqual(stagingBefore.filter(matchesOwn));

    // No flow collaborator was touched.
    expect(harness.spies.extensionCompile).not.toHaveBeenCalled();
    expect(harness.spies.extensionEnable).not.toHaveBeenCalled();
    expect(harness.spies.createAgentWorkspace).not.toHaveBeenCalled();
  });

  it('rolls back a partially-activated plugin when extensionManager.enable throws', async () => {
    // The shipped `missing-extension-code` fixture fails validation before
    // the plugin flow ever runs, so it cannot exercise the activation-step
    // rollback. Build an in-flight fixture instead that passes validation
    // and carries one fully-formed extension, then force the enable step
    // to throw via the harness spy.
    const packagePath = await buildActivatableFixture('activation-fail-plugin');
    scratchDirs.push(path.dirname(packagePath));

    // Pre-create a sentinel file in `dorkHome` so we can prove the
    // rollback did not sweep unrelated state on the way out.
    const sentinelPath = path.join(dorkHome, 'sentinel.txt');
    await writeFile(sentinelPath, 'untouched-by-rollback', 'utf-8');

    const harness = buildHarness(dorkHome);
    harness.spies.extensionEnable.mockRejectedValueOnce(
      new Error('simulated activation failure: enable threw')
    );

    const stagingBefore = await listStagingDirs();

    await expect(harness.installer.install({ name: packagePath })).rejects.toThrow(
      /simulated activation failure/
    );

    // The flow must have entered activation — compile happens in
    // `stage()`, enable in `activate()`. Seeing `compile` called proves
    // the broken fixture exercised the full stage→activate pipeline and
    // the failure is rooted at the activation step, not validation.
    expect(harness.spies.extensionCompile).toHaveBeenCalledTimes(1);
    expect(harness.spies.extensionEnable).toHaveBeenCalledTimes(1);

    // Sentinel must still be intact — rollback is scoped to the install
    // transaction, not the entire dorkHome.
    expect(await pathExists(sentinelPath)).toBe(true);
    expect(await readFile(sentinelPath, 'utf-8')).toBe('untouched-by-rollback');

    // Staging directory from this transaction is cleaned up. Filter to
    // this test's specific package name so parallel test runs (e.g.
    // integration.test.ts also exercising the install-plugin flow) do
    // not pollute the snapshot.
    const stagingAfter = await listStagingDirs();
    const ownPrefix = `${STAGING_DIR_PREFIX}install-plugin-activation-fail-plugin-`;
    expect(stagingAfter.filter((entry) => entry.startsWith(ownPrefix))).toEqual(
      stagingBefore.filter((entry) => entry.startsWith(ownPrefix))
    );
  });

  it('rejects with ConflictError when a colliding plugin directory already exists', async () => {
    // Pre-create a colliding install root so the conflict detector's
    // package-name rule fires.
    const collidingRoot = path.join(dorkHome, 'plugins', 'valid-plugin');
    await mkdir(collidingRoot, { recursive: true });
    const prevMarker = path.join(collidingRoot, 'prior-install.txt');
    await writeFile(prevMarker, 'prior install', 'utf-8');

    const harness = buildHarness(dorkHome);
    const stagingBefore = await listStagingDirs();

    await expect(
      harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-plugin') })
    ).rejects.toBeInstanceOf(ConflictError);

    // Pre-existing collision is still present and untouched.
    expect(await pathExists(collidingRoot)).toBe(true);
    expect(await readFile(prevMarker, 'utf-8')).toBe('prior install');

    // No other package directories were created under plugins/.
    const pluginsDir = await readdir(path.join(dorkHome, 'plugins'));
    expect(pluginsDir).toEqual(['valid-plugin']);

    // Conflict gate fires before the transaction engine opens a staging
    // directory. We deliberately do NOT compare staging snapshots here
    // because the package name (`valid-plugin`) collides with the
    // integration test's happy-path fixture, and parallel runs make any
    // global staging-snapshot comparison race-prone. The pre-existing
    // `plugins/valid-plugin/` integrity check above already proves the
    // gate fired before any flow disk activity.
    void stagingBefore;

    // Flow collaborators were not invoked — the gate blocks them.
    expect(harness.spies.extensionCompile).not.toHaveBeenCalled();
    expect(harness.spies.extensionEnable).not.toHaveBeenCalled();
  });

  it('bypasses the conflict gate when req.force is true and completes the install', async () => {
    // Plant a pre-existing plugin whose task SKILL shares its `name`
    // with the one in `valid-plugin`. The conflict detector's skill-name
    // rule fires an error-level conflict that would normally block the
    // install. With `force: true` the gate is bypassed and the atomic
    // rename can still succeed because the actual install root
    // (`plugins/valid-plugin`) is empty — the collision is only in a
    // sibling package's SKILL.md.
    const existingPluginRoot = path.join(dorkHome, 'plugins', 'existing-pkg');
    const existingSkillDir = path.join(existingPluginRoot, '.dork', 'tasks', 'sample-task');
    await mkdir(existingSkillDir, { recursive: true });
    await writeFile(
      path.join(existingSkillDir, 'SKILL.md'),
      [
        '---',
        'name: sample-task',
        'description: Planted by the failure-paths force-override test.',
        'kind: task',
        '---',
        '',
        '# Planted task',
        '',
      ].join('\n'),
      'utf-8'
    );

    const harness = buildHarness(dorkHome);

    // Sanity: the same install without `force` must throw ConflictError
    // so we are actually testing a bypass, not a no-op.
    await expect(
      harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-plugin') })
    ).rejects.toBeInstanceOf(ConflictError);

    // With `force: true` the gate is bypassed and the install completes.
    const result = await harness.installer.install({
      name: path.join(FIXTURES_DIR, 'valid-plugin'),
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('valid-plugin');
    expect(result.installPath).toBe(path.join(dorkHome, 'plugins', 'valid-plugin'));
    expect(
      await pathExists(path.join(dorkHome, 'plugins', 'valid-plugin', '.dork', 'manifest.json'))
    ).toBe(true);
    // The planted package is still on disk — `force` does not sweep
    // unrelated install state.
    expect(await pathExists(path.join(existingSkillDir, 'SKILL.md'))).toBe(true);
    expect(harness.spies.templateClone).not.toHaveBeenCalled();
  });
});
