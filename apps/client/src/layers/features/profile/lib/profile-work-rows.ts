/**
 * The Work fold: what an agent has been doing. Its chats, schedules, promises,
 * how it wakes, and every action on record.
 *
 * @module features/profile/lib/profile-work-rows
 */
import type { ProfileRowGroup, ProfileRowModel, ProfileRowsContext } from './profile-rows';
import { nextCheckMeta, wakeRowValue } from './heartbeat-words';
import { countValue, fold, summaryOf } from './profile-row-parts';

/** How long ago, in the two or three characters a row's trailing meta can carry. */
function lastWords(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const elapsed = Math.max(0, Date.now() - then);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'last just now';
  if (minutes < 60) return `last ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last ${hours} h`;
  return `last ${Math.floor(hours / 24)} d`;
}

/** When the next run fires, as a clock time — or a weekday when it is not today. */
function nextWords(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return undefined;
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  const clock = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay
    ? `next ${clock}`
    : `next ${when.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
}

/**
 * The To-dos row: how many promises are open, and how many are overdue.
 * Drawn on every agent's profile, because anyone may read any agent's list.
 */
function todosRow(ctx: ProfileRowsContext): ProfileRowModel {
  const summary = ctx.todoPromises;
  return {
    id: 'todos',
    kind: 'nav',
    label: 'To-dos',
    value: countValue(summary?.open, 'open', 'open'),
    ...(summary && summary.overdue > 0 ? { meta: `${summary.overdue} overdue` } : {}),
    page: 'todos',
  };
}

/**
 * The Heartbeat row: how this agent wakes, and when it next checks in. Drawn
 * on every agent's profile, like To-dos.
 */
function heartbeatRow(ctx: ProfileRowsContext): ProfileRowModel {
  const status = ctx.heartbeat;
  const meta =
    status?.enabled && status.wake === 'timed'
      ? nextCheckMeta(status.nextBeatAt, new Date(ctx.now ?? Date.now()))
      : undefined;
  return {
    id: 'heartbeat',
    kind: 'nav',
    label: 'Heartbeat',
    value: status ? wakeRowValue(status) : null,
    ...(meta ? { meta } : {}),
    page: 'heartbeat',
  };
}

/**
 * Work: what this agent has been doing — its conversations, its schedules, its
 * promises, how it wakes, and every action on record.
 *
 * The same rows for an agent you manage and for DorkBot — what DorkBot
 * withholds is its identity, not its work.
 *
 * @param ctx - The row context.
 */
export function workFold(ctx: ProfileRowsContext): ProfileRowGroup {
  const facts = ctx.facts;
  const tasksAvailable = facts?.tasksAvailable !== false;
  const rows: ProfileRowModel[] = [
    {
      id: 'sessions',
      kind: 'nav',
      label: 'Chats',
      value: countValue(facts?.sessions?.count, 'chat', 'chats'),
      meta: lastWords(facts?.sessions?.newestAt ?? null),
      page: 'sessions',
    },
  ];
  // Not "0 scheduled" and not a locked row: an install with the tasks tool off
  // has no such thing as a schedule, so there is nothing here to name (§1.4).
  if (tasksAvailable) {
    rows.push({
      id: 'tasks',
      kind: 'nav',
      label: 'Schedules',
      value: countValue(facts?.tasks?.count, 'scheduled', 'scheduled'),
      meta: nextWords(facts?.tasks?.nextRunAt ?? null),
      page: 'tasks',
    });
  }
  rows.push(todosRow(ctx));
  // Yours only, so it is here and not on someone else's agent: the prompts are private.
  rows.push({
    id: 'work-queue',
    kind: 'nav',
    label: 'Work queue',
    value: null,
    page: 'work-queue',
  });
  rows.push(heartbeatRow(ctx));
  // What it did, and what was done to it, from the audit log. No value: a count
  // of every recorded action is a number nobody acts on.
  rows.push({ id: 'activity', kind: 'nav', label: 'Activity', value: null, page: 'activity' });
  return fold(
    'work',
    'Work',
    rows,
    summaryOf([
      // Beside a DM with Show sessions off, the Chats row is left out, so its
      // count is too.
      ctx.quietSessionDetail ? null : countValue(facts?.sessions?.count, 'chat', 'chats'),
      tasksAvailable ? countValue(facts?.tasks?.count, 'schedule', 'schedules') : null,
      ctx.todoPromises ? `${ctx.todoPromises.open} open` : null,
    ])
  );
}

/**
 * Someone else's agent's Work fold: its promises and how it wakes, which anyone
 * may read. Its chats and schedules are not theirs to see.
 *
 * @param ctx - The row context.
 */
export function otherAgentWorkFold(ctx: ProfileRowsContext): ProfileRowGroup {
  return fold(
    'work',
    'Work',
    [todosRow(ctx), heartbeatRow(ctx)],
    ctx.todoPromises ? `${ctx.todoPromises.open} open` : null
  );
}
