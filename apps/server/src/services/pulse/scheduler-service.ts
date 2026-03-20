import { Cron } from 'croner';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { PulseSchedule, PulseRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { PulseDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { PulseStore } from './pulse-store.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Pulse');

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

/** Dependencies for the scheduler service. */
export interface SchedulerDeps {
  store: PulseStore;
  agentManager: SchedulerAgentManager;
  config: SchedulerConfig;
  /** Optional RelayCore instance for dispatching runs via the Relay message bus. */
  relay?: RelayCore | null;
  /** Optional MeshCore instance for resolving agent CWDs from agent IDs. */
  meshCore?: MeshCore | null;
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
  private relay: RelayCore | null;
  private meshCore: MeshCore | null;

  constructor(
    store: PulseStore,
    agentManager: SchedulerAgentManager,
    config: SchedulerConfig,
    relay?: RelayCore | null,
    meshCore?: MeshCore | null
  );
  constructor(deps: SchedulerDeps);
  constructor(
    storeOrDeps: PulseStore | SchedulerDeps,
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
    } else {
      // Positional args form (backwards-compatible)
      this.store = storeOrDeps as PulseStore;
      this.agentManager = agentManager!;
      this.config = config!;
      this.relay = relay ?? null;
      this.meshCore = meshCore ?? null;
    }
  }

  /** Start the scheduler: recover from crashes, prune old runs, register enabled schedules. */
  async start(): Promise<void> {
    const failed = this.store.markRunningAsFailed();
    if (failed > 0) {
      logger.info(`marked ${failed} interrupted run(s) as failed`);
    }

    const schedules = this.store.getSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled && schedule.status === 'active') {
        this.registerSchedule(schedule);
      }
      this.store.pruneRuns(schedule.id, this.config.retentionCount);
    }

    logger.info(`started with ${this.cronJobs.size} active schedule(s)`);
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

  /** Register a cron job for a schedule. */
  registerSchedule(schedule: PulseSchedule): void {
    if (this.cronJobs.has(schedule.id)) {
      this.unregisterSchedule(schedule.id);
    }

    const tz = schedule.timezone ?? this.config.timezone ?? undefined;
    const job = new Cron(schedule.cron, { protect: true, timezone: tz }, () => {
      this.dispatch(schedule).catch((err) => {
        logger.error(`dispatch error for ${schedule.name}:`, err);
      });
    });

    this.cronJobs.set(schedule.id, job);
    logger.debug(`registered schedule "${schedule.name}" (${schedule.cron})`);
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
      logger.error(`manual run error for ${schedule.name}:`, err);
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

  /**
   * Resolve the effective working directory for a schedule.
   *
   * When the schedule is linked to an agent (via agentId), resolves the agent's
   * projectPath from MeshCore. Falls back to schedule.cwd, then the server default.
   *
   * @param schedule - The schedule to resolve CWD for
   * @returns The absolute path to use as CWD for this run
   * @throws When agentId is set but the agent is not found in the Mesh registry
   */
  private async resolveEffectiveCwd(schedule: PulseSchedule): Promise<string> {
    if (schedule.agentId && this.meshCore) {
      const projectPath = this.meshCore.getProjectPath(schedule.agentId);
      if (!projectPath) {
        throw new Error(
          `Agent ${schedule.agentId} not found in registry -- schedule ${schedule.id} cannot run. ` +
            'The agent may have been unregistered. Re-link the schedule to a valid agent or directory.'
        );
      }
      return projectPath;
    }
    return schedule.cwd ?? process.cwd();
  }

  /** Dispatch a scheduled run — checks concurrency and schedule state. */
  private async dispatch(schedule: PulseSchedule): Promise<void> {
    if (this.activeRuns.size >= this.config.maxConcurrentRuns) {
      logger.debug(`skipping "${schedule.name}" — at concurrency cap`);
      return;
    }

    // Re-read schedule to check current state
    const current = this.store.getSchedule(schedule.id);
    if (!current || !current.enabled || current.status !== 'active') {
      logger.debug(`skipping "${schedule.name}" — disabled or not active`);
      return;
    }

    const run = this.store.createRun(schedule.id, 'scheduled');
    await this.executeRun(current, run);
  }

  /** Execute a run — branches between Relay dispatch and direct AgentManager execution. */
  private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
    if (isRelayEnabled() && this.relay) {
      return this.executeRunViaRelay(schedule, run);
    }
    return this.executeRunDirect(schedule, run);
  }

  /**
   * Execute a run by publishing a PulseDispatchPayload via the Relay message bus.
   *
   * Builds an envelope with the schedule/run metadata and publishes to
   * `relay.system.pulse.{scheduleId}`. If no receiver is subscribed
   * (deliveredTo === 0), the run is immediately marked as failed.
   * Otherwise it is marked as running — the receiver will update
   * status on completion via a separate response flow.
   */
  private async executeRunViaRelay(schedule: PulseSchedule, run: PulseRun): Promise<void> {
    let effectiveCwd: string;
    try {
      effectiveCwd = await this.resolveEffectiveCwd(schedule);
    } catch (err) {
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: (err as Error).message,
      });
      logger.error(`run ${run.id} failed: ${(err as Error).message}`);
      return;
    }

    const payload: PulseDispatchPayload = {
      type: 'pulse_dispatch',
      scheduleId: schedule.id,
      runId: run.id,
      prompt: schedule.prompt,
      cwd: effectiveCwd,
      permissionMode: schedule.permissionMode,
      scheduleName: schedule.name,
      cron: schedule.cron,
      trigger: run.trigger,
    };

    const subject = `relay.system.pulse.${schedule.id}`;
    const result = await this.relay!.publish(subject, payload, {
      from: 'relay.system.pulse.scheduler',
      replyTo: `relay.system.pulse.${schedule.id}.response`,
      budget: {
        maxHops: 3,
        ttl: Date.now() + (schedule.maxRuntime || 3_600_000),
        callBudgetRemaining: 5,
      },
    });

    if (result.deliveredTo === 0) {
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: 'No receiver for pulse dispatch',
      });
      logger.warn(`no receiver for relay dispatch of run ${run.id}`);
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
  private async executeRunDirect(schedule: PulseSchedule, run: PulseRun): Promise<void> {
    let effectiveCwd: string | undefined;
    try {
      effectiveCwd = await this.resolveEffectiveCwd(schedule);
    } catch (err) {
      this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: (err as Error).message,
      });
      logger.error(`run ${run.id} failed: ${(err as Error).message}`);
      return;
    }

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
        cwd: effectiveCwd,
        hasStarted: false,
      });

      const pulseAppend = buildPulseAppend(schedule, run);
      const stream = this.agentManager.sendMessage(sessionId, schedule.prompt, {
        permissionMode,
        cwd: effectiveCwd,
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
      logger.error(`run ${run.id} failed:`, err);
    } finally {
      this.activeRuns.delete(run.id);
    }
  }
}
