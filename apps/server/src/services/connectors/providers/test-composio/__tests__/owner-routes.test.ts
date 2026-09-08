import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, connectorEventInbox } from '@dorkos/db';
import { startTestComposioFixture } from '../fixture.js';
import { COMPOSIO_FIXTURE_KEY, COMPOSIO_FIXTURE_WEBHOOK_SECRET } from '../data.js';
import {
  EncryptedFileCredentialStore,
  type CredentialProvider,
} from '../../../../core/credential-provider.js';
import { ConnectorRegistry } from '../../../registry.js';
import { ConnectorProviderBootstrapper } from '../../../bootstrap.js';
import { legacyDefaultProviderInstanceId } from '../../../legacy-connection-migration.js';
import { ConnectorAuthenticationFlowService } from '../../../resources/authentication-flow-service.js';
import { ConnectorOperatorQueryService } from '../../../resources/operator-query-service.js';
import { ConnectorLifecycleService } from '../../../resources/lifecycle-service.js';
import { ConnectorEventSettingsService } from '../../../events/settings-service.js';
import { ConnectorSubscriptionStore } from '../../../events/subscription-store.js';
import { ConnectorSubscriptionService } from '../../../events/subscription-service.js';
import { ConnectorEventGrantService } from '../../../events/grant-service.js';
import { ConnectorEventInboxStore } from '../../../event-inbox-store.js';
import { ConnectorEventIngressService } from '../../../events/ingress-service.js';
import { createConnectorSignedIngress } from '../../../events/signed-ingress.js';
import { createConnectorEventsRouter } from '../../../../../routes/connector-events.js';
import { createConnectorResourcesRouter } from '../../../../../routes/connector-resources.js';
import { createConnectorProvidersRouter } from '../../../../../routes/connector-providers.js';

const owner = { kind: 'local_install', installationId: 'offline-owner' } as const;
const providerId = legacyDefaultProviderInstanceId('composio');
const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dork-offline-composio-'));
  const db = createDb(':memory:');
  runMigrations(db);
  disposers.push(() => {
    db.$client.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const secrets = new EncryptedFileCredentialStore(dir);
  const credentials: CredentialProvider = {
    async resolve(ref) {
      const secret = await secrets.get(ref.slice(5));
      return secret
        ? { ok: true, secret }
        : { ok: false, ref, reason: 'unresolved', message: 'Absent' };
    },
  };
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: owner.kind, ownerId: owner.installationId },
  });
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  disposers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const upstream = await startTestComposioFixture({ testRuntime: true, localOrigin: origin });
  disposers.push(upstream.close);
  const settings = new ConnectorEventSettingsService(db, credentials, secrets, async () => {
    await bootstrap.reload('composio');
  });
  const bootstrap = new ConnectorProviderBootstrapper({
    rawMcpPendingConnect: () => undefined,
    registry,
    credentials,
    composioBaseUrl: upstream.baseUrl,
    composioWebhookSecretRef: () => settings.webhookSecretRef(providerId),
    nangoEnv: () => ({}),
    rawMcpServers: () => [],
  });
  await bootstrap.registerBootProviders();
  const authentication = new ConnectorAuthenticationFlowService({ db, registry });
  const query = new ConnectorOperatorQueryService({
    db,
    registry,
    agentOwnership: { ownsAgent: () => true },
    sessions: { resolveSessionAgent: () => undefined },
  });
  const lifecycle = new ConnectorLifecycleService({
    db,
    registry,
    authenticationFlows: authentication,
    authorityCleanup: { revokeAgent() {}, revokeAgentConnection() {}, revokeConnection() {} },
  });
  const boundary = {
    resolveOwner: () => owner,
    loginEnabled: () => false,
    trustedOrigins: () => [origin],
  };
  const store = new ConnectorSubscriptionStore(db);
  const destinations = {
    authorize: (_owner: unknown, agentId: string) => agentId === 'agent-fixture',
  };
  const subscriptions = new ConnectorSubscriptionService(store, registry, destinations);
  const managed = { reconcile: async () => false, ready: () => false };
  const grants = new ConnectorEventGrantService(store, subscriptions, destinations, managed);
  const inbox = new ConnectorEventInboxStore({ db });
  const ingress = new ConnectorEventIngressService(store, inbox, settings);
  app.post(
    '/api/connectors/webhooks/:providerInstanceId',
    ...createConnectorSignedIngress({
      verifier: (id) => registry.resolveProviderInstance(id as never)?.events,
      accept: (id, event) => ingress.accept(id, event),
    })
  );
  app.use(express.json());
  app.use('/api/test/composio', upstream.router);
  app.use(
    '/api/connectors/providers',
    createConnectorProvidersRouter({ bootstrapper: bootstrap, credentialStore: secrets })
  );
  app.use(
    '/api/connectors',
    createConnectorResourcesRouter({ ...boundary, authentication, query, lifecycle })
  );
  app.use(
    '/api/connectors',
    createConnectorEventsRouter({ ...boundary, store, subscriptions, grants, settings, managed })
  );
  const call = (path: string, method = 'GET', body?: unknown, headers = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { origin, 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, db, grants, registry, bootstrap, store };
}

describe('offline Composio through real owner and signed ingress routes', () => {
  it('requires source setup and explicit receive consent, recovers the same pending selection, dedupes, and revokes', async () => {
    const f = await fixture();
    expect(
      (
        await f.call('/api/connectors/providers/composio/credential', 'PUT', {
          secret: COMPOSIO_FIXTURE_KEY,
        })
      ).status
    ).toBe(200);
    const ids: string[] = [];
    for (const label of ['Work Gmail', 'Personal Gmail']) {
      const started = await f.call('/api/connectors/connections', 'POST', {
        providerInstanceId: providerId,
        toolkit: 'gmail',
        label,
        idempotencyKey: randomUUID(),
      });
      expect(started.status).toBe(201);
      const flow = await started.json();
      expect(flow.state).toBe('pending');
      expect((await fetch(flow.authorizeUrl, { method: 'POST' })).status).toBe(200);
      const completed = await (
        await f.call(`/api/connectors/authentication-flows/${flow.flowId}`)
      ).json();
      expect(completed.state).toBe('connected');
      ids.push(completed.connectionId);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const prefix = `/api/connectors/connections/${ids[0]}/events`;
    expect(await (await f.call(`${prefix}/source`)).json()).toMatchObject({
      setupMode: 'byo_webhook',
      configured: false,
    });
    expect(
      (
        await f.call(
          `${prefix}/source`,
          'PUT',
          {
            publicOrigin: 'https://offline-events.example',
            webhookSecret: COMPOSIO_FIXTURE_WEBHOOK_SECRET,
          },
          { authorization: 'Bearer program' }
        )
      ).status
    ).toBe(403);
    const setup = await f.call(`${prefix}/source`, 'PUT', {
      publicOrigin: 'https://offline-events.example',
      webhookSecret: COMPOSIO_FIXTURE_WEBHOOK_SECRET,
    });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toMatchObject({ setupMode: 'byo_webhook', configured: true });
    const discovered = await (await f.call(`${prefix}/definitions`)).json();
    expect(discovered.definitions).toHaveLength(3);
    expect(discovered.definitions[1]).toMatchObject({ deliveryMode: 'unknown' });
    const body = {
      manageExistingTrigger: false,
      definitionId: discovered.definitions[0].id,
      filter: { label: 'INBOX' },
      agentId: 'agent-fixture',
      destination: { kind: 'agent', id: 'agent-fixture' },
      requestId: randomUUID(),
    };
    expect(
      (await f.call(`${prefix}/subscriptions`, 'POST', body, { authorization: 'Bearer program' }))
        .status
    ).toBe(403);
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(0);
    // A signed pre-existing vendor trigger is not DorkOS receive consent.
    const currentProvider = f.registry.resolveProviderInstance(providerId as never)!;
    const definitionPage = await currentProvider.events!.listDefinitions({
      toolkit: 'gmail',
      toolkitVersion: '20260901_00',
      limit: 100,
      signal: AbortSignal.timeout(5_000),
    });
    const account = f.store.connection(owner, ids[0]!);
    expect(
      await currentProvider.events!.createTrigger({
        definition: definitionPage.definitions[0]!,
        externalAccountRef: account.externalAccountRef,
        filter: body.filter,
        signal: AbortSignal.timeout(5_000),
        authorizeDispatch: async () => true,
      })
    ).toMatchObject({ status: 'ready' });
    expect(
      await (
        await f.call('/api/test/composio/emit', 'POST', {
          accountOrdinal: 1,
          eventType: 'GMAIL_NEW_MESSAGE',
          eventId: 'before_consent',
          signature: 'valid',
        })
      ).json()
    ).toMatchObject({ status: 403 });
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(0);
    await f.call('/api/test/composio/events-state', 'POST', { mode: 'unavailable' });
    const pendingResponse = await f.call(`${prefix}/subscriptions`, 'POST', body);
    expect(pendingResponse.status).toBe(202);
    const pending = await pendingResponse.json();
    expect(pending.state).toBe('pending');
    await f.call('/api/test/composio/events-state', 'POST', { mode: 'ready' });
    // Invoke the same production maintenance method; the browser waits for its real interval.
    expect(await f.grants.recoverPending(AbortSignal.timeout(5_000))).toMatchObject({ ready: 1 });
    const page = await (await f.call(`${prefix}/subscriptions`)).json();
    expect(page.subscriptions).toMatchObject([{ id: pending.id, state: 'active' }]);
    const unknown = await f.call(`${prefix}/subscriptions`, 'POST', {
      ...body,
      definitionId: discovered.definitions[1].id,
      requestId: randomUUID(),
    });
    expect(unknown.status).toBe(201);
    expect(await unknown.json()).toMatchObject({ deliveryMode: 'unknown', state: 'active' });
    const unsupported = await f.call(`${prefix}/subscriptions`, 'POST', {
      ...body,
      definitionId: discovered.definitions[2].id,
      filter: { arbitrary: 42 },
      requestId: randomUUID(),
    });
    expect(unsupported.status).toBe(400);
    const emit = {
      accountOrdinal: 1,
      eventType: 'GMAIL_NEW_MESSAGE',
      eventId: 'owner_offline_event',
      signature: 'valid',
    };
    for (let index = 0; index < 2; index++)
      expect(await (await f.call('/api/test/composio/emit', 'POST', emit)).json()).toMatchObject({
        status: 202,
      });
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(1);
    const stored = f.db.select().from(connectorEventInbox).get()!;
    expect(stored.normalizedPayload).not.toContain('owner_offline_event');
    expect(
      await (
        await f.call('/api/test/composio/emit', 'POST', { ...emit, signature: 'invalid' })
      ).json()
    ).toMatchObject({ status: 401 });
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(1);
    expect((await f.call(`${prefix}/subscriptions/${pending.id}`, 'DELETE')).status).toBe(204);
    // A fresh event cannot enter after local receive authority closes, even if upstream cleanup remains pending.
    const after = await f.call('/api/test/composio/emit', 'POST', {
      ...emit,
      eventId: 'after_revoke',
    });
    const result = await after.json();
    expect(after.status).toBe(200);
    expect(result).toMatchObject({ status: 403 });
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(1);
  });
});
