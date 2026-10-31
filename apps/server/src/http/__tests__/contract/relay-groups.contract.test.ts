/**
 * Contract for the Relay route groups, which move to Hono together in
 * DOR-2811: the message bus (`/api/relay/messages`, `/endpoints`,
 * `/dead-letters`, `/metrics`, the traces and the deprecated `/stream`), the
 * connections and their chat routes (`/adapters`, `/bindings`), the signed
 * webhook receiver (`POST /webhooks/:adapterId`) and the claim feed
 * (`/unclaimed-chats`). That PR must pass this file unchanged.
 *
 * The webhook receiver is the one route whose caller is an outside service. It
 * checks an HMAC over the exact bytes that arrived, so its body is never parsed
 * as JSON first, it may carry up to 1 MB, and, unlike the connector ingress,
 * it still stands behind the login gate.
 *
 * Four servers:
 *
 * 1. Relay on, login off, nothing set up: every read's shape, validation
 *    answers, the reserved-sender and reserved-subject refusals, 404s, HEAD,
 *    trailing slashes, and the refusals a caller earns with headers alone.
 * 2. Relay on, login off, driven by hand: a webhook connection signed into
 *    and refused, the byte ceiling, an endpoint registered and read, a chat
 *    route made, moved, tested and deleted for a seeded agent, and the event
 *    stream's first frame.
 * 3. Relay on, login on: no credential is refused at the gate, the webhook
 *    receiver included; the owner's cookie passes.
 * 4. Relay off: none of these paths exist.
 *
 * Nothing leaves the machine: the webhook connection's outbound address is a
 * listener this file opens on loopback.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  type ContractCase,
  stepUpAt,
} from './harness.js';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const FOREIGN_HOST = { host: 'evil.example' };
const VALIDATION_FAILED = z
  .object({ error: z.literal('Validation failed'), details: z.unknown() })
  .strict();
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const TOO_LARGE = z.object({ code: z.literal('REQUEST_TOO_LARGE') }).loose();
const HOST_REFUSED = z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose();
const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
const MESSAGE_PAGE = z.object({ messages: z.array(z.unknown()) }).loose();
const ENDPOINTS = z.array(z.object({ subject: z.string() }).loose());
const ADAPTERS = z.array(z.object({ config: z.object({ id: z.string() }).loose() }).loose());
const CATALOG = z.array(z.object({ manifest: z.object({ type: z.string() }).loose() }).loose());
const BINDINGS = z.object({ bindings: z.array(z.unknown()) }).strict();
const BINDING_NOT_FOUND = { error: 'Binding not found' };
const CHAT_NOT_FOUND = { error: 'Unclaimed chat not found' };
const WEBHOOK_NOT_FOUND = { error: 'Webhook adapter not found' };
const TRACING_ABSENT_OR_EMPTY = { error: 'Trace not found' };
/** A well-formed relay message id no message has. */
const UNKNOWN_MESSAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
/** The webhook receiver's raw byte ceiling. */
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const DEAD_LETTER_GROUP = { source: 'contract.nobody', reason: 'nothing' };
const RATE_LIMIT_HEADERS = {
  'ratelimit-limit': '10',
  'ratelimit-policy': '10;w=60',
};

contractSuite('the Relay groups, login off, nothing set up', [
  // --- messages ---
  {
    name: 'GET /messages lists a page of messages',
    path: '/api/relay/messages',
    expect: { status: 200, headers: JSON_TYPE, schema: MESSAGE_PAGE },
  },
  {
    name: 'GET /messages/ with a trailing slash is the same route',
    path: '/api/relay/messages/',
    expect: { status: 200, schema: MESSAGE_PAGE },
  },
  {
    name: 'HEAD /messages answers with no body',
    method: 'HEAD',
    path: '/api/relay/messages',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /messages with a limit out of range is a validation failure',
    path: '/api/relay/messages?limit=0',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /messages with an unknown status is a validation failure',
    path: '/api/relay/messages?status=nope',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /messages with a repeated subject is a validation failure',
    path: '/api/relay/messages?subject=a&subject=b',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET an unknown message is a 404',
    path: `/api/relay/messages/${UNKNOWN_MESSAGE_ID}`,
    expect: { status: 404, body: { error: 'Message not found' } },
  },
  {
    name: 'GET the status of a malformed message id is refused, never cached',
    path: '/api/relay/messages/not-an-id/status',
    expect: {
      status: 400,
      headers: { 'cache-control': 'no-store' },
      body: { error: 'Invalid relay message ID.', code: 'INVALID_RELAY_MESSAGE_ID' },
    },
  },
  {
    name: 'GET the status of an unknown message is a 404, never cached',
    path: `/api/relay/messages/${UNKNOWN_MESSAGE_ID}/status`,
    expect: {
      status: 404,
      headers: { 'cache-control': 'no-store' },
      body: { error: 'Delivery receipt not found.', code: 'RELAY_RECEIPT_NOT_FOUND' },
    },
  },
  {
    name: 'GET the trace of an unknown message is a 404',
    path: `/api/relay/messages/${UNKNOWN_MESSAGE_ID}/trace`,
    expect: { status: 404, body: TRACING_ABSENT_OR_EMPTY },
  },
  {
    name: 'POST /messages with an empty body is a validation failure',
    method: 'POST',
    path: '/api/relay/messages',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /messages with no subject is a validation failure',
    method: 'POST',
    path: '/api/relay/messages',
    body: { payload: 'hi', from: 'relay.human.console' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /messages from a reserved server principal is refused',
    method: 'POST',
    path: '/api/relay/messages',
    body: { subject: 'relay.contract.inbox', payload: 'hi', from: 'relay.system.console' },
    expect: {
      status: 403,
      body: {
        error:
          'Sender "relay.system.console" is a reserved server principal and cannot be asserted ' +
          'by a client. Send from your own principal (e.g. relay.human.console).',
        code: 'RESERVED_SENDER',
      },
    },
  },
  {
    name: 'POST /messages to a server-owned destination is refused',
    method: 'POST',
    path: '/api/relay/messages',
    body: { subject: 'relay.system.tasks.x', payload: 'hi', from: 'relay.human.console' },
    expect: {
      status: 403,
      schema: z
        .object({
          error: z.string().startsWith('Cannot send to "relay.system.tasks.x": '),
          code: z.literal('RESERVED_SUBJECT'),
        })
        .strict(),
    },
  },
  {
    name: 'POST /messages with a server-owned reply address is refused',
    method: 'POST',
    path: '/api/relay/messages',
    body: {
      subject: 'relay.contract.inbox',
      payload: 'hi',
      from: 'relay.human.console',
      replyTo: 'relay.system.tasks.x',
    },
    expect: {
      status: 403,
      schema: z.object({ code: z.literal('RESERVED_SUBJECT') }).loose(),
    },
  },
  {
    name: 'POST /messages to an ordinary subject is published',
    method: 'POST',
    path: '/api/relay/messages',
    body: { subject: 'relay.contract.inbox', payload: 'hi', from: 'relay.human.console' },
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ messageId: z.string(), deliveredTo: z.number() }).loose(),
    },
  },
  {
    name: 'POST /messages with malformed JSON is the chain’s parse error',
    method: 'POST',
    path: '/api/relay/messages',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /messages over the JSON limit is refused before parsing',
    method: 'POST',
    path: '/api/relay/messages',
    body: { subject: 'relay.contract.inbox', payload: 'x'.repeat(1024 * 1024), from: 'a.b' },
    expect: { status: 413, schema: TOO_LARGE },
  },
  {
    name: 'GET /messages at a foreign host is refused by the host guard',
    path: '/api/relay/messages',
    headers: FOREIGN_HOST,
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET /messages from a wrong browser origin is refused by CORS',
    path: '/api/relay/messages',
    headers: { origin: 'https://evil.example' },
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'GET /conversations lists the exchanges',
    path: '/api/relay/conversations',
    expect: {
      status: 200,
      schema: z.object({ conversations: z.array(z.unknown()) }).strict(),
    },
  },
  // --- endpoints ---
  {
    name: 'GET /endpoints lists registered mailboxes',
    path: '/api/relay/endpoints',
    expect: { status: 200, headers: JSON_TYPE, schema: ENDPOINTS },
  },
  {
    name: 'POST /endpoints with no subject is a validation failure',
    method: 'POST',
    path: '/api/relay/endpoints',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /endpoints in a namespace DorkOS manages is refused',
    method: 'POST',
    path: '/api/relay/endpoints',
    body: { subject: 'relay.agent.someone' },
    expect: {
      status: 403,
      schema: z
        .object({ error: z.string().startsWith('Subject "relay.agent.someone" is in a namespace') })
        .strict(),
    },
  },
  {
    name: 'DELETE an endpoint nobody registered is a 404',
    method: 'DELETE',
    path: '/api/relay/endpoints/contract.nobody.here',
    expect: { status: 404, body: { error: 'Endpoint not found' } },
  },
  {
    name: 'GET the inbox of an endpoint nobody registered is a 404',
    path: '/api/relay/endpoints/contract.nobody.here/inbox',
    expect: { status: 404, body: { error: 'Endpoint not found' } },
  },
  {
    name: 'GET an inbox with an unknown status filter is a validation failure',
    path: '/api/relay/endpoints/contract.nobody.here/inbox?status=nope',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET a bare endpoint path is the /api 404',
    path: '/api/relay/endpoints/contract.nobody.here',
    expect: { status: 404, body: NOT_FOUND },
  },
  // --- dead letters, metrics, traces ---
  {
    name: 'GET /dead-letters lists the dead letters',
    path: '/api/relay/dead-letters',
    expect: { status: 200, headers: JSON_TYPE, schema: z.array(z.unknown()) },
  },
  {
    name: 'GET /dead-letters with a malformed endpoint hash is a validation failure',
    path: '/api/relay/dead-letters?endpointHash=%20bad%20',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /dead-letters/aggregated groups them',
    path: '/api/relay/dead-letters/aggregated',
    expect: { status: 200, schema: z.object({ groups: z.array(z.unknown()) }).strict() },
  },
  {
    name: 'DELETE /dead-letters with no group named is refused',
    method: 'DELETE',
    path: '/api/relay/dead-letters',
    expect: { status: 400, body: { error: 'source and reason are required' } },
  },
  {
    name: 'DELETE /dead-letters for a group that has none removes nothing',
    method: 'DELETE',
    path: '/api/relay/dead-letters',
    // Node sends a DELETE body only with a declared length.
    headers: { 'content-length': String(JSON.stringify(DEAD_LETTER_GROUP).length) },
    body: DEAD_LETTER_GROUP,
    expect: { status: 200, body: { removed: 0 } },
  },
  {
    name: 'GET /metrics reports the bus',
    path: '/api/relay/metrics',
    expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
  },
  {
    name: 'GET /trace/metrics reports delivery',
    path: '/api/relay/trace/metrics',
    expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
  },
  {
    name: 'GET /stream with an unscoped pattern is refused',
    path: '/api/relay/stream?subject=%3E',
    expect: {
      status: 400,
      body: {
        error: 'Invalid subscription pattern',
        allowedPrefixes: ['relay.human.console.', 'relay.system.', 'relay.signal.'],
      },
    },
  },
  {
    name: 'GET /stream with a pattern outside the allowed prefixes is refused',
    path: '/api/relay/stream?subject=relay.agent.%3E',
    expect: { status: 400, schema: z.object({ error: z.string() }).loose() },
  },
  // --- adapters ---
  {
    name: 'GET /adapters/catalog lists what can be connected',
    path: '/api/relay/adapters/catalog',
    expect: { status: 200, headers: JSON_TYPE, schema: CATALOG },
  },
  {
    name: 'GET /adapters lists the connections',
    path: '/api/relay/adapters',
    expect: { status: 200, headers: JSON_TYPE, schema: ADAPTERS },
  },
  {
    name: 'GET an unknown connection is a 404',
    path: '/api/relay/adapters/contract-nobody',
    expect: { status: 404, body: { error: 'Adapter not found' } },
  },
  {
    name: 'POST /adapters/test with no type is a validation failure',
    method: 'POST',
    path: '/api/relay/adapters/test',
    body: { config: {} },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /adapters with an id that is not a slug is a validation failure',
    method: 'POST',
    path: '/api/relay/adapters',
    body: { type: 'webhook', id: 'Not A Slug', config: {} },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /adapters of a type DorkOS does not know is refused with its code',
    method: 'POST',
    path: '/api/relay/adapters',
    body: { type: 'not-a-type', id: 'contract-unknown', config: {} },
    expect: {
      status: 400,
      schema: z.object({ error: z.string(), code: z.literal('UNKNOWN_TYPE') }).strict(),
    },
  },
  {
    name: 'POST /adapters with a webhook config its schema refuses is a 400 with its code',
    method: 'POST',
    path: '/api/relay/adapters',
    body: {
      type: 'webhook',
      id: 'contract-bad-hook',
      config: { inbound: { subject: 'relay.agent.x', secret: 'short' } },
    },
    expect: {
      status: 400,
      schema: z.object({ error: z.string(), code: z.literal('INVALID_CONFIG') }).strict(),
    },
  },
  {
    name: 'DELETE an unknown connection is a 404 with its code',
    method: 'DELETE',
    path: '/api/relay/adapters/contract-nobody',
    expect: {
      status: 404,
      schema: z.object({ error: z.string(), code: z.literal('NOT_FOUND') }).strict(),
    },
  },
  {
    name: 'PATCH a connection’s config with no config is a validation failure',
    method: 'PATCH',
    path: '/api/relay/adapters/contract-nobody/config',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH an unknown connection’s config is a 404 with its code',
    method: 'PATCH',
    path: '/api/relay/adapters/contract-nobody/config',
    body: { config: {} },
    expect: {
      status: 404,
      schema: z.object({ error: z.string(), code: z.literal('NOT_FOUND') }).strict(),
    },
  },
  {
    name: 'POST enable on an unknown connection is refused',
    method: 'POST',
    path: '/api/relay/adapters/contract-nobody/enable',
    expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
  },
  {
    name: 'POST disable on an unknown connection is refused',
    method: 'POST',
    path: '/api/relay/adapters/contract-nobody/disable',
    expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
  },
  {
    name: 'GET a connection’s events lists them',
    path: '/api/relay/adapters/contract-nobody/events?limit=5',
    expect: { status: 200, body: { events: [] } },
  },
  {
    name: 'GET a connection’s events with a limit that is not a number uses the default',
    path: '/api/relay/adapters/contract-nobody/events?limit=abc',
    expect: { status: 200, body: { events: [] } },
  },
  {
    name: 'GET a connection’s chats lists them',
    path: '/api/relay/adapters/contract-nobody/chats',
    expect: { status: 200, body: { chats: [] } },
  },
  // --- bindings ---
  {
    name: 'GET /bindings lists the chat routes',
    path: '/api/relay/bindings',
    expect: { status: 200, headers: JSON_TYPE, schema: BINDINGS },
  },
  {
    name: 'GET an unknown chat route is a 404',
    path: '/api/relay/bindings/contract-nobody',
    expect: { status: 404, body: BINDING_NOT_FOUND },
  },
  {
    name: 'POST /bindings with no adapter is a validation failure',
    method: 'POST',
    path: '/api/relay/bindings',
    body: { agentId: 'someone' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /bindings onto a connection that does not exist is refused',
    method: 'POST',
    path: '/api/relay/bindings',
    body: { adapterId: 'contract-nobody', agentId: 'someone' },
    expect: { status: 400, body: { error: "Adapter 'contract-nobody' not found" } },
  },
  {
    name: 'POST move with no agent is a validation failure',
    method: 'POST',
    path: '/api/relay/bindings/contract-nobody/move',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST move onto an agent the registry does not know is refused',
    method: 'POST',
    path: '/api/relay/bindings/contract-nobody/move',
    body: { agentId: 'contract-no-agent' },
    expect: {
      status: 400,
      body: { error: "Agent 'contract-no-agent' not found in mesh registry" },
    },
  },
  {
    name: 'PATCH a chat route with a field of the wrong type is a validation failure',
    method: 'PATCH',
    path: '/api/relay/bindings/contract-nobody',
    body: { canReply: 'yes' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH an unknown chat route is a 404',
    method: 'PATCH',
    path: '/api/relay/bindings/contract-nobody',
    body: { label: 'x' },
    expect: { status: 404, body: BINDING_NOT_FOUND },
  },
  {
    name: 'DELETE an unknown chat route is a 404',
    method: 'DELETE',
    path: '/api/relay/bindings/contract-nobody',
    expect: { status: 404, body: BINDING_NOT_FOUND },
  },
  {
    name: 'POST test on an unknown chat route is a 404, counted by the limiter',
    method: 'POST',
    path: '/api/relay/bindings/contract-nobody/test',
    expect: {
      status: 404,
      headers: { ...RATE_LIMIT_HEADERS, 'ratelimit-remaining': '9' },
      body: BINDING_NOT_FOUND,
    },
  },
  // --- the webhook receiver ---
  {
    name: 'POST a webhook to a connection that does not exist is a 404',
    method: 'POST',
    path: '/api/relay/webhooks/contract-nobody',
    body: '{}',
    headers: { 'content-type': 'application/json' },
    expect: { status: 404, body: WEBHOOK_NOT_FOUND },
  },
  {
    name: 'POST a webhook of any content type is still read as bytes',
    method: 'POST',
    path: '/api/relay/webhooks/contract-nobody',
    body: 'not json at all',
    headers: { 'content-type': 'text/plain' },
    expect: { status: 404, body: WEBHOOK_NOT_FOUND },
  },
  {
    name: 'POST malformed JSON as a webhook is never parsed',
    method: 'POST',
    path: '/api/relay/webhooks/contract-nobody',
    body: '{broken',
    headers: { 'content-type': 'application/json' },
    expect: { status: 404, body: WEBHOOK_NOT_FOUND },
  },
  {
    name: 'POST a webhook over 1 MB is refused before any connection is looked up',
    method: 'POST',
    path: '/api/relay/webhooks/contract-nobody',
    body: 'x'.repeat(WEBHOOK_MAX_BYTES + 1),
    headers: { 'content-type': 'application/json' },
    expect: { status: 413, schema: TOO_LARGE },
  },
  {
    name: 'POST a webhook at a foreign host is refused by the host guard',
    method: 'POST',
    path: '/api/relay/webhooks/contract-nobody',
    body: '{}',
    headers: { ...FOREIGN_HOST, 'content-type': 'application/json' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET a webhook path is the /api 404',
    path: '/api/relay/webhooks/contract-nobody',
    expect: { status: 404, body: NOT_FOUND },
  },
  // --- the claim feed ---
  {
    name: 'GET /unclaimed-chats lists pending chats',
    path: '/api/relay/unclaimed-chats',
    expect: { status: 200, headers: JSON_TYPE, body: { chats: [] } },
  },
  {
    name: 'GET /unclaimed-chats with an unknown status lists pending ones',
    path: '/api/relay/unclaimed-chats?status=nope',
    expect: { status: 200, body: { chats: [] } },
  },
  {
    name: 'GET /unclaimed-chats/ with a trailing slash is the same route',
    path: '/api/relay/unclaimed-chats/?status=blocked',
    expect: { status: 200, body: { chats: [] } },
  },
  {
    name: 'POST claim on an unknown chat is a 404, before the body is read',
    method: 'POST',
    path: '/api/relay/unclaimed-chats/contract-nobody/claim',
    body: { nope: true },
    expect: { status: 404, body: CHAT_NOT_FOUND },
  },
  {
    name: 'POST ignore on an unknown chat is a 404',
    method: 'POST',
    path: '/api/relay/unclaimed-chats/contract-nobody/ignore',
    expect: { status: 404, body: CHAT_NOT_FOUND },
  },
  {
    name: 'POST block on an unknown chat is a 404',
    method: 'POST',
    path: '/api/relay/unclaimed-chats/contract-nobody/block',
    expect: { status: 404, body: CHAT_NOT_FOUND },
  },
  {
    name: 'POST leave on an unknown chat is a 404',
    method: 'POST',
    path: '/api/relay/unclaimed-chats/contract-nobody/leave',
    expect: { status: 404, body: CHAT_NOT_FOUND },
  },
  // --- callers and strays ---
  {
    name: 'GET /adapters from an unverified agent is answered: no bar here',
    path: '/api/relay/adapters',
    headers: AGENT,
    expect: { status: 200, schema: ADAPTERS },
  },
  {
    name: 'GET an unknown path under /api/relay is the /api 404',
    path: '/api/relay/not-a-route',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'PUT /messages is the /api 404',
    method: 'PUT',
    path: '/api/relay/messages',
    body: {},
    expect: { status: 404, body: NOT_FOUND },
  },
]);

/** One answer, JSON-decoded. */
interface Answer {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

/** Send one request and decode its JSON answer. */
async function call(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: res.headers,
  };
}

/** Send one setup request, failing loudly when the server refuses it. */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const answer = await call(server, method, url, body, headers);
  if (answer.status >= 300) {
    throw new Error(`${method} ${url} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return answer;
}

/** Check one case against a hand-driven server. */
async function check(
  server: ComposedServer | undefined,
  ask: Omit<ContractCase, 'name'>
): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** The first event-stream frame a server sends, its status and headers, then the stream closed. */
function firstFrame(
  server: ComposedServer | undefined,
  url: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; frame: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(url, server!.baseUrl), (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        const end = text.indexOf('\n\n');
        if (end === -1) return;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, frame: text.slice(0, end) });
        req.destroy();
      });
      res.on('error', () => undefined);
    });
    req.on('error', (error) => {
      if (!req.destroyed) reject(error);
    });
  });
}

/**
 * The status line a server answers a chunked upload of `bytes` bytes with, a
 * body whose length nothing declared up front, so only counting can stop it.
 */
function answerToChunkedUpload(
  server: ComposedServer | undefined,
  path: string,
  bytes: number
): Promise<string> {
  const { hostname, port } = new URL(server!.baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n'
      );
      const chunk = 'x'.repeat(64 * 1024);
      for (let sent = 0; sent < bytes; sent += chunk.length) {
        socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      }
      socket.write('0\r\n\r\n');
    });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      text += data;
      const end = text.indexOf('\r\n');
      if (end === -1) return;
      resolve(text.slice(0, end));
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

/** Sign up the owner and sign in; the cookie. */
async function ownerCookie(server: ComposedServer | undefined): Promise<Record<string, string>> {
  const owner = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  const origin = { origin: server!.baseUrl };
  await setup(server, 'POST', '/api/auth/sign-up/email', { ...owner, name: 'Owner' }, origin);
  const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', owner, origin);
  return {
    cookie: signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0]!)
      .join('; '),
  };
}

const HOOK_ID = 'contract-hook';
const HOOK_SECRET = 'contract-webhook-secret-sixteen-plus';
const HOOK_SUBJECT = 'relay.webhook.contract';

/** Headers signing `body` the way a webhook sender does: `{timestamp}.{body}`, hex. */
function signed(
  body: string,
  nonce: string = randomUUID(),
  secret = HOOK_SECRET,
  timestamp = String(Math.floor(Date.now() / 1000))
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    'x-timestamp': timestamp,
    'x-nonce': nonce,
  };
}

/** A loopback listener the webhook connection's outbound address points at. */
async function outboundSink(): Promise<{ url: string; close: () => Promise<void> }> {
  const sink = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(204).end());
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const { port } = sink.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise((resolve) => sink.close(() => resolve())),
  };
}

describe('contract: the Relay groups, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  let sink: Awaited<ReturnType<typeof outboundSink>> | undefined;
  let agent: { agentId: string; agentDir: string } | undefined;

  beforeAll(async () => {
    sink = await outboundSink();
    server = await bootComposedServer();
    const seeded = await setup(server, 'POST', '/api/test/seed-agent', {
      slot: 'shared',
      instance: `contract-${randomUUID().slice(0, 8)}`,
    });
    agent = { agentId: seeded.json.agentId as string, agentDir: seeded.json.agentDir as string };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    await sink?.close();
    if (agent) rmSync(agent.agentDir, { recursive: true, force: true });
  }, 30_000);

  it('streams relay events, opening with relay_connected', async () => {
    const { status, headers, frame } = await firstFrame(
      server,
      '/api/relay/stream?subject=relay.human.console.contract'
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const [event, data] = frame.split('\n');
    expect(event).toBe('event: relay_connected');
    expect(JSON.parse(data!.replace(/^data: /, ''))).toEqual({
      pattern: 'relay.human.console.contract',
      connectedAt: expect.any(String),
    });
    // The server is still answering after the client left.
    await check(server, { path: '/api/relay/metrics', expect: { status: 200 } });
  });

  it('streams the console pattern when no subject is named', async () => {
    const { status, frame } = await firstFrame(server, '/api/relay/stream');
    expect(status).toBe(200);
    expect(frame).toContain('"pattern":"relay.human.console.>"');
  });

  it('registers an endpoint, reads its inbox, and removes it', async () => {
    const subject = `contract.mailbox.${randomUUID().slice(0, 8)}`;
    const created = await call(server, 'POST', '/api/relay/endpoints', { subject });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ subject });
    const again = await call(server, 'POST', '/api/relay/endpoints', { subject });
    expect(again.status).toBe(422);
    expect(again.json).toEqual({ error: expect.any(String) });
    await check(server, {
      path: '/api/relay/endpoints',
      expect: { status: 200, schema: z.array(z.object({ subject: z.string() }).loose()).min(1) },
    });
    await setup(server, 'POST', '/api/relay/messages', {
      subject,
      payload: { text: 'hello' },
      from: 'relay.human.console',
    });
    await check(server, {
      path: `/api/relay/endpoints/${subject}/inbox?status=all`,
      expect: {
        status: 200,
        schema: z.object({ messages: z.array(z.unknown()).min(1) }).loose(),
      },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/relay/endpoints/${subject}`,
      expect: { status: 200, body: { success: true } },
    });
    await check(server, {
      path: `/api/relay/endpoints/${subject}/inbox`,
      expect: { status: 404, body: { error: 'Endpoint not found' } },
    });
  });

  it('receives a signed webhook, and refuses a replay, a bad signature and a stale clock', async () => {
    await setup(server, 'POST', '/api/relay/adapters', {
      type: 'webhook',
      id: HOOK_ID,
      enabled: true,
      config: {
        inbound: { subject: HOOK_SUBJECT, secret: HOOK_SECRET },
        outbound: { url: sink!.url, secret: HOOK_SECRET },
      },
    });
    await check(server, {
      path: `/api/relay/adapters/${HOOK_ID}`,
      expect: {
        status: 200,
        schema: z.object({ config: z.object({ id: z.literal(HOOK_ID) }).loose() }).loose(),
      },
    });
    const url = `/api/relay/webhooks/${HOOK_ID}`;
    // Whitespace and non-ASCII kept: the signature covers the bytes as sent.
    const body = '{\n  "event": "push", "text": "café 🚀" }\n';
    const headers = signed(body);
    await check(server, {
      method: 'POST',
      path: url,
      headers,
      body,
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      method: 'POST',
      path: url,
      headers,
      body,
      expect: { status: 401, body: { error: 'Nonce already seen (replay)' } },
    });
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed(body, randomUUID(), 'a-different-secret-sixteen'),
      body,
      expect: { status: 401, body: { error: 'Invalid signature' } },
    });
    // A re-serialized body no longer matches what was signed.
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed(body),
      body: JSON.stringify(JSON.parse(body)),
      expect: { status: 401, body: { error: 'Invalid signature' } },
    });
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed(body, randomUUID(), HOOK_SECRET, '1000'),
      body,
      expect: { status: 401, body: { error: 'Timestamp expired or invalid' } },
    });
    const { 'x-nonce': _nonce, ...noNonce } = signed(body);
    await check(server, {
      method: 'POST',
      path: url,
      headers: noNonce,
      body,
      expect: { status: 400, body: { error: 'Missing X-Nonce header' } },
    });
    // Signed, but not JSON: verified first, then refused.
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed('{broken'),
      body: '{broken',
      expect: { status: 401, body: { error: 'Publish failed' } },
    });
    // Any content type is read as bytes.
    const plain = 'plain text is still bytes';
    await check(server, {
      method: 'POST',
      path: url,
      headers: { ...signed(plain), 'content-type': 'text/plain' },
      body: plain,
      expect: { status: 401, body: { error: 'Publish failed' } },
    });
    const { 'content-type': _type, ...untyped } = signed(body);
    await check(server, {
      method: 'POST',
      path: url,
      headers: untyped,
      body,
      expect: { status: 400, body: { error: 'Send a request body with a content type.' } },
    });
  });

  it('takes a signed webhook up to 1 MB, and refuses one over it unread', async () => {
    const url = `/api/relay/webhooks/${HOOK_ID}`;
    const big = JSON.stringify({ padding: 'x'.repeat(200 * 1024) });
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed(big),
      body: big,
      expect: { status: 200, body: { ok: true } },
    });
    const tooBig = JSON.stringify({ padding: 'x'.repeat(WEBHOOK_MAX_BYTES) });
    const headers = signed(tooBig);
    await check(server, {
      method: 'POST',
      path: url,
      headers,
      body: tooBig,
      expect: { status: 413, schema: TOO_LARGE },
    });
    // The refused one never reached the receiver, so its nonce is still unspent.
    const small = '{"ok":1}';
    await check(server, {
      method: 'POST',
      path: url,
      headers: signed(small, headers['x-nonce']),
      body: small,
      expect: { status: 200, body: { ok: true } },
    });
  });

  it('counts a chunked webhook and refuses it past 1 MB', async () => {
    expect(
      await answerToChunkedUpload(server, `/api/relay/webhooks/${HOOK_ID}`, 2 * WEBHOOK_MAX_BYTES)
    ).toBe('HTTP/1.1 413 Payload Too Large');
  });

  it('answers a webhook for a connection that is not a webhook with a 404', async () => {
    const adapters = await setup(server, 'GET', '/api/relay/adapters');
    const other = (adapters.json as unknown as { config: { id: string; type: string } }[]).find(
      (adapter) => adapter.config.type !== 'webhook'
    );
    if (!other) return;
    await check(server, {
      method: 'POST',
      path: `/api/relay/webhooks/${other.config.id}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      expect: { status: 404, body: WEBHOOK_NOT_FOUND },
    });
  });

  it('makes a chat route for an agent, reads, tests, moves and deletes it', async () => {
    const created = await call(server, 'POST', '/api/relay/bindings', {
      adapterId: HOOK_ID,
      agentId: agent!.agentId,
      chatId: 'contract-chat',
      label: 'contract',
    });
    expect(created.status).toBe(201);
    const binding = created.json.binding as { id: string; agentId: string };
    expect(binding).toMatchObject({ agentId: agent!.agentId, chatId: 'contract-chat' });
    await check(server, {
      method: 'POST',
      path: '/api/relay/bindings',
      body: { adapterId: HOOK_ID, agentId: agent!.agentId, chatId: 'contract-chat' },
      expect: {
        status: 409,
        schema: z
          .object({
            error: z.string(),
            code: z.literal('CHAT_ALREADY_BOUND'),
            conflict: z.object({ bindingId: z.literal(binding.id) }).loose(),
          })
          .strict(),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/relay/bindings',
      body: { adapterId: HOOK_ID, agentId: 'contract-no-agent' },
      expect: {
        status: 400,
        body: { error: "Agent 'contract-no-agent' not found in mesh registry" },
      },
    });
    await check(server, {
      path: `/api/relay/bindings/${binding.id}`,
      expect: {
        status: 200,
        schema: z.object({ binding: z.object({ id: z.literal(binding.id) }).loose() }).strict(),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/relay/bindings/${binding.id}`,
      body: { label: 'renamed', canInitiate: true },
      expect: {
        status: 200,
        schema: z.object({ binding: z.object({ label: z.literal('renamed') }).loose() }).strict(),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/relay/bindings/${binding.id}`,
      body: { bridge: 'room', chatId: null },
      expect: { status: 400, schema: VALIDATION_FAILED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/relay/bindings/${binding.id}/test`,
      expect: {
        status: 200,
        headers: RATE_LIMIT_HEADERS,
        schema: z.object({ ok: z.boolean(), resolved: z.boolean(), latencyMs: z.number() }).loose(),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/relay/bindings/${binding.id}`,
      body: { enabled: false },
      expect: { status: 200 },
    });
    await check(server, {
      method: 'POST',
      path: `/api/relay/bindings/${binding.id}/test`,
      expect: { status: 409, body: { error: 'Binding is paused. Resume to run a test.' } },
    });
    await check(server, {
      method: 'POST',
      path: `/api/relay/bindings/${binding.id}/move`,
      body: { agentId: agent!.agentId },
      expect: {
        status: 200,
        schema: z.object({ binding: z.object({ id: z.literal(binding.id) }).loose() }).strict(),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/relay/bindings/contract-nobody/move',
      body: { agentId: agent!.agentId },
      expect: { status: 404, body: BINDING_NOT_FOUND },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/relay/bindings/${binding.id}`,
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: `/api/relay/bindings/${binding.id}`,
      expect: { status: 404, body: BINDING_NOT_FOUND },
    });
  });

  it('records who changed a connection in the activity feed', async () => {
    await setup(
      server,
      'POST',
      '/api/relay/adapters',
      {
        type: 'webhook',
        id: 'contract-agent-hook',
        config: {
          inbound: { subject: 'relay.webhook.contract-agent', secret: HOOK_SECRET },
          outbound: { url: sink!.url, secret: HOOK_SECRET },
        },
      },
      AGENT
    );
    const feed = await setup(server, 'GET', '/api/activity?categories=relay');
    const added = (
      feed.json.items as { eventType: string; resourceId: string; actorLabel: string }[]
    ).find(
      (item) =>
        item.eventType === 'relay.adapter_added' && item.resourceId === 'contract-agent-hook'
    );
    expect(added?.actorLabel).toBe('Unidentified caller');
    await check(server, {
      method: 'DELETE',
      path: '/api/relay/adapters/contract-agent-hook',
      expect: { status: 200, body: { ok: true } },
    });
  });
});

describe('contract: the Relay groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;

  beforeAll(async () => {
    server = await bootComposedServer();
    cookie = await ownerCookie(server);
    // Asking for a password is the owner's own act, after their step-up (DOR-3330).
    await setup(
      server,
      'PATCH',
      '/api/config',
      { auth: { enabled: true } },
      await stepUpAt(server!.baseUrl, 'a-long-password-1')
    );
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('refuses a caller with no credential at the session gate, the webhook receiver included', async () => {
    for (const [method, url] of [
      ['GET', '/api/relay/messages'],
      ['POST', '/api/relay/messages'],
      ['GET', `/api/relay/messages/${UNKNOWN_MESSAGE_ID}/status`],
      ['GET', '/api/relay/endpoints'],
      ['GET', '/api/relay/stream'],
      ['GET', '/api/relay/adapters'],
      ['GET', '/api/relay/bindings'],
      ['POST', '/api/relay/bindings/x/test'],
      ['GET', '/api/relay/unclaimed-chats'],
      ['POST', '/api/relay/webhooks/any-hook'],
      ['GET', '/api/relay/not-a-route'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
    await check(server, {
      method: 'POST',
      path: '/api/relay/webhooks/any-hook',
      headers: signed('{}'),
      body: '{}',
      expect: { status: 401, schema: AUTH_REQUIRED },
    });
  });

  it('still refuses an oversized webhook before the gate', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/relay/webhooks/any-hook',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(WEBHOOK_MAX_BYTES + 1),
      expect: { status: 413, schema: TOO_LARGE },
    });
  });

  it('answers the owner’s cookie', async () => {
    await check(server, {
      path: '/api/relay/messages',
      headers: cookie,
      expect: { status: 200, schema: MESSAGE_PAGE },
    });
    await check(server, {
      path: `/api/relay/messages/${UNKNOWN_MESSAGE_ID}/status`,
      headers: cookie,
      expect: {
        status: 404,
        headers: { 'cache-control': 'no-store' },
        body: { error: 'Delivery receipt not found.', code: 'RELAY_RECEIPT_NOT_FOUND' },
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/relay/webhooks/any-hook',
      headers: { ...cookie, 'content-type': 'application/json' },
      body: '{}',
      expect: { status: 404, body: WEBHOOK_NOT_FOUND },
    });
    await check(server, {
      path: '/api/relay/unclaimed-chats',
      headers: cookie,
      expect: { status: 200, body: { chats: [] } },
    });
  });
});

contractSuite(
  'the Relay groups with Relay off',
  [
    {
      name: 'GET /messages does not exist',
      path: '/api/relay/messages',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /adapters does not exist',
      path: '/api/relay/adapters',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /unclaimed-chats does not exist',
      path: '/api/relay/unclaimed-chats',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /stream does not exist',
      path: '/api/relay/stream',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST a JSON webhook does not exist',
      method: 'POST',
      path: '/api/relay/webhooks/any-hook',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'POST a JSON webhook over 1 MB is still refused for its size',
      method: 'POST',
      path: '/api/relay/webhooks/any-hook',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(WEBHOOK_MAX_BYTES + 1),
      expect: { status: 413, schema: TOO_LARGE },
    },
  ],
  { env: { DORKOS_RELAY_ENABLED: 'false' } }
);
