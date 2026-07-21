import { Cron } from 'croner';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { Task, TaskRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { TaskStore } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { eventFanOut } from '../core/event-fan-out.js';
import { createTaggedLogger } from '../../lib/logger.js';
import { formatDuration } from '../../lib/format-duration.js';
import { SchedulerLock, SCHEDULER_HEARTBEAT_MS, type LeaderLock } from './scheduler-lock.js';
import { withSpan, SPAN, ATTR } from '../observability/index.js';

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

/** Narrow interface for the AgentManager methods used by the scheduler. */
export interface SchedulerAgentManager {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: PermissionMode; cwd?: string; hasStarted?: boolean }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string; systemPromptAppend?: string }
  ): AsyncGenerator<StreamEvent>;
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
 * Build the system prompt append for a Task-dispatched agent run.
 *
 * Gives the agent context about the scheduled job so it can operate unattended.
 */
export function buildTaskAppend(task: Task, run: TaskRun): string {
  return [
    '',
    '=== TASK SCHEDULER CONTEXT ===',
    `Job: ${task.name}`,
    `Schedule: ${task.cron ?? 'on-demand'}`,
    `Agent: ${task.agentId ?? '(global)'}`,
    `Run ID: ${run.id}`,
    `Trigger: ${run.trigger}`,
    '',
    'You are running as an unattended task via DorkOS Tasks.',
    'Complete the task described in the prompt efficiently.',
    'Do not ask questions — make reasonable decisions autonomously.',
    '=== END TASK CONTEXT ===',
  ].join('\n');
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

  /** Cancel a running job by aborting its AbortController. */
  cancelRun(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
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

  /** Execute a run — branches between Relay dispatch and direct AgentManager execution. */
  private async executeRun(task: Task, run: TaskRun): Promise<void> {
    return withSpan(SPAN.TASK_RUN, { [ATTR.TASK_TRIGGER]: run.trigger }, async (span) => {
      const viaRelay = isRelayEnabled() && this.relay;
      span.setAttr(ATTR.TASK_DISPATCH, viaRelay ? 'relay' : 'direct');
      return viaRelay ? this.executeRunViaRelay(task, run) : this.executeRunDirect(task, run);
    });
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
      from: 'relay.system.tasks.scheduler',
      replyTo: `relay.system.tasks.${task.id}.response`,
      budget: {
        maxHops: 3,
        ttl: Date.now() + (task.maxRuntime || 3_600_000),
        callBudgetRemaining: 5,
      },
    });

    if (result.deliveredTo === 0) {
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

    // Combine manual abort with optional timeout
    const signals: AbortSignal[] = [controller.signal];
    if (task.maxRuntime) {
      signals.push(AbortSignal.timeout(task.maxRuntime));
    }
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;

    const startTime = Date.now();
    let outputChars = 0;
    let outputSummary = '';

    try {
      const sessionId = run.id; // Use run ID as session ID for isolation
      const permissionMode = (task.permissionMode ?? 'acceptEdits') as PermissionMode;

      this.agentManager.ensureSession(sessionId, {
        permissionMode,
        cwd: effectiveCwd,
        hasStarted: false,
      });

      const taskAppend = buildTaskAppend(task, run);
      const stream = this.agentManager.sendMessage(sessionId, task.prompt, {
        permissionMode,
        cwd: effectiveCwd,
        systemPromptAppend: taskAppend,
      });

      for await (const event of stream) {
        if (combinedSignal.aborted) break;

        // Collect first 500 chars of text output as summary
        if (event.type === 'text_delta' && outputChars < 500) {
          const data = event.data as { text: string };
          outputSummary += data.text;
          outputChars += data.text.length;
        }
      }

      const durationMs = Date.now() - startTime;

      if (combinedSignal.aborted) {
        this.store.updateRun(run.id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, 500),
          error: 'Run cancelled',
          sessionId,
        });
        this.emitRunEvent(task, run, 'cancelled', durationMs);
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
    // Fire the attention-freshness broadcast on the failure transition BEFORE the
    // activity guard: the Pulse "Needs attention" badge must tick the moment a run
    // is recorded failed (DOR-403), regardless of whether activity logging is
    // wired. This is the real transition edge — emitRunEvent is called exactly
    // once per terminal run, never on a poll re-observation.
    if (status === 'failed') {
      eventFanOut.broadcast('task_run_failed', {
        runId: run.id,
        taskId: task.id,
        scheduleId: run.scheduleId,
        failedAt: new Date().toISOString(),
      });
    }

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
