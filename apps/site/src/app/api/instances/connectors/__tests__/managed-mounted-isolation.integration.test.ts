/**
 * @vitest-environment node
 */
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { neon } from '@neondatabase/serverless';
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Auth } from '@/lib/auth';
import type { ManagedConnectorDatabase } from '@/lib/connectors/managed/authority-service';

const state = vi.hoisted(() => {
  process.env.DORKOS_MANAGED_CONNECTORS_ENABLED = '1';
  process.env.DORKOS_MANAGED_CONNECTORS_LIVE_READY = '1';
  process.env.DORKOS_MANAGED_COMPOSIO_PROJECT_KEY = 'project-key';
  process.env.DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS = '{"gmail":"ac_gmail"}';
  process.env.DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN = 'https://dorkos.test';
  return {
    auth: undefined as unknown as Auth,
    authMemory: undefined as unknown as Record<string, Array<Record<string, unknown>>>,
    accounts: undefined as unknown as Record<string, unknown>,
    db: undefined as unknown as ManagedConnectorDatabase,
    httpDb: undefined as unknown as ManagedConnectorDatabase,
    expectedProviderUserId: '',
    operations: undefined as unknown as Record<string, unknown>,
    providerCalls: { createLink: 0, getAccount: 0, execute: 0, completeAuth: 0 },
  };
});

// Email delivery is outside this offline protocol proof.
vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/db/transaction-client', () => ({ getTransactionDb: () => state.db }));
vi.mock('@/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/client')>()),
  getDb: () => state.httpDb,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getAuth: () => state.auth,
}));
vi.mock('@dorkos/connector-providers/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/connector-providers/composio')>()),
  createComposioHostedClients: () => ({
    operations: state.operations,
    accounts: state.accounts,
    executionConfigDigest: 'managed-test-digest',
  }),
}));

import * as siteSchema from '@/db/schema';
import * as managedConfig from '@/lib/connectors/managed/config';
import { GET as completeCallback } from '@/app/api/connectors/managed/callback/route';
import { createAuth } from '@/lib/auth';
import { INSTANCE_KEY_PREFIX } from '@/lib/instance-descriptor';
import { createInstanceApiKey } from '@/lib/instance-service';
import { GET as authorizeBrowser } from '@/app/connectors/managed/authorize/route';
import { GET as pollAuthentication } from '../authentication-flows/[flowId]/route';
import { POST as startAuthentication } from '../authentication-flows/route';
import { GET as getAuthorityCommand } from '../authority-commands/[commandId]/route';
import { POST as applyAuthorityCommand } from '../authority-commands/route';
import { GET as getConnection } from '../connections/[managedConnectionId]/route';
import { GET as getConnectionUsage } from '../connections/[managedConnectionId]/usage/route';
import { GET as listConnections } from '../connections/route';
import { GET as listCatalog } from '../catalog/route';
import { POST as acknowledgeEvents } from '../events/ack/route';
import { GET as getExecutionReceipt } from '../executions/[attemptId]/route';
import { POST as executeOperation } from '../executions/route';

import { GET as listUsage } from '../usage/route';
import { GET as getToolkitVersion } from '../toolkits/[toolkit]/version/route';
import { GET as getOperationSchemas } from '../toolkits/[toolkit]/operations/route';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../../drizzle/', import.meta.url));

function bearerRequest(key: string, path = '/connections', body?: unknown): Request {
  const url = new URL(`/api/instances/connectors${path}`, 'https://dorkos.test');
  if (!body) {
    url.searchParams.set('version', '1');
    if (path === '/connections' || path === '/catalog' || path.endsWith('/usage')) {
      url.searchParams.set('limit', '100');
    }
  }
  return new Request(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('mounted managed connection isolation', () => {
  let client: PGlite;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = 'managed-route-test-secret-1234567890';
    client = new PGlite();
    const database = drizzle(client, { schema: siteSchema });
    state.db = database as unknown as ManagedConnectorDatabase;
    // Ordinary reads still use the offline fixture, but the legacy constructor
    // retains the actual HTTP driver's unsupported interactive transaction API.
    // Returning state.db for both getters would hide a route wired to getDb().
    const http = drizzleHttp(neon('postgresql://fixture:fixture@127.0.0.1:1/fixture'));
    state.httpDb = new Proxy(state.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return http.transaction.bind(http);
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await migrate(database, { migrationsFolder: MIGRATIONS_DIR });
    state.authMemory = {
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
      deviceCode: [],
      instance: [],
      auditLog: [],
    };
    state.auth = createAuth(memoryAdapter(state.authMemory));
    state.accounts = {
      completeAuth: async () => {
        state.providerCalls.completeAuth += 1;
        return {
          connectedAccountId: `provider-auth-${state.providerCalls.createLink}`,
          toolkit: 'gmail',
        };
      },
      createLink: async () => {
        state.providerCalls.createLink += 1;
        return {
          connectedAccountId: `provider-auth-${state.providerCalls.createLink}`,
          redirectUrl: 'https://provider.test/authorize',
        };
      },
      getAccount: async (connectedAccountId: string) => {
        state.providerCalls.getAccount += 1;
        return {
          connectedAccountId,
          providerUserId: state.expectedProviderUserId,
          toolkit: 'gmail',
          authConfigId: 'ac_gmail',
          status: 'ACTIVE',
        };
      },
    };
    state.operations = {
      listToolkitPage: async () => ({ toolkits: [], truncated: false }),
      execute: async (input: Parameters<ComposioOperationClient['execute']>[0]) => {
        state.providerCalls.execute += 1;
        if (!(await input.authorizeDispatch())) {
          return {
            status: 'error' as const,
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Authority changed before dispatch.',
            retryable: false,
          };
        }
        return { status: 'success' as const, data: { accepted: true } };
      },
    };
  });

  afterAll(async () => {
    await client.close();
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.DORKOS_MANAGED_CONNECTORS_ENABLED;
    delete process.env.DORKOS_MANAGED_CONNECTORS_LIVE_READY;
    delete process.env.DORKOS_MANAGED_COMPOSIO_PROJECT_KEY;
    delete process.env.DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS;
    delete process.env.DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN;
  });

  // This real multi-route protocol includes password hashing, two databases and
  // durable restart/reclassification checks. The full site suite exceeds the
  // default five-second unit-test budget. Never retry its partially completed
  // one-shot state: a failure must remain a failure, not reuse existing owners.
  const protocol = { timeout: 30_000, retry: 0 };
  it('enforces mounted owner, instance and revision authority', protocol, async () => {
    const descriptor = { name: 'Test instance', platform: 'darwin', dorkosVersion: '1.0.0' };
    const ownerAFirst = await createInstanceApiKey(state.auth, {
      userId: 'owner-a',
      descriptor: { ...descriptor, name: 'Owner A first' },
    });
    const ownerASecond = await createInstanceApiKey(state.auth, {
      userId: 'owner-a',
      descriptor: { ...descriptor, name: 'Owner A second' },
    });
    const ownerB = await createInstanceApiKey(state.auth, {
      userId: 'owner-b',
      descriptor: { ...descriptor, name: 'Owner B' },
    });
    await client.query(
      `INSERT INTO "user" ("id", "name", "email", "email_verified") VALUES
        ('owner-a', 'Owner A', 'owner-a@dork.test', true),
        ('owner-b', 'Owner B', 'owner-b@dork.test', true)`
    );
    for (const [instanceId, ownerId, name] of [
      [ownerAFirst.instanceId, 'owner-a', 'Owner A first'],
      [ownerASecond.instanceId, 'owner-a', 'Owner A second'],
      [ownerB.instanceId, 'owner-b', 'Owner B'],
    ]) {
      await client.query(
        `INSERT INTO "instance" (
          "id", "user_id", "name", "platform", "dorkos_version", "created_at", "last_seen_at"
        ) VALUES ($1, $2, $3, 'darwin', '1.0.0', now(), now())`,
        [instanceId, ownerId, name]
      );
    }
    for (const linked of [ownerAFirst, ownerASecond, ownerB]) {
      const verified = await state.auth.api.verifyApiKey({ body: { key: linked.key } });
      if (!verified.valid || !verified.key?.referenceId) {
        throw new Error('Better Auth did not return the linked key');
      }
      await state.db.insert(siteSchema.apikey).values({
        id: verified.key.id,
        name: verified.key.name,
        referenceId: verified.key.referenceId,
        key: `test-hash-${verified.key.id}`,
        prefix: INSTANCE_KEY_PREFIX,
        enabled: true,
        rateLimitEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        permissions:
          typeof verified.key.permissions === 'string'
            ? verified.key.permissions
            : JSON.stringify(verified.key.permissions),
        metadata:
          typeof verified.key.metadata === 'string'
            ? verified.key.metadata
            : JSON.stringify(verified.key.metadata),
      });
    }

    const catalog = await listCatalog(bearerRequest(ownerAFirst.key, '/catalog'));
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ version: 1, toolkits: [] });

    // Buffered event acknowledgement resolves the readiness-independent principal
    // constructor, then requires its transaction even when this lease is absent.
    const ack = await acknowledgeEvents(
      bearerRequest(ownerAFirst.key, '/events/ack', {
        events: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            leaseToken: '00000000-0000-4000-8000-000000000002',
          },
        ],
      })
    );
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ acknowledged: 0 });

    for (const linked of [ownerAFirst, ownerASecond, ownerB]) {
      const empty = await listConnections(bearerRequest(linked.key));
      const body = await empty.json();
      expect(empty.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ accounts: [] });
    }
    const tenants = await state.db.select().from(siteSchema.connectorTenant);
    expect(tenants).toHaveLength(2);
    const tenantByOwner = new Map(
      tenants.map((tenant: typeof siteSchema.connectorTenant.$inferSelect) => [
        tenant.ownerUserId,
        tenant,
      ])
    );
    for (const [id, ownerId, instanceId] of [
      ['account-a-first', 'owner-a', ownerAFirst.instanceId],
      ['account-a-second', 'owner-a', ownerASecond.instanceId],
      ['account-b', 'owner-b', ownerB.instanceId],
    ]) {
      const tenant = tenantByOwner.get(ownerId);
      if (!tenant) throw new Error(`Missing tenant for ${ownerId}`);
      const [provider] = await state.db
        .select()
        .from(siteSchema.managedConnectorProvider)
        .where(eq(siteSchema.managedConnectorProvider.tenantId, tenant.id));
      await state.db.insert(siteSchema.managedConnectorConnection).values({
        tenantId: tenant.id,
        id,
        originatingInstanceId: instanceId,
        providerInstanceId: provider.id,
        providerUserId: tenant.providerUserId,
        externalAccountRef: `private-${id}`,
        toolkit: 'gmail',
        authConfigId: 'ac_gmail',
        label: id,
        lifecycle: 'active',
        authenticationStatus: 'active',
        materialGeneration: provider.materialGeneration,
      });
    }

    const revisions = new Map<
      string,
      typeof siteSchema.managedConnectorOperationRevision.$inferSelect
    >();
    for (const [ownerId, tenant] of tenantByOwner) {
      const [revision] = await state.db
        .insert(siteSchema.managedConnectorOperationRevision)
        .values({
          tenantId: tenant.id,
          providerInstanceId: 'managed:composio',
          toolkit: 'gmail',
          operationSlug: 'gmail.messages.list',
          toolkitVersion: '20260901_00',
          schemaHash: `sha256:${ownerId}`,
          classification: 'read',
          inputSchema: { type: 'object' },
        })
        .returning();
      revisions.set(ownerId, revision);
    }

    for (const [linked, expectedId] of [
      [ownerAFirst, 'account-a-first'],
      [ownerASecond, 'account-a-second'],
      [ownerB, 'account-b'],
    ] as const) {
      const response = await listConnections(bearerRequest(linked.key));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        body.accounts.map((account: { managedConnectionId: string }) => account.managedConnectionId)
      ).toEqual([expectedId]);
      expect(JSON.stringify(body)).not.toContain('private-');
    }

    const ownerARevision = revisions.get('owner-a');
    if (!ownerARevision) throw new Error('Missing owner A revision');
    const command = {
      version: 1 as const,
      kind: 'replace_agent_grants' as const,
      commandId: 'mounted-command-a',
      managedConnectionId: 'account-a-first',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: ownerARevision.id,
          operationSlug: ownerARevision.operationSlug,
          toolkitVersion: ownerARevision.toolkitVersion,
          schemaHash: ownerARevision.schemaHash,
        },
      ],
    };
    const applied = await applyAuthorityCommand(
      bearerRequest(ownerAFirst.key, '/authority-commands', command)
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      state: 'applied',
      commandId: command.commandId,
    });
    const ownCommand = await getAuthorityCommand(
      bearerRequest(ownerAFirst.key, `/authority-commands/${command.commandId}`),
      { params: Promise.resolve({ commandId: command.commandId }) }
    );
    expect(ownCommand.status).toBe(200);

    for (const [foreignConnectionId, ownerKey] of [
      ['account-a-second', ownerAFirst.key],
      ['account-b', ownerAFirst.key],
    ]) {
      const before = { ...state.providerCalls };
      const foreignAccount = await getConnection(
        bearerRequest(ownerKey, `/connections/${foreignConnectionId}`),
        { params: Promise.resolve({ managedConnectionId: foreignConnectionId }) }
      );
      expect(foreignAccount.status).toBe(404);
      const foreignAuthority = await applyAuthorityCommand(
        bearerRequest(ownerKey, '/authority-commands', {
          ...command,
          commandId: `foreign-${foreignConnectionId}`,
          managedConnectionId: foreignConnectionId,
          revisions: [],
        })
      );
      expect(foreignAuthority.status).toBe(200);
      expect(await foreignAuthority.json()).toMatchObject({
        state: 'rejected',
        rejectionCode: 'connection_unavailable',
      });
      expect(state.providerCalls).toEqual(before);
    }

    const authStarted = await startAuthentication(
      bearerRequest(ownerAFirst.key, '/authentication-flows', {
        version: 1,
        requestId: 'mounted-auth-a',
        toolkit: 'gmail',
      })
    );
    expect(authStarted.status).toBe(200);
    const authBody = await authStarted.json();
    expect(authBody).toMatchObject({ state: 'pending', toolkit: 'gmail' });
    // Mock only the already-authenticated browser identity; drive the real
    // mounted route and durable database claim for both cookie-less browsers.
    const browserSession = vi.spyOn(state.auth.api, 'getSession').mockResolvedValue({
      user: { id: 'owner-a' },
    } as Awaited<ReturnType<typeof state.auth.api.getSession>>);
    try {
      const browsers = await Promise.all([
        authorizeBrowser(new Request(authBody.authorizeUrl)),
        authorizeBrowser(new Request(authBody.authorizeUrl)),
      ]);
      expect(browsers.map((response) => response.status).sort()).toEqual([302, 404]);
      const accepted = browsers.find((response) => response.status === 302)!;
      const rejected = browsers.find((response) => response.status === 404)!;
      expect(accepted.headers.get('set-cookie')).toContain('dorkos_managed_connector_flow=');
      expect(rejected.headers.get('set-cookie')).toBeNull();
      expect(rejected.headers.get('location')).toBeNull();
      const thirdBrowser = await authorizeBrowser(new Request(authBody.authorizeUrl));
      expect(thirdBrowser.status).toBe(404);
      expect(thirdBrowser.headers.get('set-cookie')).toBeNull();
      const beforeForgery = { ...state.providerCalls };
      const authorizeUrl = new URL(authBody.authorizeUrl);
      const forged = await completeCallback(
        new Request(
          'https://dorkos.test/api/connectors/managed/callback?session_uri=opaque-session',
          {
            headers: {
              cookie: `dorkos_managed_connector_flow=${authBody.flowId}.${authorizeUrl.searchParams.get('nonce')}`,
            },
          }
        )
      );
      expect(forged.status).toBe(403);
      expect(state.providerCalls).toEqual(beforeForgery);
      const [unconsumedFlow] = await state.db
        .select()
        .from(siteSchema.managedConnectorAuthFlow)
        .where(eq(siteSchema.managedConnectorAuthFlow.id, authBody.flowId));
      expect(unconsumedFlow.state).toBe('waiting');
    } finally {
      browserSession.mockRestore();
    }

    const ownPoll = await pollAuthentication(
      bearerRequest(ownerAFirst.key, `/authentication-flows/${authBody.flowId}`),
      { params: Promise.resolve({ flowId: authBody.flowId }) }
    );
    expect(ownPoll.status).toBe(200);
    expect(await ownPoll.json()).toMatchObject({ state: 'pending', flowId: authBody.flowId });
    for (const foreign of [ownerASecond, ownerB]) {
      const before = { ...state.providerCalls };
      const foreignPoll = await pollAuthentication(
        bearerRequest(foreign.key, `/authentication-flows/${authBody.flowId}`),
        { params: Promise.resolve({ flowId: authBody.flowId }) }
      );
      expect(foreignPoll.status).toBe(404);
      expect(state.providerCalls).toEqual(before);
    }

    state.expectedProviderUserId = tenantByOwner.get('owner-a')?.providerUserId ?? '';
    const execution = {
      version: 1 as const,
      logicalOperationId: 'mounted-logical-a',
      attemptId: 'mounted-attempt-a',
      attemptIndex: 1,
      managedConnectionId: 'account-a-first',
      agentId: 'agent-a',
      grantScopeVersion: 1,
      attribution: {
        surface: 'mcp' as const,
        actorKind: 'agent' as const,
        actorId: 'agent-a',
        sessionId: 'session-a',
      },
      revision: command.revisions[0],
      arguments: { query: 'from:me' },
    };
    const executed = await executeOperation(
      bearerRequest(ownerAFirst.key, '/executions', execution)
    );
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      state: 'completed',
      result: { status: 'success' },
      receipt: { attemptId: execution.attemptId, outcome: 'success' },
    });
    const ownReceipt = await getExecutionReceipt(
      bearerRequest(ownerAFirst.key, `/executions/${execution.attemptId}`),
      { params: Promise.resolve({ attemptId: execution.attemptId }) }
    );
    expect(ownReceipt.status).toBe(200);
    const ownUsage = await getConnectionUsage(
      bearerRequest(ownerAFirst.key, `/connections/${execution.managedConnectionId}/usage`),
      { params: Promise.resolve({ managedConnectionId: execution.managedConnectionId }) }
    );
    expect(ownUsage.status).toBe(200);
    expect(await ownUsage.json()).toMatchObject({
      status: 'available',
      counts: { logicalOperationCount: 1, attemptCount: 1 },
    });

    for (const foreign of [ownerASecond, ownerB]) {
      const before = { ...state.providerCalls };
      const deniedReceipt = await getExecutionReceipt(
        bearerRequest(foreign.key, `/executions/${execution.attemptId}`),
        { params: Promise.resolve({ attemptId: execution.attemptId }) }
      );
      expect(deniedReceipt.status).toBe(404);
      const deniedUsage = await getConnectionUsage(
        bearerRequest(foreign.key, `/connections/${execution.managedConnectionId}/usage`),
        { params: Promise.resolve({ managedConnectionId: execution.managedConnectionId }) }
      );
      expect(deniedUsage.status).toBe(404);
      expect(state.providerCalls).toEqual(before);
    }

    for (const managedConnectionId of ['account-a-second', 'account-b']) {
      const before = { ...state.providerCalls };
      const deniedExecution = await executeOperation(
        bearerRequest(ownerAFirst.key, '/executions', {
          ...execution,
          logicalOperationId: `foreign-logical-${managedConnectionId}`,
          attemptId: `foreign-attempt-${managedConnectionId}`,
          managedConnectionId,
        })
      );
      expect(deniedExecution.status).toBe(403);
      expect(await deniedExecution.json()).toEqual({ error: 'authority_unavailable' });
      expect(state.providerCalls).toEqual(before);
    }

    const beforeRecovery = { ...state.providerCalls };
    const configured = managedConfig.readManagedConnectorConfig();
    const disabled = vi
      .spyOn(managedConfig, 'readManagedConnectorConfig')
      .mockReturnValue({ ...configured, enabled: false });
    try {
      const recovered = await executeOperation(
        bearerRequest(ownerAFirst.key, '/executions', execution)
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        state: 'receipt_only',
        receipt: { attemptId: execution.attemptId, outcome: 'success' },
      });
      const conflict = await executeOperation(
        bearerRequest(ownerAFirst.key, '/executions', {
          ...execution,
          arguments: { other: true },
        })
      );
      expect(conflict.status).toBe(409);
      const receipt = await getExecutionReceipt(
        bearerRequest(ownerAFirst.key, `/executions/${execution.attemptId}`),
        { params: Promise.resolve({ attemptId: execution.attemptId }) }
      );
      expect(receipt.status).toBe(200);
      expect(state.providerCalls).toEqual(beforeRecovery);
    } finally {
      disabled.mockRestore();
    }

    const scoped = await state.auth.api.createApiKey({
      body: {
        userId: 'owner-a',
        name: 'Authority-only instance key',
        prefix: INSTANCE_KEY_PREFIX,
        metadata: {
          instanceId: ownerAFirst.instanceId,
          name: 'Owner A first',
          platform: 'darwin',
          dorkosVersion: '1.0.0',
          scope: 'instance',
        },
        permissions: { instance: ['link'], connectors: ['authority'] },
        rateLimitEnabled: false,
      },
    });
    const beforeScoped = { ...state.providerCalls };
    const scopedExecution = await executeOperation(
      bearerRequest(scoped.key, '/executions', { ...execution, attemptId: 'scope-denied' })
    );
    expect(scopedExecution.status).toBe(403);
    expect(await scopedExecution.json()).toEqual({ error: 'permission_upgrade_required' });
    const scopedUsage = await getConnectionUsage(
      bearerRequest(scoped.key, `/connections/${execution.managedConnectionId}/usage`),
      { params: Promise.resolve({ managedConnectionId: execution.managedConnectionId }) }
    );
    expect(scopedUsage.status).toBe(403);
    expect(state.providerCalls).toEqual(beforeScoped);

    const issueKey = (name: string, connectors: string[]) =>
      state.auth.api.createApiKey({
        body: {
          userId: 'owner-a',
          name,
          prefix: INSTANCE_KEY_PREFIX,
          metadata: {
            instanceId: ownerAFirst.instanceId,
            name: 'Owner A first',
            platform: 'darwin',
            dorkosVersion: '1.0.0',
            scope: 'instance',
          },
          permissions: { instance: ['link'], connectors },
          rateLimitEnabled: false,
        },
      });
    const expiring = await issueKey('Expired key', ['authority', 'execute', 'usage']);
    const expiringRow = state.authMemory.apikey.find((row) => row.id === expiring.id);
    if (!expiringRow) throw new Error('Missing expiring key row');
    expiringRow.expiresAt = new Date(Date.now() - 1_000);
    const revoked = await issueKey('Revoked key', ['authority', 'execute', 'usage']);
    const revokedRow = state.authMemory.apikey.find((row) => row.id === revoked.id);
    if (!revokedRow) throw new Error('Missing revoked key row');
    revokedRow.enabled = false;
    for (const key of [expiring.key, revoked.key]) {
      const before = { ...state.providerCalls };
      const denied = await listConnections(bearerRequest(key));
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: 'unauthorized' });
      expect(state.providerCalls).toEqual(before);
    }

    expect(state.providerCalls).toEqual({
      createLink: 1,
      getAccount: 1,
      execute: 1,
      completeAuth: 0,
    });

    // Issue a real Better Auth session cookie for the seeded owner. Password
    // hashing, sign-in and callback session verification run without an auth spy.
    const authPost = (path: string, body: unknown) =>
      state.auth.handler(
        new Request(`http://localhost:3000/api/auth/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify(body),
        })
      );
    const password = 'mounted-owner-protocol-password';
    const email = 'protocol-owner@dork.test';
    const signup = await authPost('sign-up/email', { email, password, name: 'Protocol owner' });
    expect(signup.ok).toBe(true);
    const user = state.authMemory.user.find((row) => row.email === email)!;
    const generatedUserId = user.id;
    user.id = 'owner-a';
    user.emailVerified = true;
    for (const account of state.authMemory.account) {
      if (account.userId === generatedUserId) account.userId = 'owner-a';
      if (account.accountId === generatedUserId) account.accountId = 'owner-a';
    }
    const signedIn = await authPost('sign-in/email', { email, password });
    expect(signedIn.ok).toBe(true);
    const ownerCookie = signedIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    expect(
      await state.auth.api.getSession({ headers: new Headers({ cookie: ownerCookie }) })
    ).toMatchObject({ user: { id: 'owner-a' } });
    let protocolClassification: 'read' | 'write' = 'read';
    Object.assign(state.operations, {
      resolveToolkitVersion: async () => ({
        status: 'ok',
        toolkit: 'gmail',
        toolkitVersion: 'protocol-v1',
      }),
      listOperationSchemas: async () => ({
        page: {
          operations: [
            {
              providerInstanceId: 'managed:composio',
              toolkit: 'gmail',
              toolkitVersion: 'protocol-v1',
              operationSlug: 'gmail.protocol.read',
              schemaHash: 'sha256:protocol',
              capabilityClassification: protocolClassification,
              retryPolicy: 'never',
              inputSchema: { type: 'object' },
            },
          ],
          truncated: false,
        },
      }),
    });
    // The server driver is checked in its own NodeNext project. Loading it at
    // this test-only boundary avoids compiling unrelated runtime code with the
    // Next.js DOM target while Vitest still executes the actual local services.
    const localDriverUrl = new URL(
      '../../../../../../../server/src/services/connectors/__tests__/helpers/managed-local-protocol.ts',
      import.meta.url
    ).href;
    const { proveLocalHostedProtocol } = await import(/* @vite-ignore */ localDriverUrl);
    await proveLocalHostedProtocol({
      instanceKey: ownerAFirst.key,
      completeAuthentication: async (authorizeUrl: string) => {
        const authorized = await authorizeBrowser(
          new Request(authorizeUrl, { headers: { cookie: ownerCookie } })
        );
        expect(authorized.status).toBe(302);
        expect(authorized.headers.get('location')).toBe('https://provider.test/authorize');
        const flowCookie = authorized.headers.get('set-cookie')!.split(';')[0];
        const nonce = new URL(authorizeUrl).searchParams.get('nonce');
        expect(flowCookie).not.toContain(nonce);
        const callbackRequest = () =>
          new Request(
            'https://dorkos.test/api/connectors/managed/callback?session_uri=protocol-session',
            {
              headers: { cookie: `${ownerCookie}; ${flowCookie}` },
            }
          );
        const callback = await completeCallback(callbackRequest());
        expect(callback.status).toBe(302);
        const completedCalls = state.providerCalls.completeAuth;
        const replay = await completeCallback(callbackRequest());
        expect(replay.status).toBe(403);
        expect(state.providerCalls.completeAuth).toBe(completedCalls);
      },
      providerExecutions: () => state.providerCalls.execute,
      reclassify: (classification: 'read' | 'write') => {
        protocolClassification = classification;
      },
      fetchImpl: async (url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        const path = new URL(url).pathname.replace('/api/instances/connectors', '');
        if (path === '/authentication-flows') return startAuthentication(request);
        if (path.startsWith('/authentication-flows/'))
          return pollAuthentication(request, {
            params: Promise.resolve({ flowId: path.split('/')[2] }),
          });
        if (path === '/usage') return listUsage(request);
        if (path === '/connections') return listConnections(request);
        if (path === '/toolkits/gmail/version')
          return getToolkitVersion(request, { params: Promise.resolve({ toolkit: 'gmail' }) });
        if (path === '/toolkits/gmail/operations')
          return getOperationSchemas(request, { params: Promise.resolve({ toolkit: 'gmail' }) });
        if (path === '/authority-commands') return applyAuthorityCommand(request);
        if (path === '/executions') return executeOperation(request);
        if (path.startsWith('/executions/'))
          return getExecutionReceipt(request, {
            params: Promise.resolve({ attemptId: path.split('/')[2] }),
          });
        throw new Error(`Unexpected local-to-hosted protocol route: ${path}`);
      },
    });
  });
});
