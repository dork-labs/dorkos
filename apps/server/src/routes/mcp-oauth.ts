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
import { getLocalCockpitOrigin } from '../lib/trusted-origins.js';
import { isLocalCaller } from '../lib/caller-authority.js';

/** HTTP status for a completed callback vs. any failure (used for the rendered page). */
const OK = 200;
const BAD_REQUEST = 400;

/** Escape the small set of HTML metacharacters so a query value can't inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** What a completed callback shows the operator. */
interface CallbackPageContent {
  /** The `<title>`, and the heading when there is no server to name. */
  title: string;
  /** The heading — names the server on success, so the tab says what just happened. */
  heading: string;
  /** The one sentence under the heading. */
  body: string;
  /** The link back into the cockpit, present only on success. */
  cockpitOrigin?: string;
}

/**
 * The copy for a landing, in the operator's terms rather than the protocol's.
 *
 * There is deliberately no close button and no `window.close()`: a tab a person
 * opened themselves cannot be closed by script, so the button would do nothing
 * and the page would be lying about what it offers. It says "you can close this
 * tab" and leaves the closing to them, next to a real link back.
 *
 * @param connected - Whether the exchange completed.
 * @param serverName - The server signed into, when the flow was still known.
 * @param error - The failure reason, when it failed.
 */
function callbackPageContent(
  connected: boolean,
  serverName?: string,
  error?: string
): CallbackPageContent {
  if (!connected) {
    return {
      title: 'Sign-in failed',
      heading: 'Sign-in failed',
      body: error ?? 'Please return to DorkOS and try again.',
    };
  }
  return {
    title: 'Signed in',
    heading: serverName ? `You’re signed in to ${serverName}.` : 'You’re signed in.',
    body: 'DorkOS has what it needs. You can close this tab — your agent is picking up where it left off.',
    cockpitOrigin: getLocalCockpitOrigin(),
  };
}

/**
 * Minimal HTML for the callback landing (no secret, no external assets).
 *
 * Every interpolated value goes through {@link escapeHtml}, the server name
 * included: it is operator-supplied text from the manifest, so it is untrusted
 * input to this page even though the operator typed it themselves.
 *
 * @param connected - Whether the exchange completed.
 * @param serverName - The server signed into, when known.
 * @param error - The failure reason, when it failed.
 */
function renderCallbackPage(connected: boolean, serverName?: string, error?: string): string {
  const { title, heading, body, cockpitOrigin } = callbackPageContent(connected, serverName, error);
  const link = cockpitOrigin
    ? `<p><a href="${escapeHtml(cockpitOrigin)}" style="color: #2563eb;">Back to DorkOS</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a;"><h1 style="font-size: 1.25rem;">${escapeHtml(heading)}</h1><p style="color: #555;">${escapeHtml(body)}</p>${link}</body></html>`;
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
      .send(renderCallbackPage(result.connected, result.serverName, result.error));
  });

  return router;
}
