/**
 * The root of every model-catalog cache key.
 *
 * Lives in `shared` rather than beside the query it keys, because the flows that
 * INVALIDATE it do not all sit above the entity that reads it. Provisioning a
 * runtime is an `entities/runtime` concern, and an entity may not import a
 * sibling entity (`.claude/rules/fsd-layers.md`) — so a key parked in
 * `entities/session` would have been reachable from the features layer and
 * nowhere else, silently leaving the provision path unable to refresh a menu its
 * own install had just changed. A cache key is an address, not domain logic, so
 * `shared` is where it belongs and every layer can name it.
 *
 * Invalidating by this prefix refreshes every cached runtime/session variant at
 * once, which is what connecting a provider actually means (DOR-1660).
 *
 * @module shared/lib/models-query-key
 */

/** Prefix shared by every model-catalog query key. */
export const MODELS_KEY = ['models'] as const;
