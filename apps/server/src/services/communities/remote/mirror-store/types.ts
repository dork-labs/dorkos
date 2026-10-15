/**
 * The value shapes a remote community mirror reads and writes: its rooms, entries, purges and
 * redaction pages, and the read-side port room visibility consumes.
 *
 * @module services/communities/remote/mirror-store/types
 */
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';

/** The current remote authorization state represented by a local cache row. */
export type MirrorState = 'authorized' | 'stale' | 'revoked';

/** A local principal allowed to read an imported room. */
export interface MirrorAccessor {
  authorId: string;
  responseMode?: ResponseMode;
}

/** Remote room data that is safe to project into the local cache. */
export interface MirrorRoomInput {
  communityRef: CommunityRef;
  remoteRoomId: string;
  title: string;
  topic: string | null;
  ownerAuthorId: string;
  accessors: readonly MirrorAccessor[];
  authorizedAt: string;
}

/** The native-only sequence retained beside an opaque generic community entry. */
export interface NativeMirrorEntry {
  entry: CommunityEntry;
  /** The authoritative sequence emitted by the native community wire. */
  remoteSeq: number;
  /** The raw remote author id and display label; it is always external locally. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' };
}

/** One owner-authorized cached entry with its native provenance metadata. */
export interface CachedRemoteEntry {
  entry: CommunityEntry;
  remoteSeq: number;
  /** Null only for rows cached before native author metadata was retained. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' } | null;
}

/** What a revocation removed from this machine, for the stores beside the room log. */
export interface MirrorPurge {
  /** Local rooms whose entries were deleted. */
  localRoomIds: readonly string[];
  /** Files that belonged to those entries; their bytes are the caller's to delete. */
  attachments: readonly { roomId: string; attachmentId: string; extension: string }[];
}

/** One stored file of a local room: where its bytes live. */
export interface MirrorAttachmentFile {
  roomId: string;
  attachmentId: string;
  extension: string;
}

/** What one page of the redaction feed changed in a mirror. */
export interface AppliedRedactions {
  localRoomId: string;
  /** Local `seq` of every room entry rewritten, for re-indexing. */
  changedSeqs: readonly number[];
  /**
   * Files whose rows this page deleted, because the Community no longer has them on the entry
   * (DOR-2549). Their bytes are the caller's to delete, after the commit.
   */
  droppedAttachments: readonly MirrorAttachmentFile[];
}

/** One persisted mirror invalidated because no active enrolled agent still sees it. */
export interface RevokedRemoteMirrorRoom {
  localRoomId: string;
  remoteRoomId: string;
}

export interface MirrorRoomAccess {
  /** `null` means the local room is not a remote mirror. */
  canRead(roomId: string, authorId: string): boolean | null;
  /** Whether owner-wide search/listing needs the mirror-aware path. */
  hasMirrors(): boolean;
  /** Whether this room is a revoked mirror of this owner's connection. */
  isRevokedMirrorOf(roomId: string, ownerAuthorId: string): boolean;
}
