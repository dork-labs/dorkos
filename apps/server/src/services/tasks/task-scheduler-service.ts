import { Cron } from 'croner';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { EffortLevel, Task, TaskRun, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { isTerminalRunStatus, type TaskStore } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { createTaggedLogger, logError } from '../../lib/logger.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';
import { formatDuration } from '../../lib/format-duration.js';
import { SchedulerLock, SCHEDULER_HEARTBEAT_MS, type LeaderLock } from './scheduler-lock.js';
import { withSpan, SPAN, ATTR } from '../observability/index.js';
import { consumeRunStream, interruptRun } from './run-stream.js';
import { publishRunStop, type CancelRunOutcome, type RunStopDelivery } from './run-cancel.js';
import { RunAccounting } from './run-accounting.js';
import { emitRunActivity } from './run-activity.js';
import { dispatchRunViaRelay } from './relay-dispatch.js';
import { pruneRunHistory, PRUNE_INTERVAL_MS } from './run-retention.js';
import { sweepInterruptedRuns } from './crash-recovery.js';
import { RefusedScheduleLog } from './refused-schedule-log.js';
import { buildTaskAppend } from './task-append.js';
import { previewNextRuns } from './cron-preview.js';
import { resolveScheduledRunPermissionMode } from './scheduled-run-power.js';
import { resolveRunSession } from './session/sticky-session.js';
import { resolveSessionCwd } from '../workspace/resolve-session-cwd.js';
import {
  resolveRunExecution,
  type RunExecution,
  type RunExecutionRuntimes,
} from './execution/resolve-run-execution.js';
import { runtimeRegistry } from '../core/runtime-registry.js';

/**
 * Whether the relay can run a turn on this runtime — asked per run, answered by
 * the relay itself (DOR-1614).
 *
 * This was the literal `'claude-code'`, and that was honest while the relay held
 * exactly one runtime: a codex or opencode run handed to the bus would have been
 * run by the wrong program or by none, so those went DIRECT. The relay now holds
 * every registered runtime and picks per message, so the question is no longer
 * "is it claude-code" but "is it one the relay actually has" — and only the relay
 * can answer that. `AdapterManager.hasAgentRuntime` is the production answer.
 *
 * A predicate rather than a set for two reasons. The relay is built after the
 * scheduler's collaborators and can be rebuilt or absent entirely, so the answer
 * has to be read at dispatch time, not captured at construction. And a predicate
 * is the whole question: the scheduler must not enumerate the relay's runtimes
 * or reach the runtimes themselves.
 *
 * @param runtimeType - The runtime this run resolved to.
 */
export type RelayRuntimePredicate = (runtimeType: string) => boolean;

/**
 * What a caller that wired a relay but never said which runtimes it holds means:
 * the v1 answer, claude-code and nothing else.
 *
 * The same compat reading `normalizeAgentRuntimes` gives a bare runtime that
 * declares no `type`, and for the same reason — it is what such a caller has
 * always meant, so honouring it keeps every existing relay caller routing
 * exactly as it did. Defaulting to "holds nothing" was measured instead: it sent
 * every relay test's run down the direct path, which is safe but silently makes
 * those tests stop testing the bus.
 *
 * Production never takes this default; `index.ts` passes
 * `AdapterManager.hasAgentRuntime`.
 */
const V1_RELAY_RUNTIME: RelayRuntimePredicate = (runtimeType) => runtimeType === 'claude-code';

export type { CancelRunOutcome } from './run-cancel.js';

const logger = createTaggedLogger('Tasks');

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
      /**
       * The model this run resolved to, in the runtime's own id space, or absent
       * for "the runtime decides" (DOR-1347).
       *
       * Asked HERE and not only at `sendMessage`, because for claude-code this
       * is the only call that can answer it: the runtime reads `session.model`
       * when it launches a query, and that field is written once, when the
       * session record is created (`messaging/launch-resolver.ts`). A model
       * handed over afterwards reaches nothing. `agent-handler.ts` in the relay
       * spreads its resolved settings into both calls for exactly this reason.
       */
      model?: string;
      /** The reasoning-effort rung this run resolved to; absent leaves it unset. */
      effort?: EffortLevel;
    }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      permissionMode?: PermissionMode;
      cwd?: string;
      systemPromptAppend?: string;
      /**
       * Sent again, for the same reason the permission mode and the cwd are: the
       * runtime contract resolves a turn as per-send override → persisted → its
       * own default, and a runtime whose sessions are not held in memory sees
       * this call and not `ensureSession`.
       */
      model?: string;
      /** See {@link SchedulerAgentManager.sendMessage}'s `model`. */
      effort?: EffortLevel;
    }
  ): AsyncGenerator<StreamEvent>;
  /**
   * End the in-flight turn for a session (`AgentRuntime.interruptQuery`).
   *
   * This is the ONLY way to stop a scheduled run: `sendMessage` takes no
   * `AbortSignal` (see `MessageOpts`), so abandoning its stream leaves the agent
   * running. Resolves false when the runtime found no in-flight turn to abort.
   */
  interruptQuery(sessionId: string): Promise<boolean>;
  /**
   * The runtime's OWN session id for a session key, after the SDK has minted or
   * kept one (`AgentRuntime.getInternalSessionId`).
   *
   * A sticky run reads this once its turn is over to learn the real id the SDK
   * wrote its transcript under, then persists it as the run's `sessionId` so the
   * next fire can resume that exact conversation (DOR-1571). Returns undefined
   * when the session is gone or never started.
   */
  getInternalSessionId(sessionId: string): string | undefined;
}

/**
 * Where the scheduler gets an agent manager for the runtime a run RESOLVED to
 * (DOR-1615).
 *
 * This replaces the single boot-bound `agentManager` the scheduler used to hold.
 * That binding was the reason a scheduled run could only ever happen on Claude
 * Code: `index.ts` constructed one `ClaudeCodeRuntime` and handed it over, so
 * `runtimes.default` moved which runtime a new CHAT got and never reached a
 * scheduled run at all.
 *
 * Deliberately the narrow shape rather than `RuntimeRegistry` itself — the
 * registry satisfies it structurally, and a test can hand over three functions
 * instead of a registry with a database behind it.
 */
export interface SchedulerRuntimes extends RunExecutionRuntimes {
  /**
   * The agent manager for a registered runtime type.
   *
   * Only ever called for a type {@link RunExecutionRuntimes.has} has already
   * answered `true` for — {@link resolveRunExecution} refuses an unregistered
   * one before anything reaches here — so a throw from this is a bug, not a
   * state to handle.
   */
  get(type: string): SchedulerAgentManager;
}

/**
 * Present ONE agent manager as a whole registry.
 *
 * Says "this one manager answers for whatever runtime the task resolves to" —
 * which is precisely what the scheduler did for EVERY task before this change,
 * so a caller that wraps a single fake keeps testing what it was written to
 * test. The capability profiles and the default type still come from the real
 * registry, so a scheduler built this way resolves power and settings exactly as
 * a wired one does; only the "which manager runs it" lookup is collapsed.
 *
 * Exported because the tests are its callers and the collapse should be visible
 * at each one rather than inferred from which constructor overload was used.
 * Production never takes this path: `index.ts` hands over the registry itself.
 *
 * @param agentManager - The single manager to answer every lookup with.
 */
export function singleRuntimeSource(agentManager: SchedulerAgentManager): SchedulerRuntimes {
  return {
    // Never refuses. This source has one manager and no registry to ask, so
    // refusing here would fail runs over a question it cannot answer. The
    // capability profiles below may still come back empty, which is a
    // different (and non-fatal) fact — see {@link RunExecution.capabilities}.
    has: () => true,
    get: () => agentManager,
    getDefaultType: () => runtimeRegistry.getDefaultType(),
    getAllCapabilities: () => runtimeRegistry.getAllCapabilities(),
  };
}

/**
 * Where one scheduled run happens — resolved once, used by everything
 * (DOR-1615 review).
 *
 * See {@link TaskSchedulerService.resolveRunPlacement} for why the working
 * directory and the agent's manifest directory are two separate answers.
 */
interface RunPlacement {
  /** The directory the turn runs in, after the shared cwd precedence chain. */
  cwd: string;
  /**
   * The agent's own project directory — the one holding `.dork/agent.json` —
   * or absent for a task with no agent. NEVER the resolved `cwd`.
   */
  agentPath?: string;
}

/** Configuration for the task scheduler service. */
export interface SchedulerConfig {
  maxConcurrentRuns: number;
  retentionCount: number;
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
  /**
   * Every runtime a run may execute on — the registry, in production
   * (DOR-1615). Replaces the single `agentManager` this used to take.
   */
  runtimes: SchedulerRuntimes;
  config: SchedulerConfig;
  /** Optional RelayCore instance for dispatching runs via the Relay message bus. */
  relay?: RelayCore | null;
  /**
   * Whether the relay holds a runtime, asked per run (DOR-1614). See
   * {@link RelayRuntimePredicate}.
   *
   * **Absent means the v1 answer — claude-code and nothing else** — so every
   * caller that wired a relay before this field existed routes exactly as it
   * did. See {@link V1_RELAY_RUNTIME}. Production (`index.ts`) passes
   * `AdapterManager.hasAgentRuntime`.
   */
  relayHoldsRuntime?: RelayRuntimePredicate;
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
  /**
   * Every run this process is accountable for, on BOTH dispatch paths — see
   * {@link RunAccounting}. One registry, because a relay-dispatched run is
   * exactly as real as a directly-executed one to the concurrency cap, to
   * `getActiveRunCount()`, and to shutdown.
   */
  private runs: RunAccounting;
  private store: TaskStore;
  private runtimes: SchedulerRuntimes;
  private config: SchedulerConfig;
  private relay: RelayCore | null;
  /**
   * Whether the relay holds a given runtime. Defaults to the v1 answer, so a
   * caller that says nothing routes as it always did — see
   * {@link SchedulerDeps.relayHoldsRuntime}.
   */
  private relayHoldsRuntime: RelayRuntimePredicate;
  private meshCore: MeshCore | null;
  private activityService: ActivityService | null;
  /**
   * The `dorkHome`-scoped leader lock (ADR-285), or `null` for single-process /
   * positional-constructor (test) setups where this process is always leader.
   */
  private leaderLock: LeaderLock | null;
  /** Heartbeat timer that keeps the leader lock fresh; cleared on `stop()`. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Retention timer for run history and the dispatch log; cleared on `stop()`. */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether this process held leadership at the last heartbeat, so a promotion
   * (the leader died and we took over) can be acted on rather than merely
   * happening. See {@link start}.
   */
  private wasLeader = false;
  /** Backing field for {@link isStarted}. */
  private started = false;
  /** Damps the log when a task's schedule cannot be run. See {@link RefusedScheduleLog}. */
  private readonly refusedSchedules = new RefusedScheduleLog();

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
    if ('store' in storeOrDeps && 'runtimes' in storeOrDeps && 'config' in storeOrDeps) {
      // SchedulerDeps object form
      this.store = storeOrDeps.store;
      this.runtimes = storeOrDeps.runtimes;
      this.config = storeOrDeps.config;
      this.relay = storeOrDeps.relay ?? null;
      this.relayHoldsRuntime = storeOrDeps.relayHoldsRuntime ?? V1_RELAY_RUNTIME;
      this.meshCore = storeOrDeps.meshCore ?? null;
      this.activityService = storeOrDeps.activityService ?? null;
      this.leaderLock =
        storeOrDeps.leaderLock ??
        (storeOrDeps.dorkHome ? new SchedulerLock({ dorkHome: storeOrDeps.dorkHome }) : null);
    } else {
      // A deps object that is MISSING `runtimes` reaches here and would be
      // silently treated as a `TaskStore`, leaving `this.store.getTask`
      // undefined until the first dispatch. TypeScript does not catch it — the
      // first parameter is a union, so the object simply matches the other arm
      // — and it is exactly what the rename from `agentManager` to `runtimes`
      // produced in three integration tests (DOR-1615). Said out loud instead.
      if ('store' in storeOrDeps && 'config' in storeOrDeps) {
        throw new TypeError(
          'TaskSchedulerService was given a deps object with no `runtimes`. ' +
            'The scheduler resolves a runtime per run off the registry; pass ' +
            '`runtimes: runtimeRegistry`, or `runtimes: singleRuntimeSource(fake)` in a test.'
        );
      }
      // Positional args form: one agent manager standing in for every runtime.
      this.store = storeOrDeps as TaskStore;
      this.runtimes = singleRuntimeSource(agentManager!);
      this.config = config!;
      this.relay = relay ?? null;
      // Positional form is tests only; it names no relay runtimes, so it takes
      // the same v1 reading as a deps object that omits the predicate.
      this.relayHoldsRuntime = V1_RELAY_RUNTIME;
      this.meshCore = meshCore ?? null;
      this.activityService = null;
      this.leaderLock = null;
    }
    this.runs = new RunAccounting(this.store);
  }

  /**
   * Whether this process may fire (is the leader). Without a lock (single-process
   * / test setups) this process is always the leader.
   */
  private get isLeader(): boolean {
    return this.leaderLock ? this.leaderLock.isLeaderNow : true;
  }

  /**
   * Whether {@link start} has finished, so registering a job is meaningful.
   *
   * Read by {@link TaskRegistrar}, which must not put jobs on the clock during
   * boot: the server listens and the file watcher delivers its initial `add`
   * events before `start()` runs, and a job registered then would be firing
   * ahead of leader election and crash recovery. `start()` registers everything
   * from the store, so nothing is lost by waiting for it.
   */
  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Start the scheduler: elect a leader, recover from crashes, prune old runs,
   * register enabled tasks, and put retention on a timer.
   *
   * Order matters. Crash recovery runs AFTER leader election, because who is
   * entitled to end an unfinished run depends on who is leader — see
   * `crash-recovery.ts` for the rule. Registration comes last, so no job is on
   * the clock while either of those is still deciding.
   */
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
      this.wasLeader = acquired;
      // Guard against a re-entrant start() leaking a prior interval.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.onHeartbeat(), SCHEDULER_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    }

    this.recoverInterruptedRuns();

    // Boot must complete. Every task is registered and pruned inside its own
    // try/catch, because this loop is the last thing standing between one bad
    // row and a server that cannot start: `index.ts` awaits this call, and a
    // throw from here ends in `process.exit(1)`. A single unschedulable task —
    // a cron somebody typo'd in a SKILL.md, a timezone that no longer exists —
    // used to take the whole install down with it, and every OTHER task with
    // it. `registerTask` already contains its own failure; this guard is for
    // everything else in the body, `pruneRuns` most of all.
    const tasks = this.store.getTasks();
    for (const task of tasks) {
      try {
        if (task.enabled && task.status === 'active') {
          this.registerTask(task);
        }
      } catch (err) {
        logger.error(`could not start task "${task.name}" — skipping it`, logError(err));
      }
    }

    // Retention at boot AND on a timer: a server that stays up for a month used
    // to shed nothing at all (DOR-1482). See `run-retention.ts` for the policy
    // and why every process runs it. Unref'd so it never holds the process open.
    const prune = () => pruneRunHistory(this.store, this.config.retentionCount);
    prune();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    this.started = true;
    logger.info(`started with ${this.cronJobs.size} active task(s)`);
  }

  /**
   * One beat of the leader heartbeat: keep our claim fresh, and act on a
   * PROMOTION.
   *
   * A follower that takes over from a leader that died is in exactly the
   * position a leader is in at boot — there may be runs the dead process left
   * unfinished, and it is now the process entitled to end them. Without this,
   * those rows waited for the next restart to be cleaned up, which on a server
   * that is meant to stay up is "never".
   */
  private onHeartbeat(): void {
    this.leaderLock?.heartbeat();
    const leaderNow = this.isLeader;
    if (leaderNow && !this.wasLeader) {
      logger.info('promoted to scheduler leader — checking for runs the previous leader left');
      this.recoverInterruptedRuns();
    }
    this.wasLeader = leaderNow;
  }

  /**
   * End the runs a crash left behind, under the ownership rule in
   * `crash-recovery.ts` — never the unscoped sweep this used to be.
   */
  private recoverInterruptedRuns(): void {
    // The runs this process is executing go in as an exclusion set. At boot
    // there are none; on a PROMOTION there may well be, and ending one of those
    // would be this bug's own mistake made against ourselves.
    const { swept, left } = sweepInterruptedRuns(
      this.store,
      this.leaderLock,
      this.runs.heldRunIds()
    );
    if (swept > 0) logger.info(`marked ${swept} interrupted run(s) as failed`);
    if (left > 0) {
      logger.debug(
        `left ${left} unfinished run(s) alone — this process cannot show they were interrupted`
      );
    }
  }

  /**
   * Stop the scheduler: cancel all jobs and end the runs it can end.
   *
   * ## What draining means on each path
   *
   * A DIRECT run is executed here, so it is aborted and then waited on — up to
   * 30 seconds — which gives its finalizer time to write a real ending.
   *
   * A RELAY run is executed inside an adapter this process holds no handle on,
   * so there is nothing here to abort. What this process CAN do is ask, on the
   * same bus the dispatch went out on, and that is what it does: one stop
   * request per run still in flight, best-effort. It does not then wait for
   * them, because the answer is not this process's to give — the runner may be
   * elsewhere, may already have finished, or may be going down with us. A run
   * left unfinished by a shutdown is exactly what the crash sweep on the next
   * boot is for.
   */
  async stop(): Promise<void> {
    // Said first, so nothing registers a job into a scheduler that is on its way
    // down — a watcher event can land while this is still awaiting active runs.
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.leaderLock?.release();
    this.wasLeader = false;

    for (const [id, cron] of this.cronJobs) {
      cron.stop();
      this.cronJobs.delete(id);
    }

    this.runs.abortDirect();
    await this.stopRelayRuns();

    // Wait up to 30s for the runs this process is actually executing.
    const deadline = Date.now() + 30_000;
    while (this.runs.directCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.store.close();
    logger.info('scheduler stopped');
  }

  /**
   * Ask the bus to stop every relay-dispatched run this process is still
   * holding, then stop holding them.
   *
   * Never throws and never reports: a shutdown that failed to send a stop is
   * not a shutdown that should hang, and the honest record of a run nobody
   * ended is the run row itself.
   */
  private async stopRelayRuns(): Promise<void> {
    const relayRunIds = this.runs.relayRunIds();
    if (relayRunIds.length === 0) return;

    if (this.relay) {
      logger.info(`asking ${relayRunIds.length} relay-dispatched run(s) to stop`);
      await Promise.allSettled(relayRunIds.map((runId) => publishRunStop(this.relay!, runId)));
    } else {
      logger.warn(
        `${relayRunIds.length} relay-dispatched run(s) are in flight with no bus to ask — ` +
          'leaving them to their runner'
      );
    }
    this.runs.forgetRelayRuns();
  }

  /**
   * Register a cron job for a task, replacing any job it already has.
   *
   * **Total: this never throws.** A task's cron and timezone reach here from
   * three places — an API request, a SKILL.md somebody hand-edited, a row an
   * older build wrote — and `croner` throws on an expression or a timezone it
   * cannot read. Letting that escape made one bad file able to abort server
   * startup, and able to break whichever writer happened to touch it next. A
   * task that cannot be scheduled is a task that does not run; it is never
   * a reason to take the other tasks down.
   *
   * The API refuses a bad schedule at the door
   * (`describeScheduleProblem` in `cron-validation.ts`), so in practice only a
   * hand-edited file gets this far.
   *
   * @param task - The task to schedule.
   * @returns Whether the task now has a live cron job. `false` covers both an
   *   on-demand task, which is not meant to have one, and a schedule croner
   *   refused.
   */
  registerTask(task: Task): boolean {
    if (!task.cron) {
      logger.debug(`skipping cron registration for on-demand task "${task.name}"`);
      return false;
    }

    if (this.cronJobs.has(task.id)) {
      this.unregisterTask(task.id);
    }

    // The task's own timezone, and nothing else. `pulse_schedules.timezone` is
    // NOT NULL DEFAULT 'UTC' and every write path fills it, so there was never
    // anything for a server-wide default to fall through to — the setting that
    // used to sit here did nothing at all, and was removed (DOR-1482).
    const tz = task.timezone ?? undefined;
    let job: Cron;
    try {
      job = new Cron(task.cron, { protect: true, timezone: tz }, (self) => {
        // Pass the cron's intended tick (not wall-clock) so dispatch idempotency
        // dedups on a value that's identical across processes (ADR-285).
        this.dispatch(task, self.currentRun()).catch((err) => {
          logger.error(`dispatch error for ${task.name}:`, err);
        });
      });
    } catch (err) {
      this.refusedSchedules.report(task, tz, err);
      return false;
    }

    // The schedule reads again, so the next refusal of this task is news.
    this.refusedSchedules.clear(task.id);
    this.cronJobs.set(task.id, job);
    logger.debug(`registered task "${task.name}" (${task.cron})`);
    return true;
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

    const controller = this.runs.directController(runId);
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

  /**
   * How many runs this process has in flight, counting BOTH the ones it is
   * executing itself and the ones it handed to the relay — see
   * {@link RunAccounting}. Reading only the direct ones, as this used to, made
   * the number a flat zero on any install with the relay enabled.
   */
  getActiveRunCount(): number {
    return this.runs.count();
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
   * Resolve, ONCE per run, the two directories a scheduled run needs.
   *
   * They are genuinely two different questions and conflating them was a bug
   * (DOR-1615 review):
   *
   * - **`cwd` — where the run WORKS.** MeshCore turns the agent id into a
   *   directory and the shared precedence chain
   *   (`services/workspace/resolve-session-cwd.ts`) turns that into the
   *   directory the run actually gets — the agent's own folder for the default
   *   `home` binding, its private checkout for `managed`, and `DEFAULT_CWD` for
   *   `none` or a binding the boundary refuses.
   * - **`agentPath` — where the agent's `.dork/agent.json` LIVES.** That is the
   *   pre-chain `projectPath`, always. A `managed` agent's provisioned checkout
   *   has no manifest in it, and a `none` binding lands on `DEFAULT_CWD`, which
   *   may hold a DIFFERENT agent's manifest entirely — so reading the execution
   *   ladder's agent tier out of `cwd` silently lost the agent's own
   *   model/runtime, or picked up a stranger's.
   *
   * Resolved once and threaded to both consumers because the chain is not free:
   * in `managed` mode it provisions (a git checkout and a port allocation), and
   * its rungs degrade independently, so asking twice could also answer twice.
   *
   * Two failures, told apart on purpose:
   *
   * - **A missing agent throws**, loudly and unchanged. An unregistered agent is
   *   a broken LINK a person has to fix — there is no directory to run in, so
   *   the run must not start.
   * - **A registered agent whose binding cannot be honored does not throw.** The
   *   directory exists; only the preference about it is unreadable. The chain
   *   degrades one rung, to the agent's own folder, and logs the reason
   *   (`[cwd] resolved` carries `degraded`). Failing the run there would turn a
   *   typo in `agent.json` into a schedule that silently stops firing.
   *
   * So this method is strict about the link and forgiving about the preference,
   * which is not a contradiction: one of them says WHETHER the run can happen and
   * the other only says WHERE.
   *
   * @param task - The task to resolve CWD for
   * @returns Where the run works, and where its agent's manifest lives
   * @throws When agentId is set but the agent is not found in the Mesh registry
   */
  private async resolveRunPlacement(task: Task): Promise<RunPlacement> {
    if (task.agentId && this.meshCore) {
      const projectPath = this.meshCore.getProjectPath(task.agentId);
      if (!projectPath) {
        throw new Error(
          `Agent ${task.agentId} not found in registry -- task ${task.id} cannot run. ` +
            'The agent may have been unregistered. Re-link the task to a valid agent or directory.'
        );
      }
      return {
        cwd: (await resolveSessionCwd({ agentPath: projectPath })).cwd,
        agentPath: projectPath,
      };
    }
    // Unchanged: `process.cwd()`, not `DEFAULT_CWD`. The two are the same in
    // every deployment that does not set `DORKOS_DEFAULT_CWD`, and routing an
    // agent-less task through the chain's default rung would quietly move the
    // ones where they differ.
    return { cwd: process.cwd() };
  }

  /**
   * Dispatch a scheduled run — checks the firing gate, leadership, task state
   * and dispatch idempotency, then either starts the run or records why it did
   * not.
   *
   * ## A tick that is missed is missed
   *
   * There is no catch-up. A schedule that came round while this server was off,
   * or while it was already at its concurrency cap, is not run later — the
   * occurrence is gone and the next one is the next one. That is deliberate:
   * these are agent turns that do real work, and a server starting after a
   * weekend off would otherwise fire a weekend's worth of them at once, all
   * acting on a world that has moved on. What a person gets instead is a record
   * that the occurrence was not run (below), which is the part that was missing.
   *
   * ## Why the claim comes before the concurrency check
   *
   * The claim is what makes a tick happen once across every process sharing
   * this database. A cap check that returned BEFORE it, as this used to, meant
   * a busy leader dropped the tick silently while leaving it unclaimed — so
   * another process could still run it, and nothing anywhere recorded the
   * decision. Claiming first makes the skip itself idempotent: exactly one
   * process writes exactly one `skipped` run for that occurrence.
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

    // Re-read task to check current state
    const current = this.store.getTask(task.id);
    if (!current || !current.enabled || current.status !== 'active') {
      logger.debug(`skipping "${task.name}" — disabled or not active`);
      return;
    }

    // Two reasons a tick is recorded but not run, in priority order. The global
    // cap comes first because it is about the whole machine; sticky
    // single-session serialization is about this one task (DOR-1571). A sticky
    // task runs everything on one session, so a fire that lands while its
    // previous run is still going must NOT open a second turn on it — that would
    // corrupt the very session sticky exists to keep coherent. Checked here, the
    // same way `atCap` is, so both end in the same `skipped` run row.
    const atCap = this.runs.count() >= this.config.maxConcurrentRuns;
    const stickyBusy = !atCap && current.sticky && this.store.hasRunningRunForTask(current.id);
    const skipReason = atCap ? this.atCapReason() : stickyBusy ? this.stickyBusyReason() : null;

    // Idempotency gate (ADR-285): atomically claim this scheduled tick, opening
    // its run row in the same transaction. If another process (or a duplicate
    // fire) already claimed it, skip. The leader lock makes this rare; this is
    // the durable backstop for the handoff/double-fire window. The key is the
    // trigger time floored to the cron's resolution (see scheduledTickKey) so
    // co-located processes firing the same occurrence agree.
    let run: TaskRun | null;
    if (current.cron) {
      const firedAt = scheduledFireTime ?? this.cronJobs.get(task.id)?.currentRun() ?? new Date();
      const tickKey = scheduledTickKey(current.cron, firedAt);
      run = this.store.claimScheduledRun(
        task.id,
        tickKey,
        skipReason ? { status: 'skipped', reason: skipReason } : { status: 'running' }
      );
      if (!run) {
        logger.debug(
          `skipping "${task.name}" — tick ${new Date(tickKey).toISOString()} already dispatched`
        );
        return;
      }
    } else {
      // No cron, so no occurrence to claim — an on-demand task can only get
      // here by being dispatched directly, and the skip reasons still apply.
      if (skipReason) {
        logger.warn(`skipped "${task.name}" — ${skipReason}`);
        return;
      }
      run = this.store.createRun(task.id, 'scheduled');
    }

    if (skipReason) {
      // The run row above is the artifact a person actually finds: it sits in
      // the task's own history, at the time the schedule came round, saying why
      // nothing happened. The operator's mental model is "it runs every hour",
      // and a dropped occurrence that leaves no trace makes that model quietly
      // wrong. Deliberately NOT an activity-feed event as well — one record of
      // a non-event is enough, and the feed is for things that happened.
      logger.warn(`skipped a scheduled run of "${task.name}" — ${skipReason}`);
      return;
    }

    await this.executeRun(current, run);
  }

  /** Why a tick was not run, in the words a person reads on the run row. */
  private atCapReason(): string {
    const cap = this.config.maxConcurrentRuns;
    return `DorkOS was already running ${cap} task${cap === 1 ? '' : 's'} at once, which is its limit`;
  }

  /**
   * Why a sticky tick was not run: its own previous run is still going, and a
   * sticky task keeps everything in one session (DOR-1571).
   */
  private stickyBusyReason(): string {
    return (
      'This task resumes one session every run, and its previous run was still going when this ' +
      'one came round — so it was skipped rather than starting a second turn on the same session'
    );
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
        // Both resolved FIRST, before either dispatch path. The execution
        // decides which path is even eligible, and a run that cannot resolve a
        // runtime must fail without a turn being started anywhere (DOR-1615).
        // The placement comes first because the execution ladder's agent tier
        // reads out of it, and because resolving it once is what stops the cwd
        // chain running (and, in `managed` mode, PROVISIONING) two or three
        // times per run with independently degradable answers.
        let placement: RunPlacement;
        let execution: RunExecution;
        try {
          placement = await this.resolveRunPlacement(task);
          execution = await this.resolveExecution(task, placement);
        } catch (err) {
          this.failRun(run, err);
          recordDispatchEnd(dispatchId, 'failed');
          return;
        }
        span.setAttr(ATTR.RUNTIME, execution.runtimeType);
        // What actually ran, on the run row, before anything runs — see
        // `TaskStore.recordRunExecution` for why it cannot wait until after.
        this.store.recordRunExecution(run.id, {
          runtime: execution.runtimeType,
          model: execution.settings.model ?? null,
        });

        // **Only a runtime the relay can actually drive** (DOR-1614). This read
        // `execution.runtimeType === 'claude-code'` while the relay held one
        // runtime; it now asks the relay itself, so a codex or opencode task
        // rides the bus exactly when there is something on the far side to run
        // it, and goes DIRECT — same run, same row, same accounting, executed in
        // this process — when there is not.
        //
        // The far side refuses a runtime it does not hold rather than
        // substituting one, so a false negative here costs nothing (the run
        // still happens, in process) while a false positive would strand it.
        // That asymmetry is why production answers "no" for a relay that never
        // built (`index.ts` reads the live `adapterManager` through `?? false`)
        // rather than guessing. It is NOT why the predicate is optional — an
        // absent predicate takes the v1 reading instead, see
        // {@link V1_RELAY_RUNTIME}.
        const viaRelay =
          isRelayEnabled() && this.relay !== null && this.relayHoldsRuntime(execution.runtimeType);
        span.setAttr(ATTR.TASK_DISPATCH, viaRelay ? 'relay' : 'direct');
        try {
          const result = viaRelay
            ? await dispatchRunViaRelay(
                {
                  store: this.store,
                  relay: this.relay!,
                  runs: this.runs,
                  // Already resolved, once, above — see `resolveRunPlacement`.
                  resolveCwd: () => Promise.resolve(placement.cwd),
                },
                task,
                run,
                execution
              )
            : await this.executeRunDirect(task, run, execution, placement.cwd);
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
   * Which runtime, model and effort this task's run executes on.
   *
   * A thin wrapper so the scheduler's two dispatch paths ask the same question
   * of the same resolver.
   *
   * The agent tier reads {@link RunPlacement.agentPath} — the agent's own
   * project directory — and NOT the run's working directory. Those are the same
   * folder only for the default `home` binding; a `managed` agent works in a
   * provisioned checkout with no manifest in it, and a `none` binding works in
   * `DEFAULT_CWD`, which may hold an unrelated agent's manifest. Passing the cwd
   * here therefore lost the agent's own runtime and model for every binding but
   * one, and could read a stranger's (DOR-1615 review).
   *
   * Absent for a task with no agent, and then the agent tiers simply drop out.
   *
   * @param task - The task being dispatched.
   * @param placement - Where this run happens, already resolved.
   * @throws {TaskRuntimeUnavailableError} When the resolved runtime is off.
   */
  private async resolveExecution(task: Task, placement: RunPlacement): Promise<RunExecution> {
    return resolveRunExecution(task, {
      runtimes: this.runtimes,
      ...(placement.agentPath !== undefined ? { agentPath: placement.agentPath } : {}),
    });
  }

  /**
   * End a run that never started, with the reason on the row a person reads.
   *
   * The activity-feed event rides the TaskStore run-terminal hook (DOR-1573),
   * fired by this `updateRun('failed')` — the one funnel both dispatch paths
   * share.
   *
   * @param run - The run row, already opened.
   * @param err - Why it could not start.
   */
  private failRun(run: TaskRun, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.store.updateRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: message,
    });
    logger.error(`run ${run.id} could not start: ${message}`);
  }

  /**
   * Execute a run directly via the resolved runtime's agent manager — manages
   * AbortController, streams output, updates status.
   *
   * @param task - The task being run.
   * @param run - Its run row, already opened.
   * @param execution - What this run resolved to run on (DOR-1615).
   * @param effectiveCwd - Where it runs, resolved once by
   *   {@link TaskSchedulerService.resolveRunPlacement}. A broken agent link has
   *   already failed the run there, with the same message it used to raise here.
   */
  private async executeRunDirect(
    task: Task,
    run: TaskRun,
    execution: RunExecution,
    effectiveCwd: string
  ): Promise<void> {
    // The manager for the runtime this run RESOLVED to, not one bound at boot.
    // Safe to `get` unconditionally: `resolveRunExecution` has already refused an
    // unregistered type, so a throw here would be a bug rather than a state.
    const agentManager = this.runtimes.get(execution.runtimeType);

    const controller = new AbortController();
    this.runs.addDirect(run.id, controller);

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
    // Which session this run runs on. A non-sticky run is isolated on the run's
    // own id, exactly as before; a sticky run resumes the real SDK session of the
    // task's previous run, so context carries across runs (DOR-1571). Declared out
    // here, not inside the `try`, because the failure finalizer needs it too.
    // A sticky task whose resolved runtime differs from the one its previous RUN
    // used starts FRESH — sessions are runtime-bound and never revised
    // (ADR-0255), so there is nothing there to resume (DOR-1615).
    const { sessionId, hasStarted } = resolveRunSession(this.store, task, run, {
      runtimeType: execution.runtimeType,
    });

    // What to write as this run's `sessionId`. For a sticky run it is the RUNTIME's
    // own id after the turn — the id the SDK actually wrote its transcript under —
    // so the next fire can resume it cold and so clicking the run opens the real
    // conversation. `sessionId` (the key we passed in) is only a resume request;
    // the SDK mints or keeps its own, and `getInternalSessionId` reads it back.
    // Non-sticky is unchanged: the run's own id. Resolved lazily so each terminal
    // branch — including the failure finalizer — records the freshest answer.
    const persistedSessionId = (): string =>
      task.sticky ? (agentManager.getInternalSessionId(sessionId) ?? sessionId) : sessionId;

    try {
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
      //
      // The profile is the RESOLVED runtime's, so a task that runs on Codex has
      // its trust stop read in Codex's mode vocabulary (DOR-1615).
      const permissionMode = (task.permissionMode ??
        resolveScheduledRunPermissionMode({
          capabilities: execution.capabilities,
        })) as PermissionMode;

      agentManager.ensureSession(sessionId, {
        permissionMode,
        cwd: effectiveCwd,
        // What this run resolved to run on. Spread into BOTH calls, the way
        // `agent-handler.ts` spreads its own, because the two seams answer for
        // different runtimes: claude-code reads the model off the session record
        // at launch, while a runtime that does not hold sessions in memory sees
        // only the send. Absent keys mean "the runtime decides".
        ...execution.settings,
        // Resume a sticky session that has already run, so the turn picks the
        // conversation back up rather than starting over. This explicit
        // `ensureSession` short-circuits `sendMessage`'s own transcript probe, so
        // the answer has to be carried here (DOR-1571). Always false for a
        // non-sticky run and a sticky task's first fire.
        hasStarted,
        // Nobody is coming back to a scheduled run, so an unanswered prompt is
        // refused at ten minutes instead of parking for four hours and stalling
        // the run (spec `ask-parks-on-timeout` §7).
        unattended: true,
      });

      const taskAppend = buildTaskAppend(task, run);
      const stream = agentManager.sendMessage(sessionId, task.prompt, {
        permissionMode,
        cwd: effectiveCwd,
        systemPromptAppend: taskAppend,
        ...execution.settings,
      });

      const stopped = await consumeRunStream(
        stream,
        combinedSignal,
        () => void interruptRun(agentManager, sessionId),
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
          sessionId: persistedSessionId(),
        });
        // A cancel is the one terminal status that does NOT ride the run-terminal
        // hook's activity emit (DOR-1573): the run row cannot say whether an
        // operator or a deadline ended it, and the two carry different actors. So
        // it is emitted here, where `operatorCancelled` is known. The cancel route
        // emits its own `tasks.run_cancelled` the moment the operator asks,
        // attributed to "You"; emitting again here would double it, the second
        // time attributed to the Scheduler. A deadline or a shutdown abort has no
        // such route emit, so it still needs this one. NOTE: this branch is
        // DIRECT-path only — a relay-dispatched run that hits its deadline is
        // finalized in `packages/relay` and emits nothing, so that case reaches
        // no activity feed today (the residual gap tracked by DOR-1580).
        if (!operatorCancelled)
          emitRunActivity(this.activityService, task, run, 'cancelled', durationMs);
      } else {
        this.store.updateRun(run.id, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, 500),
          sessionId: persistedSessionId(),
        });
        // The activity-feed event for a completed run rides the TaskStore
        // run-terminal hook (DOR-1573), fired by the `updateRun('completed')`
        // above — the one funnel both dispatch paths share.
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
        sessionId: persistedSessionId(),
      });
      logger.error(`run ${run.id} failed:`, err);
      // The activity-feed event for this failure rides the TaskStore run-terminal
      // hook (DOR-1573), fired by the `updateRun('failed')` above.
    } finally {
      this.runs.release(run.id);
    }
  }
}
