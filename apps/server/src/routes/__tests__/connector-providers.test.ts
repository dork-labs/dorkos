import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialStore,
} from '../../services/core/credential-provider.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../../services/connectors/bootstrap.js';
import { NangoProxyMcp } from '../../services/connectors/providers/nango-proxy-mcp.js';
import type { ComposioHttpClient } from '../../services/connectors/providers/composio-client.js';
import type { NangoHttpClient } from '../../services/connectors/providers/nango-client.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../../services/connectors/attachment-store.js';
import { createConnectorProvidersRouter } from '../connector-providers.js';
import { FakeConnectorProvider } from '@dorkos/test-utils';

const SECRET = 'ck-super-secret-composio-key';

/**
 * Hermetic vendor clients for the bootstrapper's connection check — without
 * these the PUT-credential tests would issue a real network request.
 */
const hermeticClients = {
  makeComposioClient: (): ComposioHttpClient => ({
    listToolkits: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnectedAccounts: () => Promise.resolve([]),
    deleteConnectedAccount: () => Promise.resolve(),
    mcpSessionForAccount: () => Promise.resolve(null),
  }),
  makeNangoClient: (): NangoHttpClient => ({
    listIntegrations: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnections: () => Promise.resolve([]),
    deleteConnection: () => Promise.resolve(),
    proxyRequest: () => Promise.resolve({ status: 200, body: '' }),
  }),
};

/** In-memory CredentialStore + CredentialProvider over one shared map. */
function fakeCredentialBackend() {
  const map = new Map<string, string>();
  const store: CredentialStore = {
    put(name, secret) {
      map.set(`file:${name}`, secret);
      return Promise.resolve(`file:${name}`);
    },
    get(name) {
      return Promise.resolve(map.get(`file:${name}`) ?? null);
    },
    delete(name) {
      map.delete(`file:${name}`);
      return Promise.resolve();
    },
  };
  const credentials: CredentialProvider = {
    resolve(ref: string): Promise<CredentialResolution> {
      const secret = map.get(ref);
      if (secret === undefined) {
        return Promise.resolve({ ok: false, reason: 'unresolved', ref, message: 'absent' });
      }
      return Promise.resolve({ ok: true, secret });
    },
  };
  return { store, credentials };
}

describe('connector-providers router', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let store: CredentialStore;
  let credentials: CredentialProvider;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    ({ store, credentials } = fakeCredentialBackend());
  });

  function buildApp(opts?: {
    nangoEnv?: () => { baseUrl?: string; encryptionKey?: string };
    testConnector?: boolean;
  }) {
    const bootstrapper = new ConnectorProviderBootstrapper({
      registry,
      credentials,
      nangoEnv: opts?.nangoEnv ?? (() => ({})),
      nangoProxy: new NangoProxyMcp({ localOrigin: 'http://127.0.0.1:4242' }),
      rawMcpServers: () => [],
      ...hermeticClients,
      ...(opts?.testConnector && { testConnector: { create: async () => null } }),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/connectors/providers',
      createConnectorProvidersRouter({ bootstrapper, credentialStore: store })
    );
    return app;
  }

  it('GET / lists both credential-gated providers, unconfigured on a bare install', async () => {
    const res = await request(buildApp()).get('/api/connectors/providers');
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p: { type: string }) => p.type).sort()).toEqual([
      'composio',
      'nango',
    ]);
    for (const provider of res.body.providers) {
      expect(provider).toMatchObject({ configured: false, registered: false });
      expect(typeof provider.disclosure).toBe('string');
      expect(provider.disclosure.length).toBeGreaterThan(0);
    }
  });

  it('PUT credential stores the key and registers the provider live (no restart)', async () => {
    const app = buildApp();
    expect(registry.resolveProvider('composio')).toBeUndefined();

    const res = await request(app)
      .put('/api/connectors/providers/composio/credential')
      .send({ secret: SECRET });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'composio', configured: true, registered: true });
    // The registry now serves the provider — the same seam a session reads.
    expect(registry.resolveProvider('composio')).toBeDefined();
    // The status list agrees.
    const list = await request(app).get('/api/connectors/providers');
    const composio = list.body.providers.find((p: { type: string }) => p.type === 'composio');
    expect(composio).toMatchObject({ configured: true, registered: true });
  });

  it('DELETE credential unregisters the provider and is idempotent (missing key still 200)', async () => {
    const app = buildApp();
    await request(app)
      .put('/api/connectors/providers/composio/credential')
      .send({ secret: SECRET });
    expect(registry.resolveProvider('composio')).toBeDefined();

    const first = await request(app).delete('/api/connectors/providers/composio/credential');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ type: 'composio', configured: false, registered: false });
    expect(registry.resolveProvider('composio')).toBeUndefined();

    // Deleting again (nothing stored) still answers 200 with the same status.
    const again = await request(app).delete('/api/connectors/providers/composio/credential');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ configured: false, registered: false });
  });

  it('surfaces the Nango configured-but-refused error text on the status', async () => {
    const app = buildApp({ nangoEnv: () => ({ baseUrl: 'http://localhost:3003' }) });

    const res = await request(app)
      .put('/api/connectors/providers/nango/credential')
      .send({ secret: 'sk-nango-secret' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'nango', configured: true, registered: false });
    expect(res.body.error).toMatch(/NANGO_ENCRYPTION_KEY/);
  });

  it('400s an unknown provider and an empty secret (Express 5 empty body)', async () => {
    const app = buildApp();

    const unknown = await request(app)
      .put('/api/connectors/providers/gmail/credential')
      .send({ secret: SECRET });
    expect(unknown.status).toBe(400);

    const emptyBody = await request(app)
      .put('/api/connectors/providers/composio/credential')
      .send();
    expect(emptyBody.status).toBe(400);

    const emptySecret = await request(app)
      .put('/api/connectors/providers/composio/credential')
      .send({ secret: '' });
    expect(emptySecret.status).toBe(400);

    const unknownDelete = await request(app).delete('/api/connectors/providers/gmail/credential');
    expect(unknownDelete.status).toBe(400);
  });

  it('accepts test-connector only when the test-mode spec is wired', async () => {
    const withoutTestMode = await request(buildApp())
      .put(`/api/connectors/providers/${TEST_CONNECTOR_PROVIDER_TYPE}/credential`)
      .send({ secret: 'test-key' });
    expect(withoutTestMode.status).toBe(400);

    const withTestMode = await request(buildApp({ testConnector: true }))
      .put(`/api/connectors/providers/${TEST_CONNECTOR_PROVIDER_TYPE}/credential`)
      .send({ secret: 'test-key' });
    expect(withTestMode.status).toBe(200);
    // The key is stored (configured), the scripted provider arrives with Slice E.
    expect(withTestMode.body).toMatchObject({
      type: TEST_CONNECTOR_PROVIDER_TYPE,
      configured: true,
    });
  });

  it('deleting a credential revokes LIVE sessions: attached accounts stop being exposed', async () => {
    // Full wiring, exactly as boot: bootstrapper + session binder + the
    // unregister hook between them.
    const sessionConnectors = new SessionConnectorService({
      registry,
      agentAttachments: new AgentConnectorAttachmentStore(db),
      sessionAttachments: new SessionConnectorAttachmentStore(db),
    });
    const bootstrapper = new ConnectorProviderBootstrapper({
      registry,
      credentials,
      nangoEnv: () => ({}),
      nangoProxy: new NangoProxyMcp({ localOrigin: 'http://127.0.0.1:4242' }),
      rawMcpServers: () => [],
      ...hermeticClients,
      onUnregistered: (providerType) => sessionConnectors.invalidateProvider(providerType),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/connectors/providers',
      createConnectorProvidersRouter({ bootstrapper, credentialStore: store })
    );

    // Save the key (registers the real provider), then swap a fake in under the
    // same type so the connect flow stays hermetic — no Composio network call.
    await request(app)
      .put('/api/connectors/providers/composio/credential')
      .send({ secret: SECRET });
    expect(registry.resolveProvider('composio')).toBeDefined();
    const provider = new FakeConnectorProvider({ type: 'composio', custody: 'managed' });
    registry.register(provider);
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    const account = (await provider.pollConnect(flowId)).account!;
    registry.recordConnect(account);
    const attached = await sessionConnectors.attach('session-1', account.id);
    expect(attached!.account.exposed).toBe(true);

    // Delete the key: the reload unregisters the provider AND the session's
    // cached exposure is dropped — the account reports unexposed with a
    // warning, and the MCP factory stops injecting its server.
    const res = await request(app).delete('/api/connectors/providers/composio/credential');
    expect(res.status).toBe(200);
    const status = sessionConnectors.status('session-1');
    expect(status.accounts[0]!.exposed).toBe(false);
    expect(status.warnings).toHaveLength(1);
    expect(sessionConnectors.mcpServersForSession('session-1').servers).toEqual({});
  });

  it('never echoes the secret in any response', async () => {
    const app = buildApp({ nangoEnv: () => ({ baseUrl: 'http://localhost:3003' }) });
    const responses = [
      await request(app)
        .put('/api/connectors/providers/composio/credential')
        .send({ secret: SECRET }),
      await request(app).put('/api/connectors/providers/nango/credential').send({ secret: SECRET }),
      await request(app).get('/api/connectors/providers'),
      await request(app).delete('/api/connectors/providers/composio/credential'),
      await request(app).put('/api/connectors/providers/composio/credential').send({ secret: '' }),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(res.text).not.toContain(SECRET);
    }
  });
});
