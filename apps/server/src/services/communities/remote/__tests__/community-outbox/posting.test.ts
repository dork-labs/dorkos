import { REF, NOW, outboxItem } from './fixtures.js';
import type { RoomMirrorWritePolicy } from '../../../../rooms/room-service.js';
import { RoomError } from '../../../../rooms/room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
  scriptedRunner,
} from '../../../../rooms/__tests__/room-test-harness.js';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it, vi } from 'vitest';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { CommunityAdapterOutboxDelivery } from '../../community-adapter-outbox-delivery.js';
import { CommunityOutboxPolicy } from '../../community-outbox-policy.js';
import { CommunityOutboxProjection } from '../../community-outbox-projection.js';
import { CommunityOutboxStore, type CommunityOutboxItem } from '../../community-outbox-store.js';
import { CommunityOutboxWorker } from '../../community-outbox-worker.js';
import { RemoteMirrorStore } from '../../mirror-store.js';

describe('community outbox', () => {
  it('writes an agent mirror post and its bounded delivery row in one RoomService transaction', async () => {
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
        retryable: false,
      }),
    ]);
    const workerRef: { current: CommunityOutboxWorker | null } = { current: null };
    const liveProjection = new CommunityOutboxProjection(
      outbox,
      mirrors,
      harness.store,
      harness.attachments,
      harness.authors,
      (id) => workerRef.current?.isInFlight(id) ?? false,
      () => NOW
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observedRetryable: boolean[] = [];
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      {
        deliver: async () => {
          await held;
          return { kind: 'retry', reason: 'temporary outage' };
        },
      },
      () => NOW,
      {
        changed: () => {
          observedRetryable.push(liveProjection.list(harness.human)[0]?.retryable ?? false);
        },
      }
    );
    workerRef.current = worker;
    const running = worker.runOnce();
    await vi.waitFor(() =>
      expect(worker.isInFlight(outbox.due(new Date(NOW).toISOString())[0]?.id ?? '')).toBe(true)
    );
    expect(liveProjection.list(harness.human)[0]?.retryable).toBe(false);
    release();
    await running;
    expect(observedRetryable).toEqual([false, true]);
    const settledProjection = new CommunityOutboxProjection(
      outbox,
      mirrors,
      harness.store,
      harness.attachments,
      harness.authors,
      () => false,
      () => NOW
    );
    expect(settledProjection.list(harness.human)[0]?.retryable).toBe(true);
  });

  it('suppresses recursive agent narration only for a remote mirror', async () => {
    let actual: CommunityOutboxPolicy | null = null;
    const policy: RoomMirrorWritePolicy = {
      prepare(room, authorId, delivery) {
        return actual?.prepare(room, authorId, delivery) ?? null;
      },
    };
    const harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/a': { name: 'Ana', responseMode: 'always' },
        '/agents/b': { name: 'Bo', responseMode: 'mention-only' },
      }),
      runner: scriptedRunner((request) =>
        request.agentPath === '/agents/a' ? '@bo please verify the deployment.' : 'Verified.'
      ),
      mirrorWrites: policy,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db, () =>
      new Date(NOW).toISOString()
    );
    const outbox = new CommunityOutboxStore(harness.db);
    const agentA = harness.authors.resolveAgent('/agents/a', 'Ana');
    const agentB = harness.authors.resolveAgent('/agents/b', 'Bo');
    const mirror = mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: 'general',
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [
        { authorId: agentA.id, responseMode: 'always' },
        { authorId: agentB.id, responseMode: 'mention-only' },
      ],
      authorizedAt: new Date(NOW).toISOString(),
    });
    for (const [localAgentId, remoteMemberId] of [
      ['/agents/a', 'remote-agent-a'],
      ['/agents/b', 'remote-agent-b'],
    ]) {
      enrollments.activate({
        communityRef: REF,
        localAgentId,
        remoteMemberId,
        ownerAuthorId: harness.human,
      });
    }
    actual = new CommunityOutboxPolicy(mirrors, enrollments, harness.authors, outbox, () => NOW);

    harness.service.post(mirror.id, {
      authorId: harness.human,
      text: '@ana report the deployment status.',
      mentions: [agentA.id],
    });
    await settleUntil(() => harness.runner.turns.length === 1, 'the mirrored agent turn');
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]?.authorId).toBe(agentA.id);
    expect(outbox.due(new Date(NOW).toISOString())).toHaveLength(1);

    const local = harness.service.createRoom(
      {
        kind: 'channel',
        title: 'Local updates',
        members: [],
        agentPaths: ['/agents/a', '/agents/b'],
      },
      harness.human
    );
    harness.service.post(local.id, {
      authorId: harness.human,
      text: '@ana report the local deployment status.',
      mentions: [agentA.id],
    });
    await settleUntil(
      () => harness.runner.turns.length === 3,
      'the local agent narration to dispatch'
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns.slice(1).map((turn) => turn.roomId)).toEqual([local.id, local.id]);
    expect(harness.runner.turns.slice(1).map((turn) => turn.authorId)).toEqual([
      agentA.id,
      agentB.id,
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
      if (condition === 'revoked') mirrors.revoke(REF, harness.human);
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

  it('keeps oversized attachment metadata visible but refuses native upload before reading bytes', async () => {
    const uploadAttachment = vi.fn();
    const attachmentStore = { get: vi.fn() };
    const delivery = new CommunityAdapterOutboxDelivery(
      () => ({ uploadAttachment, post: vi.fn() }) as never,
      { localRoomIdForOwner: () => 'room-1' } as never,
      { findRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }) } as never,
      { getEntryById: () => ({ kind: 'post', body: { text: 'Output' } }) } as never,
      {
        get: () => ({
          id: 'attachment-1',
          entryId: 'entry-1',
          size: 26 * 1024 * 1024,
        }),
      } as never,
      attachmentStore as never,
      { recordOrigin: vi.fn() } as never
    );

    await expect(
      delivery.deliver(outboxItem({ attachmentIds: JSON.stringify(['attachment-1']) }), () => true)
    ).resolves.toEqual({ kind: 'permanent', reason: 'remote-attachment-too-large' });
    expect(attachmentStore.get).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('aborts only the matching held post and leaves its stopped row unable to retry', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const item = outboxItem({ ownerAuthorId: harness.human });
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    let observedSignal: AbortSignal | undefined;
    const worker = new CommunityOutboxWorker(
      outbox,
      { canDeliver: () => true },
      {
        deliver: async (_item, _stillAuthorized, signal) => {
          observedSignal = signal;
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true })
          );
          return { kind: 'stopped', reason: 'stopped-or-unauthorized' };
        },
      },
      () => NOW
    );

    const running = worker.runOnce();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    worker.abortForRoom(REF, 'other-room', harness.human);
    expect(observedSignal?.aborted).toBe(false);
    worker.abortForRoom(REF, item.remoteRoomId, harness.human);
    await running;

    expect(observedSignal?.aborted).toBe(true);
    expect(outbox.isPending(item.id)).toBe(false);
    expect(
      worker.retryNow({
        communityRef: REF,
        remoteRoomId: item.remoteRoomId,
        ownerAuthorId: harness.human,
        idempotencyKey: item.idempotencyKey,
      })
    ).toBe('terminal');
  });

  it('stops only the departed agent work in its qualified remote room', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const target = outboxItem({ id: 'left-agent-room-a', ownerAuthorId: harness.human });
    const otherAgent = outboxItem({
      id: 'other-agent-room-a',
      localAgentId: 'agent-b',
      idempotencyKey: 'delivery-key-b',
      localEntryId: 'entry-2',
      ownerAuthorId: harness.human,
    });
    const otherRoom = outboxItem({
      id: 'left-agent-room-b',
      remoteRoomId: 'build',
      idempotencyKey: 'delivery-key-c',
      localEntryId: 'entry-3',
      ownerAuthorId: harness.human,
    });
    harness.db.transaction((tx) => {
      outbox.enqueue(target, tx);
      outbox.enqueue(otherAgent, tx);
      outbox.enqueue(otherRoom, tx);
    });

    outbox.stopForAgentInRoom(REF, target.remoteRoomId, target.localAgentId, harness.human);

    expect(outbox.isPending(target.id)).toBe(false);
    expect(outbox.isPending(otherAgent.id)).toBe(true);
    expect(outbox.isPending(otherRoom.id)).toBe(true);
  });

  // Purpose (DOR-2575): what a deleted community's panel reports as "didn't send" is exactly the
  // owner's waiting and failed posts to that community: never a delivered one, never one the
  // person stopped, never another community's or another owner's. It fails if any of those
  // leaks into the count or a waiting or failed one is missed.
  it('counts only one owner’s waiting and failed posts to one community', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const outbox = new CommunityOutboxStore(harness.db);
    const rows: Array<Partial<CommunityOutboxItem>> = [
      { state: 'pending' },
      { state: 'failed', failure: 'This space was deleted.' },
      { state: 'failed', failure: 'expired' },
      { state: 'confirmed', remoteEntryId: 'remote-1' },
      { state: 'stopped', failure: 'stopped' },
      { state: 'pending', communityRef: 'remote_other' as CommunityRef },
      { state: 'pending', ownerAuthorId: 'someone-else' },
    ];
    harness.db.transaction((tx) =>
      rows.forEach((row, index) =>
        outbox.enqueue(
          outboxItem({
            id: `row-${index}`,
            idempotencyKey: `key-${index}`,
            localEntryId: `entry-${index}`,
            ...row,
          }),
          tx
        )
      )
    );

    expect(outbox.undeliveredCount(REF, 'owner')).toBe(3);
    expect(outbox.undeliveredCount(REF, 'nobody')).toBe(0);
  });
});
