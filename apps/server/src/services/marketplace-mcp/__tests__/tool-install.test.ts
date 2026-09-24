import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';

import { initBoundary } from '../../../lib/boundary.js';
import { createInstallHandler, InstallInputSchema } from '../tool-install.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import { SHAPE_PROJECT_PATH_IGNORED_WARNING } from '../../marketplace/flows/install-shape.js';
import {
  ConflictError,
  InvalidPackageError,
  type InstallerLike,
  type PreviewResult,
} from '../../marketplace/marketplace-installer.js';
import type {
  ConflictReport,
  InstallRequest,
  InstallResult,
  PermissionPreview,
} from '../../marketplace/types.js';
import {
  InAppConfirmationProvider,
  TokenConfirmationProvider,
  type ConfirmationProvider,
  type ConfirmationRequest,
  type ConfirmationResult,
} from '../confirmation-provider.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../core/approvals/index.js';

/**
 * A token provider over a fresh approval store, plus the two things the cockpit
 * does with a pending approval. Decisions go through the store by approval id —
 * the provider has no decide-by-token path, because the agent holds the token.
 */
function buildTokenProvider() {
  const approvals = new ApprovalService(createTestDb());
  return {
    provider: new TokenConfirmationProvider(approvals),
    /** Grant every pending approval, the way the cockpit's Allow button does. */
    grantPending: () => {
      for (const pending of approvals.listPending()) approvals.grant(pending.approvalId);
    },
    /** Deny every pending approval, with an optional reason. */
    denyPending: (reason?: string) => {
      for (const pending of approvals.listPending()) approvals.deny(pending.approvalId, reason);
    },
  };
}

/**
 * In-memory `ConfirmationProvider` test double. Tests can pre-program the
 * status returned by `requestInstallConfirmation()` and `resolveToken()` and
 * inspect the calls each receives.
 */
class FakeConfirmationProvider implements ConfirmationProvider {
  requestInstallConfirmation = vi.fn<(req: ConfirmationRequest) => Promise<ConfirmationResult>>();
  resolveToken = vi.fn<(token: string) => Promise<ConfirmationResult>>();
}

/**
 * Build a minimal `PermissionPreview` with sensible defaults. Tests override
 * only the fields they care about.
 */
function permissionPreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    skippedLinks: [],
    unreadableDeclarations: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

/**
 * Build a minimal valid `MarketplacePackageManifest` for canned preview
 * results returned by the stub installer.
 */
function manifest(overrides: { name: string; version?: string }): MarketplacePackageManifest {
  return {
    manifestVersion: 1,
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    type: 'plugin',
    description: 'A package',
  } as MarketplacePackageManifest;
}

/**
 * Build a canned `PreviewResult` (the tuple returned by
 * {@link InstallerLike.preview}) with sensible defaults.
 */
/** An empty staged package directory every canned preview points at. */
const STAGED_DIR = mkdtempSync(join(tmpdir(), 'tool-install-staged-'));

function previewResult(overrides: {
  name: string;
  version?: string;
  preview?: PermissionPreview;
  packagePath?: string;
}): PreviewResult {
  return {
    preview: overrides.preview ?? permissionPreview(),
    manifest: manifest({ name: overrides.name, version: overrides.version }),
    // A real, empty directory: the install hashes the staged files it approves.
    packagePath: overrides.packagePath ?? STAGED_DIR,
  };
}

/**
 * Build a canned `InstallResult` with sensible defaults.
 */
function installResult(overrides: Partial<InstallResult> & { packageName: string }): InstallResult {
  return {
    ok: true,
    packageName: overrides.packageName,
    version: overrides.version ?? '1.0.0',
    type: overrides.type ?? 'plugin',
    installPath: overrides.installPath ?? `/tmp/.dork-test/plugins/${overrides.packageName}`,
    manifest:
      overrides.manifest ?? manifest({ name: overrides.packageName, version: overrides.version }),
    warnings: overrides.warnings ?? [],
    ...overrides,
  };
}

/**
 * Stub `InstallerLike` that records calls and yields canned responses. The
 * stub is intentionally minimal — it never reaches the real transaction
 * engine, which is file-scoped and git-free (ADR-0304).
 */
function createStubInstaller(canned: {
  preview?: PreviewResult | Error;
  install?: InstallResult | Error;
}): InstallerLike & {
  preview: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const preview = vi.fn(async (_req: InstallRequest): Promise<PreviewResult> => {
    if (!canned.preview) {
      throw new Error('No canned preview() result configured');
    }
    if (canned.preview instanceof Error) {
      throw canned.preview;
    }
    return canned.preview;
  });
  const install = vi.fn(async (_req: InstallRequest): Promise<InstallResult> => {
    if (!canned.install) {
      throw new Error('No canned install() result configured');
    }
    if (canned.install instanceof Error) {
      throw canned.install;
    }
    return canned.install;
  });
  const update = vi.fn(async (_req: InstallRequest): Promise<InstallResult> => {
    throw new Error('update() should not be called by the install handler');
  });
  return { preview, install, update };
}

/**
 * Build a `MarketplaceMcpDeps` populated only with the fields the install
 * handler reads (`installer`, `confirmationProvider`, `logger`). Other fields
 * are stubbed via `unknown` casts so the cast is local to this helper.
 */
function createStubDeps(opts: {
  confirmationProvider: ConfirmationProvider;
  installer: InstallerLike;
  onPluginsChanged?: MarketplaceMcpDeps['onPluginsChanged'];
}): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/.dork-test',
    installer: opts.installer,
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: opts.confirmationProvider,
    onPluginsChanged: opts.onPluginsChanged ?? vi.fn(),
    consent: { settle: vi.fn(async () => {}), removed: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

/**
 * Parse the JSON payload out of an MCP `text` content block — every handler
 * in this directory wraps its response in `{ content: [{ type: 'text', text }] }`.
 */
function parseToolPayload<T = unknown>(result: { content: { type: 'text'; text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

/**
 * Point the directory boundary at a fresh temp root and return an in-bounds
 * project path under it. The install handler confines `projectPath` the same
 * way the HTTP route does, so tests that pass one have to be inside a boundary.
 */
async function boundedProjectPath(): Promise<string> {
  // Realpath'd, because the handler hands its effects the canonical path and
  // macOS's tmpdir (`/var/…`) is itself a symlink to `/private/var/…`.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-install-boundary-')));
  await initBoundary(root);
  return join(root, 'some-project');
}

describe('InstallInputSchema', () => {
  it('exports a Zod-compatible shape with name + optional fields', () => {
    expect(InstallInputSchema).toHaveProperty('name');
    expect(InstallInputSchema).toHaveProperty('marketplace');
    expect(InstallInputSchema).toHaveProperty('projectPath');
    expect(InstallInputSchema).toHaveProperty('confirmationToken');
  });
});

describe('createInstallHandler — path safety', () => {
  it('refuses a projectPath outside the directory boundary, before any preview', async () => {
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry' }),
    });
    const provider = new InAppConfirmationProvider(vi.fn());
    const deps = createStubDeps({ confirmationProvider: provider, installer });
    await boundedProjectPath();
    const outside = await mkdtemp(join(tmpdir(), 'mcp-install-outside-'));

    try {
      const handler = createInstallHandler(deps);
      const result = await handler({ name: 'sentry', projectPath: outside });

      expect(result.isError).toBe(true);
      expect(parseToolPayload<{ code: string }>(result).code).toBe('OUTSIDE_BOUNDARY');
      // The preview clones the package to disk, so refusing after it would
      // have done the fetch for a request that was never going to be honored.
      expect(installer.preview).not.toHaveBeenCalled();
      expect(installer.install).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('createInstallHandler — in-app approve happy path', () => {
  let installer: ReturnType<typeof createStubInstaller>;
  let callback: ReturnType<typeof vi.fn>;
  let provider: InAppConfirmationProvider;
  let deps: MarketplaceMcpDeps;

  beforeEach(() => {
    installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry', version: '1.2.3' }),
    });
    callback = vi.fn(async () => ({ status: 'approved' as const }));
    provider = new InAppConfirmationProvider(callback);
    deps = createStubDeps({ confirmationProvider: provider, installer });
  });

  it('returns status: installed with package details when approved', async () => {
    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      package: { name: string; version: string; type: string };
      installPath: string;
      warnings: string[];
    }>(result);
    expect(payload.status).toBe('installed');
    expect(payload.package).toEqual({ name: 'sentry', version: '1.2.3', type: 'plugin' });
    expect(payload.installPath).toBe('/tmp/.dork-test/plugins/sentry');
    expect(payload.warnings).toEqual([]);
  });

  it('builds the preview before requesting confirmation', async () => {
    const order: string[] = [];
    installer.preview.mockImplementation(async () => {
      order.push('preview');
      return previewResult({ name: 'sentry' });
    });
    callback.mockImplementation(async () => {
      order.push('confirmation');
      return { status: 'approved' as const };
    });
    installer.install.mockImplementation(async () => {
      order.push('install');
      return installResult({ packageName: 'sentry' });
    });

    const handler = createInstallHandler(deps);
    await handler({ name: 'sentry' });

    expect(order).toEqual(['preview', 'confirmation', 'install']);
  });

  it('passes the package name and preview through requestInstallConfirmation', async () => {
    const handler = createInstallHandler(deps);
    await handler({ name: 'sentry', marketplace: 'dorkos-community' });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: 'sentry',
        marketplace: 'dorkos-community',
        operation: 'install',
        preview: expect.any(Object),
      })
    );
  });

  it('forwards marketplace and projectPath to installer.install()', async () => {
    const projectPath = await boundedProjectPath();
    const handler = createInstallHandler(deps);
    await handler({
      name: 'sentry',
      marketplace: 'dorkos-community',
      projectPath,
    });

    expect(installer.install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sentry',
        marketplace: 'dorkos-community',
        projectPath,
      })
    );
  });

  it('surfaces warnings from the underlying install result', async () => {
    installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({
        packageName: 'sentry',
        warnings: ['something subtle happened'],
      }),
    });
    deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    const payload = parseToolPayload<{ warnings: string[] }>(result);
    expect(payload.warnings).toEqual(['something subtle happened']);
  });

  it('surfaces the Shape scope-ignored warning in the tool result text (DOR-386)', async () => {
    // Regression for DOR-386: an MCP caller that installs a Shape with a
    // projectPath must see the scope-ignored warning in the tool response,
    // not just have it dropped on the floor after a silently-global install.
    installer = createStubInstaller({
      preview: previewResult({ name: 'linear-ops' }),
      install: installResult({
        packageName: 'linear-ops',
        type: 'shape',
        warnings: [SHAPE_PROJECT_PATH_IGNORED_WARNING],
      }),
    });
    deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({
      name: 'linear-ops',
      projectPath: await boundedProjectPath(),
    });

    const payload = parseToolPayload<{ status: string; warnings: string[] }>(result);
    expect(payload.status).toBe('installed');
    expect(payload.warnings).toEqual([SHAPE_PROJECT_PATH_IGNORED_WARNING]);
  });
});

describe('createInstallHandler — token resume flow', () => {
  it('returns requires_confirmation + token + preview on first call from external client', async () => {
    const { provider: tokenProvider } = buildTokenProvider();
    const installer = createStubInstaller({
      preview: previewResult({
        name: 'sentry',
        preview: permissionPreview({
          externalHosts: ['sentry.io'],
        }),
      }),
      install: installResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      preview: PermissionPreview;
      confirmationToken: string;
      message: string;
    }>(result);
    expect(payload.status).toBe('requires_confirmation');
    expect(payload.confirmationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.message).toContain('confirmationToken');
    expect(payload.preview.externalHosts).toEqual(['sentry.io']);
    // The flow must NOT have run yet — the user still has to approve.
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('proceeds with install when re-called with an approved token', async () => {
    const { provider: tokenProvider, grantPending } = buildTokenProvider();
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry', version: '2.0.0' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, installer });
    const handler = createInstallHandler(deps);

    // First call → pending token.
    const first = await handler({ name: 'sentry' });
    const { confirmationToken } = parseToolPayload<{ confirmationToken: string }>(first);

    // Out-of-band approval (simulates the DorkOS UI clicking Approve).
    grantPending();

    // Second call → handler must use the token, NOT issue a new request.
    const requestSpy = vi.spyOn(tokenProvider, 'requestInstallConfirmation');
    const second = await handler({ name: 'sentry', confirmationToken });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(second.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      package: { name: string; version: string };
    }>(second);
    expect(payload.status).toBe('installed');
    expect(payload.package.version).toBe('2.0.0');
    expect(installer.install).toHaveBeenCalledTimes(1);
  });
});

describe('createInstallHandler — declined', () => {
  it('returns status: declined with reason when the user declines via in-app provider', async () => {
    const callback = vi.fn(async () => ({ status: 'declined' as const, reason: 'Not now' }));
    const provider = new InAppConfirmationProvider(callback);
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ status: string; reason: string }>(result);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('Not now');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('falls back to a default reason when the provider omits one', async () => {
    const provider = new FakeConfirmationProvider();
    provider.requestInstallConfirmation.mockResolvedValue({ status: 'declined' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    const payload = parseToolPayload<{ status: string; reason: string }>(result);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toMatch(/declined/i);
  });

  it('returns declined when a token resolves to declined', async () => {
    const { provider: tokenProvider, denyPending } = buildTokenProvider();
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, installer });
    const handler = createInstallHandler(deps);

    const first = await handler({ name: 'sentry' });
    const { confirmationToken } = parseToolPayload<{ confirmationToken: string }>(first);
    denyPending('Changed my mind');

    const second = await handler({ name: 'sentry', confirmationToken });
    const payload = parseToolPayload<{ status: string; reason: string }>(second);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('Changed my mind');
    expect(installer.install).not.toHaveBeenCalled();
  });
});

describe('createInstallHandler — error mapping', () => {
  it('maps ConflictError to code CONFLICT and surfaces the conflicts list', async () => {
    const conflicts: ConflictReport[] = [
      {
        level: 'error',
        type: 'skill-name',
        description: 'a skill named "sentry-sync" is already installed',
        conflictingPackage: 'sentry',
      },
    ];
    const provider = new FakeConfirmationProvider();
    provider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: new ConflictError(conflicts),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{
      error: string;
      code: string;
      conflicts: ConflictReport[];
    }>(result);
    expect(payload.code).toBe('CONFLICT');
    expect(payload.conflicts).toEqual(conflicts);
    expect(payload.error).toContain('Install blocked by conflicts');
  });

  it('maps InvalidPackageError to code INVALID_PACKAGE and surfaces validator errors', async () => {
    const errors = ['manifest.json missing required field "name"'];
    const provider = new FakeConfirmationProvider();
    provider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: new InvalidPackageError(errors),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string; errors: string[] }>(result);
    expect(payload.code).toBe('INVALID_PACKAGE');
    expect(payload.errors).toEqual(errors);
  });

  it('maps any other install error to code INSTALL_FAILED', async () => {
    const provider = new FakeConfirmationProvider();
    provider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: new Error('disk on fire'),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string }>(result);
    expect(payload.code).toBe('INSTALL_FAILED');
    expect(payload.error).toContain('disk on fire');
  });

  it('short-circuits when preview() throws — no confirmation requested, no install', async () => {
    const provider = new FakeConfirmationProvider();
    const installer = createStubInstaller({
      preview: new Error('package not found in any marketplace'),
      install: installResult({ packageName: 'ghost' }),
    });
    const deps = createStubDeps({ confirmationProvider: provider, installer });

    const handler = createInstallHandler(deps);
    const result = await handler({ name: 'ghost' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string }>(result);
    expect(payload.code).toBe('INSTALL_FAILED');
    expect(payload.error).toContain('package not found');
    expect(provider.requestInstallConfirmation).not.toHaveBeenCalled();
    expect(installer.install).not.toHaveBeenCalled();
  });
});

// DOR-2306: a person who read the card and said yes has approved exactly what
// the package runs, so a global install of it loads into sessions without a
// second card. Nobody else's yes is recorded.
describe('createInstallHandler — settling consent after the install (DOR-2306)', () => {
  let confirmationProvider: FakeConfirmationProvider;

  beforeEach(() => {
    confirmationProvider = new FakeConfirmationProvider();
  });

  function stubs() {
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });
    const onPluginsChanged = vi.fn();
    const deps = createStubDeps({ confirmationProvider, installer, onPluginsChanged });
    return { deps, onPluginsChanged, installer };
  }

  it('settles a granted global install with what the card showed, before the refresh', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const { deps, onPluginsChanged } = stubs();

    await createInstallHandler(deps)({ name: 'flow' });

    const settle = vi.mocked(deps.consent.settle);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ global: true });
    expect(settle.mock.calls[0]?.[1]).toEqual({
      disclosed: expect.objectContaining({ hooks: [] }),
      contentHash: expect.stringMatching(/^sha256:/),
    });
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(
      onPluginsChanged.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('binds the card to the staged files it describes', async () => {
    // Purpose: a card granted for one set of bytes must not cover another.
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const { deps } = stubs();

    await createInstallHandler(deps)({ name: 'flow' });

    expect(confirmationProvider.requestInstallConfirmation.mock.calls[0]?.[0]).toMatchObject({
      contentHash: expect.stringMatching(/^sha256:/),
      origin: { version: '1.0.0' },
    });
  });

  it('says a project install is not global', async () => {
    const projectPath = await boundedProjectPath();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const { deps } = stubs();

    await createInstallHandler(deps)({ name: 'flow', projectPath });

    expect(vi.mocked(deps.consent.settle).mock.calls[0]?.[0]).toMatchObject({ global: false });
  });

  it('settles with no approval when the tier gate skipped the card: nobody was shown anything', async () => {
    const { deps } = stubs();

    await createInstallHandler(deps)({ name: 'flow' }, { preApproved: true });

    expect(vi.mocked(deps.consent.settle).mock.calls[0]?.[1]).toBeUndefined();
  });

  it('settles nothing while the card waits', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({
      status: 'pending',
      token: 'tok-1',
    });
    const { deps } = stubs();

    await createInstallHandler(deps)({ name: 'flow' });

    expect(deps.consent.settle).not.toHaveBeenCalled();
  });
});

// DOR-2057: an install the agent drives through this tool must set the plugin
// up exactly as the app's Install button does — refresh the runtime's plugin
// list and project the plugin to the project's harnesses. Both hang off the
// same `onPluginsChanged` notification the HTTP route fires.
describe('createInstallHandler — plugins-changed notification (DOR-2057)', () => {
  let confirmationProvider: FakeConfirmationProvider;
  let onPluginsChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirmationProvider = new FakeConfirmationProvider();
    onPluginsChanged = vi.fn();
  });

  function depsWith(installer: InstallerLike): MarketplaceMcpDeps {
    return createStubDeps({ confirmationProvider, installer, onPluginsChanged });
  }

  it('still reports the install as installed when the notifier throws', async () => {
    const projectPath = await boundedProjectPath();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });
    const deps = createStubDeps({
      confirmationProvider,
      installer,
      onPluginsChanged: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    const result = await createInstallHandler(deps)({ name: 'flow', projectPath });

    // The package is on disk by the time the notifier runs; a failed follow-up
    // must never be reported as a failed install.
    expect(result.isError).toBeUndefined();
    expect(parseToolPayload<{ status: string }>(result).status).toBe('installed');
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fires once with the install context after an approved install', async () => {
    const projectPath = await boundedProjectPath();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    // The identifier the agent passed is not the package name; the notification
    // carries the RESOLVED manifest name, as the HTTP route does (DOR-264).
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    const result = await createInstallHandler(depsWith(installer))({
      name: 'github:dork-labs/flow',
      projectPath,
    });

    expect(parseToolPayload<{ status: string }>(result).status).toBe('installed');
    expect(onPluginsChanged).toHaveBeenCalledTimes(1);
    expect(onPluginsChanged).toHaveBeenCalledWith({
      projectPath,
      packageName: 'flow',
      action: 'install',
    });
  });

  it('fires with projectPath undefined for a global install', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    await createInstallHandler(depsWith(installer))({ name: 'flow' });

    expect(onPluginsChanged).toHaveBeenCalledWith({
      projectPath: undefined,
      packageName: 'flow',
      action: 'install',
    });
  });

  it('fires when the tier gate already approved the call', async () => {
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    await createInstallHandler(depsWith(installer))({ name: 'flow' }, { preApproved: true });

    expect(onPluginsChanged).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire while the install is waiting for confirmation', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({
      status: 'pending',
      token: 'tok-1',
    });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    const result = await createInstallHandler(depsWith(installer))({ name: 'flow' });

    expect(parseToolPayload<{ status: string }>(result).status).toBe('requires_confirmation');
    expect(onPluginsChanged).not.toHaveBeenCalled();
  });

  it('does NOT fire when the install is declined', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'declined' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    const result = await createInstallHandler(depsWith(installer))({ name: 'flow' });

    expect(parseToolPayload<{ status: string }>(result).status).toBe('declined');
    expect(onPluginsChanged).not.toHaveBeenCalled();
  });

  it('does NOT fire when the approved install fails', async () => {
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: new Error('disk full'),
    });

    const result = await createInstallHandler(depsWith(installer))({ name: 'flow' });

    expect(result.isError).toBe(true);
    expect(onPluginsChanged).not.toHaveBeenCalled();
  });

  it('does NOT fire when the preview fails', async () => {
    const installer = createStubInstaller({ preview: new Error('not found') });

    const result = await createInstallHandler(depsWith(installer))({ name: 'flow' });

    expect(result.isError).toBe(true);
    expect(onPluginsChanged).not.toHaveBeenCalled();
  });
});

// DOR-2057 follow-up: the effects receive the CANONICAL project path, as the HTTP
// route's `confineProjectPath` hands them, while the approval stays bound to the
// arguments exactly as the agent sent them.
describe('createInstallHandler — canonical project path (DOR-2057)', () => {
  it('installs into the realpath of a symlinked projectPath, but approves and notifies with the raw spelling', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-install-canonical-')));
    await initBoundary(root);
    const repo = join(root, 'real-repo');
    await mkdir(repo);
    const link = join(root, 'link-to-repo');
    await symlink(repo, link);

    const { provider, grantPending } = buildTokenProvider();
    const onPluginsChanged = vi.fn();
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });
    const handler = createInstallHandler(
      createStubDeps({ confirmationProvider: provider, installer, onPluginsChanged })
    );

    try {
      const first = await handler({ name: 'flow', projectPath: link });
      const pending = parseToolPayload<{ status: string; confirmationToken: string }>(first);
      expect(pending.status).toBe('requires_confirmation');
      expect(onPluginsChanged).not.toHaveBeenCalled();

      grantPending();
      // The retry repeats the raw spelling; the token was minted over it.
      const second = await handler({
        name: 'flow',
        projectPath: link,
        confirmationToken: pending.confirmationToken,
      });

      expect(parseToolPayload<{ status: string }>(second).status).toBe('installed');
      expect(installer.preview).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: repo })
      );
      expect(installer.install).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: repo })
      );
      expect(onPluginsChanged).toHaveBeenCalledTimes(1);
      // The RAW spelling, as the HTTP route sends it: listeners key on the path
      // the way the person picked it (DOR-711), so the two surfaces must agree.
      expect(onPluginsChanged).toHaveBeenCalledWith({
        projectPath: link,
        packageName: 'flow',
        action: 'install',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('asks the confirmation provider with the raw projectPath, not the canonical one', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-install-raw-binding-')));
    await initBoundary(root);
    const repo = join(root, 'real-repo');
    await mkdir(repo);
    const link = join(root, 'link-to-repo');
    await symlink(repo, link);

    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const installer = createStubInstaller({
      preview: previewResult({ name: 'flow' }),
      install: installResult({ packageName: 'flow' }),
    });

    try {
      await createInstallHandler(createStubDeps({ confirmationProvider, installer }))({
        name: 'flow',
        projectPath: link,
      });

      expect(confirmationProvider.requestInstallConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: link })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
