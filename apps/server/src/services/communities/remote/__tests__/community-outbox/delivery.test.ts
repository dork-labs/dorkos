import { REF, NOW, outboxItem } from './fixtures.js';
import { RoomError } from '../../../../rooms/room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { describe, expect, it, vi } from 'vitest';
import { CommunityAdapterOutboxDelivery } from '../../community-adapter-outbox-delivery.js';
import { CommunityOutboxStore, type CommunityOutboxItem } from '../../community-outbox-store.js';
import { CommunityOutboxWorker } from '../../community-outbox-worker.js';
import { CommunityOutboxRuntime } from '../../community-outbox-runtime.js';
import { PinnedHttpError } from '../../pinned-origin.js';

describe('community outbox', () => {
  it('fails a post refused while the community is held at once, and never sends it after release (AC-9)', async () => {
    // Purpose: fails if a post refused during a host hold is retried, so held-era posts would
    // flood in on release, or if the person reads the archived sentence instead of the hold's.
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({ ownerAuthorId: harness.human });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    let held = true;
    const post = vi.fn(async () => {
      if (held) throw new PinnedHttpError(423, 'COMMUNITY_HELD');
      return { entryId: 'remote-entry' } as never;
    });
    const delivery = new CommunityAdapterOutboxDelivery(
      () => ({ post, uploadAttachment: vi.fn() }),
      { localRoomIdForOwner: () => 'room-1', remoteEntryIdForLocal: () => null } as never,
      { findRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }) } as never,
      { getEntryById: () => ({ kind: 'post', body: { text: 'Output' } }) } as never,
      {} as never,
      {} as never,
      outbox
    );
    await new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      delivery,
      () => NOW
    ).runOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(outbox.visibleForOwner(harness.human)).toEqual([
      expect.objectContaining({
        id: item.id,
        state: 'failed',
        failure:
          'This space is on hold. You can read it, but no one can post. Its owner can still export it.',
      }),
    ]);

    held = false;
    await new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      delivery,
      () => NOW + 60_000
    ).runOnce();
    expect(post).toHaveBeenCalledOnce();
  });

  it('retries network uncertainty, but stops before a later request after authority changes', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    harness.db.transaction((tx) => outbox.enqueue(outboxItem(), tx));
    let allowed = true;
    const delivery = vi.fn(async (_item: CommunityOutboxItem, stillAuthorized: () => boolean) => {
      expect(stillAuthorized()).toBe(true);
      return { kind: 'retry' as const, reason: 'timeout after remote commit' };
    });
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => allowed },
      { deliver: delivery },
      () => NOW
    );

    await worker.runOnce();
    expect(outbox.due(new Date(NOW).toISOString())).toEqual([]);
    allowed = false;
    const dueLater = outbox.due(new Date(NOW + 31_000).toISOString());
    expect(dueLater).toHaveLength(1);
    await worker.runOnce();
    // The worker clock remains NOW, so invoke a fresh worker at the scheduled point.
    const laterWorker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => allowed },
      { deliver: delivery },
      () => NOW + 31_000
    );
    await laterWorker.runOnce();
    expect(outbox.due(new Date(NOW + 400_000).toISOString())).toEqual([]);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('does not release a pending backoff while the same worker holds delivery', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({ ownerAuthorId: harness.human });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivery = vi.fn(async () => {
      await held;
      return { kind: 'retry' as const, reason: 'temporary outage' };
    });
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      { deliver: delivery },
      () => NOW
    );

    const running = worker.runOnce();
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    expect(
      worker.retryNow({
        communityRef: REF,
        remoteRoomId: item.remoteRoomId,
        ownerAuthorId: harness.human,
        idempotencyKey: item.idempotencyKey,
      })
    ).toBe('in-flight');

    release();
    await running;
  });

  it('releases a genuine backoff without changing its delivery identity or expiry', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({
      ownerAuthorId: harness.human,
      localParentEntryId: 'parent-local-entry',
      attachmentIds: JSON.stringify(['attachment-1']),
      attempts: 2,
      nextAttemptAt: new Date(NOW + 10_000).toISOString(),
      expiresAt: new Date(NOW + 300_000).toISOString(),
    });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      { deliver: vi.fn() },
      () => NOW
    );

    expect(
      worker.retryNow({
        communityRef: REF,
        remoteRoomId: item.remoteRoomId,
        ownerAuthorId: harness.human,
        idempotencyKey: item.idempotencyKey,
      })
    ).toBe('retried');
    expect(
      outbox.deliveryForOwner(REF, item.remoteRoomId, harness.human, item.idempotencyKey)
    ).toMatchObject({
      state: 'pending',
      attempts: item.attempts,
      nextAttemptAt: new Date(NOW).toISOString(),
      expiresAt: item.expiresAt,
      idempotencyKey: item.idempotencyKey,
      attachmentIds: item.attachmentIds,
      localParentEntryId: item.localParentEntryId,
    });
  });

  it.each([
    outboxItem({ state: 'failed', failure: 'remote-refused', attempts: 1 }),
    outboxItem({
      id: 'expired',
      attempts: 1,
      expiresAt: new Date(NOW - 1).toISOString(),
      nextAttemptAt: new Date(NOW + 10_000).toISOString(),
    }),
    outboxItem({
      id: 'revoked',
      state: 'stopped',
      failure: 'revoked',
      attempts: 1,
      nextAttemptAt: new Date(NOW + 10_000).toISOString(),
    }),
  ])('denies retry for terminal delivery state $state', (item) => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const owned = { ...item, ownerAuthorId: harness.human };
    harness.db.transaction((tx) => outbox.enqueue(owned, tx));
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      { deliver: vi.fn() },
      () => NOW
    );

    expect(
      worker.retryNow({
        communityRef: REF,
        remoteRoomId: owned.remoteRoomId,
        ownerAuthorId: harness.human,
        idempotencyKey: owned.idempotencyKey,
      })
    ).toBe('terminal');
  });

  it('keeps retry owner-qualified and refuses missing enrollment or revoked mirror authority', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/a': { name: 'Agent A' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/a', 'Agent A');
    let isCurrent = true;
    const runtime = new CommunityOutboxRuntime({
      db: harness.db,
      roomStore: harness.store,
      authors: harness.authors,
      attachmentRows: {} as never,
      attachmentBytes: {} as never,
      adapters: () => ({}) as never,
      isLocalAgentCurrent: () => isCurrent,
      now: () => NOW,
    });
    runtime.mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: 'general',
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
      authorizedAt: new Date(NOW).toISOString(),
    });
    const item = outboxItem({
      ownerAuthorId: harness.human,
      localAgentId: agent.mintedForManifestId!,
      attempts: 1,
      nextAttemptAt: new Date(NOW + 10_000).toISOString(),
    });
    harness.db.transaction((tx) => runtime.outbox.enqueue(item, tx));
    const input = {
      communityRef: REF,
      remoteRoomId: item.remoteRoomId,
      ownerAuthorId: harness.human,
      idempotencyKey: item.idempotencyKey,
    };
    await expect(runtime.retryNow(input)).resolves.toBe('terminal');
    expect(runtime.outbox.isPending(item.id)).toBe(true);

    runtime.enrollments.activate({
      communityRef: REF,
      localAgentId: item.localAgentId,
      remoteMemberId: 'remote-a',
      ownerAuthorId: harness.human,
    });
    await expect(runtime.retryNow({ ...input, ownerAuthorId: 'other-owner' })).resolves.toBe(
      'missing'
    );
    expect(runtime.outbox.isPending(item.id)).toBe(true);

    isCurrent = false;
    await expect(runtime.retryNow(input)).resolves.toBe('terminal');
    expect(runtime.outbox.isPending(item.id)).toBe(true);
    isCurrent = true;

    runtime.mirrors.revokeAbsentRooms(REF, harness.human, new Set());
    await expect(runtime.retryNow(input)).resolves.toBe('terminal');
    expect(runtime.outbox.isPending(item.id)).toBe(true);
  });

  it('publishes an owner replacement when expiry alone removes a pending delivery', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    harness.db.transaction((tx) =>
      outbox.enqueue(
        outboxItem({
          ownerAuthorId: harness.human,
          expiresAt: new Date(NOW - 1).toISOString(),
        }),
        tx
      )
    );
    const changed = vi.fn();
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      { deliver: vi.fn() },
      () => NOW,
      { changed }
    );

    await worker.runOnce();

    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(harness.human);
    expect(outbox.visibleForOwner(harness.human)).toMatchObject([
      { state: 'failed', failure: 'expired' },
    ]);
  });

  it('settles a receipt and records owner-scoped echo provenance without account matching', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({ ownerAuthorId: harness.human });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      {
        deliver: async () => {
          outbox.recordOrigin({
            communityRef: REF,
            remoteRoomId: 'general',
            ownerAuthorId: harness.human,
            remoteEntryId: 'remote-entry-1',
            idempotencyKey: item.idempotencyKey,
          });
          return { kind: 'confirmed', remoteEntryId: 'remote-entry-1' };
        },
      },
      () => NOW
    );
    await worker.runOnce();

    expect(outbox.originForRemoteEntry(REF, 'general', harness.human, 'remote-entry-1')).toBe(
      item.idempotencyKey
    );
    expect(outbox.confirmByRemoteEntry(REF, 'general', harness.human, 'remote-entry-1')).toBe(
      item.idempotencyKey
    );
    expect(outbox.due(new Date(NOW + 400_000).toISOString())).toEqual([]);
  });
});

it('keeps every other 423 retryable', async () => {
  // Purpose: fails if the permanent rule catches a 423 that does not mean read-only.
  const harness = createRoomHarness({ agents: agentLookupFor({}) });
  const outbox = new CommunityOutboxStore(harness.db);
  const item = outboxItem({ ownerAuthorId: harness.human });
  harness.db.transaction((tx) => outbox.enqueue(item, tx));
  const delivery = new CommunityAdapterOutboxDelivery(
    () => ({
      post: vi.fn(async () => {
        throw new PinnedHttpError(423, 'STATE_CONFLICT');
      }),
      uploadAttachment: vi.fn(),
    }),
    { localRoomIdForOwner: () => 'room-1', remoteEntryIdForLocal: () => null } as never,
    { findRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }) } as never,
    { getEntryById: () => ({ kind: 'post', body: { text: 'Output' } }) } as never,
    {} as never,
    {} as never,
    outbox
  );
  await expect(delivery.deliver(item, () => true)).resolves.toMatchObject({ kind: 'retry' });
  for (const [status, code] of [
    [423, 'COMMUNITY_ARCHIVED'],
    [423, 'COMMUNITY_DELETION_PENDING'],
    // DOR-2334: a deleted community will never take the post.
    [410, 'COMMUNITY_DELETED'],
    [423, 'COMMUNITY_TAKEN_DOWN'],
  ] as const) {
    const refused = new CommunityAdapterOutboxDelivery(
      () => ({
        post: vi.fn(async () => {
          throw new PinnedHttpError(status, code);
        }),
        uploadAttachment: vi.fn(),
      }),
      { localRoomIdForOwner: () => 'room-1', remoteEntryIdForLocal: () => null } as never,
      { findRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }) } as never,
      { getEntryById: () => ({ kind: 'post', body: { text: 'Output' } }) } as never,
      {} as never,
      {} as never,
      outbox
    );
    await expect(
      refused.deliver(item, () => true),
      code
    ).resolves.toMatchObject({
      kind: 'permanent',
    });
  }
});

// Spec `official-community-space` D5: while spaces are off, a space other than the official one
// is closed to agents here. Each case fails if its guard is dropped.
describe('a space that cannot be reached right now', () => {
  it('holds a waiting post untouched, and sends it once the space can be reached', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({ ownerAuthorId: harness.human });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    let reachable = false;
    const canDeliver = vi.fn(() => true);
    const deliver = vi.fn(async () => ({ kind: 'confirmed' as const, remoteEntryId: 'r-1' }));
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver, held: () => !reachable },
      { deliver },
      () => NOW
    );

    await worker.runOnce();
    expect(canDeliver).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.isPending(item.id)).toBe(true);

    reachable = true;
    await worker.runOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('reads as closed to room tools, and refuses an agent’s post into it', () => {
    let reachable = false;
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/a': { name: 'Agent A' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/a', 'Agent A');
    const runtime = new CommunityOutboxRuntime({
      db: harness.db,
      roomStore: harness.store,
      authors: harness.authors,
      attachmentRows: {} as never,
      attachmentBytes: {} as never,
      adapters: () => ({}) as never,
      isLocalAgentCurrent: () => true,
      now: () => NOW,
      reachable: (ref) => reachable && ref === REF,
    });
    const room = runtime.mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: 'general',
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
      authorizedAt: new Date(NOW).toISOString(),
    });
    runtime.enrollments.activate({
      communityRef: REF,
      localAgentId: agent.mintedForManifestId!,
      remoteMemberId: 'remote-a',
      ownerAuthorId: harness.human,
    });
    const access = runtime.mirrorAccess;
    const post = () =>
      runtime.mirrorWrites.prepare(room, agent.id, { parentEntryId: null, attachmentIds: [] });

    expect(access.canRead(room.id, agent.id)).toBe(false);
    expect(post).toThrow(RoomError);

    reachable = true;
    expect(access.canRead(room.id, agent.id)).toBe(true);
    expect(post()).not.toBeNull();
    // An ordinary room is not a mirror, so reachability never touches it.
    expect(access.canRead('not-a-mirror', agent.id)).toBeNull();
  });
});
