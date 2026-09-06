import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  connectionOperationGrants,
  connectorEventSubscriptions,
  connectorOperationRevisions,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../../services/connectors/attachment-store.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import { createAgentConnectorsRouter, type AgentConnectorsMeshLike } from '../agent-connectors.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Connect one account on a fake provider and persist its routing binding. */
async function connectAndRecord(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  return registry.recordConnect(provider, account!);
}

describe('agent-connectors router', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let store: AgentConnectorAttachmentStore;
  let sessionStore: SessionConnectorAttachmentStore;
  let sessions: SessionConnectorService;

  function buildApp(meshCore?: AgentConnectorsMeshLike) {
    const app = express();
    app.use(express.json());
    app.use('/api/agents', createAgentConnectorsRouter({ store, registry, sessions, meshCore }));
    return app;
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider({ type: 'composio', custody: 'managed' });
    registry.register(provider);
    store = new AgentConnectorAttachmentStore(db);
    sessionStore = new SessionConnectorAttachmentStore(db);
    sessions = new SessionConnectorService({
      registry,
      agentAttachments: store,
      sessionAttachments: sessionStore,
    });
  });

  it('POST attaches an account to an agent (standing consent) and re-shows the custody disclosure', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(fixtureTarget.mount(buildApp())).post(
      `/api/agents/agent-a/connectors/${account.id}`
    );

    expect(res.status).toBe(200);
    expect(res.body.account.accountId).toBe(account.id);
    expect(res.body.disclosure).toContain('secure vault');
    expect(store.listForAgent('agent-a').map((a) => a.accountId)).toEqual([account.id]);
  });

  it('POST returns 404 for an unknown account id and does not persist a row', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).post(
      '/api/agents/agent-a/connectors/does-not-exist'
    );
    expect(res.status).toBe(404);
    expect(store.listForAgent('agent-a')).toEqual([]);
  });

  it('GET lists an agent standing attachments', async () => {
    const gmail = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const slack = await connectAndRecord(registry, provider, 'slack', 'team');
    const app = buildApp();
    await request(fixtureTarget.mount(app)).post(`/api/agents/agent-a/connectors/${gmail.id}`);
    await request(fixtureServer).post(`/api/agents/agent-a/connectors/${slack.id}`);

    const res = await request(fixtureServer).get('/api/agents/agent-a/connectors');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a: { accountId: string }) => a.accountId).sort()).toEqual(
      [gmail.id, slack.id].sort()
    );
  });

  it('DELETE detaches an account and is idempotent', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const app = buildApp();
    await request(fixtureTarget.mount(app)).post(`/api/agents/agent-a/connectors/${account.id}`);
    expect(store.listForAgent('agent-a')).toHaveLength(1);

    const del = await request(fixtureServer).delete(`/api/agents/agent-a/connectors/${account.id}`);
    expect(del.status).toBe(204);
    expect(store.listForAgent('agent-a')).toEqual([]);

    const again = await request(fixtureServer).delete(
      `/api/agents/agent-a/connectors/${account.id}`
    );
    expect(again.status).toBe(204);
  });

  it('DELETE revokes only this agent and connection before returning', async () => {
    const gmail = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const slack = await connectAndRecord(registry, provider, 'slack', 'team');
    const now = new Date().toISOString();
    for (const [revisionId, account, toolkit] of [
      ['gmail.send@1', gmail, 'gmail'],
      ['slack.send@1', slack, 'slack'],
    ] as const) {
      db.insert(connectorOperationRevisions)
        .values({
          id: revisionId,
          providerInstanceId: provider.instanceId,
          toolkit,
          operationSlug: 'send',
          toolkitVersion: '1',
          schemaHash: `${toolkit}-send-v1`,
          capabilityClassification: 'write',
          inputSchemaJson: '{}',
          discoveredAt: now,
        })
        .run();
      db.insert(connectionOperationGrants)
        .values([
          {
            id: `${revisionId}:agent-a`,
            subjectType: 'agent',
            subjectId: 'agent-a',
            agentId: 'agent-a',
            connectionId: account.id,
            operationRevisionId: revisionId,
            createdBy: 'operator',
            createdAt: now,
          },
          {
            id: `${revisionId}:session-agent-a`,
            subjectType: 'session',
            subjectId: 'session-agent-a',
            agentId: 'agent-a',
            connectionId: account.id,
            operationRevisionId: revisionId,
            createdBy: 'operator',
            createdAt: now,
          },
        ])
        .run();
      db.insert(connectorEventSubscriptions)
        .values({
          id: `${toolkit}:agent-a`,
          connectionId: account.id,
          agentId: 'agent-a',
          destinationKind: 'agent',
          destinationId: 'agent-a',
          eventType: 'message.received',
          filterJson: '{}',
          filterHash: 'empty',
          deliveryMode: 'relay',
          createdBy: 'operator',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    db.insert(connectionOperationGrants)
      .values([
        {
          id: 'gmail.send@1:agent-b',
          subjectType: 'agent',
          subjectId: 'agent-b',
          agentId: 'agent-b',
          connectionId: gmail.id,
          operationRevisionId: 'gmail.send@1',
          createdBy: 'operator',
          createdAt: now,
        },
        {
          id: 'gmail.send@1:session-agent-b',
          subjectType: 'session',
          subjectId: 'session-agent-b',
          agentId: 'agent-b',
          connectionId: gmail.id,
          operationRevisionId: 'gmail.send@1',
          createdBy: 'operator',
          createdAt: now,
        },
      ])
      .run();
    db.insert(connectorEventSubscriptions)
      .values({
        id: 'gmail:agent-b',
        connectionId: gmail.id,
        agentId: 'agent-b',
        destinationKind: 'agent',
        destinationId: 'agent-b',
        eventType: 'message.received',
        filterJson: '{}',
        filterHash: 'empty',
        deliveryMode: 'relay',
        createdBy: 'operator',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    store.attach('agent-a', gmail.id);
    store.attach('agent-a', slack.id);
    store.attach('agent-b', gmail.id);
    sessionStore.setState('session-agent-a', gmail.id, 'attached', 'agent-a');
    sessionStore.setState('session-agent-a', slack.id, 'attached', 'agent-a');
    sessionStore.setState('session-agent-b', gmail.id, 'attached', 'agent-b');
    await sessions.hydrateSession('session-agent-a', 'agent-a');
    await sessions.hydrateSession('session-agent-b', 'agent-b');
    expect(Object.keys(sessions.mcpServersForSession('session-agent-a').servers)).toHaveLength(2);
    expect(Object.keys(sessions.mcpServersForSession('session-agent-b').servers)).toHaveLength(1);

    const response = await request(fixtureTarget.mount(buildApp())).delete(
      `/api/agents/agent-a/connectors/${gmail.id}`
    );

    expect(response.status).toBe(204);
    const grantState = db.$client
      .prepare('SELECT id, revoked_at FROM connection_operation_grants ORDER BY id')
      .all() as Array<{ id: string; revoked_at: string | null }>;
    expect(grantState).toEqual([
      { id: 'gmail.send@1:agent-a', revoked_at: expect.any(String) },
      { id: 'gmail.send@1:agent-b', revoked_at: null },
      { id: 'gmail.send@1:session-agent-a', revoked_at: expect.any(String) },
      { id: 'gmail.send@1:session-agent-b', revoked_at: null },
      { id: 'slack.send@1:agent-a', revoked_at: null },
      { id: 'slack.send@1:session-agent-a', revoked_at: null },
    ]);
    expect(
      db.$client.prepare('SELECT id, enabled FROM connector_event_subscriptions ORDER BY id').all()
    ).toEqual([
      { id: 'gmail:agent-a', enabled: 0 },
      { id: 'gmail:agent-b', enabled: 1 },
      { id: 'slack:agent-a', enabled: 1 },
    ]);
    expect(
      db.$client
        .prepare(
          'SELECT session_id, connection_id FROM session_connection_overrides ORDER BY session_id, connection_id'
        )
        .all()
    ).toEqual([
      { session_id: 'session-agent-a', connection_id: slack.id },
      { session_id: 'session-agent-b', connection_id: gmail.id },
    ]);
    expect(store.listForAgent('agent-a').map((row) => row.accountId)).toEqual([slack.id]);
    expect(store.listForAgent('agent-b').map((row) => row.accountId)).toEqual([gmail.id]);
    expect(Object.keys(sessions.mcpServersForSession('session-agent-a').servers)).toHaveLength(1);
    expect(Object.keys(sessions.mcpServersForSession('session-agent-b').servers)).toHaveLength(1);
  });

  it('DELETE cannot be undone by a late provider result from hydration', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const binding = registry.accountBinding(account.id)!;
    store.attach('agent-a', account.id);
    let releaseProvider!: (value: {
      transport: 'http';
      url: string;
      headers: Record<string, string>;
    }) => void;
    const providerResult = new Promise<{
      transport: 'http';
      url: string;
      headers: Record<string, string>;
    }>((resolve) => {
      releaseProvider = resolve;
    });
    const toolServer = vi
      .spyOn(provider, 'toolServerForAccount')
      .mockImplementation((externalRef) =>
        externalRef === binding.externalAccountRef
          ? providerResult
          : Promise.reject(new Error('unexpected account'))
      );
    const hydration = sessions.hydrateSession('session-agent-a', 'agent-a');
    await vi.waitFor(() => expect(toolServer).toHaveBeenCalledTimes(1));

    const response = await request(fixtureTarget.mount(buildApp())).delete(
      `/api/agents/agent-a/connectors/${account.id}`
    );
    expect(response.status).toBe(204);
    releaseProvider({ transport: 'http', url: 'https://late.example/mcp', headers: {} });
    await hydration;

    expect(sessions.mcpServersForSession('session-agent-a').servers).toEqual({});
    expect(store.listForAgent('agent-a')).toEqual([]);
  });

  it('attaching to one agent does not attach to another', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    await request(fixtureTarget.mount(buildApp())).post(
      `/api/agents/agent-a/connectors/${account.id}`
    );
    expect(store.listForAgent('agent-b')).toEqual([]);
  });

  describe('MAJOR 7: agent existence validation', () => {
    it('POST 400s for an unknown agent and does not persist a row', async () => {
      const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
      const meshCore: AgentConnectorsMeshLike = { getProjectPath: () => undefined };

      const res = await request(fixtureTarget.mount(buildApp(meshCore))).post(
        `/api/agents/ghost-agent/connectors/${account.id}`
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('ghost-agent');
      expect(store.listForAgent('ghost-agent')).toEqual([]);
    });

    it('POST succeeds when the mesh knows the agent', async () => {
      const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
      const meshCore: AgentConnectorsMeshLike = {
        getProjectPath: (agentId) => (agentId === 'agent-a' ? '/agents/a' : undefined),
      };

      const res = await request(fixtureTarget.mount(buildApp(meshCore))).post(
        `/api/agents/agent-a/connectors/${account.id}`
      );

      expect(res.status).toBe(200);
      expect(store.listForAgent('agent-a').map((a) => a.accountId)).toEqual([account.id]);
    });

    it('the agent-existence check runs BEFORE the account-existence check (agent validation wins on both being wrong)', async () => {
      const meshCore: AgentConnectorsMeshLike = { getProjectPath: () => undefined };
      const res = await request(fixtureTarget.mount(buildApp(meshCore))).post(
        '/api/agents/ghost-agent/connectors/does-not-exist'
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('ghost-agent');
    });
  });
});
