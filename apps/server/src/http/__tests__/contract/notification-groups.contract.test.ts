/**
 * Contract for the route groups that tell a person what is waiting on them and
 * record what they decide, which move to Hono together in DOR-2799: the
 * Inbox (`/api/notifications`), web push (`/api/push`), approvals
 * (`/api/approvals`), extension decisions (`/api/extension-decisions`), the
 * permission routes and the agent pause routes. That PR must pass this file
 * unchanged.
 *
 * The permission and pause routers were mounted on all of `/api` on Express,
 * so this file also pins that they answer only their own paths: an unknown
 * path beside them is still the `/api` 404.
 *
 * Approvals and permissions are authority surfaces, so the refusals are the
 * heart of it. Three servers:
 *
 * 1. Login off, nothing seeded: the shapes, the validation answers, the 404s,
 *    and every refusal a caller can earn with headers alone (an agent header,
 *    an approval token, a cross-site `Origin`).
 * 2. Login off, with a registered agent, a real agent token and seeded request
 *    cards: a person answering once, Always allow refused, an answered card,
 *    the agent and its token refused, pausing and resuming that agent, and
 *    reading and changing its permissions.
 * 3. Login on, with an owner signed in and one of their API keys: no
 *    credential is refused by the session gate, an API key reads but may not
 *    decide or change anything, and the owner's cookie may.
 *
 * Servers 2 and 3 are driven by hand rather than by `contractSuite`, because
 * what they are asked depends on ids and credentials the server hands out.
 * They seed an agent under the git-ignored `tmp/` the test-control routes use.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { z } from 'zod';
import {
  ListNotificationsResponseSchema,
  PushSubscriptionDTOSchema,
} from '@dorkos/shared/notification-schemas';
import { PendingApprovalsResponseSchema } from '@dorkos/shared/approval-schemas';
import { ListExtensionDecisionsResponseSchema } from '@dorkos/shared/extension-decision-schemas';
import {
  AgentPermissionsResponseSchema,
  PermissionHistoryResponseSchema,
  PermissionsResponseSchema,
} from '@dorkos/shared/permissions';
import { AgentPauseListSchema, AgentPauseResultSchema } from '@dorkos/shared/mesh-schemas';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
  stepUpAt,
} from './harness.js';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** The header a caller holding an approval token sends. */
const APPROVAL_TOKEN = { 'X-DorkOS-Approval': 'some-token' };
/** A ULID nothing in a fresh install has. */
const UNKNOWN_ULID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const NOTIFICATIONS_OPERATOR_ONLY = {
  error: 'Marking a notification read has to happen inside DorkOS, by the person it was for.',
  code: 'NOTIFICATIONS_OPERATOR_ONLY',
};
const PUSH_OPERATOR_ONLY = {
  error:
    'Deciding which devices DorkOS may reach is something only you can do, from inside DorkOS.',
  code: 'PUSH_OPERATOR_ONLY',
};
const AGENT_CANNOT_DECIDE = {
  error: 'Approvals are decided by a person in DorkOS, not by an agent',
  code: 'AGENT_CANNOT_DECIDE',
};
const REQUESTER_CANNOT_DECIDE = {
  error: 'The caller holding an approval token cannot also decide that approval',
  code: 'REQUESTER_CANNOT_DECIDE',
};
const UNKNOWN_APPROVAL = { error: 'No such approval', code: 'UNKNOWN_APPROVAL' };
const ONLY_A_PERSON = 'Only a person can change permissions. Agents can ask the person.';
const DECISION_AGENT_REFUSAL = {
  error: 'Only a person can answer this.',
  code: 'decision_person_required',
  message:
    'DorkOS changed nothing. Only a person can answer this. Ask them to answer it in DorkOS.',
};
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed') }).loose();

/** A push subscription body `POST /api/push/subscriptions` accepts. */
const SUBSCRIPTION = {
  endpoint: `https://push.example.test/send/${randomUUID()}`,
  keys: { p256dh: 'contract-p256dh', auth: 'contract-auth' },
};

contractSuite('notification, push, approval, extension-decision, permission and pause groups', [
  // notifications
  {
    name: 'GET /api/notifications lists an empty Inbox',
    path: '/api/notifications',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { notifications: [], nextCursor: null, unreadCount: 0 },
    },
  },
  {
    name: 'GET /api/notifications/ answers with a trailing slash',
    path: '/api/notifications/?limit=5',
    expect: { status: 200, schema: ListNotificationsResponseSchema },
  },
  {
    name: 'HEAD /api/notifications answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/notifications',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/notifications refuses a limit out of range',
    path: '/api/notifications?limit=0',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /api/notifications reads as empty to an agent rather than refusing it',
    path: '/api/notifications',
    headers: AGENT,
    expect: { status: 200, body: { notifications: [], nextCursor: null, unreadCount: 0 } },
  },
  {
    name: 'PATCH /api/notifications/:id/read marks nothing for an unknown id',
    method: 'PATCH',
    path: '/api/notifications/no-such-notification/read',
    expect: { status: 200, body: { ok: true, marked: 0, unreadCount: 0 } },
  },
  {
    name: 'PATCH /api/notifications/:id/read refuses an agent',
    method: 'PATCH',
    path: '/api/notifications/no-such-notification/read',
    headers: AGENT,
    expect: { status: 403, body: NOTIFICATIONS_OPERATOR_ONLY },
  },
  {
    name: 'POST /api/notifications/read-all marks nothing in an empty Inbox',
    method: 'POST',
    path: '/api/notifications/read-all',
    expect: { status: 200, body: { ok: true, marked: 0, unreadCount: 0 } },
  },
  {
    name: 'POST /api/notifications/read-all refuses an agent',
    method: 'POST',
    path: '/api/notifications/read-all',
    headers: AGENT,
    expect: { status: 403, body: NOTIFICATIONS_OPERATOR_ONLY },
  },
  {
    name: 'GET /api/notifications/read-all is the /api 404',
    path: '/api/notifications/read-all',
    expect: { status: 404, body: NOT_FOUND },
  },

  // push
  {
    name: 'GET /api/push/vapid-public-key hands out this install’s public key',
    path: '/api/push/vapid-public-key',
    expect: { status: 200, headers: JSON_TYPE, schema: z.object({ key: z.string().min(1) }) },
  },
  {
    name: 'GET /api/push/vapid-public-key refuses an agent',
    path: '/api/push/vapid-public-key',
    headers: AGENT,
    expect: { status: 403, body: PUSH_OPERATOR_ONLY },
  },
  {
    name: 'GET /api/push/subscriptions lists no devices',
    path: '/api/push/subscriptions',
    expect: { status: 200, body: { subscriptions: [] } },
  },
  {
    name: 'HEAD /api/push/subscriptions answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/push/subscriptions',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/push/subscriptions refuses an agent',
    path: '/api/push/subscriptions',
    headers: AGENT,
    expect: { status: 403, body: PUSH_OPERATOR_ONLY },
  },
  {
    name: 'POST /api/push/subscriptions refuses an agent before reading the body',
    method: 'POST',
    path: '/api/push/subscriptions',
    headers: AGENT,
    body: { nothing: true },
    expect: { status: 403, body: PUSH_OPERATOR_ONLY },
  },
  {
    name: 'POST /api/push/subscriptions refuses a body with no keys',
    method: 'POST',
    path: '/api/push/subscriptions',
    body: { endpoint: SUBSCRIPTION.endpoint },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/push/subscriptions refuses an empty body',
    method: 'POST',
    path: '/api/push/subscriptions',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/push/subscriptions refuses malformed JSON as the chain does',
    method: 'POST',
    path: '/api/push/subscriptions',
    headers: { 'content-type': 'application/json' },
    body: '{"endpoint":',
    expect: { status: 500, schema: z.object({ code: z.literal('INTERNAL_ERROR') }).loose() },
  },
  {
    name: 'POST /api/push/subscriptions stores a device and never echoes its endpoint',
    method: 'POST',
    path: '/api/push/subscriptions',
    body: SUBSCRIPTION,
    expect: {
      status: 200,
      schema: z
        .object({ ok: z.literal(true), subscription: PushSubscriptionDTOSchema.strict() })
        .strict(),
    },
  },
  {
    name: 'POST /api/push/subscriptions/ refreshes the same device with a trailing slash (after the case above)',
    method: 'POST',
    path: '/api/push/subscriptions/',
    body: SUBSCRIPTION,
    expect: { status: 200, schema: z.object({ ok: z.literal(true) }).loose() },
  },
  {
    name: 'GET /api/push/subscriptions lists the one device (after the cases above)',
    path: '/api/push/subscriptions',
    expect: {
      status: 200,
      schema: z.object({ subscriptions: z.array(PushSubscriptionDTOSchema).length(1) }),
    },
  },
  {
    name: 'DELETE /api/push/subscriptions/:id answers ok for an id that is not there',
    method: 'DELETE',
    path: '/api/push/subscriptions/no-such-device',
    expect: { status: 200, body: { ok: true, removed: 0 } },
  },
  {
    name: 'DELETE /api/push/subscriptions/:id refuses an agent',
    method: 'DELETE',
    path: '/api/push/subscriptions/no-such-device',
    headers: AGENT,
    expect: { status: 403, body: PUSH_OPERATOR_ONLY },
  },
  {
    name: 'GET /api/push is the /api 404',
    path: '/api/push',
    expect: { status: 404, body: NOT_FOUND },
  },

  // approvals
  {
    name: 'GET /api/approvals/pending lists nothing waiting',
    path: '/api/approvals/pending',
    expect: { status: 200, headers: JSON_TYPE, body: { approvals: [] } },
  },
  {
    name: 'GET /api/approvals/pending is readable by an agent',
    path: '/api/approvals/pending/',
    headers: AGENT,
    expect: { status: 200, schema: PendingApprovalsResponseSchema },
  },
  {
    name: 'HEAD /api/approvals/pending answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/approvals/pending',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/approvals/:id/grant answers 404 for an unknown approval',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/grant`,
    expect: { status: 404, body: UNKNOWN_APPROVAL },
  },
  {
    name: 'POST /api/approvals/:id/grant/ answers with a trailing slash',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/grant/`,
    body: { answer: 'once' },
    expect: { status: 404, body: UNKNOWN_APPROVAL },
  },
  {
    name: 'POST /api/approvals/:id/grant refuses an answer it does not know',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/grant`,
    body: { answer: 'forever' },
    expect: {
      status: 400,
      schema: z
        .object({ error: z.literal('Validation failed'), code: z.literal('INVALID_GRANT_BODY') })
        .loose(),
    },
  },
  {
    name: 'POST /api/approvals/:id/grant refuses an agent before reading anything',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/grant`,
    headers: AGENT,
    body: { answer: 'forever' },
    expect: { status: 403, body: AGENT_CANNOT_DECIDE },
  },
  {
    name: 'POST /api/approvals/:id/grant refuses the caller holding an approval token',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/grant`,
    headers: APPROVAL_TOKEN,
    expect: { status: 403, body: REQUESTER_CANNOT_DECIDE },
  },
  {
    name: 'POST /api/approvals/:id/deny answers 404 for an unknown approval',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/deny`,
    body: { reason: 'Not now' },
    expect: { status: 404, body: UNKNOWN_APPROVAL },
  },
  {
    name: 'POST /api/approvals/:id/deny refuses a reason that is not text',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/deny`,
    body: { reason: 42 },
    expect: {
      status: 400,
      schema: z
        .object({ error: z.literal('Validation failed'), code: z.literal('INVALID_DENY_BODY') })
        .loose(),
    },
  },
  {
    name: 'POST /api/approvals/:id/deny refuses an agent',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/deny`,
    headers: AGENT,
    expect: { status: 403, body: AGENT_CANNOT_DECIDE },
  },
  {
    name: 'POST /api/approvals/:id/deny refuses the caller holding an approval token',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/deny`,
    headers: APPROVAL_TOKEN,
    expect: { status: 403, body: REQUESTER_CANNOT_DECIDE },
  },
  {
    name: 'POST /api/approvals/:id/dismiss-suggestion answers 404 for an unknown approval',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/dismiss-suggestion`,
    expect: { status: 404, body: UNKNOWN_APPROVAL },
  },
  {
    name: 'POST /api/approvals/:id/dismiss-suggestion refuses an agent',
    method: 'POST',
    path: `/api/approvals/${UNKNOWN_ULID}/dismiss-suggestion`,
    headers: AGENT,
    expect: { status: 403, body: AGENT_CANNOT_DECIDE },
  },
  {
    name: 'GET /api/approvals/:id/grant is the /api 404',
    path: `/api/approvals/${UNKNOWN_ULID}/grant`,
    expect: { status: 404, body: NOT_FOUND },
  },

  // extension decisions
  {
    name: 'GET /api/extension-decisions lists nothing open',
    path: '/api/extension-decisions',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { decisions: [], offers: [] },
    },
  },
  {
    name: 'GET /api/extension-decisions/ answers with a trailing slash and a filter',
    path: '/api/extension-decisions/?extensionId=some-extension',
    expect: { status: 200, schema: ListExtensionDecisionsResponseSchema },
  },
  {
    name: 'HEAD /api/extension-decisions answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/extension-decisions',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/extension-decisions refuses a repeated filter',
    path: '/api/extension-decisions?extensionId=a&extensionId=b',
    expect: { status: 400, body: { error: 'Invalid query' } },
  },
  {
    name: 'POST /api/extension-decisions/:id/action answers 404 for an id that is not a decision id',
    method: 'POST',
    path: '/api/extension-decisions/not-a-ulid/action',
    headers: AGENT,
    body: { action: 'approve' },
    expect: { status: 404, body: { error: 'Not found' } },
  },
  {
    name: 'POST /api/extension-decisions/:id/action refuses an agent',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/action`,
    headers: AGENT,
    body: { action: 'approve' },
    expect: { status: 403, body: DECISION_AGENT_REFUSAL },
  },
  {
    // CORS refuses a foreign origin before the person bar sees it.
    name: 'POST /api/extension-decisions/:id/action from another site is refused by the chain',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/action`,
    headers: { origin: 'http://evil.example' },
    body: { action: 'approve' },
    expect: {
      status: 403,
      body: {
        error:
          'This instance does not answer to pages from "http://evil.example". If that is how you reach DorkOS, list it in DORKOS_CORS_ORIGIN, or open DorkOS at its own address.',
        code: 'ORIGIN_NOT_ALLOWED',
      },
    },
  },
  {
    name: 'POST /api/extension-decisions/:id/action refuses a body with no action',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/action`,
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 400,
      body: { error: 'Send an action, and keep notes under 2000 characters.' },
    },
  },
  {
    name: 'POST /api/extension-decisions/:id/action answers the inbox’s refusal for an unknown decision',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/action`,
    body: { action: 'approve' },
    expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }) },
  },
  {
    name: 'POST /api/extension-decisions/:id/offer refuses a body with no answer',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/offer/`,
    body: { accept: 'yes' },
    expect: { status: 400, body: { error: 'Send { accept: true | false }.' } },
  },
  {
    name: 'POST /api/extension-decisions/:id/offer refuses an agent',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/offer`,
    headers: AGENT,
    body: { accept: true },
    expect: { status: 403, body: DECISION_AGENT_REFUSAL },
  },
  {
    name: 'POST /api/extension-decisions/:id/offer answers the inbox’s refusal for an unknown offer',
    method: 'POST',
    path: `/api/extension-decisions/${UNKNOWN_ULID}/offer`,
    body: { accept: false },
    expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }) },
  },

  // permissions
  {
    name: 'GET /api/permissions reads the default layer',
    path: '/api/permissions',
    expect: { status: 200, headers: JSON_TYPE, schema: PermissionsResponseSchema },
  },
  {
    name: 'GET /api/permissions/ answers with a trailing slash, to an agent too',
    path: '/api/permissions/',
    headers: AGENT,
    expect: { status: 200, schema: PermissionsResponseSchema },
  },
  {
    name: 'HEAD /api/permissions answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/permissions',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/permissions/history reads an empty history',
    path: '/api/permissions/history',
    expect: { status: 200, schema: PermissionHistoryResponseSchema },
  },
  {
    name: 'GET /api/permissions/history refuses a cursor that is not a time',
    path: '/api/permissions/history?before=yesterday',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PUT /api/permissions/preset refuses a preset it does not know',
    method: 'PUT',
    path: '/api/permissions/preset',
    body: { preset: 'reckless', surface: 'settings' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PUT /api/permissions/preset refuses an agent before reading the body',
    method: 'PUT',
    path: '/api/permissions/preset',
    headers: AGENT,
    body: { preset: 'reckless' },
    expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'AGENT_CANNOT_DECIDE' } },
  },
  {
    name: 'PUT /api/permissions/preset refuses the caller holding an approval token',
    method: 'PUT',
    path: '/api/permissions/preset',
    headers: APPROVAL_TOKEN,
    body: { preset: 'balanced', surface: 'settings' },
    expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'REQUESTER_CANNOT_DECIDE' } },
  },
  {
    name: 'PATCH /api/permissions/defaults refuses an empty body',
    method: 'PATCH',
    path: '/api/permissions/defaults',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/permissions/defaults refuses an agent',
    method: 'PATCH',
    path: '/api/permissions/defaults',
    headers: AGENT,
    body: { surface: 'settings' },
    expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'AGENT_CANNOT_DECIDE' } },
  },
  {
    name: 'PATCH /api/permissions/defaults with nothing to change changes nothing',
    method: 'PATCH',
    path: '/api/permissions/defaults',
    body: { surface: 'settings' },
    expect: {
      status: 200,
      schema: z.object({ changes: z.array(z.unknown()), permissions: PermissionsResponseSchema }),
    },
  },
  {
    name: 'POST /api/permissions/history/:eventId/undo refuses an agent',
    method: 'POST',
    path: '/api/permissions/history/no-such-event/undo',
    headers: AGENT,
    expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'AGENT_CANNOT_DECIDE' } },
  },
  {
    name: 'POST /api/permissions/history/:eventId/undo refuses a force that is not a flag',
    method: 'POST',
    path: '/api/permissions/history/no-such-event/undo',
    body: { force: 'yes' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/permissions/history/:eventId/undo answers the service’s refusal for an unknown change',
    method: 'POST',
    path: '/api/permissions/history/no-such-event/undo',
    expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }).loose() },
  },
  {
    name: 'GET /api/agents/:id/permissions answers the service’s refusal for an unknown agent',
    path: '/api/agents/no-such-agent/permissions',
    expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }).loose() },
  },
  {
    name: 'PATCH /api/agents/:id/permissions refuses an agent',
    method: 'PATCH',
    path: '/api/agents/no-such-agent/permissions',
    headers: AGENT,
    body: { surface: 'agent-page' },
    expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'AGENT_CANNOT_DECIDE' } },
  },
  {
    name: 'PATCH /api/agents/:id/permissions refuses an empty body',
    method: 'PATCH',
    path: '/api/agents/no-such-agent/permissions',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/agents/:id/permissions answers the service’s refusal for an unknown agent',
    method: 'PATCH',
    path: '/api/agents/no-such-agent/permissions',
    body: { surface: 'agent-page' },
    expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }).loose() },
  },
  {
    name: 'GET /api/permissions/nothing-here is the /api 404, not a permission route',
    path: '/api/permissions/nothing-here',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/nothing-here is still the /api 404 beside the routers mounted on /api',
    path: '/api/nothing-here',
    expect: { status: 404, body: NOT_FOUND },
  },

  // agent pause
  {
    name: 'GET /api/agents/pauses lists no paused agents',
    path: '/api/agents/pauses',
    expect: { status: 200, headers: JSON_TYPE, body: { pauses: [] } },
  },
  {
    name: 'GET /api/agents/pauses/ answers with a trailing slash, to an agent too',
    path: '/api/agents/pauses/',
    headers: AGENT,
    expect: { status: 200, schema: AgentPauseListSchema },
  },
  {
    name: 'HEAD /api/agents/pauses answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/agents/pauses',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/agents/:id/pause answers 404 for an unknown agent',
    method: 'POST',
    path: '/api/agents/no-such-agent/pause',
    body: { reason: 'Contract check' },
    expect: { status: 404, schema: z.object({ code: z.literal('AGENT_NOT_FOUND') }).loose() },
  },
  {
    name: 'POST /api/agents/:id/pause refuses a reason that is not text',
    method: 'POST',
    path: '/api/agents/no-such-agent/pause',
    body: { reason: 42 },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/agents/:id/resume answers 404 for an unknown agent with no body',
    method: 'POST',
    path: '/api/agents/no-such-agent/resume',
    expect: { status: 404, schema: z.object({ code: z.literal('AGENT_NOT_FOUND') }).loose() },
  },
]);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/**
 * Send one case to a server this file booted itself.
 *
 * @param server - The server.
 * @param ask - The request and what it must answer.
 */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/**
 * Send one setup request and return its JSON body, failing loudly when the
 * server refuses it.
 */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(new URL(path, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

/** An agent registered on a hand-driven server, and a token that names it. */
interface SeededAgent {
  agentId: string;
  agentDir: string;
  token: string;
}

/** Register a fresh test agent and mint its token. */
async function seedAgent(server: ComposedServer | undefined): Promise<SeededAgent> {
  const instance = `contract-${randomUUID().slice(0, 8)}`;
  const seeded = await setup(server, 'POST', '/api/test/seed-agent', {
    slot: 'permission-requester',
    instance,
  });
  const agentDir = seeded.json.agentDir as string;
  const minted = await setup(server, 'POST', '/api/test/agent-token', { agentPath: agentDir });
  return {
    agentId: seeded.json.agentId as string,
    agentDir,
    token: minted.json.token as string,
  };
}

/** Raise one request card for `agent`, as the gate would. */
async function seedApproval(
  server: ComposedServer | undefined,
  agent: SeededAgent,
  capabilityId = 'agent.pause',
  area = 'agents'
): Promise<string> {
  const seeded = await setup(server, 'POST', '/api/test/seed-approval', {
    capabilityId,
    agentPath: agent.agentDir,
    area,
    summary: 'Contract check',
  });
  return seeded.json.approvalId as string;
}

describe('contract: approvals, permissions and pause, with a registered agent (login off)', () => {
  let server: ComposedServer | undefined;
  let agent: SeededAgent;
  beforeAll(async () => {
    server = await bootComposedServer();
    agent = await seedAgent(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    if (agent) rmSync(agent.agentDir, { recursive: true, force: true });
  }, 30_000);

  it('lists a seeded card as pending, to a person and to an agent', async () => {
    const approvalId = await seedApproval(server, agent);
    const listed = z.object({
      approvals: z
        .array(z.object({ approvalId: z.string() }).loose())
        .refine((cards) => cards.some((card) => card.approvalId === approvalId)),
    });
    await check(server, {
      path: '/api/approvals/pending',
      expect: { status: 200, schema: listed },
    });
    await check(server, {
      path: '/api/approvals/pending',
      headers: { 'X-DorkOS-Agent': agent.token },
      expect: { status: 200, schema: listed },
    });
  });

  it('refuses the agent that asked, by its real token, then lets a person answer once', async () => {
    const approvalId = await seedApproval(server, agent);
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      headers: { 'X-DorkOS-Agent': agent.token },
      expect: { status: 403, body: AGENT_CANNOT_DECIDE },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      expect: {
        status: 200,
        body: { ok: true, approvalId, outcome: 'granted', answer: 'once' },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      body: { answer: 'once' },
      expect: {
        status: 409,
        body: { error: 'This approval was already decided', code: 'APPROVAL_NOT_PENDING' },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/deny`,
      expect: {
        status: 409,
        body: { error: 'This approval was already decided', code: 'APPROVAL_NOT_PENDING' },
      },
    });
  });

  it('lets a person deny with a reason, and records the answer in the permission history', async () => {
    const approvalId = await seedApproval(server, agent);
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/deny/`,
      body: { reason: 'Not today' },
      expect: { status: 200, body: { ok: true, approvalId, outcome: 'denied' } },
    });
    await check(server, {
      path: `/api/permissions/history?agentId=${encodeURIComponent(agent.agentId)}`,
      expect: { status: 200, schema: PermissionHistoryResponseSchema },
    });
  });

  it('refuses Always allow when the setting cannot be written, and turns its suggestion off', async () => {
    const approvalId = await seedApproval(server, agent, 'contract.no_such_action', 'agents');
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      body: { answer: 'always' },
      expect: {
        status: 409,
        body: {
          error: 'There is no action called "contract.no_such_action".',
          code: 'UNKNOWN_ACTION',
        },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/dismiss-suggestion/`,
      expect: { status: 200, body: { ok: true, approvalId } },
    });
    // Nothing was granted: the card is still open for a plain yes.
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      expect: { status: 200, body: { ok: true, approvalId, outcome: 'granted', answer: 'once' } },
    });
  });

  it('answers Always allow for an action the agent may be allowed', async () => {
    const approvalId = await seedApproval(server, agent, 'tasks_update', 'tasks');
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${approvalId}/grant`,
      body: { answer: 'always' },
      expect: { status: 200, body: { ok: true, approvalId, outcome: 'granted', answer: 'always' } },
    });
  });

  it('reads and changes the agent’s permissions for a person, and refuses the agent', async () => {
    await check(server, {
      path: `/api/agents/${agent.agentId}/permissions`,
      expect: { status: 200, headers: JSON_TYPE, schema: AgentPermissionsResponseSchema },
    });
    await check(server, {
      method: 'HEAD',
      path: `/api/agents/${agent.agentId}/permissions/`,
      expect: { status: 200, headers: JSON_TYPE, body: '' },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/agents/${agent.agentId}/permissions`,
      headers: { 'X-DorkOS-Agent': agent.token },
      body: { surface: 'agent-page', actions: { 'agent.pause': 'allowed' } },
      expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'AGENT_CANNOT_DECIDE' } },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/agents/${agent.agentId}/permissions`,
      body: { surface: 'agent-page', areas: { rooms: 'ask' } },
      expect: {
        status: 200,
        schema: z.object({
          changes: z.array(z.unknown()),
          permissions: AgentPermissionsResponseSchema,
        }),
      },
    });
  });

  it('pauses the agent for a person, keeps it from lifting its own pause, and resumes it', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/agents/${agent.agentId}/pause`,
      body: { reason: 'Contract check' },
      expect: {
        status: 200,
        schema: AgentPauseResultSchema.extend({
          paused: z.literal(true),
          changed: z.literal(true),
        }),
      },
    });
    await check(server, {
      path: '/api/agents/pauses',
      expect: { status: 200, schema: AgentPauseListSchema.refine((l) => l.pauses.length === 1) },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${agent.agentId}/resume`,
      headers: { 'X-DorkOS-Agent': agent.token },
      expect: { status: 403, schema: z.object({ code: z.literal('CANNOT_RESUME_SELF') }).loose() },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${agent.agentId}/resume/`,
      expect: {
        status: 200,
        schema: AgentPauseResultSchema.extend({
          paused: z.literal(false),
          changed: z.literal(true),
        }),
      },
    });
  });
});

describe('contract: the same groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  let agent: SeededAgent;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer();
    // Seeded while login is off: the test-control routes sit behind the gate.
    agent = await seedAgent(server);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    const session = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0]!)
      .join('; ');
    cookie = { cookie: session };
    // Asking for a password is the owner's own act, after their step-up (DOR-3330).
    const person = await stepUpAt(server.baseUrl, OWNER.password);
    await setup(
      server,
      'PATCH',
      '/api/config',
      { auth: { enabled: true } },
      { ...person, ...origin }
    );
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      {
        ...cookie,
        ...origin,
      }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    if (agent) rmSync(agent.agentDir, { recursive: true, force: true });
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();

  it('refuses a caller with no credential at the session gate, on every group', async () => {
    for (const [method, path] of [
      ['GET', '/api/notifications'],
      ['GET', '/api/push/subscriptions'],
      ['GET', '/api/approvals/pending'],
      ['POST', `/api/approvals/${UNKNOWN_ULID}/grant`],
      ['GET', '/api/extension-decisions'],
      ['GET', '/api/permissions'],
      ['PUT', '/api/permissions/preset'],
      ['GET', '/api/agents/pauses'],
      ['POST', '/api/agents/no-such-agent/pause'],
    ] as const) {
      await check(server, { method, path, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets an API key read the Inbox but not mark it read, nor touch push devices', async () => {
    await check(server, {
      path: '/api/notifications',
      headers: apiKey,
      expect: { status: 200, schema: ListNotificationsResponseSchema },
    });
    await check(server, {
      method: 'POST',
      path: '/api/notifications/read-all',
      headers: apiKey,
      expect: { status: 403, body: NOTIFICATIONS_OPERATOR_ONLY },
    });
    await check(server, {
      path: '/api/push/subscriptions',
      headers: apiKey,
      expect: { status: 403, body: PUSH_OPERATOR_ONLY },
    });
    await check(server, {
      method: 'POST',
      path: '/api/notifications/read-all',
      headers: cookie,
      expect: { status: 200, body: { ok: true, marked: 0, unreadCount: 0 } },
    });
    await check(server, {
      path: '/api/push/subscriptions',
      headers: cookie,
      expect: { status: 200, body: { subscriptions: [] } },
    });
  });

  it('refuses an API key a decision on a card, and lets the owner’s cookie make it', async () => {
    const grantId = await seedApprovalSignedIn();
    const denyId = await seedApprovalSignedIn();
    const cookieRefusal = {
      error:
        'Approving or refusing a risky action has to happen inside DorkOS, by a person who is signed in. ' +
        'A program holding an API key cannot answer for you. Open DorkOS and answer it there.',
      code: 'operator_cookie_required',
    };
    for (const id of [grantId, denyId]) {
      for (const verb of ['grant', 'deny', 'dismiss-suggestion']) {
        await check(server, {
          method: 'POST',
          path: `/api/approvals/${id}/${verb}`,
          headers: apiKey,
          expect: { status: 403, body: cookieRefusal },
        });
      }
    }
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${grantId}/grant`,
      headers: { ...apiKey, 'X-DorkOS-Agent': agent.token },
      expect: { status: 403, body: AGENT_CANNOT_DECIDE },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${grantId}/grant`,
      headers: cookie,
      body: { answer: 'once' },
      expect: {
        status: 200,
        body: { ok: true, approvalId: grantId, outcome: 'granted', answer: 'once' },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/approvals/${denyId}/deny`,
      headers: cookie,
      expect: { status: 200, body: { ok: true, approvalId: denyId, outcome: 'denied' } },
    });
  });

  it('refuses an API key a permission change, and lets the owner’s cookie make it', async () => {
    await check(server, {
      path: '/api/permissions',
      headers: apiKey,
      expect: { status: 200, schema: PermissionsResponseSchema },
    });
    await check(server, {
      method: 'PATCH',
      path: '/api/permissions/defaults',
      headers: apiKey,
      body: { surface: 'settings' },
      expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'operator_cookie_required' } },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/agents/${agent.agentId}/permissions`,
      headers: apiKey,
      body: { surface: 'agent-page' },
      expect: { status: 403, body: { error: ONLY_A_PERSON, code: 'operator_cookie_required' } },
    });
    await check(server, {
      method: 'PATCH',
      path: '/api/permissions/defaults',
      headers: cookie,
      body: { surface: 'settings' },
      expect: {
        status: 200,
        schema: z.object({ changes: z.array(z.unknown()), permissions: PermissionsResponseSchema }),
      },
    });
  });

  it('refuses an API key an answer to an extension decision', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/extension-decisions/${UNKNOWN_ULID}/action`,
      headers: apiKey,
      body: { action: 'approve' },
      expect: {
        status: 403,
        schema: z
          .object({
            error: z.literal('Only a person can answer this.'),
            code: z.literal('operator_cookie_required'),
          })
          .loose(),
      },
    });
  });

  it('lets an API key and the owner pause and resume an agent', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/agents/${agent.agentId}/pause`,
      headers: apiKey,
      expect: { status: 200, schema: AgentPauseResultSchema.extend({ paused: z.literal(true) }) },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${agent.agentId}/resume`,
      headers: cookie,
      expect: { status: 200, schema: AgentPauseResultSchema.extend({ paused: z.literal(false) }) },
    });
  });

  /** Raise a card while login is on: the test-control route takes the cookie. */
  async function seedApprovalSignedIn(): Promise<string> {
    const seeded = await setup(
      server,
      'POST',
      '/api/test/seed-approval',
      {
        capabilityId: 'agent.pause',
        agentPath: agent.agentDir,
        area: 'agents',
        summary: 'Contract check',
      },
      cookie
    );
    return seeded.json.approvalId as string;
  }
});
