/**
 * @vitest-environment node
 *
 * `/api/hub/computers` behind the real `/api` chain, with a fake computer
 * connection: only a hub answers, only linked computers are reached, a
 * computer that is not connected is woken, only the protocol's own request
 * shapes go out, the computer's refusals come back in its own words, and a
 * relayed chat stream carries its frames, resumes, and closes both ways.
 */
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import {
  SESSION_RELAY_FEATURES,
  type RelayError,
  type RelayRequest,
} from '@dorkos/shared/session-relay';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: audit.record,
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RelayStreamFrame } from '../../services/core/hub-relay/index.js';
import {
  createHubComputerRoutes,
  type HubComputerRoutesDeps,
  type RelayedComputer,
} from '../hub-computers.js';

const COMPUTER = 'computer-1';
const AGENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CURSOR = `${SESSION}-1-g1-5`;
const BASE = `/api/hub/computers/${COMPUTER}`;

interface OpenedStream {
  sessionId: string;
  resume: string | undefined;
  onFrame: (frame: RelayStreamFrame) => void;
  onEnd: (error?: RelayError) => void;
  close: ReturnType<typeof vi.fn>;
}

/** A connected computer that answers every request with `answer`. */
function fakeComputer() {
  const streams: OpenedStream[] = [];
  const computer = {
    connected: true,
    features: [...SESSION_RELAY_FEATURES] as readonly string[],
    request: vi.fn(async (req: RelayRequest) => ({ ok: true, body: { echoed: req.op } })),
    openStream: vi.fn(
      (
        sessionId: string,
        resume: string | undefined,
        onFrame: OpenedStream['onFrame'],
        onEnd: OpenedStream['onEnd']
      ) => {
        const close = vi.fn();
        streams.push({ sessionId, resume, onFrame, onEnd, close });
        return close;
      }
    ),
  };
  return { computer, streams };
}

let fake = fakeComputer();
const release = vi.fn();
/** Who the chain put on the request; `null` for no one. */
const caller: { credential: 'cookie' | 'api-key' | null } = { credential: 'cookie' };
const SSE_ACCEPT = { Accept: 'text/event-stream' };
const deps = {
  isHub: vi.fn(() => true),
  linkedComputerIds: vi.fn((): readonly string[] => [COMPUTER]),
  connection: vi.fn((): RelayedComputer | null => fake.computer as unknown as RelayedComputer),
  wake: vi.fn(),
  viewers: { open: vi.fn(() => release) },
} satisfies HubComputerRoutesDeps;

/** The owner's link routes, faked: only the stored names matter here. */
const links = {
  servingOrigin: () => 'https://me.dorkos.app',
  mint: vi.fn(),
  forget: vi.fn(),
  record: (computerId: string) =>
    computerId === COMPUTER
      ? {
          v: 1 as const,
          computerId,
          secretHash: 'h'.repeat(43),
          computerKey: 'k'.repeat(43),
          computerName: 'Studio Mac',
          linkedAt: '2026-10-16T12:00:00.000Z',
        }
      : null,
};

const server = listeningServer(
  honoGroupListener(
    { path: '/api/hub/computers', routes: createHubComputerRoutes(deps, links) },
    {
      before: async (c, next) => {
        if (caller.credential)
          c.set('user', { userId: 'user_owner', credential: caller.credential });
        await next();
      },
    }
  )
);

beforeEach(() => {
  vi.clearAllMocks();
  caller.credential = 'cookie';
  fake = fakeComputer();
  deps.isHub.mockReturnValue(true);
  deps.linkedComputerIds.mockReturnValue([COMPUTER]);
  deps.connection.mockImplementation(() => fake.computer as unknown as RelayedComputer);
});

/** Open the stream route and collect what it writes. */
function openSse(path: string, headers: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo;
  let body = '';
  let response: IncomingMessage | undefined;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  const req = httpGet(
    { host: '127.0.0.1', port, path, headers: { ...SSE_ACCEPT, ...headers } },
    (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', resolveEnded);
      res.on('close', resolveEnded);
    }
  );
  req.on('error', resolveEnded);
  return {
    destroy: () => req.destroy(),
    ended,
    body: () => body,
    status: () => response?.statusCode,
    headers: () => response?.headers,
  };
}

/** Wait until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 5 });
}

describe('who is answered', () => {
  it('answers the /api 404 on a person`s own computer', async () => {
    deps.isHub.mockReturnValue(false);
    for (const path of ['/api/hub/computers', `${BASE}/agents/${AGENT}/chats`]) {
      const res = await request(server).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('API_NOT_FOUND');
    }
    const post = await request(server).post(`${BASE}/sessions/${SESSION}/interrupt`);
    expect(post.status).toBe(404);
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it('answers a computer it does not serve exactly as an unknown path', async () => {
    deps.linkedComputerIds.mockReturnValue([]);
    const res = await request(server).get(`${BASE}/agents/${AGENT}/chats`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'API_NOT_FOUND' });
    expect(deps.wake).not.toHaveBeenCalled();
    expect(fake.computer.request).not.toHaveBeenCalled();
  });
});

describe('only the person`s own browser sign-in', () => {
  const PATHS = [
    ['get', '/api/hub/computers'],
    ['get', `${BASE}/agents/${AGENT}/chats`],
    ['post', `${BASE}/sessions/${SESSION}/interrupt`],
  ] as const;

  it.each(PATHS)('refuses %s %s to a caller presenting agent identity', async (method, path) => {
    const res = await request(server)[method](path).set('X-DorkOS-Agent', 'agent-token');
    expect(res.status).toBe(403);
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it.each(PATHS)('refuses %s %s to an API key, reads included', async (method, path) => {
    caller.credential = 'api-key';
    const res = await request(server)[method](path);
    expect(res.status).toBe(403);
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it('refuses the stream to an API key before opening anything', async () => {
    caller.credential = 'api-key';
    const res = await request(server).get(`${BASE}/sessions/${SESSION}/stream`).set(SSE_ACCEPT);
    expect(res.status).toBe(403);
    expect(deps.viewers.open).not.toHaveBeenCalled();
  });

  it('refuses a request no one is signed in on', async () => {
    caller.credential = null;
    const res = await request(server).get('/api/hub/computers');
    expect(res.status).toBe(401);
  });

  it.each(PATHS)('lets a cookie sign-in through to %s %s', async (method, path) => {
    const res = await request(server)[method](path);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/hub/computers', () => {
  it('lists linked computers with whether they are connected, and nothing secret', async () => {
    deps.linkedComputerIds.mockReturnValue([COMPUTER, 'computer-2']);
    deps.connection.mockImplementation(((id: string) =>
      id === COMPUTER ? fake.computer : null) as never);
    const res = await request(server).get('/api/hub/computers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      computers: [
        {
          computerId: COMPUTER,
          computerName: 'Studio Mac',
          linkedAt: '2026-10-16T12:00:00.000Z',
          connected: true,
          features: [...SESSION_RELAY_FEATURES],
        },
        {
          computerId: 'computer-2',
          computerName: null,
          linkedAt: null,
          connected: false,
          features: [],
        },
      ],
    });
  });
});

describe('reaching a computer', () => {
  it('wakes one that is not connected and asks the page to try again', async () => {
    deps.connection.mockReturnValue(null);
    const res = await request(server).get(`${BASE}/agents/${AGENT}/chats`);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toMatchObject({
      code: 'computer_waking',
      message: 'Waking your computer. Try again in a moment.',
    });
    expect(deps.wake).toHaveBeenCalledWith(COMPUTER);
  });

  it('refuses a feature the computer did not advertise, without sending it', async () => {
    fake.computer.features = ['chats.list'];
    const res = await request(server).post(`${BASE}/sessions/${SESSION}/interrupt`);
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'needs_update', feature: 'session.interrupt' });
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it('answers a computer`s 401 as 502, never as the owner being signed out', async () => {
    fake.computer.request.mockResolvedValueOnce({
      ok: false,
      error: { status: 401, code: 'refused', message: 'Sign in again.' },
    } as never);
    const res = await request(server).get(`${BASE}/agents/${AGENT}/chats`);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'computer_refused',
      message: 'Your computer turned this request away.',
    });
  });

  it('answers the computer`s refusal with its own status and sentence', async () => {
    fake.computer.request.mockResolvedValueOnce({
      ok: false,
      error: { status: 404, code: 'not_found', message: 'No such chat.' },
    } as never);
    const res = await request(server).get(`${BASE}/agents/${AGENT}/chats`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found', message: 'No such chat.' });
  });
});

describe('requests', () => {
  it('relays chats.list with only the agent id', async () => {
    const res = await request(server).get(`${BASE}/agents/${AGENT}/chats`);
    expect(res.status).toBe(200);
    expect(fake.computer.request).toHaveBeenCalledWith({ op: 'chats.list', agentId: AGENT });
  });

  it('refuses ids that are not the protocol`s shapes', async () => {
    const agent = await request(server).get(`${BASE}/agents/not-an-agent/chats`);
    const session = await request(server).post(`${BASE}/sessions/NOT-A-UUID/interrupt`);
    expect([agent.status, session.status]).toEqual([400, 400]);
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it('sends a message, and records it without what was said', async () => {
    const res = await request(server)
      .post(`${BASE}/sessions/${SESSION}/messages`)
      .send({ content: 'secret plans', newChat: { agentId: AGENT } });
    expect(res.status).toBe(200);
    expect(fake.computer.request).toHaveBeenCalledWith({
      op: 'session.send',
      sessionId: SESSION,
      content: 'secret plans',
      newChat: { agentId: AGENT },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: 'hub.relay.session.send',
      outcome: 'ok',
      target: { type: 'session', id: SESSION, containerId: COMPUTER },
    });
    expect(JSON.stringify(entry)).not.toContain('secret plans');
  });

  it('never forwards a field the protocol does not carry', async () => {
    for (const extra of [
      { cwd: '/etc' },
      { permissionMode: 'bypassPermissions' },
      { runtime: 'x' },
    ]) {
      const res = await request(server)
        .post(`${BASE}/sessions/${SESSION}/messages`)
        .send({ content: 'hi', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const elsewhere = await request(server)
      .post(`${BASE}/sessions/${SESSION}/messages`)
      .send({ content: 'hi', sessionId: '1f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(elsewhere.status).toBe(400);
    const newChat = await request(server)
      .post(`${BASE}/sessions/${SESSION}/messages`)
      .send({ content: 'hi', newChat: { agentId: AGENT, agentPath: '/tmp' } });
    expect(newChat.status).toBe(400);
    expect(fake.computer.request).not.toHaveBeenCalled();
  });

  it('interrupts, and records it', async () => {
    const res = await request(server).post(`${BASE}/sessions/${SESSION}/interrupt`);
    expect(res.status).toBe(200);
    expect(fake.computer.request).toHaveBeenCalledWith({
      op: 'session.interrupt',
      sessionId: SESSION,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.relay.session.interrupt', outcome: 'ok' })
    );
  });

  it('answers a question, and records a refusal as refused', async () => {
    fake.computer.request.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, code: 'refused', message: 'Nothing is waiting.' },
    } as never);
    const res = await request(server)
      .post(`${BASE}/sessions/${SESSION}/answers`)
      .send({ toolCallId: 'tool_1', answers: { '0': 'yes' } });
    expect(res.status).toBe(409);
    expect(fake.computer.request).toHaveBeenCalledWith({
      op: 'interaction.respond',
      sessionId: SESSION,
      answer: { kind: 'answer', toolCallId: 'tool_1', answers: { '0': 'yes' } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.relay.interaction.answer', outcome: 'refused' })
    );
  });

  it('offers no approvals: an answer carrying a proof or a kind is refused', async () => {
    for (const body of [
      { toolCallId: 'tool_1', answers: {}, kind: 'approve' },
      { toolCallId: 'tool_1', answers: {}, proof: { challengeId: 'c1' } },
    ]) {
      const res = await request(server).post(`${BASE}/sessions/${SESSION}/answers`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.computer.request).not.toHaveBeenCalled();
  });
});

describe('the chat stream', () => {
  it('relays frames as SSE, resuming from Last-Event-ID, and counts a viewer', async () => {
    const sse = openSse(`${BASE}/sessions/${SESSION}/stream`, { 'Last-Event-ID': CURSOR });
    await until(() => fake.streams.length === 1);
    expect(fake.streams[0]).toMatchObject({ sessionId: SESSION, resume: CURSOR });
    expect(deps.viewers.open).toHaveBeenCalledWith(COMPUTER);
    fake.streams[0]!.onFrame({
      event: 'text_delta',
      data: { text: 'hi' },
      id: `${SESSION}-1-g1-6`,
    });
    fake.streams[0]!.onFrame({ event: 'sync_update', data: { n: 1 } });
    await until(() => sse.body().includes('sync_update'));
    expect(sse.status()).toBe(200);
    expect(sse.headers()?.['content-type']).toContain('text/event-stream');
    expect(sse.body()).toContain(
      `id: ${SESSION}-1-g1-6\nevent: text_delta\ndata: {"text":"hi"}\n\n`
    );
    expect(sse.body()).toContain('event: sync_update\ndata: {"n":1}\n\n');
    sse.destroy();
    await until(() => fake.streams[0]!.close.mock.calls.length === 1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes ?resume= when there is no Last-Event-ID, and refuses a bad cursor', async () => {
    const sse = openSse(`${BASE}/sessions/${SESSION}/stream?resume=${CURSOR}`);
    await until(() => fake.streams.length === 1);
    expect(fake.streams[0]!.resume).toBe(CURSOR);
    sse.destroy();
    const bad = await request(server)
      .get(`${BASE}/sessions/${SESSION}/stream`)
      .set(SSE_ACCEPT)
      .set('Last-Event-ID', '../../etc?x=1');
    expect(bad.status).toBe(400);
  });

  it('ends with an error event when the computer ends the stream with a reason', async () => {
    const sse = openSse(`${BASE}/sessions/${SESSION}/stream`);
    await until(() => fake.streams.length === 1);
    fake.streams[0]!.onEnd({ status: 404, code: 'not_found', message: 'No such chat.' });
    await sse.ended;
    expect(sse.body()).toContain(
      'event: error\ndata: {"code":"not_found","message":"No such chat."}\n\n'
    );
    expect(fake.streams[0]!.close).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('drops a frame whose event name would split the stream', async () => {
    const sse = openSse(`${BASE}/sessions/${SESSION}/stream`);
    await until(() => fake.streams.length === 1);
    fake.streams[0]!.onFrame({ event: 'x\ndata: injected', data: 1 });
    fake.streams[0]!.onEnd();
    await sse.ended;
    expect(sse.body()).not.toContain('injected');
  });

  it('wakes a computer that is not connected instead of opening a stream', async () => {
    deps.connection.mockReturnValue(null);
    const res = await request(server).get(`${BASE}/sessions/${SESSION}/stream`).set(SSE_ACCEPT);
    expect(res.status).toBe(503);
    expect(deps.wake).toHaveBeenCalledWith(COMPUTER);
    expect(deps.viewers.open).not.toHaveBeenCalled();
  });

  it('refuses a request that does not accept an event stream', async () => {
    const res = await request(server).get(`${BASE}/sessions/${SESSION}/stream`);
    expect(res.status).toBe(406);
    expect(fake.computer.openStream).not.toHaveBeenCalled();
    expect(deps.viewers.open).not.toHaveBeenCalled();
  });

  it('releases the viewer when starting the stream throws', async () => {
    fake.computer.openStream.mockImplementationOnce(() => {
      throw new Error('could not start');
    });
    const sse = openSse(`${BASE}/sessions/${SESSION}/stream`);
    await sse.ended;
    expect(deps.viewers.open).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers 501 before opening when the computer cannot stream', async () => {
    fake.computer.features = ['chats.list'];
    const res = await request(server).get(`${BASE}/sessions/${SESSION}/stream`).set(SSE_ACCEPT);
    expect(res.status).toBe(501);
    expect(fake.computer.openStream).not.toHaveBeenCalled();
  });
});
