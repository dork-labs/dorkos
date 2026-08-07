/**
 * The managed-MCP OAuth loopback callback route (DOR-942): loopback-only, renders
 * a secret-free "return to DorkOS" page, and delegates the exchange to the engine.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

import { createMcpOAuthRouter } from '../mcp-oauth.js';
import { getLocalCockpitOrigin } from '../../lib/trusted-origins.js';
import type { AgentMcpOAuthService } from '../../services/mesh/agent-mcp-oauth-service.js';

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

function appWith(oauth: AgentMcpOAuthService): express.Express {
  const app = express();
  app.use('/api/agents/mcp-oauth', createMcpOAuthRouter(oauth));
  return app;
}

describe('GET /api/agents/mcp-oauth/callback', () => {
  it('renders the success page (200) for a completed local callback', async () => {
    const spy = vi.fn();
    const server = listeningServer(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Signed in');
    // The route forwarded exactly the query the browser carried back.
    expect(spy).toHaveBeenCalledWith({ state: 's1', code: 'c1', error: undefined });
  });

  it('names the server the operator signed in to, and links back to the cockpit', async () => {
    const server = listeningServer(appWith(stubOAuth({ connected: true, serverName: 'granola' })));
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
    const server = listeningServer(appWith(stubOAuth({ connected: true, serverName: hostile })));
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    // The name comes off the agent manifest, so it is operator-supplied text and
    // must never reach the page as markup. Dropping escapeHtml reddens both.
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the failure page (400) when the exchange did not complete', async () => {
    const server = listeningServer(appWith(stubOAuth({ connected: false, error: 'nope' })));
    const res = await request(server).get('/api/agents/mcp-oauth/callback?state=s1&code=c1');

    expect(res.status).toBe(400);
    expect(res.text).toContain('nope');
  });

  it('refuses a non-loopback caller with 403 and never runs the exchange', async () => {
    const spy = vi.fn();
    const server = listeningServer(appWith(stubOAuth({ connected: true }, spy)));
    const res = await request(server)
      .get('/api/agents/mcp-oauth/callback?state=s1&code=c1')
      .set('Host', 'evil.example.com');

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});
