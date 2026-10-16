/** Original ordinary-save evidence; never a checkbox approval or a replayable write command. */
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { canvasDocChannels } from './channel.js';

export const canvasDocFileSaveIntents = sqliteTable(
  'canvas_doc_file_save_intents',
  {
    intentId: text('intent_id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    eventId: text('event_id').notNull(),
    requestHash: text('request_hash').notNull(),
    incarnation: text('incarnation', { mode: 'json' }).notNull(),
    source: text('source', { mode: 'json' }).notNull(),
    owner: text('owner', { mode: 'json' }).notNull(),
    canonicalPath: text('canonical_path').notNull(),
    beforeDevice: text('before_device').notNull(),
    beforeInode: text('before_inode').notNull(),
    beforeHash: text('before_hash').notNull(),
    afterHash: text('after_hash').notNull(),
    replacementDevice: text('replacement_device'),
    replacementInode: text('replacement_inode'),
    status: text('status', {
      enum: ['prepared', 'staged', 'committed', 'no_op', 'in_doubt', 'failed'],
    }).notNull(),
    docSeq: integer('doc_seq'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'canvas_doc_file_save_status_valid',
      sql`"status" in ('prepared','staged','committed','no_op','in_doubt','failed')`
    ),
    check(
      'canvas_doc_file_save_sequence_valid',
      sql`("status" = 'committed' AND "doc_seq" IS NOT NULL AND "doc_seq" > 0) OR ("status" != 'committed' AND "doc_seq" IS NULL)`
    ),
    check(
      'canvas_doc_file_save_replacement_pair',
      sql`("replacement_device" IS NULL) = ("replacement_inode" IS NULL)`
    ),
    check(
      'canvas_doc_file_save_replacement_phase',
      sql`("status" NOT IN ('staged','committed') OR "replacement_inode" IS NOT NULL) AND ("status" NOT IN ('prepared','no_op','failed') OR "replacement_inode" IS NULL)`
    ),
    check(
      'canvas_doc_file_save_noop_valid',
      sql`"status" != 'no_op' OR "before_hash" = "after_hash"`
    ),
    uniqueIndex('canvas_doc_file_save_intents_event_unique').on(table.documentId, table.eventId),
    index('canvas_doc_file_save_intents_recovery_idx').on(table.status, table.updatedAt),
    // A second document opened on the same path cannot bypass an unresolved ordinary replacement.
    uniqueIndex('canvas_doc_file_save_intents_active_path_unique')
      .on(table.canonicalPath)
      .where(sql`"status" in ('prepared', 'staged', 'in_doubt')`),
  ]
);
