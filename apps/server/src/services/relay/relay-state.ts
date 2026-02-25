/**
 * Lightweight relay feature state registry.
 *
 * Holds the runtime enabled/disabled state of the Relay message bus so that
 * the config route can report it without a circular dependency on index.ts.
 * Set once during server startup by `index.ts` when RelayCore is
 * initialized.
 *
 * @module services/relay-state
 */

/** Mutable Relay runtime state shared across the server process. */
const state = {
  enabled: false,
};

/**
 * Mark the Relay message bus as enabled.
 *
 * Called once from `index.ts` after `RelayCore` is successfully created.
 */
export function setRelayEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

/**
 * Return whether the Relay message bus is currently enabled.
 *
 * Consumed by the config route to populate `relay.enabled` in the GET response.
 */
export function isRelayEnabled(): boolean {
  return state.enabled;
}
