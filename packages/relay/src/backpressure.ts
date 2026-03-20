/**
 * Reactive backpressure load-shedding for the Relay message bus.
 *
 * Pure function with no side effects. Checks mailbox depth against
 * a configurable maximum and returns a pressure metric (0.0-1.0)
 * for proactive capacity signaling.
 *
 * @module relay/backpressure
 */
import type { BackpressureConfig, BackpressureResult } from './types.js';

/** Default backpressure configuration. */
const DEFAULT_BP_CONFIG: BackpressureConfig = {
  enabled: true,
  maxMailboxSize: 1000,
  pressureWarningAt: 0.8,
};

/**
 * Check backpressure for an endpoint.
 *
 * Computes a pressure ratio from the current mailbox depth and the
 * configured maximum. When the mailbox is at or above capacity, delivery
 * is rejected with a descriptive reason. The pressure metric is always
 * capped at 1.0, even when the mailbox exceeds `maxMailboxSize`.
 *
 * Division by zero is handled gracefully: when `maxMailboxSize` is 0,
 * pressure is reported as 0.
 *
 * @param currentSize - Number of unprocessed messages (status='new') for this endpoint.
 * @param config - Backpressure configuration.
 * @returns A BackpressureResult with allowed flag and pressure metric.
 */
export function checkBackpressure(
  currentSize: number,
  config: BackpressureConfig = DEFAULT_BP_CONFIG
): BackpressureResult {
  if (!config.enabled) {
    return { allowed: true, currentSize, pressure: 0 };
  }

  const pressure =
    config.maxMailboxSize > 0 ? Math.min(currentSize / config.maxMailboxSize, 1.0) : 0;

  if (currentSize >= config.maxMailboxSize) {
    return {
      allowed: false,
      reason: `backpressure: mailbox full (${currentSize}/${config.maxMailboxSize})`,
      currentSize,
      pressure,
    };
  }

  return { allowed: true, currentSize, pressure };
}

export { DEFAULT_BP_CONFIG };
