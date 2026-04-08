/**
 * Config entity — domain hooks for reading and patching the persisted server
 * configuration. Wraps the `/config` Transport endpoints in TanStack Query so
 * any feature can subscribe to live config state and mutate it without each
 * callsite re-implementing the query/key/invalidation plumbing.
 *
 * @module entities/config
 */

export { configKeys } from './api/query-keys';
export { useConfig } from './model/use-config';
export { useUpdateConfig } from './model/use-update-config';
