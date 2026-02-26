/**
 * Consolidated Drizzle ORM schema for the DorkOS database.
 *
 * Re-exports all table definitions from domain-specific schema files.
 * Used by drizzle.config.ts for migration generation and by createDb()
 * for query type inference.
 *
 * @module db/schema
 */
export * from './pulse.js';
export * from './relay.js';
export * from './mesh.js';
