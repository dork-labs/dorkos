import { Cron } from 'croner';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { Task, TaskRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { TaskStore } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { createTaggedLogger } from '../../lib/logger.js';
import { formatDuration } from '../../lib/format-duration.js';

const logger = createTaggedLogger('Tasks');

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
    } else {
      // Positional args form (backwards-compatible)
      this.store = storeOrDeps as TaskStore;
      this.agentManager = agentManager!;
      this.config = config!;
      this.relay = relay ?? null;
      this.meshCore = meshCore ?? null;
      this.activityService = null;
    }
  }

  /** Start the scheduler: recover from crashes, prune old runs, register enabled tasks. */
  async start(): Promise<void> {
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

    logger.info(`started with ${this.cronJobs.size} active task(s)`);
  }

  /** Stop the scheduler: cancel all jobs and abort active runs. */
  async stop(): Promise<void> {
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
    const job = new Cron(task.cron, { protect: true, timezone: tz }, () => {
      this.dispatch(task).catch((err) => {
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

  /** Dispatch a scheduled run — checks concurrency and task state. */
  private async dispatch(task: Task): Promise<void> {
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

    const run = this.store.createRun(task.id, 'scheduled');
    await this.executeRun(current, run);
  }

  /** Execute a run — branches between Relay dispatch and direct AgentManager execution. */
  private async executeRun(task: Task, run: TaskRun): Promise<void> {
    if (isRelayEnabled() && this.relay) {
      return this.executeRunViaRelay(task, run);
    }
    return this.executeRunDirect(task, run);
  }

  /**
   * Execute a run by publishing a TaskDispatchPayload via the Relay message bus.
   *
   * Builds an envelope with the task/run metadata and publishes to
   * `relay.system.tasks.{taskId}`. If no receiver is subscribed
   * (deliveredTo === 0), the run is immediately marked as failed.
   * Otherwise it is marked as running — the receiver will update
   * status on completion via a separate response flow.
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
