import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Server-managed isolated workspaces (DOR-84). Derived cache of the file-first
 * per-workspace manifests (ADR-0043): the sidecar `<key>.workspace.json` is the
 * source of truth; this table is rebuilt from it by the reconciler. Keyed for
 * reuse by `(project_key, key)`.
 */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(), // ULID
    projectKey: text('project_key').notNull(),
    key: text('key').notNull(),
    path: text('path').notNull().unique(),
    source: text('source').notNull(),
    branch: text('branch'),
    provider: text('provider').notNull(), // 'worktree' | 'clone'
    status: text('status').notNull(), // 'provisioning' | 'ready' | 'failed' | 'removing'
    portBase: integer('port_base').notNull(),
    portBlockSize: integer('port_block_size').notNull(),
    hostname: text('hostname'), // reserved for the v2 naming layer (DOR-91)
    url: text('url'), // reserved for the v2 naming layer (DOR-91)
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [uniqueIndex('workspaces_project_key_unique').on(table.projectKey, table.key)]
);
