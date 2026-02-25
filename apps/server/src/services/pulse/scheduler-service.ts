import { Cron } from 'croner';
import type { PulseSchedule, PulseRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { PulseStore } from './pulse-store.js';
import { logger } from '../../lib/logger.js';

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

/** Configuration for the scheduler service. */
export interface SchedulerConfig {
  maxConcurrentRuns: number;
  retentionCount: number;
  timezone: string | null;
}

/**
 * Build the system prompt append for a Pulse-dispatched agent run.
 *
 * Gives the agent context about the scheduled job so it can operate unattended.
 */
export function buildPulseAppend(schedule: PulseSchedule, run: PulseRun): string {
  return [
    '',
    '=== PULSE SCHEDULER CONTEXT ===',
    `Job: ${schedule.name}`,
    `Schedule: ${schedule.cron}`,
    `CWD: ${schedule.cwd ?? '(server default)'}`,
    `Run ID: ${run.id}`,
    `Trigger: ${run.trigger}`,
    '',
    'You are running as an unattended scheduled job via DorkOS Pulse.',
    'Complete the task described in the prompt efficiently.',
    'Do not ask questions — make reasonable decisions autonomously.',
    '=== END PULSE CONTEXT ===',
  ].join('\n');
}

/**
 * Cron orchestration service that manages job lifecycle and dispatches agent runs.
 *
 * Uses croner with `protect: true` for built-in per-job overrun protection
 * and enforces a global concurrency cap on total active runs.
 */
export class SchedulerService {
  private cronJobs = new Map<string, Cron>();
  private activeRuns = new Map<string, AbortController>();
  private store: PulseStore;
  private agentManager: SchedulerAgentManager;
  private config: SchedulerConfig;

  constructor(store: PulseStore, agentManager: SchedulerAgentManager, config: SchedulerConfig) {
    this.store = store;
    this.agentManager = agentManager;
    this.config = config;
  }

  /** Start the scheduler: recover from crashes, prune old runs, register enabled schedules. */
  async start(): Promise<void> {
    const failed = this.store.markRunningAsFailed();
    if (failed > 0) {
      logger.info(`Pulse: marked ${failed} interrupted run(s) as failed`);
    }

    const schedules = this.store.getSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled && schedule.status === 'active') {
        this.registerSchedule(schedule);
      }
      this.store.pruneRuns(schedule.id, this.config.retentionCount);
    }

    logger.info(`Pulse: started with ${this.cronJobs.size} active schedule(s)`);
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
    logger.info('Pulse: scheduler stopped');
  }

  /** Register a cron job for a schedule. */
  registerSchedule(schedule: PulseSchedule): void {
    if (this.cronJobs.has(schedule.id)) {
      this.unregisterSchedule(schedule.id);
    }

    const tz = schedule.timezone ?? this.config.timezone ?? undefined;
    const job = new Cron(schedule.cron, { protect: true, timezone: tz }, () => {
      this.dispatch(schedule).catch((err) => {
        logger.error(`Pulse: dispatch error for ${schedule.name}:`, err);
      });
    });

    this.cronJobs.set(schedule.id, job);
    logger.debug(`Pulse: registered schedule "${schedule.name}" (${schedule.cron})`);
  }

  /** Unregister and stop a cron job. */
  unregisterSchedule(id: string): void {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }
  }

  /** Manually trigger a run for a schedule. */
  async triggerManualRun(scheduleId: string): Promise<PulseRun | null> {
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule) return null;

    const run = this.store.createRun(scheduleId, 'manual');
    // Fire and forget — executeRun handles its own error handling
    this.executeRun(schedule, run).catch((err) => {
      logger.error(`Pulse: manual run error for ${schedule.name}:`, err);
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

  /** Get the next run time for a schedule. */
  getNextRun(scheduleId: string): Date | null {
    const job = this.cronJobs.get(scheduleId);
    if (!job) return null;
    return job.nextRun() ?? null;
  }

  /** Check if a schedule has a registered cron job. */
  isRegistered(scheduleId: string): boolean {
    return this.cronJobs.has(scheduleId);
  }

  /** Dispatch a scheduled run — checks concurrency and schedule state. */
  private async dispatch(schedule: PulseSchedule): Promise<void> {
    if (this.activeRuns.size >= this.config.maxConcurrentRuns) {
      logger.debug(`Pulse: skipping "${schedule.name}" — at concurrency cap`);
      return;
    }

    // Re-read schedule to check current state
    const current = this.store.getSchedule(schedule.id);
    if (!current || !current.enabled || current.status !== 'active') {
      logger.debug(`Pulse: skipping "${schedule.name}" — disabled or not active`);
      return;
    }

    const run = this.store.createRun(schedule.id, 'scheduled');
    await this.executeRun(current, run);
  }

  /** Execute a run — manages AbortController, streams agent output, updates run status. */
  private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);

    // Combine manual abort with optional timeout
    const signals: AbortSignal[] = [controller.signal];
    if (schedule.maxRuntime) {
      signals.push(AbortSignal.timeout(schedule.maxRuntime));
    }
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;

    const startTime = Date.now();
    let outputChars = 0;
    let outputSummary = '';

    try {
      const sessionId = run.id; // Use run ID as session ID for isolation
      const permissionMode = (schedule.permissionMode ?? 'acceptEdits') as PermissionMode;

      this.agentManager.ensureSession(sessionId, {
        permissionMode,
        cwd: schedule.cwd ?? undefined,
        hasStarted: false,
      });

      const pulseAppend = buildPulseAppend(schedule, run);
      const stream = this.agentManager.sendMessage(sessionId, schedule.prompt, {
        permissionMode,
        cwd: schedule.cwd ?? undefined,
        systemPromptAppend: pulseAppend,
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
      } else {
        this.store.updateRun(run.id, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, 500),
          sessionId,
        });
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
      logger.error(`Pulse: run ${run.id} failed:`, err);
    } finally {
      this.activeRuns.delete(run.id);
    }
  }
}
