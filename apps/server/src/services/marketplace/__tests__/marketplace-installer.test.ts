/**
 * Tests for {@link MarketplaceInstaller}.
 *
 * The orchestrator ties together resolver, fetcher, validator, preview
 * builder, and the four type-specific install flows. Every collaborator is
 * mocked here so the tests exercise the orchestrator's own logic — routing,
 * conflict gating, telemetry, error translation — without touching disk or
 * invoking the real transaction engine (which would otherwise run a
 * destructive `git reset --hard` on failure paths).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import type {
  AdapterPackageManifest,
  AgentPackageManifest,
  MarketplacePackageManifest,
  PluginPackageManifest,
  SkillPackPackageManifest,
} from '@dorkos/marketplace';
import type { InstallRequest, InstallResult, PermissionPreview } from '../types.js';
import type { ResolvedPackageSource } from '../package-resolver.js';

// Mock the validator module. Tests override `validatePackage.mockResolvedValue`
// per-case. Placed before the installer import so vi.mock hoisting captures it.
vi.mock('@dorkos/marketplace/package-validator', () => ({
  validatePackage: vi.fn(),
}));

// Mock the telemetry hook so we can assert events without stateful reporters.
vi.mock('../telemetry-hook.js', () => ({
  reportInstallEvent: vi.fn().mockResolvedValue(undefined),
}));

import { validatePackage } from '@dorkos/marketplace/package-validator';
import {
  ConflictError,
  InvalidPackageError,
  MarketplaceInstaller,
  type InstallerDeps,
} from '../marketplace-installer.js';
import { reportInstallEvent } from '../telemetry-hook.js';

const mockedValidatePackage = vi.mocked(validatePackage);
const mockedReportInstallEvent = vi.mocked(reportInstallEvent);

/** Build a no-op logger that satisfies the {@link Logger} interface. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a plugin manifest stub used by most test cases. */
function buildPluginManifest(
  overrides: Partial<PluginPackageManifest> = {}
): PluginPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'plugin',
    description: 'Plugin fixture',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    ...overrides,
  };
}

function buildAgentManifest(): AgentPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-agent',
    version: '1.0.0',
    type: 'agent',
    description: 'Agent fixture',
    tags: [],
    layers: [],
    requires: [],
  };
}

function buildSkillPackManifest(): SkillPackPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-skill-pack',
    version: '1.0.0',
    type: 'skill-pack',
    description: 'Skill-pack fixture',
    tags: [],
    layers: [],
    requires: [],
  };
}

function buildAdapterManifest(): AdapterPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-adapter',
    version: '1.0.0',
    type: 'adapter',
    adapterType: 'slack',
    description: 'Adapter fixture',
    tags: [],
    layers: [],
    requires: [],
  };
}

/** Build a clean preview with no conflicts and no warnings. */
function buildEmptyPreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

/** Build a successful InstallResult for a given manifest. */
function buildInstallResult(manifest: MarketplacePackageManifest): InstallResult {
  return {
    ok: true,
    packageName: manifest.name,
    version: manifest.version,
    type: manifest.type,
    installPath: `/fake/dorkhome/plugins/${manifest.name}`,
    manifest,
    warnings: [],
  };
}

/** Build mocked installer dependencies. Individual tests tweak specific mocks. */
function buildDeps(): {
  deps: InstallerDeps;
  resolver: { resolve: ReturnType<typeof vi.fn> };
  fetcher: { fetchFromGit: ReturnType<typeof vi.fn> };
  previewBuilder: { build: ReturnType<typeof vi.fn> };
  pluginFlow: { install: ReturnType<typeof vi.fn> };
  agentFlow: { install: ReturnType<typeof vi.fn> };
  skillPackFlow: { install: ReturnType<typeof vi.fn> };
  adapterFlow: { install: ReturnType<typeof vi.fn> };
  uninstallFlow: { uninstall: ReturnType<typeof vi.fn> };
  logger: Logger;
} {
  const resolver = { resolve: vi.fn() };
  const fetcher = { fetchFromGit: vi.fn() };
  const previewBuilder = { build: vi.fn() };
  const pluginFlow = { install: vi.fn() };
  const agentFlow = { install: vi.fn() };
  const skillPackFlow = { install: vi.fn() };
  const adapterFlow = { install: vi.fn() };
  const uninstallFlow = { uninstall: vi.fn() };
  const logger = buildLogger();

  const deps = {
    dorkHome: '/fake/dorkhome',
    resolver: resolver as unknown as InstallerDeps['resolver'],
    fetcher: fetcher as unknown as InstallerDeps['fetcher'],
    previewBuilder: previewBuilder as unknown as InstallerDeps['previewBuilder'],
    pluginFlow: pluginFlow as unknown as InstallerDeps['pluginFlow'],
    agentFlow: agentFlow as unknown as InstallerDeps['agentFlow'],
    skillPackFlow: skillPackFlow as unknown as InstallerDeps['skillPackFlow'],
    adapterFlow: adapterFlow as unknown as InstallerDeps['adapterFlow'],
    uninstallFlow: uninstallFlow as unknown as InstallerDeps['uninstallFlow'],
    logger,
  };

  return {
    deps,
    resolver,
    fetcher,
    previewBuilder,
    pluginFlow,
    agentFlow,
    skillPackFlow,
    adapterFlow,
    uninstallFlow,
    logger,
  };
}

/** Configure a resolver + fetcher combo that returns a local package. */
function wireLocalResolution(
  resolver: { resolve: ReturnType<typeof vi.fn> },
  packageName: string,
  localPath = '/tmp/pkg'
): void {
  const resolved: ResolvedPackageSource = {
    kind: 'local',
    packageName,
    localPath,
  };
  resolver.resolve.mockResolvedValue(resolved);
}

/** Configure a resolver + fetcher combo that returns a git-backed package. */
function wireGitResolution(
  resolver: { resolve: ReturnType<typeof vi.fn> },
  fetcher: { fetchFromGit: ReturnType<typeof vi.fn> },
  packageName: string,
  marketplaceName: string,
  fetchedPath = '/tmp/cached-pkg'
): void {
  const resolved: ResolvedPackageSource = {
    kind: 'marketplace',
    packageName,
    marketplaceName,
    gitUrl: `https://example.com/${packageName}.git`,
  };
  resolver.resolve.mockResolvedValue(resolved);
  fetcher.fetchFromGit.mockResolvedValue({
    path: fetchedPath,
    commitSha: 'abc123',
    fromCache: false,
  });
}

describe('MarketplaceInstaller', () => {
  beforeEach(() => {
    mockedValidatePackage.mockReset();
    mockedReportInstallEvent.mockReset();
    mockedReportInstallEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('install()', () => {
    it('installs a local plugin end-to-end and reports success telemetry', async () => {
      const { deps, resolver, pluginFlow, previewBuilder } = buildDeps();
      const manifest = buildPluginManifest({ name: 'hello-plugin' });
      const installResult = buildInstallResult(manifest);

      wireLocalResolution(resolver, 'hello-plugin', '/tmp/hello-plugin');
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      pluginFlow.install.mockResolvedValue(installResult);

      const installer = new MarketplaceInstaller(deps);
      const req: InstallRequest = { name: 'hello-plugin' };
      const result = await installer.install(req);

      expect(result).toEqual(installResult);
      expect(mockedValidatePackage).toHaveBeenCalledWith('/tmp/hello-plugin');
      expect(previewBuilder.build).toHaveBeenCalledWith(
        '/tmp/hello-plugin',
        manifest,
        expect.objectContaining({ projectPath: undefined })
      );
      expect(pluginFlow.install).toHaveBeenCalledWith('/tmp/hello-plugin', manifest, req);
      expect(mockedReportInstallEvent).toHaveBeenCalledTimes(1);
      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          packageName: 'hello-plugin',
          type: 'plugin',
          outcome: 'success',
          marketplace: '<direct>',
        })
      );
    });

    it('fetches from git when the resolved package is not local', async () => {
      const { deps, resolver, fetcher, pluginFlow, previewBuilder } = buildDeps();
      const manifest = buildPluginManifest({ name: 'git-plugin' });

      wireGitResolution(
        resolver,
        fetcher,
        'git-plugin',
        'dorkos-community',
        '/tmp/cached/git-plugin'
      );
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      pluginFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      await installer.install({ name: 'git-plugin', marketplace: 'dorkos-community' });

      expect(fetcher.fetchFromGit).toHaveBeenCalledWith({
        packageName: 'git-plugin',
        gitUrl: 'https://example.com/git-plugin.git',
        force: undefined,
      });
      expect(mockedValidatePackage).toHaveBeenCalledWith('/tmp/cached/git-plugin');
      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          marketplace: 'dorkos-community',
          outcome: 'success',
        })
      );
    });

    it('forwards req.force to fetcher.fetchFromGit', async () => {
      const { deps, resolver, fetcher, pluginFlow, previewBuilder } = buildDeps();
      const manifest = buildPluginManifest({ name: 'git-plugin' });

      wireGitResolution(resolver, fetcher, 'git-plugin', 'dorkos-community');
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      pluginFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      await installer.install({ name: 'git-plugin', marketplace: 'dorkos-community', force: true });

      expect(fetcher.fetchFromGit).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });

    it('throws InvalidPackageError on validation failure and reports failure telemetry', async () => {
      const { deps, resolver, pluginFlow } = buildDeps();
      wireLocalResolution(resolver, 'broken-plugin');
      mockedValidatePackage.mockResolvedValue({
        ok: false,
        issues: [
          { level: 'error', code: 'MANIFEST_MISSING', message: 'Required file missing' },
          { level: 'warning', code: 'NAME_DIRECTORY_MISMATCH', message: 'Directory mismatch' },
        ],
      });

      const installer = new MarketplaceInstaller(deps);

      await expect(installer.install({ name: 'broken-plugin' })).rejects.toBeInstanceOf(
        InvalidPackageError
      );
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          errorCode: 'InvalidPackageError',
          packageName: 'broken-plugin',
        })
      );
    });

    it('throws ConflictError when preview contains error-level conflicts and force is false', async () => {
      const { deps, resolver, previewBuilder, pluginFlow } = buildDeps();
      const manifest = buildPluginManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(
        buildEmptyPreview({
          conflicts: [
            {
              level: 'error',
              type: 'slot',
              description: 'Slot panel.sidebar already bound by other-plugin',
              conflictingPackage: 'other-plugin',
            },
          ],
        })
      );

      const installer = new MarketplaceInstaller(deps);
      await expect(installer.install({ name: manifest.name })).rejects.toBeInstanceOf(
        ConflictError
      );
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          errorCode: 'ConflictError',
        })
      );
    });

    it('proceeds through conflicts when req.force is true', async () => {
      const { deps, resolver, previewBuilder, pluginFlow } = buildDeps();
      const manifest = buildPluginManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(
        buildEmptyPreview({
          conflicts: [
            {
              level: 'error',
              type: 'slot',
              description: 'Slot conflict',
            },
          ],
        })
      );
      pluginFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      const result = await installer.install({ name: manifest.name, force: true });

      expect(result.ok).toBe(true);
      expect(pluginFlow.install).toHaveBeenCalledTimes(1);
      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('allows install when conflicts are warning-level only', async () => {
      const { deps, resolver, previewBuilder, pluginFlow } = buildDeps();
      const manifest = buildPluginManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(
        buildEmptyPreview({
          conflicts: [{ level: 'warning', type: 'slot', description: 'Cosmetic slot overlap' }],
        })
      );
      pluginFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      const result = await installer.install({ name: manifest.name });

      expect(result.ok).toBe(true);
      expect(pluginFlow.install).toHaveBeenCalledTimes(1);
    });

    it('dispatches agent packages to agentFlow', async () => {
      const { deps, resolver, previewBuilder, agentFlow, pluginFlow, skillPackFlow, adapterFlow } =
        buildDeps();
      const manifest = buildAgentManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      agentFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      await installer.install({ name: manifest.name });

      expect(agentFlow.install).toHaveBeenCalledTimes(1);
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(skillPackFlow.install).not.toHaveBeenCalled();
      expect(adapterFlow.install).not.toHaveBeenCalled();
    });

    it('dispatches skill-pack packages to skillPackFlow', async () => {
      const { deps, resolver, previewBuilder, agentFlow, pluginFlow, skillPackFlow, adapterFlow } =
        buildDeps();
      const manifest = buildSkillPackManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      skillPackFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      await installer.install({ name: manifest.name });

      expect(skillPackFlow.install).toHaveBeenCalledTimes(1);
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(agentFlow.install).not.toHaveBeenCalled();
      expect(adapterFlow.install).not.toHaveBeenCalled();
    });

    it('dispatches adapter packages to adapterFlow', async () => {
      const { deps, resolver, previewBuilder, agentFlow, pluginFlow, skillPackFlow, adapterFlow } =
        buildDeps();
      const manifest = buildAdapterManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());
      adapterFlow.install.mockResolvedValue(buildInstallResult(manifest));

      const installer = new MarketplaceInstaller(deps);
      await installer.install({ name: manifest.name });

      expect(adapterFlow.install).toHaveBeenCalledTimes(1);
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(agentFlow.install).not.toHaveBeenCalled();
      expect(skillPackFlow.install).not.toHaveBeenCalled();
    });

    it('reports failure telemetry when a flow throws', async () => {
      const { deps, resolver, previewBuilder, pluginFlow } = buildDeps();
      const manifest = buildPluginManifest();
      wireLocalResolution(resolver, manifest.name);
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(buildEmptyPreview());

      class FlowFailure extends Error {
        constructor() {
          super('atomic rename failed');
          this.name = 'FlowFailure';
        }
      }
      pluginFlow.install.mockRejectedValue(new FlowFailure());

      const installer = new MarketplaceInstaller(deps);
      await expect(installer.install({ name: manifest.name })).rejects.toThrow(
        'atomic rename failed'
      );

      expect(mockedReportInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          errorCode: 'FlowFailure',
        })
      );
    });
  });

  describe('preview()', () => {
    it('returns the preview, manifest, and packagePath without dispatching any flow', async () => {
      const { deps, resolver, previewBuilder, pluginFlow } = buildDeps();
      const manifest = buildPluginManifest({ name: 'preview-plugin' });
      const preview = buildEmptyPreview({
        fileChanges: [{ path: '/foo/bar', action: 'create' }],
      });

      wireLocalResolution(resolver, 'preview-plugin', '/tmp/preview-plugin');
      mockedValidatePackage.mockResolvedValue({ ok: true, issues: [], manifest });
      previewBuilder.build.mockResolvedValue(preview);

      const installer = new MarketplaceInstaller(deps);
      const result = await installer.preview({ name: 'preview-plugin' });

      expect(result).toEqual({
        preview,
        manifest,
        packagePath: '/tmp/preview-plugin',
      });
      expect(pluginFlow.install).not.toHaveBeenCalled();
      expect(mockedReportInstallEvent).not.toHaveBeenCalled();
    });

    it('throws InvalidPackageError when validation fails without emitting telemetry', async () => {
      const { deps, resolver } = buildDeps();
      wireLocalResolution(resolver, 'broken-preview');
      mockedValidatePackage.mockResolvedValue({
        ok: false,
        issues: [{ level: 'error', code: 'MANIFEST_MISSING', message: 'missing' }],
      });

      const installer = new MarketplaceInstaller(deps);
      await expect(installer.preview({ name: 'broken-preview' })).rejects.toBeInstanceOf(
        InvalidPackageError
      );
      expect(mockedReportInstallEvent).not.toHaveBeenCalled();
    });
  });

  describe('error classes', () => {
    it('InvalidPackageError preserves the issue messages', () => {
      const err = new InvalidPackageError(['issue one', 'issue two']);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('InvalidPackageError');
      expect(err.errors).toEqual(['issue one', 'issue two']);
      expect(err.message).toContain('issue one');
      expect(err.message).toContain('issue two');
    });

    it('ConflictError preserves only error-level conflicts in the message', () => {
      const err = new ConflictError([
        { level: 'error', type: 'slot', description: 'slot collision' },
        { level: 'warning', type: 'slot', description: 'cosmetic warning' },
      ]);
      expect(err.name).toBe('ConflictError');
      expect(err.conflicts).toHaveLength(2);
      expect(err.message).toContain('slot collision');
      expect(err.message).not.toContain('cosmetic warning');
    });
  });
});
