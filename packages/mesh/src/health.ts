/**
 * Portable agent health status computation.
 *
 * Replaces the SQLite julianday()-based computation that was
 * not portable to other SQL dialects. Uses TypeScript Date math.
 *
 * @module mesh/health
 */

/** Health status thresholds in minutes. Exported for test use. */
export const ACTIVE_THRESHOLD_MINUTES = 60;
export const INACTIVE_THRESHOLD_MINUTES = 60 * 24; // 1440 minutes

/**
 * Compute agent health status from last_seen_at timestamp.
 *
 * @param lastSeenAt - ISO 8601 timestamp of last agent heartbeat, or null
 * @returns Health status: 'active' (< 1hr), 'inactive' (1-24hr), 'stale' (> 24hr or null)
 */
export function computeHealthStatus(lastSeenAt: string | null): 'active' | 'inactive' | 'stale' {
  if (!lastSeenAt) return 'stale';
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  const diffMinutes = diffMs / 60_000;
  if (diffMinutes < ACTIVE_THRESHOLD_MINUTES) return 'active';
  if (diffMinutes < INACTIVE_THRESHOLD_MINUTES) return 'inactive';
  return 'stale';
}
