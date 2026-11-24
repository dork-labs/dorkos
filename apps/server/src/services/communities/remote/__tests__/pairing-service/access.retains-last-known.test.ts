import {
  fake,
  token,
  remoteCommunityId,
  qualified,
  requests,
  directory,
  origin,
} from './fake-community.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
} from '../../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../../core/credential-provider.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import { RemoteCommunityAdapter } from '../../remote-community-adapter.js';
import { COMMUNITY_ACCESS_BUDGET_MS } from '../../pairing-service.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  it('retains last-known access through an outage and fails closed after grant rejection', async () => {
    fake.approved = true;
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
      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = `${qualified}/me/connection-access`;
      fake.rejectedStatus = 503;
      const unavailable = await service.status(started.connection.ref, owner);
      expect(unavailable.access).toMatchObject({
        state: 'unverified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: connected.connection?.access?.lastKnown,
      });
      expect(accessAuthorityChanged).toHaveBeenCalledOnce();

      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      await expect(service.status(started.connection.ref, owner)).resolves.toMatchObject({
        access: { state: 'verified' },
      });
      expect(accessAuthorityChanged).toHaveBeenCalledTimes(2);
      await service.status(started.connection.ref, owner);
      expect(accessAuthorityChanged).toHaveBeenCalledTimes(2);

      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = `${qualified}/me/connection-access`;
      fake.rejectedStatus = 401;
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
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
    }
  });

  it('carries the host’s operator answer only while the connection is verified', async () => {
    fake.approved = true;
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
      fake.hostAccessAnswer = undefined;
      const before = hostRequests();
      const older = await service.status(ref, owner);
      expect(older.access).toMatchObject({ state: 'verified' });
      expect(older).not.toHaveProperty('hostOperator');
      expect(hostRequests()).toBe(before + 1);

      fake.hostAccessAnswer = { status: 200, body: { hostOperator: true } };
      expect(await service.status(ref, owner)).toMatchObject({ hostOperator: true });
      expect(await service.list(owner)).toEqual([
        expect.objectContaining({ ref, hostOperator: true }),
      ]);

      fake.hostAccessAnswer = { status: 200, body: { hostOperator: false } };
      expect(await service.status(ref, owner)).not.toHaveProperty('hostOperator');

      // Anything the app cannot read as a clear yes is a no, and never costs
      // the connection its verified access.
      for (const answer of [
        { status: 200, body: { hostOperator: 'yes' } },
        { status: 200, body: { hostOperator: true, extra: true } },
        { status: 500, body: { hostOperator: true } },
      ]) {
        fake.hostAccessAnswer = answer;
        const read = await service.status(ref, owner);
        expect(read.access).toMatchObject({ state: 'verified' });
        expect(read).not.toHaveProperty('hostOperator');
      }

      // An offline host keeps the last answer on disk but offers nothing.
      fake.hostAccessAnswer = { status: 200, body: { hostOperator: true } };
      expect(await service.status(ref, owner)).toMatchObject({ hostOperator: true });
      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = `${qualified}/me/connection-access`;
      fake.rejectedStatus = 503;
      const offline = await service.status(ref, owner);
      expect(offline.access).toMatchObject({ state: 'unverified' });
      expect(offline).not.toHaveProperty('hostOperator');

      // A rejected grant ends the offer with the connection.
      fake.rejectedStatus = 401;
      const rejected = await service.status(ref, owner);
      expect(rejected.status).toBe('reconnect-required');
      expect(rejected).not.toHaveProperty('hostOperator');
    } finally {
      await service.disconnect(ref, owner);
      fake.hostAccessAnswer = undefined;
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
    }
  });

  describe('list re-checks access within a budget', () => {
    let release: () => void = () => undefined;
    function holdAccess(): void {
      fake.accessGate = new Promise<void>((resolve) => (release = resolve));
    }
    async function connect(
      owner: string,
      timing: ConstructorParameters<typeof RemoteCommunityPairingService>[3] = { budgetMs: 100 }
    ) {
      fake.approved = true;
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
      fake.accessGate = undefined;
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
      fake.approved = false;
      fake.pollCount = 0;
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
        fake.rejectedAuthorization = `Bearer ${token}`;
        fake.rejectedPath = `${qualified}/me/connection-access`;
        fake.rejectedStatus = 401;
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
        const before = fake.accessRequests;
        const reads = await Promise.all([
          service.list('budget-shared'),
          service.list('budget-shared'),
          service.list('budget-shared'),
        ]);
        for (const [item] of reads) expect(item?.access?.state).toBe('unverified');
        expect(fake.accessRequests - before).toBe(1);

        release();
        await expect(service.status(ref, 'budget-shared')).resolves.toMatchObject({
          access: { state: 'verified' },
        });
        expect(fake.accessRequests - before).toBe(1);

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
    fake.approved = true;
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
    fake.rejectedAuthorization = `Bearer ${token}`;
    fake.rejectedStatus = 401;
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
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'revoked-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });
});
