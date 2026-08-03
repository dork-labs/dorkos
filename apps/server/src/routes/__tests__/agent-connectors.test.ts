import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { AgentConnectorAttachmentStore } from '../../services/connectors/attachment-store.js';
import { createAgentConnectorsRouter } from '../agent-connectors.js';

/** Connect one account on a fake provider and persist its routing binding. */
async function connectAndRecord(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  registry.recordConnect(account!);
  return account!;
}

describe('agent-connectors router', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let store: AgentConnectorAttachmentStore;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/agents', createAgentConnectorsRouter({ store, registry }));
    return app;
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider({ type: 'composio', custody: 'managed' });
    registry.register(provider);
    store = new AgentConnectorAttachmentStore(db);
  });

  it('POST attaches an account to an agent (standing consent) and re-shows the custody disclosure', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(buildApp()).post(`/api/agents/agent-a/connectors/${account.id}`);

    expect(res.status).toBe(200);
    expect(res.body.account.accountId).toBe(account.id);
    expect(res.body.disclosure).toContain('secure vault');
    expect(store.listForAgent('agent-a').map((a) => a.accountId)).toEqual([account.id]);
  });

  it('POST returns 404 for an unknown account id and does not persist a row', async () => {
    const res = await request(buildApp()).post('/api/agents/agent-a/connectors/does-not-exist');
    expect(res.status).toBe(404);
    expect(store.listForAgent('agent-a')).toEqual([]);
  });

  it('GET lists an agent standing attachments', async () => {
    const gmail = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const slack = await connectAndRecord(registry, provider, 'slack', 'team');
    const app = buildApp();
    await request(app).post(`/api/agents/agent-a/connectors/${gmail.id}`);
    await request(app).post(`/api/agents/agent-a/connectors/${slack.id}`);

    const res = await request(app).get('/api/agents/agent-a/connectors');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a: { accountId: string }) => a.accountId).sort()).toEqual(
      [gmail.id, slack.id].sort()
    );
  });

  it('DELETE detaches an account and is idempotent', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const app = buildApp();
    await request(app).post(`/api/agents/agent-a/connectors/${account.id}`);
    expect(store.listForAgent('agent-a')).toHaveLength(1);

    const del = await request(app).delete(`/api/agents/agent-a/connectors/${account.id}`);
    expect(del.status).toBe(204);
    expect(store.listForAgent('agent-a')).toEqual([]);

    const again = await request(app).delete(`/api/agents/agent-a/connectors/${account.id}`);
    expect(again.status).toBe(204);
  });

  it('attaching to one agent does not attach to another', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    await request(buildApp()).post(`/api/agents/agent-a/connectors/${account.id}`);
    expect(store.listForAgent('agent-b')).toEqual([]);
  });
});
