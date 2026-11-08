/**
 * Which to-dos a list shows, in what order, and the rail badge (DOR-3088). Pure: the service hands
 * it the rows and the clock.
 *
 * Known v1 limits, both fine at one person's scale and both noted for later:
 *
 * - It reads every row and filters here, rather than in SQL.
 * - "Due today" and the badge end the day at midnight UTC, not on the person's own clock.
 *
 * @module services/todos/todo-list
 */
import type { TodoRow } from '@dorkos/db';
import { isOverdue, PERSON_ASSIGNER } from './todo-promise-service.js';
import type { TodoListFilter } from './todo-service.js';

/** The rows a list shows, before they are turned into to-dos. */
export interface TodoRowList {
  /** The rows, open first. */
  rows: TodoRow[];
  /** How many done or declined ones the view hides. */
  doneCount: number;
  /** The person's open to-dos due today or overdue. */
  badge: number;
}

/**
 * The rows for a view, open first: soonest due (no date last) or the assignee's own order
 * (unranked last), then newest. Done ones only when asked, counted either way.
 *
 * @param all - Every stored row.
 * @param filter - The view and its filters.
 * @param now - The moment to judge due dates at.
 */
export function listTodoRows(
  all: readonly TodoRow[],
  filter: TodoListFilter,
  now: Date
): TodoRowList {
  const nowMs = now.getTime();
  const endOfToday = `${now.toISOString().slice(0, 10)}T23:59:59.999Z`;
  const weekAhead = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  const mine = (row: TodoRow) => row.ownerAccount === PERSON_ASSIGNER;
  const view = filter.view ?? 'mine';
  const inView = all.filter((row) => {
    if (view === 'mine' && !mine(row)) return false;
    if (view === 'by-me' && row.assignedByKind !== 'person') return false;
    if (view === 'agents' && !row.agentId) return false;
    if (filter.agentId && row.agentId !== filter.agentId) return false;
    if (filter.roomId && row.roomId !== filter.roomId) return false;
    if (filter.due === 'none' && row.dueAt) return false;
    if (filter.due === 'overdue' && !isOverdue(row, nowMs)) return false;
    if (filter.due === 'today' && (!row.dueAt || row.dueAt > endOfToday)) return false;
    if (filter.due === 'week' && (!row.dueAt || row.dueAt > weekAhead)) return false;
    return true;
  });
  const open = inView.filter((row) => row.state === 'open');
  const done = inView.filter((row) => row.state !== 'open');
  const byDue = (a: TodoRow, b: TodoRow) =>
    (a.dueAt ?? '\uffff').localeCompare(b.dueAt ?? '\uffff') ||
    b.createdAt.localeCompare(a.createdAt);
  const byRank = (a: TodoRow, b: TodoRow) =>
    (a.rank ?? '\uffff').localeCompare(b.rank ?? '\uffff') || byDue(a, b);
  open.sort(filter.sort === 'rank' ? byRank : byDue);
  done.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const rows = [...open, ...(filter.showDone ? done : [])].slice(0, filter.limit ?? 500);
  const badge = all.filter(
    (row) => mine(row) && row.state === 'open' && row.dueAt !== null && row.dueAt <= endOfToday
  ).length;
  return { rows, doneCount: done.length, badge };
}
