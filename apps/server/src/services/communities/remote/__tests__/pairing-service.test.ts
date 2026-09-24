import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
  RemoteConnectionNotFoundError,
} from '../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../core/credential-provider.js';
import {
  RemoteCommunityPairingService,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
  RemotePairingBusyError,
  COMMUNITY_ACCESS_BUDGET_MS,
} from '../pairing-service.js';
import {
  RemoteCommunityAdapter,
  remoteOriginIdempotencyKeyOf,
  remoteThreadReplySeqOf,
  type RemoteNativeRoomEvent,
} from '../remote-community-adapter.js';
import {
  checkedAddress,
  communityApiPath,
  parseCommunityLink,
  parseCommunityOrigin,
  pinnedJson,
  PinnedHttpError,
  PinnedOriginError,
} from '../pinned-origin.js';
import {
  READ_ONLY_RECHECK_MS,
  RemoteRoomSubscriptionRuntime,
} from '../remote-room-subscription-runtime.js';

let server: Server;
let redirectedServer: Server;
let origin: string;
let redirectedOrigin: string;
let redirectedRequests = 0;
let directory: string;
let approved = false;
let cancelled = false;
let redirect = false;
let requireExplicitCommunity = false;
let legacySingletonServer = false;
let pollCount = 0;
let waitForPoll: (() => Promise<void>) | undefined;
let waitForExchange: (() => Promise<void>) | undefined;
let rejectedAuthorization: string | undefined;
let rejectedStatus = 403;
let rejectedPath: string | undefined;
/** What the host says to `/me/host-access`; `undefined` models a host built before it (404). */
let hostAccessAnswer: { status: number; body: unknown } | undefined;
/** What `/me/connection-access` reports: `archived` models a host hold, as installations see it. */
let accessLifecycle: 'active' | 'archived' = 'active';
const token = 'private-pairing-bearer-should-never-appear-in-dto';
const remoteCommunityId = randomUUID();
const secondRemoteCommunityId = randomUUID();
const remoteAgentId = randomUUID();
const remoteRoomId = randomUUID();
const remoteAttachmentId = randomUUID();
const qualified = `/api/v1/communities/${remoteCommunityId}`;
const secondQualified = `/api/v1/communities/${secondRemoteCommunityId}`;
const requests: Array<{ path: string; body: Record<string, string> }> = [];
/** Every self-revocation the fake Community received, with the bearer that sent it. */
const revocations: Array<{ path: string; authorization: string | undefined }> = [];
/** How the fake Community answers a self-revocation: a status, or drop the socket. */
let revocationAnswer: number | 'hang-up' = 204;
/** How the fake Community answers a reply-count read: counts, or 404 like a server from before the route. */
let threadsAnswer: 'counts' | 404 = 'counts';
/** When set, the fake Community holds every access re-check until this settles. */
let accessGate: Promise<void> | undefined;
/** How many access re-checks reached the fake Community. */
let accessRequests = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-pairing-'));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body =
      chunks.length && req.headers['content-type'] === 'application/json'
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
    requests.push({ path: req.url ?? '', body });
    if (req.url === `${qualified}/me/connection-access`) {
      accessRequests += 1;
      if (accessGate) await accessGate;
    }
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (redirect) {
      res.statusCode = 302;
      res.setHeader('location', `${redirectedOrigin}/private`);
      res.end();
      return;
    }
    if (
      rejectedAuthorization &&
      req.headers.authorization === rejectedAuthorization &&
      (!rejectedPath || req.url === rejectedPath)
    ) {
      send({ error: 'Grant rejected' }, rejectedStatus);
      return;
    }
    if (req.method === 'DELETE' && req.url === `${qualified}/me/connection`) {
      revocations.push({ path: req.url, authorization: req.headers.authorization });
      if (revocationAnswer === 'hang-up') {
        req.socket.destroy();
        return;
      }
      if (revocationAnswer === 204) {
        res.statusCode = 204;
        res.end();
        return;
      }
      send({ code: 'UNAUTHENTICATED', message: 'untrusted remote text' }, revocationAnswer);
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
    if (req.url === '/api/v1/community' && requireExplicitCommunity) {
      send({ code: 'COMMUNITY_SELECTION_REQUIRED', message: 'Choose a community.' }, 409);
    } else if (req.url === '/api/v1/community' || req.url === `${qualified}/community`) {
      send({
        id: remoteCommunityId,
        name: 'Test community',
        description: null,
        createdAt: new Date().toISOString(),
      });
    } else if (req.url === `${qualified}/pairings/start` && !legacySingletonServer) {
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
      pollCount++;
      await waitForPoll?.();
      send(approved ? { status: 'approved', code: 'one-time-code' } : { status: 'pending' });
    } else if (req.url === `${qualified}/pairings/exchange`) {
      await waitForExchange?.();
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
      cancelled = true;
      res.statusCode = 204;
      res.end();
    } else if (req.url === `${qualified}/me/connection-access`) {
      const live = accessLifecycle === 'active';
      const capabilities = { read: true, post: live, enrollAgent: live, stream: live };
      send({
        access: {
          state: 'verified',
          effective: capabilities,
          lastKnown: {
            lifecycle: accessLifecycle,
            capabilities,
            verifiedAt: new Date().toISOString(),
          },
        },
      });
    } else if (req.url === `${qualified}/me/host-access` && hostAccessAnswer) {
      if (req.headers.authorization !== `Bearer ${token}`) {
        send({ error: 'Unauthorized' }, 401);
        return;
      }
      send(hostAccessAnswer.body, hostAccessAnswer.status);
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
      if (threadsAnswer === 404) send({ code: 'NOT_FOUND', message: 'Not found.' }, 404);
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
        })}\n\n`
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
  origin = `http://127.0.0.1:${address.port}`;
  redirectedServer = createServer((_req, res) => {
    redirectedRequests++;
    res.end('unexpected');
  });
  await new Promise<void>((resolve) => redirectedServer.listen(0, '127.0.0.1', resolve));
  const redirectedAddress = redirectedServer.address();
  if (!redirectedAddress || typeof redirectedAddress === 'string')
    throw new Error('No redirect test port');
  redirectedOrigin = `http://127.0.0.1:${redirectedAddress.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => redirectedServer.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  it('creates distinct local connections for two canonical tenants at one origin', async () => {
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const first = await service.start(
      'same-origin-owner',
      `${origin}/c/${remoteCommunityId}`,
      'First install'
    );
    const second = await service.start(
      'same-origin-owner',
      `${origin}/c/${secondRemoteCommunityId}`,
      'Second install'
    );
    expect(first.connection).toMatchObject({
      remoteCommunityId,
      pinnedOrigin: origin,
      label: 'Test community',
    });
    expect(second.connection).toMatchObject({
      remoteCommunityId: secondRemoteCommunityId,
      pinnedOrigin: origin,
      label: 'Second community',
    });
    expect(first.connection.ref).not.toBe(second.connection.ref);
  });

  it('requires a canonical tenant link when singleton discovery is ambiguous', async () => {
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    requireExplicitCommunity = true;
    try {
      await expect(
        service.start('multi-owner', origin, 'Ambiguous install')
      ).rejects.toBeInstanceOf(RemoteCommunitySelectionRequiredError);
      await expect(
        service.start('multi-owner', `${origin}/c/${remoteCommunityId}`, 'Selected install')
      ).resolves.toMatchObject({ connection: { remoteCommunityId } });
    } finally {
      requireExplicitCommunity = false;
    }
  });

  it('requires an upgraded server after authoritative singleton discovery', async () => {
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    legacySingletonServer = true;
    try {
      await expect(service.start('legacy-owner', origin, 'Legacy install')).rejects.toBeInstanceOf(
        RemoteCommunityUpgradeRequiredError
      );
      await expect(
        service.start('legacy-owner', `${origin}/c/${remoteCommunityId}`, 'Invalid canonical link')
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      legacySingletonServer = false;
    }
  });

  it('closes a quiet generic room subscription without requiring a caller abort', async () => {
    const adapter = new RemoteCommunityAdapter(
      'remote-generic-return' as never,
      'adapter-owner',
      new RemoteConnectionStore(directory)
    );
    let unblock: ((result: IteratorResult<RemoteNativeRoomEvent>) => void) | undefined;
    let nativeReturned = false;
    vi.spyOn(adapter, 'subscribeNativeRoom').mockImplementation(() => ({
      [Symbol.asyncIterator](): AsyncIterator<RemoteNativeRoomEvent> {
        let sentSnapshot = false;
        return {
          next: () => {
            if (!sentSnapshot) {
              sentSnapshot = true;
              return Promise.resolve({
                done: false,
                value: {
                  type: 'snapshot',
                  room: {
                    community: adapter.community,
                    roomId: 'quiet-room',
                    kind: 'channel',
                    title: 'Quiet room',
                    slug: null,
                    topic: null,
                    archived: false,
                    createdAt: new Date(0).toISOString(),
                    lastActivityAt: new Date(0).toISOString(),
                    unreadCount: 0,
                  },
                  entries: [],
                  cursor: 'quiet-cursor' as never,
                  capturedSeq: 0,
                },
              });
            }
            return new Promise<IteratorResult<RemoteNativeRoomEvent>>((resolve) => {
              unblock = resolve;
            });
          },
          return: async () => {
            nativeReturned = true;
            unblock?.({ done: true, value: undefined as never });
            return { done: true, value: undefined as never };
          },
        };
      },
    }));

    const iterator = adapter.subscribeRoom('quiet-room')[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('snapshot');
    const pending = iterator.next();

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(nativeReturned).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it('uses the private store for a live HTTP adapter and rejects an unowned agent before a request', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const requestStart = requests.length;
    const started = await service.start(
      'adapter-owner',
      `${origin}/c/${remoteCommunityId}`,
      'Adapter test'
    );
    expect((await service.poll(started.connection.ref, 'adapter-owner')).status).toBe('connected');
    expect(await service.status(started.connection.ref, 'adapter-owner')).toMatchObject({
      status: 'connected',
      access: {
        state: 'verified',
        effective: { read: true, post: true, enrollAgent: true, stream: true },
      },
    });
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'adapter-owner', store);
    expect((await adapter.connect()).status).toBe('connected');
    expect(await adapter.attention()).toEqual({ unreadCount: 7, mentionCount: 2 });
    expect((await adapter.listRooms()).map((item) => item.roomId)).toEqual([remoteRoomId]);
    const history = await adapter.listEntries(remoteRoomId);
    expect(history.entries).toHaveLength(1);
    expect(remoteOriginIdempotencyKeyOf(history.entries[0]!)).toBe('owner-wire-key');
    expect(history.entries[0]!.attachments).toEqual([
      {
        id: remoteAttachmentId,
        name: 'shot.png',
        contentType: 'image/png',
        byteSize: 5,
        checksum: 'checksum-1',
      },
    ]);
    // The port's own read carries no counts; the browser's read asks for them.
    expect(history.entries[0]!.thread).toBeUndefined();
    const browserHistory = await adapter.listEntriesWithThreadRoot(remoteRoomId);
    expect(browserHistory.entries[0]!.thread).toEqual({
      replyCount: 3,
      lastReplyAt: '2026-09-23T12:05:00.000Z',
    });
    expect(remoteThreadReplySeqOf(browserHistory.entries[0]!)).toBe(9);
    // A server from before the route costs the counts and never the history.
    threadsAnswer = 404;
    const olderServer = await adapter.listEntriesWithThreadRoot(remoteRoomId);
    threadsAnswer = 'counts';
    expect(olderServer.entries.map((item) => item.id)).toEqual(['entry-1']);
    expect(olderServer.entries[0]!.thread).toBeUndefined();
    expect(remoteThreadReplySeqOf(olderServer.entries[0]!)).toBeUndefined();
    expect(await adapter.getReadCursor(remoteRoomId)).toBe('resume-1');
    await adapter.setReadCursor(remoteRoomId, 'resume-1' as never);
    const upload = await adapter.uploadAttachment(remoteRoomId, {
      idempotencyKey: 'qualified-upload',
      name: 'proof.txt',
      contentType: 'text/plain',
      byteSize: 5,
      bytes: (async function* () {
        yield new TextEncoder().encode('hello');
      })(),
    });
    expect(upload.id).toBe(remoteAttachmentId);
    const download = await adapter.downloadAttachment(remoteRoomId, remoteAttachmentId);
    const downloaded: Uint8Array[] = [];
    for await (const chunk of download.bytes) downloaded.push(chunk);
    expect(Buffer.concat(downloaded).toString()).toBe('hello');
    const stream = adapter.subscribeNativeRoom(remoteRoomId)[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'snapshot', room: { roomId: remoteRoomId } },
    });
    await stream.return?.();
    const agent = await adapter.admitAgent({ agentId: randomUUID(), displayName: 'Test Agent' });
    expect(agent.memberId).toBe(remoteAgentId);
    expect(requests.slice(requestStart).map((request) => request.path)).toEqual(
      expect.arrayContaining([
        `${qualified}/community`,
        `${qualified}/channels`,
        `${qualified}/channels/${remoteRoomId}/entries`,
        `${qualified}/channels/${remoteRoomId}/events`,
        `${qualified}/channels/${remoteRoomId}/attachments`,
        `${qualified}/attachments/${remoteAttachmentId}`,
      ])
    );
    expect(
      requests
        .slice(requestStart)
        .filter((request) => request.path.startsWith('/api/v1/'))
        .every((request) => request.path.startsWith(qualified))
    ).toBe(true);
    await expect(adapter.listRooms({ actingMemberId: randomUUID() })).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    const metadata = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(metadata).not.toContain('private-agent-token');
    await service.disconnect(started.connection.ref, 'adapter-owner');
    approved = false;
    pollCount = 0;
  });

  it('retains last-known access through an outage and fails closed after grant rejection', async () => {
    approved = true;
    const owner = 'access-owner';
    const store = new RemoteConnectionStore(directory);
    const revokeConnection = vi.fn(async () => undefined);
    const accessAuthorityChanged = vi.fn();
    const service = new RemoteCommunityPairingService(
      store,
      revokeConnection,
      accessAuthorityChanged
    );
    const started = await service.start(owner, `${origin}/c/${remoteCommunityId}`, 'Access test');
    const connected = await service.poll(started.connection.ref, owner);
    expect(connected.connection?.access).toMatchObject({ state: 'verified' });

    try {
      rejectedAuthorization = `Bearer ${token}`;
      rejectedPath = `${qualified}/me/connection-access`;
      rejectedStatus = 503;
      const unavailable = await service.status(started.connection.ref, owner);
      expect(unavailable.access).toMatchObject({
        state: 'unverified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: connected.connection?.access?.lastKnown,
      });
      expect(accessAuthorityChanged).toHaveBeenCalledOnce();

      rejectedAuthorization = undefined;
      rejectedPath = undefined;
      await expect(service.status(started.connection.ref, owner)).resolves.toMatchObject({
        access: { state: 'verified' },
      });
      expect(accessAuthorityChanged).toHaveBeenCalledTimes(2);
      await service.status(started.connection.ref, owner);
      expect(accessAuthorityChanged).toHaveBeenCalledTimes(2);

      rejectedAuthorization = `Bearer ${token}`;
      rejectedPath = `${qualified}/me/connection-access`;
      rejectedStatus = 401;
      const rejected = await service.status(started.connection.ref, owner);
      expect(rejected).toMatchObject({
        status: 'reconnect-required',
        access: {
          state: 'reconnect-required',
          effective: { read: false, post: false, enrollAgent: false, stream: false },
        },
      });
      expect(revokeConnection).toHaveBeenCalledWith(started.connection.ref, owner);
      await expect(store.personalToken(started.connection.ref, owner)).rejects.toBeInstanceOf(
        RemoteConnectionAuthorizationError
      );
    } finally {
      await service.disconnect(started.connection.ref, owner);
      rejectedAuthorization = undefined;
      rejectedPath = undefined;
      rejectedStatus = 403;
    }
  });
  it('carries the host’s operator answer only while the connection is verified', async () => {
    approved = true;
    const owner = 'host-operator-owner';
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(
      store,
      vi.fn(async () => undefined)
    );
    const started = await service.start(owner, `${origin}/c/${remoteCommunityId}`, 'Host test');
    const { ref } = started.connection;
    await service.poll(ref, owner);
    const hostRequests = () =>
      requests.filter((request) => request.path === `${qualified}/me/host-access`).length;

    try {
      // A host built before the read exists answers 404: still a working
      // connection, just no offer.
      hostAccessAnswer = undefined;
      const before = hostRequests();
      const older = await service.status(ref, owner);
      expect(older.access).toMatchObject({ state: 'verified' });
      expect(older).not.toHaveProperty('hostOperator');
      expect(hostRequests()).toBe(before + 1);

      hostAccessAnswer = { status: 200, body: { hostOperator: true } };
      expect(await service.status(ref, owner)).toMatchObject({ hostOperator: true });
      expect(await service.list(owner)).toEqual([
        expect.objectContaining({ ref, hostOperator: true }),
      ]);

      hostAccessAnswer = { status: 200, body: { hostOperator: false } };
      expect(await service.status(ref, owner)).not.toHaveProperty('hostOperator');

      // Anything the app cannot read as a clear yes is a no, and never costs
      // the connection its verified access.
      for (const answer of [
        { status: 200, body: { hostOperator: 'yes' } },
        { status: 200, body: { hostOperator: true, extra: true } },
        { status: 500, body: { hostOperator: true } },
      ]) {
        hostAccessAnswer = answer;
        const read = await service.status(ref, owner);
        expect(read.access).toMatchObject({ state: 'verified' });
        expect(read).not.toHaveProperty('hostOperator');
      }

      // An offline host keeps the last answer on disk but offers nothing.
      hostAccessAnswer = { status: 200, body: { hostOperator: true } };
      expect(await service.status(ref, owner)).toMatchObject({ hostOperator: true });
      rejectedAuthorization = `Bearer ${token}`;
      rejectedPath = `${qualified}/me/connection-access`;
      rejectedStatus = 503;
      const offline = await service.status(ref, owner);
      expect(offline.access).toMatchObject({ state: 'unverified' });
      expect(offline).not.toHaveProperty('hostOperator');

      // A rejected grant ends the offer with the connection.
      rejectedStatus = 401;
      const rejected = await service.status(ref, owner);
      expect(rejected.status).toBe('reconnect-required');
      expect(rejected).not.toHaveProperty('hostOperator');
    } finally {
      await service.disconnect(ref, owner);
      hostAccessAnswer = undefined;
      rejectedAuthorization = undefined;
      rejectedPath = undefined;
      rejectedStatus = 403;
    }
  });

  describe('list re-checks access within a budget', () => {
    let release: () => void = () => undefined;
    function holdAccess(): void {
      accessGate = new Promise<void>((resolve) => (release = resolve));
    }
    async function connect(
      owner: string,
      timing: ConstructorParameters<typeof RemoteCommunityPairingService>[3] = { budgetMs: 100 }
    ) {
      approved = true;
      const accessAuthorityChanged = vi.fn();
      const service = new RemoteCommunityPairingService(
        new RemoteConnectionStore(directory),
        undefined,
        accessAuthorityChanged,
        timing
      );
      const started = await service.start(owner, `${origin}/c/${remoteCommunityId}`, 'Budget');
      const connected = await service.poll(started.connection.ref, owner);
      expect(connected.connection?.access?.state).toBe('verified');
      accessAuthorityChanged.mockClear();
      return {
        service,
        ref: started.connection.ref,
        lastKnown: connected.connection!.access!.lastKnown,
        accessAuthorityChanged,
      };
    }
    afterEach(() => {
      release();
      accessGate = undefined;
      rejectedAuthorization = undefined;
      rejectedPath = undefined;
      rejectedStatus = 403;
      approved = false;
      pollCount = 0;
    });

    it('reports a hanging Community as offline within the real budget, never as revoked', async () => {
      const { service, ref, lastKnown, accessAuthorityChanged } = await connect('budget-real', {});
      try {
        holdAccess();
        const started = performance.now();
        const [listed] = await service.list('budget-real');
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(COMMUNITY_ACCESS_BUDGET_MS + 500);
        expect(listed).toMatchObject({
          ref,
          status: 'connected',
          access: {
            state: 'unverified',
            effective: { read: false, post: false, enrollAgent: false, stream: false },
            lastKnown,
          },
        });
        // Only reported: nothing stored, nothing told to reconcile authority.
        expect(accessAuthorityChanged).not.toHaveBeenCalled();
      } finally {
        release();
        await service.disconnect(ref, 'budget-real');
      }
    });

    it('never downgrades to reconnect-required on a timeout, but a late refusal still does', async () => {
      const { service, ref } = await connect('budget-refused');
      try {
        holdAccess();
        rejectedAuthorization = `Bearer ${token}`;
        rejectedPath = `${qualified}/me/connection-access`;
        rejectedStatus = 401;
        const [waiting] = await service.list('budget-refused');
        expect(waiting).toMatchObject({ status: 'connected', access: { state: 'unverified' } });
        release();
        // status() joins the re-check the list left running.
        await expect(service.status(ref, 'budget-refused')).resolves.toMatchObject({
          status: 'reconnect-required',
        });
        const [after] = await service.list('budget-refused');
        expect(after).toMatchObject({
          status: 'reconnect-required',
          access: { state: 'reconnect-required' },
        });
      } finally {
        release();
        await service.disconnect(ref, 'budget-refused');
      }
    });

    it('shares one re-check between concurrent reads and serves its late answer next', async () => {
      let clock = 1_000_000;
      const { service, ref, accessAuthorityChanged } = await connect('budget-shared', {
        budgetMs: 100,
        freshMs: 90_000,
        now: () => clock,
      });
      try {
        holdAccess();
        const before = accessRequests;
        const reads = await Promise.all([
          service.list('budget-shared'),
          service.list('budget-shared'),
          service.list('budget-shared'),
        ]);
        for (const [item] of reads) expect(item?.access?.state).toBe('unverified');
        expect(accessRequests - before).toBe(1);

        release();
        await expect(service.status(ref, 'budget-shared')).resolves.toMatchObject({
          access: { state: 'verified' },
        });
        expect(accessRequests - before).toBe(1);

        // The Community is slow again, but it answered moments ago: the next
        // read keeps that answer instead of flickering offline.
        holdAccess();
        const [picked] = await service.list('budget-shared');
        expect(picked?.access).toMatchObject({
          state: 'verified',
          effective: { read: true, post: true, enrollAgent: true, stream: true },
        });
        release();
        await service.status(ref, 'budget-shared');

        // Once that answer is old, a Community that stops answering is offline.
        clock += 90_001;
        holdAccess();
        const [aged] = await service.list('budget-shared');
        expect(aged?.access?.state).toBe('unverified');
        expect(accessAuthorityChanged).not.toHaveBeenCalled();
      } finally {
        release();
        await service.disconnect(ref, 'budget-shared');
      }
    });
  });

  it('persists a reconnect-required state when the remote rejects the personal grant', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('revoked-owner', origin, 'Revoked install');
    expect((await service.poll(started.connection.ref, 'revoked-owner')).status).toBe('connected');
    const revokeConnection = vi.fn(async () => undefined);
    const adapter = new RemoteCommunityAdapter(
      started.connection.ref,
      'revoked-owner',
      store,
      undefined,
      revokeConnection
    );
    rejectedAuthorization = `Bearer ${token}`;
    rejectedStatus = 401;
    try {
      await expect(adapter.listRooms()).rejects.toMatchObject({
        name: 'RemoteConnectionAuthorizationError',
      });
      expect(await store.list('revoked-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'reconnect-required' }),
      ]);
      await expect(
        store.personalToken(started.connection.ref, 'revoked-owner')
      ).rejects.toMatchObject({ name: 'RemoteConnectionAuthorizationError' });
      expect(
        await new EncryptedFileCredentialStore(directory).get(
          `community:${started.connection.ref}:personal`
        )
      ).toBeNull();
      expect(revokeConnection).toHaveBeenCalledWith(started.connection.ref, 'revoked-owner');
      await expect(service.poll(started.connection.ref, 'revoked-owner')).rejects.toBeInstanceOf(
        RemoteConnectionAuthorizationError
      );
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'revoked-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('learns a released hold for a member-only connection through the release check (AC-8)', async () => {
    // Purpose: fails if the five-minute check does not reach the real pairing service and
    // store, so a member-only connection kept its read-only access after the host released.
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const owner = 'release-check-owner';
    const started = await service.start(owner, origin, 'Member-only install');
    expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
    approved = false;
    const lifecycle = async () =>
      (await store.list(owner)).find((row) => row.ref === started.connection.ref)?.access?.lastKnown
        ?.lifecycle;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge: {} as never,
      enrollments: { activeConnections: () => [] } as never,
      adapters: vi.fn(),
      resolveConnectionAccess: async (ref, ownerKey) =>
        (await service.status(ref, ownerKey)).access,
      readOnlyConnections: () => store.readOnlyConnections(),
      resolveLocalAgentAuthor: () => null,
      isReady: () => false,
    });
    try {
      accessLifecycle = 'archived';
      await service.status(started.connection.ref, owner);
      expect(await lifecycle()).toBe('archived');
      runtime.start();
      // The host releases the hold; nobody opens the connection's status.
      accessLifecycle = 'active';
      await vi.advanceTimersByTimeAsync(READ_ONLY_RECHECK_MS - 1);
      expect(await lifecycle()).toBe('archived');
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => expect(await lifecycle()).toBe('active'));
      expect(
        (await store.list(owner)).find((row) => row.ref === started.connection.ref)?.access
      ).toMatchObject({ state: 'verified', effective: { post: true, stream: true } });
    } finally {
      runtime.stop();
      vi.useRealTimers();
      accessLifecycle = 'active';
      await service.disconnect(started.connection.ref, owner);
    }
  });

  describe('disconnect revokes the grant on the Community', () => {
    async function connected(owner: string) {
      approved = true;
      const store = new RemoteConnectionStore(directory);
      const service = new RemoteCommunityPairingService(store);
      const started = await service.start(owner, origin, 'Disconnecting install');
      expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
      approved = false;
      revocations.length = 0;
      return { store, service, ref: started.connection.ref };
    }

    async function expectLocalCopyGone(store: RemoteConnectionStore, ref: string, owner: string) {
      expect(await store.list(owner)).toEqual([]);
      expect(
        await new EncryptedFileCredentialStore(directory).get(`community:${ref}:personal`)
      ).toBeNull();
    }

    afterEach(() => {
      revocationAnswer = 204;
      revocations.length = 0;
    });

    it('revokes with its own bearer at the qualified path before deleting the local copy', async () => {
      const { store, service, ref } = await connected('disconnect-owner');
      expect(await service.disconnect(ref, 'disconnect-owner')).toEqual({ remoteRevoked: true });
      expect(revocations).toEqual([
        { path: `${qualified}/me/connection`, authorization: `Bearer ${token}` },
      ]);
      await expectLocalCopyGone(store, ref, 'disconnect-owner');
    });

    it('counts a grant the Community already refuses as revoked', async () => {
      const { store, service, ref } = await connected('already-revoked-owner');
      revocationAnswer = 401;
      expect(await service.disconnect(ref, 'already-revoked-owner')).toEqual({
        remoteRevoked: true,
      });
      expect(revocations).toHaveLength(1);
      await expectLocalCopyGone(store, ref, 'already-revoked-owner');
    });

    it.each([
      ['unreachable', 'hang-up' as const],
      ['failing', 500],
      ['older and without the route', 404],
      ['refusing', 403],
    ])(
      'still deletes the local copy and reports it when the Community is %s',
      async (_label, answer) => {
        const { store, service, ref } = await connected('unreachable-owner');
        revocationAnswer = answer;
        expect(await service.disconnect(ref, 'unreachable-owner')).toEqual({
          remoteRevoked: false,
        });
        expect(revocations).toHaveLength(1);
        await expectLocalCopyGone(store, ref, 'unreachable-owner');
      }
    );

    it('keeps only the closed-enum code of a refusal, never its text', async () => {
      revocationAnswer = 403;
      const error = await pinnedJson(
        new URL(origin),
        `${qualified}/me/connection`,
        undefined,
        undefined,
        { method: 'DELETE', accept: [204] }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PinnedHttpError);
      expect(error).toMatchObject({ status: 403, remoteCode: 'UNAUTHENTICATED' });
      expect(
        JSON.stringify({ ...(error as object), message: (error as Error).message })
      ).not.toContain('untrusted remote text');
      const unknown = await pinnedJson(new URL(origin), `${qualified}/no-such-route`).catch(
        (caught: unknown) => caught
      );
      expect(unknown).toMatchObject({ status: 404, remoteCode: undefined });
    });

    it('still revokes a reconnect-required connection whose bearer is stored', async () => {
      // A grant refused for a missing scope can still be live on the Community.
      const { store, service, ref } = await connected('reconnect-owner');
      const file = join(directory, 'communities', 'remote', 'connections.json');
      const records = JSON.parse(await readFile(file, 'utf8')) as Array<{
        ref: string;
        status: string;
      }>;
      records.find((record) => record.ref === ref)!.status = 'reconnect-required';
      await writeFile(file, JSON.stringify(records));
      expect(await service.disconnect(ref, 'reconnect-owner')).toEqual({ remoteRevoked: true });
      expect(revocations).toEqual([
        { path: `${qualified}/me/connection`, authorization: `Bearer ${token}` },
      ]);
      await expectLocalCopyGone(store, ref, 'reconnect-owner');
    });

    it('reports a failed revoke of a reconnect-required grant as unconfirmed', async () => {
      const { store, service, ref } = await connected('reconnect-offline-owner');
      const file = join(directory, 'communities', 'remote', 'connections.json');
      const records = JSON.parse(await readFile(file, 'utf8')) as Array<{
        ref: string;
        status: string;
      }>;
      records.find((record) => record.ref === ref)!.status = 'reconnect-required';
      await writeFile(file, JSON.stringify(records));
      revocationAnswer = 'hang-up';
      expect(await service.disconnect(ref, 'reconnect-offline-owner')).toEqual({
        remoteRevoked: false,
      });
      expect(revocations).toHaveLength(1);
      await expectLocalCopyGone(store, ref, 'reconnect-offline-owner');
    });

    it('makes no call once a rejected grant has already dropped its bearer', async () => {
      const { store, service, ref } = await connected('dropped-bearer-owner');
      await store.requireReconnect(ref, 'dropped-bearer-owner');
      expect(await service.disconnect(ref, 'dropped-bearer-owner')).toEqual({
        remoteRevoked: true,
      });
      expect(revocations).toEqual([]);
      await expectLocalCopyGone(store, ref, 'dropped-bearer-owner');
    });

    it('reports a connected record that lost its bearer as unconfirmed', async () => {
      const { store, service, ref } = await connected('lost-bearer-owner');
      await new EncryptedFileCredentialStore(directory).delete(`community:${ref}:personal`);
      expect(await service.disconnect(ref, 'lost-bearer-owner')).toEqual({ remoteRevoked: false });
      expect(revocations).toEqual([]);
      await expectLocalCopyGone(store, ref, 'lost-bearer-owner');
    });

    it('does not call the Community for a pending request, which has no grant', async () => {
      approved = false;
      const store = new RemoteConnectionStore(directory);
      const service = new RemoteCommunityPairingService(store);
      const started = await service.start('pending-disconnect-owner', origin, 'Pending install');
      revocations.length = 0;
      expect(await service.disconnect(started.connection.ref, 'pending-disconnect-owner')).toEqual({
        remoteRevoked: true,
      });
      expect(revocations).toEqual([]);
      expect(await store.list('pending-disconnect-owner')).toEqual([]);
    });
  });

  it('fences local authority even when reconnect persistence fails', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('recovery-owner', origin, 'Recovery install');
    expect((await service.poll(started.connection.ref, 'recovery-owner')).status).toBe('connected');
    const revokeConnection = vi.fn(async () => undefined);
    const adapter = new RemoteCommunityAdapter(
      started.connection.ref,
      'recovery-owner',
      store,
      undefined,
      revokeConnection
    );
    const persistenceFailure = new Error('simulated credential persistence failure');
    vi.spyOn(store, 'requireReconnect').mockRejectedValueOnce(persistenceFailure);
    rejectedAuthorization = `Bearer ${token}`;
    rejectedStatus = 401;
    try {
      await expect(adapter.listRooms()).rejects.toBe(persistenceFailure);
      expect(revokeConnection).toHaveBeenCalledWith(started.connection.ref, 'recovery-owner');
      expect(await store.personalToken(started.connection.ref, 'recovery-owner')).toBe(token);
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'recovery-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('still clears rejected credentials when local authority cleanup fails', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('cleanup-owner', origin, 'Cleanup install');
    expect((await service.poll(started.connection.ref, 'cleanup-owner')).status).toBe('connected');
    const cleanupFailure = new Error('simulated local cleanup failure');
    const adapter = new RemoteCommunityAdapter(
      started.connection.ref,
      'cleanup-owner',
      store,
      undefined,
      vi.fn(() => Promise.reject(cleanupFailure))
    );
    rejectedAuthorization = `Bearer ${token}`;
    rejectedStatus = 401;
    try {
      await expect(adapter.listRooms()).rejects.toBe(cleanupFailure);
      expect(await store.list('cleanup-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'reconnect-required' }),
      ]);
      await expect(
        store.personalToken(started.connection.ref, 'cleanup-owner')
      ).rejects.toBeInstanceOf(RemoteConnectionAuthorizationError);
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'cleanup-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('preserves a valid personal connection when a remote action is forbidden', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('forbidden-owner', origin, 'Forbidden action install');
    expect((await service.poll(started.connection.ref, 'forbidden-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'forbidden-owner', store);
    rejectedAuthorization = `Bearer ${token}`;
    try {
      await expect(adapter.connect()).resolves.toMatchObject({ status: 'unreachable' });
      await expect(adapter.listRooms()).rejects.toMatchObject({
        name: 'PinnedHttpError',
        status: 403,
      });
      expect(await store.list('forbidden-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'forbidden-owner')).toBe(token);
    } finally {
      rejectedAuthorization = undefined;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'forbidden-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('treats a temporary channel-directory failure as unavailable without changing credentials', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('unavailable-owner', origin, 'Unavailable install');
    expect((await service.poll(started.connection.ref, 'unavailable-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'unavailable-owner', store);
    rejectedAuthorization = `Bearer ${token}`;
    rejectedStatus = 503;
    try {
      await expect(adapter.connect()).resolves.toEqual({
        status: 'unreachable',
        error: 'The community returned HTTP 503.',
      });
      expect(await store.list('unavailable-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'unavailable-owner')).toBe(token);
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'unavailable-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('does not replace the personal connection state when an agent grant is rejected', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('agent-revoked-owner', origin, 'Agent revoked install');
    expect((await service.poll(started.connection.ref, 'agent-revoked-owner')).status).toBe(
      'connected'
    );
    await store.saveAgentToken(
      started.connection.ref,
      'agent-revoked-owner',
      remoteAgentId,
      'private-agent-token'
    );
    const adapter = new RemoteCommunityAdapter(
      started.connection.ref,
      'agent-revoked-owner',
      store
    );
    rejectedAuthorization = 'Bearer private-agent-token';
    rejectedStatus = 401;
    try {
      await expect(adapter.listRooms({ actingMemberId: remoteAgentId })).rejects.toMatchObject({
        name: 'PinnedHttpError',
        status: 401,
      });
      expect(await store.list('agent-revoked-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'agent-revoked-owner')).toBe(token);
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'agent-revoked-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('preserves a valid read grant when an enrollment request lacks its scope', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('read-only-owner', origin, 'Read-only install');
    expect((await service.poll(started.connection.ref, 'read-only-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'read-only-owner', store);
    rejectedAuthorization = `Bearer ${token}`;
    rejectedStatus = 401;
    rejectedPath = `${qualified}/agents`;
    try {
      await expect(
        adapter.admitAgent({ agentId: randomUUID(), displayName: 'Denied Agent' })
      ).rejects.toMatchObject({ name: 'PinnedHttpError', status: 401 });
      expect(await store.list('read-only-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'read-only-owner')).toBe(token);
    } finally {
      rejectedAuthorization = undefined;
      rejectedStatus = 403;
      rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'read-only-owner');
      approved = false;
      pollCount = 0;
    }
  });
  it('rejects private targets and refuses a cross-host redirect without following it', async () => {
    expect((await checkedAddress(parseCommunityOrigin('http://localhost:6491'))).address).toBe(
      '127.0.0.1'
    );
    expect(
      await pinnedJson(
        parseCommunityOrigin(origin.replace('127.0.0.1', 'localhost')),
        '/api/v1/community'
      )
    ).toMatchObject({ id: remoteCommunityId });
    expect(() => parseCommunityOrigin('http://192.168.1.9:4444')).toThrow(PinnedOriginError);
    await expect(checkedAddress(parseCommunityOrigin('https://192.168.1.9'))).rejects.toMatchObject(
      { code: 'UNSAFE_ADDRESS' }
    );
    await expect(
      checkedAddress(parseCommunityOrigin('https://[::ffff:127.0.0.1]'))
    ).rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    await expect(
      checkedAddress(parseCommunityOrigin('https://public.example'), async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ])
    ).rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    redirect = true;
    await expect(
      pinnedJson(parseCommunityOrigin(origin), '/api/v1/pairings/poll', {
        pairingId: 'pairing',
        verifier: 'private-verifier',
      })
    ).rejects.toMatchObject({ code: 'REMOTE_RESPONSE' });
    expect(redirectedRequests).toBe(0);
    redirect = false;
  });

  it('separates a canonical tenant link from its pinned socket origin', () => {
    expect(parseCommunityLink(`${origin}/c/${remoteCommunityId}`)).toEqual({
      origin: new URL(origin),
      communityId: remoteCommunityId,
    });
    expect(communityApiPath(remoteCommunityId, '/api/v1/channels/room?cursor=opaque')).toBe(
      `/api/v1/communities/${remoteCommunityId}/channels/room?cursor=opaque`
    );
    for (const invalid of [
      `${origin}/c/${remoteCommunityId}/extra`,
      `${origin}/c/%2F${remoteCommunityId}`,
      `${origin}/c/not-a-uuid`,
      `${origin}/c/${remoteCommunityId.toUpperCase()}`,
      `${origin}/c/${remoteCommunityId}?select=other`,
      `${origin}/api/v1/communities/${remoteCommunityId}`,
    ]) {
      expect(() => parseCommunityLink(invalid)).toThrow(PinnedOriginError);
    }
  });

  it('isolates two refs with the same remote id, survives restart, and never returns secrets', async () => {
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const first = await service.start('local-owner-a', origin, 'Test install');
    const second = await service.start('local-owner-b', origin, 'Test install');
    expect(first.connection.remoteCommunityId).toBe(second.connection.remoteCommunityId);
    expect(first.connection.ref).not.toBe(second.connection.ref);
    expect(await service.list('local-owner-a')).toHaveLength(1);
    expect(await service.list('local-owner-b')).toHaveLength(1);
    await expect(service.status(first.connection.ref, 'local-owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    expect((await service.poll(first.connection.ref, 'local-owner-a')).status).toBe('pending');
    approved = true;
    const restarted = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    const completed = await restarted.poll(first.connection.ref, 'local-owner-a');
    expect(completed.status).toBe('connected');
    expect(completed.connection?.connectedHumanMemberId).toBe('human-id');
    expect(JSON.stringify(completed)).not.toContain(token);
    expect(
      await new RemoteConnectionStore(directory).personalToken(
        first.connection.ref,
        'local-owner-a'
      )
    ).toBe(token);
    await expect(store.personalToken(first.connection.ref, 'local-owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    const agentId = randomUUID();
    await store.saveAgentToken(
      first.connection.ref,
      'local-owner-a',
      agentId,
      'private-agent-bearer'
    );
    expect(
      await new RemoteConnectionStore(directory).agentToken(
        first.connection.ref,
        'local-owner-a',
        agentId
      )
    ).toBe('private-agent-bearer');
    await expect(
      store.agentToken(first.connection.ref, 'local-owner-b', agentId)
    ).rejects.toBeInstanceOf(RemoteConnectionNotFoundError);
    await expect(
      store.agentToken(first.connection.ref, 'local-owner-a', randomUUID())
    ).rejects.toBeInstanceOf(RemoteConnectionNotFoundError);
    const metadata = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(metadata).not.toContain(token);
    expect(metadata).not.toContain(
      requests.find((request) => request.path.endsWith('/poll'))?.body.verifier
    );
    const secretFiles = await readdir(join(directory, 'extension-secrets'));
    for (const file of secretFiles) {
      const bytes = await readFile(join(directory, 'extension-secrets', file), 'utf8');
      expect(bytes).not.toContain(token);
      expect(bytes).not.toContain('private-agent-bearer');
    }
    expect(pollCount).toBe(2);
    await restarted.cancel(second.connection.ref, 'local-owner-b');
    expect(cancelled).toBe(true);
    await expect(restarted.status(second.connection.ref, 'local-owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await restarted.disconnect(first.connection.ref, 'local-owner-a');
    expect(await restarted.list('local-owner-a')).toEqual([]);
  });

  it('refuses a second in-flight poll and clears a cancelled verifier without issuing a token', async () => {
    approved = false;
    cancelled = false;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('local-owner-a', origin, 'Second install');
    let entered!: () => void;
    let release!: () => void;
    const atPoll = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    waitForPoll = async () => {
      entered();
      await held;
    };
    try {
      const first = service.poll(started.connection.ref, 'local-owner-a');
      await atPoll;
      await expect(service.poll(started.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
        RemotePairingBusyError
      );
      await expect(service.cancel(started.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
        RemotePairingBusyError
      );
      await expect(
        service.disconnect(started.connection.ref, 'local-owner-a')
      ).rejects.toBeInstanceOf(RemotePairingBusyError);
      release();
      expect((await first).status).toBe('pending');
    } finally {
      release();
      waitForPoll = undefined;
    }
    await service.cancel(started.connection.ref, 'local-owner-a');
    expect(cancelled).toBe(true);
    await expect(store.verifier(started.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(
      store.personalToken(started.connection.ref, 'local-owner-a')
    ).rejects.toBeInstanceOf(RemoteConnectionNotFoundError);
  });

  it('keeps the local token when cancellation races an approved exchange', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('local-owner-a', origin, 'Exchange race');
    let entered!: () => void;
    let release!: () => void;
    const atExchange = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    waitForExchange = async () => {
      entered();
      await held;
    };
    try {
      const polling = service.poll(started.connection.ref, 'local-owner-a');
      await atExchange;
      await expect(service.cancel(started.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
        RemotePairingBusyError
      );
      await expect(
        service.disconnect(started.connection.ref, 'local-owner-a')
      ).rejects.toBeInstanceOf(RemotePairingBusyError);
      release();
      expect((await polling).status).toBe('connected');
      expect(await store.personalToken(started.connection.ref, 'local-owner-a')).toBe(token);
    } finally {
      release();
      waitForExchange = undefined;
      await service.disconnect(started.connection.ref, 'local-owner-a');
    }
  });

  it('keeps both records when starts write the local store concurrently', async () => {
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const results = await Promise.all([
      service.start('local-owner-a', origin, 'Parallel A'),
      service.start('local-owner-a', origin, 'Parallel B'),
    ]);
    const refs = new Set(results.map((result) => result.connection.ref));
    expect(refs.size).toBe(2);
    const persisted = await new RemoteCommunityPairingService(
      new RemoteConnectionStore(directory)
    ).list('local-owner-a');
    expect(persisted.map((item) => item.ref).sort()).toEqual([...refs].sort());
    for (const ref of refs) await service.disconnect(ref, 'local-owner-a');
  });

  it('clears expired pending descriptors and encrypted verifiers on the next read after restart', async () => {
    approved = false;
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    const first = await service.start('local-owner-a', origin, 'Expired status');
    const second = await service.start('local-owner-a', origin, 'Expired list');
    const file = join(directory, 'communities', 'remote', 'connections.json');
    const records = JSON.parse(await readFile(file, 'utf8')) as Array<{
      ref: string;
      expiresAt: string;
    }>;
    for (const record of records) {
      if (record.ref === first.connection.ref || record.ref === second.connection.ref)
        record.expiresAt = new Date(Date.now() - 1_000).toISOString();
    }
    await writeFile(file, JSON.stringify(records));
    const restarted = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    await expect(restarted.status(first.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    expect(await restarted.list('local-owner-a')).toEqual([]);
    const encrypted = new EncryptedFileCredentialStore(directory);
    expect(await encrypted.get(`community:${first.connection.ref}:pairing`)).toBeNull();
    expect(await encrypted.get(`community:${second.connection.ref}:pairing`)).toBeNull();
  });
});
