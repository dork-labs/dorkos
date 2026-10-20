import { describe, expect, it } from 'vitest';
import {
  RemoteCommunityEnrollmentSchema,
  RemoteCommunityEntrySchema,
  RemoteCommunityEventSchema,
  RemoteCommunityHistoryQuerySchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityPostRequestSchema,
  RemoteCommunityRoomSchema,
} from '../community-views.js';

const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
const access = {
  state: 'verified' as const,
  effective: capabilities,
  lastKnown: {
    lifecycle: 'active' as const,
    capabilities,
    verifiedAt: '2026-09-21T00:00:00.000Z',
  },
};

const room = {
  community: 'community_a',
  roomId: 'same-room-id',
  remoteCommunityId: 'deployment-a',
  kind: 'channel',
  title: 'General',
  slug: 'general',
  topic: null,
  archived: false,
  createdAt: '2026-09-16T10:00:00Z',
  lastActivityAt: '2026-09-16T10:00:00Z',
  unreadCount: 2,
  visibility: 'public',
  readable: true,
  writable: true,
  joined: true,
  stale: false,
  cacheCursor: 'opaque:not-a-number',
  lastRemoteSeq: 27,
  access,
};
const entry = {
  community: 'community_a',
  roomId: 'same-room-id',
  id: 'reply',
  authorId: 'agent-id',
  authorDisplayName: 'Archivist',
  authorKind: 'agent',
  text: 'A reply',
  mentions: ['member-id'],
  parentEntryId: 'root',
  threadRootEntryId: 'root',
  depth: 1,
  cursor: 'opaque:not-a-number',
  createdAt: '2026-09-16T10:00:00Z',
  remoteSeq: 27,
  attachments: [
    { id: 'file', name: 'notes.txt', contentType: 'text/plain', byteSize: 7, checksum: 'hash' },
  ],
};

describe('local remote-community view boundary', () => {
  it('preserves opaque cursors, immutable author identity, thread links and file metadata', () => {
    expect(RemoteCommunityEntrySchema.parse(entry)).toEqual(entry);
    expect(
      RemoteCommunityEntrySchema.safeParse({ ...entry, remoteSeq: Number.MAX_SAFE_INTEGER + 1 })
        .success
    ).toBe(false);
    expect(RemoteCommunityEntrySchema.safeParse({ ...entry, authorKind: undefined }).success).toBe(
      false
    );
  });

  it('cannot advertise writing from stale, archived, unreadable or unjoined history', () => {
    expect(RemoteCommunityRoomSchema.parse(room)).toEqual(room);
    for (const changed of [
      { stale: true },
      { archived: true },
      { readable: false },
      { joined: false },
    ]) {
      expect(RemoteCommunityRoomSchema.safeParse({ ...room, ...changed }).success).toBe(false);
      expect(
        RemoteCommunityRoomSchema.safeParse({ ...room, ...changed, writable: false }).success
      ).toBe(true);
    }
  });

  it('rejects credential and runtime authority fields instead of passing database rows to the client', () => {
    for (const key of ['token', 'bearer', 'ownerKey', 'localRoomId', 'cwd', 'sessionId']) {
      expect(RemoteCommunityRoomSchema.safeParse({ ...room, [key]: 'private' }).success).toBe(
        false
      );
      expect(RemoteCommunityEntrySchema.safeParse({ ...entry, [key]: 'private' }).success).toBe(
        false
      );
    }
    expect(
      RemoteCommunityEntrySchema.safeParse({
        ...entry,
        attachments: [{ ...entry.attachments[0], storagePath: '/private' }],
      }).success
    ).toBe(false);
    expect(
      RemoteCommunityEnrollmentSchema.safeParse({
        community: 'community_a',
        localAgentId: 'local-agent',
        remoteMemberId: 'remote-agent',
        displayName: 'Archivist',
        ownerMemberId: 'owner',
        ownerDisplayName: 'Alex',
        roomIds: ['same-room-id'],
        active: true,
        token: 'private',
      }).success
    ).toBe(false);
  });

  it('does not accept browser-selected acting identity or numeric resume shortcuts', () => {
    expect(
      RemoteCommunityPostRequestSchema.safeParse({
        text: 'Hi',
        idempotencyKey: 'retry',
        actingMemberId: 'agent-id',
      }).success
    ).toBe(false);
    expect(RemoteCommunityHistoryQuerySchema.safeParse({ afterRemoteSeq: 26 }).success).toBe(false);
    expect(
      RemoteCommunityHistoryQuerySchema.parse({
        cursor: 'opaque:not-a-number',
        limit: 100,
        threadRootId: 'root',
      })
    ).toEqual({ cursor: 'opaque:not-a-number', limit: 100, threadRootId: 'root' });
    expect(RemoteCommunityHistoryQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('bounds snapshots and requires explicit closure reasons', () => {
    const snapshot = {
      type: 'snapshot',
      room,
      entries: [entry],
      cursor: entry.cursor,
      lastRemoteSeq: 27,
      stale: false,
    };
    expect(RemoteCommunityEventSchema.safeParse(snapshot).success).toBe(true);
    expect(
      RemoteCommunityEventSchema.safeParse({
        ...snapshot,
        entries: Array.from({ length: 101 }, () => entry),
      }).success
    ).toBe(false);
    expect(
      RemoteCommunityEventSchema.safeParse({
        type: 'closed',
        community: 'community_a',
        roomId: 'same-room-id',
        reason: 'revoked',
      }).success
    ).toBe(true);
    expect(RemoteCommunityEventSchema.safeParse({ type: 'closed' }).success).toBe(false);
  });

  it('rejects mixed communities, duplicate entries and timestamp-based history order', () => {
    const snapshot = {
      type: 'snapshot',
      room,
      entries: [entry],
      cursor: entry.cursor,
      lastRemoteSeq: 27,
      stale: false,
    };
    for (const entries of [
      [{ ...entry, community: 'community_b' }],
      [{ ...entry, roomId: 'different-room' }],
      [entry, entry],
      [entry, { ...entry, id: 'older', remoteSeq: 26, createdAt: '2026-09-16T11:00:00Z' }],
    ]) {
      expect(RemoteCommunityEventSchema.safeParse({ ...snapshot, entries }).success).toBe(false);
    }
    expect(RemoteCommunityEventSchema.safeParse({ ...snapshot, lastRemoteSeq: 26 }).success).toBe(
      false
    );
    expect(RemoteCommunityEventSchema.safeParse({ ...snapshot, stale: true }).success).toBe(false);
  });
});

describe('remote roster rows and agent availability (DOR-2878)', () => {
  const ref = 'community-ref';
  const row = {
    community: ref,
    memberId: 'agent-1',
    kind: 'agent' as const,
    displayName: 'Scout',
    handle: 'scout',
    role: null,
    ownerMemberId: 'person-1',
    joinedAt: '2026-10-01T00:00:00.000Z',
  };
  const roster = (members: unknown[]) => ({
    community: ref,
    roomId: 'room-1',
    members,
    stale: false,
  });

  it('reads a row from a space without availability, unchanged', () => {
    expect(RemoteCommunityMembersResponseSchema.parse(roster([row])).members[0]).toEqual(row);
  });

  it('reads an agent row that carries where it runs and whether it is there', () => {
    const reported = {
      ...row,
      runsOn: 'agent-computer',
      lastSeenAt: '2026-10-15T10:00:00.000Z',
      availability: 'offline',
    };
    expect(RemoteCommunityMembersResponseSchema.parse(roster([reported])).members[0]).toEqual(
      reported
    );
    // Never reported: the space says unknown, with nothing behind it.
    expect(() =>
      RemoteCommunityMembersResponseSchema.parse(
        roster([{ ...row, runsOn: null, lastSeenAt: null, availability: 'unknown' }])
      )
    ).not.toThrow();
  });

  it('stays strict: an unknown field or state is refused', () => {
    expect(() =>
      RemoteCommunityMembersResponseSchema.parse(roster([{ ...row, extra: 1 }]))
    ).toThrow();
    expect(() =>
      RemoteCommunityMembersResponseSchema.parse(roster([{ ...row, availability: 'away' }]))
    ).toThrow();
  });
});
