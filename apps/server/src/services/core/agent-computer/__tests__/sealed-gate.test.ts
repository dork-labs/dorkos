/**
 * A sealed agent computer admits no person, ever (DOR-2940): from the
 * classifier through the gate policy to every gate that reads it (the session
 * gate, `/mcp`, the stream upgrade), plus registration and exposure.
 *
 * Each case also asks a person's own computer the same question, so a case
 * that passes only because the stub refuses everything cannot pass here.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../../../env.js', () => ({
  env: { DORKOS_ALLOW_INSECURE_BIND: false, MCP_API_KEY: undefined },
}));
vi.mock('../../config-manager.js', () => ({ configManager: { get: () => undefined } }));
const users = vi.hoisted(() => ({ exist: false }));
vi.mock('../../auth/index.js', () => ({
  hasAnyUser: () => users.exist,
  getAuth: () => null,
  verifyRequestAuth: vi.fn(async () => null),
}));
vi.mock('../../auth/mcp-local-token.js', () => ({
  getMcpLocalToken: () => 'local-token',
  getMcpLocalTokenPath: () => '/tmp/mcp-token',
}));
vi.mock('../../agent-identity/agent-identity-service.js', () => ({
  agentTokenDigestPrefix: () => 'digest',
  getAgentIdentityService: () => ({
    resolve: async (token: string) => {
      if (token === 'agent-live') return { agentPath: '/agents/a', displayName: 'A' };
      if (token === 'agent-revoked') {
        return { agentPath: '/agents/a', displayName: 'A', inactive: 'revoked' };
      }
      return undefined;
    },
  }),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { classifyRequest } = await import('../../../../lib/request-classifier.js');
const { decideGateAccess, gateAccessFor, isAtThisComputer, credentialGated } =
  await import('../../auth/gate-policy.js');
const { decideRegistration, registrationAllowed } =
  await import('../../auth/registration-policy.js');
const { decideSessionGate } = await import('../../auth/session-gate.js');
const { decideMcpAuth } = await import('../../../../middleware/mcp-auth.js');
const { authorizeStreamUpgrade } = await import('../../streams/stream-upgrade-auth.js');
const { canExpose } = await import('../../auth/exposure-guard.js');

/** A request from a process on this machine: loopback peer, loopback `Host`. */
const LOCAL = {
  peerAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:4242' } as Record<string, string>,
  ingress: 'direct' as const,
};
const POSTURE = { askOnThisComputer: false, insecureBind: false, ownerExists: () => false };

/** {@link LOCAL} with extra headers. */
function local(headers: Record<string, string> = {}) {
  return { ...LOCAL, headers: { ...LOCAL.headers, ...headers } };
}

beforeEach(() => {
  role.value = 'agent-computer';
  users.exist = false;
});

describe('classifying a request to an agent computer', () => {
  it('never calls a request from this machine a person at it', () => {
    expect(classifyRequest(LOCAL, 'computer').kind).toBe('this-computer');
    expect(classifyRequest(LOCAL, 'agent-computer')).toEqual({
      kind: 'agent-computer',
      route: 'local',
    });
  });

  it('calls everything that is not plainly this machine the network', () => {
    const forwarded = local({ 'x-forwarded-for': '203.0.113.9' });
    expect(classifyRequest(forwarded, 'agent-computer').route).toBe('network');
    expect(classifyRequest({ ...LOCAL, ingress: 'relay' }, 'agent-computer').route).toBe('network');
    expect(classifyRequest({ ...LOCAL, peerAddress: '10.0.0.4' }, 'agent-computer').route).toBe(
      'network'
    );
  });
});

describe('the gate policy on an agent computer', () => {
  it('asks a local request for an agent credential, and refuses the network', () => {
    expect(decideGateAccess({ kind: 'agent-computer', route: 'local' }, POSTURE)).toBe('agent');
    expect(decideGateAccess({ kind: 'agent-computer', route: 'network' }, POSTURE)).toBe('refused');
    expect(gateAccessFor(LOCAL, POSTURE)).toBe('agent');
  });

  it('never treats a request as a person at this computer', () => {
    expect(isAtThisComputer(LOCAL, POSTURE)).toBe(false);
    expect(credentialGated(LOCAL)).toBe(true);
    role.value = 'computer';
    expect(isAtThisComputer(LOCAL, POSTURE)).toBe(true);
  });
});

describe('registration on an agent computer', () => {
  it('is closed for every caller, even with no account yet', () => {
    const callers = [
      'in-process',
      'provisioning',
      { kind: 'agent-computer', route: 'local' },
      { kind: 'this-computer', route: 'local' },
    ] as const;
    for (const caller of callers) {
      const mode = decideRegistration({ caller, hasUsers: false, role: 'agent-computer' });
      expect(mode, JSON.stringify(caller)).toBe('closed');
      expect(registrationAllowed(mode, caller)).toBe(false);
    }
    expect(decideRegistration({ caller: 'in-process', hasUsers: false, role: 'computer' })).toBe(
      'local-open'
    );
  });
});

describe('the session gate on an agent computer', () => {
  it('answers the liveness probe with nothing, and nothing else', async () => {
    expect(await decideSessionGate('GET', '/api/health', LOCAL)).toEqual({ allowed: true });
    expect((await decideSessionGate('GET', '/api/health/deep', LOCAL)).allowed).toBe(false);
  });

  it('refuses a person`s sign-in, the app and every route without an agent identity', async () => {
    for (const path of ['/api/auth/sign-in/email', '/api/sessions', '/', '/x/ext']) {
      expect((await decideSessionGate('POST', path, LOCAL)).allowed, path).toBe(false);
    }
    role.value = 'computer';
    expect((await decideSessionGate('POST', '/api/sessions', LOCAL)).allowed).toBe(true);
  });

  it('never lets the local MCP token into /api', async () => {
    const withToken = local({ authorization: 'Bearer local-token' });
    for (const path of ['/api/sessions', '/api/config', '/api/agents']) {
      expect((await decideSessionGate('GET', path, withToken)).allowed, path).toBe(false);
    }
  });

  it('admits a live agent identity to /api, never a revoked or unknown one', async () => {
    const asAgent = local({ 'x-dorkos-agent': 'agent-live' });
    for (const [method, path] of [
      ['GET', '/api/sessions'],
      ['POST', '/api/sessions/s1/messages'],
    ] as const) {
      expect(await decideSessionGate(method, path, asAgent), path).toEqual({
        allowed: true,
        agentIdentity: { agentPath: '/agents/a', displayName: 'A' },
      });
    }
    for (const token of ['agent-revoked', 'agent-unknown']) {
      const caller = local({ 'x-dorkos-agent': token });
      for (const [method, path] of [
        ['GET', '/api/sessions'],
        ['POST', '/api/sessions/s1/messages'],
      ] as const) {
        expect((await decideSessionGate(method, path, caller)).allowed, token).toBe(false);
      }
    }
  });

  it('hands /mcp and A2A to their own authorizer, whatever they carry', async () => {
    for (const path of ['/mcp', '/a2a', '/a2a/agents/x', '/.well-known/agent-card.json']) {
      expect((await decideSessionGate('POST', path, LOCAL)).allowed, path).toBe(true);
    }
  });

  it('refuses the DorkOS account routes and the app`s streams, even to an agent', async () => {
    const asAgent = local({ 'x-dorkos-agent': 'agent-live' });
    const paths = [
      '/api/cloud/status',
      '/API/Cloud//unlink',
      '/api/events',
      '/api/sessions/s1/events',
      '/api/rooms/r1/events',
    ];
    for (const path of paths) {
      expect((await decideSessionGate('GET', path, asAgent)).allowed, path).toBe(false);
    }
    expect((await decideSessionGate('GET', '/api/cloudy', asAgent)).allowed).toBe(true);
    expect((await decideSessionGate('GET', '/api/sessions/s1', asAgent)).allowed).toBe(true);
  });

  it('answers a write the hub owns with a 403 refusal, even to an agent', async () => {
    const asAgent = local({ 'x-dorkos-agent': 'agent-live' });
    const decision = await decideSessionGate('PUT', '/api/config/agents/defaultAgent', asAgent);
    expect(decision).toMatchObject({
      allowed: false,
      refusal: { code: 'AGENT_COMPUTER_HUB_OWNED' },
    });
    expect((await decideSessionGate('GET', '/api/config', asAgent)).allowed).toBe(true);
  });

  it('lets an agent pause another agent, never resume one a person paused', async () => {
    const asAgent = local({ 'x-dorkos-agent': 'agent-live' });
    expect((await decideSessionGate('POST', '/api/agents/a1/pause', asAgent)).allowed).toBe(true);
    expect(await decideSessionGate('POST', '/api/agents/a1/resume', asAgent)).toMatchObject({
      allowed: false,
      refusal: { code: 'AGENT_COMPUTER_HUB_OWNED' },
    });
  });

  it('refuses every write it does not list, the hub`s and a person`s alike', async () => {
    const asAgent = local({ 'x-dorkos-agent': 'agent-live' });
    for (const [method, path] of [
      ['POST', '/api/relay/adapters'],
      ['POST', '/api/connectors/connections'],
      ['POST', '/api/community-connections'],
      ['POST', '/api/hub/link'],
      ['POST', '/api/desktop/sign-in'],
      ['POST', '/api/discovery/scan'],
      ['POST', '/api/directory'],
      ['POST', '/api/communities/c1/dms'],
      ['POST', '/api/workspaces'],
      ['POST', '/api/local-browser/open'],
      ['POST', '/api/templates'],
      ['POST', '/api/sessions/s1/approve'],
    ] as const) {
      expect(await decideSessionGate(method, path, asAgent), path).toMatchObject({
        allowed: false,
        refusal: { code: 'AGENT_COMPUTER_HUB_OWNED' },
      });
    }
  });

  // The liveness probe stays exempt from the network, as on every server, and
  // A2A answers from its own authorizer (below).
  it('refuses the API and /mcp from the network', async () => {
    const remote = { ...local({ 'x-dorkos-agent': 'agent-live' }), peerAddress: '10.0.0.4' };
    for (const path of ['/mcp', '/api/sessions']) {
      expect((await decideSessionGate('POST', path, remote)).allowed, path).toBe(false);
    }
  });
});

describe('odd spellings of a path on an agent computer', () => {
  const asAgent = local({ 'x-dorkos-agent': 'agent-live' });

  // The gate is handed the path the router matches; each of these is refused
  // whatever the method, so no spelling of the account routes or a stream
  // reaches its handler.
  it.each([
    '/api/%63loud/status',
    '/API/Cloud/status',
    '/api/Cloud',
    '/api/cloud./status',
    '/api/cloud.',
    '//api/cloud',
    '//api//cloud//unlink',
    '/api/cloud%2Fstatus',
    '/api/cloud%2fstatus',
    '/api%2Fcloud',
    '/API/Events',
    '/api/events/',
    '/api/events.',
    '/api/sessions/s1//events',
    '/api/sessions/s1%2Fevents',
  ])('refuses %s, reading or writing', async (path) => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await decideSessionGate(method, path, asAgent)).allowed, method).toBe(false);
    }
  });

  // An open write is matched exactly; any other spelling of it is refused,
  // and so is every spelling of a refused one.
  it.each([
    ['PUT', '/API/config/agents/defaultAgent'],
    ['PUT', '/api/%63onfig/agents/defaultAgent'],
    ['PUT', '/api/config./agents/defaultAgent'],
    ['PUT', '//api/config/agents/defaultAgent'],
    ['PUT', '/api/config%2Fagents/defaultAgent'],
    ['POST', '/api/relay//adapters'],
    ['POST', '/API/sessions/s1/messages'],
    ['POST', '/api/Sessions/s1/messages'],
    ['POST', '/api/sessions//s1/messages'],
    ['POST', '//api/sessions/s1/messages'],
    ['POST', '/api/sessions/s1/messages/'],
    ['POST', '/api/sessions/s1%2Fmessages'],
    ['POST', '/api/sessions/s1/%6Dessages'],
    ['POST', '/api/files/'],
    ['POST', '/MCP'],
  ])('refuses %s %s with the one code', async (method, path) => {
    expect(await decideSessionGate(method, path, asAgent)).toMatchObject({
      allowed: false,
      refusal: { code: 'AGENT_COMPUTER_HUB_OWNED' },
    });
  });
});

describe('/mcp on an agent computer', () => {
  const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  it('has no tokenless path, even for discovery', async () => {
    const tokenless = { method: 'POST', body: INITIALIZE, ...LOCAL };
    expect((await decideMcpAuth('mcp', tokenless)).allowed).toBe(false);
    role.value = 'computer';
    expect((await decideMcpAuth('mcp', tokenless)).allowed).toBe(true);
  });

  it('refuses A2A from the network, even with the local token', async () => {
    const remote = { ...local({ authorization: 'Bearer local-token' }), peerAddress: '10.0.0.4' };
    expect(
      (await decideMcpAuth('a2a', { method: 'GET', body: undefined, ...remote })).allowed
    ).toBe(false);
  });

  it('accepts the local MCP token from this machine', async () => {
    const decision = await decideMcpAuth('mcp', {
      method: 'POST',
      body: INITIALIZE,
      ...local({ authorization: 'Bearer local-token' }),
    });
    expect(decision).toEqual({ allowed: true, mcpLocalToken: true });
  });
});

describe('streams and exposure on an agent computer', () => {
  it('refuses a stream upgrade from this machine', async () => {
    const req = { headers: LOCAL.headers, socket: { remoteAddress: '127.0.0.1' } };
    const decision = await authorizeStreamUpgrade(req as never);
    expect(decision.ok).toBe(false);
    role.value = 'computer';
    expect((await authorizeStreamUpgrade(req as never)).ok).toBe(true);
  });

  it('never allows a tunnel, Wi-Fi access or managed remote access', () => {
    users.exist = true;
    expect(canExpose()).toBe(false);
    role.value = 'computer';
    expect(canExpose()).toBe(true);
  });
});
