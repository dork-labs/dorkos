/**
 * Deep health checks — the part of `dorkos doctor` that needs a running server.
 *
 * Only what the route and the bootstrap need. The individual checks and
 * collectors are imported directly by their tests; re-exporting them here as
 * well would be a second public name for each with no caller.
 *
 * @module services/observability/deep-health
 */
export { runDeepHealthChecks, type DeepHealthDeps } from './run.js';
