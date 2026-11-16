/**
 * The session-level running set: the background work a session's stream
 * projection still counts as running, and names (DOR-1100, spec
 * `warm-process-lifecycle` D8).
 *
 * A background task OUTLIVES the turn that launched it, and the per-turn record
 * of it does not: the turn-end reconcile's history reload wipes it about a
 * second after the turn closes, while the work is still going. So the set is
 * held at the session level, in parity with the server projector, and
 * `status.runningSubagents` keeps each task's kind and label beside it — which
 * is what lets the composer's strip keep a helper's row through that reload
 * (FB-18).
 *
 * @module entities/session/model/stream/running-subagents
 */
import type { BackgroundTaskStatus } from '@dorkos/shared/types';
import type { RunningTask, SessionEvent, SessionStatus } from '@dorkos/shared/session-stream';

/** A `subagent_update` stream event. */
type SubagentUpdate = Extract<SessionEvent, { type: 'subagent_update' }>;

/** The slice of a session's projection the running set lives in. */
export interface RunningSubagentFold {
  /** The session's status; `runningSubagentCount` and `runningSubagents` are written here. */
  status: SessionStatus | null;
  /** Running children this projection can name, housekeeping excluded. */
  runningSubagentIds: string[];
  /** Running children the runtime marked as housekeeping. */
  ambientSubagentIds: string[];
  /** Children the server counted at hydration that this projection cannot name. */
  unnamedRunningSubagents: number;
}

/**
 * Re-derive `status.runningSubagentCount` from the two things that know: the
 * children this projection can name, and the ones the server counted before it
 * arrived.
 */
function syncRunningSubagentCount(session: RunningSubagentFold): void {
  if (!session.status) return;
  session.status.runningSubagentCount =
    session.runningSubagentIds.length + session.unnamedRunningSubagents;
}

/** The facts an update carries about a task, absent ones left out. */
function factsOf(event: SubagentUpdate): Omit<RunningTask, 'taskId'> {
  return {
    ...(event.taskType !== undefined ? { taskType: event.taskType } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.command !== undefined ? { command: event.command } : {}),
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
  };
}

/**
 * Keep `status.runningSubagents` naming exactly the running, non-housekeeping
 * children: merge a running update's facts in, drop a task that ended or turned
 * out to be housekeeping. A progress report names none of the facts, so it
 * never blanks what the start said.
 */
function syncRunningList(
  session: RunningSubagentFold,
  event: SubagentUpdate,
  shown: boolean
): void {
  if (!session.status) return;
  const list = session.status.runningSubagents ?? [];
  const at = list.findIndex((task) => task.taskId === event.taskId);
  if (!shown) {
    if (at >= 0) session.status.runningSubagents = list.filter((_, i) => i !== at);
    return;
  }
  const facts = factsOf(event);
  // A progress report names nothing new: keep the same array, so nothing
  // reading the list re-renders on every tool a helper calls.
  if (at >= 0 && Object.keys(facts).length === 0) return;
  const merged: RunningTask = { ...(list[at] ?? { taskId: event.taskId }), ...facts };
  session.status.runningSubagents =
    at >= 0 ? list.map((task, i) => (i === at ? merged : task)) : [...list, merged];
}

/**
 * Fold one `subagent_update` into the session-level running set (DOR-1100).
 *
 * Mirrors the server projector's `applySubagentUpdate`, with one extra case it
 * does not need: a terminal update for an id this projection never saw start is
 * one of the {@link RunningSubagentFold.unnamedRunningSubagents} finishing, so it
 * decrements that instead of doing nothing. Without that arm, a session hydrated
 * mid-background-work would report those children as running forever.
 *
 * The status is a negative check on the whole enum rather than a list of
 * terminal values, so a status added later (`untracked`, DOR-1108) drains the
 * count instead of silently pinning it.
 *
 * The housekeeping mark rides only the start and the terminal update, so the
 * answer is remembered in {@link RunningSubagentFold.ambientSubagentIds} and
 * every arm below reads the remembered answer, never the event alone.
 * Housekeeping children are excluded from the count outright, failed ones
 * included: this is a count of what is RUNNING, and a failure is not running.
 *
 * @param session - The session projection to mutate.
 * @param event - The update.
 */
export function applyRunningSubagent(session: RunningSubagentFold, event: SubagentUpdate): void {
  const { taskId, ambient } = event;
  const status: BackgroundTaskStatus = event.status;
  if (ambient === true || session.ambientSubagentIds.includes(taskId)) {
    if (status === 'running') {
      if (!session.ambientSubagentIds.includes(taskId)) session.ambientSubagentIds.push(taskId);
    } else {
      // Terminal: forget it, so the list stays bounded by the live children.
      session.ambientSubagentIds = session.ambientSubagentIds.filter((id) => id !== taskId);
    }
    // A child DorkOS had already counted before the mark arrived has to leave
    // the count now: after this it is skipped, so nothing else ever would.
    if (session.runningSubagentIds.includes(taskId)) {
      session.runningSubagentIds = session.runningSubagentIds.filter((id) => id !== taskId);
      syncRunningSubagentCount(session);
    }
    syncRunningList(session, event, false);
    return;
  }
  const known = session.runningSubagentIds.includes(taskId);
  if (status === 'running') {
    // Progress reports repeat `running` for a child already counted — adding it
    // again would inflate the tally with every tool the child uses.
    if (!known) session.runningSubagentIds.push(taskId);
  } else if (known) {
    session.runningSubagentIds = session.runningSubagentIds.filter((id) => id !== taskId);
  } else {
    session.unnamedRunningSubagents = Math.max(0, session.unnamedRunningSubagents - 1);
  }
  syncRunningSubagentCount(session);
  syncRunningList(session, event, status === 'running');
}

/**
 * Re-baseline the running set against a snapshot's own answer (DOR-1100).
 *
 * A snapshot carries the server's count, its named list (servers since D8),
 * and the current turn's events. The children the list or the turn names are
 * named here; anything the count covers beyond them is a child from an earlier
 * turn this projection cannot name, and is booked as
 * {@link RunningSubagentFold.unnamedRunningSubagents}. Housekeeping children
 * the turn shows are remembered, because the live events that follow carry the
 * mark no more reliably than the ones inside it did.
 *
 * @param session - The session projection to mutate; its `status` is replaced.
 * @param status - The snapshot's status.
 * @param turn - The snapshot's `inProgressTurn`, in seq order.
 */
export function rebaseRunningSubagents(
  session: RunningSubagentFold,
  status: SessionStatus,
  turn: readonly SessionEvent[]
): void {
  const facts = new Map<string, RunningTask>();
  const running = new Map<string, boolean>();
  const ambient = new Set<string>();
  for (const event of turn) {
    if (event.type !== 'subagent_update') continue;
    if (event.ambient) ambient.add(event.taskId);
    running.set(event.taskId, event.status === 'running');
    facts.set(event.taskId, {
      ...(facts.get(event.taskId) ?? { taskId: event.taskId }),
      ...factsOf(event),
    });
  }
  const list = new Map((status.runningSubagents ?? []).map((task) => [task.taskId, task]));
  for (const [taskId, live] of running) {
    if (!live || ambient.has(taskId)) list.delete(taskId);
    else list.set(taskId, { ...facts.get(taskId)!, ...list.get(taskId) });
  }
  session.runningSubagentIds = [...list.keys()];
  session.ambientSubagentIds = [...running]
    .filter(([id, live]) => live && ambient.has(id))
    .map(([id]) => id);
  session.unnamedRunningSubagents = Math.max(
    0,
    status.runningSubagentCount - session.runningSubagentIds.length
  );
  // Re-assign rather than mutate: the caller's snapshot object is frozen, and
  // the two parts must add back up to the count. Copying also stops the store
  // aliasing an object it does not own.
  session.status = {
    ...status,
    runningSubagentCount: session.runningSubagentIds.length + session.unnamedRunningSubagents,
    ...(status.runningSubagents !== undefined || list.size > 0
      ? { runningSubagents: [...list.values()] }
      : {}),
  };
}
