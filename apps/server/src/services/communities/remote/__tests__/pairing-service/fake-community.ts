/**
 * A fake Community host on a real local HTTP server, shared by the pairing-service suites.
 * Tests steer its answers through the mutable `fake` state; each test file gets its own
 * server and its own temporary data directory.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export const token = 'private-pairing-bearer-should-never-appear-in-dto';
export const remoteCommunityId = randomUUID();
export const secondRemoteCommunityId = randomUUID();
export const remoteAgentId = randomUUID();
export const remoteRoomId = randomUUID();
export const remoteAttachmentId = randomUUID();
export const qualified = `/api/v1/communities/${remoteCommunityId}`;
const secondQualified = `/api/v1/communities/${secondRemoteCommunityId}`;
/** Every request the fake Community received, with its JSON body. */
export const requests: Array<{ path: string; body: Record<string, string> }> = [];
/** Every self-revocation the fake Community received, with the bearer that sent it. */
export const revocations: Array<{ path: string; authorization: string | undefined }> = [];
/** Every agent removal the fake Community received, with the bearer that sent it. */
export const agentRemovals: Array<{ memberId: string; authorization: string | undefined }> = [];
/** How the fake Community answers removing one agent, by member id: default 204. */
export const agentRemovalAnswers = new Map<string, number | 'hang-up' | 'bare-404'>();
/**
 * How the fake host answers `GET /api/v1/community-names/:name`: a JSON body, `redirect` for a
 * 301 to another host, or nothing (the host's single `404` for every unresolvable name).
 */
export const shortNameAnswers = new Map<string, unknown>();

/** What the fake Community answers; tests set a field and restore it when done. */
export const fake = {
  approved: false,
  cancelled: false,
  redirect: false,
  requireExplicitCommunity: false,
  legacySingletonServer: false,
  pollCount: 0,
  waitForPoll: undefined as (() => Promise<void>) | undefined,
  waitForExchange: undefined as (() => Promise<void>) | undefined,
  /** A bearer the fake refuses, optionally only on `rejectedPath`. */
  rejectedAuthorization: undefined as string | undefined,
  rejectedStatus: 403,
  /** The wire error code sent with a rejection, when a test needs one. */
  rejectedCode: undefined as string | undefined,
  rejectedPath: undefined as string | undefined,
  /** A refusal the host gives to a qualified pairing start instead of starting one. */
  pairingStartRefusal: undefined as
    { status: number; body: unknown; retryAfter?: string } | undefined,
  /** What the host says to `/me/host-access`; `undefined` models a host built before it (404). */
  hostAccessAnswer: undefined as { status: number; body: unknown } | undefined,
  /** What `/me/connection-access` reports: `archived` models a host hold. */
  accessLifecycle: 'active' as 'active' | 'archived',
  /** Frames the fake live stream sends after its snapshot, before it ends. */
  eventsTail: '',
  /** How the fake Community answers a self-revocation: a status, or drop the socket. */
  revocationAnswer: 204 as number | 'hang-up',
  /** How the fake Community answers a reply-count read, or 404 like a server from before it. */
  threadsAnswer: 'counts' as 'counts' | 404,
  /** When set, the fake Community holds every access re-check until this settles. */
  accessGate: undefined as Promise<void> | undefined,
  /** How many access re-checks reached the fake Community. */
  accessRequests: 0,
  /** How many requests reached the host a redirect points at (it must stay 0). */
  redirectedRequests: 0,
};

/** The encrypted local store's data directory for this test file. */
export const directory = await mkdtemp(join(tmpdir(), 'community-pairing-'));

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body =
    chunks.length && req.headers['content-type'] === 'application/json'
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
  requests.push({ path: req.url ?? '', body });
  if (req.url === `${qualified}/me/connection-access`) {
    fake.accessRequests += 1;
    if (fake.accessGate) await fake.accessGate;
  }
  res.setHeader('content-type', 'application/json');
  const send = (value: unknown, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  const nameLookup = /^\/api\/v1\/community-names\/([^/]+)$/.exec(req.url ?? '');
  if (nameLookup) {
    const answer = shortNameAnswers.get(nameLookup[1]);
    if (answer === 'rate-limited') {
      // The real Community answers a spent lookup budget this way (apps/space http.ts).
      res.setHeader('retry-after', '17');
      send({ code: 'RATE_LIMITED', message: 'Slow down.' }, 429);
    } else if (answer === 'redirect') {
      res.statusCode = 301;
      res.setHeader('location', `${redirectedOrigin}/api/v1/community-names/${nameLookup[1]}`);
      res.end();
    } else if (answer === undefined) {
      send({ code: 'NOT_FOUND', message: 'No community at this address.' }, 404);
    } else {
      res.setHeader('cache-control', 'no-store');
      send(answer);
    }
    return;
  }
  if (fake.redirect) {
    res.statusCode = 302;
    res.setHeader('location', `${redirectedOrigin}/private`);
    res.end();
    return;
  }
  if (
    fake.rejectedAuthorization &&
    req.headers.authorization === fake.rejectedAuthorization &&
    (!fake.rejectedPath || req.url === fake.rejectedPath)
  ) {
    send(
      fake.rejectedCode
        ? { code: fake.rejectedCode, message: 'Refused.' }
        : { error: 'Grant rejected' },
      fake.rejectedStatus
    );
    return;
  }
  const agentRemoval =
    req.method === 'DELETE' && req.url?.startsWith(`${qualified}/agents/`)
      ? decodeURIComponent(req.url.slice(`${qualified}/agents/`.length))
      : null;
  if (agentRemoval) {
    agentRemovals.push({ memberId: agentRemoval, authorization: req.headers.authorization });
    const answer = agentRemovalAnswers.get(agentRemoval) ?? 204;
    if (answer === 'hang-up') {
      req.socket.destroy();
      return;
    }
    if (answer === 204) {
      res.statusCode = 204;
      res.end();
      return;
    }
    // A 404 from something in front of the Community, not the Community's own answer.
    if (answer === 'bare-404') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    send(
      { code: answer === 404 ? 'NOT_FOUND' : 'INTERNAL', message: 'untrusted remote text' },
      answer
    );
    return;
  }
  if (req.method === 'DELETE' && req.url === `${qualified}/me/connection`) {
    revocations.push({ path: req.url, authorization: req.headers.authorization });
    if (fake.revocationAnswer === 'hang-up') {
      req.socket.destroy();
      return;
    }
    if (fake.revocationAnswer === 204) {
      res.statusCode = 204;
      res.end();
      return;
    }
    send({ code: 'UNAUTHENTICATED', message: 'untrusted remote text' }, fake.revocationAnswer);
    return;
  }
  if (req.url === `${secondQualified}/community`) {
    send({
      id: secondRemoteCommunityId,
      name: 'Second community',
      description: null,
      createdAt: new Date().toISOString(),
    });
    return;
  }
  if (req.url === `${secondQualified}/pairings/start`) {
    const pairingId = randomUUID();
    send(
      {
        pairingId,
        approvalUrl: `${origin}/c/${secondRemoteCommunityId}/pairing?pairingId=${pairingId}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      201
    );
    return;
  }
  if (req.url === '/api/v1/community' && fake.requireExplicitCommunity) {
    send({ code: 'COMMUNITY_SELECTION_REQUIRED', message: 'Choose a community.' }, 409);
  } else if (req.url === '/api/v1/community' || req.url === `${qualified}/community`) {
    send({
      id: remoteCommunityId,
      name: 'Test community',
      description: null,
      createdAt: new Date().toISOString(),
    });
  } else if (req.url === `${qualified}/pairings/start` && fake.pairingStartRefusal) {
    if (fake.pairingStartRefusal.retryAfter)
      res.setHeader('retry-after', fake.pairingStartRefusal.retryAfter);
    send(fake.pairingStartRefusal.body, fake.pairingStartRefusal.status);
  } else if (req.url === `${qualified}/pairings/start` && !fake.legacySingletonServer) {
    const pairingId = randomUUID();
    send(
      {
        pairingId,
        approvalUrl: `${origin}/c/${remoteCommunityId}/pairing?pairingId=${pairingId}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      201
    );
  } else if (req.url === `${qualified}/pairings/poll`) {
    fake.pollCount++;
    await fake.waitForPoll?.();
    send(fake.approved ? { status: 'approved', code: 'one-time-code' } : { status: 'pending' });
  } else if (req.url === `${qualified}/pairings/exchange`) {
    await fake.waitForExchange?.();
    send({
      token,
      grant: {
        id: randomUUID(),
        memberId: 'human-id',
        installName: 'Test install',
        scopes: ['read', 'post', 'enroll-agent'],
        lifecycle: 'active',
        capabilities: { read: true, post: true, enrollAgent: true, stream: true },
        createdAt: new Date().toISOString(),
      },
    });
  } else if (req.url === `${qualified}/pairings/cancel`) {
    fake.cancelled = true;
    res.statusCode = 204;
    res.end();
  } else if (req.url === `${qualified}/me/connection-access`) {
    const live = fake.accessLifecycle === 'active';
    const capabilities = { read: true, post: live, enrollAgent: live, stream: live };
    send({
      access: {
        state: 'verified',
        effective: capabilities,
        lastKnown: {
          lifecycle: fake.accessLifecycle,
          capabilities,
          verifiedAt: new Date().toISOString(),
        },
      },
    });
  } else if (req.url === `${qualified}/me/host-access` && fake.hostAccessAnswer) {
    if (req.headers.authorization !== `Bearer ${token}`) {
      send({ error: 'Unauthorized' }, 401);
      return;
    }
    send(fake.hostAccessAnswer.body, fake.hostAccessAnswer.status);
  } else if (req.url === `${qualified}/attention`) {
    if (req.headers.authorization !== `Bearer ${token}`) {
      send({ error: 'Unauthorized' }, 401);
      return;
    }
    send({ unreadCount: 7, mentionCount: 2 });
  } else if (req.url === `${qualified}/channels`) {
    send({
      channels: [
        {
          id: remoteRoomId,
          name: 'General',
          description: null,
          visibility: 'public',
          archived: false,
          createdAt: new Date().toISOString(),
          joined: true,
          unreadCount: 0,
        },
      ],
    });
  } else if (req.url === `${qualified}/channels/${remoteRoomId}/entries`) {
    send({
      entries: [
        {
          id: 'entry-1',
          channelId: remoteRoomId,
          seq: 1,
          authorMemberId: remoteAgentId,
          authorDisplayName: 'Test Agent',
          authorKind: 'agent',
          originIdempotencyKey: 'owner-wire-key',
          text: 'hello',
          mentions: [],
          parentEntryId: null,
          threadRootEntryId: null,
          createdAt: new Date().toISOString(),
          cursor: 'resume-1',
          attachments: [
            {
              id: remoteAttachmentId,
              name: 'shot.png',
              contentType: 'image/png',
              byteSize: 5,
              checksum: 'checksum-1',
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ],
      nextCursor: null,
    });
  } else if (req.url === `${qualified}/channels/${remoteRoomId}/threads?roots=entry-1`) {
    if (fake.threadsAnswer === 404) send({ code: 'NOT_FOUND', message: 'Not found.' }, 404);
    else
      send({
        threads: [
          {
            rootEntryId: 'entry-1',
            replyCount: 3,
            lastReplyAt: '2026-09-23T12:05:00.000Z',
            lastReplySeq: 9,
          },
        ],
      });
  } else if (req.url === `${qualified}/channels/${remoteRoomId}/read-cursor`) {
    send({ cursor: 'resume-1', unreadCount: 0 });
  } else if (
    req.url === `${qualified}/channels/${remoteRoomId}/attachments` &&
    req.method === 'POST'
  ) {
    send(
      {
        attachment: {
          id: remoteAttachmentId,
          name: decodeURIComponent(String(req.headers['x-file-name'])),
          contentType: req.headers['content-type'],
          byteSize: Number(req.headers['x-file-size']),
          checksum: 'checksum-upload',
          createdAt: new Date().toISOString(),
        },
      },
      201
    );
  } else if (req.url === `${qualified}/attachments/${remoteAttachmentId}`) {
    res.setHeader('content-type', 'application/octet-stream');
    res.end('hello');
  } else if (req.url === `${qualified}/channels/${remoteRoomId}/events`) {
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      `data: ${JSON.stringify({
        type: 'snapshot',
        channel: {
          id: remoteRoomId,
          name: 'General',
          description: null,
          visibility: 'public',
          archived: false,
          createdAt: new Date().toISOString(),
          joined: true,
          unreadCount: 0,
        },
        entries: [],
        capturedSeq: 0,
        cursor: 'resume-1',
      })}\n\n${fake.eventsTail}`
    );
  } else if (req.url === `${qualified}/agents`) {
    send(
      {
        token: 'private-agent-token',
        agent: {
          memberId: remoteAgentId,
          displayName: 'Test Agent',
          handle: 'test-agent',
          ownerMemberId: 'human-id',
          active: true,
        },
      },
      201
    );
  } else send({}, 404);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No HTTP test port');
/** The fake Community's origin. */
export const origin = `http://127.0.0.1:${address.port}`;

const redirectedServer = createServer((_req, res) => {
  fake.redirectedRequests++;
  res.end('unexpected');
});
await new Promise<void>((resolve) => redirectedServer.listen(0, '127.0.0.1', resolve));
const redirectedAddress = redirectedServer.address();
if (!redirectedAddress || typeof redirectedAddress === 'string')
  throw new Error('No redirect test port');
/** Another host a redirect points at; nothing should ever reach it. */
export const redirectedOrigin = `http://127.0.0.1:${redirectedAddress.port}`;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => redirectedServer.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
