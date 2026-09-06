import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentConnectionAttachments,
  agents,
  connectionOperationGrants,
  connections,
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
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../attachment-store.js';
import { ConnectionStore } from '../connection-store.js';
import { ConnectorRegistry } from '../registry.js';
import { SessionConnectorService } from '../session-exposure.js';

const NOW = '2026-09-05T12:00:00.000Z';
const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
const temporaryDirectories: string[] = [];
const meshes: MeshCore[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'connector-agent-cleanup-'));
  temporaryDirectories.push(root);
  return root;
}

function createServices(db: Db, registry: ConnectorRegistry): SessionConnectorService {
  return new SessionConnectorService({
    registry,
    agentAttachments: new AgentConnectorAttachmentStore(db),
    sessionAttachments: new SessionConnectorAttachmentStore(db),
  });
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
    const sessions = createServices(db, registry);
    const account = await connect(registry);
    seedAuthority(db, account, [agentA.id, agentB.id]);
    await sessions.hydrateSession(`session-${agentA.id}`, agentA.id);
    await sessions.hydrateSession(`session-${agentB.id}`, agentB.id);
    registerConnectorAgentCleanup({
      mesh,
      registry,
      sessions,
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
    expect(db.select().from(connectorLegacyAgentRevocations).all()).toMatchObject([
      { agentId: agentA.id },
    ]);
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
    expect(sessions.mcpServersForSession(`session-${agentA.id}`).servers).toEqual({});
    expect(Object.keys(sessions.mcpServersForSession(`session-${agentB.id}`).servers)).toEqual([
      'gmail-shared',
    ]);
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
      sessions: createServices(db, failedRegistry),
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
      sessions: createServices(db, recoveredRegistry),
      logger: { warn },
    });

    expect(recoveredRegistry.migrationHealth()).toEqual({ status: 'ready', migrated: true });
    expect(db.select().from(agentConnectionAttachments).all()).toEqual([]);
    expect(db.$client.prepare('SELECT * FROM agent_connector_attachments').all()).toHaveLength(1);
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

    // The marker only fences old consent. A fresh explicit operator action for
    // the re-registered agent can create canonical authority normally.
    const stableConnectionId = db.select({ id: connections.id }).from(connections).get()!
      .id as ConnectedAccount['id'];
    new AgentConnectorAttachmentStore(db).attach(removed.id, stableConnectionId);
    expect(db.select().from(agentConnectionAttachments).all()).toMatchObject([
      { agentId: removed.id, connectionId: stableConnectionId },
    ]);
  });
});
