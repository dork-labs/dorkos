/**
 * The session-level running list (spec `warm-process-lifecycle` D8, FB-18):
 * what each piece of background work under a session IS — its kind, label and
 * start — kept beside the projector's liveness clock so a client can name the
 * work after the turn that started it has been reloaded away.
 *
 * The projector still owns WHICH tasks are running and for how long (its
 * `runningSubagents` map and silence clock, DOR-1100/DOR-1104); this only
 * remembers the facts a start carried, and forgets them when the task ends.
 *
 * @module services/session/projector/running-tasks
 */
import type { BackgroundTaskType } from '@dorkos/shared/types';
import type { RunningTask, SessionEvent } from '@dorkos/shared/session-stream';

/** The facts a `background_task_started` carries onto the durable `subagent_update`. */
export interface StartedTaskFacts {
  taskType?: BackgroundTaskType;
  command?: string;
  startedAt?: number;
}

/**
 * Read the kind, command and start time off a `background_task_started`
 * payload, leaving out whatever it does not name, so absent stays absent on the
 * durable event.
 *
 * @param data - The stream event's loose payload
 */
export function startedTaskFacts(data: Record<string, unknown>): StartedTaskFacts {
  const kind = data.taskType;
  return {
    ...(kind === 'agent' || kind === 'bash' || kind === 'other' ? { taskType: kind } : {}),
    ...(typeof data.command === 'string' && data.command ? { command: data.command } : {}),
    ...(typeof data.startedAt === 'number' ? { startedAt: data.startedAt } : {}),
  };
}

/**
 * The durable `subagent_update` a `background_task_started` becomes: running,
 * with its description, its housekeeping mark (carried so a client that
 * reconnects mid-turn still knows), and the facts the running list names it by.
 * Absent stays absent throughout.
 *
 * @param data - The stream event's loose payload
 */
export function toStartedTaskUpdate(
  data: Record<string, unknown>
): Omit<Extract<SessionEvent, { type: 'subagent_update' }>, 'seq'> {
  return {
    type: 'subagent_update',
    taskId: String(data.taskId ?? ''),
    status: 'running',
    ...(data.description !== undefined ? { description: String(data.description) } : {}),
    ...(data.ambient !== undefined ? { ambient: Boolean(data.ambient) } : {}),
    ...startedTaskFacts(data),
  };
}

/** The `subagent_update` fields this list reads. */
export interface RunningTaskUpdate extends StartedTaskFacts {
  taskId: string;
  description?: string;
}

/**
 * What the projector knows about each running task beyond its clock.
 *
 * Bounded by the projector's own set: an entry is noted on a `running` update
 * and forgotten on the terminal one, and {@link list} only ever reads ids the
 * caller still counts as running.
 */
export class RunningTaskDetails {
  private readonly byTask = new Map<string, RunningTask>();

  /**
   * Merge a `running` update's facts in. A progress report names none of them,
   * so a field the start set is never blanked by a later update.
   *
   * @param update - The update's id and whichever facts it carried
   */
  note(update: RunningTaskUpdate): void {
    const known = this.byTask.get(update.taskId) ?? { taskId: update.taskId };
    this.byTask.set(update.taskId, {
      ...known,
      ...(update.taskType !== undefined ? { taskType: update.taskType } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.command !== undefined ? { command: update.command } : {}),
      ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    });
  }

  /**
   * Drop a task that ended.
   *
   * @param taskId - The ended task's id
   */
  forget(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /**
   * The tasks an activity indicator may show — every running one except
   * housekeeping — in the order they started.
   *
   * @param running - The ids the projector still counts as running
   * @param ambient - The ids the runtime marked as housekeeping
   */
  list(running: Iterable<string>, ambient: ReadonlySet<string>): RunningTask[] {
    const shown: RunningTask[] = [];
    for (const taskId of running) {
      if (!ambient.has(taskId)) shown.push(this.byTask.get(taskId) ?? { taskId });
    }
    return shown;
  }
}

/** What the runtimes say a session's process still runs, by task id. */
type LiveTaskProbe = (sessionId: string) => readonly string[];

/** Wired at startup; until then, and in tests, nothing is reported alive. */
let liveTaskProbe: LiveTaskProbe = () => [];

/**
 * Set how the silence sweep asks the runtimes which tasks are still alive
 * (`AgentRuntime.liveHelperIds`). Called once at startup.
 *
 * @param probe - Every task id a runtime still names live for the session
 */
export function setLiveTaskProbe(probe: LiveTaskProbe): void {
  liveTaskProbe = probe;
}

/**
 * The tasks whose silence outlasted the cutoff and that no runtime still
 * reports alive. A quiet task its runtime still names is not lost — a Monitor
 * or a `tail -f` shell may never send progress — so its clock restarts in
 * `lastSeen` instead (DOR-2065). A probe that throws spares nothing.
 *
 * @param sessionId - The session whose children these are
 * @param lastSeen - Each running child's last-heard time; alive ones are refreshed
 * @param cutoff - Epoch ms at or before which a child counts as silent
 */
export function staleUnlessLive(
  sessionId: string,
  lastSeen: Map<string, number>,
  cutoff: number
): string[] {
  const silent = [...lastSeen].filter(([, at]) => at <= cutoff).map(([taskId]) => taskId);
  if (silent.length === 0) return [];
  let alive: ReadonlySet<string>;
  try {
    alive = new Set(liveTaskProbe(sessionId));
  } catch {
    alive = new Set();
  }
  const now = Date.now();
  for (const taskId of silent) if (alive.has(taskId)) lastSeen.set(taskId, now);
  return silent.filter((taskId) => !alive.has(taskId));
}
