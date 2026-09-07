/** Live authority and retry invariants for the DorkOS connector broker. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorProviderExecuteCommand,
  type ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorExternalAccountRef,
  ConnectorProvider,
} from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectionStore } from '../../connection-store.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorRuntimePrincipalService } from '../../principal/runtime-principal-service.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import { ConnectorExecutionBroker } from '../execution-broker.js';
import { ConnectorUsageStore } from '../usage-store.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = 'connection-a' as const;
const REVISION_ID = 'revision-a';
const DESTRUCTIVE_REVISION_ID = 'revision-destructive';
const RETRY_REVISION_ID = 'revision-retry';
const EXTERNAL_REF = 'provider-account-a' as ConnectorExternalAccountRef;

interface ScriptedProvider extends ConnectorProvider {
  readonly commands: ConnectorProviderExecuteCommand[];
  readonly dispatchedCommands: ConnectorProviderExecuteCommand[];
  readonly results: Array<ConnectorProviderExecuteResult | Error>;
  afterExecute?: () => void | Promise<void>;
  beforeDispatch?: () => void | Promise<void>;
}

function createScriptedProvider(): ScriptedProvider {
  const base = new FakeConnectorProvider({
    instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
    type: 'fake',
  });
  const commands: ConnectorProviderExecuteCommand[] = [];
  const dispatchedCommands: ConnectorProviderExecuteCommand[] = [];
  const results: Array<ConnectorProviderExecuteResult | Error> = [];
  const provider = base as unknown as ScriptedProvider;
  Object.defineProperties(provider, {
    commands: { value: commands },
    dispatchedCommands: { value: dispatchedCommands },
    results: { value: results },
    execute: {
      value: async (command: ConnectorProviderExecuteCommand) => {
        commands.push(command);
        await provider.beforeDispatch?.();
        if (!(await command.authorizeDispatch())) {
          return {
            status: 'error' as const,
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Connector authority changed before dispatch.',
            retryable: false,
          };
        }
        dispatchedCommands.push(command);
        const result = results.shift() ?? { status: 'success' as const, data: { ok: true } };
        await provider.afterExecute?.();
        if (result instanceof Error) throw result;
        return result;
      },
    },
  });
  return provider;
}

describe('ConnectorExecutionBroker', () => {
  let db: Db;
  let provider: ScriptedProvider;
  let registry: ConnectorRegistry;
  let authorization: ConnectorExecutionAuthorizationService;
  let broker: ConnectorExecutionBroker;
  const target = ConnectorExecutionTargetSchema.parse({
    connectionId: CONNECTION_ID,
    operationRevisionId: REVISION_ID,
    arguments: { message: 'hello' },
  });
  const destructiveTarget = ConnectorExecutionTargetSchema.parse({
    ...target,
    operationRevisionId: DESTRUCTIVE_REVISION_ID,
  });
  const retryTarget = ConnectorExecutionTargetSchema.parse({
    ...target,
    operationRevisionId: RETRY_REVISION_ID,
  });

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    provider = createScriptedProvider();
    registry = new ConnectorRegistry({ db });
    registry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: EXTERNAL_REF,
        toolkit: 'gmail',
        label: 'work',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-09-06T12:00:00.000Z',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values(
        [
          {
            id: REVISION_ID,
            operationSlug: 'gmail.send',
            capabilityClassification: 'write' as const,
            retryPolicy: 'never' as const,
          },
          {
            id: DESTRUCTIVE_REVISION_ID,
            operationSlug: 'gmail.delete',
            capabilityClassification: 'destructive' as const,
            retryPolicy: 'never' as const,
          },
          {
            id: RETRY_REVISION_ID,
            operationSlug: 'gmail.idempotent_send',
            capabilityClassification: 'write' as const,
            retryPolicy: 'provider_idempotency_key' as const,
          },
        ].map((revision) => ({
          ...revision,
          providerInstanceId: provider.instanceId,
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          schemaHash: `sha256:${revision.id}`,
          inputSchemaJson: JSON.stringify({
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          }),
          discoveredAt: '2026-09-06T12:00:00.000Z',
        }))
      )
      .run();
    db.insert(connectionOperationGrants)
      .values(
        [REVISION_ID, DESTRUCTIVE_REVISION_ID, RETRY_REVISION_ID].map((revisionId) => ({
          id: `grant-${revisionId}`,
          subjectType: 'agent' as const,
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: revisionId,
          createdBy: 'operator',
          createdAt: '2026-09-06T12:00:00.000Z',
        }))
      )
      .run();
    authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (_owner, agentId) => agentId === 'agent-a',
    });
    broker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: () => true },
      () => new Date('2026-09-06T12:00:01.000Z')
    );
  });

  function principal(agentId = 'agent-a') {
    return createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId,
      agentPath: `/agents/${agentId}`,
    });
  }

  function runtimePrincipal() {
    return createServerPrincipal({
      kind: 'runtime',
      owner: OWNER,
      bindingId: 'binding-a',
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/agents/agent-a',
    });
  }

  async function execute(
    principalProof = principal(),
    capabilityId:
      'connectors.execute_write' | 'connectors.execute_destructive' = 'connectors.execute_write',
    approval?: { via: 'approval'; approvalId: string; authorityBindingDigest?: string },
    executionTarget = target
  ) {
    const authorized = await authorization.prepare({
      capabilityId,
      target: executionTarget,
      principal: principalProof,
    });
    return broker.execute({
      capabilityId,
      target: executionTarget,
      principal: principalProof,
      authorityBinding: authorized.authorityBinding,
      ...(approval ? { approval } : {}),
      surface: 'mcp',
      signal: new AbortController().signal,
    });
  }

  it('persists intent before dispatch and a separate terminal receipt without provider-private ids', async () => {
    provider.results.push({
      status: 'success',
      data: { delivered: true, url: 'https://mail.example/message/1' },
      providerLogId: 'private-log-a',
    });

    await expect(execute()).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'success', data: { delivered: true } },
    });
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(db.select().from(connectorUsageTerminalReceipts).get()).toMatchObject({
      outcome: 'success',
      providerLogId: 'private-log-a',
    });
    expect(provider.commands).toHaveLength(1);
    expect(provider.dispatchedCommands).toHaveLength(1);
  });

  it('refuses a durable runtime principal before dispatch when connector migration failed', async () => {
    const runtimePrincipals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
        revalidateTurn: async () => true,
      },
      makeBootEpoch: () => 'boot-migration-failure',
      makeBearer: () => 'bearer-migration-failure',
    });
    await runtimePrincipals.initializeBoot();
    const opened = await runtimePrincipals.openTurn({
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/agents/agent-a',
      signal: new AbortController().signal,
    });
    const resolved = await runtimePrincipals.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: '/agents/agent-a',
    });
    if (resolved.status !== 'resolved') throw new Error('Expected an authenticated principal.');

    const unavailableRegistry = new ConnectorRegistry({
      db,
      connectionStore: new ConnectionStore({
        db,
        runMigration: () => ({
          status: 'migration_failed',
          error: 'Connector data is temporarily unavailable.',
        }),
      }),
    });
    unavailableRegistry.register(provider);
    authorization = new ConnectorExecutionAuthorizationService(db, unavailableRegistry, {
      ownsAgent: () => true,
    });
    broker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
      () => new Date('2026-09-06T12:00:01.000Z')
    );

    await expect(execute(resolved.principal)).rejects.toMatchObject({ code: 'migration_failed' });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toEqual([]);
    expect(provider.commands).toEqual([]);
  });

  it('refuses owner mismatch before intent or provider dispatch', async () => {
    const other = createServerPrincipal({
      kind: 'agent',
      owner: { kind: 'local_install', installationId: 'install-b' },
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
    });

    await expect(
      authorization.prepare({ capabilityId: 'connectors.execute_write', target, principal: other })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(provider.commands).toEqual([]);
  });

  it('refuses arguments that do not exactly match the immutable schema', async () => {
    await expect(
      authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: { ...target, arguments: { message: 'hello', ignored: true } },
        principal: principal(),
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_ARGUMENTS_INVALID' } });
  });

  it('rechecks a grant revoked after preflight and creates no intent', async () => {
    const actor = principal();
    const authorized = await authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target,
      principal: actor,
    });
    db.update(connectionOperationGrants)
      .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
      .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
      .run();

    await expect(
      broker.execute({
        capabilityId: 'connectors.execute_write',
        target,
        principal: actor,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('refuses a dispatch when authority changes during provider preflight', async () => {
    provider.beforeDispatch = async () => {
      await Promise.resolve();
      db.update(connectionOperationGrants)
        .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
        .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
        .run();
      db.update(connections)
        .set({ lifecycleState: 'disconnected', status: 'revoked' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
    };

    await expect(execute()).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    });
    expect(provider.commands).toHaveLength(1);
    expect(provider.dispatchedCommands).toEqual([]);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
      { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    ]);
  });

  it.each(['grant', 'connection'] as const)(
    'refuses dispatch when the %s changes during the last principal authority await',
    async (change) => {
      let providerPreflightStarted = false;
      let finalAuthorityChecks = 0;
      let reachedLastAuthorityCheck!: () => void;
      let releaseLastAuthorityCheck!: () => void;
      const lastAuthorityCheckReached = new Promise<void>((resolve) => {
        reachedLastAuthorityCheck = resolve;
      });
      const lastAuthorityCheckReleased = new Promise<void>((resolve) => {
        releaseLastAuthorityCheck = resolve;
      });
      const runtimePrincipals = new ConnectorRuntimePrincipalService({
        db,
        authority: {
          authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
          revalidateTurn: async () => {
            if (providerPreflightStarted) {
              finalAuthorityChecks += 1;
              if (finalAuthorityChecks === 2) {
                reachedLastAuthorityCheck();
                await lastAuthorityCheckReleased;
              }
            }
            return true;
          },
        },
        makeBootEpoch: () => `boot-final-${change}`,
        makeBearer: () => `bearer-final-${change}`,
      });
      await runtimePrincipals.initializeBoot();
      const opened = await runtimePrincipals.openTurn({
        runtime: 'claude-code',
        canonicalSessionId: 'session-a',
        agentPath: '/agents/agent-a',
        canonicalCwd: '/agents/agent-a',
        signal: new AbortController().signal,
      });
      const resolved = await runtimePrincipals.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'claude-code',
        expectedCanonicalCwd: '/agents/agent-a',
      });
      if (resolved.status !== 'resolved') throw new Error('Expected a live runtime principal.');

      const runtimeBroker = new ConnectorExecutionBroker(
        authorization,
        new ConnectorUsageStore(db),
        { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
        () => new Date('2026-09-06T12:00:01.000Z')
      );
      const authorized = await authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target,
        principal: resolved.principal,
      });
      provider.beforeDispatch = () => {
        providerPreflightStarted = true;
      };

      const execution = runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      });
      await lastAuthorityCheckReached;
      if (change === 'grant') {
        db.update(connectionOperationGrants)
          .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
          .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
          .run();
      } else {
        db.update(connections)
          .set({ enabled: false })
          .where(eq(connections.id, CONNECTION_ID))
          .run();
      }
      releaseLastAuthorityCheck();

      await expect(execution).resolves.toMatchObject({
        attemptCount: 1,
        result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      });
      expect(finalAuthorityChecks).toBe(2);
      expect(provider.commands).toHaveLength(1);
      expect(provider.dispatchedCommands).toEqual([]);
      expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
      expect(db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
        { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      ]);
    }
  );

  it('uses only session grants for an explicit attached override and otherwise inherits agent grants', async () => {
    const actor = runtimePrincipal();
    await expect(
      authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target,
        principal: actor,
      })
    ).resolves.toMatchObject({ agentId: 'agent-a', sessionId: 'session-a' });

    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        state: 'attached',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(
      authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target,
        principal: actor,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });

    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-session-a',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(
      authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target,
        principal: actor,
      })
    ).resolves.toMatchObject({ agentId: 'agent-a', sessionId: 'session-a' });
  });

  it.each([
    { agentId: 'agent-b', needsReconciliation: false },
    { agentId: 'agent-a', needsReconciliation: true },
  ])(
    'refuses an attached session override owned by $agentId with reconciliation=$needsReconciliation',
    async ({ agentId, needsReconciliation }) => {
      db.insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-a',
          agentId,
          connectionId: CONNECTION_ID,
          state: 'attached',
          needsReconciliation,
          updatedAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      db.insert(connectionOperationGrants)
        .values({
          id: `grant-session-${agentId}-${needsReconciliation}`,
          subjectType: 'session',
          subjectId: 'session-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: REVISION_ID,
          createdBy: 'operator',
          createdAt: '2026-09-06T12:00:00.000Z',
        })
        .run();

      await expect(
        authorization.prepare({
          capabilityId: 'connectors.execute_write',
          target,
          principal: runtimePrincipal(),
        })
      ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
    }
  );

  it.each([
    { agentId: 'agent-b', needsReconciliation: false },
    { agentId: 'agent-a', needsReconciliation: true },
  ])(
    'review probe: full broker refuses override owner=$agentId reconciliation=$needsReconciliation',
    async ({ agentId, needsReconciliation }) => {
      const runtimePrincipals = new ConnectorRuntimePrincipalService({
        db,
        authority: {
          authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
          revalidateTurn: async () => true,
        },
        makeBootEpoch: () => 'boot-probe',
        makeBearer: () => 'bearer-probe',
      });
      await runtimePrincipals.initializeBoot();
      const opened = await runtimePrincipals.openTurn({
        runtime: 'claude-code',
        canonicalSessionId: 'session-a',
        agentPath: '/agents/agent-a',
        canonicalCwd: '/agents/agent-a',
        signal: new AbortController().signal,
      });
      const resolved = await runtimePrincipals.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'claude-code',
        expectedCanonicalCwd: '/agents/agent-a',
      });
      if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');
      db.insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-a',
          agentId,
          connectionId: CONNECTION_ID,
          state: 'attached',
          needsReconciliation,
          updatedAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      db.insert(connectionOperationGrants)
        .values({
          id: `review-probe-session-${agentId}-${needsReconciliation}`,
          subjectType: 'session',
          subjectId: 'session-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: REVISION_ID,
          createdBy: 'operator',
          createdAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      const runtimeBroker = new ConnectorExecutionBroker(
        authorization,
        new ConnectorUsageStore(db),
        { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
        () => new Date('2026-09-06T12:00:01.000Z')
      );

      await expect(
        (async () => {
          const authorized = await authorization.prepare({
            capabilityId: 'connectors.execute_write',
            target,
            principal: resolved.principal,
          });
          return runtimeBroker.execute({
            capabilityId: 'connectors.execute_write',
            target,
            principal: resolved.principal,
            authorityBinding: authorized.authorityBinding,
            surface: 'mcp',
            signal: new AbortController().signal,
          });
        })()
      ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
      expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
      expect(db.select().from(connectorUsageTerminalReceipts).all()).toEqual([]);
      expect(provider.commands).toEqual([]);
    }
  );

  it('review probe: full broker keeps a valid attached override exact and executable', async () => {
    const runtimePrincipals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
        revalidateTurn: async () => true,
      },
      makeBootEpoch: () => 'boot-valid-probe',
      makeBearer: () => 'bearer-valid-probe',
    });
    await runtimePrincipals.initializeBoot();
    const opened = await runtimePrincipals.openTurn({
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/agents/agent-a',
      signal: new AbortController().signal,
    });
    const resolved = await runtimePrincipals.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: '/agents/agent-a',
    });
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        state: 'attached',
        needsReconciliation: false,
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'review-probe-valid-session',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    const runtimeBroker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
      () => new Date('2026-09-06T12:00:01.000Z')
    );
    const authorized = await authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target,
      principal: resolved.principal,
    });

    await expect(
      runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ attemptCount: 1, result: { status: 'success' } });
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
    expect(provider.commands).toHaveLength(1);
  });

  it('rejects a structurally identical but unauthenticated preflight binding', async () => {
    const actor = principal();
    const authorized = await authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target,
      principal: actor,
    });

    await expect(
      broker.execute({
        capabilityId: 'connectors.execute_write',
        target,
        principal: actor,
        authorityBinding: {
          approvalScope: { ...authorized.authorityBinding.approvalScope },
        },
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_PREFLIGHT_REQUIRED' } });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('denies cross-actor destructive approval reuse before intent', async () => {
    const actor = principal();
    const authorized = await authorization.prepare({
      capabilityId: 'connectors.execute_destructive',
      target: destructiveTarget,
      principal: actor,
    });

    await expect(
      execute(
        actor,
        'connectors.execute_destructive',
        {
          via: 'approval',
          approvalId: 'approval-for-other-actor',
          authorityBindingDigest: `${authorized.authorityBinding.approvalScope.digest}-other`,
        },
        destructiveTarget
      )
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_APPROVAL_BINDING_MISMATCH' } });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('retries only a pinned idempotent operation and reuses one upstream key', async () => {
    provider.results.push(
      { status: 'error', code: 'temporary', message: 'Try again', retryable: true },
      { status: 'success', data: { delivered: true } }
    );

    await expect(
      execute(principal(), 'connectors.execute_write', undefined, retryTarget)
    ).resolves.toMatchObject({ attemptCount: 2, result: { status: 'success' } });
    expect(provider.commands).toHaveLength(2);
    expect(provider.commands[0]!.upstreamIdempotencyKey).toBe(
      provider.commands[1]!.upstreamIdempotencyKey
    );
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(2);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(2);
  });

  it('never retries an unknown transport outcome even under an idempotent policy', async () => {
    provider.results.push(new Error('socket reset'));

    await expect(
      execute(principal(), 'connectors.execute_write', undefined, retryTarget)
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'outcome_unknown', code: 'PROVIDER_TRANSPORT_OUTCOME_UNKNOWN' },
    });
    expect(provider.commands).toHaveLength(1);
  });

  it('revalidates a durable runtime binding before a safe retry', async () => {
    const runtimePrincipals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
        revalidateTurn: async () => true,
      },
      makeBootEpoch: () => 'boot-a',
      makeBearer: () => 'bearer-a',
    });
    await runtimePrincipals.initializeBoot();
    const opened = await runtimePrincipals.openTurn({
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/agents/agent-a',
      signal: new AbortController().signal,
    });
    const resolved = await runtimePrincipals.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: '/agents/agent-a',
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('Expected runtime principal.');

    const runtimeBroker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
      () => new Date('2026-09-06T12:00:01.000Z')
    );
    provider.results.push(
      { status: 'error', code: 'temporary', message: 'Try again', retryable: true },
      { status: 'success', data: { delivered: true } }
    );
    let revoked = false;
    provider.afterExecute = async () => {
      if (revoked) return;
      revoked = true;
      await runtimePrincipals.revoke(opened.bindingId, 'runtime_failed');
    };
    const authorized = await authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target: retryTarget,
      principal: resolved.principal,
    });

    await expect(
      runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target: retryTarget,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'error', code: 'temporary' },
    });
    expect(provider.commands).toHaveLength(1);
  });

  it('stops a retry when the live grant changes after the first attempt', async () => {
    provider.results.push({
      status: 'error',
      code: 'temporary',
      message: 'Try again',
      retryable: true,
    });
    provider.afterExecute = () => {
      db.update(connectionOperationGrants)
        .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
        .where(eq(connectionOperationGrants.id, `grant-${RETRY_REVISION_ID}`))
        .run();
    };

    await expect(
      execute(principal(), 'connectors.execute_write', undefined, retryTarget)
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'error', code: 'temporary' },
    });
    expect(provider.commands).toHaveLength(1);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
  });
});
