/** Cross-application proof driver for the mounted hosted route integration test. */
import { expect } from 'vitest';
import {
  connections,
  connectorProviderInstances,
  connectorOperationRevisions,
  connectorManagedUsageMirrors,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  connectorManagedAuthorityOutbox,
  createDb,
  runMigrations,
  eq,
} from '@dorkos/db';
import {
  ManagedConnectorExecutionRequestSchema,
  type ManagedConnectorExecutionRequest,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import { CloudLinkManager } from '../../../core/auth/cloud-link.js';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorProviderBootstrapper } from '../../bootstrap.js';
import { ManagedCloudConnectorProvider } from '../../providers/managed/managed-cloud.js';
import { ManagedConnectorExecutionContextStore } from '../../execution/managed-execution-context.js';
import { ManagedAuthoritySyncService } from '../../resources/managed-authority-sync-service.js';
import { ConnectorReconciliationService } from '../../reconciliation-service.js';
import { ConnectorExecutionAuthorizationService } from '../../execution/authorization-service.js';
import { ConnectorExecutionBroker } from '../../execution/execution-broker.js';
import { ConnectorUsageStore } from '../../execution/usage-store.js';
import { ManagedUsageMirrorService } from '../../execution/managed-usage-mirror-service.js';
import { createServerPrincipal } from '../../principal/server-principal.js';

/** Drive real local persistence, grant outbox, broker and receipt mirror through hosted HTTP handlers. */
export async function proveLocalHostedProtocol(input: {
  instanceKey: string;
  completeAuthentication: (authorizeUrl: string) => Promise<void>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  providerExecutions: () => number;
  reclassify: (classification: 'read' | 'write') => void;
}): Promise<void> {
  const db = createDb(':memory:');
  runMigrations(db);
  const owner = { kind: 'local_install', installationId: 'protocol-install' } as const;
  const providerId = ConnectorProviderInstanceIdSchema.parse('protocol-managed');
  const wireExecutions: ManagedConnectorExecutionRequest[] = [];
  const cloud = new CloudLinkManager({
    config: {
      getToken: () => input.instanceKey,
      getAccountLabel: () => 'Protocol owner',
      save: () => {},
      setAccountLabel: () => {},
      clear: () => {},
    },
    fetchImpl: (url, init) => {
      if (new URL(url).pathname.endsWith('/executions') && init?.body) {
        wireExecutions.push(
          ManagedConnectorExecutionRequestSchema.parse(JSON.parse(String(init.body)))
        );
      }
      return input.fetchImpl(url, init);
    },
  });
  try {
    const contexts = new ManagedConnectorExecutionContextStore();
    const provider = new ManagedCloudConnectorProvider({
      instanceId: providerId,
      cloud,
      executionContext: (command) => contexts.resolve(command),
    });
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: owner.kind, ownerId: owner.installationId },
    });
    const bootstrapper = new ConnectorProviderBootstrapper({
      registry,
      credentials: {
        resolve: (ref) =>
          Promise.resolve({
            ok: false as const,
            reason: 'unresolved' as const,
            ref,
            message: 'absent',
          }),
      },
      nangoEnv: () => ({}),
      rawMcpServers: () => [],
      managedCloud: {
        instanceId: providerId,
        configured: () => true,
        executionConfigDigest: () => 'protocol-material',
        create: () => provider,
      },
    });
    await bootstrapper.registerBootProviders();
    expect(
      db
        .select({ mode: connectorProviderInstances.mode })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, providerId))
        .get()?.mode
    ).toBe('managed');
    const flows = new ConnectorAuthenticationFlowService({ db, registry });
    const started = await flows.start(owner, {
      providerInstanceId: providerId,
      toolkit: 'gmail',
      label: 'Protocol Gmail',
      idempotencyKey: 'protocol-authentication',
    });
    expect(started.state).toBe('pending');
    if (started.state !== 'pending' || !started.authorizeUrl)
      throw new Error('Missing managed sign-in URL');
    // A fresh local coordinator resumes the same durable flow after the browser
    // completes its separately authenticated, single-use hosted callback.
    const reopened = new ConnectorAuthenticationFlowService({ db, registry });
    expect(reopened.status(owner, started.flowId).flowId).toBe(started.flowId);
    await input.completeAuthentication(started.authorizeUrl);
    const completed = await reopened.poll(owner, started.flowId);
    expect(completed.state).toBe('connected');
    if (completed.state !== 'connected') throw new Error('Managed sign-in did not complete');
    const connectionId = ConnectionIdSchema.parse(completed.connectionId);
    const persistedConnection = db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get()!;
    const managedConnectionId = persistedConnection.externalAccountRef;
    expect(connectionId).not.toBe(managedConnectionId);
    expect(await reopened.poll(owner, started.flowId)).toEqual(completed);
    expect(db.select().from(connections).all()).toHaveLength(1);
    const sync = new ManagedAuthoritySyncService({ db, cloud });
    const reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'protocol-boot',
      listAgents: () => [{ agentId: 'protocol-agent', displayName: 'Protocol agent' }],
      managedAuthority: sync,
    });
    const preview = await reconciliation.preview(
      owner,
      { connectionId },
      new AbortController().signal
    );
    expect(preview.catalogComplete).toBe(true);
    const operation = preview.candidates.find(
      (candidate) => candidate.operationSlug === 'gmail.protocol.read'
    );
    expect(operation).toMatchObject({ supported: true, capabilityClassification: 'read' });
    if (!operation) throw new Error('Missing protocol operation');
    const stored = db
      .select()
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.id, operation.operationRevisionId))
      .get()!;
    expect(stored.providerRevisionRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.providerRevisionRef).not.toBe(operation.operationRevisionId);
    expect(JSON.stringify(preview)).not.toContain(stored.providerRevisionRef);
    await reconciliation.apply(owner, {
      previewId: preview.previewId,
      grants: [
        { agentId: 'protocol-agent', operationRevisionIds: [operation.operationRevisionId] },
      ],
    });
    const applied = db.select().from(connectorManagedAuthorityOutbox).get()!;
    expect(applied.state).toBe('applied');
    expect(applied.requestJson).toContain(stored.providerRevisionRef);
    const mirror = new ManagedUsageMirrorService({ db, cloud });
    cloud.setManagedReceiptObserver((receipt) => mirror.observe(receipt));
    const authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (_owner, agentId) => agentId === 'protocol-agent',
    });
    const broker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: () => true },
      () => new Date(),
      contexts
    );
    const principal = createServerPrincipal({
      kind: 'agent',
      owner,
      agentId: 'protocol-agent',
      agentPath: '/agents/protocol-agent',
    });
    const target = ConnectorExecutionTargetSchema.parse({
      connectionId,
      operationRevisionId: operation.operationRevisionId,
      arguments: { query: 'harmless-read' },
    });
    const prepared = await authorization.prepare({
      capabilityId: 'connectors.execute_read',
      target,
      principal,
    });
    const before = input.providerExecutions();
    const response = await broker.execute({
      capabilityId: 'connectors.execute_read',
      target,
      principal,
      authorityBinding: prepared.authorityBinding,
      surface: 'mcp',
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({
      attemptCount: 1,
      result: { status: 'success', data: { accepted: true } },
    });
    expect(input.providerExecutions()).toBe(before + 1);
    const intent = db.select().from(connectorUsageAttempts).get()!;
    expect(intent.payer).toBe('dorkos_managed');
    expect(db.select().from(connectorUsageTerminalReceipts).get()).toMatchObject({
      attemptId: intent.attemptId,
      outcome: 'success',
    });
    expect(db.select().from(connectorManagedUsageMirrors).get()).toMatchObject({
      attemptId: intent.attemptId,
      outcome: 'success',
    });
    await cloud.getManagedConnectorExecutionReceipt(intent.attemptId, new AbortController().signal);
    expect(db.select().from(connectorManagedUsageMirrors).all()).toHaveLength(1);
    expect(input.providerExecutions()).toBe(before + 1);
    const fresh = await reconciliation.preview(
      owner,
      { connectionId },
      new AbortController().signal
    );
    await reconciliation.apply(owner, {
      previewId: fresh.previewId,
      grants: [{ agentId: 'protocol-agent', operationRevisionIds: [] }],
    });
    await expect(
      authorization.prepare({ capabilityId: 'connectors.execute_read', target, principal })
    ).rejects.toThrow();
    expect(input.providerExecutions()).toBe(before + 1);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    // Hosted authority independently denies a fresh attempt even if a compromised
    // caller bypasses local preflight. No provider dispatch and no receipt is minted.
    await expect(
      cloud.executeManagedConnectorOperation(
        {
          ...wireExecutions[0]!,
          logicalOperationId: 'protocol-denied-after-revoke',
          attemptId: 'protocol-denied-after-revoke',
        },
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(input.providerExecutions()).toBe(before + 1);

    input.reclassify('write');
    const changed = await reconciliation.preview(
      owner,
      { connectionId },
      new AbortController().signal
    );
    const write = changed.candidates.find(
      (candidate) => candidate.supported && candidate.operationSlug === operation.operationSlug
    )!;
    expect(write.capabilityClassification).toBe('write');
    input.reclassify('read');
    const returned = await reconciliation.preview(
      owner,
      { connectionId },
      new AbortController().signal
    );
    const newRead = returned.candidates.find(
      (candidate) => candidate.supported && candidate.operationSlug === operation.operationSlug
    )!;
    expect(
      new Set([
        operation.operationRevisionId,
        write.operationRevisionId,
        newRead.operationRevisionId,
      ]).size
    ).toBe(3);
    expect(returned.currentGrants).toEqual([]);
    const newTarget = ConnectorExecutionTargetSchema.parse({
      ...target,
      operationRevisionId: newRead.operationRevisionId,
    });
    await expect(
      authorization.prepare({
        capabilityId: 'connectors.execute_read',
        target: newTarget,
        principal,
      })
    ).rejects.toThrow();
    await reconciliation.apply(owner, {
      previewId: returned.previewId,
      grants: [{ agentId: 'protocol-agent', operationRevisionIds: [newRead.operationRevisionId] }],
    });
    const newPrepared = await authorization.prepare({
      capabilityId: 'connectors.execute_read',
      target: newTarget,
      principal,
    });
    await expect(
      broker.execute({
        capabilityId: 'connectors.execute_read',
        target: newTarget,
        principal,
        authorityBinding: newPrepared.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ attemptCount: 1, result: { status: 'success' } });
    expect(input.providerExecutions()).toBe(before + 2);
    expect(db.select().from(connectorManagedUsageMirrors).all()).toHaveLength(2);
    const usage = await cloud.listManagedConnectorUsage(
      { version: 1, managedConnectionId, agentId: 'protocol-agent', limit: 100 },
      new AbortController().signal
    );
    expect(usage).toMatchObject({
      status: 'available',
      counts: { logicalOperationCount: 2, attemptCount: 2 },
    });
    expect(JSON.stringify(usage)).not.toContain('harmless-read');
    expect(JSON.stringify(usage)).not.toContain(stored.providerRevisionRef);
    // The original durable receipt remains recoverable after both grant removal
    // and hosted revision supersession, without redispatch or double accounting.
    await cloud.getManagedConnectorExecutionReceipt(intent.attemptId, new AbortController().signal);
    expect(db.select().from(connectorManagedUsageMirrors).all()).toHaveLength(2);
    expect(input.providerExecutions()).toBe(before + 2);
  } finally {
    cloud.stop();
    db.$client.close();
  }
}
