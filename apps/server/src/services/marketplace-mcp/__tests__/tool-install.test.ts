import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';

import { createInstallHandler, InstallInputSchema } from '../tool-install.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
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
    tasks: [],
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
function previewResult(overrides: {
  name: string;
  version?: string;
  preview?: PermissionPreview;
  packagePath?: string;
}): PreviewResult {
  return {
    preview: overrides.preview ?? permissionPreview(),
    manifest: manifest({ name: overrides.name, version: overrides.version }),
    packagePath: overrides.packagePath ?? `/tmp/.dork-test/cache/${overrides.name}`,
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
 * engine, so tests do not need to mock `transactionInternal.isGitRepo`.
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
}): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/.dork-test',
    installer: opts.installer,
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: opts.confirmationProvider,
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

describe('InstallInputSchema', () => {
  it('exports a Zod-compatible shape with name + optional fields', () => {
    expect(InstallInputSchema).toHaveProperty('name');
    expect(InstallInputSchema).toHaveProperty('marketplace');
    expect(InstallInputSchema).toHaveProperty('projectPath');
    expect(InstallInputSchema).toHaveProperty('confirmationToken');
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
    const handler = createInstallHandler(deps);
    await handler({
      name: 'sentry',
      marketplace: 'dorkos-community',
      projectPath: '/tmp/some-project',
    });

    expect(installer.install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sentry',
        marketplace: 'dorkos-community',
        projectPath: '/tmp/some-project',
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
});

describe('createInstallHandler — token resume flow', () => {
  it('returns requires_confirmation + token + preview on first call from external client', async () => {
    const tokenProvider = new TokenConfirmationProvider();
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
    expect(payload.confirmationToken).toMatch(/[0-9a-f-]{36}/);
    expect(payload.message).toContain('confirmationToken');
    expect(payload.preview.externalHosts).toEqual(['sentry.io']);
    // The flow must NOT have run yet — the user still has to approve.
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('proceeds with install when re-called with an approved token', async () => {
    const tokenProvider = new TokenConfirmationProvider();
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
    tokenProvider.approve(confirmationToken);

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
    const tokenProvider = new TokenConfirmationProvider();
    const installer = createStubInstaller({
      preview: previewResult({ name: 'sentry' }),
      install: installResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, installer });
    const handler = createInstallHandler(deps);

    const first = await handler({ name: 'sentry' });
    const { confirmationToken } = parseToolPayload<{ confirmationToken: string }>(first);
    tokenProvider.decline(confirmationToken, 'Changed my mind');

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
        type: 'package-name',
        description: 'sentry already installed',
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
