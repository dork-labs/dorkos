/**
 * Who may read which audit rows (spec `audit-trail` §3.4). The one rule every
 * read path applies, for people and agents alike.
 *
 * | Row visibility  | The owner | An agent                              |
 * | --------------- | --------- | ------------------------------------- |
 * | `space`         | yes       | yes                                   |
 * | `participants`  | yes       | only when it is one of the participants |
 * | `admins`        | yes       | never                                 |
 *
 * A local install is a one-person space, so its owner reads everything. When
 * spaces have more than one person, a person reader is added here with the
 * same rules as an agent plus their role's `admins` access, and nothing else
 * changes.
 *
 * @module services/audit/visibility
 */
import { and, eq, or, sql, type SQL } from '@dorkos/db';
import { auditEvents } from '@dorkos/db';
import type { AuditEvent } from '@dorkos/shared/audit-schemas';

/** Who is reading. */
export type AuditReader =
  /** The person who owns this install: reads every row. */
  | { readonly kind: 'owner' }
  /** An agent (or an unidentified caller): reads what the space may, and its own private rows. */
  | { readonly kind: 'agent'; readonly accountId: string };

/** The owner, who reads everything. */
export const OWNER_READER: AuditReader = { kind: 'owner' };

/**
 * Whether `reader` may read `event`.
 *
 * @param reader - Who is reading.
 * @param event - The row.
 */
export function canRead(
  reader: AuditReader,
  event: Pick<AuditEvent, 'visibility' | 'participants'>
): boolean {
  if (reader.kind === 'owner') return true;
  if (event.visibility === 'space') return true;
  if (event.visibility === 'participants') {
    return event.participants?.includes(reader.accountId) ?? false;
  }
  return false;
}

/**
 * The same rule as {@link canRead}, as a SQL condition, so a page is filled
 * with rows the reader may see rather than filtered after the fact.
 *
 * @param reader - Who is reading.
 * @returns A condition, or `undefined` when the reader sees every row.
 */
export function readableBy(reader: AuditReader): SQL | undefined {
  if (reader.kind === 'owner') return undefined;
  // `participants` is canonical JSON, so an id appears exactly as `"<id>"`.
  const quoted = JSON.stringify(reader.accountId);
  const pattern = `%${escapeLike(quoted)}%`;
  return or(
    eq(auditEvents.visibility, 'space'),
    and(
      eq(auditEvents.visibility, 'participants'),
      sql`${auditEvents.participants} LIKE ${pattern} ESCAPE '\\'`
    )
  );
}

/** Escape LIKE wildcards in a literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
