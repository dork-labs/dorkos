import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createUninstallHandler, UninstallInputSchema } from '../tool-uninstall.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import {
  PackageNotInstalledError,
  type UninstallRequest,
  type UninstallResult,
} from '../../marketplace/flows/uninstall.js';
import {
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
 * Stub `UninstallFlow` that records calls and yields canned responses. The
 * stub is intentionally minimal — it only exposes the `uninstall()` method
 * the handler reaches for, never the real transaction engine.
 */
function createStubUninstallFlow(canned: {
  result?: UninstallResult;
  error?: Error;
}): MarketplaceMcpDeps['uninstallFlow'] {
  const uninstall = vi.fn(async (_req: UninstallRequest): Promise<UninstallResult> => {
    if (canned.error) throw canned.error;
    if (canned.result) return canned.result;
    throw new Error('No canned uninstall result configured');
  });
  return { uninstall } as unknown as MarketplaceMcpDeps['uninstallFlow'];
}

/**
 * Build a `MarketplaceMcpDeps` populated only with the fields the uninstall
 * handler reads (`uninstallFlow`, `confirmationProvider`, `logger`). Other
 * fields are stubbed via `unknown` casts so the cast is local to this helper.
 */
function createStubDeps(opts: {
  confirmationProvider: ConfirmationProvider;
  uninstallFlow: MarketplaceMcpDeps['uninstallFlow'];
}): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/.dork-test',
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: opts.uninstallFlow,
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
 * Build a canned `UninstallResult` with sensible defaults; tests override
 * only the fields they care about.
 */
function uninstallResult(
  overrides: Partial<UninstallResult> & { packageName: string }
): UninstallResult {
  return {
    ok: true,
    packageName: overrides.packageName,
    removedFiles: 1,
    preservedData: [],
    ...overrides,
  };
}

/**
 * Parse the JSON payload out of an MCP `text` content block — every handler
 * in this directory wraps its response in `{ content: [{ type: 'text', text }] }`.
 */
function parseToolPayload<T = unknown>(result: { content: { type: 'text'; text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe('UninstallInputSchema', () => {
  it('exports a Zod-compatible shape with name + optional purge/projectPath/confirmationToken', () => {
    expect(UninstallInputSchema).toHaveProperty('name');
    expect(UninstallInputSchema).toHaveProperty('purge');
    expect(UninstallInputSchema).toHaveProperty('projectPath');
    expect(UninstallInputSchema).toHaveProperty('confirmationToken');
  });
});

describe('createUninstallHandler — in-app approve happy path', () => {
  let confirmationProvider: FakeConfirmationProvider;
  let uninstallFlow: MarketplaceMcpDeps['uninstallFlow'];
  let deps: MarketplaceMcpDeps;

  beforeEach(() => {
    confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({
        packageName: 'sentry',
        removedFiles: 4,
        preservedData: ['/tmp/.dork-test/plugins/sentry/.dork/secrets.json'],
      }),
    });
    deps = createStubDeps({ confirmationProvider, uninstallFlow });
  });

  it('returns status: uninstalled with package details when approved', async () => {
    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      package: { name: string; type: string };
      purgedPaths: string[];
      preservedPaths: string[];
    }>(result);
    expect(payload.status).toBe('uninstalled');
    expect(payload.package.name).toBe('sentry');
    expect(payload.preservedPaths).toEqual(['/tmp/.dork-test/plugins/sentry/.dork/secrets.json']);
  });

  it('passes the package name through requestInstallConfirmation with operation: uninstall', async () => {
    const handler = createUninstallHandler(deps);
    await handler({ name: 'sentry' });

    expect(confirmationProvider.requestInstallConfirmation).toHaveBeenCalledTimes(1);
    expect(confirmationProvider.requestInstallConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: 'sentry',
        operation: 'uninstall',
      })
    );
  });

  it('does not call resolveToken when no confirmationToken is supplied', async () => {
    const handler = createUninstallHandler(deps);
    await handler({ name: 'sentry' });

    expect(confirmationProvider.resolveToken).not.toHaveBeenCalled();
  });
});

describe('createUninstallHandler — token resume flow', () => {
  it('returns requires_confirmation + token on first call from external client', async () => {
    const tokenProvider = new TokenConfirmationProvider();
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      confirmationToken: string;
      message: string;
    }>(result);
    expect(payload.status).toBe('requires_confirmation');
    expect(payload.confirmationToken).toMatch(/[0-9a-f-]{36}/);
    expect(payload.message).toContain('confirmationToken');
    // The flow must NOT have been invoked yet — the user still has to approve.
    expect(uninstallFlow.uninstall).not.toHaveBeenCalled();
  });

  it('proceeds with uninstall when re-called with an approved token', async () => {
    const tokenProvider = new TokenConfirmationProvider();
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry', removedFiles: 3 }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, uninstallFlow });
    const handler = createUninstallHandler(deps);

    // First call → pending token.
    const first = await handler({ name: 'sentry' });
    const { confirmationToken } = parseToolPayload<{ confirmationToken: string }>(first);

    // Out-of-band approval (simulates the DorkOS UI clicking Approve).
    tokenProvider.approve(confirmationToken);

    // Second call → handler must use the token, NOT issue a new one.
    const requestSpy = vi.spyOn(tokenProvider, 'requestInstallConfirmation');
    const second = await handler({ name: 'sentry', confirmationToken });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(second.isError).toBeUndefined();
    const payload = parseToolPayload<{
      status: string;
      package: { name: string };
    }>(second);
    expect(payload.status).toBe('uninstalled');
    expect(payload.package.name).toBe('sentry');
    expect(uninstallFlow.uninstall).toHaveBeenCalledTimes(1);
  });
});

describe('createUninstallHandler — declined', () => {
  it('returns status: declined with reason when the user declines via in-app provider', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({
      status: 'declined',
      reason: 'Not now',
    });
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBeUndefined();
    const payload = parseToolPayload<{ status: string; reason: string }>(result);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('Not now');
    expect(uninstallFlow.uninstall).not.toHaveBeenCalled();
  });

  it('falls back to a default reason when the provider omits one', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'declined' });
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    const payload = parseToolPayload<{ status: string; reason: string }>(result);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toMatch(/declined/i);
  });

  it('returns declined when a token resolves to declined', async () => {
    const tokenProvider = new TokenConfirmationProvider();
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider: tokenProvider, uninstallFlow });
    const handler = createUninstallHandler(deps);

    const first = await handler({ name: 'sentry' });
    const { confirmationToken } = parseToolPayload<{ confirmationToken: string }>(first);
    tokenProvider.decline(confirmationToken, 'Changed my mind');

    const second = await handler({ name: 'sentry', confirmationToken });
    const payload = parseToolPayload<{ status: string; reason: string }>(second);
    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('Changed my mind');
    expect(uninstallFlow.uninstall).not.toHaveBeenCalled();
  });
});

describe('createUninstallHandler — package not installed', () => {
  it('returns isError + code NOT_INSTALLED when the flow throws PackageNotInstalledError', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const uninstallFlow = createStubUninstallFlow({
      error: new PackageNotInstalledError('ghost'),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'ghost' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string }>(result);
    expect(payload.code).toBe('NOT_INSTALLED');
    expect(payload.error).toContain('ghost');
  });

  it('returns isError + code UNINSTALL_FAILED for any other error', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const uninstallFlow = createStubUninstallFlow({
      error: new Error('disk on fire'),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(result.isError).toBe(true);
    const payload = parseToolPayload<{ error: string; code: string }>(result);
    expect(payload.code).toBe('UNINSTALL_FAILED');
    expect(payload.error).toContain('disk on fire');
  });
});

describe('createUninstallHandler — purge flag', () => {
  it('forwards purge: true to the underlying flow', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry', preservedData: [] }),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    await handler({ name: 'sentry', purge: true });

    expect(uninstallFlow.uninstall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sentry', purge: true })
    );
  });

  it('defaults purge to false when omitted', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({
        packageName: 'sentry',
        preservedData: ['/tmp/.dork-test/plugins/sentry/.dork/data'],
      }),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    const result = await handler({ name: 'sentry' });

    expect(uninstallFlow.uninstall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sentry', purge: false })
    );
    const payload = parseToolPayload<{ preservedPaths: string[] }>(result);
    expect(payload.preservedPaths).toEqual(['/tmp/.dork-test/plugins/sentry/.dork/data']);
  });

  it('forwards projectPath to the underlying flow when supplied', async () => {
    const confirmationProvider = new FakeConfirmationProvider();
    confirmationProvider.requestInstallConfirmation.mockResolvedValue({ status: 'approved' });
    const uninstallFlow = createStubUninstallFlow({
      result: uninstallResult({ packageName: 'sentry' }),
    });
    const deps = createStubDeps({ confirmationProvider, uninstallFlow });

    const handler = createUninstallHandler(deps);
    await handler({ name: 'sentry', projectPath: '/tmp/some-project' });

    expect(uninstallFlow.uninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sentry',
        projectPath: '/tmp/some-project',
      })
    );
  });
});
