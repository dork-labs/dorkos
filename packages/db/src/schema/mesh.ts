import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

/** Registered mesh agents. Replaces mesh/mesh.db 'agents' table. */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  displayName: text('display_name'),
  runtime: text('runtime').notNull(),
  projectPath: text('project_path').notNull().unique(),
  namespace: text('namespace').notNull().default('default'),
  capabilities: text('capabilities_json').notNull().default('[]'), // JSON array
  entrypoint: text('entrypoint'),
  version: text('version'),
  description: text('description'),
  approver: text('approver'),
  status: text('status', {
    enum: ['active', 'inactive', 'unreachable'],
  })
    .notNull()
    .default('active'),
  scanRoot: text('scan_root').notNull().default(''),
  behaviorJson: text('behavior_json').notNull().default('{"responseMode":"always"}'),
  lastSeenAt: text('last_seen_at'), // ISO 8601 TEXT
  lastSeenEvent: text('last_seen_event'),
  persona: text('persona'),
  personaEnabled: integer('persona_enabled', { mode: 'boolean' }).notNull().default(true),
  traitsJson: text('traits_json'), // JSON string of Traits — null = no traits configured
  conventionsJson: text('conventions_json'), // JSON string of Conventions — null = no conventions configured
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  color: text('color'),
  icon: text('icon'),
  registeredAt: text('registered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // manifest_json DROPPED — redundant with individual structured columns
});

/**
 * First-class cross-namespace ALLOW rules owned by Mesh (mesh #16).
 *
 * Mesh is the authority for which namespace pairs may talk; it projects each
 * rule one-directionally into Relay access rules (Relay stays the enforcer).
 * Topology reads THIS table instead of reverse-engineering Relay rule strings
 * with a regex, so a subject-grammar change can no longer silently corrupt the
 * topology view. Only user-managed cross-namespace allows live here; the
 * provisioning-time defaults (same-namespace allow, cross-namespace deny,
 * system-agent bridge) remain Relay-only constants written at registration.
 */
export const meshNamespaceRules = sqliteTable(
  'mesh_namespace_rules',
  {
    sourceNamespace: text('source_namespace').notNull(),
    targetNamespace: text('target_namespace').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceNamespace, table.targetNamespace] })]
);

/** Paths denied from mesh registration. Replaces 'denials' table. */
export const agentDenials = sqliteTable('agent_denials', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  reason: text('reason'),
  denier: text('denier'),
  createdAt: text('created_at').notNull(),
});
