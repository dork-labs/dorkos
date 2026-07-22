import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import { createSessionConnectorsRouter } from '../session-connectors.js';

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

describe('session-connectors router', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let service: SessionConnectorService;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', createSessionConnectorsRouter({ service }));
    return app;
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider({ type: 'composio', custody: 'managed' });
    registry.register(provider);
    service = new SessionConnectorService({ registry });
  });

  it('POST attaches an account and re-shows the custody disclosure', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(buildApp()).post(`/api/sessions/s1/connectors/${account.id}`);

    expect(res.status).toBe(200);
    expect(res.body.account.exposed).toBe(true);
    expect(res.body.account.serverName).toBe('gmail-personal');
    expect(res.body.disclosure).toContain('secure vault');
    // The account is now bound to the session's tool surface.
    expect(Object.keys(service.mcpServersForSession('s1').servers)).toEqual(['gmail-personal']);
  });

  it('POST returns 404 for an unknown account id', async () => {
    const res = await request(buildApp()).post('/api/sessions/s1/connectors/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('does-not-exist');
  });

  it('GET reports the connector surface with null-branch warnings', async () => {
    const active = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const expired = await connectAndRecord(registry, provider, 'slack', 'team');
    provider.setStatus(expired.id, 'expired');

    const app = buildApp();
    await request(app).post(`/api/sessions/s1/connectors/${active.id}`);
    await request(app).post(`/api/sessions/s1/connectors/${expired.id}`);

    const res = await request(app).get('/api/sessions/s1/connectors');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.warnings.map((w: { accountId: string }) => w.accountId)).toEqual([expired.id]);
  });

  it('DELETE detaches an account and is idempotent', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const app = buildApp();
    await request(app).post(`/api/sessions/s1/connectors/${account.id}`);
    expect(Object.keys(service.mcpServersForSession('s1').servers)).toEqual(['gmail-personal']);

    const del = await request(app).delete(`/api/sessions/s1/connectors/${account.id}`);
    expect(del.status).toBe(204);
    expect(service.mcpServersForSession('s1').servers).toEqual({});

    // Detaching again still resolves 204.
    const again = await request(app).delete(`/api/sessions/s1/connectors/${account.id}`);
    expect(again.status).toBe(204);
  });

  it('never exposes McpAppServerConnection details to the client', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(buildApp()).post(`/api/sessions/s1/connectors/${account.id}`);
    // The response carries only account metadata + disclosure — no url/command/env.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('fake.mcp');
    expect(res.body.account).not.toHaveProperty('provider');
  });
});
