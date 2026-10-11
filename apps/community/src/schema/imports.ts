import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities, hostApiKeys, managedBlobs, members, time, users } from '../schema.js';

// Importing an owner export into a new community (0017 onwards), beside `../schema.ts`.

/**
 * One import of an owner export into a new, unclaimed community. The community is cleared only
 * after a cancelled or failed import's leftovers are removed; the row stays so its creator can
 * read how it ended.
 */
export const communityImports = pgTable(
  'community_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .unique()
      .references(() => communities.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').notNull().default('awaiting_upload'),
    autoCommit: boolean('auto_commit').notNull().default(false),
    uploadTokenHash: text('upload_token_hash').notNull().unique(),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    archiveSha256: text('archive_sha256'),
    archiveBytes: bigint('archive_bytes', { mode: 'number' }),
    archiveReceivedAt: timestamp('archive_received_at', { withTimezone: true }),
    uploadLeaseUntil: timestamp('upload_lease_until', { withTimezone: true }),
    uploadLeaseToken: uuid('upload_lease_token'),
    stagingBlobKey: text('staging_blob_key')
      .unique()
      .references(() => managedBlobs.blobKey, { onDelete: 'set null' }),
    manifestVersion: integer('manifest_version'),
    /** Counts and sizes only, never text or names. */
    report: jsonb('report'),
    failureCode: text('failure_code'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => hostApiKeys.id),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    adoptMemberId: uuid('adopt_member_id').references(() => members.id, { onDelete: 'set null' }),
    /** How the export arrived: one upload, or numbered parts put together by `complete`. */
    uploadKind: text('upload_kind'),
    /** Whether the create request named a description; a version 2 export fills it in if not. */
    descriptionGiven: boolean('description_given').notNull().default(true),
    /** Whether the create request named an admission policy; as for the description. */
    admissionPolicyGiven: boolean('admission_policy_given').notNull().default(true),
    /** Where a version 2 restore stands: step, file, and lines of that file committed. */
    restoreProgress: jsonb('restore_progress'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    check(
      'community_imports_upload_kind',
      sql`${table.uploadKind} IS NULL OR (${table.uploadKind} IN ('single','parts') AND ${table.archiveSha256} IS NOT NULL)`
    ),
    check(
      'community_imports_restore_progress',
      sql`${table.restoreProgress} IS NULL OR jsonb_typeof(${table.restoreProgress}) = 'object'`
    ),
    check(
      'community_imports_idempotency_key',
      sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`
    ),
    check('community_imports_payload_hash', sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check('community_imports_token_hash', sql`${table.uploadTokenHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'community_imports_state',
      sql`${table.state} IN ('awaiting_upload','validating','validated','restoring','ready','failed','cancelled')`
    ),
    check(
      'community_imports_archive',
      sql`(${table.archiveSha256} IS NULL) = (${table.archiveBytes} IS NULL) AND (${table.archiveSha256} IS NULL OR ${table.archiveSha256} ~ '^[a-f0-9]{64}$') AND (${table.archiveBytes} IS NULL OR ${table.archiveBytes} > 0) AND (${table.state} IN ('awaiting_upload','cancelled','failed') OR ${table.archiveSha256} IS NOT NULL) AND (${table.archiveSha256} IS NULL) = (${table.archiveReceivedAt} IS NULL)`
    ),
    check(
      'community_imports_manifest_version',
      sql`${table.manifestVersion} IS NULL OR ${table.manifestVersion} > 0`
    ),
    check(
      'community_imports_report',
      sql`(${table.report} IS NULL) = (${table.state} IN ('awaiting_upload','validating') OR (${table.state} IN ('failed','cancelled') AND ${table.validatedAt} IS NULL))`
    ),
    check(
      'community_imports_failure',
      sql`(${table.state} = 'failed') = (${table.failureCode} IS NOT NULL) AND (${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$')`
    ),
    check('community_imports_attempts', sql`${table.attempts} >= 0`),
    check(
      'community_imports_creator',
      sql`num_nonnulls(${table.createdByUserId}, ${table.createdByApiKeyId}) <= 1`
    ),
    check(
      'community_imports_community',
      sql`${table.communityId} IS NOT NULL OR ${table.settledAt} IS NOT NULL`
    ),
    check(
      'community_imports_settled',
      sql`${table.settledAt} IS NULL OR ${table.state} IN ('ready','failed','cancelled')`
    ),
    index('community_imports_due_idx')
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.settledAt} IS NULL`),
    index('community_imports_settled_idx')
      .on(table.settledAt)
      .where(sql`${table.settledAt} IS NOT NULL`),
  ]
);

/** Restore progress: one row per file an import worker has stored and verified. */
export const communityImportFiles = pgTable(
  'community_import_files',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => communityImports.id, { onDelete: 'cascade' }),
    sourceAttachmentId: uuid('source_attachment_id').notNull(),
    blobKey: text('blob_key')
      .notNull()
      .unique()
      .references(() => managedBlobs.blobKey),
    contentType: text('content_type').notNull(),
    /** A restored attachment, or the community icon (under the nil UUID). */
    purpose: text('purpose').notNull().default('attachment'),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.sourceAttachmentId] }),
    check(
      'community_import_files_purpose',
      sql`${table.purpose} IN ('attachment','icon') AND (${table.purpose} = 'icon') = (${table.sourceAttachmentId} = '00000000-0000-0000-0000-000000000000')`
    ),
  ]
);

/** One uploaded part of an export, stored as a managed blob and put together in order. */
export const communityImportParts = pgTable(
  'community_import_parts',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => communityImports.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    blobKey: text('blob_key')
      .notNull()
      .unique()
      .references(() => managedBlobs.blobKey, { onDelete: 'cascade' }),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.partNumber] }),
    check('community_import_parts_number', sql`${table.partNumber} BETWEEN 1 AND 10000`),
    check('community_import_parts_size', sql`${table.byteSize} > 0`),
    check('community_import_parts_sha256', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  ]
);

/** One part upload in flight on any replica, held by a short renewed lease. */
export const communityImportPartUploads = pgTable(
  'community_import_part_uploads',
  {
    leaseToken: uuid('lease_token').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => communityImports.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    /** The size the upload declared, counted toward the import's limit while it arrives. */
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('community_import_part_uploads_number', sql`${table.partNumber} BETWEEN 1 AND 10000`),
    check('community_import_part_uploads_size', sql`${table.declaredBytes} > 0`),
    index('community_import_part_uploads_import_idx').on(table.importId, table.partNumber),
  ]
);
