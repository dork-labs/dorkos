import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import type { RelayAdapterCatalog } from '../../services/connectors/routing.js';
import { createConnectorsRouter } from '../connectors.js';

/** A relay catalog with a purpose-built adapter only for the given slugs. */
function relayWith(slugs: Record<string, string>): RelayAdapterCatalog {
  return {
    getManifest: (type: string) => (slugs[type] ? { displayName: slugs[type] } : undefined),
  };
}

describe('connectors router', () => {
  let db: Db;
  let registry: ConnectorRegistry;

  /** Build an app wired to a registry with a managed composio fake registered. */
  function buildApp(relay?: RelayAdapterCatalog) {
    const app = express();
    app.use(express.json());
    app.use('/api/connectors', createConnectorsRouter({ registry, relay }));
    return app;
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
  });

  it('GET /toolkits returns the aggregated connectable services', async () => {
    const res = await request(buildApp()).get('/api/connectors/toolkits');
    expect(res.status).toBe(200);
    expect(res.body.toolkits.map((t: { slug: string }) => t.slug).sort()).toEqual([
      'gmail',
      'slack',
    ]);
    expect(res.body.warnings).toEqual([]);
  });

  it('GET /recommend routes slack to the relay adapter first, gmail to the gateway', async () => {
    const app = buildApp(relayWith({ slack: 'Slack' }));

    const slack = await request(app).get('/api/connectors/recommend?service=slack');
    expect(slack.status).toBe(200);
    expect(slack.body.recommendations[0]).toMatchObject({ kind: 'relay-adapter', target: 'slack' });

    const gmail = await request(app).get('/api/connectors/recommend?service=gmail');
    expect(gmail.body.recommendations[0]).toMatchObject({ kind: 'gateway', provider: 'composio' });
  });

  it('GET /recommend 400s without a service param', async () => {
    const res = await request(buildApp()).get('/api/connectors/recommend');
    expect(res.status).toBe(400);
  });

  it('POST /:provider/connect starts a flow; GET /flows/:flowId polls it to connected', async () => {
    const app = buildApp();
    const start = await request(app)
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    expect(start.status).toBe(200);
    expect(start.body.flowId).toBeTruthy();
    expect(start.body.authorizeUrl).toContain('gmail');

    const poll = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('connected');
    expect(poll.body.account.toolkit).toBe('gmail');
  });

  it('POST /:provider/connect 404s for an unknown provider', async () => {
    const res = await request(buildApp())
      .post('/api/connectors/no-such-provider/connect')
      .send({ toolkit: 'gmail' });
    expect(res.status).toBe(404);
  });

  it('POST /:provider/connect 400s on a missing toolkit (Express 5 empty body)', async () => {
    const res = await request(buildApp()).post('/api/connectors/composio/connect').send();
    expect(res.status).toBe(400);
  });

  it('GET /flows/:flowId 404s for an unknown flow', async () => {
    const res = await request(buildApp()).get('/api/connectors/flows/never-started');
    expect(res.status).toBe(404);
  });

  it('GET /accounts strips the server-only provider field and never carries connection details', async () => {
    const app = buildApp();
    const start = await request(app)
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    await request(app).get(`/api/connectors/flows/${start.body.flowId}`);

    const res = await request(app).get('/api/connectors/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    const account = res.body.accounts[0];
    // The DTO carries account metadata but NOT the owning provider field, and
    // never a McpAppServerConnection (no url/command/transport/headers).
    // (The opaque account id may be provider-scoped — that is by design and
    // never names the vendor in the session tool surface.)
    expect(Object.keys(account)).not.toContain('provider');
    expect(account.provider).toBeUndefined();
    expect(account).not.toHaveProperty('connection');
    expect(account).not.toHaveProperty('url');
    expect(account).not.toHaveProperty('command');
    expect(account).toMatchObject({ toolkit: 'gmail', label: 'personal', custody: 'managed' });
  });

  it('GET /accounts?toolkit filters to one service', async () => {
    const app = buildApp();
    for (const toolkit of ['gmail', 'slack']) {
      const start = await request(app)
        .post('/api/connectors/composio/connect')
        .send({ toolkit, label: 'x' });
      await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    }
    const res = await request(app).get('/api/connectors/accounts?toolkit=slack');
    expect(res.body.accounts.map((a: { toolkit: string }) => a.toolkit)).toEqual(['slack']);
  });

  it('DELETE /accounts/:accountId disconnects and is idempotent (204 for unknown ids)', async () => {
    const app = buildApp();
    const start = await request(app)
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    const poll = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    const accountId = poll.body.account.id;

    const first = await request(app).delete(
      `/api/connectors/accounts/${encodeURIComponent(accountId)}`
    );
    expect(first.status).toBe(204);
    // Gone from the aggregate now.
    const after = await request(app).get('/api/connectors/accounts');
    expect(after.body.accounts).toHaveLength(0);

    // Deleting an unknown/already-removed id still resolves 204.
    const again = await request(app).delete('/api/connectors/accounts/never-existed');
    expect(again.status).toBe(204);
  });
});
