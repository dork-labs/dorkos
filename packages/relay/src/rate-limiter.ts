/**
 * Per-sender sliding window rate limiting for the Relay message bus.
 *
 * Pure functions with no side effects. The rate limit check runs ONCE
 * at publish-time, before fan-out. The caller provides the current
 * message count from the SQLite index; this module only decides
 * whether the sender is within their limit.
 *
 * @module relay/rate-limiter
 */
import type { RateLimitConfig, RateLimitResult } from './types.js';

/**
 * Default rate limit configuration: 100 messages per 60-second window.
 *
 * Agent senders (`agent:*`) get a much higher limit because a single agent
 * response stream can easily produce 100+ events (text_delta, thinking_delta,
 * tool_call_start/delta/end, session_status, approval_required, etc.).
 * Without this override, the rate limiter silently drops critical events
 * like approval_required mid-stream.
 */
const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: true,
  windowSecs: 60,
  maxPerWindow: 100,
  perSenderOverrides: {
    'agent:': 2000,
  },
};

/**
 * Check whether a sender has exceeded their rate limit.
 *
 * Uses a sliding window log derived from the messages table.
 * The rate limit check runs ONCE at publish-time, before fan-out.
 *
 * @param sender - The sender's subject identifier.
 * @param countInWindow - Number of messages sent by this sender in the current window.
 * @param config - Rate limit configuration.
 * @returns A RateLimitResult indicating whether the message is allowed.
 */
export function checkRateLimit(
  sender: string,
  countInWindow: number,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG
): RateLimitResult {
  if (!config.enabled) {
    return { allowed: true };
  }

  // Check per-sender overrides first (longest prefix match)
  const limit = resolveLimit(sender, config);

  if (countInWindow >= limit) {
    return {
      allowed: false,
      reason: `rate limit exceeded: ${countInWindow}/${limit} messages in ${config.windowSecs}s window`,
      currentCount: countInWindow,
      limit,
    };
  }

  return { allowed: true, currentCount: countInWindow, limit };
}

/**
 * Resolve the effective rate limit for a sender.
 * Checks perSenderOverrides (longest prefix match), falls back to maxPerWindow.
 *
 * @param sender - The sender's subject identifier.
 * @param config - Rate limit configuration containing optional per-sender overrides.
 * @returns The effective message limit for this sender.
 */
export function resolveLimit(sender: string, config: RateLimitConfig): number {
  if (!config.perSenderOverrides) return config.maxPerWindow;

  let bestMatch = '';
  let bestLimit = config.maxPerWindow;

  for (const [prefix, limit] of Object.entries(config.perSenderOverrides)) {
    if (sender.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
      bestLimit = limit;
    }
  }

  return bestLimit;
}

export { DEFAULT_RATE_LIMIT_CONFIG };
