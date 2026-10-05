/**
 * Work Codex keeps running after a turn ends, and waking the chat when it
 * finishes (spec `codex-app-server-transport` §12, DOR-2717 item 8).
 *
 * ## What Codex does (verified on the 0.154 binary, `app-server.binary.test.ts`)
 *
 * A command the model starts with a short `yield_time_ms` keeps running as a
 * background terminal: its `commandExecution` item is still `inProgress` when
 * `turn/completed` arrives, `thread/backgroundTerminals/list` names it, and
 * when it ends an `item/completed` arrives under the OLD turn's id with its
 * exit code and output. Codex itself starts no turn: the model hears about it
 * only if someone opens one. A helper agent (`subAgentActivity`) that
 * outlives its turn ends the same way.
 *
 * ## What DorkOS does with it
 *
 * Each such task is tracked from the end of its turn. Its late completion is:
 *
 * - shown in the turn that is open on the session, when there is one (the
 *   model is running and needs no wake);
 * - otherwise collected for {@link WAKE_COALESCE_MS}, so a burst of
 *   completions becomes ONE wake, and handed to the runtime as a
 *   {@link BackgroundWake}: the completions, and whether to start a model turn.
 *
 * A model turn starts only when the work's own turn ended normally
 * (`completed`). After a stop or a failure the completion is shown and
 * nothing more: the person stopped it, and DorkOS does not restart it behind
 * their back. A task a person stopped (or the ceiling stopped) never wakes.
 *
 * ## The lesson from the Claude Code wake (DOR-2065)
 *
 * **Nothing here wakes on a clock.** A wake follows a completion and nothing
 * else, so a terminal that never ends — `pnpm dev`, a watcher — never wakes
 * the chat, let alone repeatedly. The only timer per task is the four-hour
 * ceiling ({@link BACKGROUND_CEILING_MS}), which stops the task and reports it
 * WITHOUT waking the model: a wake there would invite the agent to start the
 * same never-ending thing again, every four hours, for ever.
 *
 * Losing the process is not a completion either. Measured on 0.154: a
 * background command OUTLIVES a killed `codex app-server`, so a crash is
 * reported as "DorkOS lost track of it", never as "stopped".
 *
 * @module services/runtimes/codex/app-server/background-work
 */
import { SESSIONS } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';
import type { ServerNotification } from './protocol/methods.js';

/** Completions arriving within this window become one wake. */
export const WAKE_COALESCE_MS = 1_500;

/**
 * The longest a queued message waits on a wake that has not opened yet
 * (`AgentRuntime.isSegmentPending` must be bounded).
 */
export const SEGMENT_PENDING_BOUND_MS = 5_000;

/**
 * How long a background task may run after its turn before DorkOS stops it:
 * the same four hours, and the same reasoning, as Claude Code's
 * `BACKGROUND_WORK_PARK_CEILING_MS`, which it reads.
 */
export const BACKGROUND_CEILING_MS = SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS;

/** How much of a finished command's output its report carries. */
export const OUTPUT_TAIL_CHARS = 2_048;

/** Reconciliations a tracked terminal may be missing from before it is dropped. */
const MISSING_LIMIT = 2;

/** What the person reads when the process went away with work in it. */
export const BACKGROUND_WORK_LOST_COPY =
  'Codex stopped. DorkOS lost track of its background work, which may still be running.';

/** What the person reads when the ceiling stopped a task. */
export const BACKGROUND_CEILING_COPY = 'Stopped after running four hours in the background.';

/** What the person reads when the ceiling could not stop a task. */
export const BACKGROUND_CEILING_FAILED_COPY =
  'DorkOS could not stop a background command after four hours. It may still run.';

/** One piece of work running past its turn. */
export interface BackgroundTask {
  /** The item id (a command) or the helper's thread id (a sub-agent). */
  readonly taskId: string;
  /** A command or a helper agent. */
  readonly kind: 'bash' | 'agent';
  /** The DorkOS session it belongs to. */
  readonly sessionId: string;
  /** The Codex thread it runs in. */
  readonly threadId: string;
  /** The app-server process it lives in. */
  readonly processKey: string;
  /** A command's background terminal id, for `terminate`. */
  readonly processId?: string;
  /** The command line, or the helper's path. */
  readonly label: string;
  /** How the turn that started it ended (`completed`, `interrupted`, `failed`). */
  readonly turnStatus: string;
  /**
   * The starting turn's own options, opaque here: the runtime hands them to
   * the turn a wake starts, so it runs as the same agent with the same
   * settings. Absent means a wake must not start a model turn.
   */
  readonly context?: unknown;
}

/** One finished task, as reported. */
export interface BackgroundCompletion {
  /** The task's id. */
  readonly taskId: string;
  /** A command or a helper agent. */
  readonly kind: 'bash' | 'agent';
  /** The command line, or the helper's path. */
  readonly label: string;
  /** How it ended. */
  readonly status: 'completed' | 'failed' | 'stopped';
  /** Exit code and output tail, or the helper's outcome. */
  readonly summary: string;
  /** Whether this completion may start a model turn. */
  readonly wakes: boolean;
  /** The starting turn's options ({@link BackgroundTask.context}). */
  readonly context?: unknown;
}

/** One wake, handed to the runtime. */
export interface BackgroundWake {
  /** The session to wake. */
  readonly sessionId: string;
  /** What finished, in order. */
  readonly completions: readonly BackgroundCompletion[];
  /** Whether to start a model turn after showing them. */
  readonly startTurn: boolean;
  /** Plain status lines to show (a lost process). */
  readonly notices: readonly string[];
}

/** Dependencies of {@link CodexBackgroundWork}. */
export interface CodexBackgroundWorkOptions {
  /**
   * Hand a wake to the runtime. `true` when it was taken (a runtime turn
   * opened), `false` when nobody is listening.
   */
  readonly onWake: (wake: BackgroundWake) => boolean;
  /**
   * Stop a task that reached the ceiling: `true` when it was stopped, `false`
   * when Codex says it had already ended (its result is on its way).
   */
  readonly terminate: (task: BackgroundTask) => Promise<boolean>;
  /** Told when a session's pending wake was dropped without opening. */
  readonly onGateChange?: (sessionId: string) => void;
  /** Coalescing window. */
  readonly coalesceMs?: number;
  /** Bound on a pending wake. */
  readonly pendingBoundMs?: number;
  /** The background ceiling. */
  readonly ceilingMs?: number;
  /** Awake-time clock (ms); `performance.now` by default. */
  readonly now?: () => number;
}

interface TrackedTask {
  readonly task: BackgroundTask;
  /** Set when a person or the ceiling asked it to stop: it never wakes. */
  stopping: 'person' | 'ceiling' | undefined;
  /** Set once Codex confirmed it terminated the task. */
  terminated: boolean;
  /** Reconciliations it has been missing from in a row. */
  missing: number;
  readonly ceiling: ReturnType<typeof setTimeout>;
}

interface PendingWake {
  readonly since: number;
  readonly completions: BackgroundCompletion[];
  readonly notices: string[];
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Background tasks per session, and the one wake each burst of completions
 * earns. Pure bookkeeping and timers: the transport feeds it notifications and
 * performs the terminations it asks for.
 */
export class CodexBackgroundWork {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly pending = new Map<string, PendingWake>();
  private readonly coalesceMs: number;
  private readonly pendingBoundMs: number;
  private readonly ceilingMs: number;
  private readonly now: () => number;

  /**
   * Construct an empty tracker.
   *
   * @param options - Where wakes go, how to stop a task, and the timings.
   */
  constructor(private readonly options: CodexBackgroundWorkOptions) {
    this.coalesceMs = options.coalesceMs ?? WAKE_COALESCE_MS;
    this.pendingBoundMs = options.pendingBoundMs ?? SEGMENT_PENDING_BOUND_MS;
    this.ceilingMs = options.ceilingMs ?? BACKGROUND_CEILING_MS;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Start tracking work a turn left running.
   *
   * @param tasks - What its turn left behind.
   */
  track(tasks: readonly BackgroundTask[]): void {
    for (const task of tasks) {
      if (this.tasks.has(task.taskId)) continue;
      const ceiling = setTimeout(() => this.reachCeiling(task.taskId), this.ceilingMs);
      ceiling.unref?.();
      this.tasks.set(task.taskId, {
        task,
        stopping: undefined,
        terminated: false,
        missing: 0,
        ceiling,
      });
    }
  }

  /**
   * The tracked task a late notification finishes, and how it finished.
   * `undefined` for anything else (Codex says a lot after a turn ends).
   *
   * @param notification - A notification that belonged to no open turn.
   */
  completionOf(
    notification: ServerNotification
  ): { task: BackgroundTask; completion: BackgroundCompletion } | undefined {
    if (notification.method !== 'item/completed') return undefined;
    const item = (notification.params as { item?: Record<string, unknown> } | undefined)?.item;
    if (!item) return undefined;
    if (item.type === 'commandExecution') {
      const tracked = this.tasks.get(String(item.id));
      if (!tracked) return undefined;
      return { task: tracked.task, completion: commandCompletion(tracked, item) };
    }
    if (item.type === 'subAgentActivity') {
      if (item.kind !== 'completed' && item.kind !== 'interrupted') return undefined;
      const tracked = this.tasks.get(String(item.agentThreadId));
      if (!tracked) return undefined;
      const status = item.kind === 'completed' && !tracked.stopping ? 'completed' : 'stopped';
      return {
        task: tracked.task,
        completion: {
          taskId: tracked.task.taskId,
          kind: 'agent',
          label: tracked.task.label,
          status,
          summary:
            status === 'completed' ? 'The helper agent finished.' : 'The helper agent was stopped.',
          wakes: wakes(tracked),
          ...(tracked.task.context !== undefined ? { context: tracked.task.context } : {}),
        },
      };
    }
    return undefined;
  }

  /**
   * Forget a finished task. Its completion goes wherever the caller shows it.
   *
   * @param taskId - The task.
   */
  finish(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (!tracked) return;
    clearTimeout(tracked.ceiling);
    this.tasks.delete(taskId);
  }

  /**
   * Collect a completion for the session's next wake (nothing was open to
   * show it in). The first one starts the coalescing window and the
   * pending-segment hold.
   *
   * @param sessionId - The session.
   * @param completion - What finished.
   */
  queue(sessionId: string, completion: BackgroundCompletion): void {
    this.pendingFor(sessionId).completions.push(completion);
  }

  /**
   * Whether a wake is on its way for this session, so its queue should wait.
   * Bounded: false once {@link SEGMENT_PENDING_BOUND_MS} has passed.
   *
   * @param sessionId - The session.
   */
  isPending(sessionId: string): boolean {
    const pending = this.pending.get(sessionId);
    return pending !== undefined && this.now() - pending.since < this.pendingBoundMs;
  }

  /**
   * Whether this session still has work that may wake it: a task whose turn
   * ended normally that nobody asked to stop, or a wake on its way.
   *
   * @param sessionId - The session.
   */
  holds(sessionId: string): boolean {
    if (this.pending.has(sessionId)) return true;
    for (const tracked of this.tasks.values()) {
      if (tracked.task.sessionId === sessionId && wakes(tracked)) return true;
    }
    return false;
  }

  /**
   * A tracked task of this session, if any.
   *
   * @param sessionId - The session.
   * @param taskId - The task.
   */
  taskOf(sessionId: string, taskId: string): BackgroundTask | undefined {
    const tracked = this.tasks.get(taskId);
    return tracked?.task.sessionId === sessionId ? tracked.task : undefined;
  }

  /**
   * Note that a person asked a task to stop: its completion is reported
   * `stopped` and never wakes the chat.
   *
   * @param taskId - The task.
   */
  markStopping(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (tracked && tracked.stopping === undefined) tracked.stopping = 'person';
  }

  /**
   * Note that Codex confirmed it terminated a task, so losing its process
   * reports it stopped rather than lost.
   *
   * @param taskId - The task.
   */
  markTerminated(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (tracked) tracked.terminated = true;
  }

  /** Every tracked task, for liveness: helpers have no terminal Codex lists. */
  tasksIn(processKey: string): BackgroundTask[] {
    return [...this.tasks.values()]
      .map((tracked) => tracked.task)
      .filter((task) => task.processKey === processKey);
  }

  /** Every tracked command in a thread, for reconciliation. */
  commandsIn(threadId: string): BackgroundTask[] {
    return [...this.tasks.values()]
      .map((tracked) => tracked.task)
      .filter((task) => task.threadId === threadId && task.kind === 'bash');
  }

  /**
   * Reconcile one thread's tracked commands with what Codex lists as running.
   * A command missing from {@link MISSING_LIMIT} lists in a row is forgotten
   * without a report: DorkOS did not see it end, so it says nothing about how.
   *
   * @param threadId - The thread.
   * @param running - The process ids Codex listed.
   */
  reconcile(threadId: string, running: ReadonlySet<string>): void {
    for (const task of this.commandsIn(threadId)) {
      const tracked = this.tasks.get(task.taskId)!;
      if (task.processId !== undefined && running.has(task.processId)) {
        tracked.missing = 0;
        continue;
      }
      tracked.missing += 1;
      if (tracked.missing >= MISSING_LIMIT) {
        logger.info('[CodexAppServer] a background command vanished without a report', {
          sessionId: task.sessionId,
        });
        this.finish(task.taskId);
      }
    }
  }

  /**
   * The process went away. Every task in it is forgotten, and each session
   * that had one is told — once, as a status line, never a model turn.
   *
   * @param processKey - The process.
   */
  processGone(processKey: string): void {
    const sessions = new Set<string>();
    for (const tracked of [...this.tasks.values()]) {
      if (tracked.task.processKey !== processKey) continue;
      this.finish(tracked.task.taskId);
      // Codex confirmed it stopped this one: say so, not that it was lost.
      if (tracked.terminated) {
        this.queue(tracked.task.sessionId, {
          taskId: tracked.task.taskId,
          kind: tracked.task.kind,
          label: tracked.task.label,
          status: 'stopped',
          summary: tracked.stopping === 'ceiling' ? BACKGROUND_CEILING_COPY : 'Stopped.',
          wakes: false,
        });
        continue;
      }
      sessions.add(tracked.task.sessionId);
    }
    for (const sessionId of sessions) {
      this.pendingFor(sessionId).notices.push(BACKGROUND_WORK_LOST_COPY);
    }
  }

  /** Stop every timer (shutdown). */
  dispose(): void {
    for (const tracked of this.tasks.values()) clearTimeout(tracked.ceiling);
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.tasks.clear();
    this.pending.clear();
  }

  /** Every tracked task (shutdown terminates them). */
  all(): BackgroundTask[] {
    return [...this.tasks.values()].map((tracked) => tracked.task);
  }

  private pendingFor(sessionId: string): PendingWake {
    let pending = this.pending.get(sessionId);
    if (!pending) {
      const timer = setTimeout(() => this.release(sessionId), this.coalesceMs);
      timer.unref?.();
      pending = { since: this.now(), completions: [], notices: [], timer };
      this.pending.set(sessionId, pending);
    }
    return pending;
  }

  /** The coalescing window closed: hand the batch over as one wake. */
  private release(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    const wake: BackgroundWake = {
      sessionId,
      completions: pending.completions,
      startTurn: pending.completions.some((completion) => completion.wakes),
      notices: pending.notices,
    };
    let taken = false;
    try {
      taken = this.options.onWake(wake);
    } catch (err) {
      logger.warn('[CodexAppServer] could not wake the chat', { sessionId, err: String(err) });
    }
    // A wake that opened claimed the session itself; one that did not leaves
    // a queue that waited on it, which has to be told the hold is gone.
    if (!taken) this.options.onGateChange?.(sessionId);
  }

  private reachCeiling(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (!tracked) return;
    tracked.stopping = 'ceiling';
    logger.info('[CodexAppServer] stopping background work at the four-hour ceiling', {
      sessionId: tracked.task.sessionId,
    });
    void this.options.terminate(tracked.task).then(
      // `false`: it had just ended, and its result is on its way.
      (stopped) => {
        if (stopped) this.markTerminated(taskId);
      },
      (err: unknown) => {
        // Codex could not stop it: say so, and stop tracking it so it holds nothing.
        logger.warn('[CodexAppServer] could not stop background work at the ceiling', {
          sessionId: tracked.task.sessionId,
          err: String(err),
        });
        this.finish(taskId);
        this.pendingFor(tracked.task.sessionId).notices.push(BACKGROUND_CEILING_FAILED_COPY);
      }
    );
  }
}

/** Whether a tracked task's completion may start a model turn. */
function wakes(tracked: TrackedTask): boolean {
  return tracked.task.turnStatus === 'completed' && tracked.stopping === undefined;
}

function commandCompletion(
  tracked: TrackedTask,
  item: Record<string, unknown>
): BackgroundCompletion {
  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
  const succeeded = item.status === 'completed' && (exitCode ?? 0) === 0;
  // A stop that raced the command's own end reports how it really ended.
  const status: BackgroundCompletion['status'] = succeeded
    ? 'completed'
    : tracked.stopping !== undefined
      ? 'stopped'
      : 'failed';
  const tail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
  const head =
    tracked.stopping === 'ceiling' && status === 'stopped'
      ? BACKGROUND_CEILING_COPY
      : exitCode !== null
        ? `Exit code ${exitCode}.`
        : status === 'stopped'
          ? 'Stopped.'
          : 'Finished.';
  return {
    taskId: tracked.task.taskId,
    kind: 'bash',
    label: tracked.task.label,
    status,
    summary: tail.trim() ? `${head}\n${tail}` : head,
    wakes: wakes(tracked),
    ...(tracked.task.context !== undefined ? { context: tracked.task.context } : {}),
  };
}

/**
 * Text from a command, made safe to put inside the `<background_update>`
 * block: fenced with more backticks than it contains, and unable to close the
 * block early.
 */
function fenced(text: string, inline = false): string {
  const safe = text.replace(/<\/?background_update/gi, (tag) => tag.replace('<', '&lt;'));
  const longest = Math.max(
    inline ? 0 : 2,
    ...[...safe.matchAll(/`+/g)].map((run) => run[0].length)
  );
  const fence = '`'.repeat(longest + 1);
  return inline ? `${fence} ${safe.replace(/\n/g, ' ')} ${fence}` : `${fence}\n${safe}\n${fence}`;
}

/**
 * The message a woken agent reads: what finished, how, and the end of its
 * output, in a block DorkOS authored. Agent-facing; the person never sees it
 * as their own words (the turn is the agent's, `origin: 'runtime'`).
 *
 * @param completions - What finished.
 */
export function buildBackgroundUpdate(completions: readonly BackgroundCompletion[]): string {
  const entries = completions.map((completion) => {
    const what =
      completion.kind === 'bash' ? `Command ${fenced(completion.label, true)}` : 'Helper agent';
    return `- ${what} (${completion.status}):\n${fenced(completion.summary)}`;
  });
  return [
    '<background_update>',
    'Background work you started earlier has finished:',
    ...entries,
    '</background_update>',
    'Carry on from where you left off, using these results.',
  ].join('\n');
}
