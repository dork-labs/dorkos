/**
 * Real SQLite and RoomService coverage for remote-community mirrors.
 *
 * The tests deliberately import through `RemoteMirrorStore` and read through
 * the ordinary room service. A cache-only test would miss the owner-wide local
 * visibility and dispatcher-context paths that a mirror row can otherwise
 * enter through.
 *
 * @module services/communities/remote/__tests__/mirror-store.integration
 */
import { communityMirrorEntries, eq } from '@dorkos/db';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it, vi } from 'vitest';
import { authorOrigin } from '../../../rooms/author-registry.js';
import { RoomStore } from '../../../rooms/room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  settleUntil,
  type RoomHarness,
  type ScriptedTurnRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../mirror-store.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { CommunityOutboxStore } from '../community-outbox-store.js';
import { RemoteRoomSubscriptionBridge } from '../remote-room-subscription-bridge.js';

const REF_A = 'remote_a' as CommunityRef;
const REF_B = 'remote_b' as CommunityRef;

function nativeEntry(ref: CommunityRef, roomId: string, seq: number): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community: ref,
    roomId,
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `remote ${seq}`,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: `2026-09-16T00:${String(seq % 60).padStart(2, '0')}:00.000Z`,
  };
  return {
    entry,
    remoteSeq: seq,
    author: { memberId: 'remote-human', displayName: 'Remote human', kind: 'human' },
  };
}

function wired(
  agents = agentLookupFor({}),
  opts: { runner?: ScriptedTurnRunner } = {}
): {
  harness: RoomHarness;
  mirrors: RemoteMirrorStore;
} {
  const state: { mirrors?: RemoteMirrorStore } = {};
  const access = {
    canRead: (roomId: string, authorId: string) => state.mirrors?.canRead(roomId, authorId) ?? null,
    hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
  };
  const harness = createRoomHarness({ agents, mirrorAccess: access, ...opts });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  state.mirrors = mirrors;
  return { harness, mirrors };
}

function roomInput(ref: CommunityRef, remoteRoomId: string, ownerAuthorId: string) {
  return {
    communityRef: ref,
    remoteRoomId,
    title: `Room ${remoteRoomId}`,
    topic: null,
    ownerAuthorId,
    accessors: [],
    authorizedAt: '2026-09-16T00:00:00.000Z',
  };
}

describe('RemoteMirrorStore', () => {
  it('keeps agent enrollment qualified, owner-scoped, and fail-closed on revoke', () => {
    const { harness } = wired();
    const enrollments = new CommunityAgentEnrollmentStore(
      harness.db,
      () => '2026-09-16T00:00:00.000Z'
    );

    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'agent-local-1',
      remoteMemberId: 'agent-remote-1',
      ownerAuthorId: harness.human,
    });

    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)?.localAgentId).toBe(
      'agent-local-1'
    );
    expect(
      enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)?.remoteMemberId
    ).toBe('agent-remote-1');
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', 'other-owner')).toBeNull();

    enrollments.revoke(REF_A, 'agent-local-1', harness.human);
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)).toBeNull();
    expect(enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)).toBeNull();
  });

  it('retains native author metadata beside the opaque cached entry', () => {
    const { harness, mirrors } = wired();
    mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const entry = nativeEntry(REF_A, 'general', 1);
    entry.author = { memberId: 'remote-agent', displayName: 'Release bot', kind: 'agent' };
    entry.entry = { ...entry.entry, authorId: 'remote-agent' };
    mirrors.importEntries(REF_A, 'general', [entry]);

    expect(
      mirrors.cachedEntryWithAuthorForOwner(REF_A, 'general', entry.entry.id, harness.human)
    ).toMatchObject({
      entry: { cursor: 'cursor-1', authorId: 'remote-agent' },
      remoteSeq: 1,
      author: { memberId: 'remote-agent', displayName: 'Release bot', kind: 'agent' },
    });
  });

  it('dispatches only fresh external-human mentions through the existing RoomService', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z')
    );
    const live = nativeEntry(REF_A, 'general', 1);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };

    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    const imported = harness.store.listEntriesAfter(mirrors.ensureRoom(room).id, 0)[0];
    const importedOrigin = authorOrigin(harness.authors.getById(imported!.authorId)!.naturalKey);
    expect(importedOrigin).not.toBe('local');
    expect(
      mirrors.cachedEntryForOwner(REF_A, 'general', live.entry.id, harness.human)?.mentions
    ).toEqual(['remote-ana']);

    // Snapshot and reconnect replay are cache-only even where a remote human
    // mentions an enrolled agent. A remote agent is never a local runtime.
    await bridge.consume(
      room,
      (async function* () {
        for (const frame of [
          {
            type: 'snapshot' as const,
            entries: [
              {
                ...nativeEntry(REF_A, 'general', 2),
                entry: { ...nativeEntry(REF_A, 'general', 2).entry, mentions: ['remote-ana'] },
                author: { memberId: 'remote-human', displayName: 'Remote', kind: 'human' as const },
                serverCreatedAt: '2026-09-16T01:00:00.000Z',
              },
            ],
          },
          {
            type: 'replay' as const,
            entries: [
              {
                ...nativeEntry(REF_A, 'general', 3),
                entry: { ...nativeEntry(REF_A, 'general', 3).entry, mentions: ['remote-ana'] },
                author: { memberId: 'remote-human', displayName: 'Remote', kind: 'human' as const },
                serverCreatedAt: '2026-09-16T01:00:00.000Z',
              },
            ],
          },
          {
            type: 'live' as const,
            entry: {
              ...nativeEntry(REF_A, 'general', 4),
              author: {
                memberId: 'remote-agent',
                displayName: 'Remote agent',
                kind: 'agent' as const,
              },
              serverCreatedAt: '2026-09-16T01:00:00.000Z',
            },
            reconnect: false,
            wasActiveBeforeDisconnect: false,
            readOnly: false,
          },
        ]) {
          yield frame;
        }
      })()
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);

    const recent = nativeEntry(REF_A, 'general', 5);
    recent.entry = { ...recent.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...recent,
        author: { ...recent.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T00:59:31.000Z',
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(2);

    // The claim is persisted: a new bridge after restart cannot replay a
    // recently eligible event, while old/revoked/read-only events never claim.
    const restarted = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z')
    );
    restarted.importLive(
      room,
      {
        ...recent,
        author: { ...recent.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T00:59:31.000Z',
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    const stale = nativeEntry(REF_A, 'general', 6);
    stale.entry = { ...stale.entry, mentions: ['remote-ana'] };
    restarted.importLive(
      room,
      {
        ...stale,
        author: { ...stale.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T00:59:29.000Z',
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    const readOnly = nativeEntry(REF_A, 'general', 7);
    readOnly.entry = { ...readOnly.entry, mentions: ['remote-ana'] };
    restarted.importLive(
      room,
      {
        ...readOnly,
        author: { ...readOnly.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: true }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(2);
  });

  it('does not refresh a stale owner mirror from a live frame before dispatching it', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'stale-general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const local = mirrors.ensureRoom(room);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    mirrors.markStale(REF_A, harness.human);
    const live = nativeEntry(REF_A, 'stale-general', 1);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };

    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
    expect(mirrors.isActivelyAuthorized(local.id, harness.human)).toBe(false);
  });

  it('does not restore a revoked mirror when a delayed snapshot arrives before a live mention', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'revoked-general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const local = mirrors.ensureRoom(room);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    mirrors.revoke(REF_A);
    bridge.importSnapshot(room, [
      {
        ...nativeEntry(REF_A, 'revoked-general', 1),
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
    ]);
    const live = nativeEntry(REF_A, 'revoked-general', 2);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
    expect(mirrors.isActivelyAuthorized(local.id, harness.human)).toBe(false);
  });

  it('revokes a local enrollment before stopping its held external turn', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const runner = gatedRunner({ interruptedTurnStillAnswers: true });
    const { harness, mirrors } = wired(agents, { runner });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    const incoming = nativeEntry(REF_A, 'general', 1);
    incoming.entry = { ...incoming.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...incoming,
        author: { ...incoming.author, kind: 'human' },
        serverCreatedAt: new Date().toISOString(),
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'external turn to be held');
    const imported = harness.store.listEntriesAfter(mirrors.ensureRoom(room).id, 0)[0];
    const importedOrigin = authorOrigin(harness.authors.getById(imported!.authorId)!.naturalKey);
    expect(importedOrigin).not.toBe('local');

    // A fresh process owns no in-memory room subscription map. Revocation still
    // stops the held turn by reading the persisted mirror rows first.
    const abortForAgent = vi.fn();
    const restarted = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      undefined,
      undefined,
      { abortForRoom: vi.fn(), abortForAgent }
    );
    await restarted.revokeEnrollment(REF_A, 'local-ana', harness.human);
    await harness.service.triggersIdle();
    expect(enrollments.findRemoteMember(REF_A, 'local-ana', harness.human)).toBeNull();
    expect(abortForAgent).toHaveBeenCalledWith(REF_A, 'local-ana', harness.human);
    expect(runner.interrupted).toHaveLength(1);
    expect(harness.service.listHolds()).toHaveLength(0);
  });

  it('returns the real RoomService count when stopping one qualified mirrored agent', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const runner = gatedRunner();
    const { harness, mirrors } = wired(agents, { runner });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    const incoming = nativeEntry(REF_A, 'general', 1);
    incoming.entry = { ...incoming.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...incoming,
        author: { ...incoming.author, kind: 'human' },
        serverCreatedAt: new Date().toISOString(),
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'the qualified external turn to hold');

    // This is the numeric RoomService receipt that the route must preserve.
    await expect(bridge.haltRoomAgent(REF_A, 'general', 'local-ana', harness.human)).resolves.toBe(
      1
    );
    await harness.service.triggersIdle();
    expect(runner.interrupted).toHaveLength(1);
  });

  it('reconciles only the owner-authorized agent wire key without delaying unrelated agent history', () => {
    const { harness, mirrors } = wired();
    const room = roomInput(REF_A, 'general', harness.human);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    const outbox = new CommunityOutboxStore(harness.db);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      () => null,
      undefined,
      outbox
    );
    bridge.authorizeRoom(room);
    const item = {
      id: 'delivery-a',
      communityRef: REF_A,
      remoteRoomId: 'general',
      ownerAuthorId: harness.human,
      localEntryId: 'local-entry-a',
      localParentEntryId: null,
      localAgentId: 'local-agent-a',
      attachmentIds: '[]',
      idempotencyKey: 'delivery-a-key',
      state: 'pending' as const,
      createdAt: '2026-09-16T00:00:00.000Z',
      expiresAt: '2026-09-16T00:05:00.000Z',
      remoteEntryId: null,
      failure: null,
      attempts: 0,
      nextAttemptAt: '2026-09-16T00:00:00.000Z',
    };
    harness.db.transaction((tx) => outbox.enqueue(item, tx));
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: item.localAgentId,
      remoteMemberId: 'remote-agent-a',
      ownerAuthorId: harness.human,
    });
    const unrelated = nativeEntry(REF_A, 'general', 1);
    unrelated.entry = {
      ...unrelated.entry,
      id: 'unrelated-agent-entry',
      authorId: 'remote-agent-a',
    };
    unrelated.author = { memberId: 'remote-agent-a', displayName: 'Other agent', kind: 'agent' };
    const echoed = nativeEntry(REF_A, 'general', 2);
    echoed.entry = { ...echoed.entry, id: 'receipt-agent-entry', authorId: 'remote-agent-a' };
    echoed.author = { memberId: 'remote-agent-a', displayName: 'Our agent', kind: 'agent' };

    bridge.importLive(
      room,
      { ...unrelated, serverCreatedAt: '2026-09-16T01:00:00.000Z' },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    const peer = nativeEntry(REF_A, 'general', 3);
    peer.entry = { ...peer.entry, id: 'peer-agent-entry', authorId: 'remote-agent-peer' };
    peer.author = { memberId: 'remote-agent-peer', displayName: 'Peer agent', kind: 'agent' };
    bridge.importLive(
      room,
      {
        ...peer,
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
        originIdempotencyKey: item.idempotencyKey,
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    expect(
      outbox.deliveryForOwner(REF_A, 'general', harness.human, item.idempotencyKey)
    ).toMatchObject({
      state: 'pending',
    });
    expect(outbox.originForRemoteEntry(REF_A, 'general', harness.human, peer.entry.id)).toBeNull();

    bridge.importLive(
      room,
      {
        ...echoed,
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
        originIdempotencyKey: item.idempotencyKey,
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );

    expect(
      mirrors.cachedEntryForOwner(REF_A, 'general', unrelated.entry.id, harness.human)
    ).not.toBeNull();
    expect(
      mirrors.cachedEntryForOwner(REF_A, 'general', echoed.entry.id, harness.human)
    ).not.toBeNull();
    expect(outbox.originForRemoteEntry(REF_A, 'general', harness.human, echoed.entry.id)).toBe(
      item.idempotencyKey
    );
    expect(
      outbox.deliveryForOwner(REF_A, 'general', harness.human, item.idempotencyKey)
    ).toMatchObject({
      state: 'confirmed',
      remoteEntryId: echoed.entry.id,
    });
    expect(
      outbox.originForRemoteEntry(REF_A, 'general', harness.human, unrelated.entry.id)
    ).toBeNull();
    const replayItem = {
      ...item,
      id: 'delivery-replay',
      localEntryId: 'local-entry-replay',
      idempotencyKey: 'delivery-replay-key',
    };
    harness.db.transaction((tx) => outbox.enqueue(replayItem, tx));
    const replay = nativeEntry(REF_A, 'general', 4);
    replay.entry = { ...replay.entry, id: 'replay-agent-entry', authorId: 'remote-agent-a' };
    replay.author = { memberId: 'remote-agent-a', displayName: 'Our agent', kind: 'agent' };
    bridge.importSnapshot(room, [
      {
        ...replay,
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
        originIdempotencyKey: replayItem.idempotencyKey,
      },
    ]);
    expect(
      outbox.deliveryForOwner(REF_A, 'general', harness.human, replayItem.idempotencyKey)
    ).toMatchObject({ state: 'confirmed', remoteEntryId: replay.entry.id });
    const stoppedItem = {
      ...item,
      id: 'delivery-stopped',
      localEntryId: 'local-entry-stopped',
      idempotencyKey: 'delivery-stopped-key',
      state: 'stopped' as const,
    };
    harness.db.transaction((tx) => outbox.enqueue(stoppedItem, tx));
    const stoppedEcho = nativeEntry(REF_A, 'general', 5);
    stoppedEcho.entry = {
      ...stoppedEcho.entry,
      id: 'stopped-agent-entry',
      authorId: 'remote-agent-a',
    };
    stoppedEcho.author = { memberId: 'remote-agent-a', displayName: 'Our agent', kind: 'agent' };
    bridge.importSnapshot(room, [
      {
        ...stoppedEcho,
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
        originIdempotencyKey: stoppedItem.idempotencyKey,
      },
    ]);
    expect(
      outbox.deliveryForOwner(REF_A, 'general', harness.human, stoppedItem.idempotencyKey)
    ).toMatchObject({ state: 'stopped', remoteEntryId: null });
    expect(harness.runner.turns).toEqual([]);
  });

  it('keeps two community refs with the same remote ids as separate local rooms', () => {
    const { harness, mirrors } = wired();
    const first = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const second = mirrors.ensureRoom(roomInput(REF_B, 'general', harness.human));

    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.importEntries(REF_B, 'general', [nativeEntry(REF_B, 'general', 1)]);

    expect(first.id).not.toBe(second.id);
    expect(harness.store.listEntriesAfter(first.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
    ]);
    expect(harness.store.listEntriesAfter(second.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
    ]);
  });

  it('deduplicates an imported entry by its qualified remote identity without dispatching', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const entry = nativeEntry(REF_A, 'general', 7);

    mirrors.importEntries(REF_A, 'general', [entry]);
    mirrors.importEntries(REF_A, 'general', [entry]);

    expect(harness.store.listEntriesAfter(room.id, 0)).toHaveLength(1);
    expect(
      harness.db
        .select()
        .from(communityMirrorEntries)
        .where(eq(communityMirrorEntries.localRoomId, room.id))
        .all()
    ).toHaveLength(1);
    expect(harness.runner.turns).toEqual([]);
  });

  it('keeps remote order after arbitrary local appends without sharing their storage ordinal', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));

    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    for (const text of ['local one', 'local two', 'local three']) {
      harness.service.post(room.id, { authorId: harness.human, text });
    }
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 2)]);

    // The live log remains strictly monotonic by local `seq`; a late remote
    // sequence must never make an SSE replay move backward.
    expect(harness.store.listEntriesAfter(room.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'local one',
      'local two',
      'local three',
      'remote 2',
    ]);
    // History and agent context use the persisted remote relation instead, so
    // the remote conversation is never reordered by arbitrary local appends.
    const timeline = harness.store.listEntries(room.id, { limit: 10 });
    expect(timeline.map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'remote 2',
      'local one',
      'local two',
      'local three',
    ]);
    expect(
      timeline.filter((entry) => entry.body.text.startsWith('local')).map((entry) => entry.seq)
    ).toEqual([2, 3, 4]);
    expect(timeline.find((entry) => entry.body.text === 'remote 2')?.seq).toBe(5);
    const snapshot = harness.service.snapshot(room.id, harness.human, 10);
    expect(snapshot.entries.map((entry) => entry.body.text)).toEqual(
      timeline.map((entry) => entry.body.text)
    );
    expect(snapshot.cursor).toBe(5);
  });

  it('pages remote history by the timeline anchor without skipping a late remote entry', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    for (const text of ['local one', 'local two', 'local three']) {
      harness.service.post(room.id, { authorId: harness.human, text });
    }
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 2)]);

    const newest = harness.store.listEntries(room.id, { limit: 2 });
    const middle = harness.store.listEntries(room.id, { before: newest[0]!.seq, limit: 2 });
    const oldest = harness.store.listEntries(room.id, { before: middle[0]!.seq, limit: 2 });

    expect([...oldest, ...middle, ...newest].map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'remote 2',
      'local one',
      'local two',
      'local three',
    ]);

    // The public history tool reverses each backward page for the reader, but
    // uses the same anchor contract; combining the pages still keeps every row.
    const historyNewest = harness.service.readHistory(room.id, harness.human, { limit: 2 });
    const historyMiddle = harness.service.readHistory(room.id, harness.human, {
      before: historyNewest.at(-1)!.seq,
      limit: 2,
    });
    const historyOldest = harness.service.readHistory(room.id, harness.human, {
      before: historyMiddle.at(-1)!.seq,
      limit: 2,
    });
    expect(
      [...historyOldest]
        .reverse()
        .concat([...historyMiddle].reverse(), [...historyNewest].reverse())
        .map((entry) => entry.body.text)
    ).toEqual(['remote 1', 'remote 2', 'local one', 'local two', 'local three']);

    const firstForward = harness.store.listEntriesForExport(room.id, { afterSeq: 0, limit: 2 });
    const secondForward = harness.store.listEntriesForExport(room.id, {
      afterSeq: firstForward.at(-1)!.seq,
      limit: 2,
    });
    const thirdForward = harness.store.listEntriesForExport(room.id, {
      afterSeq: secondForward.at(-1)!.seq,
      limit: 2,
    });
    expect(
      [...firstForward, ...secondForward, ...thirdForward].map((entry) => entry.body.text)
    ).toEqual(['remote 1', 'remote 2', 'local one', 'local two', 'local three']);
  });

  it('hides a revoked cache row from the local owner and rejects its normal history read', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.revoke(REF_A);

    expect(harness.service.listRooms(harness.human).map((item) => item.id)).not.toContain(room.id);
    expect(harness.service.listMemberRooms(harness.human).map((item) => item.roomId)).not.toContain(
      room.id
    );
    expect(() => harness.service.readHistory(room.id, harness.human, { limit: 10 })).toThrow(
      'No such room'
    );
  });

  it('allows only the last authorized owner to read a stale cache', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.markStale(REF_A, harness.human);

    expect(harness.service.readHistory(room.id, harness.human, { limit: 10 })).toHaveLength(1);
    const other = harness.authors.resolveExternal({
      platformType: 'community',
      instanceId: REF_A,
      platformUserId: 'other',
      displayName: 'Other',
    });
    expect(() => harness.service.readHistory(room.id, other.id, { limit: 10 })).toThrow(
      'No such room'
    );
  });

  it('keeps authorized mirror caches readable but out of generic room lists', () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });

    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    expect(harness.service.listRooms(harness.human).map((item) => item.id)).not.toContain(room.id);
    expect(harness.service.listRooms(agent.id).map((item) => item.id)).not.toContain(room.id);
    expect(harness.service.readHistory(room.id, harness.human, { limit: 10 })).toHaveLength(1);

    mirrors.markStale(REF_A, harness.human);
    expect(harness.service.listRooms(agent.id).map((item) => item.id)).not.toContain(room.id);

    mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });
    mirrors.revoke(REF_A);
    expect(harness.service.listRooms(agent.id).map((item) => item.id)).not.toContain(room.id);
  });

  it('keeps a reply’s opaque remote entry data and repairs its parent after backfill', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const reply = nativeEntry(REF_A, 'general', 2);
    reply.entry = {
      ...reply.entry,
      parentEntryId: 'entry-1',
      threadRootEntryId: 'entry-1',
      depth: 1,
      cursor: 'opaque-resume-after-reply' as CommunityEntry['cursor'],
      attachments: [
        {
          id: 'attachment-1',
          name: 'plan.pdf',
          contentType: 'application/pdf',
          byteSize: 42,
          checksum: 'sha256:fixture',
        },
      ],
    };

    // A page may contain a reply before its parent. The cache retains the
    // remote relation instead of deciding the reply is permanently top-level.
    mirrors.importEntries(REF_A, 'general', [reply]);
    const beforeParent = harness.store.listEntries(room.id, { limit: 10 })[0]!;
    expect(beforeParent.parentEntryId).toBeNull();

    const parent = nativeEntry(REF_A, 'general', 1);
    mirrors.importEntries(REF_A, 'general', [parent]);
    const parentLocal = harness.store
      .listEntries(room.id, { limit: 10 })
      .find((entry) => entry.body.text === 'remote 1')!;
    const repaired = harness.store.getEntryById(room.id, beforeParent.id)!;
    expect(repaired.parentEntryId).toBe(parentLocal.id);
    expect(repaired.threadRootEntryId).toBe(parentLocal.id);

    // A fresh cache store reads the original adapter entry without interpreting
    // its opaque cursor or discarding the attachment metadata.
    const restarted = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    expect(restarted.cachedEntryForOwner(REF_A, 'general', reply.entry.id, harness.human)).toEqual(
      reply.entry
    );
    expect(restarted.cachedEntriesForOwner(REF_A, 'general', harness.human, { limit: 1 })).toEqual([
      parent.entry,
    ]);
    expect(
      restarted.cachedEntriesForOwner(REF_A, 'general', harness.human, {
        afterRemoteSeq: 1,
        limit: 1,
      })
    ).toEqual([reply.entry]);
    expect(
      restarted.cachedEntryForOwner(REF_A, 'general', reply.entry.id, 'other-owner')
    ).toBeNull();
  });

  it('keeps remote authors external even when their remote id matches the local owner', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const entry = nativeEntry(REF_A, 'general', 1);
    entry.author.memberId = harness.human;
    mirrors.importEntries(REF_A, 'general', [entry]);

    const stored = harness.store.listEntriesAfter(room.id, 0)[0];
    const author = harness.authors.getById(stored.authorId);
    expect(author).toBeDefined();
    const origin = authorOrigin(author!.naturalKey);
    if (origin === 'local') throw new Error('A remote mirror author became local');
    expect(origin.platform).toBe('community');
    expect(stored.authorId).not.toBe(harness.human);
  });

  it('orders late history backfill by native sequence in history and dispatcher context', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });

    mirrors.importEntries(
      REF_A,
      'general',
      Array.from({ length: 50 }, (_, index) => nativeEntry(REF_A, 'general', index + 101))
    );
    mirrors.importEntries(
      REF_A,
      'general',
      Array.from({ length: 100 }, (_, index) => nativeEntry(REF_A, 'general', index + 1))
    );

    expect(
      harness.store.listEntries(room.id, { limit: 200 }).map((entry) => entry.body.text)
    ).toEqual(Array.from({ length: 150 }, (_, index) => `remote ${index + 1}`));
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(room.id, { authorId: harness.human, text: 'local question' });
    await harness.service.triggersIdle();
    const context = harness.runner.turns[0]?.roomContext;
    expect(context?.pending.map((entry) => entry.text)).toEqual(
      Array.from({ length: 30 }, (_, index) => `remote ${index + 121}`)
    );

    // Local and imported rows receive independent storage ordinals. Remote
    // order still comes from the persisted native sequence relation.
    const local = harness.store
      .listEntriesAfter(room.id, 0)
      .find((entry) => entry.body.text === 'local question');
    expect(local?.seq).toBe(151);
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 151)]);
    expect(
      harness.store.listEntries(room.id, { limit: 200 }).map((entry) => entry.body.text)
    ).toEqual([
      ...Array.from({ length: 151 }, (_, index) => `remote ${index + 1}`),
      'local question',
      'on it',
    ]);
    expect(harness.store.getEntryById(room.id, local?.id ?? '')?.body.text).toBe('local question');

    // The native sequence mapping is persisted, but the room store's choice of
    // indexed local or native remote ordering is process-local. Recreating both
    // sides proves startup restores that choice before a cached history read.
    const restartedStore = new RoomStore(harness.db);
    new RemoteMirrorStore(harness.db, restartedStore, harness.authors);
    expect(
      restartedStore.listEntries(room.id, { limit: 200 }).map((entry) => entry.body.text)
    ).toEqual([
      ...Array.from({ length: 151 }, (_, index) => `remote ${index + 1}`),
      'local question',
      'on it',
    ]);
  });
});
