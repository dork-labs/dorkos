/**
 * Contract for the groups that move to Hono together in DOR-2812: settings
 * (`/api/config`), first-run setup (`/api/onboarding`), the MCP server list
 * (`/api/mcp-config`), feedback (`/api/feedback`, with its LARGER body limit),
 * document events (`/api/canvas/docs`, with its SMALLER body limit), the
 * diagnostic reads (`/api/debug`), reset and restart (`/api/admin`), and the
 * two test-only surfaces: the test-control routes (`/api/test`, with the fake
 * Cloud's approval page and fake inference stream) and the mock OAuth MCP
 * server (`/.well-known/*` and `/api/test/mcp-oauth/*`). That PR must pass this
 * file unchanged.
 *
 * Nothing here leaves the machine: the site URL feedback reads points at a
 * closed local port, no valid feedback is ever sent (its metrics post has a
 * fixed address), no reset is ever confirmed, and no restart ever runs (the
 * admin limiter refuses it first).
 *
 * Four servers:
 *
 * 1. Login off, test mode: every route's answer and refusal that a caller earns
 *    with one request, both body limits, the admin limiter, and the mock OAuth
 *    server's discovery and refusals.
 * 2. Login off, test mode, driven by hand: the OAuth sign-in from registration
 *    to a bearer the MCP endpoint accepts; the fake inference stream; a refused
 *    document event counted in the document metrics.
 * 3. Login off, NOT test mode, and started by the desktop app: no test-only
 *    route exists, and reset and restart refuse at every spelling.
 * 4. Login on: no credential is refused at the session gate, after the body
 *    limits; an API key is not a person, so it may not change protected
 *    settings, read document metrics or set DorkOS up; the owner's cookie may.
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** Nothing reaches the site: feedback history reads a closed local port. */
const NO_SITE = { DORKOS_CLOUD_URL: 'http://127.0.0.1:9', NGROK_AUTHTOKEN: '' };
/** A host name the server is told it answers to, which is not this computer. */
const REMOTE_HOST = 'dorkos.contract.example';
const BASE_ENV = { ...NO_SITE, DORKOS_TRUSTED_HOSTS: REMOTE_HOST };

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const HTML_TYPE = { 'content-type': /^text\/html\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const TOO_LARGE = {
  error: 'That is too large to send in one request.',
  code: 'REQUEST_TOO_LARGE',
};
const VALIDATION_FAILED = z
  .object({ error: z.literal('Validation failed'), details: z.object({}).loose() })
  .strict();
const UUID = '00000000-0000-4000-8000-000000000000';

/** A JSON body of about `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  return JSON.stringify({ padding: 'x'.repeat(bytes) });
}
/** Above the app-wide 1 MB limit, inside feedback's 2 MB one. */
const BETWEEN_LIMITS = jsonOfSize(1_500_000);
/** Above feedback's 2 MB limit. */
const ABOVE_FEEDBACK_LIMIT = jsonOfSize(2_200_000);
/** Above document events' 16 KB limit, far inside the app-wide one. */
const ABOVE_DOC_EVENT_LIMIT = jsonOfSize(17_000);

const CONFIG = z
  .object({
    version: z.string(),
    isLocalCaller: z.boolean(),
    port: z.number(),
    mcp: z.object({ authSource: z.string(), endpoint: z.string() }).loose(),
    tunnel: z.object({ enabledInConfig: z.boolean() }).loose(),
  })
  .loose();
const LOCAL_CALLER = CONFIG.and(z.object({ isLocalCaller: z.literal(true) }).loose());
const REMOTE_CALLER = CONFIG.and(z.object({ isLocalCaller: z.literal(false) }).loose());
const SAVED = z.object({ success: z.literal(true), config: z.object({}).loose() }).strict();
const OPERATOR_ONLY = (paths: string[]) =>
  z
    .object({
      error: z.literal('Only a person can change those settings'),
      code: z.literal('operator_only_config'),
      paths: z.array(z.string()).refine((have) => have.join() === paths.join()),
      message: z.string(),
    })
    .strict();
const LOCAL_TOKEN = z.object({ localToken: z.string().startsWith('dork_mcp_local_') }).strict();
const DISPATCHES = z.object({ claims: z.array(z.unknown()), holds: z.array(z.unknown()) }).loose();
const DOC_METRICS = z
  .object({
    sampledAt: z.string(),
    requestAttempts: z.object({ rejectedRequestsByClass: z.object({}).loose() }).loose(),
  })
  .loose();
const DOC_METRICS_FORBIDDEN = {
  code: 'DOC_METRICS_FORBIDDEN',
  error: 'Only the owner can read document metrics.',
};
const DOC_NOT_FOUND = {
  error: 'The document is not available.',
  code: 'CANVAS_DOCUMENT_NOT_FOUND',
};
const DOC_EVENT_TOO_LARGE = {
  error: 'The document event is too large.',
  code: 'DOC_EVENT_TOO_LARGE',
};
const SETUP_REFUSED = (code: string) => ({ error: 'Only the owner can set up DorkOS.', code });
const RESET_TOKEN_REQUIRED = {
  error:
    'Nothing has been deleted. Resetting DorkOS takes two steps now: ask DorkOS to start the reset, then confirm it within 2 minutes. Open Settings and start the reset again.',
  code: 'RESET_TOKEN_REQUIRED',
};
const BAD_CONFIRM = { error: 'Missing or invalid confirm field. Send { confirm: "reset" }.' };
const TOO_MANY_ADMIN = { error: 'Too many admin requests. Try again later.' };
const ADMIN_LIMIT = (limit: number, remaining: number) => ({
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-reset': /^\d+$/,
});
/** The origin a contract server answers on, as the mock names it in a body. */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+$/;
/** The mock's protected-resource metadata, naming `origin`. */
const PROTECTED_RESOURCE = (origin: RegExp | string) =>
  z
    .object({
      resource: z.string().refine((value) => matches(value, origin, '/api/test/mcp-oauth/mcp')),
      authorization_servers: z.tuple([z.string().refine((value) => matches(value, origin))]),
    })
    .strict();
/** The mock's authorization-server metadata, naming `origin`. */
const AUTH_SERVER = (origin: RegExp | string) =>
  z
    .object({
      issuer: z.string().refine((value) => matches(value, origin)),
      authorization_endpoint: z
        .string()
        .refine((value) => matches(value, origin, '/api/test/mcp-oauth/authorize')),
      token_endpoint: z
        .string()
        .refine((value) => matches(value, origin, '/api/test/mcp-oauth/token')),
      registration_endpoint: z
        .string()
        .refine((value) => matches(value, origin, '/api/test/mcp-oauth/register')),
      response_types_supported: z.tuple([z.literal('code')]),
      grant_types_supported: z.tuple([z.literal('authorization_code'), z.literal('refresh_token')]),
      code_challenge_methods_supported: z.tuple([z.literal('S256')]),
      token_endpoint_auth_methods_supported: z.tuple([z.literal('none')]),
    })
    .strict();

/** Whether `value` is `origin` (a pattern, or exactly) followed by `suffix`. */
function matches(value: string, origin: RegExp | string, suffix = ''): boolean {
  if (!value.endsWith(suffix)) return false;
  const head = value.slice(0, value.length - suffix.length);
  return typeof origin === 'string' ? head === origin : origin.test(head);
}
const MCP_UNAUTHORIZED = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Unauthorized' },
  id: null,
};
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

contractSuite(
  'feedback, debug, admin, config and test-only groups',
  [
    // config: the read
    {
      name: 'GET /api/config answers the settings, uncached, for a caller at this computer',
      path: '/api/config',
      expect: {
        status: 200,
        headers: { ...JSON_TYPE, 'cache-control': 'no-store' },
        schema: LOCAL_CALLER,
      },
    },
    {
      name: 'GET /api/config/ answers with a trailing slash',
      path: '/api/config/',
      expect: { status: 200, schema: LOCAL_CALLER },
    },
    {
      name: 'HEAD /api/config answers the GET’s status with no body',
      method: 'HEAD',
      path: '/api/config',
      expect: { status: 200, headers: { 'cache-control': 'no-store' }, body: '' },
    },
    {
      name: 'GET /api/config tells a caller at another name it is not at this computer',
      path: '/api/config',
      headers: { host: REMOTE_HOST },
      expect: { status: 200, schema: REMOTE_CALLER },
    },
    {
      name: 'GET /api/config refuses a foreign host',
      path: '/api/config',
      headers: { host: 'evil.example' },
      expect: {
        status: 403,
        headers: JSON_TYPE,
        schema: z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose(),
      },
    },
    {
      name: 'GET /api/config/nope is the /api 404',
      path: '/api/config/nope',
      expect: { status: 404, body: NOT_FOUND },
    },
    // config: the write
    {
      name: 'PATCH /api/config with no body fails as it always has',
      method: 'PATCH',
      path: '/api/config',
      expect: { status: 500, headers: JSON_TYPE, body: { error: 'Internal server error' } },
    },
    {
      name: 'PATCH /api/config refuses a body that is not an object',
      method: 'PATCH',
      path: '/api/config',
      body: [1],
      expect: { status: 400, body: { error: 'Request body must be a JSON object' } },
    },
    {
      name: 'PATCH /api/config refuses malformed JSON in the chain',
      method: 'PATCH',
      path: '/api/config',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
      expect: { status: 500, schema: MALFORMED_JSON },
    },
    {
      name: 'PATCH /api/config refuses a body above the app-wide limit',
      method: 'PATCH',
      path: '/api/config',
      headers: { 'content-type': 'application/json' },
      body: BETWEEN_LIMITS,
      expect: { status: 413, headers: JSON_TYPE, body: TOO_LARGE },
    },
    {
      name: 'PATCH /api/config refuses an agent a protected setting',
      method: 'PATCH',
      path: '/api/config',
      headers: AGENT,
      body: { auth: { enabled: false } },
      expect: { status: 403, headers: JSON_TYPE, schema: OPERATOR_ONLY(['auth.enabled']) },
    },
    {
      name: 'PATCH /api/config refuses an approval token the same way',
      method: 'PATCH',
      path: '/api/config',
      headers: { 'X-DorkOS-Approval': 'abc' },
      body: { auth: { enabled: false } },
      expect: { status: 403, schema: OPERATOR_ONLY(['auth.enabled']) },
    },
    {
      name: 'PATCH /api/config saves an ordinary setting and answers the curated snapshot',
      method: 'PATCH',
      path: '/api/config',
      body: { logging: { level: 'info' } },
      expect: { status: 200, headers: JSON_TYPE, schema: SAVED },
    },
    {
      name: 'PATCH /api/config lets the app write a protected setting while login is off',
      method: 'PATCH',
      path: '/api/config',
      body: { auth: { enabled: false } },
      expect: { status: 200, schema: SAVED },
    },
    {
      name: 'PUT /api/config/agents/defaultAgent refuses a missing value',
      method: 'PUT',
      path: '/api/config/agents/defaultAgent',
      body: {},
      expect: {
        status: 400,
        body: { error: 'Body must include a non-empty "value" string' },
      },
    },
    {
      name: 'PUT /api/config/agents/defaultAgent refuses no body at all',
      method: 'PUT',
      path: '/api/config/agents/defaultAgent',
      expect: {
        status: 400,
        body: { error: 'Body must include a non-empty "value" string' },
      },
    },
    {
      name: 'PUT /api/config/agents/defaultAgent saves the trimmed name',
      method: 'PUT',
      path: '/api/config/agents/defaultAgent',
      body: { value: '  dorkbot  ' },
      expect: { status: 200, body: { success: true, defaultAgent: 'dorkbot' } },
    },
    {
      name: 'POST /api/config/mcp/reveal-token answers the local token',
      method: 'POST',
      path: '/api/config/mcp/reveal-token',
      expect: { status: 200, headers: JSON_TYPE, schema: LOCAL_TOKEN },
    },
    {
      name: 'POST /api/config/mcp/rotate-token answers a new local token',
      method: 'POST',
      path: '/api/config/mcp/rotate-token',
      expect: { status: 200, schema: LOCAL_TOKEN },
    },
    {
      name: 'GET /api/config/mcp/reveal-token is the /api 404',
      path: '/api/config/mcp/reveal-token',
      expect: { status: 404, body: NOT_FOUND },
    },
    // onboarding
    {
      name: 'POST /api/onboarding/first-run refuses a caller at another name',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { host: REMOTE_HOST },
      body: {},
      expect: {
        status: 403,
        headers: JSON_TYPE,
        body: { error: 'Setup is only available on this computer.' },
      },
    },
    {
      name: 'POST /api/onboarding/first-run refuses an agent',
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: AGENT,
      body: {},
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/first-run refuses a choice it does not know',
      method: 'POST',
      path: '/api/onboarding/first-run',
      body: { path: 'nowhere' },
      expect: { status: 400, body: { error: 'Choose how your agents run.' } },
    },
    {
      name: 'POST /api/onboarding/welcome refuses an agent',
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: AGENT,
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    },
    {
      name: 'POST /api/onboarding/welcome posts DorkBot’s welcome',
      method: 'POST',
      path: '/api/onboarding/welcome',
      expect: {
        status: 200,
        schema: z.object({ roomId: z.string(), entryId: z.string() }).strict(),
      },
    },
    {
      name: 'GET /api/onboarding/welcome is the /api 404',
      path: '/api/onboarding/welcome',
      expect: { status: 404, body: NOT_FOUND },
    },
    // mcp-config
    {
      name: 'GET /api/mcp-config refuses a missing path',
      path: '/api/mcp-config',
      expect: {
        status: 400,
        headers: JSON_TYPE,
        body: { error: 'Missing required query param: path' },
      },
    },
    {
      name: 'GET /api/mcp-config refuses a repeated path',
      path: '/api/mcp-config?path=a&path=b',
      expect: { status: 400, body: { error: 'Missing required query param: path' } },
    },
    {
      name: 'GET /api/mcp-config refuses a runtime this server does not run',
      path: '/api/mcp-config?path=.&runtime=nope',
      expect: { status: 400, body: { error: 'Unknown runtime: nope' } },
    },
    {
      name: 'GET /api/mcp-config refuses a path outside the boundary',
      path: '/api/mcp-config?path=/etc',
      expect: {
        status: 403,
        body: { error: 'Access denied: path outside directory boundary', code: 'OUTSIDE_BOUNDARY' },
      },
    },
    // feedback
    {
      name: 'POST /api/feedback refuses an empty submission',
      method: 'POST',
      path: '/api/feedback',
      body: {},
      expect: {
        status: 400,
        headers: JSON_TYPE,
        body: { error: 'Invalid feedback', code: 'INVALID_FEEDBACK' },
      },
    },
    {
      name: 'POST /api/feedback refuses no body at all',
      method: 'POST',
      path: '/api/feedback',
      expect: { status: 400, body: { error: 'Invalid feedback', code: 'INVALID_FEEDBACK' } },
    },
    {
      name: 'POST /api/feedback reads a body above the app-wide limit, then refuses it',
      method: 'POST',
      path: '/api/feedback',
      headers: { 'content-type': 'application/json' },
      body: BETWEEN_LIMITS,
      expect: { status: 400, body: { error: 'Invalid feedback', code: 'INVALID_FEEDBACK' } },
    },
    {
      name: 'POST /api/feedback refuses a body above its own 2 MB limit',
      method: 'POST',
      path: '/api/feedback',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_FEEDBACK_LIMIT,
      expect: { status: 413, headers: JSON_TYPE, body: TOO_LARGE },
    },
    {
      name: 'POST /api/feedback refuses malformed JSON in the chain',
      method: 'POST',
      path: '/api/feedback',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
      expect: { status: 500, schema: MALFORMED_JSON },
    },
    {
      name: 'GET /api/feedback/mine answers 502 when the site cannot be reached',
      path: '/api/feedback/mine',
      expect: {
        status: 502,
        headers: JSON_TYPE,
        body: { error: 'Could not reach the feedback service' },
      },
    },
    {
      name: 'POST /api/feedback/nope reads the larger body, then is the /api 404',
      method: 'POST',
      path: '/api/feedback/nope',
      headers: { 'content-type': 'application/json' },
      body: BETWEEN_LIMITS,
      expect: { status: 404, body: NOT_FOUND },
    },
    // canvas document events
    {
      name: 'POST /api/canvas/docs/:id/events answers an unknown document',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      body: {},
      expect: { status: 404, headers: JSON_TYPE, body: DOC_NOT_FOUND },
    },
    {
      name: 'POST /api/canvas/docs/:id/events refuses malformed JSON with its own words',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
      expect: {
        status: 400,
        headers: JSON_TYPE,
        body: { error: 'The document event is not valid.', code: 'INVALID_DOC_EVENT' },
      },
    },
    {
      name: 'POST /api/canvas/docs/:id/events refuses a body above its 16 KB limit',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_DOC_EVENT_LIMIT,
      expect: { status: 413, headers: JSON_TYPE, body: DOC_EVENT_TOO_LARGE },
    },
    {
      name: 'POST /api/canvas/docs/:id/events takes a body just inside the limit',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: { 'content-type': 'application/json' },
      body: jsonOfSize(15_000),
      expect: { status: 404, body: DOC_NOT_FOUND },
    },
    {
      name: 'POST /api/canvas/docs/:id/events refuses an unverified agent',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: AGENT,
      body: {},
      expect: {
        status: 401,
        body: { error: 'Sign in or use a valid agent token.', code: 'AGENT_IDENTITY_UNVERIFIED' },
      },
    },
    {
      name: 'a path under /api/canvas/docs no route serves still has the 16 KB limit',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/nope',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_DOC_EVENT_LIMIT,
      expect: { status: 413, body: DOC_EVENT_TOO_LARGE },
    },
    {
      name: 'a path under /api/canvas/docs no route serves is the /api 404',
      method: 'POST',
      path: '/api/canvas/docs/doc-1/nope',
      body: {},
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/canvas/docs/:id/channel answers an unknown document',
      path: '/api/canvas/docs/doc-1/channel',
      expect: { status: 404, body: DOC_NOT_FOUND },
    },
    {
      name: 'GET /api/canvas/docs/:id/channel refuses a cursor that is not a number',
      path: '/api/canvas/docs/doc-1/channel?since=abc',
      expect: {
        status: 400,
        body: { error: 'The document event or query is not valid.', code: 'INVALID_DOC_QUERY' },
      },
    },
    {
      name: 'GET /api/canvas/docs/:id/channel refuses a key it does not know',
      path: '/api/canvas/docs/doc-1/channel?other=1',
      expect: {
        status: 400,
        body: { error: 'The document event or query is not valid.', code: 'INVALID_DOC_QUERY' },
      },
    },
    {
      name: 'GET /api/canvas/docs/:id/events/:eventId refuses an id that is not one',
      path: '/api/canvas/docs/doc-1/events/not-an-id',
      expect: {
        status: 400,
        body: {
          error: 'The document event or query is not valid.',
          code: 'INVALID_DOC_EVENT_ID',
        },
      },
    },
    {
      name: 'GET /api/canvas/docs/:id/events/:eventId answers an unknown document',
      path: `/api/canvas/docs/doc-1/events/${UUID}`,
      expect: { status: 404, body: DOC_NOT_FOUND },
    },
    // debug
    {
      name: 'GET /api/debug/dispatches answers claims, holds and recent work',
      path: '/api/debug/dispatches',
      expect: { status: 200, headers: JSON_TYPE, schema: DISPATCHES },
    },
    {
      name: 'GET /api/debug/dispatches clamps a limit it cannot read',
      path: '/api/debug/dispatches?limit=lots',
      expect: { status: 200, schema: DISPATCHES },
    },
    {
      name: 'GET /api/debug/refusals answers the refusals',
      path: '/api/debug/refusals?limit=2',
      expect: { status: 200, schema: z.object({ refusals: z.array(z.unknown()) }).strict() },
    },
    {
      name: 'GET /api/debug/phantom-cancellations answers the counts',
      path: '/api/debug/phantom-cancellations',
      expect: {
        status: 200,
        schema: z.object({ total: z.number(), since: z.string() }).loose(),
      },
    },
    {
      name: 'GET /api/debug/auto-mode-stops answers the counts',
      path: '/api/debug/auto-mode-stops',
      expect: { status: 200, schema: z.object({ stops: z.number() }).loose() },
    },
    {
      name: 'GET /api/debug/projectors answers the live projectors',
      path: '/api/debug/projectors',
      expect: { status: 200, schema: z.object({ projectors: z.array(z.unknown()) }).strict() },
    },
    {
      name: 'GET /api/debug/sessions/:id refuses an id that is not one',
      path: '/api/debug/sessions/not-a-uuid',
      expect: { status: 400, body: { error: 'Invalid session ID', code: 'INVALID_SESSION_ID' } },
    },
    {
      name: 'GET /api/debug/sessions/:id answers a session nothing has bound',
      path: `/api/debug/sessions/${UUID}`,
      expect: {
        status: 200,
        schema: z
          .object({
            sessionId: z.literal(UUID),
            runtimeBound: z.literal(false),
            projectorLive: z.literal(false),
            durableEvents: z.object({ total: z.literal(0) }).loose(),
          })
          .loose(),
      },
    },
    {
      name: 'GET /api/debug/sessions/:id hides a session from an agent that may not read it',
      path: `/api/debug/sessions/${UUID}`,
      headers: AGENT,
      expect: { status: 404, body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' } },
    },
    {
      name: 'GET /api/debug/rooms/:id/bindings answers a room with none',
      path: '/api/debug/rooms/room-1/bindings',
      expect: { status: 200, body: { bindings: [] } },
    },
    {
      name: 'GET /api/debug/relay/traces/:traceId answers an unknown trace',
      path: '/api/debug/relay/traces/trace-1',
      expect: { status: 200, body: { spans: [], available: true } },
    },
    {
      name: 'GET /api/debug/doc-channels answers the document metrics',
      path: '/api/debug/doc-channels',
      expect: { status: 200, headers: JSON_TYPE, schema: DOC_METRICS },
    },
    {
      name: 'GET /api/debug/doc-channels refuses an agent',
      path: '/api/debug/doc-channels',
      headers: AGENT,
      expect: { status: 403, body: DOC_METRICS_FORBIDDEN },
    },
    {
      name: 'POST /api/debug/dispatches is the /api 404',
      method: 'POST',
      path: '/api/debug/dispatches',
      expect: { status: 404, body: NOT_FOUND },
    },
    // admin: arming, refusals, and the shared limiter
    {
      name: 'POST /api/admin/reset/prepare hands out a one-time token',
      method: 'POST',
      path: '/api/admin/reset/prepare',
      expect: {
        status: 200,
        headers: { ...JSON_TYPE, ...ADMIN_LIMIT(10, 9) },
        schema: z.object({ token: z.string().min(20) }).strict(),
      },
    },
    {
      name: 'POST /api/admin/reset refuses without a token, and does not count it',
      method: 'POST',
      path: '/api/admin/reset',
      body: { confirm: 'reset' },
      expect: { status: 403, headers: ADMIN_LIMIT(3, 2), body: RESET_TOKEN_REQUIRED },
    },
    {
      name: 'POST /api/admin/reset refuses a token it never minted, and does not count it',
      method: 'POST',
      path: '/api/admin/reset',
      body: { confirm: 'reset', token: 'nope' },
      expect: { status: 403, headers: ADMIN_LIMIT(3, 2), body: RESET_TOKEN_REQUIRED },
    },
    {
      name: 'POST /api/admin/reset refuses a missing confirm, and counts it (1 of 3)',
      method: 'POST',
      path: '/api/admin/reset',
      body: {},
      expect: { status: 400, headers: ADMIN_LIMIT(3, 2), body: BAD_CONFIRM },
    },
    {
      name: 'POST /api/admin/reset refuses no body at all, and counts it (2 of 3)',
      method: 'POST',
      path: '/api/admin/reset',
      expect: { status: 400, headers: ADMIN_LIMIT(3, 1), body: BAD_CONFIRM },
    },
    {
      name: 'POST /api/admin/reset/ refuses with a trailing slash too (3 of 3)',
      method: 'POST',
      path: '/api/admin/reset/',
      body: { confirm: 'nope' },
      expect: { status: 400, headers: ADMIN_LIMIT(3, 0), body: BAD_CONFIRM },
    },
    {
      name: 'POST /api/admin/reset is then refused by the limiter',
      method: 'POST',
      path: '/api/admin/reset',
      body: { confirm: 'reset' },
      expect: {
        status: 429,
        headers: { ...JSON_TYPE, ...ADMIN_LIMIT(3, 0), 'retry-after': /^\d+$/ },
        body: TOO_MANY_ADMIN,
      },
    },
    {
      name: 'POST /api/admin/restart shares the limiter, so it restarts nothing',
      method: 'POST',
      path: '/api/admin/restart',
      expect: { status: 429, headers: ADMIN_LIMIT(3, 0), body: TOO_MANY_ADMIN },
    },
    {
      name: 'POST /api/admin/reset/prepare keeps its own budget',
      method: 'POST',
      path: '/api/admin/reset/prepare',
      expect: { status: 200, headers: ADMIN_LIMIT(10, 8) },
    },
    {
      name: 'GET /api/admin/reset is the /api 404',
      path: '/api/admin/reset',
      expect: { status: 404, body: NOT_FOUND },
    },
    // test control
    {
      name: 'POST /api/test/scenario refuses no name',
      method: 'POST',
      path: '/api/test/scenario',
      body: {},
      expect: { status: 400, headers: JSON_TYPE, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/scenario refuses a scenario it does not know',
      method: 'POST',
      path: '/api/test/scenario',
      body: { name: 'no-such-scenario' },
      expect: {
        status: 400,
        schema: z.object({ error: z.string().startsWith('Unknown scenario') }).strict(),
      },
    },
    {
      name: 'POST /api/test/scenario sets the default scenario',
      method: 'POST',
      path: '/api/test/scenario',
      body: { name: 'simple-text' },
      expect: { status: 200, body: { ok: true, scenario: 'simple-text' } },
    },
    {
      name: 'POST /api/test/finish-turn answers ok',
      method: 'POST',
      path: '/api/test/finish-turn',
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'POST /api/test/interrupt-outcome refuses an outcome it does not know',
      method: 'POST',
      path: '/api/test/interrupt-outcome',
      body: { outcome: 'nah' },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/interrupt-outcome restores the default',
      method: 'POST',
      path: '/api/test/interrupt-outcome',
      body: { outcome: null },
      expect: { status: 200, body: { ok: true, outcome: null } },
    },
    {
      name: 'POST /api/test/step answers a session with nothing parked',
      method: 'POST',
      path: '/api/test/step',
      body: { sessionId: UUID },
      expect: { status: 200, body: { ok: true, released: false } },
    },
    {
      name: 'POST /api/test/step refuses an id that is not one',
      method: 'POST',
      path: '/api/test/step',
      body: { sessionId: 'nope' },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/canonical-id refuses a runtime this server does not run',
      method: 'POST',
      path: '/api/test/canonical-id',
      body: { sessionId: UUID, canonicalId: UUID, runtime: 'nope' },
      expect: { status: 500, body: { error: "Runtime 'nope' not registered" } },
    },
    {
      name: 'GET /api/test/persistent refuses no session',
      path: '/api/test/persistent',
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/persistent turns the held process off for a session',
      method: 'POST',
      path: '/api/test/persistent',
      body: { sessionId: UUID, enabled: false },
      expect: { status: 200, body: { ok: true, sessionId: UUID, enabled: false } },
    },
    {
      name: 'GET /api/test/persistent reads the runtime’s answer',
      path: `/api/test/persistent?sessionId=${UUID}`,
      expect: {
        status: 200,
        body: { enabled: false, warmth: 'cold', steerable: false, stageable: false },
      },
    },
    {
      name: 'POST /api/test/reap answers ok',
      method: 'POST',
      path: '/api/test/reap',
      body: { sessionId: UUID },
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'POST /api/test/room-worktree-commit refuses an incomplete body',
      method: 'POST',
      path: '/api/test/room-worktree-commit',
      body: { roomId: 'r' },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/room-worktree-commit refuses an agent nobody registered',
      method: 'POST',
      path: '/api/test/room-worktree-commit',
      body: { roomId: 'r', agentPath: '/nowhere', path: 'a.txt', text: 't' },
      expect: { status: 404, body: { error: 'No agent is registered at /nowhere' } },
    },
    {
      name: 'POST /api/test/agent-token refuses an agent nobody registered',
      method: 'POST',
      path: '/api/test/agent-token',
      body: { agentPath: '/nowhere' },
      expect: {
        status: 404,
        schema: z.object({ error: z.string().startsWith('No agent is registered at /nowhere') }),
      },
    },
    {
      name: 'POST /api/test/seed-approval refuses an incomplete body',
      method: 'POST',
      path: '/api/test/seed-approval',
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/seed-approval refuses an agent nobody registered',
      method: 'POST',
      path: '/api/test/seed-approval',
      body: { capabilityId: 'x', agentPath: '/nowhere', area: 'rooms', summary: 's' },
      expect: { status: 404, body: { error: 'No agent is registered at /nowhere.' } },
    },
    {
      name: 'POST /api/test/seed-agent refuses a slot it does not know',
      method: 'POST',
      path: '/api/test/seed-agent',
      body: { slot: 'nope' },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/seed-bridge refuses no agent',
      method: 'POST',
      path: '/api/test/seed-bridge',
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/probe-mcp-oauth-server refuses no agent',
      method: 'POST',
      path: '/api/test/probe-mcp-oauth-server',
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/probe-mcp-oauth-server answers a folder with no such server',
      method: 'POST',
      path: '/api/test/probe-mcp-oauth-server',
      body: { agentPath: '.', name: 'granola' },
      expect: {
        status: 200,
        schema: z
          .object({
            ok: z.literal(false),
            error: z.literal('server is not injectable (no manifest, or disabled)'),
            agentPath: z.string(),
            available: z.array(z.string()),
          })
          .strict(),
      },
    },
    {
      name: 'POST /api/test/connectors/request refuses a key it does not know',
      method: 'POST',
      path: '/api/test/connectors/request',
      body: { other: 1 },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/test/connectors/execute-read refuses a key it does not know',
      method: 'POST',
      path: '/api/test/connectors/execute-read',
      body: { other: 1 },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'GET /api/test/community-subscription refuses no room',
      path: '/api/test/community-subscription',
      expect: { status: 400, body: { error: 'A community ref and roomId are required.' } },
    },
    {
      name: 'GET /api/test/community-subscription answers a room it is not following',
      path: '/api/test/community-subscription?ref=a&roomId=b',
      expect: { status: 404, body: { error: 'Community room subscription is unavailable.' } },
    },
    {
      name: 'POST /api/test/community-connection-change answers ok',
      method: 'POST',
      path: '/api/test/community-connection-change',
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'GET /api/test/connect-approved answers the signed-in page',
      path: '/api/test/connect-approved',
      expect: {
        status: 200,
        headers: HTML_TYPE,
        body: '<!doctype html><html><head><title>Signed in</title></head><body><main><h1>Signed in</h1><p>You can close this tab and go back to DorkOS.</p></main></body></html>',
      },
    },
    {
      name: 'POST /api/test/reset answers ok',
      method: 'POST',
      path: '/api/test/reset',
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'GET /api/test/fake-cloud/approve answers a code nobody is waiting on',
      path: '/api/test/fake-cloud/approve?code=nope',
      expect: {
        status: 404,
        headers: { 'content-type': /^text\/plain\b/ },
        body: 'That code is not waiting for approval.',
      },
    },
    {
      name: 'GET /api/test/fake-inference/v1/models lists the fake model',
      path: '/api/test/fake-inference/v1/models',
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: z.object({ object: z.literal('list'), data: z.array(z.unknown()).length(1) }),
      },
    },
    {
      name: 'GET /api/test/nope is the /api 404',
      path: '/api/test/nope',
      expect: { status: 404, body: NOT_FOUND },
    },
    // the mock OAuth MCP server
    {
      name: 'GET /.well-known/oauth-protected-resource names the mock’s resource',
      path: '/.well-known/oauth-protected-resource',
      expect: { status: 200, headers: JSON_TYPE, schema: PROTECTED_RESOURCE(LOOPBACK_ORIGIN) },
    },
    {
      name: 'GET /.well-known/oauth-protected-resource/<resource> answers the same',
      path: '/.well-known/oauth-protected-resource/api/test/mcp-oauth/mcp',
      expect: { status: 200, schema: PROTECTED_RESOURCE(LOOPBACK_ORIGIN) },
    },
    {
      name: 'GET /.well-known/oauth-authorization-server names the endpoints',
      path: '/.well-known/oauth-authorization-server',
      expect: { status: 200, headers: JSON_TYPE, schema: AUTH_SERVER(LOOPBACK_ORIGIN) },
    },
    {
      name: 'GET /.well-known/oauth-authorization-server/<path> answers the same',
      path: '/.well-known/oauth-authorization-server/api/test/mcp-oauth/mcp',
      expect: { status: 200, schema: AUTH_SERVER(LOOPBACK_ORIGIN) },
    },
    {
      name: 'POST /api/test/mcp-oauth/register hands out a client',
      method: 'POST',
      path: '/api/test/mcp-oauth/register',
      body: { redirect_uris: ['http://127.0.0.1/cb'] },
      expect: {
        status: 201,
        headers: JSON_TYPE,
        schema: z
          .object({
            client_id: z.string().startsWith('mock-client-'),
            redirect_uris: z.tuple([z.literal('http://127.0.0.1/cb')]),
            token_endpoint_auth_method: z.literal('none'),
            client_name: z.literal('DorkOS'),
          })
          .loose(),
      },
    },
    {
      name: 'GET /api/test/mcp-oauth/authorize refuses a client nobody registered',
      path: '/api/test/mcp-oauth/authorize?client_id=nope',
      expect: {
        status: 400,
        headers: HTML_TYPE,
        body: 'unknown client_id; register through DCR first',
      },
    },
    {
      name: 'POST /api/test/mcp-oauth/token refuses a grant it does not offer',
      method: 'POST',
      path: '/api/test/mcp-oauth/token',
      headers: FORM,
      body: 'grant_type=password',
      expect: { status: 400, headers: JSON_TYPE, body: { error: 'unsupported_grant_type' } },
    },
    {
      name: 'POST /api/test/mcp-oauth/token refuses a refresh token it never issued',
      method: 'POST',
      path: '/api/test/mcp-oauth/token',
      headers: FORM,
      body: 'grant_type=refresh_token&refresh_token=nope',
      expect: { status: 400, body: { error: 'invalid_grant' } },
    },
    {
      name: 'POST /api/test/mcp-oauth/token reads a JSON body too',
      method: 'POST',
      path: '/api/test/mcp-oauth/token',
      body: { grant_type: 'authorization_code', code: 'nope' },
      expect: { status: 400, body: { error: 'invalid_grant' } },
    },
    {
      name: 'POST /api/test/mcp-oauth/token answers no body at all',
      method: 'POST',
      path: '/api/test/mcp-oauth/token',
      expect: { status: 400, body: { error: 'unsupported_grant_type' } },
    },
    {
      name: 'GET /api/test/mcp-oauth/mcp refuses no bearer, and says where to sign in',
      path: '/api/test/mcp-oauth/mcp',
      expect: {
        status: 401,
        headers: {
          ...JSON_TYPE,
          'www-authenticate': `Bearer resource_metadata="${SERVER_ORIGIN}/.well-known/oauth-protected-resource"`,
        },
        body: MCP_UNAUTHORIZED,
      },
    },
    {
      name: 'DELETE /api/test/mcp-oauth/mcp refuses a bearer it never issued',
      method: 'DELETE',
      path: '/api/test/mcp-oauth/mcp',
      headers: { authorization: 'Bearer mock-access-nope' },
      expect: { status: 401, body: MCP_UNAUTHORIZED },
    },
  ],
  { env: BASE_ENV }
);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to a server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** One raw answer, headers and all. */
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** Send one request and return the raw answer, whatever it is. */
function send(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  options: { body?: string; headers?: Record<string, string> } = {}
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(url, server!.baseUrl),
      { method, headers: options.headers ?? {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/**
 * Send one setup request and return its JSON body and headers, failing loudly
 * when the server refuses it.
 */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

/** The base64url S256 challenge for a PKCE verifier. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('contract: the mock OAuth sign-in, the fake inference stream and document metrics, driven by hand', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer(BASE_ENV);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  /** Register a client and authorize it, returning the code the callback is handed. */
  async function authorize(challenge: string): Promise<{ clientId: string; code: string }> {
    const registered = await setup(server, 'POST', '/api/test/mcp-oauth/register', {});
    const clientId = registered.json.client_id as string;
    const callback = `${server!.baseUrl}/api/agents/mcp-oauth/callback`;
    const answer = await send(
      server,
      'GET',
      `/api/test/mcp-oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}&code_challenge=${challenge}&state=s-1`
    );
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(callback);
    expect(location.searchParams.get('state')).toBe('s-1');
    expect(answer.headers['content-type']).toMatch(/^text\/plain\b/);
    expect(answer.text).toBe(`Found. Redirecting to ${answer.headers.location}`);
    return { clientId, code: location.searchParams.get('code')! };
  }

  /** Exchange a form at the token endpoint. */
  function token(form: string): Promise<Answer> {
    return send(server, 'POST', '/api/test/mcp-oauth/token', {
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }

  it('signs in from registration to a bearer the MCP endpoint takes', async () => {
    const verifier = `verifier-${randomUUID()}`;
    const registered = await setup(server, 'POST', '/api/test/mcp-oauth/register', {});
    // A redirect that is not the DorkOS callback is refused.
    await check(server, {
      path: `/api/test/mcp-oauth/authorize?client_id=${registered.json.client_id as string}&redirect_uri=${encodeURIComponent('http://evil.example/cb')}`,
      expect: {
        status: 400,
        headers: HTML_TYPE,
        body: 'redirect_uri must be the DorkOS loopback callback',
      },
    });

    // A wrong verifier spends the code.
    const first = await authorize(s256(verifier));
    const wrong = await token(
      `grant_type=authorization_code&code=${first.code}&code_verifier=nope`
    );
    expect([wrong.status, JSON.parse(wrong.text)]).toEqual([400, { error: 'invalid_grant' }]);
    const replay = await token(
      `grant_type=authorization_code&code=${first.code}&code_verifier=${verifier}`
    );
    expect(replay.status).toBe(400);

    const second = await authorize(s256(verifier));
    const granted = await token(
      `grant_type=authorization_code&code=${second.code}&code_verifier=${verifier}`
    );
    expect(granted.status).toBe(200);
    expect(granted.headers['content-type']).toMatch(/^application\/json\b/);
    const tokens = z
      .object({
        access_token: z.string().startsWith('mock-access-'),
        token_type: z.literal('Bearer'),
        expires_in: z.literal(3600),
        refresh_token: z.string().startsWith('mock-refresh-'),
      })
      .strict()
      .parse(JSON.parse(granted.text));

    // The refresh token rotates: it works once.
    const refreshed = await token(`grant_type=refresh_token&refresh_token=${tokens.refresh_token}`);
    expect(refreshed.status).toBe(200);
    const again = await token(`grant_type=refresh_token&refresh_token=${tokens.refresh_token}`);
    expect([again.status, JSON.parse(again.text)]).toEqual([400, { error: 'invalid_grant' }]);

    // The bearer opens the endpoint, which takes only a POST.
    const bearer = { authorization: `bearer ${tokens.access_token}` };
    await check(server, {
      path: '/api/test/mcp-oauth/mcp',
      headers: bearer,
      expect: {
        status: 405,
        headers: JSON_TYPE,
        body: {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed (stateless).' },
          id: null,
        },
      },
    });
    const initialized = await send(server, 'POST', '/api/test/mcp-oauth/mcp', {
      headers: {
        ...bearer,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'contract', version: '1' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers['content-type']).toBe('text/event-stream');
    expect(initialized.headers['x-content-type-options']).toBe('nosniff');
    const frame = initialized.text.split('\n').find((line) => line.startsWith('data: '));
    expect(JSON.parse(frame!.slice('data: '.length))).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'mock-oauth-mcp' } },
    });

    // A reset forgets every token.
    await setup(server, 'POST', '/api/test/reset');
    await check(server, {
      method: 'POST',
      path: '/api/test/mcp-oauth/mcp',
      headers: bearer,
      body: {},
      expect: { status: 401, body: MCP_UNAUTHORIZED },
    });
  });

  it('names its endpoints on the scheme a proxy forwarded', async () => {
    await check(server, {
      path: '/.well-known/oauth-authorization-server',
      headers: { 'x-forwarded-proto': 'https' },
      expect: { status: 200, schema: AUTH_SERVER(server!.baseUrl.replace(/^http:/, 'https:')) },
    });
  });

  it('streams the fake inference reply as an event stream', async () => {
    const answer = await send(server, 'POST', '/api/test/fake-inference/v1/chat/completions', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'contract-model', messages: [] }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('text/event-stream');
    expect(answer.headers['cache-control']).toBe('no-cache');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    const frames = answer.text.split('\n\n').filter(Boolean);
    expect(frames.at(-1)).toBe('data: [DONE]');
    const first = JSON.parse(frames[0]!.slice('data: '.length)) as Record<string, unknown>;
    expect(first).toMatchObject({
      object: 'chat.completion.chunk',
      model: 'contract-model',
      choices: [{ index: 0, delta: { role: 'assistant' } }],
    });
  });

  it('counts a document event refused for its size in the document metrics', async () => {
    const TOO_LARGE_COUNT = z
      .object({
        requestAttempts: z
          .object({ rejectedRequestsByClass: z.object({ too_large: z.number() }).loose() })
          .loose(),
      })
      .loose();
    const before = TOO_LARGE_COUNT.parse(
      (await setup(server, 'GET', '/api/debug/doc-channels')).json
    );
    await check(server, {
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_DOC_EVENT_LIMIT,
      expect: { status: 413, body: DOC_EVENT_TOO_LARGE },
    });
    const after = TOO_LARGE_COUNT.parse(
      (await setup(server, 'GET', '/api/debug/doc-channels')).json
    );
    expect(after.requestAttempts.rejectedRequestsByClass.too_large).toBe(
      before.requestAttempts.rejectedRequestsByClass.too_large + 1
    );
  });
});

/** What the desktop app tells a person who asks the server to restart itself. */
const DESKTOP_RESTART =
  'The DorkOS app starts and stops the server for you, so restarting it from here would leave you with no server running. Quit DorkOS and open it again instead. That does the same thing.';
/** What it tells a person who asks for a reset; the data folder is named. */
const DESKTOP_RESET = z
  .object({
    error: z
      .string()
      .startsWith('The DorkOS app starts and stops the server for you, so it cannot reset itself'),
    code: z.literal('MANAGED_BY_DESKTOP'),
  })
  .strict();
const DESKTOP_GENERIC = {
  error:
    'The DorkOS app starts and stops the server for you, so this action is not available here.',
  code: 'MANAGED_BY_DESKTOP',
};

contractSuite(
  'admin and test-only groups outside test mode, under the desktop app',
  [
    {
      name: 'POST /api/admin/restart is refused while the desktop app runs the server',
      method: 'POST',
      path: '/api/admin/restart',
      expect: {
        status: 409,
        headers: { ...JSON_TYPE, 'x-ratelimit-limit': null },
        body: { error: DESKTOP_RESTART, code: 'MANAGED_BY_DESKTOP' },
      },
    },
    {
      name: 'POST /api/admin/restart is refused every time, never rate limited',
      method: 'POST',
      path: '/api/admin/restart',
      expect: { status: 409, body: { error: DESKTOP_RESTART, code: 'MANAGED_BY_DESKTOP' } },
    },
    {
      name: 'POST /api/admin/reset is refused with the reset’s own words',
      method: 'POST',
      path: '/api/admin/reset',
      body: { confirm: 'reset' },
      expect: { status: 409, schema: DESKTOP_RESET },
    },
    {
      name: 'POST /api/admin/reset/ is refused with a trailing slash too',
      method: 'POST',
      path: '/api/admin/reset/',
      body: { confirm: 'reset' },
      expect: { status: 409, schema: DESKTOP_RESET },
    },
    {
      name: 'POST /api/admin/Reset is refused in any case',
      method: 'POST',
      path: '/api/admin/Reset',
      body: { confirm: 'reset' },
      expect: { status: 409, schema: DESKTOP_RESET },
    },
    {
      name: 'POST /api/admin/reset/prepare is refused with the reset’s own words',
      method: 'POST',
      path: '/api/admin/reset/prepare',
      expect: { status: 409, schema: DESKTOP_RESET },
    },
    {
      name: 'GET /api/admin/anything is refused, not answered 404',
      path: '/api/admin/anything',
      expect: { status: 409, body: DESKTOP_GENERIC },
    },
    {
      name: 'GET /api/admin is refused too',
      path: '/api/admin',
      expect: { status: 409, body: DESKTOP_GENERIC },
    },
    {
      name: 'POST /api/test/scenario does not exist outside test mode',
      method: 'POST',
      path: '/api/test/scenario',
      body: { name: 'simple-text' },
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST /api/test/reset does not exist outside test mode',
      method: 'POST',
      path: '/api/test/reset',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/test/connect-approved does not exist outside test mode',
      path: '/api/test/connect-approved',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/test/fake-inference/v1/models does not exist outside test mode',
      path: '/api/test/fake-inference/v1/models',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/test/route-census does not exist outside test mode',
      path: '/api/test/route-census',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST /api/test/mcp-oauth/register does not exist outside test mode',
      method: 'POST',
      path: '/api/test/mcp-oauth/register',
      body: {},
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/test/mcp-oauth/mcp does not exist outside test mode',
      path: '/api/test/mcp-oauth/mcp',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /.well-known/oauth-protected-resource does not exist outside test mode',
      path: '/.well-known/oauth-protected-resource',
      expect: { status: 404, headers: HTML_TYPE },
    },
    {
      name: 'GET /.well-known/oauth-authorization-server does not exist outside test mode',
      path: '/.well-known/oauth-authorization-server',
      expect: { status: 404, headers: HTML_TYPE },
    },
    {
      name: 'GET /api/config still answers outside test mode',
      path: '/api/config',
      expect: { status: 200, schema: LOCAL_CALLER },
    },
  ],
  { env: { ...NO_SITE, DORKOS_TEST_RUNTIME: 'false', DORKOS_MANAGED_BY: 'desktop' } }
);

describe('contract: the same groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer(BASE_ENV);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = {
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/config'],
      ['PATCH', '/api/config'],
      ['POST', '/api/config/mcp/reveal-token'],
      ['POST', '/api/onboarding/welcome'],
      ['GET', '/api/mcp-config?path=.'],
      ['POST', '/api/feedback'],
      ['GET', '/api/feedback/mine'],
      ['POST', '/api/canvas/docs/doc-1/events'],
      ['GET', '/api/debug/dispatches'],
      ['POST', '/api/admin/reset/prepare'],
      ['POST', '/api/admin/restart'],
      ['POST', '/api/test/scenario'],
      ['GET', '/api/test/connect-approved'],
      ['POST', '/api/test/mcp-oauth/register'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('applies the body limits before the session gate', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/feedback',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_FEEDBACK_LIMIT,
      expect: { status: 413, body: TOO_LARGE },
    });
    await check(server, {
      method: 'POST',
      path: '/api/feedback',
      headers: { 'content-type': 'application/json' },
      body: BETWEEN_LIMITS,
      expect: { status: 401, schema: AUTH_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/canvas/docs/doc-1/events',
      headers: { 'content-type': 'application/json' },
      body: ABOVE_DOC_EVENT_LIMIT,
      expect: { status: 413, body: DOC_EVENT_TOO_LARGE },
    });
  });

  it('leaves the mock OAuth discovery open, as it always was', async () => {
    await check(server, {
      path: '/.well-known/oauth-protected-resource',
      expect: { status: 200, schema: PROTECTED_RESOURCE(LOOPBACK_ORIGIN) },
    });
  });

  it('lets an API key read, but not change a protected setting', async () => {
    await check(server, {
      path: '/api/config',
      headers: apiKey,
      expect: { status: 200, schema: LOCAL_CALLER },
    });
    await check(server, {
      method: 'PATCH',
      path: '/api/config',
      headers: apiKey,
      body: { auth: { enabled: false } },
      expect: {
        status: 403,
        body: {
          error: 'Only a person can change those settings',
          code: 'operator_cookie_required',
          paths: ['auth.enabled'],
          message:
            'Only a person signed in to DorkOS can change the settings that protect this instance',
        },
      },
    });
    await check(server, {
      method: 'PATCH',
      path: '/api/config',
      headers: apiKey,
      body: { logging: { level: 'info' } },
      expect: { status: 200, schema: SAVED },
    });
  });

  it('keeps the local MCP token out of reach while login is on', async () => {
    for (const action of ['reveal-token', 'rotate-token']) {
      await check(server, {
        method: 'POST',
        path: `/api/config/mcp/${action}`,
        headers: cookie,
        expect: {
          status: 409,
          body: {
            error:
              'The local MCP token does not apply while login is on — clients authenticate with their personal API keys.',
          },
        },
      });
    }
  });

  it('keeps document metrics and setup to the owner’s cookie', async () => {
    await check(server, {
      path: '/api/debug/doc-channels',
      headers: apiKey,
      expect: { status: 403, body: DOC_METRICS_FORBIDDEN },
    });
    await check(server, {
      path: '/api/debug/doc-channels',
      headers: cookie,
      expect: { status: 200, schema: DOC_METRICS },
    });
    await check(server, {
      path: '/api/debug/dispatches',
      headers: apiKey,
      expect: { status: 200, schema: DISPATCHES },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/welcome',
      headers: apiKey,
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...apiKey, origin: server!.baseUrl },
      body: {},
      expect: { status: 403, body: SETUP_REFUSED('not-a-person') },
    });
    await check(server, {
      method: 'POST',
      path: '/api/onboarding/first-run',
      headers: { ...cookie, origin: server!.baseUrl },
      body: {},
      expect: { status: 400, body: { error: 'Choose how your agents run.' } },
    });
  });
});
