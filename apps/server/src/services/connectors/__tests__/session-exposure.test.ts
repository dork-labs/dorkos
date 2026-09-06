import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connectorOperationRevisions,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../attachment-store.js';
import { ConnectorRegistry } from '../registry.js';
import { SessionConnectorService } from '../session-exposure.js';

async function connectAndRecord(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  label = 'work'
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect('gmail', { label });
  const poll = await provider.pollConnect(flowId);
  return registry.recordConnect(provider, poll.account!);
}

function grant(
  db: Db,
  provider: FakeConnectorProvider,
  account: ConnectedAccount,
  subjectType: 'agent' | 'session',
  subjectId: string
): void {
  const operationRevisionId = `revision-${account.id}`;
  db.insert(connectorOperationRevisions)
    .values({
      id: operationRevisionId,
      providerInstanceId: provider.instanceId,
      toolkit: account.toolkit,
      operationSlug: `${account.toolkit}.read`,
      toolkitVersion: 'test-v1',
      schemaHash: `sha256:${account.id}`,
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
      discoveredAt: '2026-09-06T12:00:00.000Z',
    })
    .onConflictDoNothing()
    .run();
  db.insert(connectionOperationGrants)
    .values({
      id: `grant-${subjectType}-${subjectId}-${account.id}`,
      subjectType,
      subjectId,
      agentId: 'agent-a',
      connectionId: account.id,
      operationRevisionId,
      createdBy: 'owner',
      createdAt: '2026-09-06T12:00:00.000Z',
    })
    .run();
}

describe('SessionConnectorService read-only durable projection', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let agents: AgentConnectorAttachmentStore;
  let sessions: SessionConnectorAttachmentStore;
  let service: SessionConnectorService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider();
    registry.register(provider);
    agents = new AgentConnectorAttachmentStore(db);
    sessions = new SessionConnectorAttachmentStore(db, () => 'agent-a');
    service = new SessionConnectorService({
      db,
      registry,
      agentAttachments: agents,
      sessionAttachments: sessions,
    });
  });

  it('reports inherited agent access without resolving a provider endpoint', async () => {
    const account = await connectAndRecord(registry, provider);
    agents.attach('agent-a', account.id);
    grant(db, provider, account, 'agent', 'agent-a');

    expect(service.status('session-a')).toEqual({
      accounts: [
        {
          accountId: account.id,
          toolkit: 'gmail',
          label: 'work',
          status: 'active',
          access: 'inherited',
        },
      ],
      warnings: [],
    });
  });

  it('keeps an explicit detached override visible and dominant over agent access', async () => {
    const account = await connectAndRecord(registry, provider);
    agents.attach('agent-a', account.id);
    grant(db, provider, account, 'agent', 'agent-a');
    sessions.setState('session-a', account.id, 'detached', 'agent-a');

    expect(service.status('session-a').accounts[0]).toMatchObject({
      accountId: account.id,
      access: 'session_blocked',
    });
  });

  it('distinguishes session-scoped access and rows that need owner reconciliation', async () => {
    const attached = await connectAndRecord(registry, provider, 'attached');
    const uncertain = await connectAndRecord(registry, provider, 'uncertain');
    sessions.setState('session-a', attached.id, 'attached', 'agent-a');
    sessions.setState('session-a', uncertain.id, 'attached', 'agent-a');
    grant(db, provider, attached, 'session', 'session-a');
    grant(db, provider, uncertain, 'session', 'session-a');
    db.$client
      .prepare(
        'UPDATE session_connection_overrides SET needs_reconciliation = 1 WHERE connection_id = ?'
      )
      .run(uncertain.id);

    expect(service.status('session-a').accounts).toEqual([
      expect.objectContaining({ accountId: attached.id, access: 'session_allowed' }),
      expect.objectContaining({ accountId: uncertain.id, access: 'needs_reconciliation' }),
    ]);
  });

  it('surfaces lifecycle warnings without exposing provider transport', async () => {
    const account = await connectAndRecord(registry, provider);
    agents.attach('agent-a', account.id);
    grant(db, provider, account, 'agent', 'agent-a');
    registry.setPaused(account.id, true);

    const status = service.status('session-a');
    expect(status.accounts[0]).toMatchObject({ status: 'paused', access: 'inherited' });
    expect(status.warnings).toEqual([{ accountId: account.id, label: 'work', reason: 'paused' }]);
    expect(JSON.stringify(status)).not.toMatch(/url|headers|command|provider/i);
  });

  it('moves durable overrides when a runtime assigns the canonical session id', async () => {
    const account = await connectAndRecord(registry, provider);
    sessions.setState('request-id', account.id, 'detached', 'agent-a');

    service.migrateSession('request-id', 'canonical-id');

    expect(sessions.listForSession('request-id')).toEqual([]);
    expect(service.status('canonical-id').accounts[0]).toMatchObject({
      accountId: account.id,
      access: 'session_blocked',
    });
  });

  it('reports legacy rows and attached overrides without canonical grants as reconciliation needs', async () => {
    const legacy = await connectAndRecord(registry, provider, 'legacy');
    const attached = await connectAndRecord(registry, provider, 'attached');
    agents.attach('agent-a', legacy.id);
    sessions.setState('session-a', attached.id, 'attached', 'agent-a');

    expect(service.status('session-a').accounts).toEqual([
      expect.objectContaining({ accountId: attached.id, access: 'needs_reconciliation' }),
      expect.objectContaining({ accountId: legacy.id, access: 'needs_reconciliation' }),
    ]);
  });

  it('reports canonical agent grants even when no legacy attachment row remains', async () => {
    const account = await connectAndRecord(registry, provider);
    grant(db, provider, account, 'agent', 'agent-a');

    expect(service.status('session-a').accounts).toEqual([
      expect.objectContaining({ accountId: account.id, access: 'inherited' }),
    ]);
  });

  it('does not report a session grant through an override owned by another agent', async () => {
    const account = await connectAndRecord(registry, provider);
    sessions.setState('session-a', account.id, 'attached', 'agent-a');
    grant(db, provider, account, 'session', 'session-a');
    db.$client
      .prepare('UPDATE session_connection_overrides SET agent_id = ? WHERE session_id = ?')
      .run('agent-b', 'session-a');

    expect(service.status('session-a').accounts).toEqual([
      expect.objectContaining({ accountId: account.id, access: 'needs_reconciliation' }),
    ]);
  });
});
