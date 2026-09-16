/**
 * Durable mappings for authorized remote-community room mirrors.
 *
 * A remote room and entry never borrow a local id: the local room log is a
 * cache, and these rows retain the qualified address and the authoritative
 * remote order that make that distinction enforceable after a restart.
 *
 * @module db/schema/community-mirrors
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** One remote room projected into this install's ordinary room tables. */
export const communityRoomMirrors = sqliteTable(
  'community_room_mirrors',
  {
    /** The local `rooms.id`; it is deliberately unrelated to `remoteRoomId`. */
    localRoomId: text('local_room_id').primaryKey(),
    /** Locally minted connection ref, never an id supplied by the remote server. */
    communityRef: text('community_ref').notNull(),
    /** Opaque id within that community. Only unique beside `communityRef`. */
    remoteRoomId: text('remote_room_id').notNull(),
    /** The local owner whose connection made this cache entry possible. */
    ownerAuthorId: text('owner_author_id').notNull(),
    /** `authorized`, owner-scoped read-only `stale`, or immediately hidden `revoked`. */
    state: text('state').notNull(),
    /** The last time a live remote authorization check admitted this room. */
    authorizedAt: text('authorized_at').notNull(),
  },
  (table) => [
    uniqueIndex('community_room_mirrors_ref_remote_room_unique').on(
      table.communityRef,
      table.remoteRoomId
    ),
    index('idx_community_room_mirrors_owner_state').on(table.ownerAuthorId, table.state),
  ]
);

/** The locally authorized readers of one mirror, including explicitly enrolled agents. */
export const communityMirrorAccess = sqliteTable(
  'community_mirror_access',
  {
    localRoomId: text('local_room_id').notNull(),
    /** Local author id. Remote identities are never access principals here. */
    authorId: text('author_id').notNull(),
    /** A current grant, or a revoked grant that cannot be resurrected by stale rows. */
    state: text('state').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.localRoomId, table.authorId] }),
    index('idx_community_mirror_access_author_state').on(table.authorId, table.state),
  ]
);

/** One imported entry's qualified remote identity and authoritative remote sequence. */
export const communityMirrorEntries = sqliteTable(
  'community_mirror_entries',
  {
    communityRef: text('community_ref').notNull(),
    remoteRoomId: text('remote_room_id').notNull(),
    remoteEntryId: text('remote_entry_id').notNull(),
    localRoomId: text('local_room_id').notNull(),
    /** Local `room_entries.id`, intentionally minted locally. */
    localEntryId: text('local_entry_id').notNull(),
    /** The native community wire sequence; never derived from timestamps or cursors. */
    remoteSeq: integer('remote_seq').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.communityRef, table.remoteRoomId, table.remoteEntryId] }),
    uniqueIndex('community_mirror_entries_room_remote_seq_unique').on(
      table.localRoomId,
      table.remoteSeq
    ),
    uniqueIndex('community_mirror_entries_local_entry_unique').on(table.localEntryId),
    index('idx_community_mirror_entries_room_seq').on(table.localRoomId, table.remoteSeq),
  ]
);
