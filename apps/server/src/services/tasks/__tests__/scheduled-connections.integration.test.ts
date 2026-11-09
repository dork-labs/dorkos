/** Scheduled turns use their recorded agent's grants on both dispatch paths. */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  type Db,
} from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayCore } from '@dorkos/relay';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { noopLogger } from '@dorkos/shared/logger';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent, Task } from '@dorkos/shared/types';
import { FakeAgentRuntime, FakeConnectorProvider } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { initBoundary } from '../../../lib/boundary.js';
import { composeRegistry } from '../../core/capabilities/index.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { ConnectorRegistry } from '../../connectors/registry.js';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../../connectors/principal/runtime-authority-resolver.js';
import { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import { ConnectorAccessQueryService } from '../../connectors/execution/access-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../../connectors/execution/authorization-service.js';
import { ConnectorExecutionBroker } from '../../connectors/execution/execution-broker.js';
import { connectorExecutionDomain } from '../../connectors/execution/execution-capabilities.js';
import { createConnectorRuntimeMcpServer } from '../../connectors/execution/runtime-mcp-server.js';
import { ConnectorUsageStore } from '../../connectors/execution/usage-store.js';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { RELAY_DISPATCH_OK } from '../../relay/task-dispatch/readiness.js';
import { TaskStore } from '../task-store.js';
import { singleRuntimeSource, TaskSchedulerService } from '../task-scheduler-service.js';

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));

const OWNER = { kind: 'local_install', installationId: 'scheduled-test' } as const;
const CONFIG = {
  maxConcurrentRuns: 2,
  retentionCount: 100,
  timezone: null,
  mayFire: true,
  firingReason: 'test',
};
type Fireable = { dispatch(task: Task, when: Date): Promise<void> };

describe.each(['direct', 'relay'] as const)('%s scheduled connected apps', (dispatchPath) => {
  let root: string;
  let agentHome: string;
  let db: Db;
  let store: TaskStore;
  let runtime: FakeAgentRuntime;
  let provider: FakeConnectorProvider;
  let principals: ConnectorRuntimePrincipalService;
  let registry: ReturnType<typeof composeRegistry>;
  let service: TaskSchedulerService | undefined;
  let toolResult: Awaited<ReturnType<Client['callTool']>> | undefined;
  let turnError: unknown;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'scheduled-connections-')));
    agentHome = path.join(root, 'agent-a');
    await mkdir(agentHome);
    await initBoundary('/');
    db = createTestDb();
    store = new TaskStore(db);
    runtime = new FakeAgentRuntime('codex');
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtime);
    toolResult = undefined;
    turnError = undefined;

    const mesh = {
      getByPath: (dir: string) => (dir === agentHome ? { id: 'agent-a' } : undefined),
    };
    principals = new ConnectorRuntimePrincipalService({
      db,
      authority: new CanonicalConnectorRuntimeAuthorityResolver({
        sessions: runtimeRegistry,
        mesh,
        owner: OWNER,
      }),
    });
    await principals.initializeBoot();
    provider = new FakeConnectorProvider({
      type: 'fake',
      instanceId: ConnectorProviderInstanceIdSchema.parse('scheduled-provider'),
      custody: 'self-host',
    });
    vi.spyOn(provider, 'execute');
    const started = await provider.startConnect('gmail', { label: 'Task mail' });
    const connected = await provider.pollConnect(started.flowId);
    if (connected.status !== 'connected' || !connected.account)
      throw new Error('Fake sign-in failed');
    const providers = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    providers.register(provider, 'scheduled-material');
    const now = new Date().toISOString();
    db.insert(connections)
      .values({
        id: 'task-mail',
        providerInstanceId: provider.instanceId,
        externalAccountRef: connected.account.externalAccountRef,
        toolkit: 'gmail',
        label: 'Task mail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'read-mail',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'test',
        schemaHash: 'sha256:scheduled-read',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: now,
      })
      .run();
    const ownership = {
      ownsAgent: async () => true,
    };
    const authorization = new ConnectorExecutionAuthorizationService(db, providers, ownership);
    registry = composeRegistry([connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization,
        access: new ConnectorAccessQueryService(db, ownership, providers, principals),
        broker: new ConnectorExecutionBroker(authorization, new ConnectorUsageStore(db), {
          revalidate: (principal) => principals.revalidatePrincipal(principal),
        }),
        requests: {} as never,
      },
    });
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function grant(agentId: string): void {
    db.insert(connectionOperationGrants)
      .values({
        id: `mail-for-${agentId}`,
        subjectType: 'agent',
        subjectId: agentId,
        agentId,
        connectionId: 'task-mail',
        operationRevisionId: 'read-mail',
        createdBy: 'operator',
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  async function callGrantedTool(sessionId: string, cwd: string, forAgent?: string): Promise<void> {
    try {
      const opened = await principals.openTurn(
        {
          runtime: 'codex',
          canonicalSessionId: sessionId,
          // Even standing in a registered agent's folder must not confer its grants.
          agentPath: forAgent ?? agentHome,
          canonicalCwd: cwd,
          signal: new AbortController().signal,
        },
        { isCurrent: () => true }
      );
      const resolved = await principals.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'codex',
        expectedCanonicalCwd: cwd,
      });
      if (resolved.status !== 'resolved') throw new Error('Runtime principal refused');
      const server = createConnectorRuntimeMcpServer(registry, resolved.principal);
      const client = new Client({ name: 'scheduled-connection-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        toolResult = await client.callTool({
          name: 'connectors.execute_read',
          arguments: { connectionId: 'task-mail', operationRevisionId: 'read-mail', arguments: {} },
        });
      } finally {
        await Promise.all([client.close(), server.close()]);
        await principals.revoke(opened.bindingId, 'turn_terminal');
      }
    } catch (err) {
      turnError = err;
    }
  }

  async function fire(
    agentId: string | null,
    trigger: 'scheduled' | 'manual' = 'scheduled'
  ): Promise<void> {
    const task = store.createTask({
      name: 'Read scheduled mail',
      description: 'Reads the granted mailbox on a schedule',
      prompt: 'Read the granted mailbox',
      filePath: path.join(root, 'read-mail', 'SKILL.md'),
      runtime: 'codex',
      agentId,
    });
    runtime.sendMessage.mockImplementation(
      async function* (sessionId, _content, opts): AsyncGenerator<StreamEvent> {
        await callGrantedTool(sessionId, opts?.cwd ?? root, opts?.forAgent);
      }
    );
    const publish = vi.fn(async (_subject: string, payload: unknown) => {
      const dispatch = payload as TaskDispatchPayload;
      await callGrantedTool(dispatch.sessionId!, dispatch.cwd!, dispatch.forAgent);
      store.updateRun(dispatch.runId, { status: 'completed' });
      return { messageId: 'delivered-task', deliveredTo: 1 };
    });
    vi.mocked(isRelayEnabled).mockReturnValue(dispatchPath === 'relay');
    service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(runtime),
      config: CONFIG,
      meshCore: {
        getProjectPath: (id: string) => (id === 'agent-a' ? agentHome : undefined),
      } as unknown as MeshCore,
      relay: { publish } as unknown as RelayCore,
      relayHoldsRuntime: () => RELAY_DISPATCH_OK,
    });
    if (trigger === 'manual') {
      const run = await service.triggerManualRun(task.id);
      if (!run) throw new Error('Run now was refused');
      await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('completed'));
    } else {
      await (service as unknown as Fireable).dispatch(task, new Date());
    }
    expect(
      dispatchPath === 'relay' && trigger === 'scheduled' ? publish : runtime.sendMessage
    ).toHaveBeenCalledOnce();
  }

  it('executes an operation granted to the scheduled agent', async () => {
    grant('agent-a');
    await fire('agent-a');
    expect(turnError).toBeUndefined();
    expect(toolResult?.isError).not.toBe(true);
    expect(provider.execute).toHaveBeenCalledOnce();
  });

  it('keeps the plain refusal for a run with no agent', async () => {
    grant('agent-a');
    await fire(null);
    expect(turnError).toMatchObject({
      code: 'agent_unrecorded',
      message: 'This chat isn’t linked to an agent, so it can’t use connected apps.',
    });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('refuses an operation granted only to another agent', async () => {
    grant('agent-b');
    await fire('agent-a');
    expect(turnError).toBeUndefined();
    expect(toolResult?.isError).toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  if (dispatchPath === 'direct') {
    it('records the same agent for an attended Run now', async () => {
      grant('agent-a');
      await fire('agent-a', 'manual');
      expect(turnError).toBeUndefined();
      expect(provider.execute).toHaveBeenCalledOnce();
    });
  }
});
