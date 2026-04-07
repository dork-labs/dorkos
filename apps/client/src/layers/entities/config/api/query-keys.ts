/**
 * Query key factory for the config entity. Centralizing keys here lets
 * mutation hooks invalidate every query that depends on `/config` without
 * each callsite needing to know the literal key.
 *
 * @module entities/config/api/query-keys
 */
export const configKeys = {
  /** Root key for all config queries. */
  all: ['config'] as const,
  /** Current server config (version, ports, features, telemetry consent). */
  current: () => [...configKeys.all, 'current'] as const,
};
