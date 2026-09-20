import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
  RemoteConnectionNotFoundError,
} from '../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../core/credential-provider.js';
import { RemoteCommunityPairingService, RemotePairingBusyError } from '../pairing-service.js';
import {
  RemoteCommunityAdapter,
  remoteOriginIdempotencyKeyOf,
  type RemoteNativeRoomEvent,
} from '../remote-community-adapter.js';
import {
  checkedAddress,
  parseCommunityOrigin,
  pinnedJson,
  PinnedOriginError,
} from '../pinned-origin.js';

let server: Server;
let redirectedServer: Server;
let origin: string;
let redirectedOrigin: string;
let redirectedRequests = 0;
let directory: string;
let approved = false;
let cancelled = false;
let redirect = false;
let pollCount = 0;
let waitForPoll: (() => Promise<void>) | undefined;
let waitForExchange: (() => Promise<void>) | undefined;
let rejectedAuthorization: string | undefined;
let rejectedStatus = 403;
let rejectedPath: string | undefined;
const token = 'private-pairing-bearer-should-never-appear-in-dto';
const remoteAgentId = randomUUID();
const requests: Array<{ path: string; body: Record<string, string> }> = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-pairing-'));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: req.url ?? '', body });
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
    if (req.url === '/api/v1/community') {
      send({
        id: 'same-remote-id',
        name: 'Test community',
        description: null,
        createdAt: new Date().toISOString(),
      });
    } else if (req.url === '/api/v1/pairings/start') {
      const pairingId = randomUUID();
      send(
        {
          pairingId,
          approvalUrl: `${origin}/pairing?pairingId=${pairingId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      );
    } else if (req.url === '/api/v1/pairings/poll') {
      pollCount++;
      await waitForPoll?.();
      send(approved ? { status: 'approved', code: 'one-time-code' } : { status: 'pending' });
    } else if (req.url === '/api/v1/pairings/exchange') {
      await waitForExchange?.();
      send({
        token,
        grant: {
          id: randomUUID(),
          memberId: 'human-id',
          installName: 'Test install',
          scopes: ['read', 'post', 'enroll-agent'],
          createdAt: new Date().toISOString(),
        },
      });
    } else if (req.url === '/api/v1/pairings/cancel') {
      cancelled = true;
      res.statusCode = 204;
      res.end();
    } else if (req.url === '/api/v1/channels') {
      send({
        channels: [
          {
            id: 'general',
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
    } else if (req.url === '/api/v1/channels/general/entries') {
      send({
        entries: [
          {
            id: 'entry-1',
            channelId: 'general',
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
                id: 'attachment-1',
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
    } else if (req.url === '/api/v1/channels/general/read-cursor') {
      send({ cursor: 'resume-1', unreadCount: 0 });
    } else if (req.url === '/api/v1/agents') {
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
    const started = await service.start('adapter-owner', origin, 'Adapter test');
    expect((await service.poll(started.connection.ref, 'adapter-owner')).status).toBe('connected');
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'adapter-owner', store);
    expect((await adapter.connect()).status).toBe('connected');
    expect((await adapter.listRooms()).map((item) => item.roomId)).toEqual(['general']);
    const history = await adapter.listEntries('general');
    expect(history.entries).toHaveLength(1);
    expect(remoteOriginIdempotencyKeyOf(history.entries[0]!)).toBe('owner-wire-key');
    expect(history.entries[0]!.attachments).toEqual([
      {
        id: 'attachment-1',
        name: 'shot.png',
        contentType: 'image/png',
        byteSize: 5,
        checksum: 'checksum-1',
      },
    ]);
    expect(await adapter.getReadCursor('general')).toBe('resume-1');
    await adapter.setReadCursor('general', 'resume-1' as never);
    const agent = await adapter.admitAgent({ agentId: randomUUID(), displayName: 'Test Agent' });
    expect(agent.memberId).toBe(remoteAgentId);
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
    rejectedPath = '/api/v1/agents';
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
    ).toMatchObject({ id: 'same-remote-id' });
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
