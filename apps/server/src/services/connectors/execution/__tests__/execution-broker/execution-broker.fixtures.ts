/**
 * The scripted provider, seed rows and per-test harness for the ConnectorExecutionBroker tests.
 */
import { beforeEach } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorProviderExecuteCommand,
  type ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import {
  type ConnectorExternalAccountRef,
  type ConnectorProvider,
} from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../../registry.js';
import { ConnectorRuntimePrincipalService } from '../../../principal/runtime-principal-service.js';
import { createServerPrincipal } from '../../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../../authorization-service.js';
import { ConnectorExecutionBroker } from '../../execution-broker.js';
import { ConnectorUsageStore } from '../../usage-store.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

const TEST_TURN_OWNERSHIP = { isCurrent: () => true } as const;

export const CONNECTION_ID = 'connection-a' as const;

export const REVISION_ID = 'revision-a';

const DESTRUCTIVE_REVISION_ID = 'revision-destructive';

export const RETRY_REVISION_ID = 'revision-retry';

export const EXTERNAL_REF = 'provider-account-a' as ConnectorExternalAccountRef;

/**
 * Shaped the way a real provider writes an operation's input: optional fields
 * carry a `default`, fields carry `title` and `examples` (strings on the integer
 * one, as Composio's do), and nothing says `additionalProperties`. The fixture
 * this replaced had none of that, so a check that filled defaults in and then
 * refused the call for no longer matching passed here while refusing every
 * real Gmail call.
 */
export const PROVIDER_SHAPED_INPUT_SCHEMA = {
  type: 'object',
  title: 'SendMessageRequest',
  properties: {
    message: { type: 'string', title: 'Message', examples: ['hello'] },
    user_id: { type: 'string', title: 'User Id', default: 'me', examples: ['me'] },
    max_attempts: {
      type: 'integer',
      title: 'Max Attempts',
      default: 1,
      minimum: 1,
      maximum: 5,
      examples: ['1', '3'],
    },
    label_ids: { type: 'array', items: { type: 'string' }, title: 'Label Ids' },
  },
  required: ['message'],
};

interface ScriptedProvider extends ConnectorProvider {
  readonly commands: ConnectorProviderExecuteCommand[];
  readonly dispatchedCommands: ConnectorProviderExecuteCommand[];
  readonly results: Array<ConnectorProviderExecuteResult | Error>;
  afterExecute?: () => void | Promise<void>;
  beforeDispatch?: () => void | Promise<void>;
  onCommand?: (command: ConnectorProviderExecuteCommand) => void;
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
        provider.onCommand?.(command);
        await provider.beforeDispatch?.();
        if (!(await command.authorizeDispatch())) {
          return {
            status: 'error' as const,
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Access changed before the operation was sent.',
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

/**
 * Open one authenticated runtime turn for agent-a in session-a, the way a runtime does, and
 * return the principal service with the turn it opened and the principal it resolved.
 */
export async function openRuntimeTurn(
  db: Db,
  options: Omit<Partial<ConstructorParameters<typeof ConnectorRuntimePrincipalService>[0]>, 'db'>
) {
  const runtimePrincipals = new ConnectorRuntimePrincipalService({
    db,
    authority: {
      authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
      revalidateTurn: async () => true,
    },
    ...options,
  });
  await runtimePrincipals.initializeBoot();
  const opened = await runtimePrincipals.openTurn(
    {
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/agents/agent-a',
      signal: new AbortController().signal,
    },
    TEST_TURN_OWNERSHIP
  );
  const resolved = await runtimePrincipals.resolve({
    bearer: opened.bearer,
    expectedRuntime: 'claude-code',
    expectedCanonicalCwd: '/agents/agent-a',
  });
  if (resolved.status !== 'resolved') throw new Error('Expected an authenticated principal.');
  return { runtimePrincipals, opened, resolved };
}

/** The shared per-test state and helpers every execution-broker piece uses. */
export function useExecutionBrokerHarness() {
  const h = {
    db: undefined as unknown as Db,
    provider: undefined as unknown as ScriptedProvider,
    registry: undefined as unknown as ConnectorRegistry,
    authorization: undefined as unknown as ConnectorExecutionAuthorizationService,
    broker: undefined as unknown as ConnectorExecutionBroker,
    target: ConnectorExecutionTargetSchema.parse({
      connectionId: CONNECTION_ID,
      operationRevisionId: REVISION_ID,
      arguments: { message: 'hello' },
    }),
    destructiveTarget: ConnectorExecutionTargetSchema.parse({
      ...h.target,
      operationRevisionId: DESTRUCTIVE_REVISION_ID,
    }),
    retryTarget: ConnectorExecutionTargetSchema.parse({
      ...h.target,
      operationRevisionId: RETRY_REVISION_ID,
    }),
    principal,
    runtimePrincipal,
    execute,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.provider = createScriptedProvider();
    h.registry = new ConnectorRegistry({ db: h.db });
    h.registry.register(h.provider);
    h.db
      .update(connectorProviderInstances)
      .set({
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    h.db
      .insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: h.provider.instanceId,
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
    h.db
      .insert(connectorOperationRevisions)
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
        ].map((revision, index) => ({
          ...revision,
          providerInstanceId: h.provider.instanceId,
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          schemaHash: `sha256:${revision.id}`,
          providerRevisionRef: `10000000-0000-4000-8000-00000000000${index + 1}`,
          inputSchemaJson: JSON.stringify(PROVIDER_SHAPED_INPUT_SCHEMA),
          discoveredAt: '2026-09-06T12:00:00.000Z',
        }))
      )
      .run();
    h.db
      .insert(connectionOperationGrants)
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
    h.authorization = new ConnectorExecutionAuthorizationService(h.db, h.registry, {
      ownsAgent: (_owner, agentId) => agentId === 'agent-a',
    });
    h.broker = new ConnectorExecutionBroker(
      h.authorization,
      new ConnectorUsageStore(h.db),
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
    principalProof = h.principal(),
    capabilityId:
      'connectors.execute_write' | 'connectors.execute_destructive' = 'connectors.execute_write',
    approval?: { via: 'approval'; approvalId: string; authorityBindingDigest?: string },
    executionTarget = h.target
  ) {
    const authorized = await h.authorization.prepare({
      capabilityId,
      target: executionTarget,
      principal: principalProof,
    });
    return h.broker.execute({
      capabilityId,
      target: executionTarget,
      principal: principalProof,
      authorityBinding: authorized.authorityBinding,
      ...(approval ? { approval } : {}),
      surface: 'mcp',
      signal: new AbortController().signal,
    });
  }
  return h;
}
