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

import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';

import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
  type ScriptedTurnRunner,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../../mirror-store.js';

export const REF_A = 'remote_a' as CommunityRef;
export const REF_B = 'remote_b' as CommunityRef;

export function nativeEntry(ref: CommunityRef, roomId: string, seq: number): NativeMirrorEntry {
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

export function wired(
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
    isRevokedMirrorOf: (roomId: string, ownerAuthorId: string) =>
      state.mirrors?.isRevokedMirrorOf(roomId, ownerAuthorId) ?? false,
  };
  const harness = createRoomHarness({ agents, mirrorAccess: access, ...opts });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  state.mirrors = mirrors;
  return { harness, mirrors };
}

export function roomInput(ref: CommunityRef, remoteRoomId: string, ownerAuthorId: string) {
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
