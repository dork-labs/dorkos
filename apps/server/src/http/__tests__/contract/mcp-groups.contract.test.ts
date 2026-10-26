/**
 * Contract for the external MCP endpoint (`/mcp`), which moves to Hono in
 * DOR-2808. That PR must pass this file unchanged.
 *
 * `/mcp` is not under `/api`, so it skips the API host guard and has gates of
 * its own, in this order: the browser `Origin` check, the on/off switch, the
 * fail-closed credential check (`middleware/mcp-auth.ts`), then the rate
 * limiter. Every one of its acceptors and refusals is a case here.
 *
 * Every server is a `DORKOS_TEST_RUNTIME` one, which registers no Claude Code
 * runtime, so a request that clears every gate is answered by the endpoint's
 * own JSON-RPC `500` ("Internal error"): the tool server cannot be built. That
 * answer is what "let in" looks like below, and it is distinct from every
 * refusal (`401`, `403`, `429`, `503`). The MCP exchange itself, through the
 * SDK's transport, is pinned by the route's own tests.
 *
 * Three servers:
 *
 * 1. Login off: the origin refusals, the switch, the methods stateless mode
 *    refuses, the tokenless read-only carve-out, the local token, every
 *    malformed credential, a malformed and an oversize body.
 * 2. Login off, then on, driven by hand: a person's API key and session cookie
 *    are let in with login off; once login is on the session gate answers
 *    first, and the local token stops counting.
 * 3. `MCP_API_KEY` set, a legacy `config.mcp.apiKey` not yet folded into an
 *    account, and a limit of three calls a minute: both keys are let in, the
 *    401 names no token file, and the fourth call is refused.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
  stepUpAt,
} from './harness.js';

/** Stands for this server's local MCP token, which is only known once it boots. */
const LOCAL_TOKEN = '{{local-token}}';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOSNIFF = { 'x-content-type-options': 'nosniff' };
/** A JSON-RPC error envelope, as every `/mcp` refusal is written. */
const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});
/** Cleared every gate; the test runtime has no tool server to build. */
const LET_IN = rpcError(-32603, 'Internal error');
const STATELESS = rpcError(-32000, 'Method not allowed. This server operates in stateless mode.');
const DISABLED = rpcError(-32000, 'External MCP access is disabled.');
const RATE_LIMITED = rpcError(-32029, 'Rate limit exceeded. Try again shortly.');
/** The login-off 401: names the token file and the header, never the token. */
const NEEDS_LOCAL_TOKEN = z
  .object({
    jsonrpc: z.literal('2.0'),
    error: z
      .object({
        code: z.literal(-32001),
        message: z
          .string()
          .regex(
            /^Unauthorized\. This DorkOS tool needs your local MCP token\. Find it in Settings → Advanced → Tools → Connect other apps to DorkOS, or in .+mcp-local-token, and send it as "Authorization: Bearer <token>"\.$/
          )
          .refine((message) => !message.includes('dork_mcp_local_'), 'echoes the token'),
      })
      .strict(),
    id: z.null(),
  })
  .strict();
/** The 401 where no local token applies: it points at the credential that does. */
const NEEDS_CREDENTIAL = rpcError(
  -32001,
  'Unauthorized. Provide a valid credential as "Authorization: Bearer <token>". ' +
    'Use your personal API key from Settings → Advanced → Tools → Connect other apps to DorkOS.'
);
const AUTH_REQUIRED = { error: 'Unauthorized', code: 'AUTH_REQUIRED' };
const NOT_ALLOWED_BY_CORS = (origin: string) => ({
  error: `Origin ${origin} not allowed by CORS`,
  code: 'INTERNAL_ERROR',
});
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR'), error: z.string() }).strict();
const TOO_LARGE = { error: 'That is too large to send in one request.', code: 'REQUEST_TOO_LARGE' };

/** A JSON-RPC request. */
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});
const INITIALIZE = rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'contract', version: '1.0.0' },
});
/** A tool that changes things: never tokenless. */
const MUTATING_CALL = rpc('tools/call', { name: 'tasks_create', arguments: {} });
/** A read-only tool in the tokenless carve-out. */
const READ_ONLY_CALL = rpc('tools/call', { name: 'ping', arguments: {} });
/** What an MCP client sends. */
const MCP_CLIENT = { accept: 'application/json, text/event-stream' };
const WITH_TOKEN = { ...MCP_CLIENT, authorization: `Bearer ${LOCAL_TOKEN}` };
/** The limiter's headers on a call it counted, under the default 60 a minute. */
const COUNTED = {
  'ratelimit-policy': '60;w=60',
  'ratelimit-limit': '60',
  'ratelimit-remaining': /^\d+$/,
  'ratelimit-reset': /^\d+$/,
};
/** A call the limiter never saw. */
const NOT_COUNTED = { 'ratelimit-limit': null };

/** Send one case, with this server's origin and local token filled in. */
async function check(
  server: ComposedServer | undefined,
  testCase: Omit<ContractCase, 'name'> & { name?: string },
  token = ''
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(testCase.headers ?? {})) {
    headers[name] = value.replaceAll(LOCAL_TOKEN, token);
  }
  await checkContractCase(server!.baseUrl, {
    name: testCase.path,
    ...testCase,
    headers,
  } as ContractCase);
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

/** This server's local MCP token, as Settings reveals it. */
async function revealLocalToken(server: ComposedServer | undefined): Promise<string> {
  const { json } = await setup(server, 'POST', '/api/config/mcp/reveal-token');
  const token = json.localToken;
  if (typeof token !== 'string') throw new Error('No local MCP token was revealed');
  return token;
}

/** The cases server 1 runs, in order. */
const LOGIN_OFF_CASES: readonly ContractCase[] = [
  // The methods stateless mode has no use for, behind the credential check.
  {
    name: 'GET /mcp with no token is refused: no body is no discovery call',
    path: '/mcp',
    expect: {
      status: 401,
      headers: { ...JSON_TYPE, ...NOSNIFF, ...NOT_COUNTED },
      schema: NEEDS_LOCAL_TOKEN,
    },
  },
  {
    name: 'GET /mcp with the local token is refused: there is no stream in stateless mode',
    path: '/mcp',
    headers: WITH_TOKEN,
    expect: { status: 405, headers: { ...JSON_TYPE, ...NOSNIFF, ...COUNTED }, body: STATELESS },
  },
  {
    name: 'GET /mcp/ answers the same with a trailing slash',
    path: '/mcp/',
    headers: WITH_TOKEN,
    expect: { status: 405, body: STATELESS },
  },
  {
    name: 'HEAD /mcp with the local token answers the GET’s status with no body',
    method: 'HEAD',
    path: '/mcp',
    headers: WITH_TOKEN,
    expect: { status: 405, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'DELETE /mcp with no token is refused',
    method: 'DELETE',
    path: '/mcp',
    expect: { status: 401, schema: NEEDS_LOCAL_TOKEN },
  },
  {
    name: 'DELETE /mcp with the local token is refused: there is no session to end',
    method: 'DELETE',
    path: '/mcp',
    headers: WITH_TOKEN,
    expect: { status: 405, headers: { ...JSON_TYPE, ...COUNTED }, body: STATELESS },
  },

  // The tokenless carve-out: the handshake, discovery and read-only tools.
  ...(
    [
      ['initialize', INITIALIZE],
      ['ping', rpc('ping')],
      ['tools/list', rpc('tools/list')],
      ['resources/list', rpc('resources/list')],
      ['resources/templates/list', rpc('resources/templates/list')],
      ['prompts/list', rpc('prompts/list')],
      ['notifications/initialized', rpc('notifications/initialized', undefined, null)],
      ['a read-only tools/call', READ_ONLY_CALL],
      ['a batch of discovery calls', [rpc('ping'), rpc('tools/list', undefined, 2)]],
    ] as const
  ).map(([what, body]): ContractCase => ({
    name: `POST /mcp lets ${what} in with no token`,
    method: 'POST',
    path: '/mcp',
    headers: MCP_CLIENT,
    body,
    expect: { status: 500, headers: { ...JSON_TYPE, ...NOSNIFF, ...COUNTED }, body: LET_IN },
  })),

  // Everything else needs the token, and fails closed.
  ...(
    [
      ['a mutating tools/call', MUTATING_CALL],
      ['a tools/call naming no tool', rpc('tools/call', {})],
      ['a tools/call of a tool that does not exist', rpc('tools/call', { name: 'no_such_tool' })],
      ['resources/read', rpc('resources/read', { uri: 'file:///etc/hosts' })],
      ['an unknown method', rpc('no/such/method')],
      ['a message with no method', { jsonrpc: '2.0', id: 1 }],
      ['a batch with one guarded call', [rpc('ping'), MUTATING_CALL]],
      ['an empty batch', []],
    ] as const
  ).map(([what, body]): ContractCase => ({
    name: `POST /mcp refuses ${what} with no token`,
    method: 'POST',
    path: '/mcp',
    headers: MCP_CLIENT,
    body,
    expect: {
      status: 401,
      headers: { ...JSON_TYPE, ...NOSNIFF, ...NOT_COUNTED },
      schema: NEEDS_LOCAL_TOKEN,
    },
  })),
  {
    name: 'POST /mcp refuses a body that is not JSON with no token: it parses as nothing',
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_CLIENT, 'content-type': 'text/plain' },
    body: JSON.stringify(READ_ONLY_CALL),
    expect: { status: 401, schema: NEEDS_LOCAL_TOKEN },
  },

  // Credentials that are not the local token.
  ...(
    [
      ['a wrong bearer token', `Bearer dork_mcp_local_${'0'.repeat(64)}`],
      ['the local token under another scheme', `Basic ${LOCAL_TOKEN}`],
      ['the local token under a lower-case scheme', `bearer ${LOCAL_TOKEN}`],
      ['a bare token with no scheme', LOCAL_TOKEN],
      ['a scheme with no token', 'Bearer'],
    ] as const
  ).map(([what, authorization]): ContractCase => ({
    name: `POST /mcp refuses a mutating call carrying ${what}`,
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_CLIENT, authorization },
    body: MUTATING_CALL,
    expect: { status: 401, headers: NOT_COUNTED, schema: NEEDS_LOCAL_TOKEN },
  })),
  {
    name: 'POST /mcp lets a mutating call in with the local token',
    method: 'POST',
    path: '/mcp',
    headers: WITH_TOKEN,
    body: MUTATING_CALL,
    expect: { status: 500, headers: { ...JSON_TYPE, ...COUNTED }, body: LET_IN },
  },
  {
    name: 'POST /mcp lets a body that is not JSON through with the local token',
    method: 'POST',
    path: '/mcp',
    headers: { ...WITH_TOKEN, 'content-type': 'text/plain' },
    body: 'not json',
    expect: { status: 500, body: LET_IN },
  },
  {
    name: 'POST /mcp lets an agent’s call in on the local token, its own token unverified',
    method: 'POST',
    path: '/mcp',
    headers: { ...WITH_TOKEN, 'X-DorkOS-Agent': 'not-a-real-agent-token' },
    body: MUTATING_CALL,
    expect: { status: 500, body: LET_IN },
  },

  // Bodies the chain refuses before any gate of `/mcp`'s own.
  {
    name: 'POST /mcp answers malformed JSON with the error handler’s 500',
    method: 'POST',
    path: '/mcp',
    headers: { ...WITH_TOKEN, 'content-type': 'application/json' },
    body: '{"jsonrpc":',
    expect: {
      status: 500,
      headers: { ...JSON_TYPE, ...NOT_COUNTED },
      schema: MALFORMED_JSON,
    },
  },
  {
    name: 'POST /mcp answers a top-level JSON string with the error handler’s 500',
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: '"initialize"',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /mcp refuses a body over a megabyte, with no token',
    method: 'POST',
    path: '/mcp',
    headers: MCP_CLIENT,
    body: { ...INITIALIZE, padding: 'x'.repeat(1_100_000) },
    expect: { status: 413, headers: { ...JSON_TYPE, ...NOT_COUNTED }, body: TOO_LARGE },
  },
  {
    name: 'POST /mcp refuses a body over a megabyte, with the token',
    method: 'POST',
    path: '/mcp',
    headers: WITH_TOKEN,
    body: { ...MUTATING_CALL, padding: 'x'.repeat(1_100_000) },
    expect: { status: 413, body: TOO_LARGE },
  },

  // Browser origins.
  {
    name: 'POST /mcp lets a call from this server’s own page in',
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_CLIENT, origin: SERVER_ORIGIN },
    body: rpc('ping'),
    expect: {
      status: 500,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      body: LET_IN,
    },
  },
  {
    name: 'POST /mcp lets a call from this computer’s localhost page in',
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_CLIENT, origin: SERVER_ORIGIN.replace('127.0.0.1', 'localhost') },
    body: rpc('ping'),
    expect: { status: 500, body: LET_IN },
  },
  {
    name: 'OPTIONS /mcp answers a preflight from this server’s own page',
    method: 'OPTIONS',
    path: '/mcp',
    headers: { origin: SERVER_ORIGIN, 'access-control-request-method': 'POST' },
    expect: {
      status: 204,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
      },
      body: '',
    },
  },
  {
    name: 'POST /mcp refuses a foreign page at CORS, even with the token',
    method: 'POST',
    path: '/mcp',
    headers: { ...WITH_TOKEN, origin: 'https://evil.example' },
    body: rpc('ping'),
    expect: {
      status: 500,
      headers: { ...NOT_COUNTED, 'access-control-allow-origin': null },
      body: NOT_ALLOWED_BY_CORS('https://evil.example'),
    },
  },
  {
    name: 'POST /mcp refuses an opaque origin at CORS',
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_CLIENT, origin: 'null' },
    body: rpc('ping'),
    expect: { status: 500, body: NOT_ALLOWED_BY_CORS('null') },
  },
  {
    // A rebound page names a host that is not this computer, so it is another
    // device, which the session gate asks for a person session even with login
    // off (ADR 261015-125850 rule 3). The local token is not one. The `/mcp`
    // origin check behind the gate is pinned with a real key in the login-on
    // suite below.
    name: 'POST /mcp refuses a page rebound onto this port at the session gate, local token or not',
    method: 'POST',
    path: '/mcp',
    headers: {
      ...WITH_TOKEN,
      host: 'evil.example:4242',
      origin: 'http://evil.example:4242',
    },
    body: rpc('ping'),
    expect: {
      status: 401,
      headers: { ...JSON_TYPE, ...NOT_COUNTED },
      body: AUTH_REQUIRED,
    },
  },
];

describe('contract: the /mcp endpoint, login off', () => {
  let server: ComposedServer | undefined;
  let token = '';
  beforeAll(async () => {
    server = await bootComposedServer();
    token = await revealLocalToken(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it.each(LOGIN_OFF_CASES.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    await check(server, testCase, token);
  });

  it('answers 503 while switched off, before the credential check, and a rebound page is refused at the gate first', async () => {
    await setup(server, 'PATCH', '/api/config', { mcp: { enabled: false } });
    try {
      for (const headers of [MCP_CLIENT, WITH_TOKEN]) {
        await check(
          server,
          {
            method: 'POST',
            path: '/mcp',
            headers,
            body: MUTATING_CALL,
            expect: {
              status: 503,
              headers: { ...JSON_TYPE, ...NOSNIFF, ...NOT_COUNTED },
              body: DISABLED,
            },
          },
          token
        );
      }
      await check(server, { path: '/mcp', expect: { status: 503, body: DISABLED } }, token);
      await check(
        server,
        {
          method: 'POST',
          path: '/mcp',
          headers: { host: 'evil.example:4242', origin: 'http://evil.example:4242' },
          body: rpc('ping'),
          // Another device: the session gate answers before the switch.
          expect: { status: 401, body: AUTH_REQUIRED },
        },
        token
      );
    } finally {
      await setup(server, 'PATCH', '/api/config', { mcp: { enabled: true } });
    }
    await check(
      server,
      {
        method: 'POST',
        path: '/mcp',
        headers: WITH_TOKEN,
        body: MUTATING_CALL,
        expect: { status: 500, body: LET_IN },
      },
      token
    );
  });
});

describe('contract: the /mcp endpoint with a person’s credentials, login off then on', () => {
  let server: ComposedServer | undefined;
  let token = '';
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer();
    token = await revealLocalToken(server);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    // The owner's step-up at this computer: its cookie and the app's proof (DOR-3330).
    cookie = await stepUpAt(server.baseUrl, OWNER.password);
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'mcp' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('lets a mutating call in on a person’s API key or session cookie while login is off', async () => {
    for (const credential of [apiKey, cookie]) {
      await check(server, {
        method: 'POST',
        path: '/mcp',
        headers: { ...MCP_CLIENT, ...credential },
        body: MUTATING_CALL,
        expect: { status: 500, headers: COUNTED, body: LET_IN },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, authorization: 'Bearer not-a-real-api-key' },
      body: MUTATING_CALL,
      expect: { status: 401, schema: NEEDS_LOCAL_TOKEN },
    });
  });

  it('answers at the session gate once login is on, where the local token no longer counts', async () => {
    // Asking for a password is the owner's own act, after their step-up (DOR-3330).
    await setup(
      server,
      'PATCH',
      '/api/config',
      { auth: { enabled: true } },
      await stepUpAt(server!.baseUrl, 'a-long-password-1')
    );
    for (const [headers, body] of [
      [MCP_CLIENT, MUTATING_CALL],
      // The tokenless carve-out ends with login on.
      [MCP_CLIENT, INITIALIZE],
      [MCP_CLIENT, READ_ONLY_CALL],
      [WITH_TOKEN, MUTATING_CALL],
      [{ ...MCP_CLIENT, authorization: 'Bearer not-a-real-api-key' }, rpc('ping')],
    ] as const) {
      await check(
        server,
        {
          method: 'POST',
          path: '/mcp',
          headers,
          body,
          expect: { status: 401, headers: { ...JSON_TYPE, ...NOT_COUNTED }, body: AUTH_REQUIRED },
        },
        token
      );
    }
    await check(server, { path: '/mcp', expect: { status: 401, body: AUTH_REQUIRED } }, token);
  });

  it('lets a mutating call in on a person’s API key or session cookie once login is on', async () => {
    for (const credential of [apiKey, cookie]) {
      await check(server, {
        method: 'POST',
        path: '/mcp',
        headers: { ...MCP_CLIENT, ...credential },
        body: MUTATING_CALL,
        expect: { status: 500, headers: COUNTED, body: LET_IN },
      });
      await check(server, {
        path: '/mcp',
        headers: { ...MCP_CLIENT, ...credential },
        expect: { status: 405, body: STATELESS },
      });
    }
  });

  it('still checks the origin and the switch before a signed-in caller', async () => {
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...apiKey, host: 'evil.example:4242', origin: 'http://evil.example:4242' },
      body: rpc('ping'),
      expect: {
        status: 403,
        body: rpcError(-32002, 'Origin http://evil.example:4242 not allowed'),
      },
    });
    await setup(server, 'PATCH', '/api/config', { mcp: { enabled: false } }, cookie);
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, ...apiKey },
      body: MUTATING_CALL,
      expect: { status: 503, body: DISABLED },
    });
    await setup(server, 'PATCH', '/api/config', { mcp: { enabled: true } }, cookie);
  });
});

describe('contract: the /mcp endpoint with MCP_API_KEY, a legacy key and a tight limit', () => {
  const ENV_KEY = `contract-env-key-${randomUUID()}`;
  const LEGACY_KEY = `dork_mcp_${randomUUID().replaceAll('-', '')}`;
  let server: ComposedServer | undefined;
  let dorkHome = '';

  beforeAll(async () => {
    // A data directory written before the first boot, as an upgraded install's
    // is: the legacy key stays in `config.json` until an owner exists.
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-contract-mcp-'));
    await writeFile(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({
        mcp: {
          enabled: true,
          apiKey: LEGACY_KEY,
          rateLimit: { enabled: true, maxPerWindow: 3, windowSecs: 60 },
        },
      })
    );
    server = await bootComposedServer({ DORK_HOME: dorkHome, MCP_API_KEY: ENV_KEY });
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    await rm(dorkHome, { recursive: true, force: true });
  }, 30_000);

  const TIGHT = { 'ratelimit-policy': '3;w=60', 'ratelimit-limit': '3' };

  it('counts the calls it lets in, not the ones it refuses, and refuses the fourth', async () => {
    // (1) The env key, highest priority.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, authorization: `Bearer ${ENV_KEY}` },
      body: MUTATING_CALL,
      expect: {
        status: 500,
        headers: { ...TIGHT, 'ratelimit-remaining': '2', 'retry-after': null },
        body: LET_IN,
      },
    });
    // Refused before the limiter: no local token applies, so the 401 points at
    // the credential that does.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, authorization: 'Bearer dork_mcp_not_the_key' },
      body: MUTATING_CALL,
      expect: { status: 401, headers: NOT_COUNTED, body: NEEDS_CREDENTIAL },
    });
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: MCP_CLIENT,
      body: MUTATING_CALL,
      expect: { status: 401, headers: NOT_COUNTED, body: NEEDS_CREDENTIAL },
    });
    // (2) The legacy key, while no owner account exists to fold it into.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, authorization: `Bearer ${LEGACY_KEY}` },
      body: MUTATING_CALL,
      expect: { status: 500, headers: { ...TIGHT, 'ratelimit-remaining': '1' }, body: LET_IN },
    });
    // (3) A tokenless discovery call is counted too.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: MCP_CLIENT,
      body: rpc('tools/list'),
      expect: { status: 500, headers: { ...TIGHT, 'ratelimit-remaining': '0' }, body: LET_IN },
    });
    // (4) Over the limit, whatever the credential.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_CLIENT, authorization: `Bearer ${ENV_KEY}` },
      body: MUTATING_CALL,
      expect: {
        status: 429,
        headers: {
          ...JSON_TYPE,
          ...NOSNIFF,
          ...TIGHT,
          'ratelimit-remaining': '0',
          'retry-after': /^\d+$/,
        },
        body: RATE_LIMITED,
      },
    });
    await check(server, {
      path: '/mcp',
      headers: { authorization: `Bearer ${ENV_KEY}` },
      expect: { status: 429, body: RATE_LIMITED },
    });
    // Still refused at the credential check first: a 401 is never a 429.
    await check(server, {
      method: 'POST',
      path: '/mcp',
      headers: MCP_CLIENT,
      body: MUTATING_CALL,
      expect: { status: 401, headers: NOT_COUNTED, body: NEEDS_CREDENTIAL },
    });
  });

  it('reveals no local token while MCP_API_KEY is the bearer', async () => {
    const res = await fetch(new URL('/api/config/mcp/reveal-token', server!.baseUrl), {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });
});
