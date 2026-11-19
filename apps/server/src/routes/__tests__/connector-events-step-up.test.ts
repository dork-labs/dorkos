/**
 * Sending an app's updates to an agent and saving a signing secret wait for the
 * owner to confirm it's them (DOR-4355). Removing a notification stays immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../env.js';
import {
  createConnectorEventsRoutes,
  type ConnectorEventsRouterDeps,
} from '../connector-events.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const PREFIX = '/api/connectors/connections/connection-a/events';
const SIGNING_SECRET = 'whsec_made_up_northwind_secret';
const SUBSCRIPTION = {
  id: 'subscription-a',
  connectionId: 'connection-a',
  definitionId: 'definition-a',
  eventType: 'GMAIL_NEW_MESSAGE',
  displayName: 'New message',
  deliveryMode: 'polling',
  expectedCadenceSeconds: null,
  agentId: 'agent-a',
  destination: { kind: 'agent', id: 'agent-a' },
  filter: {},
  scopeVersion: 1,
  state: 'active',
  lastDelivery: null,
  chatSessionId: null,
};
const CREATE = {
  requestId: '6be1ef29-aa17-4050-8c29-dcb235c1c372',
  definitionId: 'definition-a',
  filter: {},
  agentId: 'agent-a',
  destination: { kind: 'agent', id: 'agent-a' },
};

describe('notification confirmation', () => {
  const store = {
    get: vi.fn(() => SUBSCRIPTION),
    list: vi.fn(),
    connection: vi.fn(() => ({ providerInstanceId: 'provider-a', mode: 'byo' })),
  };
  const grants = {
    approve: vi.fn(async () => ({
      state: 'ready',
      selections: [{ subscriptionId: 'subscription-a' }],
    })),
  };
  const settings = {
    describe: vi.fn(),
    configure: vi.fn(async () => ({
      setupMode: 'byo_webhook',
      configured: true,
      endpoint: 'https://northwind.example.test/api/connectors/webhooks/provider-a',
      reason: null,
    })),
  };
  const subscriptions = { discover: vi.fn(), remove: vi.fn(async () => undefined) };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/connectors',
      routes: createConnectorEventsRoutes({
        store,
        subscriptions,
        grants,
        settings,
        managed: { reconcile: vi.fn(async () => false) },
        resolveOwner: () => OWNER,
        loginEnabled: () => true,
        trustedOrigins: () => [ORIGIN],
      } as unknown as ConnectorEventsRouterDeps),
    },
  ]);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds sending updates to an agent until the owner confirms', async () => {
    const held = await owner.call('post', `${PREFIX}/subscriptions`, 'own-tunnel').send(CREATE);
    expect(held.status).toBe(428);
    expect(grants.approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(grants.approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 201,
      result: { id: 'subscription-a', state: 'active' },
    });
    expect(grants.approve).toHaveBeenCalledOnce();
  });

  it('answers a held one that no longer fits in its own words', async () => {
    grants.approve.mockResolvedValueOnce({ state: 'unavailable', selections: [] });
    const held = await owner.call('post', `${PREFIX}/subscriptions`, 'own-tunnel').send(CREATE);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 409,
      result: { code: 'definition_changed' },
    });
  });

  it('holds a signing secret, and never puts it in what it holds', async () => {
    const held = await owner
      .call('put', `${PREFIX}/source`, 'own-tunnel')
      .send({ publicOrigin: 'https://northwind.example.test', webhookSecret: SIGNING_SECRET });
    expect(held.status).toBe(428);
    expect(JSON.stringify(held.body)).not.toContain(SIGNING_SECRET);
    expect(settings.configure).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(settings.configure).not.toHaveBeenCalled();
    const confirmed = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(confirmed.body).toMatchObject({ ok: true, status: 200, result: { configured: true } });
    expect(JSON.stringify(confirmed.body)).not.toContain(SIGNING_SECRET);
    expect(settings.configure).toHaveBeenCalledExactlyOnceWith(OWNER, 'provider-a', {
      publicOrigin: 'https://northwind.example.test',
      webhookSecret: SIGNING_SECRET,
    });
  });

  it('keeps both refused from Wi-Fi', async () => {
    const created = await owner.call('post', `${PREFIX}/subscriptions`, 'wifi').send(CREATE);
    const saved = await owner
      .call('put', `${PREFIX}/source`, 'wifi')
      .send({ publicOrigin: 'https://northwind.example.test', webhookSecret: SIGNING_SECRET });
    for (const res of [created, saved]) {
      expect(res.status).toBe(403);
      expect(res.body.heldActionId).toBeUndefined();
    }
    expect(grants.approve).not.toHaveBeenCalled();
    expect(settings.configure).not.toHaveBeenCalled();
  });

  it('removes a notification at once', async () => {
    const res = await owner.call('delete', `${PREFIX}/subscriptions/subscription-a`, 'own-tunnel');
    expect(res.status).toBe(204);
    expect(subscriptions.remove).toHaveBeenCalledOnce();
  });
});
