/** @vitest-environment node */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createComposioHostedClients,
  normalizeComposioToolkitAuthentication,
  type ComposioAuthenticationConfiguration,
  type ComposioManagedAccount,
  type ComposioManagedAccountClient,
  type ComposioOperationClient,
} from '@dorkos/connector-providers/composio';
import * as schema from '@/db/schema';
import { provisionManagedTestDatabase } from './managed-database-fixture';
import { resolveManagedAuthenticationConfiguration } from '../auth-config-resolver';
import { createManagedAuthenticationOwnerService } from '../authentication-owner-service';
import {
  applyManagedAuthorityCommand,
  registerManagedProvider,
  resolveConnectorTenant,
  type ManagedConnectorDatabase,
} from '../authority-service';
import {
  startManagedAuthentication,
  completeManagedAuthentication,
  getManagedAuthenticationState,
  reconcileManagedAuthentication,
} from '../authentication-service';
import { listManagedConnections } from '../discovery-service';
import { executeManagedConnectorOperation } from '../execution-service';
import type { ManagedConnectorConfig } from '../config';

vi.setConfig({ hookTimeout: 30_000 });
const signal = () => new AbortController().signal;
const SECRET = 'SYNTHETIC-CREDENTIAL-NOT-STORED';

describe('hosted owner field completion', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;
  beforeEach(async () => {
    client = new PGlite();
    await provisionManagedTestDatabase(client);
    db = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await client.close();
  });

  async function setup(scheme: 'API_KEY' | 'NO_AUTH' | 'OAUTH2' = 'API_KEY') {
    const config: ManagedConnectorConfig = {
      enabled: true,
      liveReady: true,
      projectApiKey: 'synthetic-project',
      callbackOrigin: 'https://dorkos.test',
      authConfigByToolkit: {},
    };
    const tenant = await resolveConnectorTenant(db, 'owner-a');
    const material = () =>
      createComposioHostedClients({
        apiKey: config.projectApiKey!,
        serverUserId: tenant.providerUserId,
        authConfigByToolkit: config.authConfigByToolkit,
      });
    const generation = await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: material().executionConfigDigest,
    });
    const principal = {
      ownerId: 'owner-a',
      instanceId: 'instance-a',
      tenantId: tenant.id,
      keyId: 'key-a',
    };
    const configs = new Map<string, ComposioAuthenticationConfiguration>();
    const accountsById = new Map<string, ComposioManagedAccount>();
    let count = 0;
    const accounts = {
      authConfigProjectDigest: material().accounts.authConfigProjectDigest,
      getToolkitAuthentication: vi.fn(async (toolkit: string) =>
        normalizeComposioToolkitAuthentication({
          slug: toolkit,
          enabled: true,
          composio_managed_auth:
            scheme === 'OAUTH2'
              ? [{ mode: 'OAUTH2', scopes: { available: ['read', 'write'] } }]
              : [],
          auth_config_details: [
            {
              mode: scheme,
              fields: {
                auth_config_creation: { required: [], optional: [] },
                connected_account_initiation: {
                  required:
                    scheme === 'API_KEY'
                      ? [
                          {
                            name: 'api_key',
                            displayName: 'API key',
                            description: '',
                            type: 'password',
                            is_secret: true,
                            required: true,
                          },
                        ]
                      : [],
                  optional: [],
                },
              },
            },
          ],
        })
      ),
      getAuthenticationConfiguration: vi.fn(async (id: string) => {
        const value = configs.get(id);
        if (!value) throw new Error('missing');
        return value;
      }),
      listAuthenticationConfigurations: vi.fn(async ({ name }: { name: string }) => ({
        items: [...configs.values()].filter((value) => value.name === name),
      })),
      createAuthenticationConfiguration: vi.fn(
        async (
          input: Parameters<ComposioManagedAccountClient['createAuthenticationConfiguration']>[0]
        ) => {
          const id = `ac_${input.descriptor.toolkit}`;
          configs.set(id, {
            id,
            name: input.name,
            toolkit: input.descriptor.toolkit,
            scheme: input.descriptor.scheme,
            enabled: true,
            managed: scheme === 'OAUTH2',
            policy: {
              type: scheme === 'OAUTH2' ? 'default' : 'custom',
              scopes: [],
              userScopes: [],
              credentialsEmpty: true,
              routerEnabled: false,
            },
          });
          return { id };
        }
      ),
      createFieldAccount: vi.fn(
        async (input: Parameters<ComposioManagedAccountClient['createFieldAccount']>[0]) => {
          const connectedAccountId = `ca_${++count}`;
          accountsById.set(connectedAccountId, {
            connectedAccountId,
            providerUserId: input.providerUserId,
            authConfigId: input.authConfigId,
            toolkit: input.descriptor.toolkit,
            status: 'ACTIVE',
          });
          return { connectedAccountId };
        }
      ),
      createLink: vi.fn(
        async ({
          authConfigId,
          providerUserId,
        }: {
          authConfigId: string;
          providerUserId: string;
        }) => {
          const connectedAccountId = `ca_${++count}`;
          accountsById.set(connectedAccountId, {
            connectedAccountId,
            authConfigId,
            providerUserId,
            toolkit: configs.get(authConfigId)!.toolkit,
            status: 'ACTIVE',
          });
          return { connectedAccountId, redirectUrl: 'https://connect.composio.dev/synthetic' };
        }
      ),
      getAccount: vi.fn(async (id: string) => {
        const account = accountsById.get(id);
        if (!account) throw new Error('missing');
        return account;
      }),
      completeAuth: vi.fn(async () => ({ connectedAccountId: 'ca_1', toolkit: 'synthetic' })),
    };
    const service = createManagedAuthenticationOwnerService(db, {
      readConfig: () => config,
      createAccounts: () => ({ accounts, executionConfigDigest: material().executionConfigDigest }),
    });
    const started = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: generation,
      executionConfigDigest: material().executionConfigDigest,
      accounts,
      config,
      resolveAuthentication: (toolkit) =>
        resolveManagedAuthenticationConfiguration({ db, accounts, toolkit, signal: signal() }),
      rawRequest: { version: 1, toolkit: 'synthetic', requestId: 'synthetic-start' },
      verifyLiveInstance: async () => true,
      signal: signal(),
    });
    if (started.state !== 'pending' || !started.authorizeUrl)
      throw new Error('Expected pending owner flow');
    const url = new URL(started.authorizeUrl);
    const authorizeInput = {
      ownerId: 'owner-a',
      flowId: started.flowId,
      nonce: url.searchParams.get('nonce')!,
      signal: signal(),
    };
    async function bind() {
      const bound = await service.authorize(authorizeInput);
      if (!bound) throw new Error('Expected owner bind');
      return bound;
    }
    async function submission() {
      const bound = await bind();
      if (bound.kind === 'oauth') throw new Error('Expected fields');
      return {
        ownerId: 'owner-a',
        cookieValue: bound.cookieValue,
        requestOrigin: 'https://dorkos.test',
        expectedOrigin: 'https://dorkos.test',
        csrfToken: bound.csrfToken,
        descriptorDigest: bound.descriptorDigest,
        fields: scheme === 'NO_AUTH' ? {} : { api_key: SECRET },
        signal: signal(),
      };
    }
    return {
      config,
      tenant,
      principal,
      material,
      service,
      accounts,
      configs,
      accountsById,
      started,
      authorizeInput,
      bind,
      submission,
    };
  }

  it('keeps refresh read-only and returns no credential defaults or values', async () => {
    const f = await setup();
    await expect(
      f.service.authorize({ ...f.authorizeInput, ownerId: 'owner-b' })
    ).resolves.toBeNull();
    const input = await f.submission();
    const before = await db.select().from(schema.managedConnectorAuthFlow);
    const first = await f.service.readFieldsPage({
      ownerId: 'owner-a',
      cookieValue: input.cookieValue,
      signal: signal(),
    });
    expect(
      await f.service.readFieldsPage({
        ownerId: 'owner-a',
        cookieValue: input.cookieValue,
        signal: signal(),
      })
    ).toEqual(first);
    expect(await db.select().from(schema.managedConnectorAuthFlow)).toEqual(before);
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(f.accounts.createFieldAccount).not.toHaveBeenCalled();
    await expect(
      f.service.readFieldsPage({
        ownerId: 'owner-b',
        cookieValue: input.cookieValue,
        signal: signal(),
      })
    ).resolves.toBeNull();
  });
  it.each(['owner', 'cookie', 'origin', 'csrf', 'digest', 'unknown-field', 'oversize'] as const)(
    'refuses %s before upstream reads or field creation',
    async (kind) => {
      const f = await setup();
      const input = await f.submission();
      f.accounts.getToolkitAuthentication.mockClear();
      const changed = { ...input };
      if (kind === 'owner') changed.ownerId = 'owner-b';
      if (kind === 'cookie') changed.cookieValue += 'x';
      if (kind === 'origin') changed.requestOrigin = 'https://foreign.test';
      if (kind === 'csrf') changed.csrfToken = 'foreign';
      if (kind === 'digest') changed.descriptorDigest = '0'.repeat(64);
      if (kind === 'unknown-field')
        changed.fields = { api_key: SECRET, undeclared: SECRET } as never;
      if (kind === 'oversize') changed.fields = { api_key: 'a'.repeat(9000) };
      await expect(f.service.completeFields(changed)).rejects.toThrow();
      expect(f.accounts.getToolkitAuthentication).not.toHaveBeenCalled();
      expect(f.accounts.createFieldAccount).not.toHaveBeenCalled();
      expect((await db.select().from(schema.managedConnectorAuthFlow))[0].state).toBe('waiting');
    }
  );
  it('caps the cookie at remaining expiry and refuses an expired handoff', async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    await db
      .update(schema.managedConnectorAuthFlow)
      .set({ expiresAt: new Date(Date.now() + 2500) });
    const bound = await f.bind();
    expect(bound.cookieMaxAgeSeconds).toBeGreaterThan(0);
    expect(bound.cookieMaxAgeSeconds).toBeLessThanOrEqual(2);
    await db.update(schema.managedConnectorAuthFlow).set({ expiresAt: new Date(0) });
    await expect(
      f.service.readFieldsPage({
        ownerId: 'owner-a',
        cookieValue: bound.cookieValue,
        signal: signal(),
      })
    ).resolves.toBeNull();
  });
  it('refuses expired and subsecond handoffs without issuing a cookie', async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    for (const remaining of [0, 500]) {
      await db
        .update(schema.managedConnectorAuthFlow)
        .set({ expiresAt: new Date(Date.now() + remaining) });
      await expect(f.service.authorize(f.authorizeInput)).resolves.toBeNull();
    }
    expect((await db.select().from(schema.managedConnectorAuthFlow))[0].browserBoundAt).toBeNull();
  });
  it('rechecks instance revocation after awaited metadata and before consuming or dispatching', async () => {
    const f = await setup();
    const input = await f.submission();
    const original = f.accounts.getToolkitAuthentication.getMockImplementation()!;
    f.accounts.getToolkitAuthentication.mockImplementation(async (toolkit) => {
      await db
        .update(schema.instance)
        .set({ revokedAt: new Date() })
        .where(eq(schema.instance.id, 'instance-a'));
      return original(toolkit);
    });
    await expect(f.service.completeFields(input)).rejects.toThrow();
    expect(f.accounts.createFieldAccount).not.toHaveBeenCalled();
    expect((await db.select().from(schema.managedConnectorAuthFlow))[0].state).toBe('waiting');
  });
  it('requires a separate explicit no-auth confirmation and rejects OAuth at the fields boundary', async () => {
    const f = await setup('NO_AUTH');
    const input = await f.submission();
    expect(f.accounts.createFieldAccount).not.toHaveBeenCalled();
    // A waiting fields row must not enter the OAuth redeemer even with its real owner cookie.
    await expect(
      completeManagedAuthentication({
        db,
        ownerId: 'owner-a',
        cookieValue: input.cookieValue,
        sessionUri: 'fake-opaque',
        createAccounts: () => ({
          accounts: f.accounts,
          executionConfigDigest: f.material().executionConfigDigest,
        }),
        signal: signal(),
      })
    ).rejects.toThrow();
    expect(f.accounts.completeAuth).not.toHaveBeenCalled();
    expect((await db.select().from(schema.managedConnectorAuthFlow))[0].state).toBe('waiting');
    await expect(f.service.completeFields(input)).resolves.toMatchObject({
      connectionId: expect.any(String),
    });
    expect(f.accounts.createFieldAccount.mock.calls[0][0].fields).toEqual({});
    expect(f.accounts.createLink).not.toHaveBeenCalled();
    await expect(
      completeManagedAuthentication({
        db,
        ownerId: 'owner-a',
        cookieValue: input.cookieValue,
        sessionUri: 'fake-opaque',
        createAccounts: () => ({
          accounts: f.accounts,
          executionConfigDigest: f.material().executionConfigDigest,
        }),
        signal: signal(),
      })
    ).rejects.toThrow();
    expect(f.accounts.completeAuth).not.toHaveBeenCalled();
  });
  it('keeps auto-resolved OAuth on the deferred callback and never accepts fields or poll as completion', async () => {
    const f = await setup('OAUTH2');
    const bound = await f.bind();
    expect(bound.kind).toBe('oauth');
    await expect(
      f.service.readFieldsPage({
        ownerId: 'owner-a',
        cookieValue: bound.cookieValue,
        signal: signal(),
      })
    ).resolves.toBeNull();
    await expect(
      f.service.completeFields({
        ownerId: 'owner-a',
        cookieValue: bound.cookieValue,
        csrfToken: 'fake',
        descriptorDigest: '0'.repeat(64),
        fields: {},
        requestOrigin: 'https://dorkos.test',
        expectedOrigin: 'https://dorkos.test',
        signal: signal(),
      })
    ).rejects.toThrow();
    expect(
      await reconcileManagedAuthentication({
        db,
        principal: f.principal,
        providerUserId: f.tenant.providerUserId,
        materialGeneration: 1,
        executionConfigDigest: f.material().executionConfigDigest,
        accounts: f.accounts,
        flowId: f.started.flowId,
        signal: signal(),
      })
    ).toBe(false);
    await expect(
      completeManagedAuthentication({
        db,
        ownerId: 'owner-a',
        cookieValue: bound.cookieValue,
        sessionUri: 'opaque-session',
        createAccounts: () => ({
          accounts: f.accounts,
          executionConfigDigest: f.material().executionConfigDigest,
        }),
        signal: signal(),
      })
    ).resolves.toMatchObject({ connectionId: expect.any(String) });
    expect(f.accounts.completeAuth).toHaveBeenCalledTimes(1);
    expect(f.accounts.createFieldAccount).not.toHaveBeenCalled();
  });
  it('lets only one of two already-validated submissions consume the flow', async () => {
    const f = await setup();
    const input = await f.submission();
    const original = f.accounts.getToolkitAuthentication.getMockImplementation()!;
    let arrivals = 0;
    let release!: () => void;
    const bothReading = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.accounts.getToolkitAuthentication.mockImplementation(async (toolkit) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReading;
      return original(toolkit);
    });
    const results = await Promise.allSettled([
      f.service.completeFields(input),
      f.service.completeFields(input),
    ]);
    expect(arrivals).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.managedConnectorConnection)).toHaveLength(1);
  });
  it('allows only one concurrent submission and never repeats a lost account create', async () => {
    const f = await setup();
    const input = await f.submission();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.accounts.createFieldAccount.mockImplementation(async () => {
      enter();
      await held;
      throw new Error(SECRET);
    });
    const first = f.service.completeFields(input);
    const caught = first.catch((error: unknown) => error);
    await Promise.race([
      entered,
      caught.then((error) => {
        throw error;
      }),
    ]);
    await expect(f.service.completeFields(input)).rejects.toThrow();
    release();
    const error = await caught;
    expect(String(error)).not.toContain(SECRET);
    await expect(f.service.completeFields(input)).rejects.toThrow();
    expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(schema.managedConnectorAuthFlow);
    expect(rows[0].state).toBe('reconcile');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
  it.each(['throws', 'empty'] as const)(
    'retains the known account ID when its first persistence write %s',
    async (failure) => {
      const f = await setup();
      const input = await f.submission();
      const create = f.accounts.createFieldAccount.getMockImplementation()!;
      f.accounts.createFieldAccount.mockImplementationOnce(async (request) => {
        const created = await create(request);
        vi.spyOn(db, 'update').mockImplementationOnce(() => {
          if (failure === 'throws') throw new Error('Synthetic one-shot DB write failure');
          return {
            set: () => ({ where: () => ({ returning: async () => [] }) }),
          } as unknown as ReturnType<ManagedConnectorDatabase['update']>;
        });
        return created;
      });
      await expect(f.service.completeFields(input)).rejects.toThrow('could not be confirmed');
      expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(1);
      expect(f.accounts.getAccount).not.toHaveBeenCalled();
      expect((await db.select().from(schema.managedConnectorAuthFlow))[0]).toMatchObject({
        state: 'reconcile',
        provisionalExternalAccountRef: 'ca_1',
      });
      await expect(f.service.completeFields(input)).rejects.toThrow();
      expect(
        await reconcileManagedAuthentication({
          db,
          principal: f.principal,
          providerUserId: f.tenant.providerUserId,
          materialGeneration: 1,
          executionConfigDigest: f.material().executionConfigDigest,
          accounts: f.accounts,
          flowId: f.started.flowId,
          signal: signal(),
        })
      ).toBe(true);
      expect(f.accounts.getAccount).toHaveBeenCalledWith('ca_1', expect.any(AbortSignal));
      expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(1);
      expect((await db.select().from(schema.managedConnectorAuthFlow))[0].state).toBe('connected');
      expect(await db.select().from(schema.managedConnectorConnection)).toHaveLength(1);
    }
  );
  it('keeps a persistent post-create database outage closed without replay or error disclosure', async () => {
    const f = await setup();
    const input = await f.submission();
    const create = f.accounts.createFieldAccount.getMockImplementation()!;
    let restore!: () => void;
    f.accounts.createFieldAccount.mockImplementationOnce(async (request) => {
      const created = await create(request);
      const spy = vi.spyOn(db, 'update').mockImplementation(() => {
        throw new Error(SECRET);
      });
      restore = () => spy.mockRestore();
      return created;
    });
    const error = await f.service.completeFields(input).catch((value: unknown) => value);
    restore();
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).toContain('could not be confirmed');
    expect((await db.select().from(schema.managedConnectorAuthFlow))[0].state).toBe('consumed');
    await expect(f.service.completeFields(input)).rejects.toThrow();
    expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(1);
  });
  it.each(['material', 'instance', 'descriptor', 'policy', 'returned-account'] as const)(
    'fails closed when %s changes',
    async (kind) => {
      const f = await setup();
      const input = await f.submission();
      if (kind === 'material') f.config.authConfigByToolkit = { synthetic: 'new_override' };
      if (kind === 'instance')
        await db
          .update(schema.instance)
          .set({ revokedAt: new Date() })
          .where(eq(schema.instance.id, 'instance-a'));
      if (kind === 'descriptor') {
        const original = f.accounts.getToolkitAuthentication.getMockImplementation()!;
        f.accounts.getToolkitAuthentication.mockImplementation(async (toolkit) => {
          const metadata = await original(toolkit);
          metadata.methods[0].descriptor!.fields[0].label = 'Changed field';
          return metadata;
        });
      }
      if (kind === 'policy') f.configs.get('ac_synthetic')!.policy!.routerEnabled = true;
      if (kind === 'returned-account')
        f.accounts.getAccount.mockImplementation(async (id) => ({
          connectedAccountId: id,
          providerUserId: 'foreign-owner',
          toolkit: 'synthetic',
          authConfigId: 'ac_synthetic',
          status: 'ACTIVE',
        }));
      await expect(f.service.completeFields(input)).rejects.toThrow();
      expect(await db.select().from(schema.managedConnectorConnection)).toEqual([]);
      expect(f.accounts.createFieldAccount).toHaveBeenCalledTimes(
        kind === 'returned-account' ? 1 : 0
      );
    }
  );
  it('uses a newly auto-resolved no-map account through existing authority and preserves it when another toolkit is added', async () => {
    const f = await setup();
    const input = await f.submission();
    const { connectionId } = await f.service.completeFields(input);
    expect(f.config.authConfigByToolkit).toEqual({});
    const listed = await listManagedConnections(db, f.principal, { version: 1, limit: 100 });
    expect(listed.accounts).toEqual([
      expect.objectContaining({
        managedConnectionId: connectionId,
        toolkit: 'synthetic',
        authenticationStatus: 'active',
      }),
    ]);
    const [revision] = await db
      .insert(schema.managedConnectorOperationRevision)
      .values({
        tenantId: f.tenant.id,
        providerInstanceId: 'managed:composio',
        toolkit: 'synthetic',
        operationSlug: 'synthetic.items.read',
        toolkitVersion: '20260910_00',
        schemaHash: 'sha256:synthetic',
        classification: 'read',
        inputSchema: { type: 'object' },
      })
      .returning();
    const selector = {
      hostedRevisionId: revision.id,
      operationSlug: revision.operationSlug,
      toolkitVersion: revision.toolkitVersion,
      schemaHash: revision.schemaHash,
    };
    await applyManagedAuthorityCommand(db, f.principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'new-account-grant',
      managedConnectionId: connectionId,
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [selector],
    });
    const operations = {
      execute: vi.fn(async (request: Parameters<ComposioOperationClient['execute']>[0]) => {
        expect(request.connectedAccountId).toBe('ca_1');
        expect(await request.authorizeDispatch()).toBe(true);
        return { status: 'success' as const, data: { synthetic: true } };
      }),
    } as unknown as ComposioOperationClient;
    const execute = (suffix: string) =>
      executeManagedConnectorOperation({
        db,
        principal: f.principal,
        accounts: f.accounts,
        operations,
        verifyLiveInstance: async () => true,
        signal: signal(),
        rawRequest: {
          version: 1,
          logicalOperationId: `logical-${suffix}`,
          attemptId: `attempt-${suffix}`,
          attemptIndex: 1,
          managedConnectionId: connectionId,
          agentId: 'agent-a',
          grantScopeVersion: 1,
          attribution: {
            surface: 'mcp',
            actorKind: 'agent',
            actorId: 'agent-a',
            sessionId: 'session-a',
          },
          revision: selector,
          arguments: {},
        },
      });
    expect(await execute('before')).toMatchObject({
      state: 'completed',
      result: { status: 'success' },
    });
    const oldConnection = await db.select().from(schema.managedConnectorConnection);
    const oldGrant = await db.select().from(schema.managedConnectorGrant);
    f.configs.get('ac_synthetic')!.name = 'Renamed display label after connecting';
    await resolveManagedAuthenticationConfiguration({
      db,
      accounts: f.accounts,
      toolkit: 'another-service',
      signal: signal(),
    });
    expect(
      await registerManagedProvider(db, {
        tenantId: f.tenant.id,
        providerInstanceId: 'managed:composio',
        configurationDigest: f.material().executionConfigDigest,
      })
    ).toBe(1);
    expect(await db.select().from(schema.managedConnectorConnection)).toEqual(oldConnection);
    expect(await db.select().from(schema.managedConnectorGrant)).toEqual(oldGrant);
    expect(oldConnection[0].authConfigId).toBe('ac_synthetic');
    expect(await execute('after')).toMatchObject({
      state: 'completed',
      result: { status: 'success' },
    });
    expect(operations.execute).toHaveBeenCalledTimes(2);
    const state = await getManagedAuthenticationState({
      db,
      principal: f.principal,
      flowId: f.started.flowId,
    });
    expect(state?.state).toBe('connected');
    expect(JSON.stringify(await db.select().from(schema.managedConnectorAuthFlow))).not.toContain(
      SECRET
    );
  });
});
