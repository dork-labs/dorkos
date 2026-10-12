/**
 * Contract for the A2A gateway (`/.well-known/agent-card.json`, its legacy
 * `agent.json` alias, and everything under `/a2a`), which moves to Hono in
 * DOR-2809. That PR must pass this file unchanged.
 *
 * The surface's own gates, in Express's order: the fleet card runs the
 * discovery limiter and then the credential check; everything under `/a2a`
 * runs the credential check and then its route's limiter. The credential check
 * is `decideMcpAuth` for the `'a2a'` surface: with login off, card discovery
 * is open and JSON-RPC execution needs a credential.
 *
 * Every server is a `DORKOS_TEST_RUNTIME` one, whose agents echo what they are
 * sent, so a message that reaches the system agent (the one agent a fresh
 * install has) comes back as a finished task. Its id is only known once the
 * server boots; cases name it as {@link AGENT}.
 *
 * Three servers:
 *
 * 1. Login off: both cards and their headers, both JSON-RPC endpoints in both
 *    protocol versions, the untargeted-message refusal, streaming, unknown
 *    methods and versions, and the bodies the chain or the SDK refuses.
 * 2. Login off, then on, driven by hand: a person's API key and session cookie
 *    are let in either way; once login is on the cards are closed too, and the
 *    local token stops counting.
 * 3. `MCP_API_KEY` set and limits of two a minute: the key is let in, the 401
 *    names no token file, and the third call or card is refused.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** Stands for this server's local MCP token, which is only known once it boots. */
const LOCAL_TOKEN = '{{local-token}}';
/** Stands for the system agent's id, which is only known once the server boots. */
const AGENT = '{{agent}}';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOSNIFF = { 'x-content-type-options': 'nosniff' };
/** The headers every card answer carries: no caching instructions of its own. */
const CARD_HEADERS = { ...JSON_TYPE, ...NOSNIFF, 'cache-control': null };
/** A JSON-RPC error envelope, as the credential check and the limiter write it. */
const rpcError = (code: number, message: string, id: string | number | null = null) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id,
});
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
            /^Unauthorized\. This agent-to-agent call needs your local MCP token\. Find it in Settings → Advanced → Tools → Connect other apps to DorkOS, or in .+mcp-local-token, and send it as "Authorization: Bearer <token>"\.$/
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
    'When login is on, use your personal API key from Settings → Advanced → Tools → Connect other apps to DorkOS.'
);
const NOT_ALLOWED_BY_CORS = (origin: string) => ({
  error: `Origin ${origin} not allowed by CORS`,
  code: 'INTERNAL_ERROR',
});
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR'), error: z.string() }).strict();
const TOO_LARGE = { error: 'That is too large to send in one request.', code: 'REQUEST_TOO_LARGE' };
/** The untargeted-message refusal on the fleet endpoint. */
const NO_TARGET = (id: number) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32602,
    message:
      "No target agent specified. POST to a specific agent's endpoint at " +
      `${SERVER_ORIGIN}/a2a/agents/{agentId} — the url advertised on its agent card — or set ` +
      'metadata.agentId on the message. Discover agents via the fleet card at ' +
      '/.well-known/agent-card.json (each skill id is an agent id).',
  },
});

/** The bearer scheme every card states, in protobuf JSON. */
const BEARER_CARD_FIELDS = {
  securitySchemes: z
    .object({
      bearerAuth: z
        .object({
          httpAuthSecurityScheme: z
            .object({ scheme: z.literal('bearer'), description: z.string() })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  securityRequirements: z.tuple([
    z.object({ schemes: z.object({ bearerAuth: z.object({}).strict() }).strict() }).strict(),
  ]),
  capabilities: z
    .object({
      streaming: z.literal(true),
      pushNotifications: z.literal(false),
      extendedAgentCard: z.literal(false),
    })
    .strict(),
  defaultInputModes: z.tuple([z.literal('text/plain')]),
  defaultOutputModes: z.tuple([z.literal('text/plain')]),
  version: z.string().regex(/^0\.0\.0-contract\./),
};
/** Both protocol versions, at one URL. */
const interfacesAt = (url: string) =>
  z.tuple([
    z
      .object({
        url: z.literal(url),
        protocolBinding: z.literal('JSONRPC'),
        protocolVersion: z.literal('1.0'),
      })
      .strict(),
    z
      .object({
        url: z.literal(url),
        protocolBinding: z.literal('JSONRPC'),
        protocolVersion: z.literal('0.3'),
      })
      .strict(),
  ]);

/** A JSON-RPC request. */
const rpc = (method: string, params?: unknown, id: number | string | null = 1) => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});
/** A v0.3 message, optionally targeted. */
const legacyMessage = (messageId: string, metadata?: Record<string, unknown>) => ({
  message: {
    kind: 'message',
    role: 'user',
    messageId,
    parts: [{ kind: 'text', text: 'Hello.' }],
    ...(metadata ? { metadata } : {}),
  },
});
/** A v1.0 message, optionally targeted. */
const v1Message = (messageId: string, metadata?: Record<string, unknown>) => ({
  message: {
    messageId,
    role: 'ROLE_USER',
    parts: [{ text: 'Hello.' }],
    ...(metadata ? { metadata } : {}),
  },
});
const WITH_TOKEN = { authorization: `Bearer ${LOCAL_TOKEN}` };
/** The RPC limiter's headers on a call it counted, under the default 60 a minute. */
const RPC_COUNTED = {
  'ratelimit-policy': '60;w=60',
  'ratelimit-limit': '60',
  'ratelimit-remaining': /^\d+$/,
  'ratelimit-reset': /^\d+$/,
};
/** The card limiter's headers, under the default 300 a minute. */
const CARD_COUNTED = {
  'ratelimit-policy': '300;w=60',
  'ratelimit-limit': '300',
  'ratelimit-remaining': /^\d+$/,
  'ratelimit-reset': /^\d+$/,
};
/** A call no limiter saw. */
const NOT_COUNTED = { 'ratelimit-limit': null };

/** A finished v0.3 task, answered to `message/send`, for the agent {@link AGENT}. */
const legacyTaskAnswer = (id: number, agentId: string) =>
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.literal(id),
      result: z
        .object({
          kind: z.literal('task'),
          id: z.string().min(1),
          contextId: z.string().min(1),
          status: z
            .object({
              state: z.literal('completed'),
              message: z
                .object({
                  kind: z.literal('message'),
                  role: z.literal('agent'),
                  parts: z.array(z.object({ kind: z.literal('text'), text: z.string() })).min(1),
                })
                .loose(),
              timestamp: z.string(),
            })
            .strict(),
          history: z
            .array(z.object({ role: z.string() }).loose())
            .refine((history) => history[0]?.role === 'user', 'starts with the caller'),
          metadata: z.object({ agentId: z.literal(agentId) }).loose(),
        })
        .loose(),
    })
    .strict();
/** A finished v1.0 task, answered to `SendMessage`. */
const v1TaskAnswer = (id: number, agentId: string) =>
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.literal(id),
      result: z
        .object({
          task: z
            .object({
              id: z.string().min(1),
              contextId: z.string().min(1),
              status: z
                .object({
                  state: z.literal('TASK_STATE_COMPLETED'),
                  message: z
                    .object({
                      role: z.literal('ROLE_AGENT'),
                      parts: z.array(z.object({ text: z.string() })).min(1),
                    })
                    .loose(),
                })
                .loose(),
              metadata: z.object({ agentId: z.literal(agentId) }).loose(),
            })
            .loose(),
        })
        .strict(),
    })
    .strict();

/** The values a case names by placeholder, known once a server boots. */
interface Known {
  token: string;
  agent: string;
  /** The server's own origin, which a refusal names. */
  origin: string;
}

/** Fill the placeholders in a string. */
const fillText = (text: string, known: Known): string =>
  text
    .replaceAll(LOCAL_TOKEN, known.token)
    .replaceAll(AGENT, known.agent)
    .replaceAll(SERVER_ORIGIN, known.origin);

/** Fill the placeholders anywhere in a JSON value. */
function fillJson<T>(value: T, known: Known): T {
  return value === undefined ? value : (JSON.parse(fillText(JSON.stringify(value), known)) as T);
}

/** Send one case, with this server's token and agent filled in. */
async function check(
  server: ComposedServer | undefined,
  testCase: Omit<ContractCase, 'name'> & { name?: string },
  known: Known
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(testCase.headers ?? {})) {
    headers[name] = fillText(value, known);
  }
  await checkContractCase(server!.baseUrl, {
    name: testCase.path,
    ...testCase,
    path: fillText(testCase.path, known),
    headers,
    body: typeof testCase.body === 'string' ? testCase.body : fillJson(testCase.body, known),
    expect: { ...testCase.expect, body: fillJson(testCase.expect.body, known) },
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

/** The system agent's id: the one agent a fresh install has. */
async function systemAgentId(server: ComposedServer | undefined): Promise<string> {
  const { json } = await setup(server, 'GET', '/api/mesh/agents');
  const agents = json.agents as { id: string; isSystem?: boolean }[];
  const agent = agents.find((candidate) => candidate.isSystem === true);
  if (!agent) throw new Error('No system agent is registered');
  return agent.id;
}

/** One SSE stream, read to its end. */
interface StreamAnswer {
  status: number;
  headers: Headers;
  /** Each `data:` frame's JSON, in order. */
  frames: Record<string, unknown>[];
  /** The raw text, to check the framing itself. */
  text: string;
}

/** POST a JSON-RPC request and read the whole SSE answer. */
async function stream(
  server: ComposedServer | undefined,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<StreamAnswer> {
  const res = await fetch(new URL(path, server!.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const frames = text
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame, 'each frame is one data line').toMatch(/^data: [^\n]+$/);
      return JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>;
    });
  return { status: res.status, headers: res.headers, frames, text };
}

/** The SSE response headers, as the SDK writes them. */
function expectEventStream(answer: StreamAnswer): void {
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/event-stream');
  expect(answer.headers.get('cache-control')).toBe('no-cache');
  expect(answer.headers.get('x-accel-buffering')).toBe('no');
  expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  expect(answer.headers.get('ratelimit-limit')).toBe('60');
  expect(answer.text.endsWith('\n\n'), 'the stream ends on a frame boundary').toBe(true);
}

/** The cases server 1 runs, in order. */
const LOGIN_OFF_CASES: readonly ContractCase[] = [
  // The fleet card: open to discovery with login off.
  ...['/.well-known/agent-card.json', '/.well-known/agent.json'].map((path): ContractCase => ({
    name: `GET ${path} serves the fleet card with no credential`,
    path,
    expect: {
      status: 200,
      headers: {
        ...CARD_HEADERS,
        ...CARD_COUNTED,
        vary: 'Origin',
        'access-control-allow-origin': null,
        'access-control-allow-credentials': 'true',
      },
      schema: z
        .object({
          name: z.literal('DorkOS Agent Fleet'),
          description: z.string().startsWith('DorkOS agent fleet with 1 registered agent.'),
          supportedInterfaces: z.array(z.object({}).loose()),
          skills: z.tuple([
            z.object({ id: z.string().min(1), name: z.literal('dorkbot') }).loose(),
          ]),
          ...BEARER_CARD_FIELDS,
        })
        .strict(),
    },
  })),
  {
    name: 'GET the fleet card answers this server’s own page with CORS headers',
    path: '/.well-known/agent-card.json',
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 200,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      },
    },
  },
  {
    name: 'GET the fleet card refuses a foreign page at CORS, before the limiter',
    path: '/.well-known/agent-card.json',
    headers: { origin: 'https://evil.example' },
    expect: {
      status: 500,
      headers: { ...JSON_TYPE, ...NOT_COUNTED, 'access-control-allow-origin': null },
      body: NOT_ALLOWED_BY_CORS('https://evil.example'),
    },
  },
  {
    name: 'HEAD the fleet card is refused with no credential: only a GET is discovery',
    method: 'HEAD',
    path: '/.well-known/agent-card.json',
    expect: { status: 401, headers: { ...JSON_TYPE, ...CARD_COUNTED }, body: '' },
  },
  {
    name: 'HEAD the fleet card with the local token answers the GET’s status with no body',
    method: 'HEAD',
    path: '/.well-known/agent-card.json',
    headers: WITH_TOKEN,
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET the fleet card with the local token is served too',
    path: '/.well-known/agent-card.json',
    headers: WITH_TOKEN,
    expect: { status: 200, headers: CARD_COUNTED },
  },

  // The per-agent card.
  {
    name: 'GET /a2a/agents/:id/card serves the agent’s card with no credential',
    path: `/a2a/agents/${AGENT}/card`,
    expect: {
      status: 200,
      headers: { ...CARD_HEADERS, ...CARD_COUNTED, vary: 'Origin' },
      schema: z
        .object({
          name: z.literal('dorkbot'),
          description: z.string().min(1),
          supportedInterfaces: z.array(z.object({}).loose()),
          skills: z
            .array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  description: z.string(),
                  tags: z.array(z.string()),
                })
                .strict()
            )
            .min(1),
          ...BEARER_CARD_FIELDS,
        })
        .strict(),
    },
  },
  {
    name: 'GET /a2a/agents/:id/card/ answers the same with a trailing slash',
    path: `/a2a/agents/${AGENT}/card/`,
    expect: { status: 200, headers: CARD_HEADERS },
  },
  {
    name: 'GET /a2a/agents/:id/card answers 404 for an agent nobody registered',
    path: '/a2a/agents/no-such-agent/card',
    expect: {
      status: 404,
      headers: { ...CARD_HEADERS, ...CARD_COUNTED },
      body: { error: 'Agent not found' },
    },
  },

  // The credential check on JSON-RPC: before the limiter.
  ...(
    [
      ['no credential', {}],
      ['a wrong bearer token', { authorization: `Bearer dork_mcp_local_${'0'.repeat(64)}` }],
      ['the local token under another scheme', { authorization: `Basic ${LOCAL_TOKEN}` }],
      ['a bare token with no scheme', { authorization: LOCAL_TOKEN }],
    ] as const
  ).flatMap(([what, headers]): ContractCase[] =>
    ['/a2a', `/a2a/agents/${AGENT}`].map((path) => ({
      name: `POST ${path === '/a2a' ? '/a2a' : '/a2a/agents/:id'} refuses ${what}`,
      method: 'POST',
      path,
      headers,
      body: rpc('message/send', legacyMessage('m-refused', { agentId: AGENT })),
      expect: {
        status: 401,
        headers: { ...JSON_TYPE, ...NOSNIFF, ...NOT_COUNTED },
        schema: NEEDS_LOCAL_TOKEN,
      },
    }))
  ),

  // The untargeted-message refusal, in both protocol versions, on the fleet endpoint.
  {
    name: 'POST /a2a refuses an untargeted v0.3 message/send, naming where to send it',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-untargeted'), 11),
    expect: { status: 400, headers: { ...JSON_TYPE, ...RPC_COUNTED }, body: NO_TARGET(11) },
  },
  {
    name: 'POST /a2a refuses an untargeted v1.0 SendMessage',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('SendMessage', v1Message('m-untargeted-v1'), 12),
    expect: { status: 400, body: NO_TARGET(12) },
  },
  {
    name: 'POST /a2a refuses an untargeted v0.3 message/stream as JSON, not a stream',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('message/stream', legacyMessage('m-untargeted-stream'), 13),
    expect: { status: 400, headers: JSON_TYPE, body: NO_TARGET(13) },
  },
  {
    name: 'POST /a2a refuses an untargeted v1.0 SendStreamingMessage',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('SendStreamingMessage', v1Message('m-untargeted-stream-v1'), 14),
    expect: { status: 400, body: NO_TARGET(14) },
  },
  {
    name: 'POST /a2a refuses an empty metadata.agentId as untargeted',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-empty-target', { agentId: '' }), 15),
    expect: { status: 400, body: NO_TARGET(15) },
  },
  {
    name: 'POST /a2a/ refuses an untargeted message with a trailing slash too',
    method: 'POST',
    path: '/a2a/',
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-untargeted-slash'), 16),
    expect: { status: 400, body: NO_TARGET(16) },
  },

  // Targeted messages: answered by the agent.
  {
    name: 'POST /a2a answers a v0.3 message/send that names its agent with a finished task',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-fleet', { agentId: AGENT }), 21),
    expect: {
      status: 200,
      headers: { ...JSON_TYPE, ...NOSNIFF, ...RPC_COUNTED },
      // The agent id is checked by the hand-driven case below.
      schema: z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.literal(21),
          result: z.object({ kind: z.literal('task') }).loose(),
        })
        .strict(),
    },
  },
  {
    name: 'POST /a2a/agents/:id answers a v0.3 message/send with no metadata, bound by the URL',
    method: 'POST',
    path: `/a2a/agents/${AGENT}`,
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-bound'), 22),
    expect: {
      status: 200,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      schema: z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.literal(22),
          result: z.object({ kind: z.literal('task') }).loose(),
        })
        .strict(),
    },
  },
  {
    name: 'POST /a2a/agents/:id refuses a metadata.agentId naming another agent',
    method: 'POST',
    path: `/a2a/agents/${AGENT}`,
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-conflict', { agentId: 'someone-else' }), 23),
    expect: {
      status: 400,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      body: {
        jsonrpc: '2.0',
        id: 23,
        error: {
          code: -32602,
          message:
            `metadata.agentId 'someone-else' conflicts with this endpoint's agent '${AGENT}'. ` +
            'Drop metadata.agentId or POST to the fleet endpoint /a2a.',
        },
      },
    },
  },
  {
    name: 'POST /a2a/agents/:id answers 404 for an agent nobody registered',
    method: 'POST',
    path: '/a2a/agents/no-such-agent',
    headers: WITH_TOKEN,
    body: rpc('message/send', legacyMessage('m-unknown-agent'), 24),
    expect: {
      status: 404,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32602,
          message:
            "Agent 'no-such-agent' not found. Discover agents via /.well-known/agent-card.json.",
        },
      },
    },
  },

  // Methods the SDK answers itself.
  {
    name: 'POST /a2a answers an unknown v0.3-style method with method-not-found',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('no/such/method', {}, 31),
    expect: {
      status: 200,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      body: rpcError(-32601, 'Method not found: no/such/method', 31),
    },
  },
  {
    name: 'POST /a2a answers an unknown method name with method-not-found',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('NoSuchMethod', {}, 'request-32'),
    expect: { status: 200, body: rpcError(-32601, 'Method not found: NoSuchMethod', 'request-32') },
  },
  {
    name: 'POST /a2a answers tasks/get for a task nobody made in v0.3’s shape',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('tasks/get', { id: 'no-such-task' }, 33),
    expect: { status: 200, body: rpcError(-32001, 'Task not found: no-such-task', 33) },
  },
  {
    name: 'POST /a2a answers GetTask for a task nobody made in v1.0’s shape',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: rpc('GetTask', { id: 'no-such-task' }, 34),
    expect: {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 34,
        error: {
          code: -32001,
          message: 'Task not found: no-such-task',
          data: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'TASK_NOT_FOUND',
              domain: 'a2a-protocol.org',
            },
          ],
        },
      },
    },
  },
  {
    name: 'POST /a2a answers a protocol version no card declares with a JSON-RPC 500',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, 'A2A-Version': '9.9' },
    body: rpc('GetTask', { id: 'no-such-task' }, 35),
    expect: {
      status: 500,
      headers: JSON_TYPE,
      schema: z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.literal(35),
          error: z.object({ code: z.number(), message: z.string().includes('9.9') }).loose(),
        })
        .strict(),
    },
  },
  {
    name: 'POST /a2a answers a request that is not JSON-RPC with invalid-request',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: { hello: 'world' },
    expect: {
      status: 200,
      schema: z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.null(),
          error: z.object({ code: z.literal(-32600), message: z.string() }).loose(),
        })
        .strict(),
    },
  },

  // Bodies.
  {
    name: 'POST /a2a refuses a body that is not JSON at the SDK’s content-type guard',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, 'content-type': 'text/plain' },
    body: JSON.stringify(rpc('message/send', legacyMessage('m-text', { agentId: AGENT }))),
    expect: {
      status: 400,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32005,
          message: 'Unsupported Content-Type "text/plain"; expected application/json.',
          data: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'CONTENT_TYPE_NOT_SUPPORTED',
              domain: 'a2a-protocol.org',
            },
          ],
        },
      },
    },
  },
  {
    name: 'POST /a2a answers a body with no content type as no request at all',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: JSON.stringify(rpc('message/send', legacyMessage('m-untyped', { agentId: AGENT }))),
    expect: {
      status: 200,
      headers: { ...JSON_TYPE, ...RPC_COUNTED },
      schema: z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.null(),
          error: z.object({ code: z.number(), message: z.string() }).loose(),
        })
        .strict(),
    },
  },
  {
    name: 'POST /a2a answers malformed JSON with the error handler’s 500',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, 'content-type': 'application/json' },
    body: '{"jsonrpc":',
    expect: { status: 500, headers: { ...JSON_TYPE, ...NOT_COUNTED }, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /a2a/agents/:id answers malformed JSON with the error handler’s 500, with no token',
    method: 'POST',
    path: `/a2a/agents/${AGENT}`,
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":',
    expect: { status: 500, headers: NOT_COUNTED, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /a2a answers a top-level JSON string with the error handler’s 500',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, 'content-type': 'application/json' },
    body: '"message/send"',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /a2a refuses a body over a megabyte, with the token',
    method: 'POST',
    path: '/a2a',
    headers: WITH_TOKEN,
    body: {
      ...rpc('message/send', legacyMessage('m-big', { agentId: AGENT })),
      padding: 'x'.repeat(1_100_000),
    },
    expect: { status: 413, headers: { ...JSON_TYPE, ...NOT_COUNTED }, body: TOO_LARGE },
  },
  {
    name: 'POST /a2a/agents/:id refuses a body over a megabyte, with no token',
    method: 'POST',
    path: `/a2a/agents/${AGENT}`,
    body: { ...rpc('message/send', legacyMessage('m-big-2')), padding: 'x'.repeat(1_100_000) },
    expect: { status: 413, body: TOO_LARGE },
  },

  // Browser origins on JSON-RPC.
  {
    name: 'POST /a2a answers this server’s own page with CORS headers',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, origin: SERVER_ORIGIN },
    body: rpc('message/send', legacyMessage('m-own-page'), 41),
    expect: {
      status: 400,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      body: NO_TARGET(41),
    },
  },
  {
    name: 'POST /a2a refuses a foreign page at CORS, even with the token',
    method: 'POST',
    path: '/a2a',
    headers: { ...WITH_TOKEN, origin: 'https://evil.example' },
    body: rpc('message/send', legacyMessage('m-evil', { agentId: AGENT })),
    expect: {
      status: 500,
      headers: { ...NOT_COUNTED, 'access-control-allow-origin': null },
      body: NOT_ALLOWED_BY_CORS('https://evil.example'),
    },
  },
  {
    name: 'OPTIONS /a2a answers a preflight from this server’s own page',
    method: 'OPTIONS',
    path: '/a2a',
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
];

describe('contract: the A2A gateway, login off', () => {
  let server: ComposedServer | undefined;
  const known: Known = { token: '', agent: '', origin: '' };
  beforeAll(async () => {
    server = await bootComposedServer();
    known.origin = server.baseUrl;
    known.token = await revealLocalToken(server);
    known.agent = await systemAgentId(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it.each(LOGIN_OFF_CASES.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    await check(server, testCase, known);
  });

  it('advertises the fleet endpoint on the fleet card, at both protocol versions', async () => {
    await check(
      server,
      {
        path: '/.well-known/agent-card.json',
        expect: {
          status: 200,
          schema: z.object({ supportedInterfaces: interfacesAt(`${server!.baseUrl}/a2a`) }).loose(),
        },
      },
      known
    );
  });

  it('advertises the agent’s own endpoint on its card, at both protocol versions', async () => {
    await check(
      server,
      {
        path: `/a2a/agents/${AGENT}/card`,
        expect: {
          status: 200,
          schema: z
            .object({
              supportedInterfaces: interfacesAt(`${server!.baseUrl}/a2a/agents/${known.agent}`),
            })
            .loose(),
        },
      },
      known
    );
  });

  it('lists the system agent as a skill on the fleet card', async () => {
    await check(
      server,
      {
        path: '/.well-known/agent-card.json',
        expect: {
          status: 200,
          schema: z
            .object({ skills: z.tuple([z.object({ id: z.literal(known.agent) }).loose()]) })
            .loose(),
        },
      },
      known
    );
  });

  it('answers message/send in v0.3’s shape and SendMessage in v1.0’s, on both endpoints', async () => {
    for (const [path, body, schema] of [
      [
        '/a2a',
        rpc('message/send', legacyMessage('m-shape-1', { agentId: known.agent }), 51),
        legacyTaskAnswer(51, known.agent),
      ],
      [
        `/a2a/agents/${known.agent}`,
        rpc('message/send', legacyMessage('m-shape-2'), 52),
        legacyTaskAnswer(52, known.agent),
      ],
      [
        '/a2a',
        rpc('SendMessage', v1Message('m-shape-3', { agentId: known.agent }), 53),
        v1TaskAnswer(53, known.agent),
      ],
      [
        `/a2a/agents/${known.agent}`,
        rpc('SendMessage', v1Message('m-shape-4'), 54),
        v1TaskAnswer(54, known.agent),
      ],
    ] as const) {
      await check(
        server,
        {
          method: 'POST',
          path,
          headers: WITH_TOKEN,
          body,
          expect: { status: 200, headers: { ...JSON_TYPE, ...RPC_COUNTED }, schema },
        },
        known
      );
    }
  });

  it('continues a task by its taskId on the fleet endpoint, which counts as a target', async () => {
    const first = await setup(
      server,
      'POST',
      `/a2a/agents/${known.agent}`,
      rpc('message/send', legacyMessage('m-continue-1'), 55),
      { authorization: `Bearer ${known.token}` }
    );
    const task = first.json.result as { id: string; contextId: string };
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: WITH_TOKEN,
        body: rpc('tasks/get', { id: task.id }, 56),
        expect: {
          status: 200,
          schema: z
            .object({
              jsonrpc: z.literal('2.0'),
              id: z.literal(56),
              result: z
                .object({
                  kind: z.literal('task'),
                  id: z.literal(task.id),
                  status: z.object({ state: z.literal('completed') }).loose(),
                })
                .loose(),
            })
            .strict(),
        },
      },
      known
    );
  });

  it('streams message/stream as SSE: a submitted task, then status updates, then completion', async () => {
    const answer = await stream(
      server,
      `/a2a/agents/${known.agent}`,
      rpc('message/stream', legacyMessage('m-stream-1'), 61),
      { authorization: `Bearer ${known.token}` }
    );
    expectEventStream(answer);
    expect(answer.frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of answer.frames) {
      expect(frame).toMatchObject({ jsonrpc: '2.0', id: 61 });
    }
    expect(answer.frames[0]).toMatchObject({
      result: {
        kind: 'task',
        status: { state: 'submitted' },
        metadata: { agentId: known.agent },
      },
    });
    expect(answer.frames.at(-1)).toMatchObject({
      result: { kind: 'status-update', status: { state: 'completed' }, final: true },
    });
  });

  it('streams SendStreamingMessage as SSE in v1.0’s shape on the fleet endpoint', async () => {
    const answer = await stream(
      server,
      '/a2a',
      rpc('SendStreamingMessage', v1Message('m-stream-2', { agentId: known.agent }), 62),
      { authorization: `Bearer ${known.token}` }
    );
    expectEventStream(answer);
    expect(answer.frames[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 62,
      result: { task: { status: { state: 'TASK_STATE_SUBMITTED' } } },
    });
    expect(answer.frames.at(-1)).toMatchObject({
      jsonrpc: '2.0',
      id: 62,
      result: { statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } },
    });
  });

  it('answers a stream that fails before its first event as JSON, not as a stream', async () => {
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: { ...WITH_TOKEN, accept: 'text/event-stream' },
        body: rpc('tasks/resubscribe', { id: 'no-such-task' }, 63),
        expect: {
          status: 200,
          headers: { 'content-type': /^text\/event-stream$/ },
        },
      },
      known
    );
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: { ...WITH_TOKEN, accept: 'text/event-stream' },
        body: rpc('SubscribeToTask', { id: 'no-such-task' }, 64),
        expect: {
          status: 200,
          headers: JSON_TYPE,
          schema: z
            .object({
              jsonrpc: z.literal('2.0'),
              id: z.literal(64),
              error: z.object({ code: z.literal(-32001) }).loose(),
            })
            .strict(),
        },
      },
      known
    );
  });
});

describe('contract: the A2A gateway with a person’s credentials, login off then on', () => {
  let server: ComposedServer | undefined;
  const known: Known = { token: '', agent: '', origin: '' };
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer();
    known.origin = server.baseUrl;
    known.token = await revealLocalToken(server);
    known.agent = await systemAgentId(server);
    const origin = { origin: server.baseUrl };
    const signedUp = await setup(
      server,
      'POST',
      '/api/auth/sign-up/email',
      { ...OWNER, name: 'Owner' },
      origin
    );
    cookie = {
      cookie: signedUp.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'a2a' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const send = (id: number) =>
    rpc('message/send', legacyMessage(`m-person-${id}`, { agentId: AGENT }), id);

  it('lets a call in on a person’s API key or session cookie while login is off', async () => {
    let id = 70;
    for (const credential of [apiKey, cookie]) {
      id += 1;
      await check(
        server,
        {
          method: 'POST',
          path: '/a2a',
          headers: credential,
          body: send(id),
          expect: { status: 200, headers: RPC_COUNTED, schema: legacyTaskAnswer(id, known.agent) },
        },
        known
      );
    }
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: { authorization: 'Bearer not-a-real-api-key' },
        body: send(79),
        expect: { status: 401, headers: NOT_COUNTED, schema: NEEDS_LOCAL_TOKEN },
      },
      known
    );
  });

  it('closes the cards too once login is on, and the local token no longer counts', async () => {
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } }, cookie);
    // The refusal still names the token file: the path is read once, at boot.
    // The fleet card counts the caller before the credential check.
    for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
      await check(
        server,
        {
          path,
          expect: {
            status: 401,
            headers: { ...JSON_TYPE, ...NOSNIFF, ...CARD_COUNTED },
            schema: NEEDS_LOCAL_TOKEN,
          },
        },
        known
      );
    }
    // Under `/a2a` the credential check comes first.
    await check(
      server,
      {
        path: `/a2a/agents/${AGENT}/card`,
        expect: { status: 401, headers: NOT_COUNTED, schema: NEEDS_LOCAL_TOKEN },
      },
      known
    );
    for (const path of ['/a2a', `/a2a/agents/${AGENT}`]) {
      await check(
        server,
        {
          method: 'POST',
          path,
          headers: WITH_TOKEN,
          body: send(80),
          expect: {
            status: 401,
            headers: { ...JSON_TYPE, ...NOT_COUNTED },
            schema: NEEDS_LOCAL_TOKEN,
          },
        },
        known
      );
    }
  });

  it('serves the cards and answers calls on a person’s API key or cookie once login is on', async () => {
    let id = 90;
    for (const credential of [apiKey, cookie]) {
      await check(
        server,
        {
          path: '/.well-known/agent-card.json',
          headers: credential,
          expect: { status: 200, headers: CARD_HEADERS },
        },
        known
      );
      await check(
        server,
        {
          path: `/a2a/agents/${AGENT}/card`,
          headers: credential,
          expect: { status: 200, headers: CARD_HEADERS },
        },
        known
      );
      id += 1;
      await check(
        server,
        {
          method: 'POST',
          path: `/a2a/agents/${AGENT}`,
          headers: credential,
          body: send(id),
          expect: { status: 200, headers: RPC_COUNTED, schema: legacyTaskAnswer(id, known.agent) },
        },
        known
      );
    }
    const answer = await stream(
      server,
      `/a2a/agents/${known.agent}`,
      rpc('message/stream', legacyMessage('m-person-stream'), 99),
      apiKey
    );
    expectEventStream(answer);
    expect(answer.frames.at(-1)).toMatchObject({
      id: 99,
      result: { status: { state: 'completed' } },
    });
  });
});

describe('contract: the A2A gateway with MCP_API_KEY and tight limits', () => {
  const ENV_KEY = `contract-env-key-${randomUUID()}`;
  let server: ComposedServer | undefined;
  const known: Known = { token: '', agent: '', origin: '' };

  beforeAll(async () => {
    server = await bootComposedServer({
      MCP_API_KEY: ENV_KEY,
      DORKOS_A2A_RPC_RATE_LIMIT: '2',
      DORKOS_A2A_CARD_RATE_LIMIT: '2',
    });
    known.origin = server.baseUrl;
    known.agent = await systemAgentId(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const TIGHT = { 'ratelimit-policy': '2;w=60', 'ratelimit-limit': '2' };
  const WITH_KEY = { authorization: `Bearer ${ENV_KEY}` };

  it('counts the calls it lets in, not the ones it refuses, and refuses the third', async () => {
    await check(
      server,
      {
        method: 'POST',
        path: `/a2a/agents/${AGENT}`,
        headers: WITH_KEY,
        body: rpc('message/send', legacyMessage('m-key-1'), 101),
        expect: {
          status: 200,
          headers: { ...TIGHT, 'ratelimit-remaining': '1', 'retry-after': null },
          schema: legacyTaskAnswer(101, known.agent),
        },
      },
      known
    );
    // Refused before the limiter: no local token applies, so the 401 points at
    // the credential that does.
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: { authorization: 'Bearer not-the-key' },
        body: rpc('message/send', legacyMessage('m-key-2', { agentId: AGENT }), 102),
        expect: { status: 401, headers: NOT_COUNTED, body: NEEDS_CREDENTIAL },
      },
      known
    );
    // The untargeted refusal is counted: it is answered after the limiter.
    await check(
      server,
      {
        method: 'POST',
        path: '/a2a',
        headers: WITH_KEY,
        body: rpc('message/send', legacyMessage('m-key-3'), 103),
        expect: {
          status: 400,
          headers: { ...TIGHT, 'ratelimit-remaining': '0' },
          body: NO_TARGET(103),
        },
      },
      known
    );
    await check(
      server,
      {
        method: 'POST',
        path: `/a2a/agents/${AGENT}`,
        headers: WITH_KEY,
        body: rpc('message/send', legacyMessage('m-key-4'), 104),
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
      },
      known
    );
  });

  it('counts card reads on their own limiter, refusing the third', async () => {
    for (const remaining of ['1', '0']) {
      await check(
        server,
        {
          path: '/.well-known/agent-card.json',
          expect: { status: 200, headers: { ...TIGHT, 'ratelimit-remaining': remaining } },
        },
        known
      );
    }
    await check(
      server,
      {
        path: '/.well-known/agent.json',
        expect: {
          status: 429,
          headers: { ...JSON_TYPE, ...TIGHT, 'retry-after': /^\d+$/ },
          body: RATE_LIMITED,
        },
      },
      known
    );
    await check(
      server,
      {
        path: `/a2a/agents/${AGENT}/card`,
        expect: { status: 429, body: RATE_LIMITED },
      },
      known
    );
  });
});
