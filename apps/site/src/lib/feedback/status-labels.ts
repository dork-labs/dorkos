/**
 * Cockpit-visible status vocabulary for a feedback submission
 * (feedback-pipeline design-decisions.md §7): `Received → Triaged →
 * In progress → Shipped vX.Y.Z / Closed`. Shared by the public `/feedback/[id]`
 * status page here; the cockpit's own tracking view keeps an independent copy
 * (`apps/client`, a separate app with its own build) rather than importing
 * across the app boundary.
 *
 * @module lib/feedback/status-labels
 */
import type { FeedbackStatus } from '@/db/feedback-schema';

/**
 * Human label for a status, folding in the shipped version when present.
 *
 * @param status - The row's `status` column.
 * @param shippedVersion - The row's `shippedVersion`, only meaningful when
 *   `status === 'shipped'`.
 */
export function feedbackStatusLabel(
  status: FeedbackStatus,
  shippedVersion?: string | null
): string {
  switch (status) {
    case 'received':
      return 'Received';
    case 'triaged':
      return 'Triaged';
    case 'in_progress':
      return 'In progress';
    case 'shipped':
      return shippedVersion ? `Shipped v${shippedVersion}` : 'Shipped';
    case 'closed':
      return 'Closed';
  }
}
