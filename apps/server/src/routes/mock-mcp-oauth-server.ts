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
 * set (`http/hono-api.ts`), so none of these paths exist in production. No real vendor and no real
 * credentials anywhere — the access tokens are minted in-process and validated
 * against an in-memory set.
 *
 * ## A mock that says yes to everything proves nothing
 *
 * Every gate here is real, because a browser test asserting "the token unlocked
 * the server" is only evidence if a wrong token would have been refused. So an
 * authorization code must be one this server minted, unexpired, and matched by
 * its PKCE verifier; a refresh token must be one this server issued (it rotates
 * on use); an authorize request must name a client registered through DCR and a
 * loopback redirect back to the DorkOS callback path; and the MCP endpoint takes
 * only a bearer from the issued set. Loosen any of them and the e2e goes on
 * passing while proving less — which is exactly what the refresh grant did
 * before DOR-988: it minted a valid access token for any string at all.
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
import { createHash, randomBytes } from 'node:crypto';
import bodyParser from 'body-parser';
import { Hono, type Context } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { MCP_OAUTH_CALLBACK_PATH } from '../services/mesh/agent-mcp-oauth-service.js';

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

/** How long an authorization code stays exchangeable, matching the usual 10 minutes. */
const AUTH_CODE_LIFETIME_MS = 10 * 60 * 1000;

/** The hostnames a `redirect_uri` may name: this machine, and nothing else. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** One authorization code awaiting exchange at `/token`. */
interface PendingAuthCode {
  /** The PKCE `code_challenge` the client put in the authorize URL. */
  challenge: string;
  /** Epoch milliseconds after which this code is no longer exchangeable. */
  expiresAt: number;
}

/**
 * Authorization codes minted at `/authorize`, so `/token` can prove the
 * `code_verifier` the SDK round-tripped through the flow store matches the
 * `code_challenge` the SDK put in the authorize URL, and that the code is still
 * fresh. In-memory and per-process — this is test infrastructure, never a real
 * store.
 */
const authCodes = new Map<string, PendingAuthCode>();

/** The `client_id`s handed out by the DCR endpoint; the `/authorize` gate. */
const registeredClients = new Set<string>();

/** The set of access tokens this mock has issued; the MCP endpoint's bearer gate. */
const issuedTokens = new Set<string>();

/** The set of live refresh tokens; the refresh grant's gate. Rotated on use. */
const issuedRefreshTokens = new Set<string>();

/**
 * Drop every code, client, and token this mock is holding.
 *
 * Called from `POST /api/test/reset` alongside the other test-mode state, so one
 * spec's issued bearer cannot make the next spec's "not signed in yet" assertion
 * pass. In-process only; the mock mints nothing that outlives the server.
 */
export function resetMockMcpOAuthState(): void {
  authCodes.clear();
  registeredClients.clear();
  issuedTokens.clear();
  issuedRefreshTokens.clear();
}

/** The base64url S256 challenge for a PKCE verifier. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The origin the caller reached this mock on. Everything internal dials the
 * loopback host (the DorkOS OAuth callback is loopback-only), so the metadata we
 * hand back must name that same host — deriving it from the request keeps the
 * discovery, authorize, and token URLs on one consistent origin.
 *
 * The scheme trusts one forwarded hop, as the server's `trust proxy, 1` does: a
 * proxy's `X-Forwarded-Proto` (its first value) wins over the connection's own.
 */
function mockOrigin(c: Context<ApiEnv>): string {
  const { incoming } = c.env;
  const forwarded = incoming.headers['x-forwarded-proto'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const encrypted = (incoming.socket as { encrypted?: boolean }).encrypted === true;
  return `${first || (encrypted ? 'https' : 'http')}://${incoming.headers.host}`;
}

/** Mint a fresh access token and remember it for the MCP endpoint's bearer gate. */
function mintAccessToken(): string {
  const token = `mock-access-${randomBytes(24).toString('hex')}`;
  issuedTokens.add(token);
  return token;
}

/** Mint a fresh refresh token and remember it for the refresh grant's gate. */
function mintRefreshToken(): string {
  const token = `mock-refresh-${randomBytes(16).toString('hex')}`;
  issuedRefreshTokens.add(token);
  return token;
}

/** The successful token-endpoint response body: a new access token and a new refresh token. */
function tokenResponseBody(): Record<string, unknown> {
  return {
    access_token: mintAccessToken(),
    token_type: 'Bearer',
    expires_in: TOKEN_LIFETIME_SECONDS,
    refresh_token: mintRefreshToken(),
  };
}

/** The single query parameter `name`, or `''` when absent or repeated. */
function queryParam(c: Context<ApiEnv>, name: string): string {
  const value = readQuery(c)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Whether `redirectUri` is the DorkOS loopback callback. A real authorization
 * server only redirects to a URI the client registered; redirecting anywhere the
 * query string names is the open-redirect this shape is famous for, and a mock
 * that does it teaches the e2e nothing about the gate.
 */
function isLoopbackCallback(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return (
      url.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.pathname === MCP_OAUTH_CALLBACK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * The bearer token on a request, or `undefined`. RFC 6750 makes the scheme name
 * case-insensitive, so `bearer x` is as valid as `Bearer x`.
 *
 * The credential must start with a non-space because ` +` and `.` both match a
 * space, so a trailing `(.+)` makes the engine try every split of the run
 * (CodeQL js/polynomial-redos). This router only mounts under
 * `DORKOS_TEST_RUNTIME`, so nothing ships it — it is fixed anyway because a
 * bearer parser left in the quadratic shape is likely to get copied into real
 * code. The only value that parses differently is an all-whitespace
 * credential, which no issued token can be.
 */
function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^bearer +(\S.*)$/i);
  return match?.[1];
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
function serveProtectedResourceMetadata(c: Context<ApiEnv>): Response {
  const origin = mockOrigin(c);
  return c.json({
    resource: `${origin}${MOCK_MCP_OAUTH_MCP_PATH}`,
    authorization_servers: [origin],
  });
}

/** The RFC 8414 authorization-server metadata handler (root + path-suffixed variants). */
function serveAuthServerMetadata(c: Context<ApiEnv>): Response {
  const origin = mockOrigin(c);
  return c.json({
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
 * RFC 7591 dynamic client registration → a `client_id` the `/authorize` gate will
 * then accept. The body is JSON, parsed by the chain's body stage.
 */
function registerClient(c: Context<ApiEnv>): Response {
  const body = readJsonBody(c, { emptyAs: {} }) as { redirect_uris?: string[] };
  const clientId = `mock-client-${randomBytes(6).toString('hex')}`;
  registeredClients.add(clientId);
  return c.json(
    {
      client_id: clientId,
      redirect_uris: body.redirect_uris ?? [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'DorkOS',
    },
    HTTP_CREATED
  );
}

/** A refusal in plain words, typed as an HTML page, as it has always been answered. */
function textAnswer(c: Context<ApiEnv>, text: string, status: 400): Response {
  return c.body(text, status, { 'Content-Type': 'text/html; charset=utf-8' });
}

/**
 * Auto-approving authorization endpoint: check the client and the redirect, then
 * capture the PKCE challenge, mint a code, and 302 straight back to the DorkOS
 * loopback callback carrying it — the browser never sees a consent screen (like
 * `/api/test/connect-approved`).
 */
function authorize(c: Context<ApiEnv>): Response {
  const clientId = queryParam(c, 'client_id');
  const redirectUri = queryParam(c, 'redirect_uri');
  if (!registeredClients.has(clientId)) {
    return textAnswer(c, 'unknown client_id; register through DCR first', HTTP_BAD_REQUEST);
  }
  if (!isLoopbackCallback(redirectUri)) {
    return textAnswer(c, 'redirect_uri must be the DorkOS loopback callback', HTTP_BAD_REQUEST);
  }
  const code = randomBytes(16).toString('hex');
  authCodes.set(code, {
    challenge: queryParam(c, 'code_challenge'),
    expiresAt: Date.now() + AUTH_CODE_LIFETIME_MS,
  });
  const dest = new URL(redirectUri);
  dest.searchParams.set('code', code);
  const state = queryParam(c, 'state');
  if (state) dest.searchParams.set('state', state);
  const location = dest.toString();
  // The body a redirect has always carried, for a client that reads it.
  return c.body(`Found. Redirecting to ${location}`, HTTP_FOUND, {
    Location: location,
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

/**
 * The `authorization_code` grant: the code must be one this server minted, still
 * unexpired, and matched by the PKCE verifier it was issued against.
 */
function grantByAuthorizationCode(form: Record<string, string>, c: Context<ApiEnv>): Response {
  const code = form.code ?? '';
  const pending = authCodes.get(code);
  authCodes.delete(code); // one-time: a replayed code cannot re-exchange
  const expired = pending !== undefined && pending.expiresAt <= Date.now();
  if (pending === undefined || expired || s256(form.code_verifier ?? '') !== pending.challenge) {
    return c.json({ error: 'invalid_grant' }, HTTP_BAD_REQUEST);
  }
  return c.json(tokenResponseBody());
}

/**
 * The `refresh_token` grant: the token must be one this server issued, and it is
 * consumed on use so the client has to carry the rotated one forward.
 */
function grantByRefreshToken(form: Record<string, string>, c: Context<ApiEnv>): Response {
  const presented = form.refresh_token ?? '';
  if (!issuedRefreshTokens.delete(presented)) {
    return c.json({ error: 'invalid_grant' }, HTTP_BAD_REQUEST);
  }
  return c.json(tokenResponseBody());
}

/** The form parser the token endpoint reads with, after the chain's JSON one. */
const parseForm = bodyParser.urlencoded({ extended: false });

/**
 * The token endpoint (form-encoded, or JSON), dispatching on `grant_type`.
 *
 * The chain has already parsed a JSON body; a form body is still unread, and is
 * parsed here, after the session gate, as the route-level parser always did.
 */
async function issueToken(c: Context<ApiEnv>): Promise<Response> {
  const { incoming, outgoing } = c.env;
  await new Promise<void>((resolve, reject) =>
    parseForm(incoming, outgoing, (error) => (error ? reject(error) : resolve()))
  );
  const form = (readJsonBody(c) ?? (incoming as { body?: unknown }).body ?? {}) as Record<
    string,
    string
  >;
  if (form.grant_type === 'refresh_token') return grantByRefreshToken(form, c);
  if (form.grant_type === 'authorization_code') return grantByAuthorizationCode(form, c);
  return c.json({ error: 'unsupported_grant_type' }, HTTP_BAD_REQUEST);
}

/**
 * The protected streamable-HTTP MCP endpoint. 401 + WWW-Authenticate (carrying
 * the resource_metadata pointer) until a valid bearer we issued is presented;
 * then a normal stateless MCP session answering `initialize` + `tools/list`.
 */
async function serveMcp(c: Context<ApiEnv>): Promise<Response> {
  const token = bearerToken(c.req.header('authorization'));
  if (!token || !issuedTokens.has(token)) {
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${mockOrigin(c)}/.well-known/oauth-protected-resource"`
    );
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      HTTP_UNAUTHORIZED
    );
  }
  if (c.req.method !== 'POST') {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless).' },
        id: null,
      },
      HTTP_METHOD_NOT_ALLOWED
    );
  }
  // Stateless: a fresh server + transport per request (per the MCP SDK example),
  // torn down when the response closes. The transport writes the Node response
  // itself (`http/raw-node-stream.ts`).
  return streamToNodeResponse(c, async (res) => {
    const server = buildMockMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(c.env.incoming, res, readJsonBody(c));
  });
}

/**
 * Build the mock OAuth-protected MCP server's routes. Mount at the app root,
 * gated to `DORKOS_TEST_RUNTIME` — see the module docs for why it is
 * root-mounted.
 */
export function createMockMcpOAuthRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // RFC 9728: the SDK inserts the resource pathname before the well-known suffix,
  // so serve both the exact root path and any path-suffixed variant.
  router.get('/.well-known/oauth-protected-resource', serveProtectedResourceMetadata);
  router.get('/.well-known/oauth-protected-resource/*', serveProtectedResourceMetadata);

  // RFC 8414: the auth server issuer is the origin root, so this is dialed at the
  // root path; the wildcard covers the path-inserted form defensively.
  router.get('/.well-known/oauth-authorization-server', serveAuthServerMetadata);
  router.get('/.well-known/oauth-authorization-server/*', serveAuthServerMetadata);

  router.post(`${MOCK_MCP_OAUTH_BASE}/register`, registerClient);
  router.get(`${MOCK_MCP_OAUTH_BASE}/authorize`, authorize);
  router.post(`${MOCK_MCP_OAUTH_BASE}/token`, issueToken);
  router.all(MOCK_MCP_OAUTH_MCP_PATH, serveMcp);

  return router;
}
