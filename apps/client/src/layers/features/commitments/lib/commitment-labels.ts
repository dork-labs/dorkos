/**
 * How a commitment reads in a list: when it is due, and who it was made to.
 *
 * @module features/commitments/lib/commitment-labels
 */
import { COMMITMENT_EXTERNAL_PREFIX, type Commitment } from '@dorkos/shared/commitment-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';

/**
 * When a promise is due, in a few words: "Due 3:00 PM" today, "Due Fri 3:00 PM"
 * within a week, else "Due Oct 20". A date already past reads "Overdue · Mon
 * 3:00 PM", never the way a future date reads.
 *
 * @param iso - The due date, or null.
 * @param now - The moment to read it from.
 * @returns The label, or null when there is no due date.
 */
export function dueLabel(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const prefix = when.getTime() < now.getTime() ? 'Overdue ·' : 'Due';
  const clock = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay) return `${prefix} ${clock}`;
  const days = Math.abs(when.getTime() - now.getTime()) / 86_400_000;
  if (days < 6) {
    return `${prefix} ${when.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
  }
  return `${prefix} ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * Who a promise was made to, for the line under it: an outsider by the name
 * given, an agent or person by their roster name, else the raw value.
 *
 * @param to - The stored recipient, or null.
 * @param nameOf - Looks up a roster name by id, when the caller has a roster.
 * @returns The label, or null when nobody was named.
 */
export function toLabel(
  to: string | null,
  nameOf?: (id: string) => string | null | undefined
): string | null {
  if (!to) return null;
  if (to.startsWith(COMMITMENT_EXTERNAL_PREFIX)) {
    return `To ${to.slice(COMMITMENT_EXTERNAL_PREFIX.length)}`;
  }
  return `To ${nameOf?.(to) ?? to}`;
}

/**
 * Split a list into the open promises and the closed ones, keeping the
 * server's order (open soonest due first, closed newest first).
 *
 * @param commitments - The list as the server sent it.
 */
export function splitCommitments(commitments: readonly Commitment[]): {
  open: Commitment[];
  closed: Commitment[];
} {
  return {
    open: commitments.filter((c) => c.state === 'open'),
    closed: commitments.filter((c) => c.state !== 'open'),
  };
}

/** The word a closed promise's state reads as. */
export const CLOSED_STATE_LABEL: Record<Exclude<Commitment['state'], 'open'>, string> = {
  kept: 'Kept',
  missed: 'Missed',
  dropped: 'Dropped',
};

/**
 * A name lookup over the team roster, by roster id or an agent's Mesh id (the
 * id a commitment names its agent by).
 *
 * @param roster - Everyone on the team.
 * @returns A function from id to display name, or undefined when nobody matches.
 */
export function rosterNameLookup(
  roster: readonly TeamMember[]
): (id: string) => string | undefined {
  const names = new Map<string, string>();
  for (const member of roster) {
    names.set(member.id, member.displayName);
    if (member.agent?.manifestId) names.set(member.agent.manifestId, member.displayName);
  }
  return (id) => names.get(id);
}
