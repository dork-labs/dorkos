import {
  fake,
  token,
  remoteCommunityId,
  secondRemoteCommunityId,
  qualified,
  requests,
  shortNameAnswers,
  directory,
  origin,
} from './fake-community.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteConnectionStore, RemoteConnectionNotFoundError } from '../../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../../core/credential-provider.js';
import {
  RemoteCommunityPairingService,
  RemoteCommunityRateLimitedError,
  RemoteCommunityNameNotFoundError,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
  RemotePairingBusyError,
} from '../../pairing-service.js';
import {
  checkedAddress,
  communityApiPath,
  parseCommunityLink,
  parseCommunityOrigin,
  pinnedJson,
  PinnedHttpError,
  PinnedOriginError,
} from '../../pinned-origin.js';

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
    fake.requireExplicitCommunity = true;
    try {
      await expect(
        service.start('multi-owner', origin, 'Ambiguous install')
      ).rejects.toBeInstanceOf(RemoteCommunitySelectionRequiredError);
      await expect(
        service.start('multi-owner', `${origin}/c/${remoteCommunityId}`, 'Selected install')
      ).resolves.toMatchObject({ connection: { remoteCommunityId } });
    } finally {
      fake.requireExplicitCommunity = false;
    }
  });

  // Purpose: the host limits pairing starts per caller (5 a minute by default), which says
  // nothing about the address. Fails if that 429 is rethrown as a generic failure, which the
  // dialog would show as "check the community address", or if the host's wait is lost.
  it('reports a limited pairing start as rate limited, with the host’s wait', async () => {
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    fake.pairingStartRefusal = {
      status: 429,
      body: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again soon.' },
      retryAfter: '42',
    };
    try {
      for (const link of [origin, `${origin}/c/${remoteCommunityId}`]) {
        const refusal = service.start('limited-owner', link, 'Limited install');
        await expect(refusal, link).rejects.toBeInstanceOf(RemoteCommunityRateLimitedError);
        await expect(refusal, link).rejects.toMatchObject({ retryAfterSeconds: 42 });
      }
    } finally {
      fake.pairingStartRefusal = undefined;
    }
  });

  // Purpose: only a server with no qualified pairing route (an uncoded 404) needs upgrading. A
  // current server's coded NOT_FOUND means the community went away between discovery and
  // pairing, which an upgrade would not fix. Fails if any 404 there reads as "upgrade".
  it('asks for an upgrade only on an uncoded 404 from the pairing start', async () => {
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    fake.pairingStartRefusal = { status: 404, body: { code: 'NOT_FOUND', message: 'Not found.' } };
    try {
      const gone = service.start('gone-owner', origin, 'Gone install');
      await expect(gone).rejects.toBeInstanceOf(PinnedHttpError);
      await expect(gone).rejects.toMatchObject({ status: 404, remoteCode: 'NOT_FOUND' });
      fake.pairingStartRefusal = { status: 404, body: {} };
      await expect(service.start('old-owner', origin, 'Old install')).rejects.toBeInstanceOf(
        RemoteCommunityUpgradeRequiredError
      );
    } finally {
      fake.pairingStartRefusal = undefined;
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
    fake.redirect = true;
    await expect(
      pinnedJson(parseCommunityOrigin(origin), '/api/v1/pairings/poll', {
        pairingId: 'pairing',
        verifier: 'private-verifier',
      })
    ).rejects.toMatchObject({ code: 'REMOTE_RESPONSE' });
    expect(fake.redirectedRequests).toBe(0);
    fake.redirect = false;
  });

  describe('short-name links', () => {
    const lookups = () =>
      requests.filter((request) => request.path.startsWith('/api/v1/community-names/'));
    const pairingStarts = () =>
      requests.filter((request) => request.path.endsWith('/pairings/start'));

    // Purpose: a /<name> link resolves through the host lookup (lower-cased) and then pairs
    // exactly as the canonical /c/<uuid> link does; the connection keeps only the UUID.
    it('resolves /Acme through the lookup and connects to the UUID it names', async () => {
      shortNameAnswers.set('acme', { communityId: remoteCommunityId, shortName: 'acme' });
      requests.length = 0;
      try {
        const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
        const started = await service.start('name-owner', `${origin}/Acme`, 'Named install');
        expect(lookups().map((request) => request.path)).toEqual(['/api/v1/community-names/acme']);
        expect(requests.map((request) => request.path)).toEqual([
          '/api/v1/community-names/acme',
          `${qualified}/community`,
          `${qualified}/pairings/start`,
        ]);
        expect(started.connection).toMatchObject({ remoteCommunityId, pinnedOrigin: origin });
        expect(JSON.stringify(started.connection)).not.toContain('acme');
        expect(started.approvalUrl).toContain(`/c/${remoteCommunityId}/pairing`);
      } finally {
        shortNameAnswers.clear();
      }
    });

    // Purpose: an unknown name is its own error, and nothing is started on the host.
    it('reports an unknown name without starting a pairing', async () => {
      requests.length = 0;
      const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
      await expect(
        service.start('name-owner', `${origin}/nobody-here`, 'Unknown')
      ).rejects.toBeInstanceOf(RemoteCommunityNameNotFoundError);
      expect(pairingStarts()).toEqual([]);
    });

    // Purpose: a lookup answer that is not exactly one canonical UUID is refused before any
    // tenant call, so a hostile host cannot steer the connection with a crafted id.
    it('refuses a lookup that answers a malformed UUID', async () => {
      const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
      for (const answer of [
        { communityId: 'not-a-uuid', shortName: 'acme' },
        { communityId: remoteCommunityId.toUpperCase(), shortName: 'acme' },
        { communityId: '00000000-0000-0000-0000-000000000000', shortName: 'acme' },
        { communityId: remoteCommunityId, shortName: 'acme', extra: true },
        { shortName: 'acme' },
        [remoteCommunityId],
      ]) {
        shortNameAnswers.set('acme', answer);
        requests.length = 0;
        await expect(
          service.start('name-owner', `${origin}/acme`, 'Malformed'),
          JSON.stringify(answer)
        ).rejects.toMatchObject({ code: 'REMOTE_RESPONSE' });
        expect(requests.map((request) => request.path)).toEqual(['/api/v1/community-names/acme']);
      }
      shortNameAnswers.clear();
    });

    // Purpose: the lookup never follows a redirect, so a host cannot send the resolution (or
    // the connection) to another host.
    it('does not follow a redirect from the lookup', async () => {
      shortNameAnswers.set('acme', 'redirect');
      const before = fake.redirectedRequests;
      try {
        const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
        await expect(
          service.start('name-owner', `${origin}/acme`, 'Redirected')
        ).rejects.toMatchObject({ status: 301 });
        expect(fake.redirectedRequests).toBe(before);
      } finally {
        shortNameAnswers.clear();
      }
    });

    // Purpose: every shape the spec names. /Acme is lower-cased; a trailing slash, a deeper
    // path, a percent-encoded spelling and a reserved name are refused before any request.
    it('accepts only the exact /<name> shape', () => {
      expect(parseCommunityLink(`${origin}/Acme`)).toEqual({
        origin: new URL(origin),
        communityId: null,
        shortName: 'acme',
      });
      expect(parseCommunityLink('https://community.example/my-club-2')).toEqual({
        origin: new URL('https://community.example'),
        communityId: null,
        shortName: 'my-club-2',
      });
      // A reserved name that is not a path may belong to a space a host operator gave it to,
      // such as the host's official space; the host's lookup decides.
      expect(parseCommunityLink(`${origin}/dorkos`)).toEqual({
        origin: new URL(origin),
        communityId: null,
        shortName: 'dorkos',
      });
      for (const invalid of [
        `${origin}/acme/`,
        `${origin}/acme/x`,
        `${origin}/%61cme`,
        `${origin}/api`,
        `${origin}/API`,
        `${origin}/settings`,
        `${origin}/ab`,
        `${origin}/1acme`,
        `${origin}/acme-`,
        `${origin}/ac--me`,
        `${origin}/${'a'.repeat(33)}`,
        `${origin}/acme?x=1`,
        `${origin}/acme#top`,
        'https://owner:secret@community.example/acme',
        'http://community.example/acme',
      ]) {
        expect(() => parseCommunityLink(invalid), invalid).toThrow(PinnedOriginError);
      }
      expect(() => parseCommunityOrigin(`${origin}/acme`)).toThrow(PinnedOriginError);
    });
  });

  it('separates a canonical tenant link from its pinned socket origin', () => {
    expect(parseCommunityLink(`${origin}/c/${remoteCommunityId}`)).toEqual({
      origin: new URL(origin),
      communityId: remoteCommunityId,
      shortName: null,
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
    fake.approved = true;
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
    expect(fake.pollCount).toBe(2);
    await restarted.cancel(second.connection.ref, 'local-owner-b');
    expect(fake.cancelled).toBe(true);
    await expect(restarted.status(second.connection.ref, 'local-owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await restarted.disconnect(first.connection.ref, 'local-owner-a');
    expect(await restarted.list('local-owner-a')).toEqual([]);
  });

  it('refuses a second in-flight poll and clears a cancelled verifier without issuing a token', async () => {
    fake.approved = false;
    fake.cancelled = false;
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
    fake.waitForPoll = async () => {
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
      fake.waitForPoll = undefined;
    }
    await service.cancel(started.connection.ref, 'local-owner-a');
    expect(fake.cancelled).toBe(true);
    await expect(store.verifier(started.connection.ref, 'local-owner-a')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(
      store.personalToken(started.connection.ref, 'local-owner-a')
    ).rejects.toBeInstanceOf(RemoteConnectionNotFoundError);
  });

  it('keeps the local token when cancellation races an approved exchange', async () => {
    fake.approved = true;
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
    fake.waitForExchange = async () => {
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
      fake.waitForExchange = undefined;
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
    fake.approved = false;
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
