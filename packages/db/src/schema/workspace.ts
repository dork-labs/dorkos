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
    // Ownership, both nullable: NULL/NULL is a unit-of-work checkout, which is
    // what every row created before this column existed is. `owner_ref` holds
    // the owner's stable path (an agent's `project_path`), never a ULID — the
    // reconciler is licensed to rebuild the `agents` cache under fresh ids.
    ownerKind: text('owner_kind'), // 'agent' | NULL
    ownerRef: text('owner_ref'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [uniqueIndex('workspaces_project_key_unique').on(table.projectKey, table.key)]
);
