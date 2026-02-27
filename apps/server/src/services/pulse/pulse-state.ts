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
import { createFeatureFlag } from '../../lib/feature-flag.js';

const pulseFlag = createFeatureFlag();

/** Mark the Pulse scheduler as enabled or disabled. */
export const setPulseEnabled = pulseFlag.setEnabled;

/** Return whether the Pulse scheduler is currently enabled. */
export const isPulseEnabled = pulseFlag.isEnabled;

/** Record why Pulse failed to initialize. */
export const setPulseInitError = pulseFlag.setInitError;

/** Return the initialization error message, if any. */
export const getPulseInitError = pulseFlag.getInitError;
