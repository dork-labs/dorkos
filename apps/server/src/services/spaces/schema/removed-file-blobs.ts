import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities } from '../schema.js';

// Removed files waiting for the sweep (0020), beside `../schema.ts`.

/**
 * A removed file whose bytes are queued but not yet swept, so a later host takedown of its
 * message can hold them again as evidence (0020). The sweep deletes the row with the bytes.
 */
export const removedFileBlobs = pgTable(
  'removed_file_blobs',
  {
    blobKey: text('blob_key').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    entryId: uuid('entry_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    displayName: text('display_name').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    checksum: text('checksum').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    uploaderMemberId: uuid('uploader_member_id'),
    uploaderAgentId: uuid('uploader_agent_id'),
  },
  (table) => [
    index('removed_file_blobs_entry_idx').on(table.communityId, table.entryId),
    check('removed_file_blobs_byte_size_check', sql`${table.byteSize} > 0`),
    check('removed_file_blobs_checksum_check', sql`${table.checksum} ~ '^[a-f0-9]{64}$'`),
  ]
);
