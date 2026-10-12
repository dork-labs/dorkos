/**
 * Contract for this machine's own rooms, `/api/rooms`, which move to Hono in
 * DOR-2814: the room routes, the thread, reaction, member and halt routes, the
 * attachments (a multipart upload and the file served back), a room's own files
 * (including their multipart upload), the shared canvas and following, and the
 * durable room stream over Server-Sent Events. That PR must pass this file
 * unchanged.
 *
 * Rooms are multi-agent, so most of what is pinned here is WHO may do a thing:
 * the person at the keyboard (login off, the install's owner), a registered
 * agent that is a member, a registered agent that is not, and an agent header
 * this machine never minted. A room a caller is not in answers exactly as a
 * room that does not exist; a person-only route refuses an agent 403; an
 * unverifiable agent is refused 401 before anything is looked up.
 *
 * The stream is pinned as bytes: the head, the `: connected` comment, the
 * `snapshot` frame on a cold connect, a live `entry` frame carrying its id,
 * and a `Last-Event-ID` resume that replays only what came after.
 *
 * Three servers:
 *
 * 1. Login off, nothing set up: the refusals that need no room.
 * 2. Login off, driven by hand: every route, in order, each relying on what an
 *    earlier step made.
 * 3. Login on: no credential is refused at the gate; the owner's cookie reads.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CanvasDocumentListResponseSchema,
  PostToRoomResponseSchema,
  RoomAttachmentUploadResponseSchema,
  RoomEntryListResponseSchema,
  RoomListResponseSchema,
  RoomWithRosterSchema,
  ThreadListResponseSchema,
} from '@dorkos/shared/room-schemas';
import {
  RoomFileContentResponseSchema,
  RoomFileListResponseSchema,
} from '@dorkos/shared/room-files';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  contractSuite,
  type ComposedServer,
} from './harness.js';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const UNVERIFIED = {
  error:
    'That agent identity could not be verified. Its token may have been revoked, or it may have expired.',
  code: 'AGENT_IDENTITY_UNVERIFIED',
};
const NO_SUCH_ROOM = z.object({ code: z.literal('ROOM_NOT_FOUND') }).loose();
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed'), details: z.unknown() });
const HOST_REFUSED = z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose();
const CORS_REFUSED = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
/** A ULID nobody minted: a well-formed room id for a room that does not exist. */
const NO_ROOM = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
/** The headers the durable room stream answers with. */
const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
  'transfer-encoding': 'chunked',
} as const;

/** The boundary every multipart body below is cut on. */
const BOUNDARY = '----dorkos-room-contract';
const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
/** The smallest bytes the attachment sniffer reads as a GIF: all ASCII. */
const GIF = 'GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;';

/** One part of a multipart body. */
interface Part {
  field: string;
  filename?: string;
  type?: string;
  content: string;
}

/** A `multipart/form-data` body, as a browser's `FormData` writes it. */
function multipart(parts: readonly Part[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${BOUNDARY}`);
    const file = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    lines.push(`Content-Disposition: form-data; name="${part.field}"${file}`);
    if (part.type) lines.push(`Content-Type: ${part.type}`);
    lines.push('', part.content);
  }
  lines.push(`--${BOUNDARY}--`, '');
  return lines.join('\r\n');
}

/** One answer from the server. */
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

/**
 * Send one request with `node:http` (so `Host` survives). A string body is
 * sent as it is, anything else as JSON.
 */
function call(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const sendHeaders: Record<string, string> = { ...headers };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') sendHeaders['content-type'] ??= 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(url, server!.baseUrl),
      { method, headers: sendHeaders, agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as typeof json;
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Check an answer's status, then its body against a schema or an exact value. */
function expectAnswer(
  answer: Answer,
  status: number,
  body?: z.ZodType | Record<string, unknown>
): void {
  expect(answer.status, `answered ${answer.status}: ${answer.text.slice(0, 400)}`).toBe(status);
  if (body instanceof z.ZodType) body.parse(answer.json);
  else if (body !== undefined) expect(answer.json).toEqual(body);
}

/** A refusal: its status and its code, and the JSON type. */
function expectRefusal(answer: Answer, status: number, code: string): void {
  expectAnswer(answer, status);
  expect(answer.headers['content-type']).toMatch(/^application\/json\b/);
  expect(answer.json.code, answer.text).toBe(code);
  expect(typeof answer.json.error).toBe('string');
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
    throw new Error(`${method} ${url} answered ${answer.status}: ${answer.text.slice(0, 300)}`);
  }
  return answer;
}

/** An agent registered on a hand-driven server, and a token that names it. */
interface SeededAgent {
  agentDir: string;
  header: Record<string, string>;
}

/** Register a fresh test agent and mint its token. */
async function seedAgent(server: ComposedServer | undefined): Promise<SeededAgent> {
  const seeded = await setup(server, 'POST', '/api/test/seed-agent', {
    slot: 'permission-requester',
    instance: `room-contract-${randomUUID().slice(0, 8)}`,
  });
  const agentDir = seeded.json.agentDir as string;
  const minted = await setup(server, 'POST', '/api/test/agent-token', { agentPath: agentDir });
  return { agentDir, header: { 'X-DorkOS-Agent': minted.json.token as string } };
}

/** An open stream, read as it arrives. */
interface OpenStream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  text(): string;
  waitFor(until: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  ended(): boolean;
  close(): void;
}

/** Open a stream and hand it back once the head arrived. */
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
        ended: () => ended,
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

/** Each frame's event name, in order. */
function eventNames(text: string): string[] {
  return [...text.matchAll(/^event: (.*)$/gm)].map((match) => match[1]!);
}

// ---------------------------------------------------------------------------
// 1. The refusals that need no room
// ---------------------------------------------------------------------------

contractSuite('the room routes, login off, the refusals', [
  {
    name: 'GET /api/rooms at a foreign host is refused by the host guard',
    path: '/api/rooms',
    headers: { host: 'evil.example' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET /api/rooms from a wrong browser origin is refused by CORS',
    path: '/api/rooms',
    headers: { origin: 'https://evil.example' },
    expect: { status: 500, schema: CORS_REFUSED },
  },
  {
    name: 'GET /api/rooms with an unverifiable agent is refused 401',
    path: '/api/rooms',
    headers: AGENT,
    expect: { status: 401, headers: JSON_TYPE, body: UNVERIFIED },
  },
  {
    name: 'GET /api/rooms/:id with an unverifiable agent is refused 401 before any lookup',
    path: `/api/rooms/${NO_ROOM}`,
    headers: AGENT,
    expect: { status: 401, headers: JSON_TYPE, body: UNVERIFIED },
  },
  {
    name: 'GET /api/rooms/:id/events with an unverifiable agent is refused 401',
    path: `/api/rooms/${NO_ROOM}/events`,
    headers: AGENT,
    expect: { status: 401, headers: JSON_TYPE, body: UNVERIFIED },
  },
  {
    name: 'POST /api/rooms/:id/attachments with an unverifiable agent is refused 401',
    method: 'POST',
    path: `/api/rooms/${NO_ROOM}/attachments`,
    headers: { ...AGENT, ...MULTIPART },
    body: multipart([{ field: 'files', filename: 'a.txt', type: 'text/plain', content: 'a' }]),
    expect: { status: 401, headers: JSON_TYPE, body: UNVERIFIED },
  },
  {
    name: 'GET /api/rooms/:id answers 404 for a room that does not exist',
    path: `/api/rooms/${NO_ROOM}`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such room', code: 'ROOM_NOT_FOUND' },
    },
  },
  {
    name: 'GET /api/rooms/:id/events answers 404 for a room that does not exist',
    path: `/api/rooms/${NO_ROOM}/events`,
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: 'No such room', code: 'ROOM_NOT_FOUND' },
    },
  },
  {
    name: 'GET /api/rooms/:id/export answers 404 for a room that does not exist',
    path: `/api/rooms/${NO_ROOM}/export`,
    expect: { status: 404, headers: JSON_TYPE, schema: NO_SUCH_ROOM },
  },
  {
    name: 'GET /api/rooms/:id/canvas answers 404 for a room that does not exist',
    path: `/api/rooms/${NO_ROOM}/canvas`,
    expect: { status: 404, headers: JSON_TYPE, schema: NO_SUCH_ROOM },
  },
  {
    name: 'GET /api/rooms?kind=bogus is refused 400',
    path: '/api/rooms?kind=bogus',
    expect: { status: 400, headers: JSON_TYPE, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /api/rooms/threads?limit=0 is refused 400',
    path: '/api/rooms/threads?limit=0',
    expect: { status: 400, headers: JSON_TYPE, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/rooms with no body is refused 400',
    method: 'POST',
    path: '/api/rooms',
    expect: { status: 400, headers: JSON_TYPE, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/rooms with malformed JSON is the chain’s 500',
    method: 'POST',
    path: '/api/rooms',
    headers: { 'content-type': 'application/json' },
    body: '{"kind":',
    expect: { status: 500, schema: CORS_REFUSED },
  },
  {
    name: 'POST /api/rooms over the JSON limit is refused 413',
    method: 'POST',
    path: '/api/rooms',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'channel', topic: 'x'.repeat(1024 * 1024 + 10) }),
    expect: { status: 413, schema: z.object({ code: z.literal('REQUEST_TOO_LARGE') }).loose() },
  },
  {
    name: 'DELETE /api/rooms/:id does not exist',
    method: 'DELETE',
    path: `/api/rooms/${NO_ROOM}`,
    expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
  },
  {
    name: 'GET /api/rooms/:id/nothing does not exist',
    path: `/api/rooms/${NO_ROOM}/nothing`,
    expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
  },
  {
    name: 'PUT /api/rooms/:id/read-cursor is gone',
    method: 'PUT',
    path: `/api/rooms/${NO_ROOM}/read-cursor`,
    body: { lastReadSeq: 1 },
    expect: { status: 404, headers: JSON_TYPE, body: NOT_FOUND },
  },
]);

// ---------------------------------------------------------------------------
// 2. Every route, driven by hand
// ---------------------------------------------------------------------------

describe('contract: the room routes, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  let member: SeededAgent;
  let stranger: SeededAgent;
  let roomId = '';
  let memberAuthorId = '';
  let firstEntryId = '';
  let firstSeq = 0;
  let imageAttachment = '';
  let fileAttachment = '';
  let documentId = '';
  let commit = '';
  const open: OpenStream[] = [];

  beforeAll(async () => {
    server = await bootComposedServer();
    member = await seedAgent(server);
    stranger = await seedAgent(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    for (const stream of open) stream.close();
    await server?.close();
  }, 30_000);

  const rooms = (rest = ''): string => `/api/rooms/${roomId}${rest}`;

  it('POST /api/rooms opens a channel: 201 with its roster', async () => {
    const created = await call(server, 'POST', '/api/rooms', {
      kind: 'channel',
      title: 'Contract room',
      topic: 'Pinned by the contract',
    });
    expectAnswer(created, 201, RoomWithRosterSchema);
    expect(created.headers['content-type']).toMatch(/^application\/json\b/);
    expect(created.json).not.toHaveProperty('created');
    expect(created.json.title).toBe('Contract room');
    expect(created.json.viewerIsOperator).toBe(true);
    roomId = created.json.id as string;
  });

  it('POST /api/rooms refuses a malformed slug 400', async () => {
    expectAnswer(
      await call(server, 'POST', '/api/rooms', { kind: 'channel', slug: 'Not A Slug' }),
      400,
      VALIDATION_FAILED
    );
  });

  it('POST /api/rooms lets a registered agent open a channel of its own', async () => {
    const answer = await call(
      server,
      'POST',
      '/api/rooms',
      { kind: 'channel', title: 'Agent made' },
      stranger.header
    );
    expectAnswer(answer, 201, RoomWithRosterSchema);
    expect(answer.json).toMatchObject({ slug: 'agent-made', viewerIsOperator: false });
  });

  it('GET /api/rooms lists the room with the warnings', async () => {
    const listed = await call(server, 'GET', '/api/rooms');
    expectAnswer(listed, 200, RoomListResponseSchema);
    expect(listed.json.warnings).toEqual([]);
    const ids = (listed.json.rooms as Array<{ id: string }>).map((room) => room.id);
    expect(ids).toContain(roomId);
    expectAnswer(await call(server, 'GET', '/api/rooms?kind=channel&includeArchived=true'), 200);
  });

  it('GET /api/rooms/:id answers the room to its operator', async () => {
    const room = await call(server, 'GET', rooms());
    expectAnswer(room, 200, RoomWithRosterSchema);
    expect(room.json.id).toBe(roomId);
  });

  it('POST /api/rooms/:id/members adds an agent by its directory: 201', async () => {
    const added = await call(server, 'POST', rooms('/members'), {
      agentPath: member.agentDir,
      responseMode: 'silent',
    });
    expectAnswer(added, 201);
    expect(added.json).toMatchObject({ roomId, responseMode: 'silent', author: { kind: 'agent' } });
    memberAuthorId = added.json.authorId as string;
  });

  it('POST /api/rooms/:id/members refuses a body naming nobody 400', async () => {
    expectAnswer(await call(server, 'POST', rooms('/members'), {}), 400, VALIDATION_FAILED);
  });

  it('POST /api/rooms/:id/members refuses an agent 403', async () => {
    const answer = await call(
      server,
      'POST',
      rooms('/members'),
      { agentPath: stranger.agentDir },
      member.header
    );
    expectAnswer(answer, 403, {
      error: 'Only you can change who is in a room',
      code: 'OPERATOR_ONLY',
    });
  });

  it('PATCH /api/rooms/:id/members/:authorId changes a response mode', async () => {
    expectAnswer(
      await call(server, 'PATCH', rooms(`/members/${memberAuthorId}`), {
        responseMode: 'silent',
      }),
      200
    );
    expectRefusal(
      await call(server, 'PATCH', rooms('/members/nobody-at-all'), { responseMode: 'silent' }),
      404,
      'MEMBER_NOT_FOUND'
    );
    expectAnswer(
      await call(server, 'PATCH', rooms(`/members/${memberAuthorId}`), { responseMode: 'loud' }),
      400,
      VALIDATION_FAILED
    );
  });

  it('a stranger agent sees the room as missing on every read', async () => {
    for (const rest of [
      '',
      '/entries',
      '/export',
      '/canvas',
      '/sessions',
      '/files',
      '/repo/status',
    ]) {
      const answer = await call(server, 'GET', rooms(rest), undefined, stranger.header);
      expect(answer.status, `${rest}: ${answer.text}`).toBe(404);
      expect(answer.json.code, rest).toBe('ROOM_NOT_FOUND');
    }
    const stream = await call(server, 'GET', rooms('/events'), undefined, stranger.header);
    expectAnswer(stream, 404, { error: 'No such room', code: 'ROOM_NOT_FOUND' });
  });

  it('POST /api/rooms/:id/entries posts as the person: 202 with its identity', async () => {
    const posted = await call(server, 'POST', rooms('/entries'), {
      text: 'Hello from the contract',
    });
    expectAnswer(posted, 202, PostToRoomResponseSchema);
    expect(posted.json.accepted).toBe(true);
    firstEntryId = posted.json.entryId as string;
    firstSeq = posted.json.seq as number;
  });

  it('POST /api/rooms/:id/entries posts as a member agent, and refuses a stranger', async () => {
    const posted = await call(
      server,
      'POST',
      rooms('/entries'),
      { text: 'An agent says hello' },
      member.header
    );
    expectAnswer(posted, 202, PostToRoomResponseSchema);
    expect(posted.json).toMatchObject({ accepted: true, triggered: [], skipped: [] });
    expectRefusal(
      await call(server, 'POST', rooms('/entries'), { text: 'x' }, stranger.header),
      404,
      'ROOM_NOT_FOUND'
    );
    expectRefusal(
      await call(server, 'POST', rooms('/entries'), { text: 'x' }, AGENT),
      401,
      'AGENT_IDENTITY_UNVERIFIED'
    );
  });

  it('POST /api/rooms/:id/entries refuses an empty text 400, and an unknown room 404', async () => {
    expectAnswer(
      await call(server, 'POST', rooms('/entries'), { text: '' }),
      400,
      VALIDATION_FAILED
    );
    expectAnswer(await call(server, 'POST', rooms('/entries')), 400, VALIDATION_FAILED);
    expectRefusal(
      await call(server, 'POST', `/api/rooms/${NO_ROOM}/entries`, { text: 'x' }),
      404,
      'ROOM_NOT_FOUND'
    );
  });

  it('GET /api/rooms/:id/entries pages the history', async () => {
    const page = await call(server, 'GET', rooms('/entries?limit=50'));
    expectAnswer(page, 200, RoomEntryListResponseSchema);
    const ids = (page.json.entries as Array<{ id: string }>).map((entry) => entry.id);
    expect(ids).toContain(firstEntryId);
    expectAnswer(await call(server, 'GET', rooms('/entries?limit=0')), 400, VALIDATION_FAILED);
    expectAnswer(await call(server, 'GET', rooms('/entries')), 200, RoomEntryListResponseSchema);
    expectAnswer(
      await call(server, 'GET', rooms('/entries'), undefined, member.header),
      200,
      RoomEntryListResponseSchema
    );
  });

  it('POST /api/rooms/:id/threads replies in a thread, and refuses a nested one', async () => {
    const reply = await call(server, 'POST', rooms('/threads'), {
      rootEntryId: firstEntryId,
      text: 'A reply',
    });
    expectAnswer(reply, 202, PostToRoomResponseSchema);
    expectRefusal(
      await call(server, 'POST', rooms('/threads'), {
        rootEntryId: reply.json.entryId,
        text: 'Too deep',
      }),
      400,
      'NESTED_THREAD'
    );
    expectRefusal(
      await call(server, 'POST', rooms('/threads'), { rootEntryId: 'nope', text: 'x' }),
      404,
      'ENTRY_NOT_FOUND'
    );
    expectAnswer(
      await call(server, 'POST', rooms('/threads'), { text: 'x' }),
      400,
      VALIDATION_FAILED
    );
  });

  it('GET /api/rooms/threads lists the caller’s threads', async () => {
    const threads = await call(server, 'GET', '/api/rooms/threads?limit=5');
    expectAnswer(threads, 200, ThreadListResponseSchema);
    expect((threads.json.threads as unknown[]).length).toBeGreaterThan(0);
  });

  it('POST /api/rooms/:id/entries/:entryId/reactions toggles, sets and refuses', async () => {
    const on = await call(server, 'POST', rooms(`/entries/${firstEntryId}/reactions`), {
      emoji: '👍',
    });
    expectAnswer(on, 202);
    expect(on.json).toMatchObject({
      accepted: true,
      entryId: firstEntryId,
      emoji: '👍',
      reacted: true,
    });
    expect(Array.isArray(on.json.frequents)).toBe(true);
    const off = await call(server, 'POST', rooms(`/entries/${firstEntryId}/reactions`), {
      emoji: '👍',
      on: false,
    });
    expectAnswer(off, 202);
    expect(off.json.reacted).toBe(false);
    expectAnswer(
      await call(server, 'POST', rooms(`/entries/${firstEntryId}/reactions`), { emoji: 'not one' }),
      400,
      VALIDATION_FAILED
    );
    expectRefusal(
      await call(server, 'POST', rooms('/entries/nope/reactions'), { emoji: '👍' }),
      404,
      'ENTRY_NOT_FOUND'
    );
  });

  it('an agent’s reactions stop at the hourly ceiling with 429', async () => {
    const emojis = [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '😂',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '🤩',
      '😘',
      '😗',
      '😚',
      '😙',
      '🥲',
    ];
    for (const emoji of emojis) {
      const answer = await call(
        server,
        'POST',
        rooms(`/entries/${firstEntryId}/reactions`),
        { emoji, on: true },
        member.header
      );
      expect(answer.status, `${emoji}: ${answer.text}`).toBe(202);
    }
    expectRefusal(
      await call(
        server,
        'POST',
        rooms(`/entries/${firstEntryId}/reactions`),
        { emoji: '🤔', on: true },
        member.header
      ),
      429,
      'REACTION_RATE_LIMITED'
    );
    // Taking one back is never charged.
    expectAnswer(
      await call(
        server,
        'POST',
        rooms(`/entries/${firstEntryId}/reactions`),
        { emoji: '😀', on: false },
        member.header
      ),
      202
    );
  });

  it('POST /api/rooms/:id/attachments stores files a person uploads', async () => {
    const uploaded = await call(
      server,
      'POST',
      rooms('/attachments'),
      multipart([
        { field: 'files', filename: 'dot.gif', type: 'text/plain', content: GIF },
        { field: 'files', filename: 'page.html', type: 'text/html', content: '<b>hi</b>' },
      ]),
      MULTIPART
    );
    expectAnswer(uploaded, 200, RoomAttachmentUploadResponseSchema);
    const attachments = uploaded.json.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      name: 'dot.gif',
      mimeType: 'image/gif',
      size: Buffer.byteLength(GIF),
      preview: 'image',
    });
    expect(attachments[1]).toMatchObject({
      name: 'page.html',
      mimeType: 'text/html',
      size: 9,
      preview: null,
    });
    imageAttachment = attachments[0]!.id as string;
    fileAttachment = attachments[1]!.id as string;
    expect(attachments[0]!.url).toBe(rooms(`/attachments/${imageAttachment}`));
  });

  it('POST /api/rooms/:id/attachments refuses an agent, a stranger and an empty upload', async () => {
    const body = multipart([
      { field: 'files', filename: 'a.txt', type: 'text/plain', content: 'a' },
    ]);
    expectRefusal(
      await call(server, 'POST', rooms('/attachments'), body, { ...MULTIPART, ...member.header }),
      403,
      'PEOPLE_ONLY'
    );
    expectRefusal(
      await call(server, 'POST', `/api/rooms/${NO_ROOM}/attachments`, body, MULTIPART),
      404,
      'ROOM_NOT_FOUND'
    );
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([{ field: 'note', content: 'only a field' }]),
        MULTIPART
      ),
      400,
      { error: "Attach the files as the 'files' field.", code: 'ATTACHMENT_MISSING' }
    );
    expectAnswer(await call(server, 'POST', rooms('/attachments')), 400, {
      error: "Attach the files as the 'files' field.",
      code: 'ATTACHMENT_MISSING',
    });
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([{ field: 'other', filename: 'o.txt', type: 'text/plain', content: 'o' }]),
        MULTIPART
      ),
      400,
      { error: 'Unexpected file field', code: 'LIMIT_UNEXPECTED_FILE' }
    );
  });

  it('POST /api/rooms/:id/attachments enforces the upload size, count and type settings', async () => {
    await setup(server, 'PATCH', '/api/config', {
      uploads: { maxFileSize: 1024 * 1024, maxFiles: 2, allowedTypes: ['text/plain', 'image/gif'] },
    });
    const big = 'x'.repeat(1024 * 1024 + 1);
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([{ field: 'files', filename: 'big.txt', type: 'text/plain', content: big }]),
        MULTIPART
      ),
      413,
      { error: 'File too large (max 1MB)', code: 'LIMIT_FILE_SIZE' }
    );
    const exact = await call(
      server,
      'POST',
      rooms('/attachments'),
      multipart([
        { field: 'files', filename: 'exact.txt', type: 'text/plain', content: big.slice(1) },
      ]),
      MULTIPART
    );
    expectAnswer(exact, 200, RoomAttachmentUploadResponseSchema);
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([
          { field: 'files', filename: '1.txt', type: 'text/plain', content: '1' },
          { field: 'files', filename: '2.txt', type: 'text/plain', content: '2' },
          { field: 'files', filename: '3.txt', type: 'text/plain', content: '3' },
        ]),
        MULTIPART
      ),
      400,
      { error: 'Too many files', code: 'LIMIT_FILE_COUNT' }
    );
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([{ field: 'files', filename: 'p.html', type: 'text/html', content: '<p>' }]),
        MULTIPART
      ),
      415,
      { error: 'File type not allowed: text/html', code: 'ATTACHMENT_TYPE_NOT_ALLOWED' }
    );
    expectAnswer(
      await call(server, 'POST', rooms('/attachments'), 'nothing', {
        'content-type': 'multipart/form-data',
      }),
      415,
      { error: 'Multipart: Boundary not found', code: 'ATTACHMENT_TYPE_NOT_ALLOWED' }
    );
    await setup(server, 'PATCH', '/api/config', {
      uploads: { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] },
    });
  });

  it('GET /api/rooms/:id/attachments/:id serves a verified image inline and a file as an attachment', async () => {
    const image = await call(server, 'GET', rooms(`/attachments/${imageAttachment}`));
    expectAnswer(image, 200);
    expect(image.headers).toMatchObject({
      'content-type': 'image/gif',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=0, must-revalidate',
      'content-length': String(Buffer.byteLength(GIF)),
    });
    expect(image.text).toBe(GIF);
    const etag = image.headers.etag as string;
    expect(etag).toBeTruthy();

    const cached = await call(server, 'GET', rooms(`/attachments/${imageAttachment}`), undefined, {
      'if-none-match': etag,
    });
    expectAnswer(cached, 304);
    expect(cached.text).toBe('');
    expect(cached.headers.etag).toBe(etag);

    const page = await call(server, 'GET', rooms(`/attachments/${fileAttachment}`));
    expectAnswer(page, 200);
    expect(page.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="page.html"',
      'x-content-type-options': 'nosniff',
    });
    expect(page.text).toBe('<b>hi</b>');
  });

  it('GET /api/rooms/:id/attachments/:id refuses with 404, or 400 for an unusable id', async () => {
    expectAnswer(await call(server, 'GET', rooms('/attachments/01HZZZZZZZZZZZZZZZZZZZZZZZ')), 404, {
      error: 'No such file.',
      code: 'ATTACHMENT_NOT_FOUND',
    });
    expectAnswer(
      await call(
        server,
        'GET',
        rooms(`/attachments/${imageAttachment}`),
        undefined,
        stranger.header
      ),
      404,
      { error: 'No such file.', code: 'ATTACHMENT_NOT_FOUND' }
    );
    // Not posted yet, so only its uploader reads it.
    expectAnswer(
      await call(server, 'GET', rooms(`/attachments/${imageAttachment}`), undefined, member.header),
      404,
      { error: 'No such file.', code: 'ATTACHMENT_NOT_FOUND' }
    );
  });

  it('POST /api/rooms/:id/entries posts the attachments, and a member reads them', async () => {
    const posted = await call(server, 'POST', rooms('/entries'), {
      text: 'With files',
      attachmentIds: [imageAttachment, fileAttachment],
    });
    expectAnswer(posted, 202, PostToRoomResponseSchema);
    expectAnswer(
      await call(server, 'GET', rooms(`/attachments/${imageAttachment}`), undefined, member.header),
      200
    );
    expectRefusal(
      await call(server, 'POST', rooms('/entries'), {
        text: 'Again',
        attachmentIds: [imageAttachment],
      }),
      409,
      'ATTACHMENT_ALREADY_POSTED'
    );
  });

  it('GET /api/rooms/:id/export streams the history as JSONL', async () => {
    const exported = await call(server, 'GET', rooms('/export'));
    expectAnswer(exported, 200);
    expect(exported.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename=".+\.jsonl"$/);
    expect(exported.headers['x-content-type-options']).toBe('nosniff');
    expect(exported.headers['cache-control']).toBe('no-store');
    const lines = exported.text.trimEnd().split('\n');
    expect(JSON.parse(lines[0]!).type).toBe('room-export');
    expect(JSON.parse(lines.at(-1)!).type).toBe('summary');
    expect(exported.text.endsWith('\n')).toBe(true);
  });

  it('GET /api/rooms/:id/sessions answers a person and refuses an agent', async () => {
    const sessions = await call(server, 'GET', rooms('/sessions'));
    expectAnswer(sessions, 200);
    expect(Array.isArray(sessions.json.bindings)).toBe(true);
    expectAnswer(await call(server, 'GET', rooms('/sessions'), undefined, member.header), 403, {
      error: "Only a person can see where a room's work runs.",
      code: 'PEOPLE_ONLY',
    });
  });

  it('PATCH /api/rooms/:id changes the room for its operator and refuses an agent', async () => {
    const updated = await call(server, 'PATCH', rooms(), {
      title: 'Contract room, renamed',
      topic: null,
    });
    expectAnswer(updated, 200, RoomWithRosterSchema);
    expect(updated.json.title).toBe('Contract room, renamed');
    expectRefusal(
      await call(server, 'PATCH', rooms(), { title: 'Mine now' }, member.header),
      403,
      'OPERATOR_ONLY'
    );
    expectRefusal(
      await call(server, 'PATCH', rooms(), { title: 'Mine now' }, stranger.header),
      404,
      'ROOM_NOT_FOUND'
    );
    expectRefusal(
      await call(server, 'PATCH', rooms(), { deliverNotices: true }),
      409,
      'NOT_A_BRIDGED_ROOM'
    );
    expectAnswer(await call(server, 'PATCH', rooms(), { title: '' }), 400, VALIDATION_FAILED);
  });

  it('PATCH /api/rooms/authors/:authorId/handle refuses an agent, and a person sets one', async () => {
    expectRefusal(
      await call(
        server,
        'PATCH',
        `/api/rooms/authors/${memberAuthorId}/handle`,
        { handle: 'mine' },
        member.header
      ),
      403,
      'OPERATOR_ONLY'
    );
    const handle = `contract-${randomUUID().slice(0, 6)}`;
    const set = await call(server, 'PATCH', `/api/rooms/authors/${memberAuthorId}/handle`, {
      handle,
    });
    expectAnswer(set, 200);
    expect(set.json.handle).toBe(handle);
    expectAnswer(
      await call(server, 'PATCH', `/api/rooms/authors/${memberAuthorId}/handle`, {}),
      400,
      VALIDATION_FAILED
    );
  });

  it('POST /api/rooms/:id/halt and /halt/:authorId stop work; an agent is refused', async () => {
    const halted = await call(server, 'POST', rooms('/halt'));
    expectAnswer(halted, 200);
    expect(typeof halted.json.stopped).toBe('number');
    const one = await call(server, 'POST', rooms(`/halt/${memberAuthorId}`));
    expectAnswer(one, 200);
    expect(one.json).toEqual({ stopped: 0 });
    expect(halted.json).toEqual({ stopped: 0 });
    expectAnswer(await call(server, 'POST', rooms('/halt'), undefined, member.header), 403, {
      error: 'Only people stop a room',
      code: 'PEOPLE_ONLY',
    });
    expectRefusal(await call(server, 'POST', `/api/rooms/${NO_ROOM}/halt`), 404, 'ROOM_NOT_FOUND');
  });

  it('POST /api/rooms/:id/holds/:authorId/promote answers false with nothing waiting', async () => {
    expectAnswer(await call(server, 'POST', rooms(`/holds/${memberAuthorId}/promote`)), 200, {
      promoted: false,
    });
    expectRefusal(
      await call(server, 'POST', `/api/rooms/${NO_ROOM}/holds/x/promote`),
      404,
      'ROOM_NOT_FOUND'
    );
  });

  it('PUT, POST /view and DELETE /api/rooms/:id/follow are a person’s', async () => {
    expectRefusal(
      await call(server, 'PUT', rooms('/follow'), { memberId: memberAuthorId }, member.header),
      403,
      'PEOPLE_ONLY'
    );
    const self = await call(server, 'GET', rooms());
    const viewer = self.json.viewerAuthorId as string;
    expectRefusal(
      await call(server, 'PUT', rooms('/follow'), { memberId: viewer }),
      400,
      'CANNOT_FOLLOW_YOURSELF'
    );
    expectAnswer(await call(server, 'PUT', rooms('/follow'), {}), 400, VALIDATION_FAILED);
    expectAnswer(
      await call(server, 'POST', rooms('/follow/view'), { surface: 'canvas' }),
      400,
      VALIDATION_FAILED
    );
    expectAnswer(
      await call(server, 'POST', rooms('/follow/view'), { documentId: 'doc-1', scrollY: 0 }),
      200,
      {
        followed: false,
      }
    );
    expectRefusal(
      await call(server, 'POST', rooms('/follow/view'), { documentId: 'doc-1' }, member.header),
      403,
      'PEOPLE_ONLY'
    );
    expectRefusal(
      await call(server, 'DELETE', rooms('/follow'), undefined, stranger.header),
      403,
      'PEOPLE_ONLY'
    );
    const gone = await call(server, 'DELETE', rooms('/follow'));
    expectAnswer(gone, 204);
    expect(gone.text).toBe('');
  });

  it('the canvas: open, list, read, update, view, edit, discuss and close', async () => {
    const opened = await call(server, 'POST', rooms('/canvas'), {
      content: { type: 'markdown', content: '# Notes' },
      pinned: true,
    });
    expectAnswer(opened, 201);
    expect(opened.json).toMatchObject({
      scope: `room:${roomId}`,
      roomId,
      content: { type: 'markdown', content: '# Notes' },
      contentType: 'markdown',
      pinned: true,
      rev: 1,
    });
    documentId = opened.json.id as string;

    const listed = await call(server, 'GET', rooms('/canvas'));
    expectAnswer(listed, 200, CanvasDocumentListResponseSchema);
    expectAnswer(
      await call(server, 'GET', rooms('/canvas'), undefined, member.header),
      200,
      CanvasDocumentListResponseSchema
    );

    const read = await call(server, 'GET', rooms(`/canvas/${documentId}`));
    expectAnswer(read, 200);
    expect(read.json.id).toBe(documentId);
    expectAnswer(await call(server, 'GET', rooms('/canvas/nope')), 404, {
      error: 'No such document on this room’s canvas',
      code: 'CANVAS_DOCUMENT_NOT_FOUND',
    });

    const patched = await call(server, 'PATCH', rooms(`/canvas/${documentId}`), {
      content: { type: 'markdown', content: '# Notes, changed' },
      activate: true,
    });
    expectAnswer(patched, 200);
    expect(patched.json).toMatchObject({ content: { content: '# Notes, changed' }, rev: 3 });
    expectRefusal(
      await call(server, 'PATCH', rooms('/canvas/nope'), {}),
      404,
      'CANVAS_DOCUMENT_NOT_FOUND'
    );

    const viewing = await call(server, 'POST', rooms('/canvas/viewing'), { documentId });
    expectAnswer(viewing, 204);
    expectRefusal(
      await call(server, 'POST', rooms('/canvas/viewing'), { documentId }, member.header),
      403,
      'PEOPLE_ONLY'
    );

    const editing = await call(server, 'POST', rooms(`/canvas/${documentId}/editing`), {
      editing: true,
    });
    expectAnswer(editing, 200);
    expect(editing.json).toMatchObject({
      editingBy: expect.any(String),
      expiresAt: expect.any(String),
    });
    expectAnswer(
      await call(server, 'POST', rooms(`/canvas/${documentId}/editing`), { editing: false }),
      200
    );

    const thread = await call(server, 'POST', rooms(`/canvas/${documentId}/thread`));
    expectAnswer(thread, 201);
    expect(thread.json).toMatchObject({ created: true });
    const again = await call(server, 'POST', rooms(`/canvas/${documentId}/thread`));
    expectAnswer(again, 200, { threadRootEntryId: thread.json.threadRootEntryId, created: false });

    expectRefusal(
      await call(server, 'GET', rooms(`/canvas/${documentId}/diff`), undefined, member.header),
      403,
      'PEOPLE_ONLY'
    );
    expectAnswer(await call(server, 'GET', rooms(`/canvas/${documentId}/diff`)), 400, {
      error:
        'That document is not a review of somebody’s working copy, so there is nothing to compare.',
      code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
    });
    expectAnswer(
      await call(server, 'PUT', rooms(`/canvas/${documentId}/diff`), {}),
      400,
      VALIDATION_FAILED
    );

    const closed = await call(server, 'DELETE', rooms(`/canvas/${documentId}`));
    expectAnswer(closed, 204);
    expectRefusal(
      await call(server, 'DELETE', rooms(`/canvas/${documentId}`)),
      404,
      'CANVAS_DOCUMENT_NOT_FOUND'
    );
  });

  it('GET /api/rooms/:id/files refuses a room with no files 409', async () => {
    expectRefusal(await call(server, 'GET', rooms('/files')), 409, 'ROOM_HAS_NO_REPO');
    expectRefusal(
      await call(server, 'GET', rooms('/files/content?path=ROOM.md')),
      409,
      'ROOM_HAS_NO_REPO'
    );
  });

  it('POST /api/rooms/:id/repo gives the room files once; an agent is refused', async () => {
    expectRefusal(
      await call(server, 'POST', rooms('/repo'), undefined, member.header),
      403,
      'OPERATOR_ONLY'
    );
    const enabled = await call(server, 'POST', rooms('/repo'));
    expectAnswer(enabled, 201);
    expect(enabled.json.repo).toMatchObject({ roomId, mode: 'owned', defaultBranch: 'main' });
    const again = await call(server, 'POST', rooms('/repo'));
    expectAnswer(again, 409);
    expect(again.json).toMatchObject({
      error: 'This room already has files of its own.',
      code: 'ROOM_REPO_EXISTS',
    });
    expect(again.json).toHaveProperty('repo');
  });

  it('GET /api/rooms/:id/files, /files/content and /repo/status read the room’s main', async () => {
    const listed = await call(server, 'GET', rooms('/files'));
    expectAnswer(listed, 200, RoomFileListResponseSchema);
    commit = listed.json.commit as string;
    expect(typeof commit).toBe('string');
    expectAnswer(
      await call(server, 'GET', rooms('/files'), undefined, member.header),
      200,
      RoomFileListResponseSchema
    );
    const content = await call(server, 'GET', rooms('/files/content?path=ROOM.md'));
    expectAnswer(content, 200, RoomFileContentResponseSchema);
    expectAnswer(await call(server, 'GET', rooms('/files/content')), 400, VALIDATION_FAILED);
    expectRefusal(
      await call(server, 'GET', rooms('/files/content?path=nope.md')),
      404,
      'ROOM_FILE_NOT_FOUND'
    );
    const status = await call(server, 'GET', rooms('/repo/status'));
    expectAnswer(status, 200);
    expect(status.json).toMatchObject({
      mainCommit: commit,
      main: { branch: 'main', dirty: false },
    });
  });

  it('PUT /api/rooms/:id/files/content saves as a person, and answers a stale lock 409', async () => {
    expectRefusal(
      await call(
        server,
        'PUT',
        rooms('/files/content'),
        { path: 'notes.md', baseCommit: commit, text: 'x' },
        member.header
      ),
      403,
      'PEOPLE_ONLY'
    );
    const saved = await call(server, 'PUT', rooms('/files/content'), {
      path: 'ROOM.md',
      baseCommit: commit,
      text: '# Contract room\n\nChanged.\n',
    });
    expectAnswer(saved, 200);
    expect(saved.json).toMatchObject({
      path: 'ROOM.md',
      committed: true,
      lastCommit: { subject: 'Edit ROOM.md' },
    });
    const stale = await call(server, 'PUT', rooms('/files/content'), {
      path: 'ROOM.md',
      baseCommit: commit,
      text: 'mine\n',
    });
    expectAnswer(stale, 409);
    expect(stale.json).toMatchObject({ code: 'FILE_CHANGED' });
    expect(stale.json).toHaveProperty('conflict');
    expectAnswer(await call(server, 'PUT', rooms('/files/content'), {}), 400, VALIDATION_FAILED);
    const listed = await call(server, 'GET', rooms('/files'));
    commit = listed.json.commit as string;
  });

  it('POST /api/rooms/:id/files/upload commits a multipart upload in one go', async () => {
    const uploaded = await call(
      server,
      'POST',
      rooms('/files/upload'),
      multipart([
        { field: 'dir', content: 'docs' },
        { field: 'baseCommit', content: commit },
        { field: 'files', filename: 'résumé.txt', type: 'text/plain', content: 'one\n' },
        { field: 'files', filename: 'b.bin', type: 'application/octet-stream', content: 'two' },
      ]),
      MULTIPART
    );
    expectAnswer(uploaded, 200);
    expect(uploaded.json).toMatchObject({
      paths: ['docs/b.bin', 'docs/résumé.txt'],
      lastCommit: { subject: 'Upload 2 files to docs/' },
    });
    const listed = await call(server, 'GET', rooms('/files?path=docs'));
    expectAnswer(listed, 200, RoomFileListResponseSchema);
    const names = (listed.json.entries as Array<{ name: string }>).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['résumé.txt', 'b.bin']));
    commit = listed.json.commit as string;
  });

  it('POST /api/rooms/:id/files/upload refuses an agent, a clash, too many files and bad fields', async () => {
    const one = multipart([
      { field: 'files', filename: 'x.txt', type: 'text/plain', content: 'x' },
    ]);
    expectRefusal(
      await call(server, 'POST', rooms('/files/upload'), one, { ...MULTIPART, ...member.header }),
      403,
      'PEOPLE_ONLY'
    );
    expectRefusal(
      await call(
        server,
        'POST',
        rooms('/files/upload'),
        multipart([
          { field: 'dir', content: 'docs' },
          { field: 'files', filename: 'b.bin', type: 'text/plain', content: 'again' },
        ]),
        MULTIPART
      ),
      409,
      'ROOM_FILE_EXISTS'
    );
    const many = Array.from({ length: 21 }, (_, i) => ({
      field: 'files',
      filename: `f${i}.txt`,
      type: 'text/plain',
      content: String(i),
    }));
    expectAnswer(
      await call(server, 'POST', rooms('/files/upload'), multipart(many), MULTIPART),
      400,
      {
        error: 'One upload can carry at most 20 files.',
        code: 'ROOM_UPLOAD_TOO_MANY_FILES',
      }
    );
    expectRefusal(
      await call(
        server,
        'POST',
        rooms('/files/upload'),
        multipart([{ field: 'wrong', filename: 'w.txt', type: 'text/plain', content: 'w' }]),
        MULTIPART
      ),
      400,
      'ROOM_FILE_PATH_INVALID'
    );
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/files/upload'),
        multipart([
          { field: 'replace', content: 'not json' },
          { field: 'files', filename: 'r.txt', type: 'text/plain', content: 'r' },
        ]),
        MULTIPART
      ),
      400,
      VALIDATION_FAILED
    );
    expectAnswer(
      await call(
        server,
        'POST',
        rooms('/files/upload'),
        multipart([
          {
            field: 'files',
            filename: 'huge.txt',
            type: 'text/plain',
            content: 'x'.repeat(5 * 1024 * 1024 + 1),
          },
        ]),
        MULTIPART
      ),
      409,
      {
        error: 'A file in that upload is larger than this room’s limit for one file, 5.0 MB.',
        code: 'FILE_TOO_LARGE',
      }
    );
    expectAnswer(
      await call(server, 'PUT', rooms('/files/content'), {
        path: 'big.md',
        baseCommit: commit,
        text: 'x'.repeat(1024 * 1024 + 1),
      }),
      413
    );
    const noFiles = {
      error: 'There were no files in that upload.',
      code: 'ROOM_FILE_PATH_INVALID',
    };
    expectAnswer(
      await call(server, 'POST', rooms('/files/upload'), multipart([]), MULTIPART),
      400,
      noFiles
    );
    expectAnswer(await call(server, 'POST', rooms('/files/upload')), 400, noFiles);
  });

  it('POST /api/rooms/:id/files/move and /files/delete change the tree, and refuse a stale lock', async () => {
    const moved = await call(server, 'POST', rooms('/files/move'), {
      from: 'docs/b.bin',
      to: 'docs/c.bin',
      baseCommit: commit,
    });
    expectAnswer(moved, 200);
    expect(moved.json).toMatchObject({ paths: ['docs/c.bin'] });
    const afterMove = (await call(server, 'GET', rooms('/files'))).json.commit as string;
    expectAnswer(
      await call(server, 'POST', rooms('/files/delete'), {
        path: 'docs/c.bin',
        baseCommit: commit,
      }),
      409
    );
    expectAnswer(
      await call(server, 'POST', rooms('/files/delete'), {
        path: 'docs/c.bin',
        baseCommit: afterMove,
      }),
      200
    );
    expectAnswer(await call(server, 'POST', rooms('/files/move'), {}), 400, VALIDATION_FAILED);
    expectRefusal(
      await call(
        server,
        'POST',
        rooms('/files/delete'),
        { path: 'ROOM.md', baseCommit: afterMove },
        member.header
      ),
      403,
      'PEOPLE_ONLY'
    );
    commit = (await call(server, 'GET', rooms('/files'))).json.commit as string;
  });

  it('POST /api/rooms/:id/files/from-attachment keeps a posted file, and 404s anything else', async () => {
    const kept = await call(server, 'POST', rooms('/files/from-attachment'), {
      attachmentId: fileAttachment,
      dir: '',
      name: 'kept.html',
      baseCommit: commit,
    });
    expectAnswer(kept, 200);
    expect(kept.json).toMatchObject({
      paths: ['kept.html'],
      lastCommit: { subject: 'Add kept.html from the chat' },
    });
    expectAnswer(
      await call(server, 'POST', rooms('/files/from-attachment'), {
        attachmentId: 'not-an-id',
        baseCommit: null,
      }),
      404,
      { error: 'No such file.', code: 'ATTACHMENT_NOT_FOUND' }
    );
  });

  it('POST /api/rooms/:id/repo/main/repair and /repo/merge answer their refusals', async () => {
    expectAnswer(
      await call(server, 'POST', rooms('/repo/main/repair'), { action: 'commit' }),
      200,
      {
        action: 'commit',
        commit: null,
        paths: 0,
        clean: true,
      }
    );
    expectRefusal(
      await call(server, 'POST', rooms('/repo/main/repair'), { action: 'commit' }, member.header),
      403,
      'OPERATOR_ONLY'
    );
    expectAnswer(
      await call(server, 'POST', rooms('/repo/main/repair'), {}),
      400,
      VALIDATION_FAILED
    );
    expectAnswer(await call(server, 'POST', rooms('/repo/merge'), { summary: 'Nothing' }), 409, {
      error:
        'You have no working copy in this room to merge. Only an agent that has worked in the room has one.',
      code: 'NOTHING_TO_MERGE',
    });
    expectRefusal(
      await call(
        server,
        'POST',
        rooms('/repo/merge'),
        { summary: 'x', worktree: 'w' },
        member.header
      ),
      403,
      'OPERATOR_ONLY'
    );
    expectAnswer(await call(server, 'POST', rooms('/repo/merge'), {}), 400, VALIDATION_FAILED);
  });

  it('GET /api/rooms/:id/events opens with the snapshot, then streams a live entry', async () => {
    const stream = await openStream(server, rooms('/events'));
    open.push(stream);
    expect(stream.status).toBe(200);
    for (const [name, want] of Object.entries(STREAM_HEADERS)) {
      expect(stream.headers[name], `header ${name}`).toBe(want);
    }
    expect(stream.headers['content-length']).toBeUndefined();
    await stream.waitFor((text) => text.includes('event: snapshot'));
    expect(stream.text()).toMatch(/^: connected\n\nevent: snapshot\ndata: \{/);
    expect(eventNames(stream.text())[0]).toBe('snapshot');

    const posted = await setup(server, 'POST', rooms('/entries'), { text: 'Live one' });
    const seq = posted.json.seq as number;
    const text = await stream.waitFor((sent) => sent.includes('Live one'));
    expect(text).toMatch(
      new RegExp(`\\nid: [^\\n]+\\nevent: entry\\ndata: \\{"type":"entry","seq":${seq},`)
    );
    stream.close();
  });

  it('GET /api/rooms/:id/events resumes from Last-Event-ID, replaying only what came after', async () => {
    const cold = await openStream(server, rooms('/events'));
    open.push(cold);
    await cold.waitFor((text) => text.includes('event: snapshot'));
    cold.close();

    const marker = await setup(server, 'POST', rooms('/entries'), { text: 'Before the resume' });
    const later = await setup(server, 'POST', rooms('/entries'), { text: 'After the resume' });
    // The id the live frame carried for the marker, read from a fresh stream.
    const watcher = await openStream(server, rooms(`/events?after=${firstSeq}`));
    open.push(watcher);
    const replayed = await watcher.waitFor((text) => text.includes('After the resume'));
    watcher.close();
    expect(replayed.startsWith(': connected\n\n')).toBe(true);
    expect(replayed).not.toContain('event: snapshot');
    const markerId = /\nid: ([^\n]+)\nevent: entry\ndata: [^\n]*Before the resume/.exec(
      replayed
    )?.[1];
    expect(markerId, replayed).toBeTruthy();

    const resumed = await openStream(server, rooms('/events'), { 'last-event-id': markerId! });
    open.push(resumed);
    expect(resumed.status).toBe(200);
    const text = await resumed.waitFor((sent) => sent.includes('After the resume'));
    expect(text.startsWith(': connected\n\n')).toBe(true);
    expect(text).not.toContain('event: snapshot');
    expect(text).not.toContain('Before the resume');
    expect(text).toContain(`"seq":${later.json.seq as number}`);
    expect(marker.json.seq as number).toBeLessThan(later.json.seq as number);
    resumed.close();
  });

  it('GET /api/rooms/:id/events treats a cursor past the end as a cold connect', async () => {
    const stream = await openStream(server, rooms('/events'), { 'last-event-id': 'garbage' });
    open.push(stream);
    await stream.waitFor((text) => text.includes('event: snapshot'));
    stream.close();
    const past = await openStream(server, rooms('/events?after=999999'));
    open.push(past);
    await past.waitFor((text) => text.includes('event: snapshot'));
    past.close();
  });

  it('GET /api/rooms/:id/events streams to a member agent', async () => {
    const stream = await openStream(server, rooms('/events'), member.header);
    open.push(stream);
    expect(stream.status).toBe(200);
    await stream.waitFor((text) => text.includes('event: snapshot'));
    stream.close();
  });

  it('DELETE /api/rooms/:id/members/:authorId removes a member: 204', async () => {
    const removed = await call(server, 'DELETE', rooms(`/members/${memberAuthorId}`));
    expectAnswer(removed, 204);
    expect(removed.text).toBe('');
    expectRefusal(
      await call(server, 'GET', rooms(), undefined, member.header),
      404,
      'ROOM_NOT_FOUND'
    );
    expectRefusal(
      await call(server, 'DELETE', rooms(`/members/${memberAuthorId}`)),
      404,
      'MEMBER_NOT_FOUND'
    );
  });

  it('PATCH /api/rooms/:id archives the room, and an archived room refuses a post', async () => {
    const archived = await call(server, 'PATCH', rooms(), { archived: true });
    expectAnswer(archived, 200, RoomWithRosterSchema);
    expect(archived.json.archived).toBe(true);
    expectRefusal(
      await call(server, 'POST', rooms('/entries'), { text: 'Too late' }),
      409,
      'ROOM_ARCHIVED'
    );
    expectRefusal(
      await call(
        server,
        'POST',
        rooms('/attachments'),
        multipart([{ field: 'files', filename: 'a.txt', type: 'text/plain', content: 'a' }]),
        MULTIPART
      ),
      409,
      'ROOM_ARCHIVED'
    );
    expectRefusal(
      await call(server, 'POST', rooms('/canvas'), { content: { type: 'markdown', content: 'x' } }),
      409,
      'ROOM_ARCHIVED'
    );
    const listed = await call(server, 'GET', '/api/rooms?includeArchived=true');
    expect((listed.json.rooms as Array<{ id: string }>).map((room) => room.id)).toContain(roomId);
  });

  it('POST /api/rooms opens a DM idempotently: 201, then 200', async () => {
    const first = await call(server, 'POST', '/api/rooms', {
      kind: 'dm',
      title: 'Contract DM',
      agentPaths: [stranger.agentDir],
    });
    expectAnswer(first, 201, RoomWithRosterSchema);
    const second = await call(server, 'POST', '/api/rooms', {
      kind: 'dm',
      title: 'Contract DM',
      agentPaths: [stranger.agentDir],
    });
    expectAnswer(second, 200, RoomWithRosterSchema);
    expect(second.json.id).toBe(first.json.id);
  });
});

// ---------------------------------------------------------------------------
// 3. Login on
// ---------------------------------------------------------------------------

describe('contract: the room routes with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;

  beforeAll(async () => {
    server = await bootComposedServer();
    const owner = {
      email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
      password: 'a-long-password-1',
    };
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...owner, name: 'Owner' }, origin);
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', owner, origin);
    const raw = signedIn.headers['set-cookie'] ?? [];
    cookie = { cookie: raw.map((value) => value.split(';')[0]!).join('; ') };
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } }, cookie);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, path] of [
      ['GET', '/api/rooms'],
      ['POST', '/api/rooms'],
      ['GET', `/api/rooms/${NO_ROOM}`],
      ['GET', `/api/rooms/${NO_ROOM}/events`],
      ['POST', `/api/rooms/${NO_ROOM}/attachments`],
    ] as const) {
      const answer = await call(server, method, path);
      expect(answer.status, `${method} ${path}`).toBe(401);
      AUTH_REQUIRED.parse(answer.json);
    }
  });

  it('answers the owner’s cookie, and the room it opens reads as theirs', async () => {
    const created = await call(
      server,
      'POST',
      '/api/rooms',
      { kind: 'channel', title: 'Signed in' },
      cookie
    );
    expectAnswer(created, 201, RoomWithRosterSchema);
    expect(created.json.viewerIsOperator).toBe(true);
    const roomId = created.json.id as string;
    expectAnswer(
      await call(server, 'GET', '/api/rooms', undefined, cookie),
      200,
      RoomListResponseSchema
    );
    const stream = await openStream(server, `/api/rooms/${roomId}/events`, cookie);
    expect(stream.status).toBe(200);
    await stream.waitFor((text) => text.includes('event: snapshot'));
    stream.close();
  });
});
