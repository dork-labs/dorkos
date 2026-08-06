/**
 * A test-mode-gated mock OAuth-protected MCP server (DOR-952).
 *
 * The managed-MCP OAuth e2e (`apps/e2e/tests/connections/mcp-oauth-signin.spec.ts`)
 * needs a REAL HTTP server that both the operator's browser and DorkOS's in-process
 * MCP OAuth client can reach — the same shape `agent-mcp-oauth-service.test.ts`
 * drives against a `fetchImpl` mock, but reachable over the wire. This router IS
 * that server. It implements just enough for the MCP SDK's `auth()` to complete
 * against it, plus a bearer-gated streamable-HTTP MCP endpoint:
 *
 *   - GET  /.well-known/oauth-protected-resource   (RFC 9728) → points at the auth server
 *   - GET  /.well-known/oauth-authorization-server (RFC 8414) → registration/authorize/token
 *   - POST /api/test/mcp-oauth/register            (RFC 7591 dynamic client registration)
 *   - GET  /api/test/mcp-oauth/authorize           → 302 to the DorkOS loopback callback,
 *                                                    auto-approving (like /api/test/connect-approved)
 *   - POST /api/test/mcp-oauth/token               → authorization_code (PKCE-validating) + refresh_token
 *   - ALL  /api/test/mcp-oauth/mcp                  → 401 + WWW-Authenticate until a valid bearer,
 *                                                    then a normal MCP `initialize` + `tools/list`
 *
 * Gated exactly like `test-control.ts`: mounted only when `DORKOS_TEST_RUNTIME` is
 * set, so none of these paths exist in production. No real vendor and no real
 * credentials anywhere — the access tokens are minted in-process and validated
 * against an in-memory set.
 *
 * Mounted at the app ROOT (not under a prefix) because RFC 9728/8414 discovery
 * fetches the `/.well-known/*` paths at the host root; the SDK inserts the
 * resource pathname before the well-known suffix, so the wildcard routes catch
 * both the root and path-suffixed variants and answer JSON — otherwise the
 * path-suffixed request would fall through to the SPA catch-all and get 200 HTML,
 * which the SDK cannot parse.
 *
 * @module routes/mock-mcp-oauth-server
 */
import express, { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Mount-relative base for the mock's non-discovery (auth + MCP) endpoints. */
export const MOCK_MCP_OAUTH_BASE = '/api/test/mcp-oauth';

/** The protected streamable-HTTP MCP endpoint path — also the manifest `serverUrl` path. */
export const MOCK_MCP_OAUTH_MCP_PATH = `${MOCK_MCP_OAUTH_BASE}/mcp`;

const HTTP_CREATED = 201;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD_NOT_ALLOWED = 405;
const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * PKCE challenge captured at `/authorize`, keyed by the authorization code, so
 * `/token` can prove the `code_verifier` the SDK round-tripped through the flow
 * store matches the `code_challenge` the SDK put in the authorize URL. In-memory
 * and per-process — this is test infrastructure, never a real store.
 */
const codeChallenges = new Map<string, string>();

/** The set of access tokens this mock has issued; the MCP endpoint's bearer gate. */
const issuedTokens = new Set<string>();

/** The base64url S256 challenge for a PKCE verifier. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The origin the caller reached this mock on. Everything internal dials the
 * loopback host (the DorkOS OAuth callback is loopback-only), so the metadata we
 * hand back must name that same host — deriving it from the request keeps the
 * discovery, authorize, and token URLs on one consistent origin.
 */
function mockOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

/** Mint a fresh access token and remember it for the MCP endpoint's bearer gate. */
function mintAccessToken(): string {
  const token = `mock-access-${randomBytes(24).toString('hex')}`;
  issuedTokens.add(token);
  return token;
}

/** A fresh MCP server exposing a couple of dummy tools for `tools/list`. */
function buildMockMcpServer(): McpServer {
  const server = new McpServer({ name: 'mock-oauth-mcp', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo the text back.' }, () => ({
    content: [{ type: 'text' as const, text: 'echo' }],
  }));
  server.registerTool('ping', { description: 'Reply pong.' }, () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  return server;
}

/** The RFC 9728 protected-resource metadata handler (root + path-suffixed variants). */
function serveProtectedResourceMetadata(req: Request, res: Response): void {
  const origin = mockOrigin(req);
  res.json({
    resource: `${origin}${MOCK_MCP_OAUTH_MCP_PATH}`,
    authorization_servers: [origin],
  });
}

/** The RFC 8414 authorization-server metadata handler (root + path-suffixed variants). */
function serveAuthServerMetadata(req: Request, res: Response): void {
  const origin = mockOrigin(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}${MOCK_MCP_OAUTH_BASE}/authorize`,
    token_endpoint: `${origin}${MOCK_MCP_OAUTH_BASE}/token`,
    registration_endpoint: `${origin}${MOCK_MCP_OAUTH_BASE}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

/**
 * Build the mock OAuth-protected MCP server router. Mount at the app root, gated
 * to `DORKOS_TEST_RUNTIME` — see the module docs for why it is root-mounted.
 */
export function createMockMcpOAuthRouter(): Router {
  const router = Router();

  // RFC 9728: the SDK inserts the resource pathname before the well-known suffix,
  // so serve both the exact root path and any path-suffixed variant.
  router.get('/.well-known/oauth-protected-resource', serveProtectedResourceMetadata);
  router.get('/.well-known/oauth-protected-resource/*splat', serveProtectedResourceMetadata);

  // RFC 8414: the auth server issuer is the origin root, so this is dialed at the
  // root path; the wildcard covers the path-inserted form defensively.
  router.get('/.well-known/oauth-authorization-server', serveAuthServerMetadata);
  router.get('/.well-known/oauth-authorization-server/*splat', serveAuthServerMetadata);

  // RFC 7591 dynamic client registration → a client_id. The body is JSON, parsed
  // by the app-wide `express.json`.
  router.post(`${MOCK_MCP_OAUTH_BASE}/register`, (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: string[] };
    res.status(HTTP_CREATED).json({
      client_id: `mock-client-${randomBytes(6).toString('hex')}`,
      redirect_uris: body.redirect_uris ?? [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'DorkOS',
    });
  });

  // Auto-approving authorization endpoint: capture the PKCE challenge, mint a
  // code, and 302 straight back to the DorkOS loopback callback carrying it —
  // the browser never sees a consent screen (like /api/test/connect-approved).
  router.get(`${MOCK_MCP_OAUTH_BASE}/authorize`, (req, res) => {
    const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const challenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
    if (!redirectUri) {
      return res.status(HTTP_BAD_REQUEST).send('missing redirect_uri');
    }
    const code = randomBytes(16).toString('hex');
    codeChallenges.set(code, challenge);
    const dest = new URL(redirectUri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);
    res.redirect(HTTP_FOUND, dest.toString());
  });

  // Token endpoint (form-encoded). authorization_code validates the PKCE verifier
  // against the challenge captured at /authorize; refresh_token always succeeds.
  router.post(
    `${MOCK_MCP_OAUTH_BASE}/token`,
    express.urlencoded({ extended: false }),
    (req, res) => {
      const form = (req.body ?? {}) as Record<string, string>;
      const grantType = form.grant_type;
      if (grantType === 'refresh_token') {
        return res.json({
          access_token: mintAccessToken(),
          token_type: 'Bearer',
          expires_in: TOKEN_LIFETIME_SECONDS,
          refresh_token: `mock-refresh-${randomBytes(16).toString('hex')}`,
        });
      }
      if (grantType === 'authorization_code') {
        const code = form.code ?? '';
        const verifier = form.code_verifier ?? '';
        const challenge = codeChallenges.get(code);
        codeChallenges.delete(code); // one-time: a replayed code cannot re-exchange
        if (challenge === undefined || s256(verifier) !== challenge) {
          return res.status(HTTP_BAD_REQUEST).json({ error: 'invalid_grant' });
        }
        return res.json({
          access_token: mintAccessToken(),
          token_type: 'Bearer',
          expires_in: TOKEN_LIFETIME_SECONDS,
          refresh_token: `mock-refresh-${randomBytes(16).toString('hex')}`,
        });
      }
      res.status(HTTP_BAD_REQUEST).json({ error: 'unsupported_grant_type' });
    }
  );

  // The protected streamable-HTTP MCP endpoint. 401 + WWW-Authenticate (carrying
  // the resource_metadata pointer) until a valid bearer we issued is presented;
  // then a normal stateless MCP session answering `initialize` + `tools/list`.
  router.all(MOCK_MCP_OAUTH_MCP_PATH, async (req, res) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token || !issuedTokens.has(token)) {
      return res
        .status(HTTP_UNAUTHORIZED)
        .set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${mockOrigin(req)}/.well-known/oauth-protected-resource"`
        )
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    if (req.method !== 'POST') {
      return res.status(HTTP_METHOD_NOT_ALLOWED).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless).' },
        id: null,
      });
    }
    // Stateless: a fresh server + transport per request (per the MCP SDK example),
    // torn down when the response closes.
    const server = buildMockMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
