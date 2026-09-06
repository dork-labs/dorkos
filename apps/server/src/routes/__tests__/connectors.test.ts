import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { agents, connections, createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectorToolkit, ProviderConnectedAccount } from '@dorkos/shared/connector-provider';
import { custodyDisclosure } from '../../services/connectors/custody-disclosure.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { ConnectorFlowBindings } from '../../services/connectors/flow-bindings.js';
import { RawMcpConnectorProvider } from '../../services/connectors/providers/raw-mcp.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../../services/connectors/attachment-store.js';
import type { RelayAdapterCatalog } from '../../services/connectors/routing.js';
import { createConnectorsRouter } from '../connectors.js';
import { logger } from '../../lib/logger.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** A relay catalog with a purpose-built adapter only for the given slugs. */
function relayWith(slugs: Record<string, string>): RelayAdapterCatalog {
  return {
    getManifest: (type: string) => (slugs[type] ? { displayName: slugs[type] } : undefined),
  };
}

/** A gateway provider whose `listToolkits` never resolves — the hung-provider case. */
class HungProvider extends FakeConnectorProvider {
  constructor() {
    super({ type: 'hung' });
  }

  override listToolkits(): Promise<ConnectorToolkit[]> {
    return new Promise<ConnectorToolkit[]>(() => {});
  }
  override listAccounts(): Promise<ProviderConnectedAccount[]> {
    return Promise.resolve([]);
  }
}

describe('connectors router', () => {
  let db: Db;
  let registry: ConnectorRegistry;

  /** Build an app wired to a registry with a managed composio fake registered. */
  function buildApp(
    relay?: RelayAdapterCatalog,
    flowBindings: ConnectorFlowBindings = new ConnectorFlowBindings()
  ) {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/connectors',
      createConnectorsRouter({
        registry,
        flowBindings,
        sessionConnectors: new SessionConnectorService({
          registry,
          agentAttachments: new AgentConnectorAttachmentStore(db),
          sessionAttachments: new SessionConnectorAttachmentStore(db, () => 'agent-a'),
        }),
        relay,
      })
    );
    return app;
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
  });

  it('GET /toolkits returns the aggregated connectable services', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).get('/api/connectors/toolkits');
    expect(res.status).toBe(200);
    expect(res.body.toolkits.map((t: { slug: string }) => t.slug).sort()).toEqual([
      'gmail',
      'slack',
    ]);
    expect(res.body.warnings).toEqual([]);
  });

  it('GET /recommend routes slack to the relay adapter first, gmail to the gateway', async () => {
    const app = buildApp(relayWith({ slack: 'Slack' }));

    const slack = await request(fixtureTarget.mount(app)).get(
      '/api/connectors/recommend?service=slack'
    );
    expect(slack.status).toBe(200);
    expect(slack.body.recommendations[0]).toMatchObject({ kind: 'relay-adapter', target: 'slack' });

    const gmail = await request(fixtureServer).get('/api/connectors/recommend?service=gmail');
    expect(gmail.body.recommendations[0]).toMatchObject({ kind: 'gateway', provider: 'composio' });
  });

  it('GET /toolkits surfaces a failing provider as a warning — never a silent empty list', async () => {
    // The founder's first-contact failure (DOR-703): Composio 401ed on every
    // call and the page showed an empty grid with warnings: []. A provider
    // failure must reach the DTO's warnings, message included.
    const failing = new HungProvider();
    failing.listToolkits = () =>
      Promise.reject(new Error('Composio request failed (401): Invalid API key: uak**SGn9'));
    const bounded = new ConnectorRegistry({ db, providerTimeoutMs: 50 });
    bounded.register(failing);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/connectors',
      createConnectorsRouter({
        registry: bounded,
        flowBindings: new ConnectorFlowBindings(),
        sessionConnectors: new SessionConnectorService({
          registry: bounded,
          agentAttachments: new AgentConnectorAttachmentStore(db),
          sessionAttachments: new SessionConnectorAttachmentStore(db, () => 'agent-a'),
        }),
      })
    );

    const res = await request(fixtureTarget.mount(app)).get('/api/connectors/toolkits');
    expect(res.status).toBe(200);
    expect(res.body.toolkits).toEqual([]);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ provider: 'hung' });
    expect(res.body.warnings[0].message).toMatch(/401/);
  });

  it('GET /recommend 400s without a service param', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).get('/api/connectors/recommend');
    expect(res.status).toBe(400);
  });

  it('GET /recommend degrades a hung provider to a warning instead of hanging', async () => {
    // A bounded registry so the hung provider times out fast rather than
    // blocking /recommend forever (the latent risk once a gateway makes a live
    // network call).
    const bounded = new ConnectorRegistry({ db, providerTimeoutMs: 50 });
    bounded.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    bounded.register(new HungProvider());
    const app = express();
    app.use(express.json());
    app.use(
      '/api/connectors',
      createConnectorsRouter({
        registry: bounded,
        flowBindings: new ConnectorFlowBindings(),
        sessionConnectors: new SessionConnectorService({
          registry: bounded,
          agentAttachments: new AgentConnectorAttachmentStore(db),
          sessionAttachments: new SessionConnectorAttachmentStore(db, () => 'agent-a'),
        }),
      })
    );

    const start = Date.now();
    const res = await request(fixtureTarget.mount(app)).get(
      '/api/connectors/recommend?service=gmail'
    );
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.recommendations[0]).toMatchObject({ kind: 'gateway', provider: 'composio' });
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ provider: 'hung' });
    expect(res.body.warnings[0].message).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(2000);
  });

  it('POST /:provider/connect starts a flow; GET /flows/:flowId polls it to connected', async () => {
    const app = buildApp();
    const start = await request(fixtureTarget.mount(app))
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    expect(start.status).toBe(200);
    expect(start.body.flowId).toBeTruthy();
    expect(start.body.authorizeUrl).toContain('gmail');
    // The custody sentence rides the start response so the client can render it
    // BEFORE opening the auth URL — server-owned copy, exactly the module's.
    expect(start.body.disclosure).toBe(custodyDisclosure('managed', { service: 'gmail' }));

    const poll = await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('connected');
    expect(poll.body.account.toolkit).toBe('gmail');
    // Publicized before it crosses out: provider stripped, disclosure attached.
    expect(poll.body.account.provider).toBeUndefined();
    expect(Object.keys(poll.body.account)).not.toContain('provider');
    expect(poll.body.account.disclosure).toBe(
      custodyDisclosure('managed', { service: 'personal' })
    );
    const replay = await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(poll.body);
  });

  it('polls the exact provider object that started a flow after its registry slot is replaced', async () => {
    const app = buildApp();
    const originalProvider = registry.resolveProvider('composio') as FakeConnectorProvider;
    const start = await request(fixtureTarget.mount(app))
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'original-instance' });
    const replacementProvider = new FakeConnectorProvider({
      type: 'composio',
      custody: 'managed',
      instanceId: originalProvider.instanceId,
    });
    registry.register(replacementProvider);

    const poll = await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({
      status: 'connected',
      account: { label: 'original-instance' },
    });
    expect((await originalProvider.listAccounts()).map((account) => account.label)).toEqual([
      'original-instance',
    ]);
    expect(await replacementProvider.listAccounts()).toEqual([]);
  });

  it('pins a provider poll against capacity eviction and rejects the competing start', async () => {
    const flowBindings = new ConnectorFlowBindings(undefined, 1);
    const app = buildApp(undefined, flowBindings);
    const provider = registry.resolveProvider('composio') as FakeConnectorProvider;
    const originalPoll = provider.pollConnect.bind(provider);
    let announcePoll!: () => void;
    let releasePoll!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      announcePoll = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    provider.pollConnect = async (flowId) => {
      announcePoll();
      await blocked;
      return originalPoll(flowId);
    };
    const first = await request(fixtureTarget.mount(app))
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'late' });
    const latePoll = request(fixtureServer)
      .get(`/api/connectors/flows/${first.body.flowId}`)
      .then((response) => response);
    await pollStarted;
    const competing = await request(fixtureServer)
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'newer' });
    expect(competing.status).toBe(400);
    expect(competing.body.error).toMatch(/connection checks are already in progress/i);
    releasePoll();

    const completed = await latePoll;
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: 'connected',
      account: { toolkit: 'gmail', label: 'late' },
    });
    expect(db.select().from(connections).all()).toHaveLength(1);
    const inventory = await request(fixtureServer).get('/api/connectors/accounts');
    expect(inventory.body.accounts).toEqual([completed.body.account]);
  });

  it('POST /:provider/connect 404s for an unknown provider', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/no-such-provider/connect')
      .send({ toolkit: 'gmail' });
    expect(res.status).toBe(404);
  });

  it('POST /:provider/connect 400s on a missing toolkit (Express 5 empty body)', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/composio/connect')
      .send();
    expect(res.status).toBe(400);
  });

  it('GET /flows/:flowId 404s for an unknown flow', async () => {
    const res = await request(fixtureTarget.mount(buildApp())).get(
      '/api/connectors/flows/never-started'
    );
    expect(res.status).toBe(404);
  });

  it('GET /accounts strips the server-only provider field and never carries connection details', async () => {
    const app = buildApp();
    const start = await request(fixtureTarget.mount(app))
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);

    const res = await request(fixtureServer).get('/api/connectors/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    const account = res.body.accounts[0];
    // The DTO carries account metadata but NOT the owning provider field, and
    // never a McpAppServerConnection (no url/command/transport/headers).
    // The public id is assigned by DorkOS and does not fall back to the
    // provider-owned account reference.
    expect(Object.keys(account)).not.toContain('provider');
    expect(account.provider).toBeUndefined();
    expect(account).not.toHaveProperty('connection');
    expect(account).not.toHaveProperty('url');
    expect(account).not.toHaveProperty('command');
    expect(account).toMatchObject({ toolkit: 'gmail', label: 'personal', custody: 'managed' });
    expect(account.id).not.toContain('composio');
    expect(account.id).not.toContain('ca_');
    // Every listed account carries its own server-composed custody sentence —
    // the client never composes disclosure copy (spec §UX).
    expect(account.disclosure).toBe(custodyDisclosure('managed', { service: 'personal' }));
  });

  it('reports a scrubbed migration_failed response without exposing a private legacy reference', async () => {
    const privateRef = 'composio:private-vendor-ref-sentinel';
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    db = createDb(':memory:');
    runMigrations(db);
    db.insert(agents)
      .values({
        id: 'agent-a',
        name: 'Agent A',
        runtime: 'claude-code',
        projectPath: '/agents/a',
        registeredAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })
      .run();
    db.$client
      .prepare(
        'INSERT INTO agent_connector_attachments(agent_id, account_id, attached_at) VALUES (?, ?, ?)'
      )
      .run('agent-a', privateRef, new Date(0).toISOString());
    registry = new ConnectorRegistry({ db });

    const res = await request(fixtureTarget.mount(buildApp())).get('/api/connectors/accounts');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'migration_failed',
      error:
        'Connector data could not be upgraded. Connector changes are unavailable; restart DorkOS to retry.',
    });
    expect(JSON.stringify(res.body)).not.toContain(privateRef);
    expect(JSON.stringify(res.body)).not.toMatch(/SQLITE|agent_connector_attachments|\/Users\//i);
    expect(errorLog).toHaveBeenCalledWith('[connectors] legacy connection migration failed', {
      migrationVersion: 1,
      phase: 'attachments',
      category: 'invariant',
      causeCode: 'legacy_agent_account_missing',
    });
    const diagnostic = JSON.stringify(errorLog.mock.calls);
    expect(diagnostic).not.toContain(privateRef);
    expect(diagnostic).not.toMatch(/SQLITE|agent_connector_attachments|\/Users\//i);
    errorLog.mockRestore();
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM connections').get()).toEqual({
      count: 0,
    });
  });

  it('GET /accounts?toolkit filters to one service', async () => {
    const app = buildApp();
    for (const toolkit of ['gmail', 'slack']) {
      const start = await request(fixtureTarget.mount(app))
        .post('/api/connectors/composio/connect')
        .send({ toolkit, label: 'x' });
      await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    }
    const res = await request(fixtureServer).get('/api/connectors/accounts?toolkit=slack');
    expect(res.body.accounts.map((a: { toolkit: string }) => a.toolkit)).toEqual(['slack']);
  });

  it('DELETE /accounts/:accountId disconnects and is idempotent (204 for unknown ids)', async () => {
    const app = buildApp();
    const start = await request(fixtureTarget.mount(app))
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    const poll = await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    const accountId = poll.body.account.id;
    const externalAccountRef = registry.accountBinding(accountId)!.externalAccountRef;
    expect(accountId).not.toBe(externalAccountRef);

    const first = await request(fixtureServer).delete(
      `/api/connectors/accounts/${encodeURIComponent(accountId)}`
    );
    expect(first.status).toBe(204);
    // Gone from the aggregate now.
    const after = await request(fixtureServer).get('/api/connectors/accounts');
    expect(after.body.accounts).toHaveLength(0);
    const replay = await request(fixtureServer).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(replay.status).toBe(404);
    expect(registry.accountBinding(accountId)?.status).toBe('revoked');

    // Deleting an unknown/already-removed id still resolves 204.
    const again = await request(fixtureServer).delete('/api/connectors/accounts/never-existed');
    expect(again.status).toBe(204);
  });

  it('DELETE cancels an in-flight reconnect by stable id without reviving its tombstone', async () => {
    const raw = new RawMcpConnectorProvider({
      servers: [
        {
          slug: 'notion',
          displayName: 'Notion',
          connection: { transport: 'http', url: 'https://mcp.notion.example/mcp' },
        },
      ],
      probe: () => Promise.resolve({ kind: 'ok', toolCount: 1 }),
    });
    registry.register(raw);
    const app = buildApp();
    const initialStart = await request(fixtureTarget.mount(app))
      .post('/api/connectors/mcp/connect')
      .send({ toolkit: 'notion', label: 'notion' });
    const initialPoll = await request(fixtureServer).get(
      `/api/connectors/flows/${initialStart.body.flowId}`
    );
    const connectionId = initialPoll.body.account.id;
    const externalAccountRef = registry.accountBinding(connectionId)!.externalAccountRef;
    expect(connectionId).not.toBe(externalAccountRef);
    await request(fixtureServer).delete(`/api/connectors/accounts/${connectionId}`).expect(204);

    const reconnect = await request(fixtureServer)
      .post('/api/connectors/mcp/connect')
      .send({ toolkit: 'notion', label: 'notion' });
    const originalPoll = raw.pollConnect.bind(raw);
    let announcePoll!: () => void;
    let releasePoll!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      announcePoll = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    raw.pollConnect = async (providerFlowId) => {
      announcePoll();
      await blocked;
      return originalPoll(providerFlowId);
    };
    const pendingPoll = request(fixtureServer)
      .get(`/api/connectors/flows/${reconnect.body.flowId}`)
      .then((response) => response);
    await pollStarted;
    const disconnected = await request(fixtureServer).delete(
      `/api/connectors/accounts/${connectionId}`
    );
    expect(disconnected.status).toBe(204);
    releasePoll();

    expect((await pendingPoll).status).toBe(404);
    expect(await raw.listAccounts()).toEqual([]);
    expect(registry.accountBinding(connectionId)?.status).toBe('revoked');
  });
});
