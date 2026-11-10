/** A person's approval for one extension install to read one connected app (DOR-3547). */
import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { connections } from './connections.js';

/** Which extensions folder an approved copy lives in. */
export const EXTENSION_APPROVAL_SCOPES = ['global', 'local'] as const;

/** Which extensions folder an approved copy lives in. */
export type ExtensionApprovalScope = (typeof EXTENSION_APPROVAL_SCOPES)[number];

/**
 * Why DorkOS may trust the approved copy's code not to change without a person
 * (Security Q7): it ships with DorkOS, it came from a source this machine can
 * prove, or a person approved its exact files and the copy is pinned to them.
 * Path-trust, dev-link and agent-built copies have no value here, so they can
 * never hold a grant.
 */
export const EXTENSION_APPROVAL_ORIGINS = ['core', 'trusted_source', 'digest_pinned'] as const;

/** Why DorkOS may trust the approved copy's code. See {@link EXTENSION_APPROVAL_ORIGINS}. */
export type ExtensionApprovalOrigin = (typeof EXTENSION_APPROVAL_ORIGINS)[number];

/** The characters SQLite's `trim` strips here: space, tab, newline and carriage return. */
const BLANKS = sql.raw(`' ' || char(9) || char(10) || char(13)`);

/** A SQL `IN (...)` list of string literals, raw so drizzle-kit writes no bind markers. */
function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}

/**
 * One person's yes for one extension INSTALL to read one connected app.
 *
 * The approval is keyed on the install, not the bare id (Security N2): its
 * scope, the real path of the copy, why that copy's code is trusted, and the
 * digest of the files the person approved. A same-id copy elsewhere is a
 * different install and matches no row. The broker checks the live copy
 * against all four on every call, and a grant is honoured only while the live
 * files digest equals `approved_files_digest` (N1).
 *
 * The grants themselves stay in `connection_operation_grants` (`subject_type =
 * 'extension'`); this row records what was approved and when. Revoking sets
 * `revoked_at`; a live row has none.
 */
export const extensionConnectionApprovals = sqliteTable(
  'extension_connection_approvals',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The extension id, in the manifest id grammar. */
    extensionId: text('extension_id').notNull(),
    /** The extensions folder the approved copy lives in. */
    installScope: text('install_scope').$type<ExtensionApprovalScope>().notNull(),
    /** The real path of the approved copy's folder. */
    installRealPath: text('install_real_path').notNull(),
    /** Why the approved copy's code is trusted. */
    installOrigin: text('install_origin').$type<ExtensionApprovalOrigin>().notNull(),
    /** The normalized `owner/repo` for a `trusted_source` copy; null otherwise. */
    originSource: text('origin_source'),
    /** The digest of the files the person approved. */
    approvedFilesDigest: text('approved_files_digest').notNull(),
    /** The manifest version the person approved. */
    approvedVersion: text('approved_version').notNull(),
    /** The service (toolkit) the manifest declared. */
    service: text('service').notNull(),
    /** The connected account the person picked. */
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** A digest of the sorted operation slugs the person approved. */
    approvedOperationsDigest: text('approved_operations_digest').notNull(),
    /** Who approved it. */
    approvedBy: text('approved_by').notNull(),
    /** ISO time approved. */
    approvedAt: text('approved_at').notNull(),
    /** ISO time revoked, or null while live. */
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('extension_connection_approvals_live_unique')
      .on(table.extensionId, table.installScope, table.installRealPath, table.service)
      .where(sql`"revoked_at" is null`),
    index('extension_connection_approvals_connection_idx').on(table.connectionId),
    check(
      'extension_connection_approvals_scope',
      sql`${table.installScope} IN (${inList(EXTENSION_APPROVAL_SCOPES)})`
    ),
    check(
      'extension_connection_approvals_origin',
      sql`${table.installOrigin} IN (${inList(EXTENSION_APPROVAL_ORIGINS)})`
    ),
    check(
      'extension_connection_approvals_origin_source',
      sql`(${table.installOrigin} = 'trusted_source') = (${table.originSource} IS NOT NULL)`
    ),
    // A source, when there is one, says something (Security S-3).
    check(
      'extension_connection_approvals_origin_source_text',
      sql`${table.originSource} IS NULL OR trim(${table.originSource}, ${BLANKS}) <> ''`
    ),
    // GLOB and substr stop at an embedded NUL, so the byte length must equal
    // the character length too, or `flow\0:agent-1` would pass (Security S-1).
    check(
      'extension_connection_approvals_extension_id',
      sql`${table.extensionId} <> '' AND substr(${table.extensionId}, 1, 1) <> '-' AND ${table.extensionId} NOT GLOB '*[^a-z0-9-]*' AND length(CAST(${table.extensionId} AS BLOB)) = length(${table.extensionId})`
    ),
    check(
      'extension_connection_approvals_digests',
      sql`trim(${table.approvedFilesDigest}, ${BLANKS}) <> '' AND trim(${table.approvedOperationsDigest}, ${BLANKS}) <> ''`
    ),
    // The real path is absolute (Security S-3).
    check(
      'extension_connection_approvals_real_path',
      sql`substr(${table.installRealPath}, 1, 1) = '/' AND length(CAST(${table.installRealPath} AS BLOB)) = length(${table.installRealPath})`
    ),
  ]
);

/** A stored `extension_connection_approvals` row. */
export type ExtensionConnectionApprovalRow = typeof extensionConnectionApprovals.$inferSelect;
