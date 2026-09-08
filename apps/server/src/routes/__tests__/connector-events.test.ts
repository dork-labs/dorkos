import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, connectorProviderInstances, connections } from '@dorkos/db';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import { createConnectorEventsRouter } from '../connector-events.js';
import { ConnectorSubscriptionStore } from '../../services/connectors/events/subscription-store.js';
import { ConnectorSubscriptionService } from '../../services/connectors/events/subscription-service.js';
import { ConnectorEventGrantService } from '../../services/connectors/events/grant-service.js';

const owner = { kind: 'local_install', installationId: 'event-route-owner' } as const;
const now = '2026-09-07T12:00:00.000Z';
const target = swappableServer();
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
function fixture(options: { login?: boolean; denyDestination?: boolean } = {}) {
  const db = createDb(':memory:');
  runMigrations(db);
  disposers.push(() => db.$client.close());
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-a',
      type: 'test',
      mode: 'byo',
      displayName: 'Test',
      custody: 'self-host',
      capabilityJson: '{}',
      status: 'available',
      ownerKind: owner.kind,
      ownerId: owner.installationId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(connections)
    .values({
      id: 'account-a',
      providerInstanceId: 'provider-a',
      externalAccountRef: 'private-account',
      toolkit: 'gmail',
      label: 'Work',
      status: 'active',
      enabled: true,
      lifecycleState: 'connected',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const definition: ConnectorEventDefinition = {
    eventType: 'GMAIL_NEW_MESSAGE',
    displayName: 'New message',
    toolkit: 'gmail',
    toolkitVersion: 'v1',
    definitionHash: `sha256:${'a'.repeat(64)}`,
    filterSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: {},
    deliveryMode: 'polling',
    expectedCadenceSeconds: null,
  };
  const discover = vi.fn(async () => ({ status: 'ok', definitions: [definition] }));
  const reconcile = vi.fn<ConnectorEventCapability['reconcileTrigger']>(async () => ({
    status: 'found',
    trigger: {
      providerTriggerRef: 'private-trigger',
      externalAccountRef: 'private-account',
      enabled: true,
    },
  }));
  const provider = {
    resolveToolkitVersion: async () => ({ status: 'ok', toolkitVersion: 'v1' }),
    events: { listDefinitions: discover, reconcileTrigger: reconcile },
  } as unknown as ConnectorProvider;
  const store = new ConnectorSubscriptionStore(db);
  const destinations = { authorize: () => !options.denyDestination };
  const subscriptions = new ConnectorSubscriptionService(
    store,
    { resolveProviderInstance: () => provider },
    destinations,
    () => now
  );
  const managed = { reconcile: vi.fn(async () => false), ready: () => false };
  const grants = new ConnectorEventGrantService(
    store,
    subscriptions,
    destinations,
    managed,
    () => now
  );
  const settings = {
    describe: vi.fn(() => ({
      setupMode: 'byo_webhook' as const,
      configured: false,
      endpoint: null,
      reason: null,
    })),
    configure: vi.fn(async () => ({
      setupMode: 'byo_webhook' as const,
      reason: null,
      configured: true,
      endpoint: 'https://instance.example/api/connectors/webhooks/provider-a',
    })),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/connectors',
    createConnectorEventsRouter({
      store,
      subscriptions,
      grants,
      managed,
      settings,
      resolveOwner: () => owner,
      loginEnabled: () => options.login ?? false,
      trustedOrigins: () => ['http://localhost:4241'],
    })
  );
  target.mount(app);
  return {
    db,
    store,
    settings,
    discover,
    reconcile,
    reconstruct: () => {
      const restored = new ConnectorSubscriptionStore(db);
      return new ConnectorEventGrantService(
        restored,
        new ConnectorSubscriptionService(
          restored,
          { resolveProviderInstance: () => provider },
          destinations,
          () => now
        ),
        destinations,
        managed,
        () => now
      );
    },
  };
}
const prefix = '/api/connectors/connections/account-a/events';
async function creation() {
  const page = await request(target.server).get(`${prefix}/definitions`);
  expect(page.status).toBe(200);
  return {
    definitionId: page.body.definitions[0].id,
    filter: {},
    agentId: 'agent-a',
    destination: { kind: 'agent', id: 'agent-a' },
    requestId: '6be1ef29-aa17-4050-8c29-dcb235c1c372',
  };
}
describe('owner notification HTTP boundary', () => {
  it('finishes a pending owner-created subscription after provider recovery and service restart', async () => {
    const f = fixture();
    const body = await creation();
    f.reconcile.mockResolvedValueOnce({ status: 'unavailable' });
    const created = await request(target.server).post(`${prefix}/subscriptions`).send(body);
    expect(created.status).toBe(202);
    expect(created.body.state).toBe('pending');
    expect(
      (await request(target.server).get(`${prefix}/subscriptions`)).body.subscriptions[0].state
    ).toBe('pending');
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.reconstruct().recoverPending(new AbortController().signal, 1);
    expect(
      (await request(target.server).get(`${prefix}/subscriptions`)).body.subscriptions[0]
    ).toMatchObject({ id: created.body.id, state: 'active' });
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 1 });
  });

  it('discovers, explicitly creates, lists and revokes exact receive consent without leaking private identifiers', async () => {
    const f = fixture();
    const body = await creation();
    const created = await request(target.server).post(`${prefix}/subscriptions`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('active');
    expect(JSON.stringify(created.body)).not.toMatch(
      /private-trigger|private-account|providerDefinitionRef/
    );
    expect((await request(target.server).post(`${prefix}/subscriptions`).send(body)).body).toEqual(
      created.body
    );
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(
      (await request(target.server).get(`${prefix}/subscriptions`)).body.subscriptions
    ).toHaveLength(1);
    expect(
      (await request(target.server).delete(`${prefix}/subscriptions/${created.body.id}`)).status
    ).toBe(204);
    expect((await request(target.server).post(`${prefix}/subscriptions`).send(body)).status).toBe(
      409
    );
    expect(
      (await request(target.server).get(`${prefix}/subscriptions`)).body.subscriptions[0].state
    ).toBe('revoked');
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });
  it.each([
    { authorization: 'Bearer synthetic' },
    { 'x-dorkos-agent': 'agent-a' },
    { origin: 'https://evil.example' },
  ])('refuses machine or foreign-origin consent before discovery: %j', async (headers) => {
    const f = fixture();
    expect((await request(target.server).get(`${prefix}/definitions`).set(headers)).status).toBe(
      403
    );
    expect(f.discover).not.toHaveBeenCalled();
  });
  it('requires the operator cookie while login is enabled', async () => {
    const f = fixture({ login: true });
    expect((await request(target.server).get(`${prefix}/subscriptions`)).status).toBe(403);
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 0 });
  });
  it('rejects agent-selected private identity and unavailable destinations before upstream mutation', async () => {
    const f = fixture({ denyDestination: true });
    const body = await creation();
    expect(
      (
        await request(target.server)
          .post(`${prefix}/subscriptions`)
          .send({ ...body, hostedDefinitionId: 'private' })
      ).status
    ).toBe(400);
    expect((await request(target.server).post(`${prefix}/subscriptions`).send(body)).status).toBe(
      409
    );
    expect(f.reconcile).not.toHaveBeenCalled();
  });
  it('does not let a subscription ID escape its connection path or let a request ID change consent', async () => {
    const f = fixture();
    const body = await creation();
    const created = await request(target.server).post(`${prefix}/subscriptions`).send(body);
    expect(
      (
        await request(target.server).delete(
          `/api/connectors/connections/another/events/subscriptions/${created.body.id}`
        )
      ).status
    ).toBe(404);
    expect(
      (
        await request(target.server)
          .post(`${prefix}/subscriptions`)
          .send({ ...body, destination: { kind: 'room', id: 'other-room' } })
      ).status
    ).toBe(409);
    expect(f.store.active(created.body.id)).toBeDefined();
  });
  it('keeps signing input write-only and does not return service exceptions', async () => {
    const f = fixture();
    const body = {
      publicOrigin: 'https://instance.example',
      webhookSecret: 'synthetic-signing-sentinel',
    };
    const saved = await request(target.server).put(`${prefix}/source`).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      setupMode: 'byo_webhook' as const,
      reason: null,
      configured: true,
      endpoint: 'https://instance.example/api/connectors/webhooks/provider-a',
    });
    expect(f.settings.configure).toHaveBeenCalledWith(owner, 'provider-a', body);
    f.settings.configure.mockRejectedValue(new Error(body.webhookSecret));
    const failure = await request(target.server).put(`${prefix}/source`).send(body);
    expect(failure.status).toBe(503);
    expect(JSON.stringify(failure.body)).not.toContain(body.webhookSecret);
  });
});
