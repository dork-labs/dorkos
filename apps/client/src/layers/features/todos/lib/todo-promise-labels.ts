/**
 * How a to-do reads in a list: when it is due, and who it was made to.
 *
 * @module features/todos/lib/todo-promise-labels
 */
import { TODO_EXTERNAL_PREFIX, type TodoPromise } from '@dorkos/shared/todo-promise-schemas';
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
  if (to.startsWith(TODO_EXTERNAL_PREFIX)) {
    return `To ${to.slice(TODO_EXTERNAL_PREFIX.length)}`;
  }
  return `To ${nameOf?.(to) ?? to}`;
}

/** How long a kept promise waits for its person's answer before it reads as unconfirmed. */
const CONFIRM_WINDOW_MS = 86_400_000;

/**
 * Whether a kept promise is still waiting for its person's Yes or Not yet (DOR-3034): asked, and
 * kept within the last day. Past that it reads "Kept · unconfirmed" and asks nothing more.
 *
 * @param todoPromise - The promise.
 * @param now - The moment to judge it at.
 */
export function awaitsConfirm(
  todoPromise: Pick<TodoPromise, 'state' | 'confirmState' | 'closedAt'>,
  now: Date = new Date()
): boolean {
  if (todoPromise.state !== 'kept' || todoPromise.confirmState !== 'asked') return false;
  const closed = todoPromise.closedAt ? Date.parse(todoPromise.closedAt) : NaN;
  return !Number.isNaN(closed) && now.getTime() - closed < CONFIRM_WINDOW_MS;
}

/**
 * The word a closed promise reads as: its state, and "unconfirmed" on a kept one nobody answered.
 *
 * @param todoPromise - The closed promise.
 * @param now - The moment to judge it at.
 */
export function closedLabel(
  todoPromise: Pick<TodoPromise, 'state' | 'confirmState' | 'closedAt'>,
  now: Date = new Date()
): string {
  if (todoPromise.state === 'open') return '';
  const word = CLOSED_STATE_LABEL[todoPromise.state];
  if (todoPromise.confirmState === 'asked' && !awaitsConfirm(todoPromise, now)) {
    return `${word} · unconfirmed`;
  }
  return word;
}

/**
 * Split a list into the open promises, the kept ones waiting for the person's answer, and the
 * closed ones, keeping the server's order (open soonest due first, closed newest first).
 *
 * @param to-dos - The list as the server sent it.
 * @param now - The moment to judge a waiting answer at.
 */
export function splitTodos(
  todoPromises: readonly TodoPromise[],
  now: Date = new Date()
): {
  open: TodoPromise[];
  confirm: TodoPromise[];
  closed: TodoPromise[];
} {
  return {
    open: todoPromises.filter((c) => c.state === 'open'),
    confirm: todoPromises.filter((c) => awaitsConfirm(c, now)),
    closed: todoPromises.filter((c) => c.state !== 'open' && !awaitsConfirm(c, now)),
  };
}

/** The word a closed promise's state reads as. */
export const CLOSED_STATE_LABEL: Record<Exclude<TodoPromise['state'], 'open'>, string> = {
  kept: 'Kept',
  missed: 'Missed',
  dropped: 'Dropped',
};

/**
 * A name lookup over the team roster, by roster id or an agent's Mesh id (the
 * id a to-do names its agent by).
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
