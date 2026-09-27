/**
 * Plain words for connection access, shared by the connectors entity's views.
 *
 * @module entities/connectors/lib/access-copy
 */
import type { ConnectorOperationClassification } from '@dorkos/shared/connector-schemas';

/**
 * A service's display name from its toolkit id when no catalog name is at hand:
 * `gmail` → `Gmail`, `google_calendar` → `Google Calendar`. The one helper for
 * this in the client; prefer the catalog's own `displayName` when you have it.
 */
export function serviceName(toolkit: string): string {
  return toolkit
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const LEVEL_WORDS: Record<ConnectorOperationClassification, string> = {
  read: 'read',
  write: 'write',
  destructive: 'delete',
};

/**
 * What a set of classifications lets an agent do, in words: `read`,
 * `read and write`, `read, write and delete`.
 *
 * @param classifications - The classifications of the granted actions.
 */
export function accessLevelWords(
  classifications: readonly ConnectorOperationClassification[]
): string {
  const words = (['read', 'write', 'destructive'] as const)
    .filter((level) => classifications.includes(level))
    .map((level) => LEVEL_WORDS[level]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
