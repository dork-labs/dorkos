/** Public program execution, access, and usage authority tests. */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { createServerPrincipal } from '../../services/connectors/principal/server-principal.js';
import { createConnectorExecutionRouter } from '../connector-execution.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();

describe('connector execution routes', () => {
  const invoke = vi.fn();
  const capabilityIdForTarget = vi.fn();
  const listConnections = vi.fn();
  const listOperations = vi.fn();
  const listAgentUsage = vi.fn();
  const listOperatorUsage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capabilityIdForTarget.mockReturnValue('connectors.execute_write');
    invoke.mockResolvedValue({
      logicalOperationId: 'logical-a',
      attemptCount: 1,
      result: { status: 'success', data: { ok: true } },
    });
    listConnections.mockResolvedValue({ connections: [] });
    listOperations.mockResolvedValue({ connectionId: 'connection-a', operations: [] });
    listAgentUsage.mockResolvedValue({ items: [] });
    listOperatorUsage.mockReturnValue({ items: [] });
  });

  function buildApp(
    options: {
      user?: RequestUser;
      verifyUser?: RequestUser | null;
      migrationFailed?: boolean;
    } = {}
  ) {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (options.user) res.locals.user = options.user;
      next();
    });
    app.use(
      '/api/connectors',
      createConnectorExecutionRouter({
        connectorRegistry: {
          migrationHealth: () =>
            options.migrationFailed
              ? { status: 'migration_failed', error: 'connector migration failed' }
              : { status: 'ready', migrated: false },
        },
        capabilities: { invoke },
        authorization: { capabilityIdForTarget },
        access: { listConnections, listOperations, listAgentUsage, listOperatorUsage },
        eventAccess: {
          listSubscriptions: vi.fn().mockResolvedValue({ agentId: 'agent-a', subscriptions: [] }),
        },
        programPrincipals: {
          mint: (user, owner) =>
            user.credentialId
              ? createServerPrincipal({
                  kind: 'program',
                  owner,
                  credentialId: user.credentialId,
                })
              : undefined,
        },
        resolveOwner: () => OWNER,
        loginEnabled: () => Boolean(options.user),
        verifyUser: async () => options.verifyUser ?? null,
        trustedOrigins: () => ['http://localhost:4242'],
      })
    );
    return app;
  }

  const PROGRAM_USER = {
    userId: 'user-a',
    credential: 'api-key',
    credentialId: 'credential-a',
  } as const;
  const EXECUTION = {
    agentId: 'agent-a',
    connectionId: 'connection-a',
    operationRevisionId: 'revision-a',
    arguments: { query: 'hello' },
  };

  it('derives the capability and forwards exact program authority through REST', async () => {
    const response = await request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .post('/api/connectors/executions')
      .set('Authorization', 'Bearer verified')
      .set('X-DorkOS-Approval', 'approval-a')
      .send(EXECUTION)
      .expect(200);

    expect(response.body).toMatchObject({ logicalOperationId: 'logical-a', attemptCount: 1 });
    const principal = capabilityIdForTarget.mock.calls[0][0];
    expect(principal.claims).toEqual({
      kind: 'program',
      owner: OWNER,
      credentialId: 'credential-a',
    });
    expect(capabilityIdForTarget).toHaveBeenCalledWith(principal, {
      connectionId: 'connection-a',
      operationRevisionId: 'revision-a',
      arguments: { query: 'hello' },
    });
    expect(invoke).toHaveBeenCalledWith(
      'connectors.execute_write',
      expect.objectContaining({ operationRevisionId: 'revision-a' }),
      expect.objectContaining({
        serverPrincipal: principal,
        connectorAgentId: 'agent-a',
        connectorSurface: 'rest',
        approvalToken: 'approval-a',
      })
    );
  });

  it('uses a server-owned CLI path for honest surface attribution', async () => {
    await request(fixtureTarget.mount(buildApp({ verifyUser: PROGRAM_USER })))
      .post('/api/connectors/cli/executions')
      .set('Authorization', 'Bearer verified-with-login-off')
      .send(EXECUTION)
      .expect(200);

    expect(invoke.mock.calls[0][2]).toMatchObject({
      connectorAgentId: 'agent-a',
      connectorSurface: 'cli',
    });
  });

  it('refuses missing, invalid, and inherited agent credentials before any read or intent', async () => {
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/executions')
      .send(EXECUTION)
      .expect(401, {
        error: 'Use a verified API key to call this service.',
        code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
      });
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/accessible?agentId=agent-a')
      .set('Authorization', 'Bearer invalid')
      .expect(401, {
        error: 'Use a verified API key to call this service.',
        code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
      });
    await request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .post('/api/connectors/executions')
      .set('Authorization', 'Bearer verified')
      .set('X-DorkOS-Agent', 'runtime-agent-token')
      .send(EXECUTION)
      .expect(403, {
        error:
          'This service call cannot run from an active agent session. Use an API key outside the session.',
        code: 'CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED',
        message: 'Run this service call with an API key outside an active agent session.',
      });
    expect(capabilityIdForTarget).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('rejects program owner/session selectors and missing named agents', async () => {
    const agent = request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .post('/api/connectors/executions')
      .set('Authorization', 'Bearer verified');
    await agent.send({ ...EXECUTION, ownerId: 'foreign-owner' }).expect(400);
    await request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .post('/api/connectors/executions')
      .set('Authorization', 'Bearer verified')
      .send({
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        arguments: {},
        sessionId: 'session-a',
      })
      .expect(400);
    expect(capabilityIdForTarget).not.toHaveBeenCalled();
  });

  it('keeps program agent usage separate from cookie-authenticated operator usage', async () => {
    await request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .get('/api/connectors/usage/agent?agentId=agent-a&limit=10')
      .set('Authorization', 'Bearer verified')
      .expect(200, { items: [] });
    expect(listAgentUsage).toHaveBeenCalledWith(OWNER, 'agent-a', {
      agentId: 'agent-a',
      limit: 10,
    });

    await request(
      fixtureTarget.mount(buildApp({ user: { userId: 'user-a', credential: 'cookie' } }))
    )
      .get('/api/connectors/usage/operator?connectionId=connection-a')
      .set('Origin', 'http://localhost:4242')
      .expect(200, { items: [] });
    expect(listOperatorUsage).toHaveBeenCalledWith(OWNER, {
      connectionId: 'connection-a',
    });

    await request(fixtureTarget.mount(buildApp({ user: PROGRAM_USER })))
      .get('/api/connectors/usage/operator')
      .set('Authorization', 'Bearer verified')
      .expect(403);
  });

  it('fails closed for every public connector route when migration recovery is incomplete', async () => {
    const app = fixtureTarget.mount(buildApp({ user: PROGRAM_USER, migrationFailed: true }));
    await request(app)
      .post('/api/connectors/executions')
      .set('Authorization', 'Bearer verified')
      .send(EXECUTION)
      .expect(503);
    await request(app)
      .get('/api/connectors/accessible?agentId=agent-a')
      .set('Authorization', 'Bearer verified')
      .expect(503);
    expect(capabilityIdForTarget).not.toHaveBeenCalled();
    expect(listConnections).not.toHaveBeenCalled();
  });
});
