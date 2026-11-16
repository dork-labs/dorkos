/**
 * Read-time projection and ordering for agent-owned to-dos.
 *
 * @module services/todos/todo-promise-view
 */
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import type { AgentTodoRow } from './todo-promise-store.js';

/**
 * Whether a to-do is overdue at `now`: open, with a due date in the past.
 *
 * @param row - The stored row.
 * @param now - The moment to judge it at, in epoch ms.
 */
export function isOverdue(row: Pick<AgentTodoRow, 'state' | 'dueAt'>, now: number): boolean {
  if (row.state !== 'open' || !row.dueAt) return false;
  const due = Date.parse(row.dueAt);
  return !Number.isNaN(due) && due < now;
}

/**
 * Turn a stored row into what readers see, computing `overdue`.
 *
 * @param row - The stored row.
 * @param now - The moment to judge overdue at, in epoch ms.
 */
export function toTodoPromise(row: AgentTodoRow, now: number): TodoPromise {
  return {
    id: row.id,
    agentId: row.agentId,
    to: row.toAccount,
    what: row.what,
    dueAt: row.dueAt,
    originalDueAt: row.originalDueAt,
    scoreDueAt: row.scoreDueAt,
    moveCount: row.moveCount,
    state: row.state,
    overdue: isOverdue(row, now),
    sourceSessionId: row.sourceSessionId,
    sourceRoomEntryId: row.sourceRoomEntryId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    note: row.note,
  };
}

/**
 * Compare two promises in reading order: open and soonest due first, then recently closed.
 *
 * @param a - The first promise.
 * @param b - The second promise.
 */
export function readingOrder(a: TodoPromise, b: TodoPromise): number {
  const openA = a.state === 'open' ? 0 : 1;
  const openB = b.state === 'open' ? 0 : 1;
  if (openA !== openB) return openA - openB;
  if (a.state === 'open') {
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.dueAt && !b.dueAt) return -1;
    if (!a.dueAt && b.dueAt) return 1;
  }
  if (a.state !== 'open') {
    const ca = a.closedAt ?? '';
    const cb = b.closedAt ?? '';
    if (ca !== cb) return ca < cb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}
