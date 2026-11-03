/**
 * How a to-do reads in a list: when it is due, who made it, and the words for the filters.
 *
 * @module features/todos/lib/todo-labels
 */
import type { ListTodosQuery, Todo, TodoView } from '@dorkos/shared/todo-schemas';

/** One day, in milliseconds. */
const DAY_MS = 86_400_000;

/** Within this many days a date reads as a weekday ("Due Thu"); past it, as a date. */
const WEEKDAY_WINDOW_DAYS = 6;

/** The four views, in the order the chips draw them. */
export const TODO_VIEWS: readonly { value: TodoView; label: string }[] = [
  { value: 'mine', label: 'Assigned to me' },
  { value: 'by-me', label: 'Assigned by me' },
  { value: 'agents', label: 'For agents' },
  { value: 'everyone', label: 'Everyone' },
];

/** A due filter, or `any` for none. */
export type TodoDueFilter = NonNullable<ListTodosQuery['due']> | 'any';

/** The due filters, in the order the menu lists them. */
export const TODO_DUE_FILTERS: readonly { value: TodoDueFilter; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No date' },
];

/** A sort order the list can ask for. */
export type TodoSort = NonNullable<ListTodosQuery['sort']>;

/** The two orders: soonest due, or the person's own. */
export const TODO_SORTS: readonly { value: TodoSort; label: string }[] = [
  { value: 'due', label: 'Due' },
  { value: 'rank', label: 'My order' },
];

/** Midnight at the start of a date's local day, epoch ms. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When a to-do is due, in a couple of words: "Overdue", "Due today", "Due tomorrow", "Due Thu"
 * within the week, else "Due Oct 20".
 *
 * @param todo - The to-do: its date and the server's own overdue flag.
 * @param now - The moment to read it from.
 * @returns The label, or null when it has no date or is no longer open.
 */
export function todoDueLabel(
  todo: Pick<Todo, 'dueAt' | 'overdue' | 'state'>,
  now: Date = new Date()
): string | null {
  if (!todo.dueAt || todo.state !== 'open') return null;
  if (todo.overdue) return 'Overdue';
  const when = new Date(todo.dueAt);
  if (Number.isNaN(when.getTime())) return null;
  const days = Math.round((startOfDay(when) - startOfDay(now)) / DAY_MS);
  if (days <= 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= WEEKDAY_WINDOW_DAYS) {
    return `Due ${when.toLocaleDateString(undefined, { weekday: 'short' })}`;
  }
  return `Due ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * Who made a to-do, for the quiet "from" line: you, an agent by name, or a guest.
 *
 * @param assignedBy - The maker the server recorded.
 * @param agentName - Looks up an agent's name by id.
 * @returns The words after "from".
 */
export function assignedByLabel(
  assignedBy: Todo['assignedBy'],
  agentName: (id: string) => string | undefined
): string {
  if (assignedBy.kind === 'person') return 'you';
  if (assignedBy.kind === 'outsider') return 'a guest';
  return agentName(assignedBy.id) ?? assignedBy.id;
}

/**
 * The end of a picked date's local day, as ISO 8601 with this computer's offset, which is the
 * form the server takes a due date in.
 *
 * @param date - A date input's value, `YYYY-MM-DD`.
 * @returns The ISO string, or null for an empty or malformed value.
 */
export function endOfLocalDayIso(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  const local = new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59);
  if (Number.isNaN(local.getTime())) return null;
  const offset = -local.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${m}-${d}T23:59:59${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
