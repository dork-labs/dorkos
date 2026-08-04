/**
 * Render a `shippedVersion` for display (feedback-pipeline Part 4).
 *
 * A Linear project-milestone or cycle *name* isn't guaranteed to be a bare
 * version — teams are free to name either anything ("Cycle 12", "Q3 push").
 * Prefixing `v` unconditionally would render "Shipped vCycle 12", which
 * reads as a broken version rather than the plain milestone name it is.
 * Only a value that actually looks like a bare version gets the `v` prefix;
 * anything else is shown as-is.
 *
 * Behaviorally-identical twin of `apps/site/src/lib/feedback/version-label.ts`
 * (the site's shipped email and public status page both use that copy) —
 * `apps/client` is a separate app with its own build and cannot import
 * across that boundary, the same reasoning the cockpit's independent
 * status-label switch already follows. Keep the two in lockstep by hand; a
 * change to one is a prompt to change the other.
 *
 * @module features/feedback-requests/lib/version-label
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
