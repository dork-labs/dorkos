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
import { createFeatureFlag } from '../../lib/feature-flag.js';

const relayFlag = createFeatureFlag();

/** Mark the Relay message bus as enabled or disabled. */
export const setRelayEnabled = relayFlag.setEnabled;

/** Return whether the Relay message bus is currently enabled. */
export const isRelayEnabled = relayFlag.isEnabled;

/** Record why Relay failed to initialize. */
export const setRelayInitError = relayFlag.setInitError;

/** Return the initialization error message, if any. */
export const getRelayInitError = relayFlag.getInitError;
