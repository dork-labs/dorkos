/**
 * Contract for the session routes (`/api/sessions`), which move to Hono in
 * DOR-2816: the session list and its reads, the 202 message trigger, the
 * per-session queue, answering a prompt, the session canvas, continuing on
 * another account, the DevTools sinks and the recording upload, turn images,
 * stopping, and the durable per-session event stream. That PR must pass this
 * file unchanged.
 *
 * The stream is the public integration contract
 * (`docs/integrations/sse-protocol.mdx`); the browser pins its head and its
 * first frame in `apps/e2e/tests/streams/sse-contract.spec.ts`. This file pins
 * the bytes: the head, the snapshot first on a cold connect, the `id:` line on
 * every live frame, and a resume that replays exactly the frames after its
 * cursor, in order and with no gap.
 *
 * Three servers, all on the test-mode runtime:
 *
 * 1. Login off, nothing set up: the shapes and refusals each route gives a
 *    session nobody started, validation, the boundary, and the chain's
 *    refusals (a foreign host, a wrong origin, malformed and oversize JSON).
 * 2. Login off, driven by hand: chats a person and an agent start, what an
 *    agent may not read or decide, a busy session's lock and queue, a prompt
 *    answered, and the stream.
 * 3. Login on: no credential is refused at the gate; the owner's cookie reads
 *    and streams.
 *
 * Every chat runs in a folder under the git-ignored `.temp/` at the repository
 * root (the server's directory boundary); the test-mode runtime keeps its
 * transcripts in memory.
 */
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  stepUpAt,
} from './harness.js';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/** The folder every chat in this file runs in, git-ignored. */
const WORK = path.join(REPO_ROOT, '.temp', `contract-sessions-${randomUUID().slice(0, 8)}`);
mkdirSync(WORK, { recursive: true });
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const S = '/api/sessions';
const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const SESSION_NOT_FOUND = { error: 'Session not found', code: 'SESSION_NOT_FOUND' };
const INVALID_SESSION_ID = { error: 'Invalid session ID', code: 'INVALID_SESSION_ID' };
const INVALID_REQUEST = { error: 'Invalid request', code: 'VALIDATION_ERROR' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const AGENT_UNVERIFIED = {
  error:
    'That agent identity could not be verified. Its token may have been revoked, or it may have expired.',
  code: 'AGENT_IDENTITY_UNVERIFIED',
};
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const CORS_REFUSED = z.object({ code: z.literal('ORIGIN_NOT_ALLOWED') }).loose();
const HOST_REFUSED = z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose();
const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
const OUTSIDE_BOUNDARY = {
  error: 'Access denied: path outside directory boundary',
  code: 'OUTSIDE_BOUNDARY',
};
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
/** The 202 every accepted message answers with. */
const ACCEPTED = z
  .object({
    sessionId: z.string().uuid(),
    messageId: z.string().uuid(),
    outcome: z.object({ messageId: z.string().uuid(), requested: z.string(), applied: z.string() }),
    queuePosition: z.number().int(),
  })
  .strict();
/** One session as the list and `GET /:id` carry it: every one names its runtime. */
const SESSION = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runtime: z.literal('test-mode'),
    permissionMode: z.string(),
  })
  .loose();
/** The headers every session stream answers with, whoever asks. */
const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
  'transfer-encoding': 'chunked',
  'access-control-allow-credentials': 'true',
  vary: 'Origin',
} as const;
/** The SSE keepalive interval (`SSE.HEARTBEAT_INTERVAL_MS`), and a margin past it. */
const HEARTBEAT_WAIT_MS = 15_000 + 5_000;

/** A session nobody started, one per case that could leave state behind. */
const fresh = (): string => randomUUID();
const UNKNOWN = fresh();

/** A multipart body, for the recording upload. */
const BOUNDARY = 'contract-boundary';
const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
function part(name: string, value: string, filename?: string): string {
  const disposition = `form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}`;
  const type = filename ? '\r\nContent-Type: image/gif' : '';
  return `--${BOUNDARY}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n${value}\r\n`;
}
const multipart = (...parts: string[]): string => `${parts.join('')}--${BOUNDARY}--\r\n`;

contractSuite('the session routes, login off, nothing started', [
  // ---- the list and the reads that need no session --------------------------
  {
    name: 'GET /api/sessions lists across runtimes, empty here',
    path: S,
    expect: { status: 200, headers: JSON_TYPE, body: { sessions: [] } },
  },
  {
    name: 'GET /api/sessions with a limit that is not a number is a 400 with the details',
    path: `${S}?limit=abc`,
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: {
        error: 'Invalid query',
        details: {
          errors: [],
          properties: { limit: { errors: ['Invalid input: expected number, received NaN'] } },
        },
      },
    },
  },
  {
    name: 'GET /api/sessions naming a runtime that is not registered is a 400',
    path: `${S}?runtime=nope`,
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Unknown runtime: nope', code: 'UNKNOWN_RUNTIME' },
    },
  },
  {
    name: 'GET /api/sessions in a folder outside the boundary is a 403',
    path: `${S}?cwd=${encodeURIComponent('/etc')}`,
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'GET /api/sessions/recent across every agent',
    path: `${S}/recent`,
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { sessions: [], agentActivity: {}, warnings: [] },
    },
  },
  {
    name: 'GET /api/sessions/recent with a bad limit is a 400',
    path: `${S}/recent?limit=abc`,
    expect: {
      status: 400,
      headers: JSON_TYPE,
      schema: z.object({ error: z.literal('Invalid query') }).loose(),
    },
  },
  {
    name: 'GET /api/sessions/daily-counts counts a week by default',
    path: `${S}/daily-counts`,
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { days: 7, dailyCounts: [0, 0, 0, 0, 0, 0, 0], warnings: [] },
    },
  },
  {
    name: 'GET /api/sessions/daily-counts with a bad day count is a 400',
    path: `${S}/daily-counts?days=abc`,
    expect: {
      status: 400,
      headers: JSON_TYPE,
      schema: z.object({ error: z.literal('Invalid query') }).loose(),
    },
  },
  {
    name: 'GET /api/sessions/pending-interactions, nothing waiting',
    path: `${S}/pending-interactions`,
    expect: { status: 200, headers: JSON_TYPE, body: { interactions: [] } },
  },
  {
    name: 'GET /api/sessions/pending-interactions to an agent is an empty list, never a 403',
    path: `${S}/pending-interactions`,
    headers: AGENT,
    expect: { status: 200, headers: JSON_TYPE, body: { interactions: [] } },
  },

  // ---- one session's reads ----------------------------------------------------
  {
    name: 'GET /api/sessions/:id with an id that is not one is a 400',
    path: `${S}/not-a-uuid`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'GET /api/sessions/:id nobody started is a 404',
    path: `${S}/${UNKNOWN}`,
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },
  {
    name: 'GET /api/sessions/:id/runtime-type infers the owner, writing nothing',
    path: `${S}/${UNKNOWN}/runtime-type`,
    expect: { status: 200, headers: JSON_TYPE, body: { runtime: 'test-mode' } },
  },
  {
    name: 'GET /api/sessions/:id/runtime-type with a bad id is a 400',
    path: `${S}/nope/runtime-type`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'GET /api/sessions/:id/settings with nothing stored is null',
    path: `${S}/${UNKNOWN}/settings`,
    expect: { status: 200, headers: JSON_TYPE, body: { settings: null } },
  },
  {
    name: 'GET /api/sessions/:id/settings with a bad id is a 400',
    path: `${S}/nope/settings`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'GET /api/sessions/:id/tasks of a session nobody started has none',
    path: `${S}/${UNKNOWN}/tasks`,
    expect: { status: 200, headers: JSON_TYPE, body: { tasks: [] } },
  },
  {
    name: 'GET /api/sessions/:id/tasks in a folder outside the boundary is a 403',
    path: `${S}/${UNKNOWN}/tasks?cwd=${encodeURIComponent('/etc')}`,
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'GET /api/sessions/:id/messages of a session nobody started is empty',
    path: `${S}/${UNKNOWN}/messages`,
    expect: { status: 200, headers: JSON_TYPE, body: { messages: [] } },
  },
  {
    name: 'GET /api/sessions/:id/messages in a folder outside the boundary is a 403',
    path: `${S}/${UNKNOWN}/messages?cwd=${encodeURIComponent('/etc')}`,
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'GET /api/sessions/:id/chat-messages: nothing sent, nothing stopped',
    path: `${S}/${UNKNOWN}/chat-messages`,
    expect: { status: 200, headers: JSON_TYPE, body: { sent: [], stops: [] } },
  },
  {
    name: 'GET /api/sessions/:id/limit-history of a session this server does not know is a 404',
    path: `${S}/${UNKNOWN}/limit-history`,
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },
  {
    name: 'GET /api/sessions/:id/attachments/:file nobody wrote is a 404',
    path: `${S}/${UNKNOWN}/attachments/abc.png`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such image.', code: 'ATTACHMENT_NOT_FOUND' },
    },
  },
  {
    name: 'GET under a session on a path no route has is the /api 404',
    path: `${S}/${UNKNOWN}/nonexistent`,
    expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
  },
  {
    name: 'DELETE /api/sessions/:id does not exist',
    method: 'DELETE',
    path: `${S}/${UNKNOWN}`,
    expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
  },

  // ---- rename and settings ----------------------------------------------------
  {
    name: 'PATCH /api/sessions/:id with a body it cannot read is a 400',
    method: 'PATCH',
    path: `${S}/${UNKNOWN}`,
    body: { title: 5 },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'PATCH /api/sessions/:id with a bad id is a 400',
    method: 'PATCH',
    path: `${S}/nope`,
    body: { title: 'x' },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'PATCH /api/sessions/:id naming a mode the runtime does not declare is a 400',
    method: 'PATCH',
    path: `${S}/${fresh()}`,
    body: { permissionMode: 'no-such-mode' },
    expect: {
      status: 400,
      headers: JSON_TYPE,
      schema: z.object({ code: z.literal('UNSUPPORTED_PERMISSION_MODE') }).loose(),
    },
  },
  {
    name: 'PATCH /api/sessions/:id in a folder outside the boundary is a 403',
    method: 'PATCH',
    path: `${S}/${fresh()}?cwd=${encodeURIComponent('/etc')}`,
    body: { title: 'x' },
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },

  // ---- fork, plugins ---------------------------------------------------------
  {
    name: 'POST /api/sessions/:id/fork with a body it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/fork`,
    body: { upToMessageId: 5 },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'POST /api/sessions/:id/fork of a session nobody started is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/fork`,
    body: {},
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'Session not found or fork failed', code: 'FORK_FAILED' },
    },
  },
  {
    name: 'POST /api/sessions/:id/fork in a folder outside the boundary is a 403',
    method: 'POST',
    path: `${S}/${UNKNOWN}/fork?cwd=${encodeURIComponent('/etc')}`,
    body: {},
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'POST /api/sessions/:id/reload-plugins with nothing running is a 409',
    method: 'POST',
    path: `${S}/${UNKNOWN}/reload-plugins`,
    expect: {
      status: 409,
      headers: JSON_TYPE,
      body: {
        error: 'No active query — send a message first to establish a session',
        code: 'NO_ACTIVE_QUERY',
      },
    },
  },

  // ---- the message trigger ---------------------------------------------------
  {
    name: 'POST /api/sessions/:id/messages with no body is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/messages`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'POST /api/sessions/:id/messages with an empty message is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/messages`,
    body: { content: '' },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'POST /api/sessions/:id/messages with a bad id is a 400',
    method: 'POST',
    path: `${S}/nope/messages`,
    body: { content: 'hi' },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'POST /api/sessions/:id/messages to an id nobody started, without create, is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/messages`,
    body: { content: 'hi' },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: {
        error: 'No session has this id. To start a new one, send create: true.',
        code: 'SESSION_NOT_FOUND',
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/messages with malformed JSON is the error handler’s answer',
    method: 'POST',
    path: `${S}/${UNKNOWN}/messages`,
    headers: { 'content-type': 'application/json' },
    body: '{',
    expect: { status: 500, headers: JSON_TYPE, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /api/sessions/:id/messages over the body limit is a 413',
    method: 'POST',
    path: `${S}/${UNKNOWN}/messages`,
    body: { content: 'x'.repeat(1_100_000) },
    expect: {
      status: 413,
      headers: JSON_TYPE,
      body: { error: 'That is too large to send in one request.', code: 'REQUEST_TOO_LARGE' },
    },
  },
  {
    name: 'POST /api/sessions/:id/opened answers 204 and nothing else',
    method: 'POST',
    path: `${S}/${UNKNOWN}/opened`,
    expect: { status: 204, body: '' },
  },
  {
    name: 'POST /api/sessions/:id/opened with a bad id is a 400',
    method: 'POST',
    path: `${S}/nope/opened`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },

  // ---- the queue -------------------------------------------------------------
  {
    name: 'GET /api/sessions/:id/queue, nothing waiting',
    path: `${S}/${UNKNOWN}/queue`,
    expect: { status: 200, headers: JSON_TYPE, body: { queue: [] } },
  },
  {
    name: 'PATCH /api/sessions/:id/queue/:messageId with a body it cannot read is a 400',
    method: 'PATCH',
    path: `${S}/${UNKNOWN}/queue/m1`,
    body: { content: 5 },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'PATCH /api/sessions/:id/queue/:messageId nobody queued is a 404',
    method: 'PATCH',
    path: `${S}/${UNKNOWN}/queue/m1`,
    body: { content: 'x' },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such queued message', code: 'QUEUED_MESSAGE_NOT_FOUND' },
    },
  },
  {
    name: 'DELETE /api/sessions/:id/queue/:messageId nobody queued is a 404',
    method: 'DELETE',
    path: `${S}/${UNKNOWN}/queue/m1`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such queued message', code: 'QUEUED_MESSAGE_NOT_FOUND' },
    },
  },

  // ---- answering a prompt ----------------------------------------------------
  ...(['approve', 'deny', 'submit-answers', 'submit-elicitation'] as const).map((route) => ({
    name: `POST /api/sessions/:id/${route} with a body it cannot read is a 400`,
    method: 'POST',
    path: `${S}/${UNKNOWN}/${route}`,
    body: {},
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  })),
  ...(['batch-approve', 'batch-deny'] as const).map((route) => ({
    name: `POST /api/sessions/:id/${route} with a body it cannot read is a 400`,
    method: 'POST',
    path: `${S}/${UNKNOWN}/${route}`,
    body: {},
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  })),
  {
    name: 'POST /api/sessions/:id/approve with nothing pending is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/approve`,
    body: { toolCallId: 't1' },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No pending approval', code: 'NO_PENDING_APPROVAL' },
    },
  },
  {
    name: 'POST /api/sessions/:id/deny with nothing pending is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/deny`,
    body: { toolCallId: 't1', reason: '  ' },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No pending approval', code: 'NO_PENDING_APPROVAL' },
    },
  },
  {
    name: 'POST /api/sessions/:id/batch-approve reports each call',
    method: 'POST',
    path: `${S}/${UNKNOWN}/batch-approve`,
    body: { toolCallIds: ['t1', 't2'] },
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: {
        results: [
          { toolCallId: 't1', ok: false },
          { toolCallId: 't2', ok: false },
        ],
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/batch-deny reports each call',
    method: 'POST',
    path: `${S}/${UNKNOWN}/batch-deny`,
    body: { toolCallIds: ['t1'] },
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { results: [{ toolCallId: 't1', ok: false }] },
    },
  },
  {
    name: 'POST /api/sessions/:id/submit-answers with nothing pending is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/submit-answers`,
    body: { toolCallId: 't1', answers: {} },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No pending question', code: 'NO_PENDING_QUESTION' },
    },
  },
  {
    name: 'POST /api/sessions/:id/submit-elicitation with nothing pending is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/submit-elicitation`,
    body: { interactionId: 'i1', action: 'decline' },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No pending elicitation', code: 'NO_PENDING_ELICITATION' },
    },
  },
  {
    name: 'POST /api/sessions/:id/approve with a bad id is a 400',
    method: 'POST',
    path: `${S}/nope/approve`,
    body: { toolCallId: 't1' },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },

  // ---- widget actions and command intents ------------------------------------
  {
    name: 'POST /api/sessions/:id/ui-action names the first thing wrong with its body',
    method: 'POST',
    path: `${S}/${UNKNOWN}/ui-action`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: {
        error: 'Invalid input: expected string, received undefined',
        code: 'VALIDATION_ERROR',
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/ui-action on a session that exists nowhere is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/ui-action`,
    body: { actionId: 'a', widgetId: 'w', toolCallId: 't' },
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },
  {
    name: 'POST /api/sessions/:id/command-intents/:intent that is not one is a 422',
    method: 'POST',
    path: `${S}/${UNKNOWN}/command-intents/bogus`,
    expect: {
      status: 422,
      headers: JSON_TYPE,
      body: { error: 'Unknown command intent: bogus', code: 'INVALID_COMMAND_INTENT' },
    },
  },
  {
    name: 'POST /api/sessions/:id/command-intents/compact with a body it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/command-intents/compact`,
    body: { instructions: 5 },
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Invalid request body', code: 'VALIDATION_ERROR' },
    },
  },
  {
    name: 'POST /api/sessions/:id/command-intents/compact on a session that exists nowhere is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/command-intents/compact`,
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },

  // ---- the session canvas ----------------------------------------------------
  {
    name: 'GET /api/sessions/:id/canvas is empty',
    path: `${S}/${UNKNOWN}/canvas`,
    expect: { status: 200, headers: JSON_TYPE, body: { documents: [] } },
  },
  {
    name: 'POST /api/sessions/:id/canvas with a body it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/canvas`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: {
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { content: ['Invalid input: expected object, received undefined'] },
        },
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/canvas on a session this server does not know is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/canvas`,
    body: { content: { type: 'markdown', title: 'Notes', content: '# Notes' } },
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },
  {
    name: 'GET /api/sessions/:id/canvas/:documentId nobody opened is a 404',
    path: `${S}/${UNKNOWN}/canvas/doc1`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such document on this canvas', code: 'CANVAS_DOCUMENT_NOT_FOUND' },
    },
  },
  {
    name: 'PATCH /api/sessions/:id/canvas/:documentId nobody opened is a 404',
    method: 'PATCH',
    path: `${S}/${UNKNOWN}/canvas/doc1`,
    body: {},
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such document on this canvas', code: 'CANVAS_DOCUMENT_NOT_FOUND' },
    },
  },
  {
    name: 'DELETE /api/sessions/:id/canvas/:documentId nobody opened is a 404',
    method: 'DELETE',
    path: `${S}/${UNKNOWN}/canvas/doc1`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such document on this canvas', code: 'CANVAS_DOCUMENT_NOT_FOUND' },
    },
  },
  {
    name: 'POST /api/sessions/:id/canvas/:documentId/editing nobody opened is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/canvas/doc1/editing`,
    body: { editing: true },
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such document on this canvas', code: 'CANVAS_DOCUMENT_NOT_FOUND' },
    },
  },
  {
    name: 'GET /api/sessions/:id/canvas with a bad id is a 400',
    path: `${S}/nope/canvas`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },

  // ---- continuing on another account -----------------------------------------
  {
    name: 'GET /api/sessions/:id/continue-options on a session that never ran out is a 409',
    path: `${S}/${UNKNOWN}/continue-options`,
    expect: {
      status: 409,
      headers: JSON_TYPE,
      body: {
        error: 'This chat has not run out of usage, so there is nothing to continue.',
        code: 'NO_LIMIT',
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/continue with a body it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/continue`,
    body: { account: 5 },
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'POST /api/sessions/:id/continue naming nothing to continue on is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/continue`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Choose an account or a model to continue on.', code: 'VALIDATION_ERROR' },
    },
  },
  {
    name: 'POST /api/sessions/:id/continue/cancel on a session that never ran out is a 409',
    method: 'POST',
    path: `${S}/${UNKNOWN}/continue/cancel`,
    expect: {
      status: 409,
      headers: JSON_TYPE,
      body: {
        error: 'This chat has not run out of usage, so there is nothing to continue.',
        code: 'NO_LIMIT',
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/wait on a session that never ran out is a 409',
    method: 'POST',
    path: `${S}/${UNKNOWN}/wait`,
    body: {},
    expect: {
      status: 409,
      headers: JSON_TYPE,
      body: {
        error: 'This chat has not run out of usage, so there is nothing to continue.',
        code: 'NO_LIMIT',
      },
    },
  },
  {
    name: 'GET /api/sessions/:id/continue-options with a bad id is a 400',
    path: `${S}/nope/continue-options`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },

  // ---- the DevTools sinks and the recording upload ---------------------------
  {
    name: 'POST /api/sessions/:id/devtools/ingest with a batch it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/ingest`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Invalid DevTools ingest batch', code: 'VALIDATION_ERROR' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/action with a result it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/action`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Invalid DevTools action result', code: 'VALIDATION_ERROR' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording that is not multipart is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    body: {},
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Invalid recording upload', code: 'VALIDATION_ERROR' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording nobody is waiting for is a 404',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: multipart(
      part('requestId', 'r1'),
      part('recording', 'GIF89a', 'a.gif'),
      part('frames', '3'),
      part('durationMs', '100')
    ),
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No recording is waiting for that upload', code: 'RECORDING_NOT_PENDING' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording with a file in another field is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: multipart(part('other', 'x', 'a.gif')),
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Unexpected file field', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording with two recordings is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: multipart(part('recording', 'x', 'a.gif'), part('recording', 'y', 'b.gif')),
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Unexpected file field', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording with too many fields is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: multipart(...Array.from({ length: 8 }, (_, i) => part(`f${i}`, 'x'))),
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Too many fields', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording with a field over its size is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: multipart(part('requestId', 'x'.repeat(3000))),
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Field value too long', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording cut off mid-form is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: MULTIPART,
    body: `--${BOUNDARY}\r\nbroken`,
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Unexpected end of form', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },
  {
    name: 'POST /api/sessions/:id/devtools/recording with no boundary is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/devtools/recording`,
    headers: { 'content-type': 'multipart/form-data' },
    body: 'abc',
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Multipart: Boundary not found', code: 'RECORDING_UPLOAD_INVALID' },
    },
  },

  // ---- MCP App resources -----------------------------------------------------
  {
    name: 'POST /api/sessions/:id/mcp-app/resource with a body it cannot read is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/mcp-app/resource`,
    body: {},
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_REQUEST },
  },
  {
    name: 'POST /api/sessions/:id/mcp-app/resource outside the ui:// scheme is a 400',
    method: 'POST',
    path: `${S}/${UNKNOWN}/mcp-app/resource`,
    body: { serverName: 's', uri: 'http://x' },
    expect: {
      status: 400,
      headers: JSON_TYPE,
      body: { error: 'Resource URI must use the ui:// scheme', code: 'INVALID_URI' },
    },
  },
  {
    name: 'POST /api/sessions/:id/mcp-app/resource on a session not running is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/mcp-app/resource`,
    body: { serverName: 's', uri: 'ui://x' },
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },

  // ---- stopping --------------------------------------------------------------
  {
    name: 'POST /api/sessions/:id/tasks/:taskId/stop of a session nobody started is a 404',
    method: 'POST',
    path: `${S}/${fresh()}/tasks/t1/stop`,
    expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
  },
  {
    name: 'POST /api/sessions/:id/process/switch with no agent running switches nothing',
    method: 'POST',
    path: `${S}/${UNKNOWN}/process/switch`,
    expect: { status: 200, headers: JSON_TYPE, body: { switched: false } },
  },
  {
    name: 'POST /api/sessions/:id/interrupt with no turn running says so',
    method: 'POST',
    path: `${S}/${UNKNOWN}/interrupt`,
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: {
        receipt: { outcome: 'not-running', reason: 'no-open-turn', runtime: 'test-mode' },
        cancelledQueued: [],
      },
    },
  },
  {
    name: 'POST /api/sessions/:id/interrupt with a bad id is a 400',
    method: 'POST',
    path: `${S}/nope/interrupt`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },

  // ---- the stream's refusals -------------------------------------------------
  {
    name: 'GET /api/sessions/:id/events with a bad id is a 400',
    path: `${S}/nope/events`,
    expect: { status: 400, headers: JSON_TYPE, body: INVALID_SESSION_ID },
  },
  {
    name: 'GET /api/sessions/:id/events in a folder outside the boundary is a 403',
    path: `${S}/${UNKNOWN}/events?cwd=${encodeURIComponent('/etc')}`,
    expect: { status: 403, headers: JSON_TYPE, body: OUTSIDE_BOUNDARY },
  },

  // ---- the chain -------------------------------------------------------------
  {
    name: 'GET /api/sessions at a foreign host is refused by the host guard',
    path: S,
    headers: { host: 'evil.example' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'POST /api/sessions/:id/messages at a foreign host is refused by the host guard',
    method: 'POST',
    path: `${S}/${UNKNOWN}/messages`,
    headers: { host: 'evil.example' },
    body: { content: 'hi' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET /api/sessions from a wrong browser origin is refused by CORS',
    path: S,
    headers: { origin: 'https://evil.example' },
    expect: { status: 403, schema: CORS_REFUSED },
  },
  {
    name: 'GET /api/sessions from the server’s own origin carries the CORS answer',
    path: S,
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 200,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
        'x-content-type-options': 'nosniff',
      },
      body: { sessions: [] },
    },
  },
]);

/** An open stream, read as it arrives. */
interface OpenStream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Everything the server has sent so far. */
  text(): string;
  /** Resolves once the text so far satisfies `until`; fails after `timeoutMs`. */
  waitFor(until: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Leave, as a client closing its tab does. */
  close(): void;
}

/**
 * Open a stream and hand it back once the head arrived. Unlike a plain request
 * it never waits for the end, which a healthy stream never sends.
 */
function openStream(
  server: ComposedServer | undefined,
  url: string,
  headers: Record<string, string> = {}
): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(url, server!.baseUrl), { headers, agent: false }, (res) => {
      let text = '';
      let ended = false;
      const waiters = new Set<() => void>();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (const wake of waiters) wake();
      });
      res.on('end', () => {
        ended = true;
        for (const wake of waiters) wake();
      });
      res.on('error', () => undefined);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        close: () => req.destroy(),
        waitFor: (until, timeoutMs = 10_000) =>
          new Promise((done, fail) => {
            const check = (): void => {
              if (until(text)) {
                waiters.delete(check);
                clearTimeout(timer);
                done(text);
              } else if (ended) {
                waiters.delete(check);
                clearTimeout(timer);
                fail(new Error(`The stream ended before it was satisfied:\n${text}`));
              }
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`Not satisfied in ${timeoutMs} ms; the stream sent:\n${text}`));
            }, timeoutMs);
            waiters.add(check);
            check();
          }),
      });
    });
    req.on('error', (error) => {
      if (!req.destroyed) reject(error);
    });
  });
}

/** One SSE frame as it went over the wire. */
interface Frame {
  id: string | undefined;
  event: string;
  data: Record<string, unknown>;
}

/** The complete frames in some stream text, comments skipped. */
function framesOf(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split('\n\n').slice(0, -1)) {
    const lines = block.split('\n').filter((line) => !line.startsWith(':'));
    if (lines.length === 0) continue;
    const field = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
    frames.push({
      id: field('id'),
      event: field('event') ?? '',
      data: JSON.parse(field('data') ?? 'null') as Record<string, unknown>,
    });
  }
  return frames;
}

/** The seq an `id:` line ends with. */
function seqOf(id: string | undefined): number {
  const match = /-(\d+)$/.exec(id ?? '');
  if (!match) throw new Error(`not a frame id: ${id}`);
  return Number(match[1]);
}

/** Every live frame's seq, checked to be one more than the last, from `first`. */
function expectGapFree(frames: Frame[], first: number): void {
  expect(frames.length).toBeGreaterThan(0);
  frames.forEach((frame, index) => {
    expect(frame.id, `frame ${index} (${frame.event}) has an id`).toMatch(
      /^[0-9a-f-]{36}-\d+-g\d+-\d+$/
    );
    expect(seqOf(frame.id), `frame ${index} (${frame.event})`).toBe(first + index);
    expect(frame.data.seq).toBe(first + index);
  });
}

/** One answer from the server. */
interface Answer {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

/** Send one request to the server. */
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

/** Poll a session until its lifecycle is `lifecycle`. */
async function until(
  server: ComposedServer | undefined,
  sessionId: string,
  lifecycle: string,
  headers: Record<string, string> = {}
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { json } = await call(
      server,
      'GET',
      `${S}/${sessionId}?cwd=${encodeURIComponent(WORK)}`,
      undefined,
      headers
    );
    const status = json.status as { lifecycle?: string } | undefined;
    if (status?.lifecycle === lifecycle) return;
    if (Date.now() > deadline)
      throw new Error(`${sessionId} never became ${lifecycle}: ${JSON.stringify(json)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Start a chat under a new id, on a scenario, and return its id. */
async function startChat(
  server: ComposedServer | undefined,
  options: { scenario?: string; headers?: Record<string, string>; content?: string } = {}
): Promise<string> {
  const sessionId = randomUUID();
  if (options.scenario) {
    await setup(server, 'POST', '/api/test/scenario', { name: options.scenario, sessionId });
  }
  const answer = await setup(
    server,
    'POST',
    `${S}/${sessionId}/messages`,
    { content: options.content ?? 'hello', create: true, cwd: WORK },
    options.headers
  );
  expect(answer.status).toBe(202);
  return sessionId;
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

describe('contract: the session routes, driven by hand (login off)', { timeout: 60_000 }, () => {
  let server: ComposedServer | undefined;
  const open: OpenStream[] = [];

  beforeAll(async () => {
    server = await bootComposedServer();
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    for (const stream of open) stream.close();
    await server?.close();
  }, 30_000);

  /** Open a stream this suite closes when it ends. */
  async function held(url: string, headers?: Record<string, string>): Promise<OpenStream> {
    const stream = await openStream(server, url, headers);
    open.push(stream);
    return stream;
  }

  it('starts a chat with a 202, then lists, reads and renames it, tagged with its runtime', async () => {
    const sessionId = randomUUID();
    const started = await call(server, 'POST', `${S}/${sessionId}/messages`, {
      content: 'hello',
      create: true,
      cwd: WORK,
    });
    expect(started.status).toBe(202);
    expect(started.headers.get('content-type')).toMatch(/^application\/json\b/);
    const accepted = ACCEPTED.parse(started.json);
    expect(accepted.sessionId).toBe(sessionId);
    expect(accepted.outcome.messageId).toBe(accepted.messageId);
    await until(server, sessionId, 'idle');

    const list = await call(server, 'GET', `${S}?cwd=${encodeURIComponent(WORK)}`);
    expect(list.status).toBe(200);
    const listed = z
      .object({ sessions: z.array(SESSION) })
      .strict()
      .parse(list.json);
    expect(listed.sessions.map((s) => s.id)).toContain(sessionId);
    const filtered = await call(
      server,
      'GET',
      `${S}?cwd=${encodeURIComponent(WORK)}&runtime=test-mode&limit=1`
    );
    expect(filtered.status).toBe(200);
    expect((filtered.json.sessions as unknown[]).length).toBe(1);

    const one = await call(server, 'GET', `${S}/${sessionId}`);
    expect(one.status).toBe(200);
    expect(SESSION.parse(one.json)).toMatchObject({ id: sessionId, title: 'Hello', cwd: WORK });
    expect(one.json.status).toEqual({ lifecycle: 'idle', limit: null });

    const messages = await call(server, 'GET', `${S}/${sessionId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.json).toEqual({
      messages: [
        { id: 'user-3', role: 'user', content: 'hello', timestamp: expect.any(String) },
        {
          id: 'assistant-3',
          role: 'assistant',
          content: 'Echo: hello',
          timestamp: expect.any(String),
        },
      ],
    });

    const renamed = await call(
      server,
      'PATCH',
      `${S}/${sessionId}?cwd=${encodeURIComponent(WORK)}`,
      {
        title: 'Renamed',
      }
    );
    expect(renamed.status).toBe(200);
    expect(SESSION.parse(renamed.json)).toMatchObject({ id: sessionId, title: 'Renamed' });
    expect(renamed.json.runtimeUnbound).toBeUndefined();
    expect((await call(server, 'GET', `${S}/${sessionId}`)).json.title).toBe('Renamed');

    expect(await call(server, 'GET', `${S}/${sessionId}/runtime-type`)).toMatchObject({
      status: 200,
      json: { runtime: 'test-mode' },
    });
    expect(await call(server, 'GET', `${S}/${sessionId}/settings`)).toMatchObject({
      status: 200,
      json: { settings: {} },
    });
    expect(await call(server, 'GET', `${S}/${sessionId}/tasks`)).toMatchObject({
      status: 200,
      json: { tasks: [] },
    });
    expect(await call(server, 'GET', `${S}/${sessionId}/chat-messages`)).toMatchObject({
      status: 200,
      json: { sent: [], stops: [] },
    });
  });

  it('says a rename is a guess on a session no turn ever bound', async () => {
    const sessionId = randomUUID();
    const renamed = await call(
      server,
      'PATCH',
      `${S}/${sessionId}?cwd=${encodeURIComponent(WORK)}`,
      {
        title: 'Draft',
      }
    );
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({
      id: sessionId,
      title: 'Draft',
      runtime: 'test-mode',
      runtimeUnbound: true,
    });
  });

  it('keeps a person’s chat from an agent, and lets an agent read its own', async () => {
    const person = await startChat(server);
    await until(server, person, 'idle');
    const agents = await startChat(server, { headers: AGENT, content: 'agent work' });
    await until(server, agents, 'idle', AGENT);

    for (const url of [
      `${S}/${person}`,
      `${S}/${person}/messages`,
      `${S}/${person}/tasks`,
      `${S}/${person}/queue`,
      `${S}/${person}/canvas`,
      `${S}/${person}/continue-options`,
      `${S}/${person}/limit-history`,
    ]) {
      const answer = await call(server, 'GET', url, undefined, AGENT);
      expect(answer.status, url).toBe(404);
      expect(answer.json, url).toEqual(SESSION_NOT_FOUND);
    }
    for (const route of ['approve', 'process/switch', 'interrupt', 'opened']) {
      const answer = await call(
        server,
        'POST',
        `${S}/${person}/${route}`,
        { toolCallId: 't' },
        AGENT
      );
      expect(answer.status, route).toBe(404);
      expect(answer.json, route).toEqual(SESSION_NOT_FOUND);
    }
    // A message to a person's chat is refused like a read; starting a new one is not.
    const intoPerson = await call(
      server,
      'POST',
      `${S}/${person}/messages`,
      { content: 'hi' },
      AGENT
    );
    expect(intoPerson).toMatchObject({ status: 404, json: SESSION_NOT_FOUND });
    // A path no route has is the /api 404, for the agent as for anyone.
    expect(await call(server, 'GET', `${S}/${person}/nonexistent`, undefined, AGENT)).toMatchObject(
      {
        status: 404,
        json: NOT_FOUND,
      }
    );

    const listed = await call(
      server,
      'GET',
      `${S}?cwd=${encodeURIComponent(WORK)}`,
      undefined,
      AGENT
    );
    const ids = (listed.json.sessions as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(agents);
    expect(ids).not.toContain(person);
    const ownersList = await call(server, 'GET', `${S}?cwd=${encodeURIComponent(WORK)}`);
    expect((ownersList.json.sessions as { id: string }[]).map((s) => s.id)).toEqual(
      expect.arrayContaining([person, agents])
    );

    const own = await call(server, 'GET', `${S}/${agents}`, undefined, AGENT);
    expect(own.status).toBe(200);
    expect(own.json.id).toBe(agents);

    // The agent may read its own chat, but what only a person may do stays refused.
    expect(
      await call(server, 'POST', `${S}/${agents}/process/switch`, undefined, AGENT)
    ).toMatchObject({
      status: 403,
      json: { error: 'Only you can switch now, from the DorkOS app.', code: 'person_only' },
    });
    expect(
      await call(
        server,
        'POST',
        `${S}/${agents}/messages`,
        { content: 'x', account: 'dorkos-credits' },
        AGENT
      )
    ).toMatchObject({
      status: 403,
      json: {
        error: 'Only you can run a chat on your DorkOS credits, from the DorkOS app.',
        code: 'person_only',
      },
    });
    for (const url of [`${S}/${agents}/canvas`, `${S}/${agents}/continue-options`]) {
      const answer = await call(server, 'GET', url, undefined, AGENT);
      expect(answer.status, url).toBe(401);
      expect(answer.json, url).toEqual(AGENT_UNVERIFIED);
    }
  });

  it('answers a prompt for a person, never for an agent', async () => {
    const asked = await startChat(server, { scenario: 'approval-gated' });
    await until(server, asked, 'blocked');

    const pending = await call(server, 'GET', `${S}/pending-interactions`);
    expect(pending.status).toBe(200);
    const row = (pending.json.interactions as Record<string, unknown>[]).find(
      (entry) => entry.sessionId === asked
    );
    expect(row).toMatchObject({
      sessionId: asked,
      cwd: WORK,
      interaction: { id: 'gated-edit-1', type: 'approval', toolName: 'Edit' },
    });
    expect(row).toHaveProperty('project');
    expect(await call(server, 'GET', `${S}/pending-interactions`, undefined, AGENT)).toMatchObject({
      status: 200,
      json: { interactions: [] },
    });

    expect(
      await call(server, 'POST', `${S}/${asked}/approve`, { toolCallId: 'gated-edit-1' })
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(
      await call(server, 'POST', `${S}/${asked}/approve`, { toolCallId: 'gated-edit-1' })
    ).toMatchObject({
      status: 409,
      json: { error: 'Interaction already resolved', code: 'INTERACTION_ALREADY_RESOLVED' },
    });

    // An agent's own chat asks too, and the agent still cannot answer it.
    const agents = await startChat(server, { scenario: 'approval-gated', headers: AGENT });
    await until(server, agents, 'blocked', AGENT);
    const refused = {
      error: 'Approvals are decided by a person in DorkOS, not by an agent',
      code: 'AGENT_CANNOT_DECIDE',
    };
    for (const [route, body] of [
      ['approve', { toolCallId: 'gated-edit-1' }],
      ['deny', { toolCallId: 'gated-edit-1' }],
      ['batch-approve', { toolCallIds: ['gated-edit-1'] }],
      ['batch-deny', { toolCallIds: ['gated-edit-1'] }],
      ['submit-answers', { toolCallId: 'gated-edit-1', answers: {} }],
      ['submit-elicitation', { interactionId: 'gated-edit-1', action: 'decline' }],
    ] as const) {
      expect(
        await call(server, 'POST', `${S}/${agents}/${route}`, body, AGENT),
        route
      ).toMatchObject({
        status: 403,
        json: refused,
      });
    }
    expect(
      await call(server, 'POST', `${S}/${agents}/deny`, {
        toolCallId: 'gated-edit-1',
        reason: 'not now',
      })
    ).toMatchObject({ status: 200, json: { ok: true } });
  });

  it('holds a busy session for the window whose turn it is, and queues the rest', async () => {
    const busy = randomUUID();
    await setup(server, 'POST', '/api/test/scenario', { name: 'long-turn', sessionId: busy });
    const first = await call(
      server,
      'POST',
      `${S}/${busy}/messages`,
      { content: 'work', create: true, cwd: WORK },
      { 'X-Client-Id': 'window-one' }
    );
    expect(first.status).toBe(202);
    await until(server, busy, 'streaming');

    // A widget action is answered by the turn it was clicked in: refused while
    // another window's turn runs, naming that window.
    const locked = await call(
      server,
      'POST',
      `${S}/${busy}/ui-action`,
      { actionId: 'a', widgetId: 'w', toolCallId: 't' },
      { 'X-Client-Id': 'window-two' }
    );
    expect(locked.status).toBe(409);
    expect(locked.json).toEqual({
      error: 'Session locked',
      code: 'SESSION_LOCKED',
      lockedBy: 'window-one',
      lockedAt: expect.stringMatching(ISO),
    });

    // A message is never refused: it waits its turn.
    const queued = await call(
      server,
      'POST',
      `${S}/${busy}/messages`,
      { content: 'next' },
      { 'X-Client-Id': 'window-two' }
    );
    expect(queued.status).toBe(202);
    const waiting = ACCEPTED.parse(queued.json);
    expect(waiting).toMatchObject({ sessionId: busy, queuePosition: 1 });

    const queue = await call(server, 'GET', `${S}/${busy}/queue`);
    expect(queue.json).toEqual({
      queue: [
        {
          id: waiting.messageId,
          content: 'next',
          disposition: 'queue',
          enqueuedAt: expect.any(Number),
          enqueuedBy: 'window-two',
        },
      ],
    });
    const edited = await call(server, 'PATCH', `${S}/${busy}/queue/${waiting.messageId}`, {
      content: 'next, edited',
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({
      message: { id: waiting.messageId, content: 'next, edited' },
      queue: [{ id: waiting.messageId, content: 'next, edited' }],
    });

    const another = ACCEPTED.parse(
      (await call(server, 'POST', `${S}/${busy}/messages`, { content: 'third' })).json
    );
    expect(another.queuePosition).toBe(2);
    const removed = await call(server, 'DELETE', `${S}/${busy}/queue/${another.messageId}`);
    expect(removed.status).toBe(200);
    expect((removed.json.queue as { id: string }[]).map((m) => m.id)).toEqual([waiting.messageId]);

    // Stop ends the turn and hands back what was waiting.
    const stopped = await call(server, 'POST', `${S}/${busy}/interrupt`);
    expect(stopped.status).toBe(200);
    expect(stopped.json).toEqual({
      receipt: { outcome: 'closed', runtime: 'test-mode' },
      cancelledQueued: [
        expect.objectContaining({
          id: waiting.messageId,
          content: 'next, edited',
          enqueuedBy: 'window-two',
        }),
      ],
    });
    expect((await call(server, 'GET', `${S}/${busy}/queue`)).json).toEqual({ queue: [] });
  });

  it('streams a session: the head, the snapshot first, then live frames with gap-free ids', async () => {
    const sessionId = await startChat(server);
    await until(server, sessionId, 'idle');

    const stream = await held(`${S}/${sessionId}/events`);
    expect(stream.status).toBe(200);
    for (const [name, want] of Object.entries(STREAM_HEADERS)) {
      expect(stream.headers[name], `header ${name}`).toBe(want);
    }
    expect(stream.headers['content-length']).toBeUndefined();
    expect(stream.headers['access-control-allow-origin']).toBeUndefined();

    // A cold connect leads with the snapshot frame, which carries no id.
    const first = await stream.waitFor((text) => framesOf(text).length >= 1);
    expect(first).toMatch(/^event: snapshot\ndata: \{"messages":/);
    const [snapshot] = framesOf(first);
    expect(snapshot!.id).toBeUndefined();
    expect(Object.keys(snapshot!.data)).toEqual([
      'messages',
      'inProgressTurn',
      'status',
      'pendingInteractions',
      'queuedMessages',
      'canvas',
      'cursor',
    ]);
    const cursor = snapshot!.data.cursor as number;
    expect(snapshot!.data.messages).toEqual([
      { id: 'user-3', role: 'user', content: 'hello', timestamp: expect.any(String) },
      { id: 'assistant-3', role: 'assistant', content: 'Echo: hello' },
    ]);

    // A live turn arrives as frames, each with its id and the next seq.
    await setup(server, 'POST', `${S}/${sessionId}/messages`, { content: 'second' });
    const live = await stream.waitFor((text) => text.includes('event: turn_end'));
    const liveFrames = framesOf(live).slice(1);
    expectGapFree(liveFrames, cursor + 1);
    expect(liveFrames.map((frame) => frame.event)).toEqual([
      'queue_update',
      'turn_start',
      'queue_update',
      'status_change',
      'text_delta',
      'turn_end',
    ]);
    expect(live).toContain(
      `\nevent: text_delta\ndata: {"type":"text_delta","text":"Echo: second","seq":${cursor + 5}}\n\n`
    );
    const lastId = liveFrames.at(-1)!.id!;
    stream.close();

    // A third turn while nobody is reading, then a resume from the last id seen:
    // no snapshot, and exactly the frames after it, in order.
    await setup(server, 'POST', `${S}/${sessionId}/messages`, { content: 'third' });
    await until(server, sessionId, 'idle');
    const resumed = await held(`${S}/${sessionId}/events`, { 'last-event-id': lastId });
    expect(resumed.status).toBe(200);
    expect(resumed.headers['content-type']).toBe('text/event-stream');
    const replay = await resumed.waitFor((text) => text.includes('event: turn_end'));
    expect(replay).toMatch(/^id: /);
    const replayed = framesOf(replay);
    expect(replayed.map((frame) => frame.event)).not.toContain('snapshot');
    expectGapFree(replayed, seqOf(lastId) + 1);
    expect(replay).toContain('"text":"Echo: third"');
    resumed.close();

    // `?after=` is the same resume for a client that cannot set the header.
    const after = await held(`${S}/${sessionId}/events?after=${cursor}`);
    const fromAfter = framesOf(
      await after.waitFor((text) => text.split('event: turn_end').length > 2)
    );
    expectGapFree(fromAfter.slice(0, 12), cursor + 1);
    after.close();

    // An id from a seq space this stream never served is a cold connect.
    const foreign = await held(`${S}/${sessionId}/events`, {
      'last-event-id': `${sessionId}-1-g99-3`,
    });
    expect(await foreign.waitFor((text) => framesOf(text).length >= 1)).toMatch(
      /^event: snapshot\n/
    );
    foreign.close();
  });

  it('streams a session nobody started yet, so a window can subscribe before it sends', async () => {
    const stream = await held(`${S}/${randomUUID()}/events?cwd=${encodeURIComponent(WORK)}`);
    expect(stream.status).toBe(200);
    const text = await stream.waitFor((sent) => framesOf(sent).length >= 1);
    const [snapshot] = framesOf(text);
    expect(snapshot).toMatchObject({
      event: 'snapshot',
      data: { messages: [], inProgressTurn: null, pendingInteractions: [], queuedMessages: [] },
    });
    stream.close();
  });

  it('answers a credentialed browser on its own origin with the CORS headers', async () => {
    const sessionId = await startChat(server);
    const stream = await held(`${S}/${sessionId}/events`, {
      origin: server!.baseUrl,
      accept: 'text/event-stream',
    });
    expect(stream.headers['access-control-allow-origin']).toBe(server!.baseUrl);
    expect(stream.headers['access-control-allow-credentials']).toBe('true');
    expect(stream.headers['content-type']).toBe('text/event-stream');
    stream.close();
  });

  it('keeps a person’s stream from an agent, and ends an unverified agent’s own at the head', async () => {
    const person = await startChat(server);
    await checkContractCase(server!.baseUrl, {
      name: 'an agent asking for a person’s stream',
      path: `${S}/${person}/events`,
      headers: AGENT,
      expect: { status: 404, headers: JSON_TYPE, body: SESSION_NOT_FOUND },
    });

    // Its own chat is readable, so the stream opens; the document channel then
    // refuses an identity this machine cannot verify, and the stream ends
    // after its head with no frame.
    const agents = await startChat(server, { headers: AGENT });
    const stream = await held(`${S}/${agents}/events`, AGENT);
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    await expect(stream.waitFor(() => false)).rejects.toThrow(/ended before/);
    expect(stream.text()).toBe('');
  });

  it(
    'keeps an idle stream open with a comment line',
    async () => {
      const sessionId = await startChat(server);
      await until(server, sessionId, 'idle');
      const stream = await held(`${S}/${sessionId}/events`);
      const text = await stream.waitFor((sent) => sent.includes(': keepalive'), HEARTBEAT_WAIT_MS);
      expect(text).toContain('\n\n: keepalive\n\n');
      stream.close();
    },
    HEARTBEAT_WAIT_MS + 5_000
  );
});

describe('contract: the session routes with login on', { timeout: 60_000 }, () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let sessionId: string;

  beforeAll(async () => {
    server = await bootComposedServer();
    sessionId = await startChat(server);
    await until(server, sessionId, 'idle');
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

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url, body] of [
      ['GET', S],
      ['GET', `${S}/recent`],
      ['GET', `${S}/pending-interactions`],
      ['GET', `${S}/${sessionId}`],
      ['GET', `${S}/${sessionId}/messages`],
      ['GET', `${S}/${sessionId}/events`],
      ['GET', `${S}/${sessionId}/nonexistent`],
      ['PATCH', `${S}/${sessionId}`, { title: 'x' }],
      ['POST', `${S}/${sessionId}/messages`, { content: 'hi' }],
      ['POST', `${S}/${sessionId}/approve`, { toolCallId: 't' }],
      ['POST', `${S}/${sessionId}/interrupt`],
      ['POST', `${S}/${sessionId}/devtools/recording`],
    ] as const) {
      await checkContractCase(server!.baseUrl, {
        name: `${method} ${url}`,
        method,
        path: url,
        ...(body ? { body } : {}),
        expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
      });
    }
    await checkContractCase(server!.baseUrl, {
      name: 'an unverified agent',
      path: S,
      headers: AGENT,
      expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
    });
  });

  it('reads and streams for the owner’s cookie', async () => {
    const list = await call(
      server,
      'GET',
      `${S}?cwd=${encodeURIComponent(WORK)}`,
      undefined,
      cookie
    );
    expect(list.status).toBe(200);
    expect((list.json.sessions as { id: string }[]).map((s) => s.id)).toContain(sessionId);

    const stream = await openStream(server, `${S}/${sessionId}/events`, cookie);
    expect(stream.status).toBe(200);
    for (const [name, want] of Object.entries(STREAM_HEADERS)) {
      expect(stream.headers[name], `header ${name}`).toBe(want);
    }
    expect(await stream.waitFor((text) => framesOf(text).length >= 1)).toMatch(
      /^event: snapshot\n/
    );
    stream.close();

    // Answering is the person's, by cookie; there is nothing pending here.
    expect(
      await call(server, 'POST', `${S}/${sessionId}/approve`, { toolCallId: 't' }, cookie)
    ).toMatchObject({ status: 409, json: { code: 'INTERACTION_ALREADY_RESOLVED' } });
  });
});
