/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  listCatalog: vi.fn(),
  listOperations: vi.fn(),
  listConnections: vi.fn(),
  getConnection: vi.fn(),
  listUsage: vi.fn(),
}));

vi.mock('@/lib/connectors/managed/request-context', () => ({
  resolveManagedConnectorRequest: mocks.resolveContext,
  managedContextFailure: (context: { status: string }) =>
    Response.json(
      {
        error:
          context.status === 'permission_upgrade_required'
            ? 'permission_upgrade_required'
            : 'unauthorized',
      },
      { status: context.status === 'permission_upgrade_required' ? 403 : 401 }
    ),
}));

vi.mock('@/lib/connectors/managed/discovery-service', async (importOriginal) => ({
  // The real request-shape tag, so a route can tell a caller's bad request
  // from its own failure exactly as it does in production.
  ManagedRequestShapeError: (
    await importOriginal<typeof import('@/lib/connectors/managed/discovery-service')>()
  ).ManagedRequestShapeError,
  listManagedConnectorCatalog: mocks.listCatalog,
  listManagedOperationSchemas: mocks.listOperations,
  listManagedConnections: mocks.listConnections,
  getManagedConnection: mocks.getConnection,
  resolveManagedToolkitVersion: vi.fn(),
}));

vi.mock('@/lib/connectors/managed/usage-service', () => ({
  listManagedConnectorUsage: mocks.listUsage,
  ManagedUsageCursorError: class ManagedUsageCursorError extends Error {},
  ManagedUsageNotFoundError: class ManagedUsageNotFoundError extends Error {},
}));

import { ZodError } from 'zod';
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import type { ManagedConnectorConfig } from '@/lib/connectors/managed/config';
import { GET as getCatalog } from '../catalog/route';
import { GET as getConnection } from '../connections/[managedConnectionId]/route';
import { GET as getConnections } from '../connections/route';
import { GET as getOperations } from '../toolkits/[toolkit]/operations/route';
import { GET as getUsage } from '../usage/route';

const context = {
  status: 'ok' as const,
  db: {},
  principal: { ownerId: 'owner-a', instanceId: 'instance-a', tenantId: 'tenant-a', keyId: 'key-a' },
  operations: {},
  config: { projectApiKey: 'cursor-secret' },
};

describe('managed discovery route boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveContext.mockResolvedValue(context);
    mocks.listCatalog.mockResolvedValue({ version: 1, toolkits: [], truncated: false });
    mocks.listOperations.mockResolvedValue({
      version: 1,
      status: 'ok',
      operations: [],
      truncated: false,
    });
    mocks.listConnections.mockResolvedValue({ version: 1, accounts: [] });
    mocks.getConnection.mockResolvedValue(null);
    mocks.listUsage.mockResolvedValue({
      version: 1,
      status: 'available',
      counts: { logicalOperationCount: 0, attemptCount: 0 },
      items: [],
    });
  });

  it('requires authority and forwards only a strict bounded catalog query', async () => {
    const response = await getCatalog(
      new Request(
        'https://dorkos.test/api/instances/connectors/catalog?version=1&query=mail&limit=25'
      )
    );
    expect(response.status).toBe(200);
    expect(mocks.resolveContext).toHaveBeenCalledWith(expect.any(Request), 'authority');
    expect(mocks.listCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: context.operations,
        rawRequest: { version: 1, query: 'mail', limit: 25 },
      })
    );
  });

  it.each([undefined, '0', '1'])(
    'negotiates catalog setup only for exact supported header %s',
    async (version) => {
      const response = await getCatalog(
        new Request(
          'https://dorkos.test/api/instances/connectors/catalog?version=1&query=mail&cursor=page2&limit=25',
          { headers: version ? { 'x-dorkos-catalog-auth-setup': version } : {} }
        )
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('vary')).toBe('x-dorkos-catalog-auth-setup');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.listCatalog).toHaveBeenCalledWith(
        expect.objectContaining({
          includeAuthenticationSetup: version === '1',
          rawRequest: { version: 1, query: 'mail', cursor: 'page2', limit: 25 },
        })
      );
    }
  );

  it('rejects duplicate and unknown selectors before any provider or database read', async () => {
    const duplicate = await getCatalog(
      new Request('https://dorkos.test/api/instances/connectors/catalog?version=1&limit=2&limit=3')
    );
    const unknown = await getConnections(
      new Request(
        'https://dorkos.test/api/instances/connectors/connections?version=1&limit=2&ownerId=other'
      )
    );
    expect(duplicate.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(mocks.listCatalog).not.toHaveBeenCalled();
    expect(mocks.listConnections).not.toHaveBeenCalled();
  });

  it('keeps foreign or absent managed connection ids indistinguishable', async () => {
    const response = await getConnection(
      new Request('https://dorkos.test/api/instances/connectors/connections/foreign?version=1'),
      { params: Promise.resolve({ managedConnectionId: 'foreign' }) }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.getConnection).toHaveBeenCalledWith(context.db, context.principal, 'foreign');
  });

  it('normalizes provider discovery failures without returning private error text', async () => {
    mocks.listOperations.mockRejectedValueOnce(new Error('private provider response'));
    const response = await getOperations(
      new Request(
        'https://dorkos.test/api/instances/connectors/toolkits/gmail/operations?version=1&toolkitVersion=20260902_00&limit=100'
      ),
      { params: Promise.resolve({ toolkit: 'gmail' }) }
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('managed_connectors_unavailable');
    expect(body).not.toContain('private provider response');
  });

  it('answers a Gmail-shaped catalog page instead of failing on the app’s own extra details', async () => {
    const actual = await vi.importActual<
      typeof import('@/lib/connectors/managed/discovery-service')
    >('@/lib/connectors/managed/discovery-service');
    const config: ManagedConnectorConfig = {
      enabled: true,
      liveReady: true,
      projectApiKey: 'project-fixture',
      callbackOrigin: 'https://dorkos.example',
      authConfigByToolkit: { gmail: 'ac_gmail' },
    };
    const operations = {
      listToolkitPage: async () => ({
        status: 'ok' as const,
        truncated: false,
        toolkits: [
          {
            slug: 'gmail',
            displayName: 'Gmail',
            authKind: 'oauth2' as const,
            logoUrl: 'https://logos.composio.dev/api/gmail',
            description: 'Send and read email.',
          },
        ],
      }),
    } as unknown as ComposioOperationClient;
    mocks.resolveContext.mockResolvedValueOnce({ ...context, config, operations });
    mocks.listCatalog.mockImplementationOnce(actual.listManagedConnectorCatalog);
    const response = await getCatalog(
      new Request('https://dorkos.test/api/instances/connectors/catalog?version=1&limit=25')
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.toolkits[0]).toMatchObject({ slug: 'gmail', displayName: 'Gmail' });
    expect(JSON.stringify(body)).not.toContain('logos.composio.dev');
  });

  it('answers a malformed request 400 and its own mapping failure 500, never the reverse', async () => {
    const actual = await vi.importActual<
      typeof import('@/lib/connectors/managed/discovery-service')
    >('@/lib/connectors/managed/discovery-service');
    mocks.listCatalog.mockImplementationOnce(actual.listManagedConnectorCatalog);
    const malformed = await getCatalog(
      new Request('https://dorkos.test/api/instances/connectors/catalog?version=1&limit=1000')
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_request' });

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.listOperations.mockRejectedValueOnce(new ZodError([]));
    const internal = await getOperations(
      new Request(
        'https://dorkos.test/api/instances/connectors/toolkits/gmail/operations?version=1&toolkitVersion=20260902_00&limit=100'
      ),
      { params: Promise.resolve({ toolkit: 'gmail' }) }
    );
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ error: 'internal_error' });
    expect(logged).toHaveBeenCalledWith(
      '[managed-discovery] internal wire-mapping failure',
      'ZodError',
      'GET',
      '/api/instances/connectors/toolkits/gmail/operations'
    );
    logged.mockRestore();
  });

  it('returns the explicit permission-upgrade response before route work', async () => {
    mocks.resolveContext.mockResolvedValueOnce({ status: 'permission_upgrade_required' });
    const response = await getCatalog(
      new Request('https://dorkos.test/api/instances/connectors/catalog?version=1&limit=25')
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'permission_upgrade_required' });
    expect(mocks.listCatalog).not.toHaveBeenCalled();
  });

  it('requires usage permission and applies the default page size inside the schema boundary', async () => {
    const response = await getUsage(
      new Request(
        'https://dorkos.test/api/instances/connectors/usage?version=1&managedConnectionId=managed-a'
      )
    );
    expect(response.status).toBe(200);
    expect(mocks.resolveContext).toHaveBeenCalledWith(expect.any(Request), 'usage');
    expect(mocks.listUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        db: context.db,
        principal: context.principal,
        rawRequest: { version: 1, managedConnectionId: 'managed-a' },
      })
    );
  });
});
