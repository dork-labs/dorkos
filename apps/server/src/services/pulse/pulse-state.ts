/**
 * Lightweight pulse feature state registry.
 *
 * Holds the runtime enabled/disabled state of the Pulse scheduler so that
 * the config route can report it without a circular dependency on index.ts.
 * Set once during server startup by `index.ts` when the scheduler is
 * initialized.
 *
 * @module services/pulse-state
 */

/** Mutable Pulse runtime state shared across the server process. */
const state = {
  enabled: false,
};

/**
 * Mark the Pulse scheduler as enabled.
 *
 * Called once from `index.ts` after `SchedulerService` is successfully created.
 */
export function setPulseEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

/**
 * Return whether the Pulse scheduler is currently enabled.
 *
 * Consumed by the config route to populate `pulse.enabled` in the GET response.
 */
export function isPulseEnabled(): boolean {
  return state.enabled;
}
