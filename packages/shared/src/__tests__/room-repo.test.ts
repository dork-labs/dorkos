import { describe, it, expect } from 'vitest';
import {
  LINKED_REPO_UNSUPPORTED_MESSAGE,
  ROOM_REPO_CAP_DEFAULTS,
  RoomRepoModeSchema,
  RoomRepoSidecarSchema,
} from '../room-repo.js';

/** A sidecar exactly as `POST /api/rooms/:id/repo` writes one. */
const sidecar = {
  roomId: '01JQ0000000000000000000000',
  mode: 'owned' as const,
  createdAt: '2026-08-27T12:00:00.000Z',
  createdBy: 'author-dorian',
  defaultBranch: 'main' as const,
  caps: { ...ROOM_REPO_CAP_DEFAULTS },
  lastMergeSeq: null,
};

describe('RoomRepoSidecarSchema', () => {
  it('parses the sidecar an owned repo writes', () => {
    expect(RoomRepoSidecarSchema.parse(sidecar)).toEqual(sidecar);
  });

  it('refuses a linked repo by name rather than by shape', () => {
    // The whole point of keeping `'linked'` in the vocabulary: the operator is
    // told the mode is not built yet, not that `'linked'` is not a string the
    // schema recognises. A `z.literal('owned')` field would give the second.
    const result = RoomRepoSidecarSchema.safeParse({ ...sidecar, mode: 'linked' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(LINKED_REPO_UNSUPPORTED_MESSAGE);
    expect(result.error?.issues[0]?.path).toEqual(['mode']);
  });

  it("keeps 'linked' in the mode vocabulary, so a future sidecar resolves to a name", () => {
    expect(RoomRepoModeSchema.parse('linked')).toBe('linked');
    expect(RoomRepoModeSchema.safeParse('borrowed').success).toBe(false);
  });

  it('fills the caps a sidecar written before they existed does not carry', () => {
    // File-first truth means files outlive schema versions. A sidecar missing
    // the whole caps object, or one leaf of it, gains the ceiling rather than
    // failing to load the room's repo.
    const { caps: _caps, ...withoutCaps } = sidecar;
    expect(RoomRepoSidecarSchema.parse(withoutCaps).caps).toEqual(ROOM_REPO_CAP_DEFAULTS);

    expect(RoomRepoSidecarSchema.parse({ ...sidecar, caps: { maxFileBytes: 1024 } }).caps).toEqual({
      maxFileBytes: 1024,
      maxRepoBytes: ROOM_REPO_CAP_DEFAULTS.maxRepoBytes,
      maxRoomMdBytes: ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
  });

  it('ships the caps spec §3.1 names', () => {
    // Pinned rather than derived: these three numbers are what a merge is
    // refused against, and changing one silently changes what a room accepts.
    expect(ROOM_REPO_CAP_DEFAULTS).toEqual({
      maxFileBytes: 5 * 1024 * 1024,
      maxRepoBytes: 500 * 1024 * 1024,
      maxRoomMdBytes: 24 * 1024,
    });
  });

  it('refuses a branch that is not the integration tree', () => {
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, defaultBranch: 'master' }).success).toBe(
      false
    );
  });

  it('carries the seq of the last merge, and nothing when there has been none', () => {
    expect(RoomRepoSidecarSchema.parse({ ...sidecar, lastMergeSeq: 42 }).lastMergeSeq).toBe(42);
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, lastMergeSeq: -1 }).success).toBe(false);
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, lastMergeSeq: 1.5 }).success).toBe(false);
  });

  it('refuses a sidecar with no room, no author, or no timestamp', () => {
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, roomId: '' }).success).toBe(false);
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, createdBy: '' }).success).toBe(false);
    expect(RoomRepoSidecarSchema.safeParse({ ...sidecar, createdAt: 'yesterday' }).success).toBe(
      false
    );
  });
});
