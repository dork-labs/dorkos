/**
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as siteSchema from '@/db/schema';
import {
  applyManagedAuthorityCommand,
  getManagedAuthorityCommandStatus,
  type ManagedConnectorDatabase,
  registerManagedProvider,
  resolveConnectorTenant,
} from '../authority-service';
import {
  executeManagedConnectorOperation,
  getManagedExecutionReceipt,
  ManagedExecutionConflictError,
  ManagedExecutionUnauthorizedError,
} from '../execution-service';
import {
  getManagedConnection,
  listManagedConnections,
  listManagedConnectorCatalog,
  listManagedOperationSchemas,
  resolveManagedToolkitVersion,
} from '../discovery-service';
import {
  bindManagedAuthenticationBrowser,
  completeManagedAuthentication,
  getManagedAuthenticationState,
  ManagedAuthenticationFlowError,
  reconcileManagedAuthentication,
  startManagedAuthentication,
} from '../authentication-service';
import type { ManagedConnectorConfig } from '../config';
import {
  listManagedConnectorUsage,
  ManagedUsageCursorError,
  ManagedUsageNotFoundError,
} from '../usage-service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../drizzle/', import.meta.url));
const MANAGED_MIGRATION_PREFIXES = ['0011_', '0012_', '0013_'];
const EXECUTION_ATTRIBUTION = {
  surface: 'mcp' as const,
  actorKind: 'agent' as const,
  actorId: 'agent-a',
  sessionId: 'session-a',
};

function isolatedMigrationFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'dorkos-managed-connectors-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };
  const selected = MANAGED_MIGRATION_PREFIXES.map((prefix) => {
    const name = readdirSync(MIGRATIONS_DIR).find(
      (file) => file.startsWith(prefix) && file.endsWith('.sql')
    );
    if (!name) throw new Error('Managed migration missing.');
    const entry = journal.entries.find((value) => value.tag === name.slice(0, -4));
    if (!entry) throw new Error('Managed migration journal entry missing.');
    writeFileSync(join(folder, name), readFileSync(join(MIGRATIONS_DIR, name)));
    return entry;
  });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: journal.version,
      dialect: journal.dialect,
      entries: selected.map((entry, idx) => ({ ...entry, idx })),
    })
  );
  return folder;
}

async function provisionBase(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "email_verified" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE "instance" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
      "name" text NOT NULL,
      "platform" text NOT NULL,
      "dorkos_version" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "last_seen_at" timestamp DEFAULT now() NOT NULL,
      "revoked_at" timestamp
    );
    CREATE TABLE "apikey" (
      "id" text PRIMARY KEY NOT NULL,
      "reference_id" text NOT NULL,
      "enabled" boolean DEFAULT true,
      "expires_at" timestamp,
      "permissions" text,
      "metadata" text
    );
    INSERT INTO "user" ("id", "name", "email") VALUES
      ('owner-a', 'Owner A', 'a@dork.test'),
      ('owner-b', 'Owner B', 'b@dork.test');
    INSERT INTO "instance" ("id", "user_id", "name", "platform", "dorkos_version") VALUES
      ('instance-a', 'owner-a', 'A', 'darwin', '1.0.0'),
      ('instance-c', 'owner-a', 'C', 'darwin', '1.0.0'),
      ('instance-b', 'owner-b', 'B', 'linux', '1.0.0');
    INSERT INTO "apikey" ("id", "reference_id", "enabled", "permissions", "metadata") VALUES
      ('key-a', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-a","scope":"instance"}'),
      ('key-c', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-c","scope":"instance"}'),
      ('key-b', 'owner-b', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-b","scope":"instance"}');
  `);
  const folder = isolatedMigrationFolder();
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('hosted managed authority service', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;

  beforeEach(async () => {
    client = new PGlite();
    await provisionBase(client);
    db = drizzle(client, { schema: siteSchema }) as unknown as ManagedConnectorDatabase;
  });

  afterEach(async () => {
    await client.close();
  });

  async function seedAuthority(ownerId = 'owner-a', instanceId = 'instance-a') {
    const tenant = await resolveConnectorTenant(db, ownerId);
    const materialGeneration = await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: 'digest-a',
    });
    await db.insert(siteSchema.managedConnectorConnection).values({
      tenantId: tenant.id,
      id: 'gmail-personal',
      originatingInstanceId: instanceId,
      providerInstanceId: 'managed:composio',
      providerUserId: tenant.providerUserId,
      externalAccountRef: 'ca_private_a',
      toolkit: 'gmail',
      authConfigId: 'ac_gmail',
      label: 'Personal Gmail',
      lifecycle: 'active',
      authenticationStatus: 'active',
      materialGeneration,
    });
    const [revision] = await db
      .insert(siteSchema.managedConnectorOperationRevision)
      .values({
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '20260901_00',
        schemaHash: 'sha256:schema-a',
        classification: 'read',
        inputSchema: { type: 'object' },
      })
      .returning();
    return {
      tenant,
      revision,
      executionAccounts: {
        getAccount: async (connectedAccountId: string) => ({
          connectedAccountId,
          providerUserId: tenant.providerUserId,
          toolkit: 'gmail',
          authConfigId: 'ac_gmail',
          status: 'ACTIVE',
        }),
      },
      principal: {
        ownerId,
        instanceId,
        tenantId: tenant.id,
        keyId: ownerId === 'owner-a' ? 'key-a' : 'key-b',
      },
    };
  }

  const managedConfig: ManagedConnectorConfig = {
    enabled: true,
    liveReady: true,
    projectApiKey: 'ck_test',
    callbackOrigin: 'https://dorkos.test',
    authConfigByToolkit: { gmail: 'ac_gmail' },
  };

  function revisionSelector(
    revision: typeof siteSchema.managedConnectorOperationRevision.$inferSelect
  ) {
    return {
      hostedRevisionId: revision.id,
      operationSlug: revision.operationSlug,
      toolkitVersion: revision.toolkitVersion,
      schemaHash: revision.schemaHash,
    };
  }

  async function seedExecution() {
    const seeded = await seedAuthority();
    await applyManagedAuthorityCommand(db, seeded.principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'regression-grant',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [revisionSelector(seeded.revision)],
    });
    return {
      ...seeded,
      request: {
        version: 1,
        logicalOperationId: 'regression-logical',
        attemptId: 'regression-attempt',
        attemptIndex: 1,
        managedConnectionId: 'gmail-personal',
        agentId: 'agent-a',
        grantScopeVersion: 1,
        attribution: EXECUTION_ATTRIBUTION,
        revision: revisionSelector(seeded.revision),
        arguments: {},
      },
    };
  }

  async function reclassify(
    revision: typeof siteSchema.managedConnectorOperationRevision.$inferSelect,
    classification: 'read' | 'write' = 'write'
  ) {
    const page = await listManagedOperationSchemas({
      db,
      principal: {
        ownerId: 'owner-a',
        instanceId: 'instance-a',
        tenantId: revision.tenantId,
        keyId: 'key-a',
      },
      operations: {
        listOperationSchemas: async () => ({
          status: 'ok',
          page: {
            truncated: false,
            operations: [
              {
                providerInstanceId: revision.providerInstanceId,
                toolkit: revision.toolkit,
                operationSlug: revision.operationSlug,
                toolkitVersion: revision.toolkitVersion,
                schemaHash: revision.schemaHash,
                capabilityClassification: classification,
                retryPolicy: 'never',
                inputSchema: revision.inputSchema,
              },
            ],
          },
        }),
      } as unknown as ComposioOperationClient,
      rawRequest: {
        version: 1,
        toolkit: revision.toolkit,
        toolkitVersion: revision.toolkitVersion,
        limit: 100,
      },
      signal: new AbortController().signal,
    });
    if (page.status !== 'ok') throw new Error('Missing operation page');
    return page.operations[0].hostedRevisionId;
  }

  it('rejects a superseded reclassified identity instead of granting its old row', async () => {
    const { principal, revision } = await seedAuthority();
    await reclassify(revision);
    const result = await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'ambiguous-grant',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [revisionSelector(revision)],
    });
    expect(result.status).toMatchObject({
      state: 'rejected',
      rejectionCode: 'revision_unavailable',
    });
    expect(await db.select().from(siteSchema.managedConnectorGrant)).toHaveLength(0);
  });

  it('denies an already granted operation when its hosted revision is superseded', async () => {
    const { principal, revision, request, executionAccounts } = await seedExecution();
    await reclassify(revision);
    let dispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'unused' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async () => {
        dispatches += 1;
        return { status: 'success', data: null };
      },
    };
    await expect(
      executeManagedConnectorOperation({
        db,
        principal,
        rawRequest: request,
        accounts: executionAccounts,
        operations,
        verifyLiveInstance: async () => true,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ManagedExecutionUnauthorizedError);
    expect(dispatches).toBe(0);
    expect(await db.select().from(siteSchema.managedConnectorExecutionAttempt)).toHaveLength(0);
  });

  it('denies reclassification that arrives after preflight but before the final dispatch claim', async () => {
    const { principal, revision, request, executionAccounts } = await seedExecution();
    let dispatchChecks = 0;
    const operations = {
      execute: async (input: Parameters<ComposioOperationClient['execute']>[0]) => {
        await reclassify(revision);
        dispatchChecks += 1;
        expect(await input.authorizeDispatch()).toBe(false);
        return {
          status: 'error',
          code: 'AUTHORITY_CHANGED',
          message: 'Authority changed.',
          retryable: false,
        };
      },
    } as ComposioOperationClient;
    await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: request,
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(dispatchChecks).toBe(1);
    const [attempt] = await db.select().from(siteSchema.managedConnectorExecutionAttempt);
    expect(attempt.dispatchClaimedAt).toBeNull();
  });

  it('requires explicit review of each fresh hosted identity and never revives an A-to-B-to-A grant', async () => {
    const { principal, revision, request, executionAccounts } = await seedExecution();
    const writeId = await reclassify(revision);
    expect(writeId).not.toBe(revision.id);
    const operations = {
      execute: async (input: Parameters<ComposioOperationClient['execute']>[0]) => {
        expect(await input.authorizeDispatch()).toBe(true);
        expect(input.operation.capabilityClassification).toBe('write');
        return { status: 'success', data: null };
      },
    } as ComposioOperationClient;
    const input = {
      db,
      principal,
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    };
    const reviewedRequest = {
      ...request,
      revision: { ...request.revision, hostedRevisionId: writeId },
      grantScopeVersion: 2,
    };
    await expect(
      executeManagedConnectorOperation({ ...input, rawRequest: reviewedRequest })
    ).rejects.toBeInstanceOf(ManagedExecutionUnauthorizedError);
    expect(
      (
        await applyManagedAuthorityCommand(db, principal, {
          version: 1,
          kind: 'replace_agent_grants',
          commandId: 'review-write',
          managedConnectionId: 'gmail-personal',
          agentId: 'agent-a',
          scopeVersion: 2,
          revisions: [reviewedRequest.revision],
        })
      ).status.state
    ).toBe('applied');
    const completed = await executeManagedConnectorOperation({
      ...input,
      rawRequest: reviewedRequest,
    });
    expect(completed.state).toBe('completed');
    const readAgainId = await reclassify(revision, 'read');
    expect(new Set([revision.id, writeId, readAgainId]).size).toBe(3);
    expect(await reclassify(revision, 'read')).toBe(readAgainId);
    const rows = await db.select().from(siteSchema.managedConnectorOperationRevision);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual([readAgainId]);
    const grants = await db.select().from(siteSchema.managedConnectorGrant);
    expect(grants).toHaveLength(2);
    expect(grants.map((grant) => grant.active)).toEqual([false, false]);
    for (const hostedRevisionId of [revision.id, writeId, readAgainId]) {
      await expect(
        executeManagedConnectorOperation({
          ...input,
          rawRequest: {
            ...request,
            attemptId: `denied-${hostedRevisionId}`,
            revision: { ...request.revision, hostedRevisionId },
          },
        })
      ).rejects.toBeInstanceOf(ManagedExecutionUnauthorizedError);
    }
    // History remains readable even after the revision ceases to be current.
    expect(
      await executeManagedConnectorOperation({ ...input, rawRequest: reviewedRequest })
    ).toMatchObject({ state: 'receipt_only' });
  });

  it('converges concurrent discovery of a reclassification on one current identity', async () => {
    const { revision } = await seedExecution();
    const ids = await Promise.all([
      reclassify(revision),
      reclassify(revision),
      reclassify(revision),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(revision.id);
    const rows = await db.select().from(siteSchema.managedConnectorOperationRevision);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual([ids[0]]);
    const grants = await db.select().from(siteSchema.managedConnectorGrant);
    expect(grants).toHaveLength(1);
    expect(grants[0].active).toBe(false);
  });

  it('returns an exact terminal receipt after revocation, disconnection, and provider loss', async () => {
    const { principal, request, executionAccounts } = await seedExecution();
    let accountReads = 0;
    let dispatches = 0;
    const accounts = {
      getAccount: async (id: string) => {
        accountReads += 1;
        if (accountReads > 1) throw new Error('Provider is offline');
        return executionAccounts.getAccount(id);
      },
    };
    const operations = {
      execute: async (input: Parameters<ComposioOperationClient['execute']>[0]) => {
        expect(await input.authorizeDispatch()).toBe(true);
        dispatches += 1;
        return { status: 'success', data: { private: 'result' } };
      },
    } as ComposioOperationClient;
    const input = {
      db,
      principal,
      rawRequest: request,
      accounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    };
    const first = await executeManagedConnectorOperation(input);
    expect(first.state).toBe('completed');
    if (first.state !== 'completed') throw new Error('Missing initial receipt');
    await db.update(siteSchema.managedConnectorGrant).set({ active: false, revokedAt: new Date() });
    for (const lifecycle of ['active', 'paused', 'disconnected'] as const) {
      await db.update(siteSchema.managedConnectorConnection).set({ lifecycle });
      expect(await executeManagedConnectorOperation(input)).toEqual({
        state: 'receipt_only',
        receipt: first.receipt,
      });
    }
    await expect(
      executeManagedConnectorOperation({
        ...input,
        rawRequest: { ...request, arguments: { different: true } },
      })
    ).rejects.toBeInstanceOf(ManagedExecutionConflictError);
    expect(accountReads).toBe(1);
    expect(dispatches).toBe(1);
  });

  it('claims disconnect cleanup once while concurrent retries wait for its provider result', async () => {
    const { tenant, principal } = await seedAuthority();
    const command = {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'concurrent-disconnect',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 2,
      lifecycle: 'disconnected',
    };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deletions = 0;
    const provider = {
      accounts: {
        getAccount: async () => {
          throw new Error('unused');
        },
        deleteAccount: async () => {
          deletions += 1;
          entered.resolve();
          await release.promise;
        },
      },
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      signal: new AbortController().signal,
    };
    const first = applyManagedAuthorityCommand(db, principal, command, provider);
    await entered.promise;
    const waiting = await applyManagedAuthorityCommand(db, principal, command, provider);
    expect(waiting.status).toMatchObject({ state: 'applied', externalCleanup: 'pending' });
    expect(deletions).toBe(1);
    release.resolve();
    expect((await first).status).toMatchObject({ state: 'applied', externalCleanup: 'complete' });
    expect(
      (await applyManagedAuthorityCommand(db, principal, command, provider)).status
    ).toMatchObject({ externalCleanup: 'complete' });
    expect(deletions).toBe(1);
  });

  it.each([
    { lifecycle: 'active' as const, lifecycleScopeVersion: 2, bindingGeneration: 2 },
    { lifecycle: 'disconnected' as const, lifecycleScopeVersion: 3, bindingGeneration: 1 },
    { lifecycle: 'disconnected' as const, lifecycleScopeVersion: 2, bindingGeneration: 2 },
  ])(
    'retires stale disconnect cleanup after its closed binding is superseded: %j',
    async (replacement) => {
      const { tenant, principal } = await seedAuthority();
      const command = {
        version: 1,
        kind: 'set_connection_lifecycle',
        commandId: 'stale-disconnect',
        managedConnectionId: 'gmail-personal',
        scopeVersion: 2,
        lifecycle: 'disconnected',
      };
      let deletions = 0;
      const provider = {
        accounts: {
          getAccount: async () => {
            throw new Error('unused');
          },
          deleteAccount: async () => {
            deletions += 1;
            throw new Error('temporary failure');
          },
        },
        providerUserId: tenant.providerUserId,
        materialGeneration: 1,
        executionConfigDigest: 'digest-a',
        signal: new AbortController().signal,
      };
      expect(
        (await applyManagedAuthorityCommand(db, principal, command, provider)).status
      ).toMatchObject({ state: 'applied', externalCleanup: 'failed' });
      await db.update(siteSchema.managedConnectorConnection).set(replacement);
      const retried = await applyManagedAuthorityCommand(db, principal, command, provider);
      expect(retried.status).toMatchObject({ state: 'superseded' });
      expect(deletions).toBe(1);
      expect((await applyManagedAuthorityCommand(db, principal, command, provider)).status).toEqual(
        retried.status
      );
      expect(deletions).toBe(1);
      expect((await db.select().from(siteSchema.managedConnectorConnection))[0]).toMatchObject(
        replacement
      );
    }
  );

  it('applies exact grants idempotently and rejects a conflicting command replay', async () => {
    const { tenant, revision, principal } = await seedAuthority();
    const command = {
      version: 1 as const,
      kind: 'replace_agent_grants' as const,
      commandId: 'command-a',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    };

    const first = await applyManagedAuthorityCommand(db, principal, command);
    expect(first.conflict).toBe(false);
    expect(first.status).toMatchObject({ state: 'applied', commandId: 'command-a' });
    await expect(applyManagedAuthorityCommand(db, principal, command)).resolves.toEqual(first);

    const conflict = await applyManagedAuthorityCommand(db, principal, {
      ...command,
      revisions: [],
    });
    expect(conflict.conflict).toBe(true);

    const grants = await db
      .select()
      .from(siteSchema.managedConnectorGrant)
      .where(eq(siteSchema.managedConnectorGrant.tenantId, tenant.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ agentId: 'agent-a', active: true, scopeVersion: 1 });
  });

  it('keeps identifiers tenant-scoped and supersedes an older authority version', async () => {
    const ownerA = await seedAuthority();
    const ownerB = await seedAuthority('owner-b', 'instance-b');

    const foreign = await applyManagedAuthorityCommand(db, ownerB.principal, {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'foreign-command',
      managedConnectionId: 'missing-in-owner-b',
      scopeVersion: 1,
      lifecycle: 'paused',
    });
    expect(foreign.status).toMatchObject({
      state: 'rejected',
      rejectionCode: 'connection_unavailable',
    });

    await applyManagedAuthorityCommand(db, ownerA.principal, {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'pause-v2',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 2,
      lifecycle: 'paused',
    });
    const stale = await applyManagedAuthorityCommand(db, ownerA.principal, {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'resume-v1',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 1,
      lifecycle: 'active',
    });
    expect(stale.status.state).toBe('superseded');
  });

  it('keeps resume closed until provider health passes and ignores a stale acknowledgement', async () => {
    const { principal } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'pause-before-resume',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 2,
      lifecycle: 'paused',
    });
    let checkedWhilePaused = false;
    const result = await applyManagedAuthorityCommand(
      db,
      principal,
      {
        version: 1,
        kind: 'set_connection_lifecycle',
        commandId: 'resume-health-check',
        managedConnectionId: 'gmail-personal',
        scopeVersion: 3,
        lifecycle: 'active',
      },
      {
        accounts: {
          getAccount: async () => {
            const [duringCheck] = await db
              .select()
              .from(siteSchema.managedConnectorConnection)
              .where(eq(siteSchema.managedConnectorConnection.id, 'gmail-personal'));
            checkedWhilePaused = duringCheck.lifecycle === 'paused';
            await applyManagedAuthorityCommand(db, principal, {
              version: 1,
              kind: 'set_connection_lifecycle',
              commandId: 'newer-pause',
              managedConnectionId: 'gmail-personal',
              scopeVersion: 4,
              lifecycle: 'paused',
            });
            return {
              connectedAccountId: 'ca_private_a',
              providerUserId: duringCheck.providerUserId,
              toolkit: 'gmail',
              authConfigId: 'ac_gmail',
              status: 'ACTIVE',
            };
          },
          deleteAccount: async () => undefined,
        },
        providerUserId: (await resolveConnectorTenant(db, principal.ownerId)).providerUserId,
        materialGeneration: 1,
        executionConfigDigest: 'digest-a',
        signal: new AbortController().signal,
      }
    );
    expect(checkedWhilePaused).toBe(true);
    expect(result.status.state).toBe('superseded');
    const [connection] = await db
      .select()
      .from(siteSchema.managedConnectorConnection)
      .where(eq(siteSchema.managedConnectorConnection.id, 'gmail-personal'));
    expect(connection.lifecycle).toBe('paused');
    expect(connection.lifecycleScopeVersion).toBe(4);

    const resumed = await applyManagedAuthorityCommand(
      db,
      principal,
      {
        version: 1,
        kind: 'set_connection_lifecycle',
        commandId: 'resume-current',
        managedConnectionId: 'gmail-personal',
        scopeVersion: 5,
        lifecycle: 'active',
      },
      {
        accounts: {
          getAccount: async () => ({
            connectedAccountId: 'ca_private_a',
            providerUserId: connection.providerUserId,
            toolkit: 'gmail',
            authConfigId: 'ac_gmail',
            status: 'ACTIVE',
          }),
          deleteAccount: async () => undefined,
        },
        providerUserId: connection.providerUserId,
        materialGeneration: 1,
        executionConfigDigest: 'digest-a',
        signal: new AbortController().signal,
      }
    );
    expect(resumed.status.state).toBe('applied');
    const [active] = await db
      .select()
      .from(siteSchema.managedConnectorConnection)
      .where(eq(siteSchema.managedConnectorConnection.id, 'gmail-personal'));
    expect(active.lifecycle).toBe('active');
    expect(active.lifecycleScopeVersion).toBe(5);
  });

  it('closes hosted authority before disconnect cleanup and retries failed cleanup idempotently', async () => {
    const { tenant, revision, principal } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-before-disconnect',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    let cleanupCalls = 0;
    const command = {
      version: 1 as const,
      kind: 'set_connection_lifecycle' as const,
      commandId: 'disconnect-account',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 2,
      lifecycle: 'disconnected' as const,
    };
    const provider = {
      accounts: {
        getAccount: async () => {
          throw new Error('not used');
        },
        deleteAccount: async () => {
          cleanupCalls += 1;
          const [connection] = await db
            .select()
            .from(siteSchema.managedConnectorConnection)
            .where(eq(siteSchema.managedConnectorConnection.id, 'gmail-personal'));
          const [grant] = await db
            .select()
            .from(siteSchema.managedConnectorGrant)
            .where(eq(siteSchema.managedConnectorGrant.tenantId, tenant.id));
          expect(connection.lifecycle).toBe('disconnected');
          expect(grant.active).toBe(false);
          if (cleanupCalls === 1) throw new Error('provider unavailable');
        },
      },
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      signal: new AbortController().signal,
    };

    const first = await applyManagedAuthorityCommand(db, principal, command, provider);
    expect(first.status).toMatchObject({
      state: 'applied',
      externalCleanup: 'failed',
    });
    const retry = await applyManagedAuthorityCommand(db, principal, command, provider);
    expect(retry.status).toMatchObject({
      state: 'applied',
      externalCleanup: 'complete',
    });
    expect(cleanupCalls).toBe(2);
  });

  it('keeps a provider-unavailable resume pending and retries the exact command', async () => {
    const { tenant, principal } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'set_connection_lifecycle',
      commandId: 'pause-for-retry',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 2,
      lifecycle: 'paused',
    });
    let healthChecks = 0;
    const command = {
      version: 1 as const,
      kind: 'set_connection_lifecycle' as const,
      commandId: 'resume-retry',
      managedConnectionId: 'gmail-personal',
      scopeVersion: 3,
      lifecycle: 'active' as const,
    };
    const provider = {
      accounts: {
        getAccount: async () => {
          healthChecks += 1;
          if (healthChecks === 1) throw new Error('temporary provider failure');
          return {
            connectedAccountId: 'ca_private_a',
            providerUserId: tenant.providerUserId,
            toolkit: 'gmail',
            authConfigId: 'ac_gmail',
            status: 'ACTIVE',
          };
        },
        deleteAccount: async () => undefined,
      },
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      signal: new AbortController().signal,
    };

    await expect(
      applyManagedAuthorityCommand(db, principal, command, provider)
    ).rejects.toMatchObject({ name: 'ManagedAuthorityProviderUnavailableError' });
    await expect(
      getManagedAuthorityCommandStatus(db, principal, command.commandId)
    ).resolves.toMatchObject({
      state: 'pending',
    });
    await expect(
      applyManagedAuthorityCommand(db, principal, command, provider)
    ).resolves.toMatchObject({
      conflict: false,
      status: { state: 'applied' },
    });
    expect(healthChecks).toBe(2);
  });

  it('closes existing connection authority when provider material changes', async () => {
    const { tenant, revision, principal } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-v1',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });

    await expect(
      registerManagedProvider(db, {
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        configurationDigest: 'digest-b',
      })
    ).resolves.toBe(2);

    const [connection] = await db
      .select()
      .from(siteSchema.managedConnectorConnection)
      .where(
        and(
          eq(siteSchema.managedConnectorConnection.tenantId, tenant.id),
          eq(siteSchema.managedConnectorConnection.id, 'gmail-personal')
        )
      );
    const [grant] = await db
      .select()
      .from(siteSchema.managedConnectorGrant)
      .where(eq(siteSchema.managedConnectorGrant.tenantId, tenant.id));
    expect(connection.lifecycle).toBe('paused');
    expect(grant.active).toBe(false);
    expect(grant.revokedAt).toBeInstanceOf(Date);
  });

  it('persists exact hosted discovery and scopes account inventory to the originating instance', async () => {
    const { tenant, principal } = await seedAuthority();
    await db.insert(siteSchema.managedConnectorConnection).values({
      tenantId: tenant.id,
      id: 'gmail-instance-c',
      originatingInstanceId: 'instance-c',
      providerInstanceId: 'managed:composio',
      providerUserId: tenant.providerUserId,
      externalAccountRef: 'ca_private_c',
      toolkit: 'gmail',
      authConfigId: 'ac_gmail',
      label: 'Other Gmail',
      lifecycle: 'active',
      authenticationStatus: 'active',
      materialGeneration: 1,
    });
    const operations: ComposioOperationClient = {
      listToolkitPage: async (request) => ({
        status: 'ok',
        toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
        ...(request.limit === 1 ? { nextCursor: 'next-page' } : {}),
        truncated: request.limit === 1,
      }),
      resolveToolkitVersion: async (toolkit) => ({
        status: 'ok',
        toolkit,
        toolkitVersion: '20260902_00',
      }),
      listOperationSchemas: async (providerInstanceId, request) => ({
        status: 'ok',
        page: {
          operations: [
            {
              providerInstanceId,
              toolkit: request.toolkit,
              operationSlug: 'gmail.messages.list',
              toolkitVersion: request.toolkitVersion,
              schemaHash: 'sha256:catalog',
              capabilityClassification: 'read',
              retryPolicy: 'never',
              inputSchema: { type: 'object' },
            },
          ],
          truncated: false,
        },
      }),
      execute: async () => ({ status: 'unsupported', reason: 'not used' }),
    };

    await expect(
      listManagedConnectorCatalog({
        operations,
        config: managedConfig,
        rawRequest: { version: 1, query: 'mail', limit: 1 },
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      version: 1,
      truncated: true,
      nextCursor: 'next-page',
      toolkits: [{ slug: 'gmail', authentication: { status: 'available' } }],
    });
    await expect(
      listManagedConnectorCatalog({
        operations,
        config: { ...managedConfig, authConfigByToolkit: {} },
        rawRequest: { version: 1, query: 'mail', limit: 1 },
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      toolkits: [
        {
          slug: 'gmail',
          authentication: {
            status: 'unsupported',
            reason: 'Managed account sign-in is not available for this service yet.',
          },
        },
      ],
    });
    await expect(
      resolveManagedToolkitVersion({
        operations,
        rawRequest: { version: 1, toolkit: 'gmail' },
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      version: 1,
      status: 'ok',
      toolkit: 'gmail',
      toolkitVersion: '20260902_00',
    });
    await expect(
      listManagedOperationSchemas({
        db,
        principal,
        operations,
        rawRequest: {
          version: 1,
          toolkit: 'gmail',
          toolkitVersion: '20260902_00',
          limit: 100,
        },
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      version: 1,
      status: 'ok',
      operations: [{ operationSlug: 'gmail.messages.list' }],
    });
    const persisted = await db
      .select()
      .from(siteSchema.managedConnectorOperationRevision)
      .where(eq(siteSchema.managedConnectorOperationRevision.schemaHash, 'sha256:catalog'));
    expect(persisted).toHaveLength(1);

    const own = await listManagedConnections(db, principal, { version: 1, limit: 100 });
    expect(own.accounts.map((account) => account.managedConnectionId)).toEqual(['gmail-personal']);
    await expect(getManagedConnection(db, principal, 'gmail-instance-c')).resolves.toBeNull();
    await expect(
      getManagedConnection(
        db,
        { ...principal, instanceId: 'instance-c', keyId: 'key-c' },
        'gmail-instance-c'
      )
    ).resolves.toMatchObject({ account: { managedConnectionId: 'gmail-instance-c' } });
  });

  it('does not let another live instance under the same owner claim a managed connection', async () => {
    const { tenant, revision, principal, executionAccounts } = await seedAuthority();
    const otherInstance = {
      ...principal,
      instanceId: 'instance-c',
      keyId: 'key-c',
    };
    await expect(
      applyManagedAuthorityCommand(db, otherInstance, {
        version: 1,
        kind: 'replace_agent_grants',
        commandId: 'foreign-instance-grant',
        managedConnectionId: 'gmail-personal',
        agentId: 'agent-a',
        scopeVersion: 1,
        revisions: [
          {
            hostedRevisionId: revision.id,
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
          },
        ],
      })
    ).resolves.toMatchObject({
      conflict: false,
      status: { state: 'rejected', rejectionCode: 'connection_unavailable' },
    });
    const grants = await db
      .select()
      .from(siteSchema.managedConnectorGrant)
      .where(eq(siteSchema.managedConnectorGrant.tenantId, tenant.id));
    expect(grants).toHaveLength(0);

    await expect(
      executeManagedConnectorOperation({
        db,
        principal: otherInstance,
        rawRequest: {
          version: 1,
          logicalOperationId: 'foreign-logical',
          attemptId: 'foreign-attempt',
          attemptIndex: 1,
          managedConnectionId: 'gmail-personal',
          agentId: 'agent-a',
          grantScopeVersion: 1,
          attribution: EXECUTION_ATTRIBUTION,
          revision: {
            hostedRevisionId: revision.id,
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
          },
          arguments: {},
        },
        accounts: executionAccounts,
        operations: {
          listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
          resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
          listOperationSchemas: async () => ({
            status: 'ok',
            page: { operations: [], truncated: false },
          }),
          execute: async () => {
            throw new Error('foreign instance reached provider dispatch');
          },
        },
        verifyLiveInstance: async () => true,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ name: 'ManagedExecutionUnauthorizedError' });
  });

  it('dispatches the exact account once and replays only its durable receipt', async () => {
    const { tenant, revision, principal, executionAccounts } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-execution',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    const request = {
      version: 1 as const,
      logicalOperationId: 'logical-a',
      attemptId: 'attempt-a',
      attemptIndex: 1,
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      grantScopeVersion: 1,
      attribution: EXECUTION_ATTRIBUTION,
      revision: {
        hostedRevisionId: revision.id,
        operationSlug: revision.operationSlug,
        toolkitVersion: revision.toolkitVersion,
        schemaHash: revision.schemaHash,
      },
      arguments: { query: 'from:me' },
    };
    let dispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async (input) => {
        expect(input.connectedAccountId).toBe('ca_private_a');
        expect(input.operation.toolkitVersion).toBe('20260901_00');
        expect(input.arguments).toEqual({ query: 'from:me' });
        expect(await input.authorizeDispatch()).toBe(true);
        dispatches += 1;
        const [duringDispatch] = await db
          .select()
          .from(siteSchema.managedConnectorExecutionAttempt)
          .where(eq(siteSchema.managedConnectorExecutionAttempt.attemptId, 'attempt-a'));
        expect(duringDispatch).toMatchObject({ state: 'pending', outcome: null });
        expect(duringDispatch.dispatchClaimedAt).toBeInstanceOf(Date);
        return {
          status: 'success',
          data: { messages: ['private result'] },
          providerLogId: 'provider-log-private-a',
        };
      },
    };

    const first = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: request,
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({
      state: 'completed',
      result: { status: 'success' },
      receipt: { attemptId: 'attempt-a', outcome: 'success' },
    });
    const replay = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: request,
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(replay).toMatchObject({
      state: 'receipt_only',
      receipt: { attemptId: 'attempt-a', outcome: 'success' },
    });
    expect(dispatches).toBe(1);

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'managed_connector_execution_attempt'`
    );
    expect(columns.rows.map((row) => row.column_name)).toContain('provider_log_id');
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['arguments', 'result'])
    );
    const [persisted] = await db
      .select()
      .from(siteSchema.managedConnectorExecutionAttempt)
      .where(eq(siteSchema.managedConnectorExecutionAttempt.tenantId, tenant.id));
    expect(JSON.stringify(persisted)).not.toContain('from:me');
    expect(JSON.stringify(persisted)).not.toContain('private result');
    expect(persisted.providerLogId).toBe('provider-log-private-a');
    expect(JSON.stringify(replay)).not.toContain('provider-log-private-a');

    await expect(
      executeManagedConnectorOperation({
        db,
        principal,
        rawRequest: { ...request, arguments: { query: 'different' } },
        accounts: executionAccounts,
        operations,
        verifyLiveInstance: async () => true,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ManagedExecutionConflictError);
    expect(dispatches).toBe(1);
  });

  it('pages authoritative hosted usage without leaking across cursor or connection scope', async () => {
    const { tenant, revision, principal } = await seedAuthority();
    const startedAt = [
      new Date('2026-09-06T00:00:01.000Z'),
      new Date('2026-09-06T00:00:02.000Z'),
      new Date('2026-09-06T00:00:03.000Z'),
    ];
    await db.insert(siteSchema.managedConnectorExecutionAttempt).values([
      {
        tenantId: tenant.id,
        instanceId: principal.instanceId,
        attemptId: 'usage-attempt-a',
        logicalOperationId: 'usage-logical-a',
        attemptIndex: 1,
        requestHash: 'request-a',
        connectionId: 'gmail-personal',
        agentId: 'agent-a',
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-a',
        sessionId: 'session-a',
        grantScopeVersion: 1,
        operationRevisionId: revision.id,
        state: 'recorded',
        executionLeaseToken: '00000000-0000-4000-8000-000000000001',
        leaseExpiresAt: startedAt[0],
        dispatchClaimedAt: startedAt[0],
        outcome: 'success',
        completedAt: startedAt[0],
        recordedAt: startedAt[0],
        createdAt: startedAt[0],
      },
      {
        tenantId: tenant.id,
        instanceId: principal.instanceId,
        attemptId: 'usage-attempt-b',
        logicalOperationId: 'usage-logical-a',
        attemptIndex: 2,
        requestHash: 'request-b',
        connectionId: 'gmail-personal',
        agentId: 'agent-a',
        surface: 'rest',
        actorKind: 'program',
        actorId: 'program-a',
        grantScopeVersion: 1,
        operationRevisionId: revision.id,
        state: 'recorded',
        executionLeaseToken: '00000000-0000-4000-8000-000000000002',
        leaseExpiresAt: startedAt[1],
        dispatchClaimedAt: startedAt[1],
        outcome: 'error',
        errorCode: 'PROVIDER_ERROR',
        completedAt: startedAt[1],
        recordedAt: startedAt[1],
        createdAt: startedAt[1],
      },
      {
        tenantId: tenant.id,
        instanceId: principal.instanceId,
        attemptId: 'usage-attempt-c',
        logicalOperationId: 'usage-logical-b',
        attemptIndex: 1,
        requestHash: 'request-c',
        connectionId: 'gmail-personal',
        agentId: 'agent-b',
        surface: 'cli',
        actorKind: 'program',
        actorId: 'program-b',
        grantScopeVersion: 1,
        operationRevisionId: revision.id,
        state: 'pending',
        executionLeaseToken: '00000000-0000-4000-8000-000000000003',
        leaseExpiresAt: startedAt[2],
        createdAt: startedAt[2],
      },
    ]);

    const first = await listManagedConnectorUsage({
      db,
      principal,
      rawRequest: { version: 1, managedConnectionId: 'gmail-personal', limit: 2 },
      cursorSecret: 'cursor-secret',
    });
    expect(first).toMatchObject({
      status: 'available',
      counts: { logicalOperationCount: 2, attemptCount: 3 },
      items: [
        { attemptId: 'usage-attempt-c', state: 'pending' },
        { attemptId: 'usage-attempt-b', state: 'recorded' },
      ],
    });
    if (first.status !== 'available' || !first.nextCursor) throw new Error('missing cursor');
    expect(first.nextCursor.length).toBeLessThanOrEqual(500);
    expect(first.nextCursor).not.toContain('usage-attempt-b');
    expect(JSON.stringify(first)).not.toContain('session-a');
    expect(JSON.stringify(first)).not.toContain('program-a');

    await db.insert(siteSchema.managedConnectorExecutionAttempt).values({
      tenantId: tenant.id,
      instanceId: principal.instanceId,
      attemptId: 'usage-attempt-new',
      logicalOperationId: 'usage-logical-new',
      attemptIndex: 1,
      requestHash: 'request-new',
      connectionId: 'gmail-personal',
      agentId: 'agent-a',
      surface: 'event',
      actorKind: 'event',
      actorId: 'subscription-a',
      grantScopeVersion: 1,
      operationRevisionId: revision.id,
      state: 'pending',
      executionLeaseToken: '00000000-0000-4000-8000-000000000004',
      leaseExpiresAt: new Date('2026-09-06T00:00:04.000Z'),
      createdAt: new Date('2026-09-06T00:00:04.000Z'),
    });
    const second = await listManagedConnectorUsage({
      db,
      principal,
      rawRequest: {
        version: 1,
        managedConnectionId: 'gmail-personal',
        cursor: first.nextCursor,
        limit: 2,
      },
      cursorSecret: 'cursor-secret',
    });
    expect(second).toMatchObject({
      status: 'available',
      counts: { logicalOperationCount: 3, attemptCount: 4 },
      items: [{ attemptId: 'usage-attempt-a' }],
    });

    await expect(
      listManagedConnectorUsage({
        db,
        principal: { ...principal, instanceId: 'instance-c', keyId: 'key-c' },
        rawRequest: { version: 1, cursor: first.nextCursor },
        cursorSecret: 'cursor-secret',
      })
    ).rejects.toBeInstanceOf(ManagedUsageCursorError);
    await expect(
      listManagedConnectorUsage({
        db,
        principal: { ...principal, instanceId: 'instance-c', keyId: 'key-c' },
        rawRequest: { version: 1, managedConnectionId: 'gmail-personal' },
        cursorSecret: 'cursor-secret',
      })
    ).rejects.toBeInstanceOf(ManagedUsageNotFoundError);
  });

  it('recovers an abandoned dispatch through receipt reads without current grant authority', async () => {
    const { revision, principal, executionAccounts } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-abandoned-dispatch',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    const request = {
      version: 1 as const,
      logicalOperationId: 'logical-abandoned',
      attemptId: 'attempt-abandoned',
      attemptIndex: 1,
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      grantScopeVersion: 1,
      attribution: EXECUTION_ATTRIBUTION,
      revision: {
        hostedRevisionId: revision.id,
        operationSlug: revision.operationSlug,
        toolkitVersion: revision.toolkitVersion,
        schemaHash: revision.schemaHash,
      },
      arguments: {},
    };
    let dispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async (providerInput) => {
        expect(await providerInput.authorizeDispatch()).toBe(true);
        dispatches += 1;
        await db
          .update(siteSchema.managedConnectorExecutionAttempt)
          .set({ dispatchClaimedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(siteSchema.managedConnectorExecutionAttempt.attemptId, request.attemptId));
        await db
          .update(siteSchema.managedConnectorGrant)
          .set({ active: false, revokedAt: new Date() })
          .where(eq(siteSchema.managedConnectorGrant.agentId, 'agent-a'));
        const recovered = await getManagedExecutionReceipt(db, principal, request.attemptId);
        expect(recovered).toMatchObject({
          state: 'recorded',
          receipt: { outcome: 'outcome_unknown', completedAt: null },
        });
        return { status: 'success', data: { tooLate: true } };
      },
    };

    const result = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: request,
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      state: 'receipt_only',
      receipt: { outcome: 'outcome_unknown', completedAt: null },
    });
    expect(dispatches).toBe(1);
    const [persisted] = await db
      .select()
      .from(siteSchema.managedConnectorExecutionAttempt)
      .where(eq(siteSchema.managedConnectorExecutionAttempt.attemptId, request.attemptId));
    expect(persisted).toMatchObject({ state: 'recorded', outcome: 'outcome_unknown' });
  });

  it('rechecks hosted authority after provider preflight and before dispatch', async () => {
    const { revision, principal, executionAccounts } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-race',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    let providerDispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async (input) => {
        await db
          .update(siteSchema.managedConnectorGrant)
          .set({ active: false, revokedAt: new Date() })
          .where(eq(siteSchema.managedConnectorGrant.agentId, 'agent-a'));
        if (!(await input.authorizeDispatch())) {
          return {
            status: 'error',
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Connector authority changed before the operation was sent.',
            retryable: false,
          };
        }
        providerDispatches += 1;
        return { status: 'success', data: {} };
      },
    };

    const result = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: {
        version: 1,
        logicalOperationId: 'logical-race',
        attemptId: 'attempt-race',
        attemptIndex: 1,
        managedConnectionId: 'gmail-personal',
        agentId: 'agent-a',
        grantScopeVersion: 1,
        attribution: EXECUTION_ATTRIBUTION,
        revision: {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
        arguments: {},
      },
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      state: 'completed',
      result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      receipt: { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    });
    expect(providerDispatches).toBe(0);
  });

  it('refuses a provider account that no longer matches the hosted binding', async () => {
    const { tenant, revision, principal } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-provider-account-check',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    let providerDispatches = 0;
    await expect(
      executeManagedConnectorOperation({
        db,
        principal,
        rawRequest: {
          version: 1,
          logicalOperationId: 'logical-account-mismatch',
          attemptId: 'attempt-account-mismatch',
          attemptIndex: 1,
          managedConnectionId: 'gmail-personal',
          agentId: 'agent-a',
          grantScopeVersion: 1,
          attribution: EXECUTION_ATTRIBUTION,
          revision: {
            hostedRevisionId: revision.id,
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
          },
          arguments: {},
        },
        accounts: {
          getAccount: async () => ({
            connectedAccountId: 'ca_private_a',
            providerUserId: tenant.providerUserId,
            toolkit: 'gmail',
            authConfigId: 'ac_gmail',
            status: 'REVOKED',
          }),
        },
        operations: {
          listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
          resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
          listOperationSchemas: async () => ({
            status: 'ok',
            page: { operations: [], truncated: false },
          }),
          execute: async () => {
            providerDispatches += 1;
            return { status: 'success', data: {} };
          },
        },
        verifyLiveInstance: async () => true,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ManagedExecutionUnauthorizedError);
    expect(providerDispatches).toBe(0);
    const attempts = await db
      .select()
      .from(siteSchema.managedConnectorExecutionAttempt)
      .where(eq(siteSchema.managedConnectorExecutionAttempt.tenantId, tenant.id));
    expect(attempts).toHaveLength(0);
  });

  it('rejects a key revoked after preflight at the final dispatch claim', async () => {
    const { revision, principal, executionAccounts } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-key-race',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    let providerDispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async (input) => {
        if (!(await input.authorizeDispatch())) {
          return {
            status: 'error',
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Connector authority changed before the operation was sent.',
            retryable: false,
          };
        }
        providerDispatches += 1;
        return { status: 'success', data: {} };
      },
    };

    const result = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: {
        version: 1,
        logicalOperationId: 'logical-key-race',
        attemptId: 'attempt-key-race',
        attemptIndex: 1,
        managedConnectionId: 'gmail-personal',
        agentId: 'agent-a',
        grantScopeVersion: 1,
        attribution: EXECUTION_ATTRIBUTION,
        revision: {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
        arguments: {},
      },
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => {
        await db
          .update(siteSchema.apikey)
          .set({ enabled: false })
          .where(eq(siteSchema.apikey.id, principal.keyId));
        return true;
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      state: 'completed',
      result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      receipt: { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    });
    expect(providerDispatches).toBe(0);
  });

  it('rejects captured provider account material after the binding changes', async () => {
    const { tenant, revision, principal, executionAccounts } = await seedAuthority();
    await applyManagedAuthorityCommand(db, principal, {
      version: 1,
      kind: 'replace_agent_grants',
      commandId: 'grant-binding-race',
      managedConnectionId: 'gmail-personal',
      agentId: 'agent-a',
      scopeVersion: 1,
      revisions: [
        {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
      ],
    });
    let providerDispatches = 0;
    const operations: ComposioOperationClient = {
      listToolkitPage: async () => ({ status: 'ok', toolkits: [], truncated: false }),
      resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'not used' }),
      listOperationSchemas: async () => ({
        status: 'ok',
        page: { operations: [], truncated: false },
      }),
      execute: async (input) => {
        expect(input.connectedAccountId).toBe('ca_private_a');
        await db
          .update(siteSchema.managedConnectorConnection)
          .set({ externalAccountRef: 'ca_private_b' })
          .where(
            and(
              eq(siteSchema.managedConnectorConnection.tenantId, tenant.id),
              eq(siteSchema.managedConnectorConnection.id, 'gmail-personal')
            )
          );
        if (!(await input.authorizeDispatch())) {
          return {
            status: 'error',
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Connector authority changed before the operation was sent.',
            retryable: false,
          };
        }
        providerDispatches += 1;
        return { status: 'success', data: {} };
      },
    };

    const result = await executeManagedConnectorOperation({
      db,
      principal,
      rawRequest: {
        version: 1,
        logicalOperationId: 'logical-binding-race',
        attemptId: 'attempt-binding-race',
        attemptIndex: 1,
        managedConnectionId: 'gmail-personal',
        agentId: 'agent-a',
        grantScopeVersion: 1,
        attribution: EXECUTION_ATTRIBUTION,
        revision: {
          hostedRevisionId: revision.id,
          operationSlug: revision.operationSlug,
          toolkitVersion: revision.toolkitVersion,
          schemaHash: revision.schemaHash,
        },
        arguments: {},
      },
      accounts: executionAccounts,
      operations,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      state: 'completed',
      result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      receipt: { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    });
    expect(providerDispatches).toBe(0);
  });

  it('claims account-link creation once and does not replay an ambiguous provider create', async () => {
    const { tenant, principal } = await seedAuthority();
    let creates = 0;
    const accounts = {
      createLink: async () => {
        creates += 1;
        throw new Error('response lost after provider accepted the create');
      },
    };
    const request = {
      version: 1 as const,
      toolkit: 'gmail',
      requestId: 'auth-once',
    };

    const first = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts,
      config: managedConfig,
      rawRequest: request,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(first.state).toBe('start_unknown');
    const replay = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts,
      config: managedConfig,
      rawRequest: request,
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(replay).toEqual(first);
    expect(creates).toBe(1);
  });

  it('requires the same signed-in browser and consumes a callback before provider redemption', async () => {
    const { tenant, principal } = await seedAuthority();
    const accounts = {
      createLink: async () => ({
        connectedAccountId: 'ca_callback_exact',
        redirectUrl: 'https://provider.test/consent',
      }),
    };
    const started = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts,
      config: managedConfig,
      rawRequest: {
        version: 1,
        toolkit: 'gmail',
        requestId: 'auth-complete',
      },
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(started.state).toBe('pending');
    if (started.state !== 'pending' || !started.authorizeUrl) throw new Error('missing URL');
    const authorizeUrl = new URL(started.authorizeUrl);
    const nonce = authorizeUrl.searchParams.get('nonce');
    if (!nonce) throw new Error('missing nonce');
    await expect(
      bindManagedAuthenticationBrowser({
        db,
        ownerId: 'owner-b',
        flowId: started.flowId,
        nonce,
      })
    ).resolves.toBeNull();
    await expect(
      bindManagedAuthenticationBrowser({
        db,
        ownerId: 'owner-a',
        flowId: started.flowId,
        nonce: 'wrong-browser',
      })
    ).resolves.toBeNull();
    const bound = await bindManagedAuthenticationBrowser({
      db,
      ownerId: 'owner-a',
      flowId: started.flowId,
      nonce,
    });
    expect(bound?.redirectUrl).toBe('https://provider.test/consent');
    await expect(
      bindManagedAuthenticationBrowser({ db, ownerId: 'owner-a', flowId: started.flowId, nonce })
    ).resolves.toBeNull();

    let redemptions = 0;
    const completionAccounts = {
      completeAuth: async () => {
        redemptions += 1;
        const [duringRedeem] = await db
          .select()
          .from(siteSchema.managedConnectorAuthFlow)
          .where(eq(siteSchema.managedConnectorAuthFlow.id, started.flowId));
        expect(duringRedeem.state).toBe('consumed');
        return { connectedAccountId: 'ca_callback_exact', toolkit: 'gmail' };
      },
      getAccount: async () => ({
        connectedAccountId: 'ca_callback_exact',
        providerUserId: tenant.providerUserId,
        toolkit: 'gmail',
        authConfigId: 'ac_gmail',
        status: 'ACTIVE',
      }),
    };
    const completed = await completeManagedAuthentication({
      db,
      ownerId: 'owner-a',
      cookieValue: bound!.cookieValue,
      sessionUri: 'opaque-provider-session',
      createAccounts: (providerUserId) => {
        expect(providerUserId).toBe(tenant.providerUserId);
        return { accounts: completionAccounts, executionConfigDigest: 'digest-a' };
      },
      signal: new AbortController().signal,
    });
    expect(completed.connectionId).toMatch(/^managed-/);
    const [flow] = await db
      .select()
      .from(siteSchema.managedConnectorAuthFlow)
      .where(eq(siteSchema.managedConnectorAuthFlow.id, started.flowId));
    expect(flow).toMatchObject({
      state: 'connected',
      provisionalExternalAccountRef: 'ca_callback_exact',
    });
    expect(JSON.stringify(flow)).not.toContain('opaque-provider-session');

    await expect(
      completeManagedAuthentication({
        db,
        ownerId: 'owner-a',
        cookieValue: bound!.cookieValue,
        sessionUri: 'opaque-provider-session',
        createAccounts: () => ({
          accounts: completionAccounts,
          executionConfigDigest: 'digest-a',
        }),
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ManagedAuthenticationFlowError);
    expect(redemptions).toBe(1);
  });

  it('recovers an ambiguous callback from the exact account without redeeming it twice', async () => {
    const { tenant, principal } = await seedAuthority();
    const started = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts: {
        createLink: async () => ({
          connectedAccountId: 'ca_recovered_callback',
          redirectUrl: 'https://provider.test/consent',
        }),
      },
      config: managedConfig,
      rawRequest: { version: 1, toolkit: 'gmail', requestId: 'auth-recover' },
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    if (started.state !== 'pending' || !started.authorizeUrl) throw new Error('missing URL');
    const nonce = new URL(started.authorizeUrl).searchParams.get('nonce');
    if (!nonce) throw new Error('missing nonce');
    const bound = await bindManagedAuthenticationBrowser({
      db,
      ownerId: principal.ownerId,
      flowId: started.flowId,
      nonce,
    });
    if (!bound) throw new Error('missing browser binding');

    let redemptions = 0;
    await expect(
      completeManagedAuthentication({
        db,
        ownerId: principal.ownerId,
        cookieValue: bound.cookieValue,
        sessionUri: 'opaque-provider-session',
        createAccounts: () => ({
          executionConfigDigest: 'digest-a',
          accounts: {
            completeAuth: async () => {
              redemptions += 1;
              return { connectedAccountId: 'ca_recovered_callback', toolkit: 'gmail' };
            },
            getAccount: async () => {
              throw new Error('response lost after provider completion');
            },
          },
        }),
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    const [uncertain] = await db
      .select()
      .from(siteSchema.managedConnectorAuthFlow)
      .where(eq(siteSchema.managedConnectorAuthFlow.id, started.flowId));
    expect(uncertain.state).toBe('reconcile');

    const recovered = await reconcileManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts: {
        getAccount: async () => ({
          connectedAccountId: 'ca_recovered_callback',
          providerUserId: tenant.providerUserId,
          toolkit: 'gmail',
          authConfigId: 'ac_gmail',
          status: 'ACTIVE',
        }),
      },
      flowId: started.flowId,
      signal: new AbortController().signal,
    });
    expect(recovered).toBe(true);
    expect(redemptions).toBe(1);
    await expect(
      getManagedAuthenticationState({
        db,
        principal,
        flowId: started.flowId,
      })
    ).resolves.toMatchObject({ state: 'connected' });
  });

  it('recovers the same upstream account only for its originating linked instance', async () => {
    const { tenant, principal } = await seedAuthority();
    const accounts = {
      createLink: async () => ({
        connectedAccountId: 'ca_private_a',
        redirectUrl: 'https://provider.test/consent',
      }),
    };
    const completionAccounts = {
      completeAuth: async () => ({ connectedAccountId: 'ca_private_a', toolkit: 'gmail' }),
      getAccount: async () => ({
        connectedAccountId: 'ca_private_a',
        providerUserId: tenant.providerUserId,
        toolkit: 'gmail',
        authConfigId: 'ac_gmail',
        status: 'ACTIVE',
      }),
    };
    const completeFor = async (
      flowPrincipal: typeof principal,
      requestId: string
    ): Promise<{ connectionId: string }> => {
      const started = await startManagedAuthentication({
        db,
        principal: flowPrincipal,
        providerUserId: tenant.providerUserId,
        materialGeneration: 1,
        executionConfigDigest: 'digest-a',
        accounts,
        config: managedConfig,
        rawRequest: { version: 1, toolkit: 'gmail', requestId },
        verifyLiveInstance: async () => true,
        signal: new AbortController().signal,
      });
      if (started.state !== 'pending' || !started.authorizeUrl) throw new Error('missing URL');
      const nonce = new URL(started.authorizeUrl).searchParams.get('nonce');
      if (!nonce) throw new Error('missing nonce');
      const bound = await bindManagedAuthenticationBrowser({
        db,
        ownerId: principal.ownerId,
        flowId: started.flowId,
        nonce,
      });
      if (!bound) throw new Error('flow did not bind');
      return completeManagedAuthentication({
        db,
        ownerId: principal.ownerId,
        cookieValue: bound.cookieValue,
        sessionUri: `session-${requestId}`,
        createAccounts: () => ({
          accounts: completionAccounts,
          executionConfigDigest: 'digest-a',
        }),
        signal: new AbortController().signal,
      });
    };

    await expect(completeFor(principal, 'same-instance-recovery')).resolves.toEqual({
      connectionId: 'gmail-personal',
    });
    const otherInstance = { ...principal, instanceId: 'instance-c', keyId: 'key-c' };
    await expect(completeFor(otherInstance, 'foreign-instance-recovery')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const connections = await db
      .select()
      .from(siteSchema.managedConnectorConnection)
      .where(eq(siteSchema.managedConnectorConnection.tenantId, tenant.id));
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: 'gmail-personal',
      originatingInstanceId: 'instance-a',
      externalAccountRef: 'ca_private_a',
    });
  });

  it('does not redeem an old flow with newly configured provider material', async () => {
    const { tenant, principal } = await seedAuthority();
    const started = await startManagedAuthentication({
      db,
      principal,
      providerUserId: tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'digest-a',
      accounts: {
        createLink: async () => ({
          connectedAccountId: 'ca_old_material',
          redirectUrl: 'https://provider.test/consent',
        }),
      },
      config: managedConfig,
      rawRequest: {
        version: 1,
        toolkit: 'gmail',
        requestId: 'auth-material-change',
      },
      verifyLiveInstance: async () => true,
      signal: new AbortController().signal,
    });
    expect(started.state).toBe('pending');
    if (started.state !== 'pending' || !started.authorizeUrl) throw new Error('missing URL');
    const nonce = new URL(started.authorizeUrl).searchParams.get('nonce');
    if (!nonce) throw new Error('missing nonce');
    const bound = await bindManagedAuthenticationBrowser({
      db,
      ownerId: principal.ownerId,
      flowId: started.flowId,
      nonce,
    });
    if (!bound) throw new Error('missing browser binding');

    await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: 'digest-b',
    });
    let providerCalls = 0;
    await expect(
      completeManagedAuthentication({
        db,
        ownerId: principal.ownerId,
        cookieValue: bound.cookieValue,
        sessionUri: 'opaque-provider-session',
        createAccounts: () => ({
          accounts: {
            completeAuth: async () => {
              providerCalls += 1;
              return { connectedAccountId: 'ca_old_material', toolkit: 'gmail' };
            },
            getAccount: async () => {
              providerCalls += 1;
              return {
                connectedAccountId: 'ca_old_material',
                providerUserId: tenant.providerUserId,
                toolkit: 'gmail',
                authConfigId: 'ac_gmail',
                status: 'ACTIVE',
              };
            },
          },
          executionConfigDigest: 'digest-b',
        }),
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(providerCalls).toBe(0);
  });
});
