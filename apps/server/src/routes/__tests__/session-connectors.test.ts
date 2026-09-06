import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../../services/connectors/attachment-store.js';
import { createSessionConnectorsRouter } from '../session-connectors.js';

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
    service = new SessionConnectorService({
      registry,
      agentAttachments: new AgentConnectorAttachmentStore(db),
      sessionAttachments: new SessionConnectorAttachmentStore(db, (sessionId) =>
        sessionId === 's1' ? 'agent-a' : undefined
      ),
    });
  });

  it('POST attaches an account and re-shows the custody disclosure', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(fixtureTarget.mount(buildApp())).post(
      `/api/sessions/s1/connectors/${account.id}`
    );

    expect(res.status).toBe(200);
    expect(res.body.account.exposed).toBe(true);
    expect(res.body.account.serverName).toBe('gmail-personal');
    expect(res.body.disclosure).toContain('secure vault');
    // The account is now bound to the session's tool surface.
    expect(Object.keys(service.mcpServersForSession('s1').servers)).toEqual(['gmail-personal']);
  });

  it('POST returns 404 for an unknown account id', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).post(
      '/api/sessions/s1/connectors/does-not-exist'
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('does-not-exist');
  });

  it('keeps an arbitrary-directory session unowned and refuses attachment with an actionable 409', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    db.$client
      .prepare(
        `INSERT INTO session_metadata(session_id, runtime, agent_path, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        'unowned-session',
        'test-mode',
        '/projects/arbitrary-directory',
        new Date().toISOString()
      );
    service = new SessionConnectorService({
      registry,
      agentAttachments: new AgentConnectorAttachmentStore(db),
      sessionAttachments: new SessionConnectorAttachmentStore(db),
    });

    const res = await request(fixtureTarget.mount(buildApp())).post(
      `/api/sessions/unowned-session/connectors/${account.id}`
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Choose a registered agent before attaching a connection to this session.',
      code: 'SESSION_CONNECTOR_OWNER_UNAVAILABLE',
    });
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM session_connection_overrides').get()
    ).toEqual({ count: 0 });
  });

  it('GET reports the connector surface with null-branch warnings', async () => {
    const active = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const expired = await connectAndRecord(registry, provider, 'slack', 'team');
    provider.setStatus(registry.accountBinding(expired.id)!.externalAccountRef, 'expired');

    const app = buildApp();
    await request(fixtureTarget.mount(app)).post(`/api/sessions/s1/connectors/${active.id}`);
    await request(fixtureServer).post(`/api/sessions/s1/connectors/${expired.id}`);

    const res = await request(fixtureServer).get('/api/sessions/s1/connectors');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.warnings.map((w: { accountId: string }) => w.accountId)).toEqual([expired.id]);
  });

  it('DELETE detaches an account and is idempotent', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const app = buildApp();
    await request(fixtureTarget.mount(app)).post(`/api/sessions/s1/connectors/${account.id}`);
    expect(Object.keys(service.mcpServersForSession('s1').servers)).toEqual(['gmail-personal']);

    const del = await request(fixtureServer).delete(`/api/sessions/s1/connectors/${account.id}`);
    expect(del.status).toBe(204);
    expect(service.mcpServersForSession('s1').servers).toEqual({});

    // Detaching again still resolves 204.
    const again = await request(fixtureServer).delete(`/api/sessions/s1/connectors/${account.id}`);
    expect(again.status).toBe(204);
  });

  it('DELETE returns 204 for an unknown connection without writing an invalid override', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).delete(
      '/api/sessions/s1/connectors/unknown-stable-connection'
    );

    expect(res.status).toBe(204);
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM session_connection_overrides').get()
    ).toEqual({ count: 0 });
  });

  it('DELETE keeps a detached tombstone for a known connection that was not attached', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');

    const res = await request(fixtureTarget.mount(buildApp())).delete(
      `/api/sessions/s1/connectors/${account.id}`
    );

    expect(res.status).toBe(204);
    expect(
      db.$client
        .prepare(
          `SELECT session_id, agent_id, connection_id, state
           FROM session_connection_overrides`
        )
        .get()
    ).toEqual({
      session_id: 's1',
      agent_id: 'agent-a',
      connection_id: account.id,
      state: 'detached',
    });
  });

  it('DELETE refuses an unknown or unowned session before the unknown-connection no-op', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).delete(
      '/api/sessions/no-such-session/connectors/unknown-stable-connection'
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Choose a registered agent before changing connections for this session.',
      code: 'SESSION_CONNECTOR_OWNER_UNAVAILABLE',
    });
  });

  it('never exposes McpAppServerConnection details to the client', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const res = await request(fixtureTarget.mount(buildApp())).post(
      `/api/sessions/s1/connectors/${account.id}`
    );
    // The response carries only account metadata + disclosure — no url/command/env.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('fake.mcp');
    expect(res.body.account).not.toHaveProperty('provider');
  });
});
