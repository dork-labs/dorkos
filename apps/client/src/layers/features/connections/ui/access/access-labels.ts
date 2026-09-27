/**
 * Words the access card uses for levels and names.
 *
 * @module features/connections/ui/access/access-labels
 */
import type { CardAccessLevel, HeldAccess } from '../../lib/access-card-selection';

/** The switch's two levels. */
export const LEVEL_LABELS: Record<CardAccessLevel, string> = {
  read: 'Read',
  'read-write': 'Read and write',
};

/** What a row says an agent holds today. */
export const HELD_LABELS: Record<Exclude<HeldAccess, 'none'>, string> = {
  ...LEVEL_LABELS,
  custom: 'Exact actions',
};

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
export function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
