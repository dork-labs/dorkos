/**
 * The managed-MCP OAuth loopback callback route (DOR-942), mirroring the
 * OpenRouter OAuth callback in `routes/runtimes.ts`.
 *
 * This is the `redirect_uri` the operator's browser lands on after authorizing a
 * managed MCP server. It is **loopback-only** (the user's own browser hits it),
 * hands the `state`/`code` to {@link AgentMcpOAuthService.handleCallback}, and
 * sends the browser on to the app's sign-in landing page
 * (`http/sign-in-landing-response.ts`), which says which server it was, takes
 * the person back to the conversation that asked, and offers Try again. The
 * token exchange and storage happen entirely inside the service; this route is
 * only the browser's landing spot.
 *
 * @module routes/mcp-oauth
 */
import { Hono } from 'hono';
import type { SignInRetryResult } from '@dorkos/shared/sign-in-landing';
import type { AgentMcpOAuthService } from '../services/mesh/agent-mcp-oauth-service.js';
import type { StartedFlow } from '../services/mesh/agent-mcp-oauth-flow-store.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { respondWithSignInLanding } from '../http/sign-in-landing-response.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { withoutReferringPage } from '../services/core/auth/oauth-callback-arrival.js';

/**
 * The page's type, spelled as Express's `res.send` spelled it for a string
 * (`c.html` would say `UTF-8`).
 */
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

/**
 * Start the same sign-in a landing page is about again: the same agent and
 * server, and the same conversation to resume once it lands.
 *
 * @param oauth - The managed-MCP OAuth engine.
 * @param flow - The flow the callback finished.
 */
function retryFor(oauth: AgentMcpOAuthService, flow: StartedFlow) {
  return async (): Promise<SignInRetryResult> => {
    const started = await oauth.startSignin(
      { agentId: flow.agentId, serverName: flow.serverName, serverUrl: flow.serverUrl },
      {
        ...(flow.originSessionId ? { originSessionId: flow.originSessionId } : {}),
        ...(flow.originCwd ? { originCwd: flow.originCwd } : {}),
      }
    );
    if (started.alreadyConnected || !started.authorizeUrl) return { kind: 'connected' };
    return { kind: 'authorize', authorizeUrl: started.authorizeUrl };
  };
}

/**
 * Build the routes serving `GET /callback` (mounted at `/api/agents/mcp-oauth`).
 *
 * @param oauth - The managed-MCP OAuth engine that completes the token exchange.
 * @returns The routes for the loopback callback.
 */
export function createMcpOAuthRoutes(oauth: AgentMcpOAuthService): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/callback', async (c) => {
    // The provider's page is the Referer here; judge where the request came from.
    if (!isAtThisComputer(withoutReferringPage(honoRequestFacts(c)))) {
      return c.body('Not available.', 403, HTML);
    }
    // A repeated key is an array, and reads as absent, as it did on Express.
    const query = readQuery(c);
    const state = typeof query.state === 'string' ? query.state : undefined;
    const code = typeof query.code === 'string' ? query.code : undefined;
    const error = typeof query.error === 'string' ? query.error : undefined;
    const result = await oauth.handleCallback({ state, code, error });
    const flow = result.flow;
    return respondWithSignInLanding(c, {
      service: 'mcp',
      // Empty when the flow was already gone: the page then names no service.
      serviceName: result.serverName ?? '',
      connected: result.connected,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(flow ? { agentId: flow.agentId } : {}),
      ...(flow?.originSessionId ? { originSessionId: flow.originSessionId } : {}),
      ...(flow && !result.connected ? { retry: retryFor(oauth, flow) } : {}),
    });
  });

  return router;
}
