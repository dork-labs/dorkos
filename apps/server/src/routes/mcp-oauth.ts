/**
 * The managed-MCP OAuth loopback callback route (DOR-942), mirroring the
 * OpenRouter OAuth callback in `routes/runtimes.ts`.
 *
 * This is the `redirect_uri` the operator's browser lands on after authorizing a
 * managed MCP server. It is **loopback-only** (the user's own browser hits it),
 * hands the `state`/`code` to {@link AgentMcpOAuthService.handleCallback}, and
 * renders a plain "return to DorkOS" page carrying no secret and no external
 * asset. The token exchange and storage happen entirely inside the service; this
 * route is only the browser's landing spot.
 *
 * @module routes/mcp-oauth
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentMcpOAuthService } from '../services/mesh/agent-mcp-oauth-service.js';
import { isLocalRequest } from '../lib/trusted-origins.js';
import { env } from '../env.js';

/** HTTP status for a completed callback vs. any failure (used for the rendered page). */
const OK = 200;
const BAD_REQUEST = 400;

/** Whether the request originates from this machine's loopback interface. */
function isLocalCaller(req: Request): boolean {
  return isLocalRequest({
    peer: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
  });
}

/** Escape the small set of HTML metacharacters so a query value can't inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal HTML for the callback landing (no secret, no external assets). */
function renderCallbackPage(connected: boolean, error?: string): string {
  const title = escapeHtml(connected ? 'Signed in' : 'Sign-in failed');
  const body = escapeHtml(
    connected
      ? 'You can close this tab and return to DorkOS.'
      : (error ?? 'Please return to DorkOS and try again.')
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a;"><h1 style="font-size: 1.25rem;">${title}</h1><p style="color: #555;">${body}</p></body></html>`;
}

/**
 * Build the router serving `GET /callback` (mounted at `/api/agents/mcp-oauth`).
 *
 * @param oauth - The managed-MCP OAuth engine that completes the token exchange.
 * @returns An Express router for the loopback callback.
 */
export function createMcpOAuthRouter(oauth: AgentMcpOAuthService): Router {
  const router = Router();

  router.get('/callback', async (req: Request, res: Response) => {
    if (!isLocalCaller(req)) {
      return res.status(403).send('Not available.');
    }
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    const result = await oauth.handleCallback({ state, code, error });
    res
      .status(result.connected ? OK : BAD_REQUEST)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(renderCallbackPage(result.connected, result.error));
  });

  return router;
}
