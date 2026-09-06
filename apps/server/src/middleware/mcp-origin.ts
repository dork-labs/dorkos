/**
 * `Origin` validation for the MCP mounts — `/mcp`, `/codex-ui-mcp`, and the
 * Nango proxy at `/api/connectors/nango/mcp`.
 *
 * A thin adapter, and nothing more: the decision itself is
 * `isTrustedBrowserOrigin` in `lib/trusted-origins.ts`, the one origin policy
 * the CORS delegate and the WebSocket upgrade read too. All this file owns is
 * the JSON-RPC shape of the refusal, which is the one thing genuinely particular
 * to an MCP endpoint — an MCP client parses every response as JSON-RPC, so a
 * bare HTTP error body reaches it as a parse failure rather than a reason.
 *
 * ## What it used to be, and why that mattered (DOR-1711)
 *
 * It built its own allowlist: `http://localhost:PORT` and
 * `http://127.0.0.1:PORT` plus the live tunnel origin. Three gaps came out of
 * that, none of them chosen:
 *
 * - `[::1]` matched nothing, so a browser at `http://[::1]:4242` cleared the
 *   `/api` host guard, cleared CORS, and was refused here — the disagreement
 *   DOR-553 filed, absorbed by this unification;
 * - `DORKOS_CORS_ORIGIN` was not consulted, so the operator's explicit
 *   allowlist — honoured by CORS, by the socket and by Better Auth — meant
 *   nothing on these mounts;
 * - there was no same-origin branch, so a container published on a remapped
 *   host port (`docker run -p 4300:4242`) or reached through a reverse proxy
 *   answered every `/api` call and refused every MCP one.
 *
 * The unified policy closes all three. It stays strictly no wider than before on
 * the attack that matters: the same-origin branch is PAIRED with the host
 * allowlist here (these mounts have no `hostGuard` in front of them), so a page
 * that DNS-rebinds `evil.example` onto this port still sends `Host: evil.example`
 * and is still refused.
 *
 * @module middleware/mcp-origin
 */
import type { Request, Response, NextFunction } from 'express';
import { type BrowserOriginPolicy, isTrustedBrowserOrigin } from '../lib/trusted-origins.js';
import { resolveBrowserOriginFacts } from './browser-origin.js';

/**
 * What the MCP mounts ask of the origin policy.
 *
 * `allowNoOrigin` is the load-bearing one and it is deliberate, not inherited:
 * MCP clients send no `Origin`. The MCP TypeScript SDK's HTTP transport sets
 * `Authorization`, `mcp-session-id`, `mcp-protocol-version`, `Accept` and
 * `content-type` and nothing else, and Node's `fetch` adds no `Origin` of its
 * own — so every remote MCP client, plus DorkOS's own in-process ones (the
 * Codex canvas stub on `/codex-ui-mcp`, the Nango proxy, the injected `dorkos`
 * tool server), arrives on that branch. Refusing it would refuse every real
 * caller these mounts have while stopping no browser, since a browser is forced
 * to send the header truthfully and can therefore always be judged by it. The
 * MCP spec asks for validation of connections that carry an `Origin`; an absent
 * header is not a failed one.
 *
 * `pairSameOriginWithHost` is on because nothing else on these mounts checks
 * `Host` — `middleware/host-guard.ts` is mounted at `/api` only, and two of the
 * three MCP mounts are not under `/api` at all.
 */
const MCP_ORIGIN_POLICY: BrowserOriginPolicy = {
  allowNoOrigin: true,
  pairSameOriginWithHost: true,
};

/**
 * Reject a browser `Origin` these mounts do not trust, with the JSON-RPC error
 * body an MCP client can read.
 *
 * The host pairing is never allowed to stand down here (`hostCheckInert: false`),
 * even under login. The exemption exists elsewhere because an origin-scoped auth
 * cookie turns a rebound origin away before anything happens — and `/codex-ui-mcp`
 * deliberately carries no auth middleware at all, so on that mount there would be
 * no cookie doing the work the exemption assumes.
 *
 * @param req - The incoming request; its `Origin` and `Host` headers decide.
 * @param res - The response, written with a JSON-RPC 403 on refusal.
 * @param next - Passes control on when the origin is trusted.
 */
export function validateMcpOrigin(req: Request, res: Response, next: NextFunction): void {
  const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });

  if (isTrustedBrowserOrigin(facts, MCP_ORIGIN_POLICY)) {
    next();
    return;
  }

  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32002, message: `Origin ${facts.origin} not allowed` },
    id: null,
  });
}
