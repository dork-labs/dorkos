/**
 * The managed-MCP OAuth loopback callback route (DOR-942): loopback-only, renders
 * a secret-free "return to DorkOS" page, and delegates the exchange to the engine.
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
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { AgentMcpOAuthService } from '../../services/mesh/agent-mcp-oauth-service.js';

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

const fixtureTarget = swappableServer();

/** A minimal engine stub exposing only the method the route calls. */
function stubOAuth(
  result: { connected: boolean; error?: string; serverName?: string },
  spy = vi.fn()
): AgentMcpOAuthService {
  return {
    handleCallback: async (args: unknown) => {
      spy(args);
      return result;
    },
  } as unknown as AgentMcpOAuthService;
}

function appWith(oauth: AgentMcpOAuthService): RequestListener {
  return honoGroupListener({ path: '/api/agents/mcp-oauth', routes: createMcpOAuthRoutes(oauth) });
}

describe('GET /api/agents/mcp-oauth/callback', () => {
  it('renders the success page (200) for a completed local callback', async () => {
    const spy = vi.fn();
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Signed in');
    // The route forwarded exactly the query the browser carried back.
    expect(spy).toHaveBeenCalledWith({ state: 's1', code: 'c1', error: undefined });
  });

  it('names the server the operator signed in to, and links back to the cockpit', async () => {
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: true, serverName: 'granola' }))
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    // The payoff sentence: WHICH server, in the operator's own words. Reverting
    // to the generic "You can close this tab and return to DorkOS." reddens this.
    expect(res.text).toContain('You’re signed in to granola.');
    expect(res.text).toContain('your agent is picking up where it left off');
    // A real link, derived from the configured port — not a scripted close, which
    // no-ops on a tab the person opened themselves.
    expect(res.text).toContain(`href="${getLocalCockpitOrigin()}"`);
    expect(res.text).not.toContain('window.close');
  });

  it('escapes a hostile server name instead of rendering it as markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const server = fixtureTarget.mount(
      appWith(stubOAuth({ connected: true, serverName: hostile }))
    );
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    // The name comes off the agent manifest, so it is operator-supplied text and
    // must never reach the page as markup. Dropping escapeHtml reddens both.
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the failure page (400) when the exchange did not complete', async () => {
    const server = fixtureTarget.mount(appWith(stubOAuth({ connected: false, error: 'nope' })));
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(res.status).toBe(400);
    expect(res.text).toContain('nope');
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
    // route runs. This request clears every chain step (a loopback peer and a
    // local Host) and is only marked as having come through the managed
    // ingress, so the 403 can come from nowhere but the route's own check.
    const spy = vi.fn();
    const listener = appWith(stubOAuth({ connected: true }, spy));
    const server = fixtureTarget.mount((req, res) => {
      markIngress(req, 'managed');
      listener(req, res);
    });
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(res.status).toBe(403);
    expect(res.text).toBe('Not available.');
    expect(spy).not.toHaveBeenCalled();
  });
});
