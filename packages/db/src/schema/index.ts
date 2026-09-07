/**
 * Consolidated Drizzle ORM schema for the DorkOS database.
 *
 * Re-exports the live runtime tables used by createDb() for query type inference.
 * Historical generator-only declarations are listed directly in drizzle.config.ts
 * and stay outside this barrel.
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
export * from './unclaimed-chats.js';
export * from './connectors/connections.js';
export * from './connectors/connector-events.js';
export * from './connectors/connector-review-requests.js';
export * from './connectors/connector-usage.js';
export * from './connectors/connector-execution-state.js';
export * from './connectors/connector-local-state.js';
export * from './rooms.js';
export * from './room-coordination.js';
export * from './read-cursors.js';
export * from './bridges.js';
export * from './search.js';
export * from './notifications.js';
