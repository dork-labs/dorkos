/**
 * End-to-end integration tests for the marketplace install pipeline.
 *
 * Unlike the per-flow tests under `./flows/`, these exercise the
 * {@link MarketplaceInstaller} orchestrator with every real collaborator
 * wired in — resolver, cache, fetcher, validator, permission preview
 * builder, conflict detector, and all five type-specific install flows.
 * The wiring, and the list of external side-effect surfaces it stubs, lives
 * in `./installer-harness.ts`.
 *
 * Safety note: every test runs against a temp `dorkHome` created under
 * `os.tmpdir()` so no install writes to the live worktree. The file-scoped
 * transaction engine (ADR-0304) is target-scoped and git-free, so there is
 * no `git reset --hard` to guard against; the temp `dorkHome` is the only
 * isolation required.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initBoundary } from '../../../lib/boundary.js';
import type { MarketplaceInstaller } from '../marketplace-installer.js';
import { ADAPTER_PROJECT_PATH_IGNORED_WARNING } from '../flows/install-adapter.js';
import { SHAPE_PROJECT_PATH_IGNORED_WARNING } from '../flows/install-shape.js';
import {
  scanAgentLocalInstalls,
  scanInstallationRecords,
  scanInstallationsAcrossScopes,
  scanInstalledPackages,
} from '../installed-scanner.js';
import { buildInstallerForTests } from './installer-harness.js';
import { MarketplaceSourceManager } from '../marketplace-source-manager.js';
import { UpdateFlow } from '../flows/update.js';
import { noopLogger } from '@dorkos/shared/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the valid fixtures shipped alongside this test file. */
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/** Resolve the absolute path of a valid fixture directory. */
function fixturePath(
  name: 'valid-plugin' | 'valid-agent' | 'valid-skill-pack' | 'valid-adapter' | 'valid-shape'
) {
  return path.join(FIXTURES_DIR, name);
}

/** Returns true if `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('marketplace install pipeline — integration', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-marketplace-integration-'));
    // Pre-seed an empty `plugins/` so the rename activation in
    // install-plugin / install-skill-pack / install-adapter has a
    // parent that already exists on the first run.
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    // Local-path installs are boundary-confined, and every fixture this file
    // installs from lives under `FIXTURES_DIR` — so that is the boundary. What
    // the boundary REFUSES is `package-resolver.test.ts`'s subject.
    await initBoundary(FIXTURES_DIR);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
  });

  it('installs a plugin package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-plugin') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-plugin');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('plugin');
    expect(result.packageName).toBe('valid-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: manifest and the sample extension dir made the trip.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(
      await pathExists(path.join(expectedInstallRoot, '.dork', 'extensions', 'sample-ext'))
    ).toBe(true);
    expect(
      await pathExists(
        path.join(expectedInstallRoot, '.dork', 'extensions', 'sample-ext', 'extension.json')
      )
    ).toBe(true);

    // The fixture ships a structurally valid `extension.json` (id +
    // name + version + entry), so `discoverStagedExtensions` finds it
    // and the plugin flow runs the full compile + enable activation.
    // The compiler/manager spies stand in for the real subsystems —
    // the integration test just verifies the install pipeline reaches
    // them, not that they actually emit valid bundles.
    expect(spies.extensionCompile).toHaveBeenCalledTimes(1);
    expect(spies.extensionEnable).toHaveBeenCalledWith('sample-ext');

    // The template downloader must not have been invoked: local paths
    // resolve via `kind: 'local'` and skip the fetcher entirely.
    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('installs the same plugin end-to-end from its file:// spelling', async () => {
    // The other local spelling of the install above. It takes a different route
    // — the resolver reads `name@file:///…` as a git-shaped address and the
    // fetcher serves it from disk — and since DOR-1825 both routes ask the
    // directory boundary the same question. This is the half that has to keep
    // WORKING: a genuine local install inside the boundary, whichever way it is
    // spelled.
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({
      name: 'valid-plugin',
      source: pathToFileURL(fixturePath('valid-plugin')).href,
    });

    expect(result.ok).toBe(true);
    expect(result.type).toBe('plugin');
    expect(result.packageName).toBe('valid-plugin');
    expect(result.installPath).toBe(path.join(dorkHome, 'plugins', 'valid-plugin'));
    expect(
      await pathExists(path.join(dorkHome, 'plugins', 'valid-plugin', '.dork', 'manifest.json'))
    ).toBe(true);

    // Served from disk, never cloned — the `file://` branch of the fetcher.
    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('installs a shape package end-to-end via MarketplaceInstaller (staged, not activated)', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-shape') });

    const expectedInstallRoot = path.join(dorkHome, 'shapes', 'linear-ops');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('shape');
    expect(result.packageName).toBe('linear-ops');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: the Shape manifest landed under the shapes/ root.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);

    // Install STAGES a Shape; it never ACTIVATES one. The Linear Ops fixture
    // ships no inline extensions, and even a Shape that did would leave them
    // compiled-but-disabled — enabling is applyShape's job (spec §6.1). So no
    // extension is enabled by the install pipeline.
    expect(spies.extensionEnable).not.toHaveBeenCalled();

    // The template downloader must not have been invoked (local path).
    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('warns (but still installs globally) when a shape install request carries a projectPath (DOR-386)', async () => {
    // Shapes are global-only. A caller that requests an agent-scoped install
    // (MCP tool, HTTP route, CLI --project) must be told their scope choice
    // was ignored — via `installer.dispatchFlow` → `ShapeInstallFlow.install`
    // — rather than have it silently dropped.
    const { installer } = buildInstallerForTests(dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-shape-scoped-project-'));

    const result = await installer.install({ name: fixturePath('valid-shape'), projectPath });

    const expectedInstallRoot = path.join(dorkHome, 'shapes', 'linear-ops');
    expect(result.ok).toBe(true);
    // Still lands globally — the projectPath never changes the install root.
    expect(result.installPath).toBe(expectedInstallRoot);
    expect(result.warnings).toEqual([SHAPE_PROJECT_PATH_IGNORED_WARNING]);

    await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
  });

  it('installs an agent package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-agent') });

    const expectedInstallRoot = path.join(dorkHome, 'agents', 'valid-agent');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('agent');
    expect(result.packageName).toBe('valid-agent');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: the agent package contents moved onto the install root.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    // And its contents match the fixture (sanity check against drift).
    const installedManifestRaw = await readFile(
      path.join(expectedInstallRoot, '.dork', 'manifest.json'),
      'utf-8'
    );
    expect(JSON.parse(installedManifestRaw)).toMatchObject({
      name: 'valid-agent',
      type: 'agent',
    });

    // The flow must delegate to `createAgentWorkspace` with the
    // marketplace-specific `skipTemplateDownload: true` flag. The
    // traits from `agentDefaults.traits` must be forwarded verbatim.
    expect(spies.createAgentWorkspace).toHaveBeenCalledTimes(1);
    const callArgs = spies.createAgentWorkspace.mock.calls[0]?.[0] as {
      directory: string;
      name: string;
      skipTemplateDownload: boolean;
      traits: Record<string, number>;
    };
    expect(callArgs.directory).toBe(expectedInstallRoot);
    expect(callArgs.name).toBe('valid-agent');
    expect(callArgs.skipTemplateDownload).toBe(true);
    expect(callArgs.traits).toEqual({
      verbosity: 3,
      autonomy: 4,
      chaos: 3,
      creativity: 3,
      humor: 3,
      spice: 3,
    });

    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('installs a skill-pack package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-skill-pack') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-skill-pack');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('skill-pack');
    expect(result.packageName).toBe('valid-skill-pack');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: all three SKILL.md files from the fixture are present.
    for (const skill of ['analyzer', 'summarizer', 'translator']) {
      expect(await pathExists(path.join(expectedInstallRoot, 'skills', skill, 'SKILL.md'))).toBe(
        true
      );
    }
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);

    // No flows touched the adapter manager or agent creator.
    expect(spies.adapterAdd).not.toHaveBeenCalled();
    expect(spies.createAgentWorkspace).not.toHaveBeenCalled();
    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('installs an adapter package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-adapter') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-adapter');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('adapter');
    expect(result.packageName).toBe('valid-adapter');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);
    expect(result.warnings).toContain(
      'Configure secrets via dorkos relay-adapters set valid-adapter'
    );

    // Disk state: the adapter package contents moved onto the install root,
    // including the slack adapter's manifest and entry stub.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(
      await pathExists(
        path.join(expectedInstallRoot, '.dork', 'adapters', 'slack', 'manifest.json')
      )
    ).toBe(true);

    // The flow must register the adapter with AdapterManager.addAdapter,
    // passing the slack adapter's on-disk plugin path.
    expect(spies.adapterAdd).toHaveBeenCalledTimes(1);
    const addArgs = spies.adapterAdd.mock.calls[0];
    expect(addArgs?.[0]).toBe('slack');
    expect(addArgs?.[1]).toBe('valid-adapter');
    expect(addArgs?.[2]).toEqual({
      pluginPath: path.join(expectedInstallRoot, '.dork', 'adapters', 'slack'),
    });

    // A successful install must never call the compensating `removeAdapter`.
    expect(spies.adapterRemove).not.toHaveBeenCalled();
    expect(spies.gitFetch).not.toHaveBeenCalled();
  });

  it('warns (but still installs globally) when an adapter install request carries a projectPath (DOR-1776)', async () => {
    // Adapters are global-only (the relay's `relay-adapters.json` registry has
    // no per-project dimension). A caller that requests a project-scoped install
    // (MCP tool, HTTP route, CLI --project) must be told their scope choice was
    // ignored — via `installer.dispatchFlow` → `AdapterInstallFlow.install` —
    // rather than have it silently dropped. Mirrors DOR-386 for Shapes.
    const { installer } = buildInstallerForTests(dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-adapter-scoped-project-'));

    const result = await installer.install({ name: fixturePath('valid-adapter'), projectPath });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-adapter');
    expect(result.ok).toBe(true);
    // Still lands globally — the projectPath never changes the install root.
    expect(result.installPath).toBe(expectedInstallRoot);
    expect(result.warnings).toEqual([
      ADAPTER_PROJECT_PATH_IGNORED_WARNING,
      'Configure secrets via dorkos relay-adapters set valid-adapter',
    ]);

    await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // Roundtrip test — drives the full install → update → uninstall lifecycle
  // through one MarketplaceInstaller against a real fixture and asserts that
  // each step actually sees the package the previous step produced. This is
  // the missing contract test that closes the manifest-format gap (issue #1
  // from the Session 2 code review): if any flow ever drifts from
  // `.dork/manifest.json` again, this test breaks immediately.
  // ---------------------------------------------------------------------------
  it('install → update → uninstall roundtrip preserves install metadata across the full lifecycle', async () => {
    const { installer } = buildInstallerForTests(dorkHome);

    // 1. Install fresh.
    const installResult = await installer.install({
      name: fixturePath('valid-skill-pack'),
    });
    expect(installResult.ok).toBe(true);
    const installRoot = installResult.installPath;

    // 2. The install pipeline must have written `.dork/manifest.json` (the
    //    canonical manifest) AND `.dork/install-metadata.json` (the
    //    provenance sidecar). Both files are required for the update flow
    //    and the uninstall flow to find this package on subsequent calls.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'install-metadata.json'))).toBe(true);

    const metadataRaw = await readFile(
      path.join(installRoot, '.dork', 'install-metadata.json'),
      'utf-8'
    );
    const metadata: Record<string, unknown> = JSON.parse(metadataRaw) as Record<string, unknown>;
    expect(metadata.name).toBe('valid-skill-pack');
    expect(metadata.type).toBe('skill-pack');
    expect(metadata.version).toBe('1.0.0');
    expect(typeof metadata.installedAt).toBe('string');
    // Local-path installs have no marketplace, so installedFrom is absent.
    expect(metadata.installedFrom).toBeUndefined();
    // Local-path installs have no upstream git repo or resolved commit
    // (DOR-147) — the sidecar must omit these rather than fabricate them.
    expect(metadata.sourceRepo).toBeUndefined();
    expect(metadata.sourceRef).toBeUndefined();
    expect(metadata.commitSha).toBeUndefined();

    // 3. Plant some user state inside the install root that the data
    //    preservation contract must protect across the update.
    await mkdir(path.join(installRoot, '.dork', 'data'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'data', 'state.json'),
      '{"important":"keep me"}',
      'utf-8'
    );
    await writeFile(path.join(installRoot, '.dork', 'secrets.json'), '{"token":"shh"}', 'utf-8');

    // 4. Uninstall (no purge). The flow must locate the package via
    //    `.dork/manifest.json` (NOT `dork-package.json`) — if the lookup
    //    is broken, this throws PackageNotInstalledError. The data files
    //    we planted must be preserved.
    const uninstallResult = await installer['deps'].uninstallFlow.uninstall({
      name: 'valid-skill-pack',
    });
    expect(uninstallResult.ok).toBe(true);
    expect(uninstallResult.preservedData.length).toBeGreaterThan(0);

    // 5. The user state survived.
    expect(await pathExists(path.join(installRoot, '.dork', 'data', 'state.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'secrets.json'))).toBe(true);
  });

  // Apply-mode update path: install → installer.update() → fresh install
  // lands at the same install root with the user's `.dork/data/` and
  // `.dork/secrets.json` preserved. This is the contract documented by
  // ADR-0233 and the fix for issue #2 from the Session 2 code review.
  it('installer.update() reinstalls cleanly while preserving user data and secrets', async () => {
    const { installer } = buildInstallerForTests(dorkHome);

    // First install.
    const firstInstall = await installer.install({
      name: fixturePath('valid-skill-pack'),
    });
    const installRoot = firstInstall.installPath;

    // Plant user state that the data preservation contract must protect.
    await mkdir(path.join(installRoot, '.dork', 'data'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'data', 'preserve-me.json'),
      '{"v":42}',
      'utf-8'
    );
    await writeFile(
      path.join(installRoot, '.dork', 'secrets.json'),
      '{"key":"secret-value"}',
      'utf-8'
    );

    // Apply-mode update against the same fixture (simulates a "no-op
    // version bump" where the user explicitly opted into a reinstall).
    // Without the uninstall-then-install fix, this throws ENOTEMPTY at
    // the rename step because the previous install root is still on disk.
    // The orchestrator's `update()` runs the resolver first so it can
    // pass the canonical package name (`valid-skill-pack`) — derived
    // from the fixture path — to the uninstall flow's name-based lookup.
    const updateResult = await installer.update({
      name: fixturePath('valid-skill-pack'),
    });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.installPath).toBe(installRoot);

    // The fresh install landed and the user state survived.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'install-metadata.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'data', 'preserve-me.json'))).toBe(
      true
    );
    const preservedState = await readFile(
      path.join(installRoot, '.dork', 'data', 'preserve-me.json'),
      'utf-8'
    );
    expect(JSON.parse(preservedState)).toEqual({ v: 42 });

    expect(await pathExists(path.join(installRoot, '.dork', 'secrets.json'))).toBe(true);
    const preservedSecrets = await readFile(
      path.join(installRoot, '.dork', 'secrets.json'),
      'utf-8'
    );
    expect(JSON.parse(preservedSecrets)).toEqual({ key: 'secret-value' });
  });

  // DOR-147 happy path: a git-sourced install must persist real source
  // provenance (sourceRepo + commitSha) into the on-disk sidecar. Only the
  // git network boundary is stubbed — the harness's designated seam: the
  // lookup resolves the default branch to a fixed commit, and the fetch copies
  // the valid-plugin fixture and reports that commit, so the test is
  // deterministic offline. Everything downstream — cache materialization,
  // validation, the plugin flow, and the unmocked writeInstallMetadata — runs
  // for real against the temp dorkHome.
  it('records sourceRepo and commitSha in the on-disk sidecar for a git-sourced install', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);
    const gitUrl = 'https://example.com/valid-plugin.git';
    const commitSha = 'e2e0123456789abcdef0123456789abcdef01234';

    spies.gitLookup.mockResolvedValue({ kind: 'found', commitSha, refName: 'HEAD' });
    spies.gitFetch.mockImplementation(async (req: { destDir: string; commitSha: string }) => {
      await cp(fixturePath('valid-plugin'), req.destDir, { recursive: true });
      return req.commitSha;
    });

    const result = await installer.install({ name: 'valid-plugin', source: gitUrl });
    expect(result.ok).toBe(true);

    const metadataRaw = await readFile(
      path.join(result.installPath, '.dork', 'install-metadata.json'),
      'utf-8'
    );
    const metadata: Record<string, unknown> = JSON.parse(metadataRaw) as Record<string, unknown>;
    expect(metadata.sourceRepo).toBe(gitUrl);
    expect(metadata.commitSha).toBe(commitSha);
    // A direct git-URL install requests no explicit ref and has no
    // marketplace — both stay absent rather than being fabricated.
    expect(metadata.sourceRef).toBeUndefined();
    expect(metadata.installedFrom).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // DOR-994: a project-scoped AGENT install lands in `<projectPath>/.dork/
  // agents/<name>`, but the installed scanner and the uninstall probe used to
  // look only in `<projectPath>/.dork/plugins/`. The package was therefore
  // installable and then neither listable nor removable through the API. These
  // cases drive the real install flow so the fixture is whatever the product
  // actually writes, and assert on the DIRECTORY, not on a 200.
  // ---------------------------------------------------------------------------
  describe('project-scoped agent installs (DOR-994)', () => {
    /** Install `valid-agent` into a fresh temp project and return both paths. */
    async function installAgentIntoProject(
      installer: MarketplaceInstaller
    ): Promise<{ projectPath: string; installRoot: string }> {
      const projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-scoped-agent-project-'));
      const result = await installer.install({ name: fixturePath('valid-agent'), projectPath });
      expect(result.ok).toBe(true);
      // The premise the two blind spots hang off: agents really do nest under
      // the project's `agents/` root, not its `plugins/` one.
      expect(result.installPath).toBe(path.join(projectPath, '.dork', 'agents', 'valid-agent'));
      return { projectPath, installRoot: result.installPath };
    }

    it('lists a project-scoped agent in every installed view', async () => {
      const { installer } = buildInstallerForTests(dorkHome);
      const { projectPath, installRoot } = await installAgentIntoProject(installer);

      try {
        // 1. The merged single-project view (`GET /installed?projectPath=…`).
        const merged = await scanInstalledPackages(dorkHome, projectPath);
        expect(merged).toContainEqual(
          expect.objectContaining({
            name: 'valid-agent',
            type: 'agent',
            installPath: installRoot,
            scope: 'agent-local',
            agentPath: projectPath,
          })
        );

        // 2. The per-installation cross-scope view (`GET /installed`, and the
        //    `marketplace_list_installed` MCP tool).
        const across = await scanInstallationsAcrossScopes(dorkHome, [
          { projectPath, id: 'agent-1', name: 'Scoped Agent' },
        ]);
        expect(across).toContainEqual(
          expect.objectContaining({
            name: 'valid-agent',
            installPath: installRoot,
            scope: 'agent-local',
            agentId: 'agent-1',
            agentName: 'Scoped Agent',
          })
        );

        // 3. The orphaned-installs report shown when an agent is unregistered.
        const orphans = await scanAgentLocalInstalls(projectPath);
        expect(orphans.map((pkg) => pkg.installPath)).toContain(installRoot);
      } finally {
        await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('uninstalls a project-scoped agent off disk', async () => {
      const { installer } = buildInstallerForTests(dorkHome);
      const { projectPath, installRoot } = await installAgentIntoProject(installer);

      try {
        const result = await installer['deps'].uninstallFlow.uninstall({
          name: 'valid-agent',
          projectPath,
          purge: true,
        });

        expect(result.ok).toBe(true);
        // The directory is gone — a 200 that removed nothing is the failure
        // this assertion exists to catch.
        expect(await pathExists(installRoot)).toBe(false);
        expect(await scanInstalledPackages(dorkHome, projectPath)).toEqual([]);
      } finally {
        await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('keeps a global install of the same package listed and removable on its own', async () => {
      const { installer } = buildInstallerForTests(dorkHome);
      const globalResult = await installer.install({ name: fixturePath('valid-agent') });
      const globalRoot = path.join(dorkHome, 'agents', 'valid-agent');
      expect(globalResult.installPath).toBe(globalRoot);

      const { projectPath, installRoot } = await installAgentIntoProject(installer);

      try {
        // Both installations are visible, and the project one is tagged as
        // shadowing the global one rather than replacing it in the listing.
        const across = await scanInstallationsAcrossScopes(dorkHome, [{ projectPath }]);
        const agentEntries = across.filter((pkg) => pkg.name === 'valid-agent');
        expect(agentEntries.map((pkg) => [pkg.installPath, pkg.scope])).toEqual([
          [globalRoot, 'global'],
          [installRoot, 'override'],
        ]);

        // Removing the project copy leaves the global one untouched…
        await installer['deps'].uninstallFlow.uninstall({
          name: 'valid-agent',
          projectPath,
          purge: true,
        });
        expect(await pathExists(installRoot)).toBe(false);
        expect(await pathExists(globalRoot)).toBe(true);

        // …and the global one still uninstalls exactly as before.
        await installer['deps'].uninstallFlow.uninstall({ name: 'valid-agent', purge: true });
        expect(await pathExists(globalRoot)).toBe(false);
      } finally {
        await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    // The case `installKey` exists for, and the one a name-keyed merge gets
    // wrong in the most damaging direction: a global `plugins/X` and a
    // project `agents/X` are two DIFFERENT packages the conflict detector
    // allows to coexist (it warns, it does not block). Merging on the name
    // alone would drop one from the listing and point its uninstall at the
    // other. Both fixtures are copied to a temp source root — with directory
    // basenames matching their manifest names — so the shared name is real all
    // the way through validation.
    it('keeps a global plugin and a project agent of the SAME name apart', async () => {
      const { installer } = buildInstallerForTests(dorkHome);
      const sourceRoot = await mkdtemp(path.join(tmpdir(), 'dorkos-crossroot-src-'));
      const projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-crossroot-project-'));

      const globalSource = path.join(sourceRoot, 'global', 'valid-plugin');
      const scopedSource = path.join(sourceRoot, 'scoped', 'valid-plugin');
      await cp(fixturePath('valid-plugin'), globalSource, { recursive: true });
      await cp(fixturePath('valid-agent'), scopedSource, { recursive: true });

      // Give the agent package the plugin's name. Everything else about it —
      // including `type: 'agent'`, which is what sends it to `agents/` — stays.
      const scopedManifestPath = path.join(scopedSource, '.dork', 'manifest.json');
      const scopedManifest: Record<string, unknown> = JSON.parse(
        await readFile(scopedManifestPath, 'utf-8')
      ) as Record<string, unknown>;
      scopedManifest.name = 'valid-plugin';
      await writeFile(scopedManifestPath, JSON.stringify(scopedManifest, null, 2), 'utf-8');

      // Local-path installs are boundary-confined, and these two sources live
      // outside FIXTURES_DIR.
      await initBoundary(sourceRoot);

      try {
        const globalRoot = (await installer.install({ name: globalSource })).installPath;
        const scopedRoot = (await installer.install({ name: scopedSource, projectPath }))
          .installPath;
        expect(globalRoot).toBe(path.join(dorkHome, 'plugins', 'valid-plugin'));
        expect(scopedRoot).toBe(path.join(projectPath, '.dork', 'agents', 'valid-plugin'));

        // Merged view: two entries sharing a name, each keyed to its own root.
        const merged = await scanInstalledPackages(dorkHome, projectPath);
        expect(
          merged
            .filter((pkg) => pkg.name === 'valid-plugin')
            .map((pkg) => [pkg.installPath, pkg.type, pkg.scope])
        ).toEqual([
          [globalRoot, 'plugin', 'global'],
          [scopedRoot, 'agent', 'agent-local'],
        ]);

        // Cross-scope view: the project copy is `agent-local`, NOT `override` —
        // it shadows nothing, because no global `agents/valid-plugin` exists.
        const across = await scanInstallationsAcrossScopes(dorkHome, [{ projectPath }]);
        expect(
          across
            .filter((pkg) => pkg.name === 'valid-plugin')
            .map((pkg) => [pkg.installPath, pkg.scope])
        ).toEqual([
          [globalRoot, 'global'],
          [scopedRoot, 'agent-local'],
        ]);

        // A scoped uninstall reaches the project's agent and leaves the global
        // plugin alone; the global uninstall then still works.
        await installer['deps'].uninstallFlow.uninstall({
          name: 'valid-plugin',
          projectPath,
          purge: true,
        });
        expect(await pathExists(scopedRoot)).toBe(false);
        expect(await pathExists(globalRoot)).toBe(true);

        await installer['deps'].uninstallFlow.uninstall({ name: 'valid-plugin', purge: true });
        expect(await pathExists(globalRoot)).toBe(false);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
        await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  describe('update check against a local marketplace (DOR-2244)', () => {
    const MARKETPLACE = 'local-fixtures';
    let marketplaceRoot: string;

    beforeEach(async () => {
      // A file:// marketplace listing valid-plugin with NO entry version —
      // the shape dork-labs/marketplace publishes, and the shape the old
      // check answered "up to date" for forever.
      marketplaceRoot = await mkdtemp(path.join(tmpdir(), 'dorkos-update-marketplace-'));
      await cp(fixturePath('valid-plugin'), path.join(marketplaceRoot, 'plugins', 'valid-plugin'), {
        recursive: true,
      });
      await mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true });
      await writeFile(
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: MARKETPLACE,
          owner: { name: 'DorkOS tests' },
          plugins: [
            {
              name: 'valid-plugin',
              source: './plugins/valid-plugin',
              description: 'A valid plugin fixture',
            },
          ],
        })
      );
      await initBoundary(path.dirname(marketplaceRoot));
    });

    afterEach(async () => {
      await rm(marketplaceRoot, { recursive: true, force: true }).catch(() => undefined);
    });

    /** Set the package's version in the marketplace copy's two version files. */
    async function setMarketplaceVersion(manifest: string, plugin: string): Promise<void> {
      const pkg = path.join(marketplaceRoot, 'plugins', 'valid-plugin');
      for (const [file, version] of [
        [path.join(pkg, '.dork', 'manifest.json'), manifest],
        [path.join(pkg, '.claude-plugin', 'plugin.json'), plugin],
      ] as const) {
        const json = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...json, version }));
      }
    }

    /**
     * Install valid-plugin 1.0.0 from the marketplace — globally, plus into
     * each of `projectPaths` — and build a real UpdateFlow.
     */
    async function installAndBuildFlow(projectPaths: string[] = []): Promise<UpdateFlow> {
      const { installer, fetcher } = buildInstallerForTests(dorkHome);
      const sourceManager = new MarketplaceSourceManager(dorkHome);
      const source = await sourceManager.add({
        name: MARKETPLACE,
        source: pathToFileURL(marketplaceRoot).href,
      });
      await fetcher.fetchMarketplaceJson(source);
      await installer.install({ name: 'valid-plugin', marketplace: MARKETPLACE });
      for (const projectPath of projectPaths) {
        await installer.install({ name: 'valid-plugin', marketplace: MARKETPLACE, projectPath });
      }
      return new UpdateFlow({ dorkHome, installer, sourceManager, fetcher, logger: noopLogger });
    }

    it('finds a new version, applies it, and then reports current', async () => {
      // Purpose: the original DOR-2244 repro, end to end with the real
      // installer. Before this change the first check said "up to date".
      const flow = await installAndBuildFlow();
      await setMarketplaceVersion('1.1.0', '1.1.0');

      const advisory = await flow.run({ name: 'valid-plugin' });
      expect(advisory.checks).toEqual([
        expect.objectContaining({
          installedVersion: '1.0.0',
          latestVersion: '1.1.0',
          status: 'update-available',
          installedVersionSource: 'package',
          latestVersionSource: 'package',
          marketplace: MARKETPLACE,
        }),
      ]);

      const applied = await flow.run({ name: 'valid-plugin', apply: true });
      expect(applied.applied.map((a) => a.version)).toEqual(['1.1.0']);

      const rerun = await flow.run({ name: 'valid-plugin' });
      expect(rerun.checks[0]).toMatchObject({
        installedVersion: '1.1.0',
        latestVersion: '1.1.0',
        status: 'current',
      });
    });

    it('updates a global install where it is, even when asked from a project', async () => {
      // Purpose: the reproduced defect, with the real installer. An apply named
      // with a project used to delete the global install and reinstall it into
      // that project.
      const flow = await installAndBuildFlow();
      await setMarketplaceVersion('1.1.0', '1.1.0');
      const projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-update-project-'));

      try {
        const result = await flow.run({ name: 'valid-plugin', apply: true, projectPath });

        const globalRoot = path.join(dorkHome, 'plugins', 'valid-plugin');
        expect(result.applied.map((a) => a.installPath)).toEqual([globalRoot]);
        expect(await pathExists(globalRoot)).toBe(true);
        expect(await pathExists(path.join(projectPath, '.dork', 'plugins', 'valid-plugin'))).toBe(
          false
        );
      } finally {
        await rm(projectPath, { recursive: true, force: true });
      }
    });

    it('checks a global and an agent install of one package, and updates each where it is', async () => {
      // Purpose: the all-packages door end to end. One scan across scopes, two
      // results, both reinstalled in place, and a rerun that reads current.
      const agentPath = await mkdtemp(path.join(tmpdir(), 'dorkos-update-agent-'));
      try {
        const flow = await installAndBuildFlow([agentPath]);
        await setMarketplaceVersion('1.1.0', '1.1.0');
        const scan = () =>
          scanInstallationRecords(dorkHome, { agents: [{ projectPath: agentPath }] });

        const advisory = await flow.checkInstallations({ installations: await scan() });
        expect(advisory.checks.map((c) => [c.scope, c.status])).toEqual([
          ['global', 'update-available'],
          ['override', 'update-available'],
        ]);

        const { checks } = await flow.checkInstallations({
          installations: await scan(),
          apply: true,
        });
        expect(checks.map((c) => c.applied?.installPath)).toEqual([
          path.join(dorkHome, 'plugins', 'valid-plugin'),
          path.join(agentPath, '.dork', 'plugins', 'valid-plugin'),
        ]);

        const rerun = await flow.checkInstallations({ installations: await scan() });
        expect(rerun.checks.map((c) => [c.installedVersion, c.status])).toEqual([
          ['1.1.0', 'current'],
          ['1.1.0', 'current'],
        ]);
      } finally {
        await rm(agentPath, { recursive: true, force: true });
      }
    });

    it('leaves every installed package exactly as it was when only checking', async () => {
      // Purpose: the advisory door is a read. A newer version being available
      // must not change what is installed.
      const flow = await installAndBuildFlow();
      await setMarketplaceVersion('1.1.0', '1.1.0');
      const before = await scanInstallationsAcrossScopes(dorkHome, []);

      const { checks } = await flow.checkInstallations({
        installations: await scanInstallationRecords(dorkHome, { agents: [] }),
      });

      expect(checks[0]?.status).toBe('update-available');
      expect(await scanInstallationsAcrossScopes(dorkHome, [])).toEqual(before);
    });

    it('reports a new version with mismatched files as unknown, and keeps the install listed', async () => {
      // Purpose: a version DorkOS would refuse to install is never offered,
      // and the package already installed stays visible.
      const flow = await installAndBuildFlow();
      await setMarketplaceVersion('1.1.0', '1.2.0');

      const [check] = (await flow.run({ name: 'valid-plugin', apply: true })).checks;

      expect(check?.status).toBe('unknown');
      expect(check?.note).toContain("the new version can't be installed: ");
      expect(check?.note).toContain('.claude-plugin/plugin.json says 1.2.0');
      const listed = await scanInstalledPackages(dorkHome);
      expect(listed.find((p) => p.name === 'valid-plugin')?.version).toBe('1.0.0');
    });
  });
});
