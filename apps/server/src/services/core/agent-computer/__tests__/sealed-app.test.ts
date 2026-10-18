/**
 * The whole Hono app on an agent computer (DOR-2940), routed through the front
 * door as the running server routes it: nobody can sign up or sign in, a write
 * it does not list answers `403` even to an agent, in any spelling of its
 * path, the app's streams refuse, and the local MCP token opens nothing under
 * `/api`.
 *
 * Better Auth is a fixture that counts the requests it is handed, and the same
 * app built for a person's own computer is asked too, so a sign-in that never
 * reached Better Auth for some other reason cannot pass.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

type Role = 'computer' | 'hub' | 'agent-computer';
const state = vi.hoisted(() => ({ role: 'agent-computer' as Role, authDispatch: vi.fn() }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => state.role }));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../auth/mcp-local-token.js', () => ({
  getMcpLocalToken: () => 'local-token',
  getMcpLocalTokenPath: () => '/tmp/mcp-token',
}));
vi.mock('../../agent-identity/agent-identity-service.js', async (original) => ({
  ...(await original<typeof import('../../agent-identity/agent-identity-service.js')>()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) =>
      token === 'agent-live' ? { agentPath: '/agents/a', displayName: 'A' } : undefined,
  }),
}));
vi.mock('../../auth/index.js', async (original) => ({
  ...(await original<typeof import('../../auth/index.js')>()),
  getAuth: () => ({
    api: { getSession: async () => null },
    handler: async () => {
      state.authDispatch();
      return Response.json({ answeredBy: 'better-auth' });
    },
  }),
}));

const { frontDoorListener } = await import('../../../../http/front-door.js');
const { composeFrontDoor } = await import('../../../../http/hono-api.js');
const { MainRequestAdmission } = await import('../../lifecycle/main-request-admission.js');

const target = swappableServer();

/** Build the app as `role` builds it, and serve it. */
function boot(role: Role) {
  state.role = role;
  target.mount(frontDoorListener(composeFrontDoor(new MainRequestAdmission())));
}

const LOOPBACK = { Host: '127.0.0.1:4242' };
const AS_AGENT = { ...LOOPBACK, 'X-DorkOS-Agent': 'agent-live' };

beforeEach(() => {
  state.authDispatch.mockClear();
});

describe('signing up or in on an agent computer', () => {
  it.each(['/api/auth/sign-up/email', '/api/auth/sign-in/email'])(
    'never hands %s to Better Auth',
    async (path) => {
      boot('agent-computer');
      const res = await request(target.server).post(path).set(AS_AGENT).send({
        email: 'a@example.invalid',
        password: 'pw-pw-pw-pw',
      });
      expect(state.authDispatch).not.toHaveBeenCalled();
      expect([401, 403, 404]).toContain(res.status);
      expect(res.body.answeredBy).toBeUndefined();
    }
  );

  it('does hand them to Better Auth on a person`s own computer', async () => {
    boot('computer');
    const res = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set(LOOPBACK)
      .send({ email: 'a@example.invalid', password: 'pw-pw-pw-pw' });
    expect(state.authDispatch).toHaveBeenCalledTimes(1);
    expect(res.body.answeredBy).toBe('better-auth');
  });
});

describe('the API on an agent computer', () => {
  it('refuses a write the hub owns with a 403, even to an agent', async () => {
    boot('agent-computer');
    const res = await request(target.server)
      .put('/api/config/agents/defaultAgent')
      .set(AS_AGENT)
      .send({ value: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AGENT_COMPUTER_HUB_OWNED');
  });

  it('refuses the app`s event stream to an agent', async () => {
    boot('agent-computer');
    const res = await request(target.server).get('/api/events').set(AS_AGENT);
    expect(res.status).toBe(401);
  });

  it('opens nothing under /api to the local MCP token', async () => {
    boot('agent-computer');
    const res = await request(target.server)
      .get('/api/config')
      .set({ ...LOOPBACK, Authorization: 'Bearer local-token' });
    expect(res.status).toBe(401);
  });

  it('refuses a write it does not list, the connections among them', async () => {
    boot('agent-computer');
    for (const path of ['/api/relay/adapters', '/api/connectors/connections', '/api/workspaces']) {
      const res = await request(target.server).post(path).set(AS_AGENT).send({});
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('AGENT_COMPUTER_HUB_OWNED');
    }
  });

  // Each spelling arrives as a real request, so the URL parser and the
  // router's own decoding run first: every one is the account routes or a
  // stream, refused before any handler.
  it.each([
    '/api/%63loud/status',
    '/API/Cloud/status',
    '/api/cloud./status',
    '//api/cloud/status',
    '/api/cloud%2Fstatus',
    '/api/x/../cloud/status',
    '/api/%2e%2e/api/cloud/status',
    '/api/%65vents',
  ])('refuses %s, reading or writing', async (path) => {
    boot('agent-computer');
    const read = await request(target.server).get(path).set(AS_AGENT);
    expect(read.status, `GET ${path}`).toBe(401);
    const write = await request(target.server).post(path).set(AS_AGENT).send({});
    expect(write.status, `POST ${path}`).toBe(401);
  });

  it.each([
    '/API/config/agents/defaultAgent',
    '/api/%63onfig/agents/defaultAgent',
    '/api/config./agents/defaultAgent',
    '//api/config/agents/defaultAgent',
    '/api/config%2Fagents/defaultAgent',
    '/api/x/../config/agents/defaultAgent',
  ])('never writes through %s', async (path) => {
    boot('agent-computer');
    const res = await request(target.server).put(path).set(AS_AGENT).send({ value: 'x' });
    expect(res.status, path).toBe(403);
    expect(res.body.code, path).toBe('AGENT_COMPUTER_HUB_OWNED');
  });

  // Two of those spellings reach the real settings route on a person's own
  // computer, so the refusal above is the gate's, not a 404 by accident.
  it.each(['/api/%63onfig/agents/defaultAgent', '/api/x/../config/agents/defaultAgent'])(
    'routes %s to the settings write on a person`s own computer',
    async (path) => {
      boot('computer');
      const res = await request(target.server).put(path).set(LOOPBACK).send({ value: 'x' });
      expect(res.status, path).toBe(200);
    }
  );

  it('answers the liveness probe with nothing', async () => {
    boot('agent-computer');
    expect((await request(target.server).get('/api/health').set(LOOPBACK)).status).toBe(200);
  });
});
