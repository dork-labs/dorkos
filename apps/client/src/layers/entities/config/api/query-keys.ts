/**
 * The config entity's query key — re-exported from `shared/`, where it now
 * lives so that every layer can reach it (`shared/model/server-config/query-keys`).
 *
 * Kept as a re-export rather than deleted: `@/layers/entities/config` is where
 * the rest of the app already imports `configKeys` from, and the key belonging
 * to the entity is still the right story to tell at this layer.
 *
 * @module entities/config/api/query-keys
 */
export { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/shared/model';
