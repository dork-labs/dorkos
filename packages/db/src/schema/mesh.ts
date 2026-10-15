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
  // Execution defaults the agent carries (spec `execution-defaults` E2). Cached
  // here, not only on the manifest, because the agent LIST is what the Settings
  // exceptions strip reads to name every agent that differs from the server
  // default — a list view that would otherwise have to open every agent.json on
  // disk to answer. NULL = inherit.
  model: text('model'),
  effort: text('effort'),
  // Which Claude Code account this agent's new sessions bill to, as a registry
  // id (spec `billing-account-ladder`). Cached beside `model`/`effort` and for
  // the same reason: the agent LIST is what the Settings exceptions strip reads
  // to name every agent that differs from the server default, and answering
  // that from disk would mean opening every agent.json. NULL = inherit.
  account: text('account'),
  // Who this agent reports to and which account created it (spec `heartbeats`
  // §4.1), mirrored from `.dork/agent.json` by the reconciler (ADR-0043) so the
  // reports-to chain can be walked from the agent LIST without opening every
  // manifest on disk. Account ids: a mesh ULID for an agent, an account id for
  // a person. NULL = not set (the chain falls back to the creator, then the
  // owner) and unknown creator respectively.
  reportsTo: text('reports_to'),
  createdBy: text('created_by'),
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

/**
 * Agents that are paused everywhere, one row per paused agent (spec
 * `audit-trail` PR5).
 *
 * Current state only: a row exists while the agent is paused and is deleted
 * when the pause is lifted. Who paused or resumed it, when and why lives in the
 * audit log (`agent.paused`, `agent.resumed`), which keeps every change. The
 * row outlives a restart, so a paused agent stays paused.
 */
export const agentPauses = sqliteTable('agent_pauses', {
  /** The paused agent's mesh id. */
  agentId: text('agent_id').primaryKey(),
  /** Stable account id of who paused it (a person's account, an agent's mesh id). */
  pausedBy: text('paused_by').notNull(),
  /** That account's kind: `person`, `agent`, `system` or `external`. */
  pausedByKind: text('paused_by_kind').notNull(),
  /** That account's name at the time. */
  pausedByName: text('paused_by_name').notNull(),
  /** When it was paused. ISO 8601 UTC. */
  pausedAt: text('paused_at').notNull(),
  /** Why, when whoever paused it said. */
  reason: text('reason'),
});
