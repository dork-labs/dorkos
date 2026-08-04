/**
 * Render a `shippedVersion` for display (feedback-pipeline Part 4).
 *
 * `resolveShippedVersion` (`lib/feedback/linear-status-map.ts`) reads a
 * Linear project-milestone or cycle *name* verbatim — teams are free to name
 * either anything ("Cycle 12", "Q3 push"), not just a version string.
 * Prefixing `v` unconditionally would render "Shipped vCycle 12", which
 * reads as a broken version rather than the plain milestone name it is.
 * Only a value that actually looks like a bare version gets the `v` prefix;
 * anything else is shown as-is.
 *
 * The one place this decision is made for `apps/site` — shared by the
 * shipped email (`lib/mailer.ts`) and the public status page
 * (`lib/feedback/status-labels.ts`), so both agree. `apps/client` is a
 * separate app with its own build and cannot import across that boundary
 * (same reasoning `status-labels.ts` already documents for its own
 * status-label switch), so its `FeedbackRequestsPanel` keeps an independent,
 * behaviorally-identical copy of this exact function — cross-referenced in
 * both directions so a future change to one is a prompt to change the other.
 *
 * @module lib/feedback/version-label
 */

/**
 * A bare semver-shaped prefix (`1.2`, `1.2.3`, `1.2.3-beta`, …) — deliberately
 * loose (major.minor is enough), just strict enough to reject a Linear
 * milestone/cycle name that merely happens to sit in the `shippedVersion`
 * column.
 */
const BARE_VERSION_RE = /^\d+\.\d+/;

/**
 * Format a `shippedVersion` value for display, prefixing `v` only when it
 * looks like a bare version.
 *
 * @param shippedVersion - The row's `shippedVersion` value.
 */
export function formatShippedVersionLabel(shippedVersion: string): string {
  return BARE_VERSION_RE.test(shippedVersion) ? `v${shippedVersion}` : shippedVersion;
}
