/**
 * Portable agent health status computation.
 *
 * Replaces the SQLite julianday()-based computation that was
 * not portable to other SQL dialects. Uses TypeScript Date math.
 *
 * @module mesh/health
 */

/** Health status thresholds in minutes. */
const ACTIVE_THRESHOLD_MINUTES = 5;
const INACTIVE_THRESHOLD_MINUTES = 30;

/**
 * Compute agent health status from last_seen_at timestamp.
 *
 * @param lastSeenAt - ISO 8601 timestamp of last agent heartbeat, or null
 * @returns Health status: 'active' (< 5min), 'inactive' (5-30min), 'stale' (> 30min or null)
 */
export function computeHealthStatus(
  lastSeenAt: string | null,
): 'active' | 'inactive' | 'stale' {
  if (!lastSeenAt) return 'stale';
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  const diffMinutes = diffMs / 60_000;
  if (diffMinutes < ACTIVE_THRESHOLD_MINUTES) return 'active';
  if (diffMinutes < INACTIVE_THRESHOLD_MINUTES) return 'inactive';
  return 'stale';
}
