/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  resolveAuthentication: vi.fn(),
  startAuthentication: vi.fn(),
}));

vi.mock('@/lib/connectors/managed/request-context', () => ({
  resolveManagedConnectorRequest: mocks.resolveContext,
  managedContextFailure: (context: { status: string }) =>
    Response.json(
      {
        error: context.status === 'unavailable' ? 'managed_connectors_unavailable' : context.status,
      },
      { status: context.status === 'unavailable' ? 503 : 401 }
    ),
}));

vi.mock('@/lib/connectors/managed/auth-config-resolver', () => ({
  resolveManagedAuthenticationConfiguration: mocks.resolveAuthentication,
}));

vi.mock('@/lib/connectors/managed/authentication-service', () => ({
  MANAGED_AUTHENTICATION_START_TIMEOUT_MS: 20,
  ManagedAuthenticationFlowError: class ManagedAuthenticationFlowError extends Error {},
  startManagedAuthentication: mocks.startAuthentication,
}));

import { POST } from './route';

describe('managed authentication start route diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs only the safe request-context category and elapsed time', async () => {
    const privateReason = 'SECRET_CONTEXT_REASON_OR_CREDENTIAL';
    mocks.resolveContext.mockResolvedValue({ status: 'unavailable', reason: privateReason });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await POST(
      new Request('https://dorkos.test/api/instances/connectors/authentication-flows', {
        method: 'POST',
        body: JSON.stringify({ version: 1, requestId: 'private-request-id', toolkit: 'gmail' }),
      })
    );

    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(
      '[Managed connectors] Authentication start did not complete',
      expect.objectContaining({
        stage: 'request_context',
        category: 'unavailable',
        elapsedMs: expect.any(Number),
      })
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(privateReason);
    expect(logged).not.toContain('private-request-id');
    expect(mocks.startAuthentication).not.toHaveBeenCalled();
  });

  it('starts the deadline before context resolution and forwards the expired signal', async () => {
    mocks.resolveContext.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        status: 'ok',
        db: {},
        principal: {},
        providerUserId: 'provider-user',
        materialGeneration: 1,
        executionConfigDigest: 'digest',
        accounts: {},
        config: { authConfigByToolkit: {} },
        verifyLiveInstance: vi.fn(),
      };
    });
    mocks.startAuthentication.mockImplementation(async (input: { signal: AbortSignal }) => ({
      version: 1,
      flowId: 'flow-a',
      toolkit: 'gmail',
      createdAt: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T12:10:00.000Z',
      state: input.signal.aborted ? 'starting' : 'pending',
    }));

    const response = await POST(
      new Request('https://dorkos.test/api/instances/connectors/authentication-flows', {
        method: 'POST',
        body: JSON.stringify({ version: 1, requestId: 'request-a', toolkit: 'gmail' }),
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.startAuthentication.mock.calls[0][0].signal.aborted).toBe(true);
    expect((await response.json()).state).toBe('starting');
  });
});
