/**
 * Durable writer and worker coverage for remote community mirror delivery.
 *
 * @module services/communities/remote/__tests__/community-outbox
 */
import type { RoomMirrorWritePolicy } from '../../../rooms/room-service.js';
import { RoomError } from '../../../rooms/room-errors.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it, vi } from 'vitest';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { CommunityOutboxPolicy } from '../community-outbox-policy.js';
import { CommunityOutboxProjection } from '../community-outbox-projection.js';
import { CommunityOutboxStore, type CommunityOutboxItem } from '../community-outbox-store.js';
import { CommunityOutboxWorker } from '../community-outbox-worker.js';
import { RemoteMirrorStore } from '../mirror-store.js';

const REF = 'remote_outbox' as CommunityRef;
const NOW = Date.parse('2026-09-16T12:00:00.000Z');

function outboxItem(overrides: Partial<CommunityOutboxItem> = {}): CommunityOutboxItem {
  return {
    id: 'outbox-1',
    communityRef: REF,
    remoteRoomId: 'general',
    ownerAuthorId: 'owner',
    localEntryId: 'entry-1',
    localParentEntryId: null,
    localAgentId: 'agent-a',
    attachmentIds: '[]',
    idempotencyKey: 'delivery-key',
    state: 'pending',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    remoteEntryId: null,
    failure: null,
    attempts: 0,
    nextAttemptAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('community outbox', () => {
  it('writes an agent mirror post and its bounded delivery row in one RoomService transaction', () => {
    let actual: CommunityOutboxPolicy | null = null;
    const policy: RoomMirrorWritePolicy = {
      prepare(room, authorId, delivery) {
        return actual?.prepare(room, authorId, delivery) ?? null;
      },
    };
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/a': { name: 'Agent A' } }),
      mirrorWrites: policy,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db, () =>
      new Date(NOW).toISOString()
    );
    const outbox = new CommunityOutboxStore(harness.db);
    const agent = harness.authors.resolveAgent('/agents/a', 'Agent A');
    const room = mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: 'general',
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
      authorizedAt: new Date(NOW).toISOString(),
    });
    enrollments.activate({
      communityRef: REF,
      localAgentId: '/agents/a',
      remoteMemberId: 'remote-agent-a',
      ownerAuthorId: harness.human,
    });
    actual = new CommunityOutboxPolicy(mirrors, enrollments, harness.authors, outbox, () => NOW);

    const posted = harness.service.post(room.id, {
      authorId: agent.id,
      text: 'I have the update.',
    });

    expect(harness.store.getEntryById(room.id, posted.id)?.body.text).toBe('I have the update.');
    expect(outbox.due(new Date(NOW).toISOString())).toMatchObject([
      {
        localEntryId: posted.id,
        localAgentId: '/agents/a',
        attachmentIds: '[]',
        state: 'pending',
      },
    ]);
    expect(
      new CommunityOutboxProjection(
        outbox,
        mirrors,
        harness.store,
        harness.attachments,
        harness.authors
      ).list(harness.human)
    ).toEqual([
      expect.objectContaining({
        communityRef: REF,
        author: { displayName: 'Agent A', kind: 'agent' },
        text: 'I have the update.',
        state: 'pending',
        attachments: [],
      }),
    ]);
  });

  it.each(['stale', 'revoked', 'missing enrollment'] as const)(
    'refuses a local agent post before append, outbox, or dispatch when the mirror is %s',
    (condition) => {
      let actual: CommunityOutboxPolicy | null = null;
      const policy: RoomMirrorWritePolicy = {
        prepare(room, authorId, delivery) {
          return actual?.prepare(room, authorId, delivery) ?? null;
        },
      };
      const harness = createRoomHarness({
        agents: agentLookupFor({ '/agents/a': { name: 'Agent A', responseMode: 'always' } }),
        mirrorWrites: policy,
      });
      const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
      const enrollments = new CommunityAgentEnrollmentStore(harness.db, () =>
        new Date(NOW).toISOString()
      );
      const outbox = new CommunityOutboxStore(harness.db);
      const agent = harness.authors.resolveAgent('/agents/a', 'Agent A');
      const room = mirrors.ensureRoom({
        communityRef: REF,
        remoteRoomId: 'general',
        title: 'General',
        topic: null,
        ownerAuthorId: harness.human,
        accessors: [{ authorId: agent.id, responseMode: 'always' }],
        authorizedAt: new Date(NOW).toISOString(),
      });
      if (condition !== 'missing enrollment') {
        enrollments.activate({
          communityRef: REF,
          localAgentId: '/agents/a',
          remoteMemberId: 'remote-agent-a',
          ownerAuthorId: harness.human,
        });
      }
      if (condition === 'stale') mirrors.markStale(REF, harness.human);
      if (condition === 'revoked') mirrors.revoke(REF);
      actual = new CommunityOutboxPolicy(mirrors, enrollments, harness.authors, outbox, () => NOW);

      expect(() =>
        harness.service.post(room.id, { authorId: agent.id, text: 'A denied local fallback.' })
      ).toThrow(RoomError);
      try {
        harness.service.post(room.id, { authorId: agent.id, text: 'A denied local fallback.' });
      } catch (error) {
        expect(error).toMatchObject({ code: 'COMMUNITY_DELIVERY_UNAVAILABLE' });
      }
      expect(harness.store.listEntries(room.id, { limit: 100 })).toEqual([]);
      expect(outbox.due(new Date(NOW).toISOString())).toEqual([]);
      expect(harness.runner.turns).toEqual([]);
    }
  );

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
