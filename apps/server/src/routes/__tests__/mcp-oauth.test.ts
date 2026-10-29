/**
 * The managed-MCP OAuth loopback callback route (DOR-942): loopback-only,
 * delegates the exchange to the engine, and sends the browser to the app's
 * landing page with nothing secret in the address.
 *
 * @vitest-environment node
 */
import type { RequestListener } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { createMcpOAuthRoutes } from '../mcp-oauth.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { getLocalCockpitOrigin } from '../../lib/trusted-origins.js';
import { signInLandings } from '../../services/core/sign-in-landing/sign-in-landings.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { AgentMcpOAuthService } from '../../services/mesh/agent-mcp-oauth-service.js';

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

/**
 * A browser session the session gate can verify. A request from another
 * device (managed access among them) must prove a person session at the `/api`
 * gate (ADR 261015-125850 rule 3) before the route's own check is reached.
 */
const PERSON_SESSION = 'dorkos-test-session=person';

// Stood in at the gate's verifier step only: a request carrying the test
// session is the owner's browser session; everything else is the real gate.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/auth/session-gate.js')>();
  return {
    ...actual,
    decideSessionGate: async (...args: Parameters<typeof actual.decideSessionGate>) => {
      const [, , facts, access] = args;
      const cookie = facts.headers.cookie ?? '';
      if (access !== 'refused' && cookie.includes(PERSON_SESSION)) {
        return { allowed: true, user: { userId: 'user_owner', credential: 'cookie' } };
      }
      return actual.decideSessionGate(...args);
    },
  };
});

const fixtureTarget = swappableServer();

/** The flow a callback finished, as the engine hands it back. */
const FLOW = {
  flowId: 's1',
  agentId: 'agent-1',
  serverName: 'granola',
  serverUrl: 'https://mcp.granola.test/mcp',
  originSessionId: '0b0c3a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21',
  originCwd: '/work/granola',
};

/** A minimal engine stub exposing only the methods the route calls. */
function stubOAuth(
  result: Awaited<ReturnType<AgentMcpOAuthService['handleCallback']>>,
  spy = vi.fn(),
  startSignin = vi.fn()
): AgentMcpOAuthService {
  return {
    handleCallback: async (args: unknown) => {
      spy(args);
      return result;
    },
    startSignin,
  } as unknown as AgentMcpOAuthService;
}

function appWith(oauth: AgentMcpOAuthService): RequestListener {
  return honoGroupListener({ path: '/api/agents/mcp-oauth', routes: createMcpOAuthRoutes(oauth) });
}

/** The landing record a redirect points at. */
function landingFrom(location: string) {
  const id = new URL(location, 'http://localhost').searchParams.get('landing') ?? '';
  const landing = signInLandings.get(id);
  if (!landing) throw new Error(`no landing for ${location}`);
  return landing;
}

describe('GET /api/agents/mcp-oauth/callback', () => {
  it('redirects to the app’s landing page, with no code or state in the address', async () => {
    const spy = vi.fn();
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: true, serverName: 'granola', flow: FLOW }, spy))
    );
    // Values long and odd enough that the random landing id can never contain
    // them: the old `s1`/`c1` matched a random id a few percent of the time.
    const state = 'state-sentinel-value';
    const code = 'code-sentinel-value';
    const res = await request(server).get(
      `/api/agents/mcp-oauth/callback?state=${state}&code=${code}`
    );

    expect(res.status).toBe(303);
    const location = res.headers.location as string;
    // Built from the configured app origin, never from the request.
    expect(location.startsWith(`${getLocalCockpitOrigin()}/signed-in?landing=`)).toBe(true);
    expect(location).not.toMatch(/[?&](code|state)=/);
    expect(location).not.toContain(state);
    expect(location).not.toContain(code);
    // The callback URL carries a one-time code: never cached, never sent on.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // The route forwarded exactly the query the browser carried back.
    expect(spy).toHaveBeenCalledWith({ state, code, error: undefined });
  });

  it('records which server, which agent, and the conversation to go back to', async () => {
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: true, serverName: 'granola', flow: FLOW }))
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(landingFrom(res.headers.location as string)).toMatchObject({
      service: 'mcp',
      serviceName: 'granola',
      status: 'connected',
      agentId: 'agent-1',
      resumesConversation: true,
      returnPath: `/session?session=${FLOW.originSessionId}`,
      returnSurface: 'browser',
      canRetry: false,
    });
  });

  it('never puts a hostile server name in the redirect', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: true, serverName: hostile, flow: FLOW }))
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    // The name comes off the agent manifest, so it is operator-supplied text. It
    // stays in the server-held record, which the app renders as text; the
    // address carries only the record's opaque id.
    const location = res.headers.location as string;
    expect(location).not.toContain('img');
    expect(location).toMatch(/\/signed-in\?landing=[A-Za-z0-9_-]+$/);
    expect(landingFrom(location).serviceName).toBe(hostile);
  });

  it('records a failure with its reason, and Try again restarts the same sign-in', async () => {
    const startSignin = vi.fn().mockResolvedValue({
      flowId: 's2',
      authorizeUrl: 'https://auth.test/x',
      alreadyConnected: false,
    });
    const server = fixtureTarget.mount(
      appWith(
        stubOAuth(
          {
            connected: false,
            error: 'nope',
            reason: 'cancelled',
            serverName: 'granola',
            flow: FLOW,
          },
          vi.fn(),
          startSignin
        )
      )
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&error=denied');

    expect(res.status).toBe(303);
    const landing = landingFrom(res.headers.location as string);
    expect(landing).toMatchObject({ status: 'failed', reason: 'cancelled', canRetry: true });
    // The engine's own sentence stays on the server; the page words the code.
    expect(JSON.stringify(landing)).not.toContain('nope');

    await expect(signInLandings.retry(landing.id)).resolves.toEqual({
      kind: 'authorize',
      authorizeUrl: 'https://auth.test/x',
    });
    // The same agent and server, and the same conversation to resume.
    expect(startSignin).toHaveBeenCalledWith(
      { agentId: 'agent-1', serverName: 'granola', serverUrl: FLOW.serverUrl },
      { originSessionId: FLOW.originSessionId, originCwd: FLOW.originCwd, restartFlowId: 's1' }
    );
  });

  it('offers no Try again when the flow was already gone', async () => {
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: false, error: 'expired', reason: 'expired' }))
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=gone&code=c1');

    expect(landingFrom(res.headers.location as string)).toMatchObject({
      status: 'failed',
      reason: 'expired',
      canRetry: false,
    });
  });

  it('finishes when the provider page is the Referer, as a real redirect sends it', async () => {
    // The provider's page redirects the browser here, so the request carries
    // its page as Referer. That alone must not read as another device: the
    // gate once answered 401 and the sign-in never finished.
    const spy = vi.fn();
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Referer', 'https://mcp.artblocks.io/')
      .set('Sec-Fetch-Mode', 'navigate')
      .set('Sec-Fetch-Dest', 'document');

    expect(res.status).toBe(303);
    expect(landingFrom(res.headers.location as string).status).toBe('connected');
    expect(spy).toHaveBeenCalledWith({ state: 's1', code: 'c1', error: undefined });
  });

  // The sign-in cookie is SameSite=Strict (DOR-3172): the provider's redirect
  // never carries it, so the callback at this computer cannot ask for it.
  it('finishes with no cookie while this computer asks for a password, and nothing else gets in', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    vi.mocked(configManager.get).mockImplementation(((key: string) =>
      key === 'auth' ? { enabled: true } : null) as never);
    try {
      const spy = vi.fn();
      const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
      const res = await request(server)
        .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
        .set('Referer', 'https://mcp.artblocks.io/');
      expect(res.status).toBe(303);
      expect(spy).toHaveBeenCalledTimes(1);
      // Any other route at this computer still asks for the password.
      const other = await request(server).get('/api/agents/mcp-oauth/other');
      expect(other.status).toBe(401);
      // A write to the callback path still does.
      const write = await request(server).post('/api/agents/mcp-oauth/callback?state=s1&code=c1');
      expect(write.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(configManager.get).mockReturnValue(null as never);
    }
  });

  it('still fails an unknown state when the provider page is the Referer', async () => {
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: false, error: 'This sign-in expired.', reason: 'expired' }))
    );
    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=unknown&code=c1')
      .set('Referer', 'https://mcp.artblocks.io/');

    expect(res.status).toBe(303);
    expect(landingFrom(res.headers.location as string)).toMatchObject({
      status: 'failed',
      reason: 'expired',
    });
  });

  it('keeps a cross-site write to the callback path gated', async () => {
    const spy = vi.fn();
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server)
      .post('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Referer', 'https://evil.example.com/');

    // Only a GET is judged without its Referer; a write is still another device.
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still refuses a foreign Referer behind a proxy forwarding header', async () => {
    const spy = vi.fn();
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Referer', 'https://mcp.artblocks.io/')
      .set('X-Forwarded-For', '203.0.113.9');

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a non-loopback caller with 403 and never runs the exchange', async () => {
    const spy = vi.fn();
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Host', 'evil.example.com');

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses managed remote access even with a local Host, on the route itself', async () => {
    // The Host above is refused by the `/api` chain's host guard before the
    // route runs. This request clears every chain step (a loopback peer, a
    // local Host and a person session) and is only marked as having come
    // through the managed ingress, so the 403 can come from nowhere but the
    // route's own check.
    const spy = vi.fn();
    const listener = appWith(stubOAuth({ connected: true }, spy));
    const server = fixtureTarget.mount((req, res) => {
      markIngress(req, 'managed');
      listener(req, res);
    });
    const unsigned = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');
    // With no session the `/api` gate turns managed access away first.
    expect(unsigned.status).toBe(401);

    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Cookie', PERSON_SESSION);

    expect(res.status).toBe(403);
    expect(res.text).toBe('Not available.');
    expect(spy).not.toHaveBeenCalled();
  });
});
