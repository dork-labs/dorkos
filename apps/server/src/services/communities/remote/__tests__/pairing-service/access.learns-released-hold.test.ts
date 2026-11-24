import { fake, token, remoteAgentId, qualified, directory, origin } from './fake-community.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
} from '../../connection-store.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import { RemoteCommunityAdapter } from '../../remote-community-adapter.js';
import { PinnedHttpError } from '../../pinned-origin.js';
import {
  READ_ONLY_RECHECK_MS,
  RemoteRoomSubscriptionRuntime,
} from '../../remote-room-subscription-runtime.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  it('learns a released hold for a member-only connection through the release check (AC-8)', async () => {
    // Purpose: fails if the five-minute check does not reach the real pairing service and
    // store, so a member-only connection kept its read-only access after the host released.
    fake.approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const owner = 'release-check-owner';
    const started = await service.start(owner, origin, 'Member-only install');
    expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
    fake.approved = false;
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
      fake.accessLifecycle = 'archived';
      await service.status(started.connection.ref, owner);
      expect(await lifecycle()).toBe('archived');
      runtime.start();
      // The host releases the hold; nobody opens the connection's status.
      fake.accessLifecycle = 'active';
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
      fake.accessLifecycle = 'active';
      await service.disconnect(started.connection.ref, owner);
    }
  });

  it('fences local authority even when reconnect persistence fails', async () => {
    fake.approved = true;
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
    fake.rejectedAuthorization = `Bearer ${token}`;
    fake.rejectedStatus = 401;
    try {
      await expect(adapter.listRooms()).rejects.toBe(persistenceFailure);
      expect(revokeConnection).toHaveBeenCalledWith(started.connection.ref, 'recovery-owner');
      expect(await store.personalToken(started.connection.ref, 'recovery-owner')).toBe(token);
    } finally {
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'recovery-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });

  it('still clears rejected credentials when local authority cleanup fails', async () => {
    fake.approved = true;
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
    fake.rejectedAuthorization = `Bearer ${token}`;
    fake.rejectedStatus = 401;
    try {
      await expect(adapter.listRooms()).rejects.toBe(cleanupFailure);
      expect(await store.list('cleanup-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'reconnect-required' }),
      ]);
      await expect(
        store.personalToken(started.connection.ref, 'cleanup-owner')
      ).rejects.toBeInstanceOf(RemoteConnectionAuthorizationError);
    } finally {
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'cleanup-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });

  it('preserves a valid personal connection when a remote action is forbidden', async () => {
    fake.approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('forbidden-owner', origin, 'Forbidden action install');
    expect((await service.poll(started.connection.ref, 'forbidden-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'forbidden-owner', store);
    fake.rejectedAuthorization = `Bearer ${token}`;
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
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'forbidden-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });

  it('treats a temporary channel-directory failure as unavailable without changing credentials', async () => {
    fake.approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('unavailable-owner', origin, 'Unavailable install');
    expect((await service.poll(started.connection.ref, 'unavailable-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'unavailable-owner', store);
    fake.rejectedAuthorization = `Bearer ${token}`;
    fake.rejectedStatus = 503;
    try {
      await expect(adapter.connect()).resolves.toEqual({
        status: 'unreachable',
        error: 'The space returned HTTP 503.',
      });
      expect(await store.list('unavailable-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'unavailable-owner')).toBe(token);
    } finally {
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'unavailable-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });

  it('does not replace the personal connection state when an agent grant is rejected', async () => {
    fake.approved = true;
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
    fake.rejectedAuthorization = 'Bearer private-agent-token';
    fake.rejectedStatus = 401;
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
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'agent-revoked-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });

  it('preserves a valid read grant when an enrollment request lacks its scope', async () => {
    fake.approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const started = await service.start('read-only-owner', origin, 'Read-only install');
    expect((await service.poll(started.connection.ref, 'read-only-owner')).status).toBe(
      'connected'
    );
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'read-only-owner', store);
    fake.rejectedAuthorization = `Bearer ${token}`;
    fake.rejectedStatus = 401;
    fake.rejectedPath = `${qualified}/agents`;
    try {
      await expect(
        adapter.admitAgent({ agentId: randomUUID(), displayName: 'Denied Agent' })
      ).rejects.toMatchObject({ name: 'PinnedHttpError', status: 401 });
      expect(await store.list('read-only-owner')).toEqual([
        expect.objectContaining({ ref: started.connection.ref, status: 'connected' }),
      ]);
      expect(await store.personalToken(started.connection.ref, 'read-only-owner')).toBe(token);
    } finally {
      fake.rejectedAuthorization = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedPath = undefined;
      await service.disconnect(started.connection.ref, 'read-only-owner');
      fake.approved = false;
      fake.pollCount = 0;
    }
  });
});
