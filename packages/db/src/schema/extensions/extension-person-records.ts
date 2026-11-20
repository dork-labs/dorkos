import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * What an extension recorded while a signed-in person's request was running
 * (`ctx.personRecord`, DOR-4301): the SHA-256 of what it recorded and when.
 *
 * The host keeps it, not the extension. An extension's own data folder is its
 * to write, so a field there saying "a person did this" proves nothing; a row
 * here exists only because the host saw the record made inside a request that
 * passed the person bar. An extension checks a claim against this table, never
 * against its own file.
 *
 * Keyed by extension and hash, so one extension can never answer for another,
 * and the first record of the same content keeps its time.
 */
export const extensionPersonRecords = sqliteTable(
  'extension_person_records',
  {
    /** The extension that recorded it. */
    extensionId: text('extension_id').notNull(),
    /** Lowercase hex SHA-256 of the recorded content, as the host computed it. */
    hash: text('hash').notNull(),
    /** When it was first recorded (ISO 8601). */
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.extensionId, table.hash] })]
);

/** A row of {@link extensionPersonRecords}. */
export type ExtensionPersonRecordRow = typeof extensionPersonRecords.$inferSelect;
