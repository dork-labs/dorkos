/**
 * Latest unresolved sign-in subjects. An account-scoped subject clears only
 * itself; legacy runtime-only rows remain readable. Read state never clears a
 * live condition. Arrival order is not trusted across refetches and live events.
 * @module widgets/app-banner/lib/dead-runtime-signins
 */
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

/**
 * Return unresolved subjects, comparing creation time then id for ties.
 * @param notifications - Notification rows in any arrival order.
 */
export function deadSigninRuntimes(notifications: readonly NotificationDTO[]): string[] {
  const latest = new Map<string, NotificationDTO>();
  for (const row of notifications) {
    if (row.kind !== 'signin.required') continue;
    const held = latest.get(row.subject.id);
    if (held === undefined || isNewer(row, held)) latest.set(row.subject.id, row);
  }
  return [...latest.entries()]
    .filter(([, row]) => row.outcome !== 'cleared')
    .map(([runtime]) => runtime);
}

/**
 * Whether `row` was raised after `held`, comparing the ISO timestamp first and
 * falling back to the ULID id when two rows share a millisecond.
 */
function isNewer(row: NotificationDTO, held: NotificationDTO): boolean {
  if (row.createdAt !== held.createdAt) return row.createdAt > held.createdAt;
  return row.id > held.id;
}
