/**
 * Contract for the global event stream, `GET /api/events` over Server-Sent
 * Events, which moves to Hono in DOR-2813. That PR must pass this file
 * unchanged.
 *
 * The stream is the public integration contract (`docs/integrations/sse-protocol.mdx`)
 * and what the Electron main process reads for its tray count, and no browser
 * spec reads it, so this file is its only guard. It pins the wire bytes, not a
 * parser's reading of them: the exact headers, the `connected` frame first, a
 * live broadcast, the heartbeat, which caller a frame addressed to a person
 * reaches (a read cursor reaches only its own person, never an agent), and
 * that a client leaving frees its place. Replay from `Last-Event-ID` is
 * `routes/__tests__/events-replay.test.ts`; here an id it never wrote is cold.
 *
 * The WebSocket the cockpit opens on the same path is an upgrade, not a
 * route, and is not in this file.
 *
 * Three servers:
 *
 * 1. Login off, nothing set up: the refusals and the paths that do not exist.
 * 2. Login off, driven by hand: the stream itself, held open.
 * 3. Login on: no credential is refused at the gate; the owner's cookie streams.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  stepUpAt,
  confirmSetupAnswer,
} from './harness.js';
import { problemBody } from '@dorkos/http-kit';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const PROBLEM_TYPE = { 'content-type': /^application\/problem\+json$/ };
const NOT_FOUND = problemBody('not_found', {
  detail: 'This server has no API route at that path.',
});
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const CORS_REFUSED = z.object({ code: z.literal('origin_not_allowed') }).loose();
const HOST_REFUSED = z.object({ code: z.literal('host_not_allowed') }).loose();
const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
/** The global stream's ceiling on concurrent readers (`SSE.MAX_TOTAL_CLIENTS`). */
const MAX_CLIENTS = 500;
/** The heartbeat interval (`SSE.HEARTBEAT_INTERVAL_MS`), and a margin past it. */
const HEARTBEAT_WAIT_MS = 15_000 + 5_000;
/**
 * The `connected` frame, byte for byte, and nothing before it: a whole
 * `DorkOsEvent` with `seq: null` and no `id:` line.
 */
const CONNECTED_FRAME =
  /^event: connected\ndata: \{"seq":null,"at":"[^"]+","type":"connected","payload":\{"connectedAt":"\d{4}-\d\d-\d\dT[\d:.]+Z"\}\}\n\n/;
/** The headers every stream answers with, whoever asks. */
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

/** An open stream, read as it arrives. */
interface OpenStream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Everything the server has sent so far. */
  text(): string;
  /** Resolves once the text so far satisfies `until`; fails after `timeoutMs`. */
  waitFor(until: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Whether the server ended the response. */
  ended(): boolean;
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
    // No keep-alive agent: each stream is its own socket, as a browser tab's is.
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

/** Open a stream and wait for its `connected` frame. */
async function connected(
  server: ComposedServer | undefined,
  url = '/api/events',
  headers: Record<string, string> = {}
): Promise<OpenStream> {
  const stream = await openStream(server, url, headers);
  expect(stream.status, `${url} answered ${stream.status}`).toBe(200);
  await stream.waitFor((text) => CONNECTED_FRAME.test(text));
  return stream;
}

/** Each frame's event name, in order. */
function eventNames(text: string): string[] {
  return [...text.matchAll(/^event: (.*)$/gm)].map((match) => match[1]!);
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
  headers: Record<string, string> = {},
  confirmationPassword?: string
): Promise<Answer> {
  let answer = await call(server, method, url, body, headers);
  if (confirmationPassword)
    answer = await confirmSetupAnswer(server!.baseUrl, answer, confirmationPassword, headers);
  if (answer.status >= 300) {
    throw new Error(`${method} ${url} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return answer;
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

/** A registered test agent, and its verified `X-DorkOS-Agent` header. */
interface SeededAgent {
  agentDir: string;
  header: Record<string, string>;
}

/** Register a fresh test agent and mint the token that proves it. */
async function seedAgent(
  server: ComposedServer | undefined,
  headers: Record<string, string> = {}
): Promise<SeededAgent> {
  const seeded = await setup(
    server,
    'POST',
    '/api/test/seed-agent',
    { slot: 'permission-requester', instance: `events-${randomUUID().slice(0, 8)}` },
    headers
  );
  const agentDir = seeded.json.agentDir as string;
  const minted = await setup(
    server,
    'POST',
    '/api/test/agent-token',
    { agentPath: agentDir },
    headers
  );
  return { agentDir, header: { 'X-DorkOS-Agent': minted.json.token as string } };
}

/**
 * Rename an agent, which every reader hears as `agents_changed` carrying the new
 * name. Sent after a frame under test, it is a barrier: one fan-out writes in
 * order, so a stream that has the name and not the earlier frame was passed
 * over, not slow.
 */
async function barrier(
  server: ComposedServer | undefined,
  agent: SeededAgent,
  headers: Record<string, string> = {}
): Promise<string> {
  const name = `Barrier ${randomUUID()}`;
  await setup(
    server,
    'PATCH',
    `/api/agents/current?path=${encodeURIComponent(agent.agentDir)}`,
    { displayName: name },
    headers
  );
  return name;
}

contractSuite('the global event stream, login off, the refusals', [
  {
    name: 'POST /api/events does not exist',
    method: 'POST',
    path: '/api/events',
    body: {},
    expect: { status: 404, headers: PROBLEM_TYPE, body: NOT_FOUND },
  },
  {
    name: 'DELETE /api/events does not exist',
    method: 'DELETE',
    path: '/api/events',
    expect: { status: 404, headers: PROBLEM_TYPE, body: NOT_FOUND },
  },
  {
    name: 'GET /api/events/anything does not exist',
    path: '/api/events/anything',
    expect: { status: 404, headers: PROBLEM_TYPE, body: NOT_FOUND },
  },
  {
    name: 'GET /api/events at a foreign host is refused by the host guard',
    path: '/api/events',
    headers: { host: 'evil.example' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'GET /api/events from a wrong browser origin is refused by CORS',
    path: '/api/events',
    headers: { origin: 'https://evil.example' },
    expect: { status: 403, schema: CORS_REFUSED },
  },
  // A mini app's frame is sandboxed to an opaque origin; it never opens this stream.
  {
    name: 'GET /api/events from a mini app frame (`Origin: null`) is refused',
    path: '/api/events',
    headers: { origin: 'null' },
    expect: { status: 403, schema: CORS_REFUSED },
  },
]);

describe('contract: the global event stream, driven by hand (login off)', () => {
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
  async function held(url?: string, headers?: Record<string, string>): Promise<OpenStream> {
    const stream = await connected(server, url, headers);
    open.push(stream);
    return stream;
  }

  it('answers as an event stream and leads with the connected frame', async () => {
    const stream = await held();
    for (const [name, want] of Object.entries(STREAM_HEADERS)) {
      expect(stream.headers[name], `header ${name}`).toBe(want);
    }
    expect(stream.headers['content-length']).toBeUndefined();
    // No origin, no allow-origin: the CORS answer is only for a browser that asked.
    expect(stream.headers['access-control-allow-origin']).toBeUndefined();
    expect(stream.text()).toMatch(CONNECTED_FRAME);
    expect(stream.ended()).toBe(false);
    stream.close();
  });

  it('answers a credentialed browser on its own origin with the CORS headers', async () => {
    const stream = await held('/api/events', {
      origin: server!.baseUrl,
      accept: 'text/event-stream',
    });
    expect(stream.headers['access-control-allow-origin']).toBe(server!.baseUrl);
    expect(stream.headers['access-control-allow-credentials']).toBe('true');
    expect(stream.headers['content-type']).toBe('text/event-stream');
    stream.close();
  });

  it('is the same stream with a trailing slash, or a query it does not read', async () => {
    for (const url of ['/api/events/', '/api/events?since=0', '/api/events?anything=at-all']) {
      const stream = await held(url);
      expect(stream.headers['content-type'], url).toBe('text/event-stream');
      expect(stream.headers['x-accel-buffering'], url).toBe('no');
      stream.close();
    }
  });

  it('treats a Last-Event-ID it never wrote as a cold connect, opening with connected', async () => {
    const stream = await held('/api/events', { 'last-event-id': '42' });
    expect(stream.text()).toMatch(CONNECTED_FRAME);
    stream.close();
  });

  it('streams a live broadcast to every reader, and a person’s frames only to that person', async () => {
    const seat = await seedAgent(server);
    const person = await held();
    const agent = await held('/api/events', AGENT);
    const verifiedAgent = await held('/api/events', seat.header);
    expect(agent.text()).toMatch(CONNECTED_FRAME);

    // `config_changed` and a session's `read_cursor` are both the person's.
    // The rename after them reaches every reader.
    await setup(server, 'PATCH', '/api/config', { spaces: { enabled: true } });
    const thread = randomUUID();
    await setup(server, 'PUT', `/api/read-cursors/session/${thread}`, { lastReadSeq: 3 });
    const name = await barrier(server, seat);

    const personText = await person.waitFor((text) => text.includes(name));
    expect(personText).toMatch(
      /\nevent: config_changed\ndata: \{"seq":\d+,"at":"[^"]+","type":"config_changed","payload":\{"sections":\["spaces"\],"changedAt":"[^"]+"\}\}\n\n/
    );
    expect(personText).toMatch(
      new RegExp(
        `\\nevent: read_cursor\\ndata: \\{"seq":\\d+,"at":"[^"]+","type":"read_cursor","payload":\\{"userId":"[^"]+","threadKind":"session","threadId":"${thread}","lastReadSeq":3\\}\\}\\n\\n`
      )
    );
    expect(eventNames(personText).indexOf('config_changed')).toBeLessThan(
      eventNames(personText).indexOf('read_cursor')
    );
    expect(personText.indexOf(thread)).toBeLessThan(personText.indexOf(name));

    for (const stream of [agent, verifiedAgent]) {
      const agentText = await stream.waitFor((text) => text.includes(name));
      expect(eventNames(agentText)).toContain('agents_changed');
      expect(agentText).not.toContain(thread);
      expect(eventNames(agentText)).not.toContain('read_cursor');
      expect(eventNames(agentText)).not.toContain('config_changed');
    }
    person.close();
    agent.close();
    verifiedAgent.close();
  });

  it(
    'sends a heartbeat frame while nothing else happens',
    async () => {
      const stream = await held();
      const text = await stream.waitFor(
        (sent) => sent.includes('event: heartbeat'),
        HEARTBEAT_WAIT_MS
      );
      expect(text).toMatch(
        /\n\nevent: heartbeat\ndata: \{"seq":null,"at":"[^"]+","type":"heartbeat","payload":null\}\n\n/
      );
      expect(stream.ended()).toBe(false);
      stream.close();
    },
    HEARTBEAT_WAIT_MS + 5_000
  );

  it('turns a reader past the ceiling away, and a reader who leaves frees its place', async () => {
    for (const stream of open.splice(0)) stream.close();
    // Every earlier stream was closed; wait until the server agrees, by the
    // only measure it offers: a full house of fresh readers is admitted.
    const readers: OpenStream[] = [];
    const deadline = Date.now() + 20_000;
    while (readers.length < MAX_CLIENTS) {
      const stream = await openStream(server, '/api/events');
      if (stream.status === 503) {
        stream.close();
        if (Date.now() > deadline) throw new Error('earlier readers were never released');
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      expect(stream.status).toBe(200);
      readers.push(stream);
      open.push(stream);
    }
    await Promise.all(readers.map((stream) => stream.waitFor((t) => CONNECTED_FRAME.test(t))));

    await checkContractCase(server!.baseUrl, {
      name: 'one past the ceiling',
      path: '/api/events',
      expect: {
        status: 503,
        headers: PROBLEM_TYPE,
        body: problemBody('temporarily_unavailable', {
          detail: 'Too many live connections are open. Try again soon.',
        }),
      },
    });

    // One reader leaves: within a moment, a new reader takes its place.
    readers.pop()!.close();
    let replacement: OpenStream | undefined;
    const freed = Date.now() + 10_000;
    while (!replacement) {
      const stream = await openStream(server, '/api/events');
      if (stream.status === 200) replacement = stream;
      else {
        expect(stream.status).toBe(503);
        stream.close();
        if (Date.now() > freed) throw new Error('a reader that left never freed its place');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    open.push(replacement);
    await replacement.waitFor((text) => CONNECTED_FRAME.test(text));

    for (const stream of open.splice(0)) stream.close();
    // The server is still answering after every reader left.
    await checkContractCase(server!.baseUrl, {
      name: 'health after the readers left',
      path: '/api/health',
      expect: { status: 200 },
    });
  }, 90_000);
});

describe('contract: the global event stream with login on', () => {
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
      await stepUpAt(server!.baseUrl, 'a-long-password-1'),
      'a-long-password-1'
    );
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('refuses a caller with no credential at the session gate', async () => {
    for (const path of ['/api/events', '/api/events/', '/api/events/anything']) {
      await checkContractCase(server!.baseUrl, {
        name: path,
        path,
        expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
      });
    }
    await checkContractCase(server!.baseUrl, {
      name: 'an unverified agent',
      path: '/api/events',
      headers: AGENT,
      expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
    });
  });

  it('sends a room’s read cursor to its signed-in member, never to an agent seated in it', async () => {
    const owner = { ...cookie, origin: server!.baseUrl };
    const seat = await seedAgent(server, owner);
    const created = await setup(
      server,
      'POST',
      '/api/rooms',
      { kind: 'channel', title: `Cursor ${randomUUID().slice(0, 8)}`, agentPaths: [seat.agentDir] },
      owner
    );
    const roomId = created.json.id as string;
    const members = created.json.members as { author: { kind: string } }[];
    expect(members.map((entry) => entry.author.kind)).toEqual(
      expect.arrayContaining(['agent', 'human'])
    );

    const member = await connected(server, '/api/events', cookie);
    // The owner's own sign-in, presenting the seated agent's proof: an agent.
    const seated = await connected(server, '/api/events', { ...cookie, ...seat.header });
    const outsider = await connected(server, '/api/events', {
      ...cookie,
      ...(await seedAgent(server, owner)).header,
    });

    await setup(server, 'PUT', `/api/read-cursors/room/${roomId}`, { lastReadSeq: 1 }, owner);
    const name = await barrier(server, seat, owner);

    const memberText = await member.waitFor((text) => text.includes(name));
    const cursorAt = memberText.search(
      new RegExp(
        `\\nevent: read_cursor\\ndata: \\{"seq":\\d+,"at":"[^"]+","type":"read_cursor","payload":\\{"userId":"[^"]+","threadKind":"room","threadId":"${roomId}","lastReadSeq":1,"unreadCount":\\d+\\}\\}\\n\\n`
      )
    );
    expect(cursorAt, memberText).toBeGreaterThan(-1);
    expect(cursorAt).toBeLessThan(memberText.indexOf(name));
    for (const stream of [seated, outsider]) {
      const agentText = await stream.waitFor((text) => text.includes(name));
      expect(eventNames(agentText)).not.toContain('read_cursor');
    }
    member.close();
    seated.close();
    outsider.close();
  });

  it('streams to the owner’s cookie', async () => {
    const stream = await connected(server, '/api/events', cookie);
    for (const [name, want] of Object.entries(STREAM_HEADERS)) {
      expect(stream.headers[name], `header ${name}`).toBe(want);
    }
    expect(stream.text()).toMatch(CONNECTED_FRAME);
    stream.close();
  });
});
