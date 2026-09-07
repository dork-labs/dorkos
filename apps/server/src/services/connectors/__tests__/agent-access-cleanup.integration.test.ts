import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentConnectionAttachments,
  agents,
  connectionOperationGrants,
  connectorEventSubscriptions,
  connectorLegacyAgentRevocations,
  connectorOperationRevisions,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { AgentRegistry, MeshCore } from '@dorkos/mesh';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { registerConnectorAgentCleanup } from '../agent-access-cleanup.js';
import { ConnectorAuthorityCleanupService } from '../authority-cleanup-service.js';
import { ConnectionStore } from '../connection-store.js';
import { ConnectorRegistry } from '../registry.js';

const NOW = '2026-09-05T12:00:00.000Z';
const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
const temporaryDirectories: string[] = [];
const meshes: MeshCore[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'connector-agent-cleanup-'));
  temporaryDirectories.push(root);
  return root;
}

async function connect(registry: ConnectorRegistry): Promise<ConnectedAccount> {
  const provider = new FakeConnectorProvider();
  registry.register(provider);
  const { flowId } = await provider.startConnect('gmail', { label: 'shared' });
  const result = await provider.pollConnect(flowId);
  return registry.recordConnect(provider, result.account!);
}

function seedAuthority(db: Db, account: ConnectedAccount, agentIds: string[]): void {
  db.insert(connectorOperationRevisions)
    .values({
      id: 'revision-1',
      providerInstanceId: 'provider_instance_fake-connector',
      toolkit: 'gmail',
      operationSlug: 'gmail.read',
      toolkitVersion: '2026-09-01',
      schemaHash: 'sha256:read-1',
      capabilityClassification: 'read',
      inputSchemaJson: '{}',
      discoveredAt: NOW,
    })
    .run();
  for (const agentId of agentIds) {
    db.insert(agentConnectionAttachments)
      .values({ agentId, connectionId: account.id, attachedAt: NOW })
      .run();
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: `session-${agentId}`,
        agentId,
        connectionId: account.id,
        state: 'attached',
        needsReconciliation: false,
        updatedAt: NOW,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${agentId}`,
        subjectType: 'agent',
        subjectId: agentId,
        agentId,
        connectionId: account.id,
        operationRevisionId: 'revision-1',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    db.insert(connectorEventSubscriptions)
      .values({
        id: `subscription-${agentId}`,
        connectionId: account.id,
        agentId,
        destinationKind: 'agent',
        destinationId: agentId,
        eventType: 'message.received',
        filterJson: '{}',
        filterHash: 'none',
        deliveryMode: 'direct',
        createdBy: 'operator',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
}

function expireAgent(db: Db, agentId: string): void {
  const registry = new AgentRegistry(db);
  registry.markUnreachable(agentId);
  db.update(agents).set({ updatedAt: expiredAt }).where(eq(agents.id, agentId)).run();
}

afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('connector authority across Mesh startup reconciliation', () => {
  it('registers cleanup before the real startup sweep removes an expired agent', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const root = makeRoot();
    const mesh = new MeshCore({ db, defaultScanRoot: root });
    meshes.push(mesh);
    const pathA = path.join(root, 'agent-a');
    const pathB = path.join(root, 'agent-b');
    mkdirSync(pathA, { recursive: true });
    mkdirSync(pathB, { recursive: true });
    const agentA = await mesh.registerByPath(pathA, {
      name: 'Agent A',
      runtime: 'claude-code',
    });
    const agentB = await mesh.registerByPath(pathB, {
      name: 'Agent B',
      runtime: 'claude-code',
    });

    const registry = new ConnectorRegistry({ db });
    const account = await connect(registry);
    seedAuthority(db, account, [agentA.id, agentB.id]);
    registerConnectorAgentCleanup({
      mesh,
      registry,
      authorityCleanup: new ConnectorAuthorityCleanupService({ db }),
      logger: { warn: vi.fn() },
    });

    rmSync(pathA, { recursive: true, force: true });
    expireAgent(db, agentA.id);
    // B is also unreachable, but still inside Mesh's grace window. It remains
    // registered, so no removal callback fires and its authority stays live.
    rmSync(pathB, { recursive: true, force: true });
    new AgentRegistry(db).markUnreachable(agentB.id);
    const result = await mesh.reconcileOnStartup();

    expect(result.removed).toBe(1);
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_legacy_agent_revocations'"
        )
        .get()
    ).toBeUndefined();
    expect(db.select().from(agentConnectionAttachments).all()).toMatchObject([
      { agentId: agentB.id },
    ]);
    expect(db.select().from(sessionConnectionOverrides).all()).toMatchObject([
      { agentId: agentB.id },
    ]);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.agentId, agentA.id))
        .get()?.revokedAt
    ).not.toBeNull();
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.agentId, agentB.id))
        .get()?.revokedAt
    ).toBeNull();
    expect(
      db
        .select()
        .from(connectorEventSubscriptions)
        .where(eq(connectorEventSubscriptions.agentId, agentA.id))
        .get()?.enabled
    ).toBe(false);
    expect(
      db
        .select()
        .from(connectorEventSubscriptions)
        .where(eq(connectorEventSubscriptions.agentId, agentB.id))
        .get()?.enabled
    ).toBe(true);
  });

  it('fences retained legacy consent across a failed migration and same-id registration', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const root = makeRoot();
    const removedPath = path.join(root, 'removed-agent');
    mkdirSync(removedPath, { recursive: true });
    let mesh = new MeshCore({ db, defaultScanRoot: root });
    meshes.push(mesh);
    const removed = await mesh.registerByPath(removedPath, {
      name: 'Removed agent',
      runtime: 'claude-code',
    });
    const removedRow = db.select().from(agents).where(eq(agents.id, removed.id)).get()!;
    const removedSessionId = 'session-removed-agent';
    db.$client
      .prepare(
        `INSERT INTO connected_accounts
         (account_id, provider, toolkit, label, custody, status, created_at)
         VALUES (?, 'composio', 'gmail', 'Legacy', 'managed', 'active', ?)`
      )
      .run('private-legacy-ref', NOW);
    db.$client
      .prepare(
        `INSERT INTO agent_connector_attachments(agent_id, account_id, attached_at)
         VALUES (?, 'private-legacy-ref', ?)`
      )
      .run(removed.id, NOW);
    db.$client
      .prepare(
        `INSERT INTO session_metadata(session_id, runtime, agent_path, created_at)
         VALUES (?, 'claude-code', ?, ?)`
      )
      .run(removedSessionId, removedRow.projectPath, NOW);
    db.$client
      .prepare(
        `INSERT INTO session_connector_attachments(session_id, account_id, state, updated_at)
         VALUES (?, 'private-legacy-ref', 'attached', ?)`
      )
      .run(removedSessionId, NOW);

    const failedStore = new ConnectionStore({
      db,
      runMigration: () => ({ status: 'migration_failed', error: 'safe public failure' }),
    });
    const failedRegistry = new ConnectorRegistry({ db, connectionStore: failedStore });
    const warn = vi.fn();
    registerConnectorAgentCleanup({
      mesh,
      registry: failedRegistry,
      authorityCleanup: new ConnectorAuthorityCleanupService({ db }),
      logger: { warn },
    });
    rmSync(removedPath, { recursive: true, force: true });
    expireAgent(db, removed.id);

    expect((await mesh.reconcileOnStartup()).removed).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy consent remains fenced'));
    expect(db.select().from(connectorLegacyAgentRevocations).all()).toMatchObject([
      { agentId: removed.id },
    ]);
    expect(db.$client.prepare('SELECT * FROM agent_connector_attachments').all()).toHaveLength(1);

    mesh.close();
    meshes.splice(meshes.indexOf(mesh), 1);
    mesh = new MeshCore({ db, defaultScanRoot: root });
    meshes.push(mesh);
    // A new registration may intentionally reuse a stable id before the
    // application migration retries. The durable marker, not absence alone,
    // keeps the deleted agent's old consent from becoming authority again.
    db.insert(agents)
      .values({ ...removedRow, status: 'active', updatedAt: NOW })
      .run();
    const recoveredRegistry = new ConnectorRegistry({ db });
    registerConnectorAgentCleanup({
      mesh,
      registry: recoveredRegistry,
      authorityCleanup: new ConnectorAuthorityCleanupService({ db }),
      logger: { warn },
    });

    expect(recoveredRegistry.migrationHealth()).toEqual({ status: 'ready', migrated: true });
    expect(db.select().from(agentConnectionAttachments).all()).toEqual([]);
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_connector_attachments'"
        )
        .get()
    ).toBeUndefined();
    expect(
      db.$client
        .prepare(
          `SELECT agent_id, state, needs_reconciliation
           FROM session_connection_overrides
           WHERE session_id = ?`
        )
        .get(removedSessionId)
    ).toEqual({ agent_id: null, state: 'attached', needs_reconciliation: 1 });
    expect(
      db.$client
        .prepare(
          `SELECT COUNT(*) AS count
           FROM connection_operation_grants
           WHERE subject_type = 'session' AND subject_id = ?`
        )
        .get(removedSessionId)
    ).toEqual({ count: 0 });

    // The migration consumes the marker after fencing the old attachment. New
    // access can now be granted only through the canonical review workflow.
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_legacy_agent_revocations'"
        )
        .get()
    ).toBeUndefined();
  });
});

describe('agent cleanup failure containment', () => {
  function runCleanup(options: {
    markerThrows?: boolean;
    durableThrows?: boolean;
    transientThrows?: boolean;
  }) {
    let unregister!: (agentId: string, projectPath: string) => void;
    const events: string[] = [];
    const registry = {
      recordAgentRemoval: vi.fn(() => {
        events.push('marker');
        if (options.markerThrows) throw new Error('marker cleanup failed');
      }),
      migrationHealth: vi.fn(() => ({ status: 'ready' as const, migrated: false })),
      removeAgentAccess: vi.fn(() => {
        events.push('durable');
        if (options.durableThrows) throw new Error('durable cleanup failed');
      }),
    } as unknown as ConnectorRegistry;
    const authorityCleanup = {
      revokeAgent: vi.fn(() => {
        events.push('transient');
        if (options.transientThrows) throw new Error('transient cleanup failed');
      }),
      revokeAgentConnection: vi.fn(),
      revokeConnection: vi.fn(),
    };
    registerConnectorAgentCleanup({
      mesh: {
        onUnregister: (callback: (agentId: string, projectPath: string) => void) => {
          unregister = callback;
        },
      },
      registry,
      authorityCleanup,
      logger: { warn: vi.fn() },
    });
    return {
      invoke: () => unregister('agent-a', '/agents/a'),
      events,
      registry,
      authorityCleanup,
    };
  }

  it('still closes durable access when transient authority cleanup throws', () => {
    const harness = runCleanup({ transientThrows: true });
    expect(harness.invoke).toThrow('transient cleanup failed');
    expect(harness.events).toEqual(['marker', 'durable', 'transient']);
    expect(harness.registry.removeAgentAccess).toHaveBeenCalledWith('agent-a');
  });

  it('still closes canonical and pending authority when the durable marker throws', () => {
    const harness = runCleanup({ markerThrows: true });
    expect(harness.invoke).toThrow('marker cleanup failed');
    expect(harness.events).toEqual(['marker', 'durable', 'transient']);
    expect(harness.registry.removeAgentAccess).toHaveBeenCalledWith('agent-a');
    expect(harness.authorityCleanup.revokeAgent).toHaveBeenCalledWith({
      agentId: 'agent-a',
      reason: 'agent_removed',
    });
  });

  it('reports the first failure after attempting every independent close', () => {
    const harness = runCleanup({ markerThrows: true, durableThrows: true, transientThrows: true });
    expect(harness.invoke).toThrow('marker cleanup failed');
    expect(harness.events).toEqual(['marker', 'durable', 'transient']);
  });

  it('still clears transient authority when durable access cleanup throws', () => {
    const harness = runCleanup({ durableThrows: true });
    expect(harness.invoke).toThrow('durable cleanup failed');
    expect(harness.events).toEqual(['marker', 'durable', 'transient']);
    expect(harness.authorityCleanup.revokeAgent).toHaveBeenCalledWith({
      agentId: 'agent-a',
      reason: 'agent_removed',
    });
  });
});
