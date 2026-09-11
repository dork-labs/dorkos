import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConnectorResourcesRouter,
  type ConnectorResourcesRouterDeps,
} from '../connector-resources.js';
import { ConnectorAuthenticationFlowError } from '../../services/connectors/resources/authentication-flow-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();

describe('connector resource routes', () => {
  let deps: ConnectorResourcesRouterDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = {
      resolveOwner: () => OWNER,
      loginEnabled: () => false,
      query: {
        catalog: vi.fn().mockResolvedValue({ services: [], warnings: [] }),
        listConnections: vi.fn().mockReturnValue([]),
        getConnection: vi.fn().mockReturnValue({ connection: { connectionId: 'connection-a' } }),
        disconnectImpact: vi.fn().mockReturnValue({ connectionId: 'connection-a' }),
        agentConnections: vi.fn().mockResolvedValue({ agentId: 'agent-a', connections: [] }),
        sessionConnections: vi
          .fn()
          .mockResolvedValue({ sessionId: 'session-a', agentId: 'agent-a', connections: [] }),
      },
      authentication: {
        start: vi.fn().mockResolvedValue({ flowId: 'flow-a', state: 'pending' }),
        reconnect: vi.fn().mockResolvedValue({ flowId: 'flow-b', state: 'pending' }),
        poll: vi.fn().mockResolvedValue({ flowId: 'flow-a', state: 'pending' }),
      },
      lifecycle: {
        remove: vi.fn(),
        rename: vi.fn().mockReturnValue({ connectionId: 'connection-a', lifecycle: 'connected' }),
        pause: vi.fn().mockResolvedValue({ connectionId: 'connection-a', lifecycle: 'paused' }),
        resume: vi.fn().mockResolvedValue({ connectionId: 'connection-a', lifecycle: 'connected' }),
        disconnect: vi
          .fn()
          .mockResolvedValue({ connectionId: 'connection-a', lifecycle: 'disconnected' }),
      },
    } as unknown as ConnectorResourcesRouterDeps;
    app = express();
    app.use(express.json());
    app.use('/api/connectors', createConnectorResourcesRouter(deps));
  });

  function api() {
    return request(fixtureTarget.mount(app));
  }

  it('keeps catalog account-free and validates its bounded query', async () => {
    await api().get('/api/connectors/catalog?q=gmail&limit=20').expect(200, {
      services: [],
      warnings: [],
    });
    expect(deps.query.catalog).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'gmail', limit: 20, signal: expect.any(AbortSignal) })
    );

    const invalid = await api().get('/api/connectors/catalog?unknown=private').expect(400);
    expect(invalid.body).toMatchObject({
      error: 'This connection request is invalid. Check the request and try again.',
      details: expect.any(Array),
    });
    expect(deps.query.catalog).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '0', '1'])(
    'negotiates public catalog setup with cache separation: %s',
    async (version) => {
      const call = api().get('/api/connectors/catalog?q=mail&cursor=page2&limit=20');
      if (version) call.set('x-dorkos-catalog-auth-setup', version);
      const response = await call.expect(200);
      expect(response.headers.vary).toContain('x-dorkos-catalog-auth-setup');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(deps.query.catalog).toHaveBeenCalledWith(
        expect.objectContaining({
          includeAuthenticationSetup: version === '1',
          query: 'mail',
          cursor: 'page2',
        })
      );
    }
  );

  it('removes only through the strict owner boundary', async () => {
    await api().post('/api/connectors/connections/connection-a/remove').send({}).expect(204);
    expect(deps.lifecycle.remove).toHaveBeenCalledWith(OWNER, 'connection-a');
    vi.mocked(deps.lifecycle.remove).mockClear();
    await api()
      .post('/api/connectors/connections/connection-a/remove')
      .send({ ownerId: 'foreign' })
      .expect(400);
    await api()
      .post('/api/connectors/connections/connection-a/remove')
      .set('X-DorkOS-Agent', 'agent-a')
      .send({})
      .expect(403);
    expect(deps.lifecycle.remove).not.toHaveBeenCalled();
  });

  it('returns a useful generic error without exposing an internal failure', async () => {
    vi.mocked(deps.query.listConnections).mockImplementationOnce(() => {
      throw new Error('private upstream detail');
    });

    await api().get('/api/connectors/connections').expect(500, {
      error: 'DorkOS could not complete this connection request. Try again.',
    });
  });

  it('refuses inherited agent identity before every owner resource read', async () => {
    const response = await api()
      .get('/api/connectors/connections')
      .set('X-DorkOS-Agent', 'agent-a')
      .expect(403);

    expect(response.body).toMatchObject({ code: 'connector_owner_required' });
    expect(deps.query.listConnections).not.toHaveBeenCalled();
  });

  it('requires a strict idempotency claim before starting provider authentication', async () => {
    await api()
      .post('/api/connectors/connections')
      .send({ providerInstanceId: 'provider-a', toolkit: 'gmail' })
      .expect(400);
    expect(deps.authentication.start).not.toHaveBeenCalled();

    await api()
      .post('/api/connectors/connections')
      .send({
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
        idempotencyKey: 'connect-gmail',
      })
      .expect(201);
    expect(deps.authentication.start).toHaveBeenCalledWith(OWNER, {
      providerInstanceId: 'provider-a',
      toolkit: 'gmail',
      idempotencyKey: 'connect-gmail',
    });
  });

  it('routes lifecycle and canonical agent/session reads through exact resource paths', async () => {
    await api().post('/api/connectors/connections/connection-a/pause').send({}).expect(200);
    await api()
      .get('/api/connectors/agents/agent-a/connections')
      .expect(200, { agentId: 'agent-a', connections: [] });
    await api()
      .get('/api/connectors/sessions/session-a/connections')
      .expect(200, { sessionId: 'session-a', agentId: 'agent-a', connections: [] });

    expect(deps.lifecycle.pause).toHaveBeenCalledWith(
      OWNER,
      'connection-a',
      expect.any(AbortSignal)
    );
    expect(deps.query.agentConnections).toHaveBeenCalledWith(OWNER, 'agent-a');
    expect(deps.query.sessionConnections).toHaveBeenCalledWith(OWNER, 'session-a');
  });

  it('passes an owned reconnect identity unchanged and keeps foreign accounts hidden', async () => {
    await api()
      .post('/api/connectors/connections/connection-a/reconnect')
      .send({ idempotencyKey: 'reconnect-valid' })
      .expect(201, { flowId: 'flow-b', state: 'pending' });
    expect(deps.authentication.reconnect).toHaveBeenCalledWith(
      OWNER,
      'connection-a',
      'reconnect-valid'
    );

    vi.mocked(deps.authentication.reconnect).mockRejectedValueOnce(
      new ConnectorAuthenticationFlowError('connection_not_found', 'Connection not found.')
    );
    await api()
      .post('/api/connectors/connections/another-owner/reconnect')
      .send({ idempotencyKey: 'reconnect-foreign' })
      .expect(404, { error: 'Connection not found.', code: 'connection_not_found' });
  });
});
