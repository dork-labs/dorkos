import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectorCapabilities,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectedAccountId,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';
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

/** A relay catalog with a purpose-built adapter only for the given slugs. */
function relayWith(slugs: Record<string, string>): RelayAdapterCatalog {
  return {
    getManifest: (type: string) => (slugs[type] ? { displayName: slugs[type] } : undefined),
  };
}

/** A gateway provider whose `listToolkits` never resolves — the hung-provider case. */
class HungProvider implements ConnectorProvider {
  readonly type = 'hung';
  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
      features: {},
    };
  }
  listToolkits(): Promise<ConnectorToolkit[]> {
    return new Promise<ConnectorToolkit[]>(() => {});
  }
  startConnect(): Promise<ConnectStart> {
    return Promise.reject(new Error('hung'));
  }
  pollConnect(): Promise<ConnectPoll> {
    return Promise.resolve({ status: 'failed', error: 'hung' });
  }
  listAccounts(): Promise<ConnectedAccount[]> {
    return Promise.resolve([]);
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  toolServerForAccount() {
    return Promise.resolve(null);
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
          sessionAttachments: new SessionConnectorAttachmentStore(db),
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
          sessionAttachments: new SessionConnectorAttachmentStore(db),
        }),
      })
    );

    const res = await request(app).get('/api/connectors/toolkits');
    expect(res.status).toBe(200);
    expect(res.body.toolkits).toEqual([]);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ provider: 'hung' });
    expect(res.body.warnings[0].message).toMatch(/401/);
  });

  it('GET /recommend 400s without a service param', async () => {
    const res = await request(buildApp()).get('/api/connectors/recommend');
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
          sessionAttachments: new SessionConnectorAttachmentStore(db),
        }),
      })
    );

    const start = Date.now();
    const res = await request(app).get('/api/connectors/recommend?service=gmail');
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
    const start = await request(app)
      .post('/api/connectors/composio/connect')
      .send({ toolkit: 'gmail', label: 'personal' });
    expect(start.status).toBe(200);
    expect(start.body.flowId).toBeTruthy();
    expect(start.body.authorizeUrl).toContain('gmail');
    // The custody sentence rides the start response so the client can render it
    // BEFORE opening the auth URL — server-owned copy, exactly the module's.
    expect(start.body.disclosure).toBe(custodyDisclosure('managed', { service: 'gmail' }));

    const poll = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('connected');
    expect(poll.body.account.toolkit).toBe('gmail');
    // Publicized before it crosses out: provider stripped, disclosure attached.
    expect(poll.body.account.provider).toBeUndefined();
    expect(Object.keys(poll.body.account)).not.toContain('provider');
    expect(poll.body.account.disclosure).toBe(
      custodyDisclosure('managed', { service: 'personal' })
    );
  });

  it('GET /flows/:flowId replays a terminal raw MCP result through the provider that started it', async () => {
    registry.unregister('composio');
    const original = new RawMcpConnectorProvider({
      servers: [
        {
          slug: 'notes',
          displayName: 'Notes',
          connection: { transport: 'http', url: 'https://mcp.notes.example/mcp' },
        },
      ],
      probe: () => Promise.resolve({ kind: 'ok', toolCount: 1 }),
    });
    registry.register(original);
    const flowBindings = new ConnectorFlowBindings();
    const app = buildApp(undefined, flowBindings);

    const start = await request(app).post('/api/connectors/mcp/connect').send({ toolkit: 'notes' });
    // A config reload may register another instance of the same provider type.
    // The already-started flow still belongs to the instance that holds its
    // auth/verification state; routing by type would send this poll elsewhere.
    registry.register(
      new RawMcpConnectorProvider({
        servers: [
          {
            slug: 'notes',
            displayName: 'Notes',
            connection: { transport: 'http', url: 'https://replacement.invalid/mcp' },
          },
        ],
        probe: () => Promise.resolve({ kind: 'failed', error: 'replacement must not be polled' }),
      })
    );

    const first = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('connected');
    const repeated = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(first.body);
  });

  it('keeps provider-local flow id collisions isolated behind public flow ids', async () => {
    const firstProvider = new FakeConnectorProvider({ type: 'first', custody: 'managed' });
    const secondProvider = new FakeConnectorProvider({ type: 'second', custody: 'self-host' });
    const providerFlowId = 'provider-local-flow-1';
    vi.spyOn(firstProvider, 'startConnect').mockResolvedValue({ flowId: providerFlowId });
    vi.spyOn(secondProvider, 'startConnect').mockResolvedValue({ flowId: providerFlowId });
    const firstPoll = vi.spyOn(firstProvider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        id: 'first:account' as ConnectedAccountId,
        provider: 'first',
        toolkit: 'gmail',
        label: 'first',
        status: 'active',
        custody: 'managed',
      },
    });
    const secondPoll = vi.spyOn(secondProvider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        id: 'second:account' as ConnectedAccountId,
        provider: 'second',
        toolkit: 'slack',
        label: 'second',
        status: 'active',
        custody: 'self-host',
      },
    });
    registry.register(firstProvider);
    registry.register(secondProvider);
    const app = buildApp();

    const firstStart = await request(app)
      .post('/api/connectors/first/connect')
      .send({ toolkit: 'gmail' });
    const secondStart = await request(app)
      .post('/api/connectors/second/connect')
      .send({ toolkit: 'slack' });
    const first = await request(app).get(`/api/connectors/flows/${firstStart.body.flowId}`);
    const second = await request(app).get(`/api/connectors/flows/${secondStart.body.flowId}`);

    expect(first.body.account.id).toBe('first:account');
    expect(second.body.account.id).toBe('second:account');
    expect(firstStart.body.flowId).not.toBe(secondStart.body.flowId);
    expect(firstStart.body.flowId).not.toBe(providerFlowId);
    expect(firstPoll).toHaveBeenCalledWith(providerFlowId);
    expect(secondPoll).toHaveBeenCalledWith(providerFlowId);
  });

  it('bounds abandoned flow bindings while keeping recent flows pollable', async () => {
    const flowBindings = new ConnectorFlowBindings({ maxEntries: 2 });
    const app = buildApp(undefined, flowBindings);
    const flowIds: string[] = [];

    for (const toolkit of ['gmail', 'slack', 'gmail']) {
      const start = await request(app).post('/api/connectors/composio/connect').send({ toolkit });
      flowIds.push(start.body.flowId);
    }

    const evicted = await request(app).get(`/api/connectors/flows/${flowIds[0]}`);
    expect(evicted.status).toBe(404);
    for (const flowId of flowIds.slice(1)) {
      const retained = await request(app).get(`/api/connectors/flows/${flowId}`);
      expect(retained.status).toBe(200);
      expect(retained.body.status).toBe('connected');
    }
  });

  it('pins an in-flight raw MCP poll so capacity cannot hide its connected account', async () => {
    let finishProbe: ((outcome: { kind: 'ok'; toolCount: number }) => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<{ kind: 'ok'; toolCount: number }>((resolve) => {
          finishProbe = resolve;
        })
    );
    registry.unregister('composio');
    const provider = new RawMcpConnectorProvider({
      servers: [
        {
          slug: 'notes',
          displayName: 'Notes',
          connection: { transport: 'http', url: 'https://mcp.notes.example/mcp' },
        },
      ],
      probe,
    });
    registry.register(provider);
    const app = buildApp(undefined, new ConnectorFlowBindings({ maxEntries: 1 }));

    const first = await request(app).post('/api/connectors/mcp/connect').send({ toolkit: 'notes' });
    const latePoll = request(app)
      .get(`/api/connectors/flows/${first.body.flowId}`)
      .then((res) => res);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    // Capacity cannot evict work that is already on the wire. Rejecting this
    // start is honest: the first poll remains observable through both its flow
    // response and the account inventory after the probe succeeds.
    const second = await request(app)
      .post('/api/connectors/mcp/connect')
      .send({ toolkit: 'notes' });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe(
      'Too many connection checks are already in progress. Wait for one to finish and try again.'
    );

    finishProbe?.({ kind: 'ok', toolCount: 1 });
    const late = await latePoll;
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({
      status: 'connected',
      account: { id: 'mcp:notes', toolkit: 'notes', status: 'active' },
    });
    expect(registry.accountBinding('mcp:notes' as ConnectedAccountId)).toMatchObject({
      accountId: 'mcp:notes',
      provider: 'mcp',
      toolkit: 'notes',
      status: 'active',
    });

    const accounts = await request(app).get('/api/connectors/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toEqual([
      expect.objectContaining({ id: 'mcp:notes', toolkit: 'notes', status: 'active' }),
    ]);
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
    // Every listed account carries its own server-composed custody sentence —
    // the client never composes disclosure copy (spec §UX).
    expect(account.disclosure).toBe(custodyDisclosure('managed', { service: 'personal' }));
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

    // The terminal flow must no longer replay a connected result after its
    // account is revoked, or the poll route would recreate the routing row.
    const stalePoll = await request(app).get(`/api/connectors/flows/${start.body.flowId}`);
    expect(stalePoll.status).toBe(404);
    expect(registry.accountBinding(accountId)).toMatchObject({
      provider: 'composio',
      status: 'revoked',
    });

    // Deleting an unknown/already-removed id still resolves 204.
    const again = await request(app).delete('/api/connectors/accounts/never-existed');
    expect(again.status).toBe(204);
  });

  it('cancels an in-flight raw MCP reconnect when its stable account id is deleted again', async () => {
    let finishReconnect: ((outcome: { kind: 'ok'; toolCount: number }) => void) | undefined;
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok', toolCount: 1 })
      .mockImplementationOnce(
        () =>
          new Promise<{ kind: 'ok'; toolCount: number }>((resolve) => {
            finishReconnect = resolve;
          })
      );
    registry.unregister('composio');
    const provider = new RawMcpConnectorProvider({
      servers: [
        {
          slug: 'notes',
          displayName: 'Notes',
          connection: { transport: 'http', url: 'https://mcp.notes.example/mcp' },
        },
      ],
      probe,
    });
    registry.register(provider);
    const app = buildApp();

    const initialStart = await request(app)
      .post('/api/connectors/mcp/connect')
      .send({ toolkit: 'notes' });
    const initialPoll = await request(app).get(`/api/connectors/flows/${initialStart.body.flowId}`);
    expect(initialPoll.body.status).toBe('connected');
    await request(app).delete('/api/connectors/accounts/mcp%3Anotes').expect(204);

    const reconnect = await request(app)
      .post('/api/connectors/mcp/connect')
      .send({ toolkit: 'notes' });
    const latePoll = request(app)
      .get(`/api/connectors/flows/${reconnect.body.flowId}`)
      .then((res) => res);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    // A config reload may replace the registered provider while the older
    // instance still owns this reconnect. Delete must reach both.
    registry.register(
      new RawMcpConnectorProvider({
        servers: [
          {
            slug: 'notes',
            displayName: 'Notes',
            connection: { transport: 'http', url: 'https://replacement.invalid/mcp' },
          },
        ],
        probe: () => Promise.resolve({ kind: 'failed', error: 'replacement is not the owner' }),
      })
    );

    // No routing row exists yet, but the stable raw-MCP account id still names
    // the reconnect that the person is revoking.
    await request(app).delete('/api/connectors/accounts/mcp%3Anotes').expect(204);
    finishReconnect?.({ kind: 'ok', toolCount: 1 });

    const late = await latePoll;
    expect(late.status).toBe(200);
    expect(late.body).toEqual({
      status: 'failed',
      error: 'This connection check is no longer active. Start again to retry.',
    });
    expect(registry.accountBinding('mcp:notes' as ConnectedAccountId)).toMatchObject({
      provider: 'mcp',
      status: 'revoked',
    });
    await expect(provider.listAccounts()).resolves.toEqual([]);
    const accounts = await request(app).get('/api/connectors/accounts');
    expect(accounts.body.accounts).toEqual([]);
  });
});
