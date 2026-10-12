/**
 * Contract for the connector route groups, which move to Hono together in
 * DOR-2804 and DOR-2805: the provider keys (`/api/connectors/providers`), the
 * owner's notification setup (`/connections/:id/events/*`), owner reviews and
 * grant changes (`/reviews`, `/agent-requests`, `/reconciliation/*`), the
 * Connections resources (`/catalog`, `/connections`, `/authentication-flows`,
 * …), program execution and usage (`/accessible`, `/executions`, `/usage/*`),
 * and the signed webhook ingress (`POST /webhooks/:providerInstanceId`). Those
 * PRs must pass this file unchanged.
 *
 * Connections act on outside services for agents, so most of this file is the
 * trust surface: who may make an account decision (never a program, an agent
 * or an approval-token holder; with login on only the owner's browser
 * session), who may run an action (an API key, never an agent session; only
 * what the named agent was granted; a high-risk one only after a person
 * approves), and what a webhook must prove before anything is stored.
 *
 * Three servers:
 *
 * 1. Login off, nothing set up: shapes, validation answers, 404s, HEAD,
 *    trailing slashes, the refusals a caller earns with headers alone, and
 *    every webhook refusal that needs no signing secret.
 * 2. Login off, driven by hand against the offline Composio service the test
 *    runtime starts (`services/connectors/providers/test-composio`): a key
 *    saved, a Gmail account connected, notifications set up, signed events
 *    delivered and refused, an agent granted reading, and an API key that runs
 *    what it was granted and nothing else.
 * 3. Login on: no credential is refused at the gate, except by the webhook
 *    ingress, which answers to its signature; an API key may not make an
 *    account decision; the owner's cookie may.
 *
 * No case touches the network: the offline service listens on loopback, and
 * no case asks for a logo the catalog would fetch.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** The offline service's project key and signing secret (`test-composio/data.ts`). */
const OFFLINE_KEY = 'dorkos-offline-composio-project-key';
const OFFLINE_SIGNING_SECRET = 'whsec_dorkos_offline_browser_fixture';
/** The webhook ingress's raw body ceiling (`CONNECTOR_EVENT_MAX_RAW_BYTES`). */
const MAX_EVENT_BYTES = 256 * 1024;

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** A caller holding an approval token is the requester, never the person. */
const REQUESTER = { 'X-DorkOS-Approval': 'not-a-real-approval' };
/** A bearer this machine never issued. */
const BOGUS_KEY = { authorization: 'Bearer not-a-real-key' };
const FOREIGN_HOST = { host: 'evil.example' };
const VALIDATION_FAILED = z
  .object({ error: z.literal('Validation failed'), details: z.unknown() })
  .strict();
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const HOST_REFUSED = z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose();
const OWNER_REQUIRED = {
  error: 'Programs and agents cannot make account decisions.',
  code: 'connector_owner_required',
  message: 'Programs and agents cannot make account decisions.',
};
const REVIEW_TOKEN_REFUSED = {
  error: 'An agent or approval token cannot make account decisions.',
  code: 'connector_owner_required',
  message: 'An agent or approval token cannot make account decisions.',
};
const PROGRAM_KEY_REQUIRED = {
  error: 'This program needs a verified API key to request an account change.',
  code: 'connector_program_credential_required',
};
const EXECUTION_KEY_REQUIRED = {
  error: 'Use a verified API key to call this service.',
  code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
};
const AGENT_SESSION_DENIED = {
  error:
    'This service call cannot run from an active agent session. Use an API key outside the session.',
  code: 'CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED',
  message: 'Run this service call with an API key outside an active agent session.',
};
const KEY_CHANGE_PERSON_ONLY = {
  code: 'person_only',
  error: 'Only you can change the keys DorkOS uses to reach your apps, from the DorkOS app.',
};
const NOTIFICATION_UNAVAILABLE = {
  code: 'not_found',
  error: 'This notification action is unavailable.',
};
const NOTIFICATION_INVALID = {
  code: 'invalid_event_request',
  error: 'Check the notification settings and try again.',
};
const EXECUTION_INVALID = z
  .object({
    error: z.literal('This service call is invalid. Check the request and try again.'),
    details: z.object({ formErrors: z.array(z.string()), fieldErrors: z.unknown() }).strict(),
  })
  .strict();
const RESOURCE_INVALID = z
  .object({
    error: z.literal('This connection request is invalid. Check the request and try again.'),
    details: z.array(z.unknown()),
  })
  .strict();
const GRANT_REQUIRED = {
  error: 'This agent is not granted the selected operation.',
  code: 'CONNECTOR_GRANT_REQUIRED',
};
const PROVIDER_LIST = z
  .object({
    providers: z.array(
      z
        .object({ type: z.string(), providerInstanceId: z.string(), configured: z.boolean() })
        .loose()
    ),
    appConnections: z.object({ ways: z.array(z.unknown()), newApps: z.unknown() }).strict(),
  })
  .strict();
const CATALOG = z
  .object({ services: z.array(z.object({ serviceSlug: z.string() }).loose()) })
  .loose();
const EVENT_SIGNATURE_REFUSED = { error: 'INVALID_EVENT_SIGNATURE' };
const EVENT_ENCODING_REFUSED = { error: 'UNSUPPORTED_EVENT_ENCODING' };
const EVENTS_UNAVAILABLE = { error: 'EVENTS_UNAVAILABLE' };
const EVENT_REQUEST_INVALID = { error: 'INVALID_EVENT_REQUEST' };
const EVENT_TOO_LARGE = { error: 'EVENT_TOO_LARGE' };

/** Webhook headers that are present and well formed, but sign nothing this server knows. */
function unknownSignature(id = 'evt_contract'): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', 'not-the-secret').update(`${id}.${timestamp}.{}`).digest('base64')}`,
  };
}

contractSuite('the connector groups, login off, nothing set up', [
  {
    name: 'GET /providers lists every provider and the ways set up to reach apps',
    path: '/api/connectors/providers',
    expect: { status: 200, headers: JSON_TYPE, schema: PROVIDER_LIST },
  },
  {
    name: 'GET /providers/ with a trailing slash is the same route',
    path: '/api/connectors/providers/',
    expect: { status: 200, schema: PROVIDER_LIST },
  },
  {
    name: 'HEAD /providers answers with no body',
    method: 'HEAD',
    path: '/api/connectors/providers',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'PUT a key for a provider DorkOS does not use is refused',
    method: 'PUT',
    path: '/api/connectors/providers/not-a-provider/credential',
    body: { secret: 'whatever' },
    expect: {
      status: 400,
      body: { error: 'DorkOS doesn’t use a key of this kind. Nothing was saved.' },
    },
  },
  {
    name: 'PUT a key with no secret is a validation failure',
    method: 'PUT',
    path: '/api/connectors/providers/composio/credential',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PUT a key with an empty body is a validation failure',
    method: 'PUT',
    path: '/api/connectors/providers/composio/credential',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PUT a key from an agent is refused: only a person changes keys',
    method: 'PUT',
    path: '/api/connectors/providers/composio/credential',
    headers: AGENT,
    body: { secret: 'whatever' },
    expect: { status: 403, body: KEY_CHANGE_PERSON_ONLY },
  },
  {
    name: 'PUT a key holding an approval token is refused: only a person changes keys',
    method: 'PUT',
    path: '/api/connectors/providers/composio/credential',
    headers: REQUESTER,
    body: { secret: 'whatever' },
    expect: { status: 403, body: KEY_CHANGE_PERSON_ONLY },
  },
  {
    name: 'DELETE a key for a provider DorkOS does not use is refused',
    method: 'DELETE',
    path: '/api/connectors/providers/not-a-provider/credential',
    expect: {
      status: 400,
      body: { error: 'DorkOS doesn’t use a key of this kind. Nothing was removed.' },
    },
  },
  {
    name: 'DELETE a key from an agent is refused',
    method: 'DELETE',
    path: '/api/connectors/providers/composio/credential',
    headers: AGENT,
    expect: { status: 403, body: KEY_CHANGE_PERSON_ONLY },
  },
  {
    name: 'GET an unknown path under /providers is the /api 404',
    path: '/api/connectors/providers/composio/credential',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /catalog lists apps, private and varying on the setup header',
    path: '/api/connectors/catalog',
    expect: {
      status: 200,
      headers: {
        ...JSON_TYPE,
        'cache-control': 'private, no-store',
        vary: 'Origin, x-dorkos-catalog-auth-setup',
      },
      schema: CATALOG,
    },
  },
  {
    name: 'GET /catalog with a limit out of range is refused with the issues',
    path: '/api/connectors/catalog?limit=0',
    expect: { status: 400, schema: RESOURCE_INVALID },
  },
  {
    name: 'GET /catalog with an unknown query key is refused',
    path: '/api/connectors/catalog?extra=1',
    expect: { status: 400, schema: RESOURCE_INVALID },
  },
  {
    name: 'GET /catalog with a repeated key is refused',
    path: '/api/connectors/catalog?q=a&q=b',
    expect: { status: 400, schema: RESOURCE_INVALID },
  },
  {
    name: 'GET a logo for an id that is not a service is a short-cached 404',
    path: '/api/connectors/catalog/logos/NOT_A_SERVICE',
    expect: {
      status: 404,
      headers: { 'cache-control': 'private, max-age=300' },
      body: { error: 'This app has no logo.' },
    },
  },
  {
    name: 'GET /connections lists none',
    path: '/api/connectors/connections',
    expect: { status: 200, body: { connections: [] } },
  },
  {
    name: 'GET /connections/ with a trailing slash is the same route',
    path: '/api/connectors/connections/',
    expect: { status: 200, body: { connections: [] } },
  },
  {
    name: 'HEAD /connections answers with no body',
    method: 'HEAD',
    path: '/api/connectors/connections',
    expect: { status: 200, body: '' },
  },
  {
    name: 'GET /connections from an agent is refused: not an account decision it may make',
    path: '/api/connectors/connections',
    headers: AGENT,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'GET /connections holding an approval token is refused',
    path: '/api/connectors/connections',
    headers: REQUESTER,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'GET /connections from a program (any bearer) is refused',
    path: '/api/connectors/connections',
    headers: BOGUS_KEY,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'GET /connections from a page on another origin is refused by CORS',
    path: '/api/connectors/connections',
    headers: { origin: 'http://evil.example' },
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'GET /connections for a foreign Host is refused',
    path: '/api/connectors/connections',
    headers: FOREIGN_HOST,
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET /connections/:id that does not exist is a 404',
    path: '/api/connectors/connections/not-a-connection',
    expect: { status: 404, body: { error: 'Connection not found.', code: 'connection_not_found' } },
  },
  {
    name: 'GET /connections/:id/disconnect-impact that does not exist is a 404',
    path: '/api/connectors/connections/not-a-connection/disconnect-impact',
    expect: { status: 404, body: { error: 'Connection not found.', code: 'connection_not_found' } },
  },
  {
    name: 'POST /connections with no body is a validation failure',
    method: 'POST',
    path: '/api/connectors/connections',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /connections with malformed JSON is a body-parser failure',
    method: 'POST',
    path: '/api/connectors/connections',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /connections from an agent is refused before the body is read',
    method: 'POST',
    path: '/api/connectors/connections',
    headers: AGENT,
    body: {},
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'PATCH /connections/:id with an empty label is a validation failure',
    method: 'PATCH',
    path: '/api/connectors/connections/not-a-connection',
    body: { label: '' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /connections/:id/remove with an unknown key is a validation failure',
    method: 'POST',
    path: '/api/connectors/connections/not-a-connection/remove',
    body: { extra: true },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /connections/:id/pause that does not exist is a 404',
    method: 'POST',
    path: '/api/connectors/connections/not-a-connection/pause',
    expect: { status: 404, body: { error: 'Connection not found.', code: 'connection_not_found' } },
  },
  {
    name: 'GET /authentication-flows/:id that does not exist is a 404',
    path: '/api/connectors/authentication-flows/not-a-flow',
    expect: { status: 404, schema: z.object({ code: z.literal('flow_not_found') }).loose() },
  },
  {
    name: 'GET /every-agent-grants lists none',
    path: '/api/connectors/every-agent-grants',
    expect: { status: 200, body: { connections: [] } },
  },
  {
    name: 'GET /agents/:id/connections for no agent is a 404',
    path: '/api/connectors/agents/not-an-agent/connections',
    expect: { status: 404, body: { error: 'Agent not found.', code: 'agent_not_found' } },
  },
  {
    name: 'GET /sessions/:id/connections for no chat is a 404',
    path: '/api/connectors/sessions/not-a-session/connections',
    expect: { status: 404, body: { error: 'Session not found.', code: 'session_not_found' } },
  },
  {
    name: 'PUT /sessions/:id/connections/:id with the wrong body is a validation failure',
    method: 'PUT',
    path: '/api/connectors/sessions/not-a-session/connections/not-a-connection',
    body: { enabled: false },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /apps/:toolkit/actions without a provider is refused with the issues',
    path: '/api/connectors/apps/gmail/actions',
    expect: { status: 400, schema: RESOURCE_INVALID },
  },
  {
    name: 'GET /reviews lists none',
    path: '/api/connectors/reviews',
    expect: { status: 200, body: { reviews: [] } },
  },
  {
    name: 'GET /reviews with an unknown state is a validation failure',
    path: '/api/connectors/reviews?state=bogus',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /reviews with an unknown query key is a validation failure',
    path: '/api/connectors/reviews?extra=1',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /reviews/:id that does not exist is a 404',
    path: '/api/connectors/reviews/not-a-review',
    expect: { status: 404, body: { error: 'Review not found.', code: 'review_not_found' } },
  },
  {
    name: 'POST /reviews/:id/decision with no body is a validation failure',
    method: 'POST',
    path: '/api/connectors/reviews/not-a-review/decision',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /reviews from the person with no body is a validation failure',
    method: 'POST',
    path: '/api/connectors/reviews',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /reviews with a bearer this machine never issued is refused',
    method: 'POST',
    path: '/api/connectors/reviews',
    headers: BOGUS_KEY,
    body: {},
    expect: { status: 401, body: PROGRAM_KEY_REQUIRED },
  },
  {
    name: 'POST /reviews from an agent is refused',
    method: 'POST',
    path: '/api/connectors/reviews',
    headers: AGENT,
    body: {},
    expect: { status: 403, body: REVIEW_TOKEN_REFUSED },
  },
  {
    name: 'GET /program/reviews/:id without an API key is refused',
    path: '/api/connectors/program/reviews/not-a-review',
    expect: { status: 401, body: PROGRAM_KEY_REQUIRED },
  },
  {
    name: 'GET /agent-requests lists none',
    path: '/api/connectors/agent-requests',
    expect: { status: 200, body: { requests: [] } },
  },
  {
    name: 'GET /agent-requests with an unknown key is a validation failure',
    path: '/api/connectors/agent-requests?extra=1',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /agent-requests/:id that does not exist is a 404',
    path: '/api/connectors/agent-requests/not-a-request',
    expect: {
      status: 404,
      body: { error: 'Service request not found.', code: 'request_not_found' },
    },
  },
  {
    name: 'POST /agent-requests/:id/decision from an agent is refused',
    method: 'POST',
    path: '/api/connectors/agent-requests/not-a-request/decision',
    headers: AGENT,
    body: {},
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'POST /reconciliation/previews with no body is a validation failure',
    method: 'POST',
    path: '/api/connectors/reconciliation/previews',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /reconciliation/apply with no body is a validation failure',
    method: 'POST',
    path: '/api/connectors/reconciliation/apply',
    body: {},
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /reconciliation/apply from an agent is refused: grants are the owner’s',
    method: 'POST',
    path: '/api/connectors/reconciliation/apply',
    headers: AGENT,
    body: {},
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'DELETE /connections/:id/every-agent that does not exist is a 404',
    method: 'DELETE',
    path: '/api/connectors/connections/not-a-connection/every-agent',
    expect: { status: 404, body: { error: 'Connection not found.', code: 'connection_not_found' } },
  },
  {
    name: 'GET notification definitions for no connection is unavailable',
    path: '/api/connectors/connections/not-a-connection/events/definitions',
    expect: { status: 404, body: NOTIFICATION_UNAVAILABLE },
  },
  {
    name: 'GET notification subscriptions for no connection is unavailable',
    path: '/api/connectors/connections/not-a-connection/events/subscriptions',
    expect: { status: 404, body: NOTIFICATION_UNAVAILABLE },
  },
  {
    name: 'GET notification subscriptions with an empty cursor is invalid',
    path: '/api/connectors/connections/not-a-connection/events/subscriptions?cursor=',
    expect: { status: 400, body: NOTIFICATION_INVALID },
  },
  {
    name: 'GET notification subscriptions with an unknown query key is invalid',
    path: '/api/connectors/connections/not-a-connection/events/subscriptions?extra=1',
    expect: { status: 400, body: NOTIFICATION_INVALID },
  },
  {
    name: 'GET the notification source for no connection is unavailable',
    path: '/api/connectors/connections/not-a-connection/events/source',
    expect: { status: 404, body: NOTIFICATION_UNAVAILABLE },
  },
  {
    name: 'PUT the notification source with no body is invalid',
    method: 'PUT',
    path: '/api/connectors/connections/not-a-connection/events/source',
    expect: { status: 400, body: NOTIFICATION_INVALID },
  },
  {
    name: 'POST a notification subscription with no body is invalid',
    method: 'POST',
    path: '/api/connectors/connections/not-a-connection/events/subscriptions',
    expect: { status: 400, body: NOTIFICATION_INVALID },
  },
  {
    name: 'DELETE a notification subscription for no connection is unavailable',
    method: 'DELETE',
    path: '/api/connectors/connections/not-a-connection/events/subscriptions/not-a-subscription',
    expect: { status: 404, body: NOTIFICATION_UNAVAILABLE },
  },
  {
    name: 'GET notification definitions from an agent is refused',
    path: '/api/connectors/connections/not-a-connection/events/definitions',
    headers: AGENT,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'an unknown path under a connection’s notifications still asks for the owner',
    method: 'PATCH',
    path: '/api/connectors/connections/not-a-connection/events/anything',
    headers: AGENT,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'an unknown path under a connection’s notifications is then the /api 404',
    method: 'PATCH',
    path: '/api/connectors/connections/not-a-connection/events/anything',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /accessible without an API key is refused',
    path: '/api/connectors/accessible',
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'GET /accessible from an agent session is refused',
    path: '/api/connectors/accessible',
    headers: AGENT,
    expect: { status: 403, body: AGENT_SESSION_DENIED },
  },
  {
    name: 'GET /accessible with a bearer this machine never issued is refused',
    path: '/api/connectors/accessible',
    headers: BOGUS_KEY,
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'GET /accessible/subscriptions without an API key is refused',
    path: '/api/connectors/accessible/subscriptions',
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'GET /accessible/:id/operations without an API key is refused',
    path: '/api/connectors/accessible/not-a-connection/operations',
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'POST /executions without an API key is refused',
    method: 'POST',
    path: '/api/connectors/executions',
    body: {},
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'POST /executions from an agent session is refused, API key or not',
    method: 'POST',
    path: '/api/connectors/executions',
    headers: { ...AGENT, ...BOGUS_KEY },
    body: {},
    expect: { status: 403, body: AGENT_SESSION_DENIED },
  },
  {
    name: 'POST /cli/executions without an API key is refused',
    method: 'POST',
    path: '/api/connectors/cli/executions',
    body: {},
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'GET /usage/agent without an API key is refused',
    path: '/api/connectors/usage/agent',
    expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
  },
  {
    name: 'GET /usage/operator lists nothing yet',
    path: '/api/connectors/usage/operator',
    expect: { status: 200, body: { items: [] } },
  },
  {
    name: 'GET /usage/operator with a limit out of range is refused',
    path: '/api/connectors/usage/operator?limit=0',
    expect: { status: 400, schema: EXECUTION_INVALID },
  },
  {
    name: 'GET /usage/operator from a program is refused: it is the owner’s view',
    path: '/api/connectors/usage/operator',
    headers: BOGUS_KEY,
    expect: { status: 403, body: OWNER_REQUIRED },
  },
  {
    name: 'GET /api/connectors itself is the /api 404',
    path: '/api/connectors',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET an unknown connectors path is the /api 404',
    path: '/api/connectors/not-a-route',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'DELETE /reviews is no route: the /api 404',
    method: 'DELETE',
    path: '/api/connectors/reviews',
    expect: { status: 404, body: NOT_FOUND },
  },
  // The signed webhook ingress answers before the session gate and before any
  // body is parsed; every answer below needs no signing secret.
  {
    name: 'a webhook with no signature headers is refused',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    body: {},
    expect: { status: 401, headers: JSON_TYPE, body: EVENT_SIGNATURE_REFUSED },
  },
  {
    name: 'a webhook missing one signature header is refused',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { 'content-type': 'application/json', 'webhook-id': 'a', 'webhook-timestamp': '1' },
    body: '{}',
    expect: { status: 401, body: EVENT_SIGNATURE_REFUSED },
  },
  {
    name: 'a webhook that is not JSON is refused before it is read',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), 'content-type': 'text/plain' },
    body: '{}',
    expect: { status: 415, body: EVENT_ENCODING_REFUSED },
  },
  {
    name: 'a compressed webhook is refused before it is read',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), 'content-encoding': 'gzip' },
    body: '{}',
    expect: { status: 415, body: EVENT_ENCODING_REFUSED },
  },
  {
    name: 'a webhook with an identity encoding is read',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), 'content-encoding': 'identity' },
    body: '{}',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook with a JSON charset is read',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), 'content-type': 'application/json; charset=utf-8' },
    body: '{}',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook with no body at all is refused as not JSON',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { 'webhook-id': 'a' },
    expect: { status: 415, body: EVENT_ENCODING_REFUSED },
  },
  {
    name: 'a signed webhook for an instance with no verifier is unavailable',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: unknownSignature(),
    body: '{}',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook body that is not even JSON is still read as bytes',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: unknownSignature(),
    body: '{not json',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook whose instance id is too long is refused',
    method: 'POST',
    path: `/api/connectors/webhooks/${'a'.repeat(257)}`,
    headers: unknownSignature(),
    body: '{}',
    expect: { status: 400, body: EVENT_REQUEST_INVALID },
  },
  {
    name: 'a webhook whose instance id is exactly the longest allowed is read',
    method: 'POST',
    path: `/api/connectors/webhooks/${'a'.repeat(256)}`,
    headers: unknownSignature(),
    body: '{}',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook one byte over the ceiling is refused',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: unknownSignature(),
    body: 'x'.repeat(MAX_EVENT_BYTES + 1),
    expect: { status: 413, body: EVENT_TOO_LARGE },
  },
  {
    name: 'a webhook exactly at the ceiling is read',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: unknownSignature(),
    body: 'x'.repeat(MAX_EVENT_BYTES),
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'a webhook for a foreign Host is refused before the signature is looked at',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), ...FOREIGN_HOST },
    body: '{}',
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'a webhook from an agent is judged by its signature alone',
    method: 'POST',
    path: '/api/connectors/webhooks/any-instance',
    headers: { ...unknownSignature(), ...AGENT },
    body: '{}',
    expect: { status: 503, body: EVENTS_UNAVAILABLE },
  },
  {
    name: 'GET on the webhook path is no route: the /api 404',
    path: '/api/connectors/webhooks/any-instance',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'PUT on the webhook path is no route: the /api 404',
    method: 'PUT',
    path: '/api/connectors/webhooks/any-instance',
    body: {},
    expect: { status: 404, body: NOT_FOUND },
  },
]);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to the server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** One answer: its status, JSON body (or `{}`) and headers. */
interface Answer {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

/** Send one request and return what it answered, whatever the status. */
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

/** Sign up the owner, sign in, and mint an API key; the cookie and the key. */
async function ownerCredentials(
  server: ComposedServer | undefined
): Promise<{ cookie: Record<string, string>; apiKey: Record<string, string> }> {
  const owner = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  const origin = { origin: server!.baseUrl };
  await setup(server, 'POST', '/api/auth/sign-up/email', { ...owner, name: 'Owner' }, origin);
  const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', owner, origin);
  const cookie = {
    cookie: signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0]!)
      .join('; '),
  };
  const created = await setup(
    server,
    'POST',
    '/api/auth/api-key/create',
    { name: 'contract' },
    { ...cookie, ...origin }
  );
  return { cookie, apiKey: { authorization: `Bearer ${created.json.key as string}` } };
}

/** An agent registered on a hand-driven server, and a token that names it. */
interface SeededAgent {
  agentId: string;
  agentDir: string;
  token: string;
}

/** Register a fresh test agent and mint its token. */
async function seedAgent(server: ComposedServer | undefined): Promise<SeededAgent> {
  const seeded = await setup(server, 'POST', '/api/test/seed-agent', {
    slot: 'shared',
    instance: `contract-${randomUUID().slice(0, 8)}`,
  });
  const agentDir = seeded.json.agentDir as string;
  const minted = await setup(server, 'POST', '/api/test/agent-token', { agentPath: agentDir });
  return { agentId: seeded.json.agentId as string, agentDir, token: minted.json.token as string };
}

/**
 * Save the offline service's key and connect one Gmail account through it,
 * as the Connections page does: the catalog, a flow, the consent page, a poll.
 */
async function connectOfflineGmail(
  server: ComposedServer | undefined
): Promise<{ providerInstanceId: string; connectionId: string }> {
  await setup(server, 'PUT', '/api/connectors/providers/composio/credential', {
    secret: OFFLINE_KEY,
  });
  const providers = await setup(server, 'GET', '/api/connectors/providers');
  const ways = (
    providers.json.appConnections as { ways: { type: string; providerInstanceId: string }[] }
  ).ways;
  const providerInstanceId = ways.find((way) => way.type === 'composio')!.providerInstanceId;
  const started = await setup(server, 'POST', '/api/connectors/connections', {
    providerInstanceId,
    toolkit: 'gmail',
    label: 'contract',
    idempotencyKey: randomUUID(),
  });
  const consent = await fetch(started.json.authorizeUrl as string, { method: 'POST' });
  expect(consent.ok).toBe(true);
  const flow = await setup(
    server,
    'GET',
    `/api/connectors/authentication-flows/${started.json.flowId as string}`
  );
  expect(flow.json.state).toBe('connected');
  return { providerInstanceId, connectionId: flow.json.connectionId as string };
}

/** The operation revisions of one connection, by classification. */
type Revisions = Record<'read' | 'write' | 'destructive', string>;

describe('contract: the connector groups, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  let providerInstanceId: string;
  let connectionId: string;
  let agent: SeededAgent;
  let apiKey: Record<string, string>;
  let revisions: Revisions;
  let subscriptionId: string;

  beforeAll(async () => {
    server = await bootComposedServer();
    ({ providerInstanceId, connectionId } = await connectOfflineGmail(server));
    agent = await seedAgent(server);
    ({ apiKey } = await ownerCredentials(server));
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    if (agent) rmSync(agent.agentDir, { recursive: true, force: true });
  }, 30_000);

  it('reports the saved key as configured, and never echoes it', async () => {
    const listed = await call(server, 'GET', '/api/connectors/providers');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).not.toContain(OFFLINE_KEY);
    const composio = (listed.json.providers as { type: string; configured: boolean }[]).find(
      (provider) => provider.type === 'composio'
    );
    expect(composio?.configured).toBe(true);
    const saved = await call(server, 'PUT', '/api/connectors/providers/composio/credential', {
      secret: OFFLINE_KEY,
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ type: 'composio', configured: true, registered: true });
    expect(JSON.stringify(saved.json)).not.toContain(OFFLINE_KEY);
  });

  it('lists the connected account and what it reaches', async () => {
    await check(server, {
      path: '/api/connectors/connections',
      expect: {
        status: 200,
        schema: z
          .object({
            connections: z
              .array(z.object({ connectionId: z.string(), lifecycle: z.string() }).loose())
              .length(1),
          })
          .strict(),
      },
    });
    await check(server, {
      path: `/api/connectors/connections/${connectionId}`,
      expect: {
        status: 200,
        schema: z
          .object({
            connection: z.object({ connectionId: z.literal(connectionId) }).loose(),
            provider: z.object({ providerInstanceId: z.literal(providerInstanceId) }).loose(),
          })
          .loose(),
      },
    });
    await check(server, {
      path: `/api/connectors/connections/${connectionId}/disconnect-impact`,
      expect: {
        status: 200,
        body: {
          connectionId,
          affectedAgentCount: 0,
          everyAgent: false,
          affectedSessionCount: 0,
          affectedSubscriptionCount: 0,
          pendingDeliveryCount: 0,
        },
      },
    });
    await check(server, {
      path: `/api/connectors/apps/gmail/actions?providerInstanceId=${providerInstanceId}`,
      expect: {
        status: 200,
        headers: { 'cache-control': 'private, no-store' },
        schema: z
          .object({
            status: z.literal('listed'),
            toolkit: z.literal('gmail'),
            actions: z.array(z.object({ operationSlug: z.string() }).loose()).length(3),
          })
          .loose(),
      },
    });
    await check(server, {
      path: '/api/connectors/catalog?q=gmail&limit=20',
      headers: { 'x-dorkos-catalog-auth-setup': '1' },
      expect: { status: 200, schema: CATALOG },
    });
  });

  it('takes the signing secret write-only, and refuses it from an agent', async () => {
    await check(server, {
      method: 'PUT',
      path: `/api/connectors/connections/${connectionId}/events/source`,
      headers: AGENT,
      body: {
        publicOrigin: 'https://offline-events.example',
        webhookSecret: OFFLINE_SIGNING_SECRET,
      },
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      path: `/api/connectors/connections/${connectionId}/events/source`,
      expect: {
        status: 200,
        body: { setupMode: 'byo_webhook', configured: false, endpoint: null, reason: null },
      },
    });
    const saved = await call(
      server,
      'PUT',
      `/api/connectors/connections/${connectionId}/events/source`,
      { publicOrigin: 'https://offline-events.example', webhookSecret: OFFLINE_SIGNING_SECRET }
    );
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({
      setupMode: 'byo_webhook',
      configured: true,
      endpoint: `https://offline-events.example/api/connectors/webhooks/${providerInstanceId}`,
      reason: null,
    });
    expect(JSON.stringify(saved.json)).not.toContain(OFFLINE_SIGNING_SECRET);
  });

  it('sets up a notification for an agent, by the owner only', async () => {
    const definitions = await setup(
      server,
      'GET',
      `/api/connectors/connections/${connectionId}/events/definitions`
    );
    const definition = (definitions.json.definitions as { eventType: string; id: string }[]).find(
      (item) => item.eventType === 'GMAIL_NEW_MESSAGE'
    )!;
    const scope = {
      agentId: agent.agentId,
      destination: { kind: 'agent', id: agent.agentId },
      definitionId: definition.id,
      filter: {},
      manageExistingTrigger: false,
    };
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/events/subscriptions`,
      headers: { 'X-DorkOS-Agent': agent.token },
      body: { requestId: randomUUID(), ...scope },
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/events/subscriptions`,
      body: { requestId: randomUUID(), ...scope, definitionId: 'not-a-definition' },
      expect: {
        status: 409,
        body: {
          code: 'definition_changed',
          error: 'These notification settings changed. Review them again.',
        },
      },
    });
    const created = await call(
      server,
      'POST',
      `/api/connectors/connections/${connectionId}/events/subscriptions`,
      { requestId: randomUUID(), ...scope }
    );
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ connectionId, agentId: agent.agentId, state: 'active' });
    subscriptionId = created.json.id as string;
    await check(server, {
      path: `/api/connectors/connections/${connectionId}/events/subscriptions`,
      expect: {
        status: 200,
        schema: z
          .object({
            subscriptions: z
              .array(
                z.object({ id: z.literal(subscriptionId), state: z.literal('active') }).loose()
              )
              .length(1),
          })
          .loose(),
      },
    });
  });

  it('accepts a signed event once a notification exists, and refuses a bad or stale one', async () => {
    const status = await setup(server, 'GET', '/api/test/composio/status');
    const accountOrdinal = (status.json.accountOrdinals as number[])[0];
    const emit = (eventId: string, signature: 'valid' | 'invalid') =>
      setup(server, 'POST', '/api/test/composio/emit', {
        accountOrdinal,
        eventType: 'GMAIL_NEW_MESSAGE',
        eventId,
        signature,
      });
    expect((await emit('contract-good', 'valid')).json).toEqual({
      eventId: 'contract-good',
      status: 202,
    });
    // The same event again, as a provider retrying it: still accepted.
    expect((await emit('contract-good', 'valid')).json).toEqual({
      eventId: 'contract-good',
      status: 202,
    });
    expect((await emit('contract-bad', 'invalid')).json).toEqual({
      eventId: 'contract-bad',
      status: 401,
    });

    const body = '{"type":"gmail_new_message"}';
    const sign = (id: string, timestamp: string, secret: string) =>
      `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    await check(server, {
      method: 'POST',
      path: `/api/connectors/webhooks/${providerInstanceId}`,
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'contract-stale',
        'webhook-timestamp': stale,
        'webhook-signature': sign('contract-stale', stale, OFFLINE_SIGNING_SECRET),
      },
      body,
      expect: { status: 401, body: EVENT_SIGNATURE_REFUSED },
    });
    const now = String(Math.floor(Date.now() / 1000));
    await check(server, {
      method: 'POST',
      path: `/api/connectors/webhooks/${providerInstanceId}`,
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'contract-wrong-secret',
        'webhook-timestamp': now,
        'webhook-signature': sign('contract-wrong-secret', now, 'not-the-secret'),
      },
      body,
      expect: { status: 401, body: EVENT_SIGNATURE_REFUSED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/webhooks/${providerInstanceId}`,
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'contract-wrong-secret',
        'webhook-timestamp': now,
        'webhook-signature': sign('contract-wrong-secret', now, 'not-the-secret'),
      },
      body: 'x'.repeat(MAX_EVENT_BYTES + 1),
      expect: { status: 413, body: EVENT_TOO_LARGE },
    });
  });

  it('lets the owner grant reading to one agent, and no program may', async () => {
    const preview = await call(server, 'POST', '/api/connectors/reconciliation/previews', {
      connectionId,
    });
    expect(preview.status).toBe(201);
    const candidates = preview.json.candidates as {
      operationRevisionId: string;
      capabilityClassification: keyof Revisions;
    }[];
    revisions = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.capabilityClassification,
        candidate.operationRevisionId,
      ])
    ) as Revisions;
    expect(Object.keys(revisions).sort()).toEqual(['destructive', 'read', 'write']);
    const grants = [{ agentId: agent.agentId, operationRevisionIds: [revisions.read] }];
    await check(server, {
      method: 'POST',
      path: '/api/connectors/reconciliation/apply',
      headers: apiKey,
      body: { previewId: preview.json.previewId, grants },
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/reconciliation/apply',
      body: { previewId: preview.json.previewId, grants },
      expect: {
        status: 200,
        body: {
          connectionId,
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
          grants,
        },
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/reconciliation/apply',
      body: { previewId: preview.json.previewId, grants },
      expect: {
        status: 409,
        body: {
          error: 'This permission review is stale. Refresh and review the current actions.',
          code: 'preview_stale',
        },
      },
    });
    await check(server, {
      path: `/api/connectors/agents/${agent.agentId}/connections`,
      expect: {
        status: 200,
        schema: z
          .object({
            agentId: z.literal(agent.agentId),
            connections: z
              .array(
                z.object({ operationRevisionIds: z.tuple([z.literal(revisions.read)]) }).loose()
              )
              .length(1),
          })
          .strict(),
      },
    });
  });

  it('lets an API key read what the agent was granted, and refuses an agent session', async () => {
    await check(server, {
      path: `/api/connectors/accessible?agentId=${agent.agentId}`,
      headers: apiKey,
      expect: {
        status: 200,
        schema: z
          .object({
            connections: z
              .array(z.object({ connectionId: z.literal(connectionId) }).loose())
              .length(1),
          })
          .strict(),
      },
    });
    await check(server, {
      path: '/api/connectors/accessible?agentId=not-an-agent',
      headers: apiKey,
      expect: { status: 404, body: { error: 'Agent not found.', code: 'agent_not_owned' } },
    });
    await check(server, {
      path: '/api/connectors/accessible',
      headers: apiKey,
      expect: { status: 400, schema: EXECUTION_INVALID },
    });
    await check(server, {
      path: `/api/connectors/accessible/${connectionId}/operations?agentId=${agent.agentId}`,
      headers: apiKey,
      expect: {
        status: 200,
        schema: z
          .object({
            connectionId: z.literal(connectionId),
            operations: z
              .array(z.object({ operationRevisionId: z.literal(revisions.read) }).loose())
              .length(1),
          })
          .strict(),
      },
    });
    await check(server, {
      path: `/api/connectors/accessible/subscriptions?agentId=${agent.agentId}`,
      headers: apiKey,
      expect: {
        status: 200,
        schema: z
          .object({
            agentId: z.literal(agent.agentId),
            subscriptions: z.array(z.object({ id: z.literal(subscriptionId) }).loose()).length(1),
          })
          .strict(),
      },
    });
    await check(server, {
      path: `/api/connectors/accessible?agentId=${agent.agentId}`,
      headers: { ...apiKey, 'X-DorkOS-Agent': agent.token },
      expect: { status: 403, body: AGENT_SESSION_DENIED },
    });
  });

  it('runs a granted read, and refuses what the agent was not granted', async () => {
    const target = (operationRevisionId: string, agentId = agent.agentId) => ({
      agentId,
      connectionId,
      operationRevisionId,
      arguments: {},
    });
    const SUCCESS = z
      .object({
        logicalOperationId: z.string(),
        attemptCount: z.literal(1),
        result: z
          .object({
            status: z.literal('success'),
            data: z.object({ messages: z.array(z.object({ subject: z.string() })) }),
          })
          .strict(),
      })
      .strict();
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: target(revisions.read),
      expect: { status: 200, schema: SUCCESS },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/cli/executions',
      headers: apiKey,
      body: target(revisions.read),
      expect: { status: 200, schema: SUCCESS },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: target(revisions.write),
      expect: { status: 403, body: GRANT_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: target(revisions.destructive),
      expect: { status: 403, body: GRANT_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: target(revisions.read, 'not-an-agent'),
      expect: {
        status: 409,
        body: { error: 'That agent isn’t one of yours.', code: 'CONNECTOR_AGENT_NOT_OWNED' },
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: { agentId: agent.agentId },
      expect: { status: 400, schema: EXECUTION_INVALID },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: { ...apiKey, 'X-DorkOS-Agent': agent.token },
      body: target(revisions.read),
      expect: { status: 403, body: AGENT_SESSION_DENIED },
    });
    await check(server, {
      path: `/api/connectors/usage/agent?agentId=${agent.agentId}`,
      headers: apiKey,
      expect: {
        status: 200,
        schema: z.object({ items: z.array(z.unknown()) }).loose(),
      },
    });
    await check(server, {
      path: '/api/connectors/usage/operator',
      expect: {
        status: 200,
        schema: z
          .object({
            items: z
              .array(
                z.object({ actorKind: z.literal('program'), outcome: z.literal('success') }).loose()
              )
              .length(2),
          })
          .loose(),
      },
    });
  });

  it('asks a person before a granted high-risk action runs', async () => {
    const preview = await setup(server, 'POST', '/api/connectors/reconciliation/previews', {
      connectionId,
    });
    await setup(server, 'POST', '/api/connectors/reconciliation/apply', {
      previewId: preview.json.previewId,
      grants: [
        { agentId: agent.agentId, operationRevisionIds: [revisions.read, revisions.destructive] },
      ],
    });
    const target = {
      agentId: agent.agentId,
      connectionId,
      operationRevisionId: revisions.destructive,
      arguments: {},
    };
    const APPROVAL = (reason: string) =>
      z
        .object({
          status: z.literal('approval_required'),
          capabilityId: z.literal('connectors.execute_destructive'),
          tier: z.literal('destructive'),
          approvalId: z.string(),
          approvalToken: z.string(),
          reason: z.literal(reason),
        })
        .loose();
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: apiKey,
      body: target,
      expect: { status: 202, schema: APPROVAL('no_approval') },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/executions',
      headers: { ...apiKey, 'X-DorkOS-Approval': 'not-a-real-approval' },
      body: target,
      expect: { status: 202, schema: APPROVAL('unknown_token') },
    });
  });

  it('changes and ends a connection, by the owner only', async () => {
    await check(server, {
      method: 'DELETE',
      path: `/api/connectors/connections/${connectionId}/events/subscriptions/${subscriptionId}`,
      headers: AGENT,
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/connectors/connections/${connectionId}/events/subscriptions/${subscriptionId}`,
      expect: { status: 204, body: '' },
    });
    const LIFECYCLE = (lifecycle: string) =>
      z.object({ connectionId: z.literal(connectionId), lifecycle: z.literal(lifecycle) }).loose();
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/pause`,
      headers: apiKey,
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/pause`,
      expect: { status: 200, schema: LIFECYCLE('paused') },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/resume`,
      expect: { status: 200, schema: LIFECYCLE('connected') },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/connectors/connections/${connectionId}`,
      body: { label: 'renamed' },
      expect: { status: 200, schema: LIFECYCLE('connected') },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/reconnect`,
      body: { idempotencyKey: randomUUID() },
      expect: {
        status: 201,
        schema: z.object({ flowId: z.string(), state: z.literal('pending') }).loose(),
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/remove`,
      body: {},
      expect: {
        status: 409,
        body: {
          error: 'Disconnect this account before removing it.',
          code: 'connection_not_disconnected',
        },
      },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/connectors/connections/${connectionId}/every-agent`,
      expect: { status: 200, body: { connectionId, revokedCount: 0 } },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/connectors/connections/${connectionId}`,
      expect: { status: 200, schema: LIFECYCLE('disconnected') },
    });
    await check(server, {
      method: 'POST',
      path: `/api/connectors/connections/${connectionId}/remove`,
      body: {},
      expect: { status: 204, body: '' },
    });
    await check(server, {
      method: 'DELETE',
      path: '/api/connectors/providers/composio/credential',
      expect: {
        status: 200,
        schema: z.object({ type: z.literal('composio'), configured: z.literal(false) }).loose(),
      },
    });
  });
});

describe('contract: the connector groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;

  beforeAll(async () => {
    server = await bootComposedServer();
    ({ cookie, apiKey } = await ownerCredentials(server));
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } }, cookie);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/connectors/providers'],
      ['PUT', '/api/connectors/providers/composio/credential'],
      ['GET', '/api/connectors/catalog'],
      ['GET', '/api/connectors/connections'],
      ['GET', '/api/connectors/reviews'],
      ['GET', '/api/connectors/connections/x/events/source'],
      ['GET', '/api/connectors/accessible'],
      ['POST', '/api/connectors/executions'],
      ['GET', '/api/connectors/not-a-route'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets a webhook through the gate, to be judged by its signature', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/connectors/webhooks/any-instance',
      body: {},
      expect: { status: 401, body: EVENT_SIGNATURE_REFUSED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/connectors/webhooks/any-instance',
      headers: unknownSignature(),
      body: '{}',
      expect: { status: 503, body: EVENTS_UNAVAILABLE },
    });
  });

  it('refuses an API key every account decision; the owner’s cookie may make them', async () => {
    await check(server, {
      path: '/api/connectors/connections',
      headers: apiKey,
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      path: '/api/connectors/connections',
      headers: cookie,
      expect: { status: 200, body: { connections: [] } },
    });
    await check(server, {
      path: '/api/connectors/connections',
      headers: { ...cookie, origin: 'http://evil.example' },
      expect: { status: 500, schema: MALFORMED_JSON },
    });
    await check(server, {
      path: '/api/connectors/reviews',
      headers: cookie,
      expect: { status: 200, body: { reviews: [] } },
    });
    await check(server, {
      path: '/api/connectors/usage/operator',
      headers: apiKey,
      expect: { status: 403, body: OWNER_REQUIRED },
    });
    await check(server, {
      path: '/api/connectors/connections/x/events/source',
      headers: cookie,
      expect: { status: 404, body: NOTIFICATION_UNAVAILABLE },
    });
  });

  it('refuses an API key a provider key change; the owner’s cookie may make it', async () => {
    await check(server, {
      method: 'PUT',
      path: '/api/connectors/providers/not-a-provider/credential',
      headers: apiKey,
      body: { secret: 'whatever' },
      expect: { status: 403, body: KEY_CHANGE_PERSON_ONLY },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/connectors/providers/not-a-provider/credential',
      headers: cookie,
      body: { secret: 'whatever' },
      expect: {
        status: 400,
        body: { error: 'DorkOS doesn’t use a key of this kind. Nothing was saved.' },
      },
    });
    await check(server, {
      path: '/api/connectors/providers',
      headers: apiKey,
      expect: { status: 200, schema: PROVIDER_LIST },
    });
  });

  it('lets an API key ask for an account change, and refuses it from the cookie path', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/connectors/reviews',
      headers: apiKey,
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    });
    await check(server, {
      path: '/api/connectors/program/reviews/not-a-review',
      headers: apiKey,
      expect: { status: 404, body: { error: 'Review not found.', code: 'review_not_found' } },
    });
    await check(server, {
      path: '/api/connectors/program/reviews/not-a-review',
      headers: cookie,
      expect: { status: 401, body: PROGRAM_KEY_REQUIRED },
    });
    await check(server, {
      path: '/api/connectors/accessible?agentId=not-an-agent',
      headers: apiKey,
      expect: { status: 404, body: { error: 'Agent not found.', code: 'agent_not_owned' } },
    });
    await check(server, {
      path: '/api/connectors/accessible?agentId=not-an-agent',
      headers: cookie,
      expect: { status: 401, body: EXECUTION_KEY_REQUIRED },
    });
  });
});
