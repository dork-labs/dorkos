/** Shared builders for the RemoteRoomSubscriptionRuntime suites. */
import type { CommunityEntry, CommunityRef, CommunityRoom } from '@dorkos/shared/community-adapter';
import type { CommunityOutboxItem } from '../../community-outbox-store.js';
import type { RemoteLiveEntry } from '../../remote-room-subscription-bridge.js';
import type { RemoteNativeRoomEvent } from '../../remote-community-adapter.js';

export const REF = 'remote_owner_a' as CommunityRef;
export const ROOM_ID = 'room-a';

export const VERIFIED_AGENT_ACCESS = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-21T12:00:00.000Z',
  },
} as const;

export function entry(seq: number, mentions: string[] = ['remote-ana']): CommunityEntry {
  return {
    community: REF,
    roomId: ROOM_ID,
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `message ${seq}`,
    mentions,
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: '2026-09-16T01:00:00.000Z',
  };
}

export function live(value: CommunityEntry, seq: number): RemoteLiveEntry {
  return {
    entry: value,
    remoteSeq: seq,
    author: { memberId: 'remote-human', displayName: 'Remote human', kind: 'human' },
    serverCreatedAt: value.createdAt,
  };
}

export function outboxItem(overrides: Partial<CommunityOutboxItem> = {}): CommunityOutboxItem {
  return {
    id: 'outbox-1',
    communityRef: REF,
    remoteRoomId: ROOM_ID,
    ownerAuthorId: 'owner',
    localEntryId: 'entry-1',
    localParentEntryId: null,
    localAgentId: '/agents/ana',
    attachmentIds: '[]',
    idempotencyKey: 'delivery-key',
    state: 'pending',
    createdAt: '2026-09-16T00:00:00.000Z',
    expiresAt: '2026-09-16T00:05:00.000Z',
    remoteEntryId: null,
    failure: null,
    attempts: 0,
    nextAttemptAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

export function testRoom(): CommunityRoom {
  return {
    community: REF,
    roomId: ROOM_ID,
    kind: 'channel',
    title: 'General',
    slug: null,
    topic: null,
    archived: false,
    createdAt: '2026-09-16T00:00:00.000Z',
    lastActivityAt: '2026-09-16T00:00:00.000Z',
    unreadCount: 0,
  };
}

export function snapshot(
  room: CommunityRoom,
  entries: CommunityEntry[],
  capturedSeq: number
): Extract<RemoteNativeRoomEvent, { type: 'snapshot' }> {
  return {
    type: 'snapshot',
    room,
    entries,
    capturedSeq,
    cursor: `cursor-${capturedSeq}` as CommunityEntry['cursor'],
  };
}
