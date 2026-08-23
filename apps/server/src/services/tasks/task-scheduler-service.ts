import { Cron } from 'croner';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { Task, TaskRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import { TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import { isTerminalRunStatus, type TaskStore } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { createTaggedLogger } from '../../lib/logger.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';
import { formatDuration } from '../../lib/format-duration.js';
import { SchedulerLock, SCHEDULER_HEARTBEAT_MS, type LeaderLock } from './scheduler-lock.js';
import { withSpan, SPAN, ATTR } from '../observability/index.js';
import { consumeRunStream, interruptRun } from './run-stream.js';
import { publishRunStop, type CancelRunOutcome, type RunStopDelivery } from './run-cancel.js';
import { buildTaskAppend } from './task-append.js';
import { previewNextRuns } from './cron-preview.js';
import { resolveScheduledRunPermissionMode } from './scheduled-run-power.js';

export type { CancelRunOutcome } from './run-cancel.js';

const logger = createTaggedLogger('Tasks');

/** Retention window for the dispatch-dedup log — generous; a tick only needs seconds. */
const DISPATCH_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Derive a stable idempotency key for a scheduled occurrence (ADR-285).
 *
 * croner's `currentRun()` is the wall-clock instant the timer fired (a few ms
 * after the scheduled boundary, at ms precision), NOT the schedule-aligned tick —
 * so two processes firing the same occurrence see different millisecond values.
 * Flooring to the cron's resolution collapses both onto one boundary: a 5-field
 * (or alias) cron fires at most once per minute → floor to 60s; a 6-field cron
 * carries seconds → floor to 1s. The leader lock is single-machine (one
 * `dorkHome`), so all co-located processes share one wall clock and agree on the
 * floored value, making the dedup row a true cross-process "fire-once" gate.
 *
 * @param cron - The task's cron expression.
 * @param firedAt - The trigger instant (croner `currentRun()`).
 * @returns The schedule-aligned epoch-ms key.
 */
export function scheduledTickKey(cron: string, firedAt: Date): number {
  const hasSecondsField = cron.trim().split(/\s+/).length >= 6;
  const resolutionMs = hasSecondsField ? 1000 : 60_000;
  return Math.floor(firedAt.getTime() / resolutionMs) * resolutionMs;
}

/**
 * Abort reason used by {@link TaskSchedulerService.cancelRun}, distinguishing an
 * operator's cancel from a shutdown abort and from the runtime deadline.
 */
const OPERATOR_CANCEL = Symbol('operator-cancel');

/** Narrow interface for the AgentManager methods used by the scheduler. */
export interface SchedulerAgentManager {
  ensureSession(
    sessionId: string,
    opts: {
      permissionMode: PermissionMode;
      cwd?: string;
      hasStarted?: boolean;
      /**
       * True for every scheduled run: nobody is watching, so a prompt this run
       * raises is refused at the countdown rather than waiting for an answer
       * that is not coming (spec `ask-parks-on-timeout` §7).
       */
      unattended?: boolean;
    }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string; systemPromptAppend?: string }
  ): AsyncGenerator<StreamEvent>;
  /**
   * End the in-flight turn for a session (`AgentRuntime.interruptQuery`).
   *
   * This is the ONLY way to stop a scheduled run: `sendMessage` takes no
   * `AbortSignal` (see `MessageOpts`), so abandoning its stream leaves the agent
   * running. Resolves false when the runtime found no in-flight turn to abort.
   */
  interruptQuery(sessionId: string): Promise<boolean>;
}

/** Configuration for the task scheduler service. */
export interface SchedulerConfig {
  maxConcurrentRuns: number;
  retentionCount: number;
  timezone: string | null;
  /**
   * Whether this environment may FIRE scheduled tasks (the production gate;
   * ADR-285). When false, crons still register (so next-run display works) but
   * `dispatch()` is suppressed. Resolved via {@link resolveTasksFiring}.
   */
  mayFire: boolean;
  /** Human-readable reason for the firing decision, surfaced once at `start()`. */
  firingReason: string;
}

/** Dependencies for the task scheduler service. */
export interface SchedulerDeps {
  store: TaskStore;
  agentManager: SchedulerAgentManager;
  config: SchedulerConfig;
  /** Optional RelayCore instance for dispatching runs via the Relay message bus. */
  relay?: RelayCore | null;
  /** Optional MeshCore instance for resolving agent CWDs from agent IDs. */
  meshCore?: MeshCore | null;
  /** Optional ActivityService for emitting activity events on run completion. */
  activityService?: ActivityService | null;
  /**
   * Data directory that keys the `dorkHome`-scoped leader lock (ADR-285). When
   * provided, a {@link SchedulerLock} is created so only one process sharing this
   * `dorkHome` fires. Omitted in single-process/test setups (then this process is
   * always the leader).
   */
  dorkHome?: string;
  /**
   * Pre-built leader lock, injectable for tests (e.g. a fake follower). Takes
   * precedence over `dorkHome`. Production passes `dorkHome` and lets the
   * scheduler build the real lock.
   */
  leaderLock?: LeaderLock;
}

/**
 * Cron orchestration service that manages job lifecycle and dispatches agent runs.
 *
 * Uses croner with `protect: true` for built-in per-job overrun protection
 * and enforces a global concurrency cap on total active runs.
 */
export class TaskSchedulerService {
  private cronJobs = new Map<string, Cron>();
  private activeRuns = new Map<string, AbortController>();
  private store: TaskStore;
  private agentManager: SchedulerAgentManager;
  private config: SchedulerConfig;
  private relay: RelayCore | null;
  private meshCore: MeshCore | null;
  private activityService: ActivityService | null;
  /**
   * The `dorkHome`-scoped leader lock (ADR-285), or `null` for single-process /
   * positional-constructor (test) setups where this process is always leader.
   */
  private leaderLock: LeaderLock | null;
  /** Heartbeat timer that keeps the leader lock fresh; cleared on `stop()`. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: TaskStore,
    agentManager: SchedulerAgentManager,
    config: SchedulerConfig,
    relay?: RelayCore | null,
    meshCore?: MeshCore | null
  );
  constructor(deps: SchedulerDeps);
  constructor(
    storeOrDeps: TaskStore | SchedulerDeps,
    agentManager?: SchedulerAgentManager,
    config?: SchedulerConfig,
    relay?: RelayCore | null,
    meshCore?: MeshCore | null
  ) {
    if ('store' in storeOrDeps && 'agentManager' in storeOrDeps && 'config' in storeOrDeps) {
      // SchedulerDeps object form
      this.store = storeOrDeps.store;
      this.agentManager = storeOrDeps.agentManager;
      this.config = storeOrDeps.config;
      this.relay = storeOrDeps.relay ?? null;
      this.meshCore = storeOrDeps.meshCore ?? null;
      this.activityService = storeOrDeps.activityService ?? null;
      this.leaderLock =
        storeOrDeps.leaderLock ??
        (storeOrDeps.dorkHome ? new SchedulerLock({ dorkHome: storeOrDeps.dorkHome }) : null);
    } else {
      // Positional args form (backwards-compatible)
      this.store = storeOrDeps as TaskStore;
      this.agentManager = agentManager!;
      this.config = config!;
      this.relay = relay ?? null;
      this.meshCore = meshCore ?? null;
      this.activityService = null;
      this.leaderLock = null;
    }
  }

  /**
   * Whether this process may fire (is the leader). Without a lock (single-process
   * / test setups) this process is always the leader.
   */
  private get isLeader(): boolean {
    return this.leaderLock ? this.leaderLock.isLeaderNow : true;
  }

  /** Start the scheduler: recover from crashes, prune old runs, register enabled tasks. */
  async start(): Promise<void> {
    logger.info(
      this.config.mayFire
        ? `firing ENABLED (${this.config.firingReason})`
        : `firing SUPPRESSED (${this.config.firingReason}) — tasks display but do not fire`
    );

    // Leader election (ADR-285): only the dorkHome leader fires. Followers still
    // register crons below (display works) but dispatch() no-ops for them. A
    // heartbeat keeps our claim fresh and promotes us if the leader dies.
    if (this.leaderLock) {
      const acquired = this.leaderLock.tryAcquire();
      logger.info(
        acquired ? 'acquired scheduler leadership' : 'running as scheduler follower (will not fire)'
      );
      // Guard against a re-entrant start() leaking a prior interval.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.leaderLock?.heartbeat(), SCHEDULER_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    }

    const failed = this.store.markRunningAsFailed();
    if (failed > 0) {
      logger.info(`marked ${failed} interrupted run(s) as failed`);
    }

    const tasks = this.store.getTasks();
    for (const task of tasks) {
      if (task.enabled && task.status === 'active') {
        this.registerTask(task);
      }
      this.store.pruneRuns(task.id, this.config.retentionCount);
    }

    // Bound the dispatch-dedup log (ADR-285) — keys only need to outlive a tick.
    this.store.pruneDispatchLog(DISPATCH_LOG_TTL_MS);

    logger.info(`started with ${this.cronJobs.size} active task(s)`);
  }

  /** Stop the scheduler: cancel all jobs and abort active runs. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.leaderLock?.release();

    for (const [id, cron] of this.cronJobs) {
      cron.stop();
      this.cronJobs.delete(id);
    }

    for (const [, controller] of this.activeRuns) {
      controller.abort();
    }

    // Wait up to 30s for active runs to finish
    const deadline = Date.now() + 30_000;
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.store.close();
    logger.info('scheduler stopped');
  }

  /** Register a cron job for a task. Skips registration for on-demand tasks (no cron). */
  registerTask(task: Task): void {
    if (!task.cron) {
      logger.debug(`skipping cron registration for on-demand task "${task.name}"`);
      return;
    }

    if (this.cronJobs.has(task.id)) {
      this.unregisterTask(task.id);
    }

    const tz = task.timezone ?? this.config.timezone ?? undefined;
    const job = new Cron(task.cron, { protect: true, timezone: tz }, (self) => {
      // Pass the cron's intended tick (not wall-clock) so dispatch idempotency
      // dedups on a value that's identical across processes (ADR-285).
      this.dispatch(task, self.currentRun()).catch((err) => {
        logger.error(`dispatch error for ${task.name}:`, err);
      });
    });

    this.cronJobs.set(task.id, job);
    logger.debug(`registered task "${task.name}" (${task.cron})`);
  }

  /** Unregister and stop a cron job. */
  unregisterTask(id: string): void {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }
  }

  /** Manually trigger a run for a task. */
  async triggerManualRun(taskId: string): Promise<TaskRun | null> {
    const task = this.store.getTask(taskId);
    if (!task) return null;

    const run = this.store.createRun(taskId, 'manual');
    // Fire and forget — executeRun handles its own error handling
    this.executeRun(task, run).catch((err) => {
      logger.error(`manual run error for ${task.name}:`, err);
    });
    return run;
  }

  /**
   * Stop a run, whichever way it was dispatched.
   *
   * A run this process is driving itself is aborted in place. A run handed to
   * the relay is executing inside an adapter that this process holds no handle
   * on, so the stop travels the same bus the dispatch did — and the only honest
   * report back is whether something took it (DOR-808).
   *
   * The direct abort carries {@link OPERATOR_CANCEL} so finalization can tell
   * an operator's cancel apart from a shutdown abort and skip a duplicate
   * activity event — the cancel route already emitted one, with the truthful
   * "You" actor.
   *
   * @param runId - The run to stop.
   * @returns What can honestly be said about the request.
   */
  async cancelRun(runId: string): Promise<CancelRunOutcome> {
    const run = this.store.getRun(runId);
    if (!run) return { state: 'not_found' };
    // Asked first, so a second Stop — and a Stop that lost the race with the
    // run's own ending — is a plain no-op rather than a message on the bus.
    if (isTerminalRunStatus(run.status)) return { state: 'already_finished' };

    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort(OPERATOR_CANCEL);
      return { state: 'stopping' };
    }

    if (!this.relay) {
      return {
        state: 'unconfirmed',
        reason: 'This run is not being driven by this server, and the message bus is off.',
      };
    }

    let delivery: RunStopDelivery;
    try {
      delivery = await publishRunStop(this.relay, runId);
    } catch (err) {
      // A stop that could not even be SENT is the same news for the person
      // pressing the button as one nobody answered: the run may still be
      // going. Reporting it as a 500 would be a truthful HTTP status and a
      // useless answer.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`could not send the stop request for run ${runId}: ${message}`);
      return {
        state: 'unconfirmed',
        reason: `The stop request could not be sent: ${message}`,
      };
    }

    if (delivery.deliveredTo > 0) {
      logger.info(`stop request for run ${runId} reached ${delivery.deliveredTo} runner(s)`);
      return { state: 'stopping' };
    }

    // Nobody took it. Either the run finished while the request was in flight —
    // in which case the record now says so — or no runner recognises it. Only
    // the first is good news, and the run record is the one that knows.
    const after = this.store.getRun(runId);
    if (after && isTerminalRunStatus(after.status)) return { state: 'already_finished' };

    // A refusal and a silence both land here as zero. Only one of them has a
    // cause worth telling somebody, and it is never the one they would guess.
    if (delivery.rejection) {
      logger.warn(`stop request for run ${runId} was refused: ${delivery.rejection}`);
      return {
        state: 'unconfirmed',
        reason:
          `The stop request could not be sent because ${delivery.rejection}. ` +
          'The agent may still be working — try again in a moment.',
      };
    }

    logger.warn(`no runner acknowledged the stop request for run ${runId}`);
    return {
      state: 'unconfirmed',
      reason:
        'Nothing picked up the stop request. The agent may still be working — ' +
        'check the run again in a moment.',
    };
  }

  /** Get the number of currently active runs. */
  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  /** Get the next run time for a task. */
  getNextRun(taskId: string): Date | null {
    const job = this.cronJobs.get(taskId);
    if (!job) return null;
    return job.nextRun() ?? null;
  }

  /**
   * When a cron WOULD fire, for a schedule this service has not registered
   * (DOR-1394). Implemented in `cron-preview.ts`; forwarded here so that "when
   * does this task run?" has ONE seam, whether or not a job exists — a caller
   * holding a scheduler should never have to know which of two places to ask.
   *
   * @param cron - The cron expression to read.
   * @param timezone - IANA timezone the expression is written in; UTC when absent.
   * @param count - How many occurrences to return.
   * @returns The next `count` fire times as ISO 8601 strings, soonest first.
   */
  previewNextRuns(
    cron: string | null | undefined,
    timezone: string | null | undefined,
    count: number
  ): string[] {
    return previewNextRuns(cron, timezone, count);
  }

  /** Check if a task has a registered cron job. */
  isRegistered(taskId: string): boolean {
    return this.cronJobs.has(taskId);
  }

  /**
   * Resolve the effective working directory for a task.
   *
   * When the task is linked to an agent (via agentId), resolves the agent's
   * projectPath from MeshCore. Falls back to the server default CWD.
   *
   * @param task - The task to resolve CWD for
   * @returns The absolute path to use as CWD for this run
   * @throws When agentId is set but the agent is not found in the Mesh registry
   */
  private async resolveEffectiveCwd(task: Task): Promise<string> {
    if (task.agentId && this.meshCore) {
      const projectPath = this.meshCore.getProjectPath(task.agentId);
      if (!projectPath) {
        throw new Error(
          `Agent ${task.agentId} not found in registry -- task ${task.id} cannot run. ` +
            'The agent may have been unregistered. Re-link the task to a valid agent or directory.'
        );
      }
      return projectPath;
    }
    return process.cwd();
  }

  /**
   * Dispatch a scheduled run — checks the firing gate, leadership, concurrency,
   * task state, and dispatch idempotency before creating a run.
   *
   * @param task - The task whose cron fired.
   * @param scheduledFireTime - The cron's intended tick (from croner `currentRun()`);
   *   keys idempotency so a tick fires at most once across processes.
   */
  private async dispatch(task: Task, scheduledFireTime?: Date | null): Promise<void> {
    // Production gate (ADR-285): suppress firing in non-production environments.
    // Crons still register, so display/next-run is unaffected — only firing stops.
    if (!this.config.mayFire) {
      logger.debug(`skipping "${task.name}" — firing suppressed (${this.config.firingReason})`);
      return;
    }

    // Leader gate (ADR-285): only the dorkHome leader fires; followers no-op so
    // N processes sharing a dorkHome fire a scheduled tick exactly once.
    if (!this.isLeader) {
      logger.debug(`skipping "${task.name}" — not the scheduler leader`);
      return;
    }

    if (this.activeRuns.size >= this.config.maxConcurrentRuns) {
      logger.debug(`skipping "${task.name}" — at concurrency cap`);
      return;
    }

    // Re-read task to check current state
    const current = this.store.getTask(task.id);
    if (!current || !current.enabled || current.status !== 'active') {
      logger.debug(`skipping "${task.name}" — disabled or not active`);
      return;
    }

    // Idempotency gate (ADR-285): atomically claim this scheduled tick. If another
    // process (or a duplicate fire) already claimed it, skip. The leader lock makes
    // this rare; this is the durable backstop for the handoff/double-fire window.
    // The key is the trigger time floored to the cron's resolution (see
    // scheduledTickKey) so co-located processes firing the same occurrence agree.
    if (current.cron) {
      const firedAt = scheduledFireTime ?? this.cronJobs.get(task.id)?.currentRun() ?? new Date();
      const tickKey = scheduledTickKey(current.cron, firedAt);
      if (!this.store.tryClaimDispatch(task.id, tickKey)) {
        logger.debug(
          `skipping "${task.name}" — tick ${new Date(tickKey).toISOString()} already dispatched`
        );
        return;
      }
    }

    const run = this.store.createRun(task.id, 'scheduled');
    await this.executeRun(current, run);
  }

  /**
   * Execute a run — branches between Relay dispatch and direct AgentManager
   * execution, inside this run's own dispatch scope.
   *
   * The scope is the OUTERMOST thing here, so the span it wraps carries the id
   * too: a task that dispatches through the relay is one dispatch that crosses
   * the bus, and the envelope's `dispatchId` is what keeps it one on the far
   * side.
   */
  private async executeRun(task: Task, run: TaskRun): Promise<void> {
    const dispatchId = newDispatchId();
    recordDispatchStart({ dispatchId, origin: 'task' });
    return runInDispatch({ dispatchId, origin: 'task' }, () =>
      withSpan(SPAN.TASK_RUN, { [ATTR.TASK_TRIGGER]: run.trigger }, async (span) => {
        const viaRelay = isRelayEnabled() && this.relay;
        span.setAttr(ATTR.TASK_DISPATCH, viaRelay ? 'relay' : 'direct');
        try {
          const result = viaRelay
            ? await this.executeRunViaRelay(task, run)
            : await this.executeRunDirect(task, run);
          recordDispatchEnd(dispatchId, 'answered');
          return result;
        } catch (err) {
          recordDispatchEnd(dispatchId, 'failed');
          throw err;
        }
      })
    );
  }

  /**
   * Execute a run by publishing a TaskDispatchPayload via the Relay message bus.
   *
   * Builds an envelope with the task/run metadata and publishes to
   * `relay.system.tasks.{taskId}`. If no receiver is subscribed
   * (deliveredTo === 0), the run is immediately marked as failed.
   * Otherwise it is marked as running — the receiver will update
   * status on completion via a separate response flow.
   *
   * DOR-248: in-process relay delivery is synchronous, so by the time
   * `publish()` resolves here the receiving task handler may have already
   * run the agent turn to completion and written a terminal status. The
   * `status: 'running'` write below can therefore race a `completed` write
   * that already happened — `TaskStore#updateRun`'s terminal-status guard is
   * what makes that race harmless, not the ordering of these two calls.
   */
  private async executeRunViaRelay(task: Task, run: TaskRun): Promise<void> {
    let effectiveCwd: string;
    try {
      effectiveCwd = await this.resolveEffectiveCwd(task);
    } catch (err) {
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: (err as Error).message,
      });
      logger.error(`run ${run.id} failed: ${(err as Error).message}`);
      this.emitRunEvent(task, run, 'failed', 0, (err as Error).message);
      return;
    }

    const payload: TaskDispatchPayload = {
      type: 'task_dispatch',
      taskId: task.id,
      runId: run.id,
      prompt: task.prompt,
      cwd: effectiveCwd,
      permissionMode: task.permissionMode,
      taskName: task.name,
      cron: task.cron,
      trigger: run.trigger,
    };

    const subject = `relay.system.tasks.${task.id}`;
    const result = await this.relay!.publish(subject, payload, {
      from: TASK_SCHEDULER_PRINCIPAL,
      replyTo: `relay.system.tasks.${task.id}.response`,
      budget: {
        maxHops: 3,
        ttl: Date.now() + (task.maxRuntime || 3_600_000),
        callBudgetRemaining: 5,
      },
    });

    if (result.deliveredTo === 0) {
      // "Nobody was listening" and "it ran and was stopped" arrive here
      // identically: the adapter reports an unsuccessful delivery for a run it
      // ended on a deadline, and in-process delivery means the whole run has
      // already happened by the time publish() resolves. The run record is the
      // tiebreaker — a run that reached a terminal status was plainly received,
      // and calling it failed would put a lie in the activity feed.
      const current = this.store.getRun(run.id);
      if (current && isTerminalRunStatus(current.status)) {
        logger.debug(`relay dispatch for run ${run.id} finished as ${current.status}`);
        return;
      }
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: 'No receiver for task dispatch',
      });
      logger.warn(`no receiver for relay dispatch of run ${run.id}`);
      this.emitRunEvent(task, run, 'failed', 0, 'No receiver for task dispatch');
    } else {
      this.store.updateRun(run.id, {
        status: 'running',
      });
      logger.info(
        `relay dispatch for run ${run.id} delivered to ${result.deliveredTo} endpoint(s)`
      );
    }
  }

  /** Execute a run directly via AgentManager — manages AbortController, streams output, updates status. */
  private async executeRunDirect(task: Task, run: TaskRun): Promise<void> {
    let effectiveCwd: string | undefined;
    try {
      effectiveCwd = await this.resolveEffectiveCwd(task);
    } catch (err) {
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: (err as Error).message,
      });
      logger.error(`run ${run.id} failed: ${(err as Error).message}`);
      this.emitRunEvent(task, run, 'failed', 0, (err as Error).message);
      return;
    }

    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);

    // Two ways a run stops early: an operator cancels it, or it outlives its
    // maxRuntime. `AbortSignal.any` adopts the reason of whichever fired FIRST,
    // and `AbortSignal.timeout` aborts with a DOMException named 'TimeoutError' —
    // which is how the finalized row below tells the two apart.
    const timeoutSignal = task.maxRuntime ? AbortSignal.timeout(task.maxRuntime) : null;
    const combinedSignal = timeoutSignal
      ? AbortSignal.any([controller.signal, timeoutSignal])
      : controller.signal;

    const startTime = Date.now();
    let outputChars = 0;
    let outputSummary = '';

    try {
      const sessionId = run.id; // Use run ID as session ID for isolation
      // DEFENCE IN DEPTH, and deliberately not more than that. The `??` branch is
      // unreachable through the shipped store: `pulse_schedules.permission_mode`
      // is `NOT NULL DEFAULT 'acceptEdits'`, so a row always carries a mode and
      // the level a task runs at is decided once, at CREATE, by the ladder in
      // `scheduled-run-power.ts` (spec `full-power-defaults`, D6).
      //
      // Say that plainly rather than letting this line read as the thing that
      // makes existing tasks follow the operator's level — it is not, and they do
      // not: a task created before the ladder existed keeps the mode stored on
      // its row. What this covers is a row that reached memory without one (a
      // hand-built fixture, a future store, a column that loses its constraint),
      // and it answers with the same ladder rather than a second hardcoded
      // constant, so the two can never disagree. Still `'acceptEdits'` when
      // nothing is configured, which is what this line always did.
      const permissionMode = (task.permissionMode ??
        resolveScheduledRunPermissionMode()) as PermissionMode;

      this.agentManager.ensureSession(sessionId, {
        permissionMode,
        cwd: effectiveCwd,
        hasStarted: false,
        // Nobody is coming back to a scheduled run, so an unanswered prompt is
        // refused at ten minutes instead of parking for four hours and stalling
        // the run (spec `ask-parks-on-timeout` §7).
        unattended: true,
      });

      const taskAppend = buildTaskAppend(task, run);
      const stream = this.agentManager.sendMessage(sessionId, task.prompt, {
        permissionMode,
        cwd: effectiveCwd,
        systemPromptAppend: taskAppend,
      });

      const stopped = await consumeRunStream(
        stream,
        combinedSignal,
        () => void interruptRun(this.agentManager, sessionId),
        (event) => {
          // Collect first 500 chars of text output as summary
          if (event.type === 'text_delta' && outputChars < 500) {
            const data = event.data as { text: string };
            outputSummary += data.text;
            outputChars += data.text.length;
          }
        }
      );

      const durationMs = Date.now() - startTime;

      if (stopped) {
        // Both stops record `cancelled` — the run-status vocabulary has no
        // separate timeout — so the error line is what tells a person which
        // happened.
        const timedOut =
          (combinedSignal.reason as { name?: string } | null)?.name === 'TimeoutError';
        const operatorCancelled = combinedSignal.reason === OPERATOR_CANCEL;
        this.store.updateRun(run.id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, 500),
          error:
            timedOut && task.maxRuntime
              ? `Run stopped after passing its ${formatDuration(task.maxRuntime)} time limit`
              : 'Run cancelled',
          sessionId,
        });
        // The cancel route emits its own `tasks.run_cancelled` the moment the
        // operator asks, attributed to "You". Emitting again here would put the
        // same cancel in the activity feed twice, the second time attributed to
        // Tasks. A deadline or a shutdown abort has no such route emit, so it
        // still needs this one.
        if (!operatorCancelled) this.emitRunEvent(task, run, 'cancelled', durationMs);
      } else {
        this.store.updateRun(run.id, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, 500),
          sessionId,
        });
        this.emitRunEvent(task, run, 'completed', durationMs);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs,
        outputSummary: outputSummary.slice(0, 500),
        error: errorMsg,
      });
      logger.error(`run ${run.id} failed:`, err);
      this.emitRunEvent(task, run, 'failed', durationMs, errorMsg);
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  /** Emit an activity event for a completed, failed, or cancelled run. */
  private emitRunEvent(
    task: Task,
    run: TaskRun,
    status: 'completed' | 'failed' | 'cancelled',
    durationMs: number,
    error?: string
  ): void {
    // NOTE: the Pulse attention broadcast (`task_run_failed`, DOR-403) is NOT
    // emitted here. emitRunEvent only covers scheduler-side terminal paths; a
    // relay-delivered run is finalized by the receiver writing 'failed' through
    // TaskStore, which never reaches this method. The broadcast rides the
    // TaskStore run-terminal hook (the single terminal funnel for both paths) —
    // see run-terminal-broadcaster.ts, wired in index.ts.
    if (!this.activityService) return;

    const eventType =
      status === 'completed'
        ? 'tasks.run_success'
        : status === 'cancelled'
          ? 'tasks.run_cancelled'
          : 'tasks.run_failed';

    const actorType = run.trigger === 'scheduled' ? 'tasks' : 'user';
    const actorLabel = run.trigger === 'scheduled' ? 'Tasks' : 'You';

    const verb =
      status === 'completed'
        ? 'ran successfully'
        : status === 'cancelled'
          ? 'was cancelled'
          : 'failed';
    const duration = durationMs ? ` (${formatDuration(durationMs)})` : '';

    this.activityService.emit({
      actorType,
      actorId: run.trigger === 'scheduled' ? run.scheduleId : null,
      actorLabel,
      category: 'tasks',
      eventType,
      resourceType: 'schedule',
      resourceId: run.scheduleId,
      resourceLabel: task.name,
      summary: `${task.name} ${verb}${duration}`,
      linkPath: '/',
      metadata: error ? { error } : null,
    });
  }
}
