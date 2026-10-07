import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { canvasDocChannels } from './channel.js';

/** Hash-only retained possession evidence; these rows do not independently grant document access. */
export const canvasDocChannelTokens = sqliteTable(
  'canvas_doc_channel_tokens',
  {
    tokenId: text('token_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    allowedTypes: text('allowed_types', { mode: 'json' }).$type<string[]>().notNull(),
    directions: text('directions', { mode: 'json' })
      .$type<('upstream' | 'downstream' | 'system')[]>()
      .notNull(),
    permissions: text('permissions', { mode: 'json' })
      .$type<('ingest' | 'replay' | 'stream')[]>()
      .notNull(),
    creatorId: text('creator_id').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    /** Original native issuer fills all binding fields; no public DTO may reconstruct authority from them. */
    bindingVersion: integer('binding_version').notNull(),
    documentScope: text('document_scope').notNull(),
    documentGeneration: text('document_generation').notNull(),
    documentBirth: text('document_birth', { mode: 'json' })
      .$type<{
        physicalId: string;
        openedAt: string;
        documentId: string;
        createdAt: string;
      }>()
      .notNull(),
    documentIncarnation: text('document_incarnation', { mode: 'json' }).$type<unknown>().notNull(),
    declarationHash: text('declaration_hash').notNull(),
    manifestHash: text('manifest_hash'),
    approvedGrantBindings: text('approved_grant_bindings', { mode: 'json' })
      .$type<unknown>()
      .notNull(),
    issuerBinding: text('issuer_binding', { mode: 'json' }).$type<unknown>().notNull(),
  },
  (table) => [
    uniqueIndex('canvas_doc_channel_tokens_hash_unique').on(table.tokenHash),
    index('canvas_doc_channel_tokens_document_idx').on(
      table.documentId,
      table.revokedAt,
      table.expiresAt
    ),
  ]
);
