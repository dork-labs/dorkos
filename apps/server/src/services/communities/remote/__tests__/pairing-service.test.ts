import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteConnectionStore, RemoteConnectionNotFoundError } from '../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../core/credential-provider.js';
import { RemoteCommunityPairingService, RemotePairingBusyError } from '../pairing-service.js';
import { RemoteCommunityAdapter } from '../remote-community-adapter.js';
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
            authorMemberId: 'human-id',
            authorDisplayName: 'Human',
            authorKind: 'human',
            text: 'hello',
            mentions: [],
            parentEntryId: null,
            threadRootEntryId: null,
            createdAt: new Date().toISOString(),
            cursor: 'resume-1',
            attachments: [],
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
  it('uses the private store for a live HTTP adapter and rejects an unowned agent before a request', async () => {
    approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('adapter-owner', origin, 'Adapter test');
    expect((await service.poll(started.connection.ref, 'adapter-owner')).status).toBe('connected');
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'adapter-owner', store);
    expect((await adapter.connect()).status).toBe('connected');
    expect((await adapter.listRooms()).map((item) => item.roomId)).toEqual(['general']);
    expect((await adapter.listEntries('general')).entries).toHaveLength(1);
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
