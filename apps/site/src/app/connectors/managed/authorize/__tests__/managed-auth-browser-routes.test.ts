/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  bindBrowser: vi.fn(),
  completeAuthentication: vi.fn(),
  createClients: vi.fn(),
}));

vi.mock('@/db/transaction-client', () => ({
  getTransactionDb: () => ({ kind: 'managed-test-db' }),
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));
vi.mock('@/lib/connectors/managed/authentication-service', () => ({
  MANAGED_CONNECTOR_FLOW_COOKIE: 'dorkos_managed_connector_flow',
  ManagedAuthenticationFlowError: class ManagedAuthenticationFlowError extends Error {},
  bindManagedAuthenticationBrowser: mocks.bindBrowser,
  completeManagedAuthentication: mocks.completeAuthentication,
}));
vi.mock('@/lib/connectors/managed/config', () => ({
  readManagedConnectorConfig: () => ({
    enabled: true,
    liveReady: true,
    projectApiKey: 'project-key',
    callbackOrigin: 'https://dorkos.test',
    authConfigByToolkit: { gmail: 'ac_gmail' },
  }),
  managedCapabilityAvailability: () => ({ status: 'available' }),
}));
vi.mock('@dorkos/connector-providers/composio', () => ({
  createComposioHostedClients: mocks.createClients,
}));

import { GET as completeCallback } from '../../../../api/connectors/managed/callback/route';
import { GET as authorizeBrowser } from '../route';

describe('managed authentication browser routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'owner-a' } });
    mocks.bindBrowser.mockResolvedValue({
      cookieValue: 'flow-cookie',
      redirectUrl: 'https://provider.test/consent',
    });
    mocks.createClients.mockReturnValue({ accounts: {}, executionConfigDigest: 'digest-a' });
    mocks.completeAuthentication.mockResolvedValue({ connectionId: 'managed-gmail' });
  });

  it('binds the signed-in owner and issues a callback-only CSRF cookie', async () => {
    const response = await authorizeBrowser(
      new Request('https://dorkos.test/connectors/managed/authorize?flow=flow-a&nonce=nonce-a')
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://provider.test/consent');
    expect(response.headers.get('set-cookie')).toContain(
      'dorkos_managed_connector_flow=flow-cookie; Path=/api/connectors/managed/callback; HttpOnly; SameSite=Lax; Max-Age=600'
    );
    expect(mocks.bindBrowser).toHaveBeenCalledWith({
      db: { kind: 'managed-test-db' },
      ownerId: 'owner-a',
      flowId: 'flow-a',
      nonce: 'nonce-a',
    });
  });

  it('does not bind a provider flow before browser sign-in', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const response = await authorizeBrowser(
      new Request('https://dorkos.test/connectors/managed/authorize?flow=flow-a&nonce=nonce-a')
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/signin?returnTo=');
    expect(mocks.bindBrowser).not.toHaveBeenCalled();
  });

  it('completes only through the signed-in owner cookie and clears it before redirecting', async () => {
    const response = await completeCallback(
      new Request(
        'https://dorkos.test/api/connectors/managed/callback?session_uri=opaque-session&returnTo=https://evil.test',
        { headers: { cookie: 'dorkos_managed_connector_flow=flow-cookie' } }
      )
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://dorkos.test/account/instances?connection=managed-gmail'
    );
    expect(response.headers.get('set-cookie')).toContain(
      'dorkos_managed_connector_flow=; Path=/api/connectors/managed/callback; HttpOnly; SameSite=Lax; Max-Age=0'
    );
    expect(mocks.completeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { kind: 'managed-test-db' },
        ownerId: 'owner-a',
        cookieValue: 'flow-cookie',
        sessionUri: 'opaque-session',
      })
    );
  });

  it('refuses a callback without the browser-bound cookie before provider redemption', async () => {
    const response = await completeCallback(
      new Request('https://dorkos.test/api/connectors/managed/callback?session_uri=opaque-session')
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(mocks.completeAuthentication).not.toHaveBeenCalled();
  });
});
