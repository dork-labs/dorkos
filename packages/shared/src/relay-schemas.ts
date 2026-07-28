/**
 * Zod schemas for the Relay message bus.
 *
 * Facade module that re-exports all relay schemas from focused sub-modules.
 * Consumers should continue importing from `@dorkos/shared/relay-schemas`.
 *
 * @module shared/relay-schemas
 */
export * from './relay-envelope-schemas.js';
export * from './relay-access-schemas.js';
export * from './relay-adapter-schemas.js';
export * from './relay-adapter-fields.js';
export * from './relay-trace-schemas.js';
