/**
 * Connecting an account, signing one back in and turning one back on wait for
 * the owner to confirm it's them (DOR-4355). Pausing one stays immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { env } from '../../env.js';
import {
  createConnectorResourcesRoutes,
  type ConnectorResourcesRouterDeps,
} from '../connector-resources.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const CONNECTION = '/api/connectors/connections/connection-a';

describe('connection confirmation', () => {
  const authentication = {
    start: vi.fn(async () => ({ flowId: 'flow-a', state: 'pending' })),
    reconnect: vi.fn(async () => ({ flowId: 'flow-b', state: 'pending' })),
    poll: vi.fn(),
  };
  const lifecycle = {
    rename: vi.fn(),
    pause: vi.fn(async () => ({ connectionId: 'connection-a', lifecycle: 'paused' })),
    resume: vi.fn(async () => ({ connectionId: 'connection-a', lifecycle: 'connected' })),
    disconnect: vi.fn(),
    remove: vi.fn(),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/connectors',
      routes: createConnectorResourcesRoutes({
        resolveOwner: () => OWNER,
        loginEnabled: () => true,
        trustedOrigins: () => [ORIGIN],
        servedOrigins: () => [ORIGIN],
        query: {},
        logos: { get: vi.fn() },
        authentication,
        lifecycle,
        actions: { list: vi.fn() },
        signIns: { refreshOnDemand: vi.fn() },
        sessionAccess: { setAccess: vi.fn() },
      } as unknown as ConnectorResourcesRouterDeps),
    },
  ]);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const raises: [string, string, object, Mock, number][] = [
    [
      'connecting an account',
      '/api/connectors/connections',
      { providerInstanceId: 'provider-a', toolkit: 'gmail', idempotencyKey: 'connect-a' },
      authentication.start,
      201,
    ],
    [
      'signing one back in',
      `${CONNECTION}/reconnect`,
      { idempotencyKey: 'reconnect-a' },
      authentication.reconnect,
      201,
    ],
    ['turning one back on', `${CONNECTION}/resume`, {}, lifecycle.resume, 200],
  ];

  it.each(raises)('holds %s until the owner confirms', async (_name, url, body, write, status) => {
    const held = await owner.call('post', url, 'own-tunnel').send(body);
    expect(held.status).toBe(428);
    expect(write).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(write).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status,
    });
    expect(write).toHaveBeenCalledOnce();
  });

  it('keeps connecting an account from Wi-Fi refused', async () => {
    const res = await owner
      .call('post', '/api/connectors/connections', 'wifi')
      .send({ providerInstanceId: 'provider-a', toolkit: 'gmail', idempotencyKey: 'connect-b' });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(authentication.start).not.toHaveBeenCalled();
  });

  it('pauses one at once', async () => {
    const res = await owner.call('post', `${CONNECTION}/pause`, 'own-tunnel').send({});
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(lifecycle.pause).toHaveBeenCalledOnce();
  });
});
