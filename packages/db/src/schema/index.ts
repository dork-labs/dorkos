/**
 * Consolidated Drizzle ORM schema for the DorkOS database.
 *
 * Re-exports all table definitions from domain-specific schema files.
 * Used by drizzle.config.ts for migration generation and by createDb()
 * for query type inference.
 *
 * @module db/schema
 */
export * from './a2a.js';
export * from './activity.js';
export * from './approvals.js';
export * from './approval-grants.js';
export * from './agent-identity.js';
export * from './tasks.js';
export * from './relay.js';
export * from './mesh.js';
export * from './sessions.js';
export * from './codex.js';
export * from './opencode.js';
export * from './session-events.js';
export * from './workspace.js';
export * from './auth.js';
export * from './connected-accounts.js';
export * from './connector-attachments.js';
export * from './rooms.js';
export * from './room-coordination.js';
export * from './read-cursors.js';
export * from './bridges.js';
export * from './search.js';
