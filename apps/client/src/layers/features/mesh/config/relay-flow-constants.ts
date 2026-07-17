/**
 * Tuning constants for the topology's relay-flow pulse animation.
 *
 * @module features/mesh/config/relay-flow-constants
 */

/**
 * Zoom level below which a pulse is not rendered. Lower than the existing
 * `0.7` label-visibility threshold in `BindingEdge` because a moving dot
 * reads at a smaller scale than text — below this, the dot is sub-pixel
 * noise rather than a legible signal.
 */
export const PULSE_MIN_ZOOM = 0.5;

/**
 * Maximum number of concurrently active pulses across the whole topology.
 * Bounds the active animation count on a large mesh; MVP meshes are small,
 * so this is a guard rail, not an expected ceiling.
 */
export const MAX_CONCURRENT_PULSES = 24;

/**
 * Duration (ms) of a single pulse's travel + fade. Kept here so the store's
 * coalescing window and the `BindingEdge` motion transition agree on one
 * constant rather than two hand-synced literals.
 */
export const PULSE_DURATION_MS = 800;
