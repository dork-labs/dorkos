/**
 * Tasks at startup: the scheduler, its routes, the file watcher and the
 * reconciler that keep schedules in step with the files that declare them,
 * and the legacy migration and approval carry-over that run before any of
 * them watch (DOR-2821, moved out of `index.ts` unchanged).
 *
 * @module startup/tasks
 */
import type { MeshCore } from '@dorkos/mesh';
import type { HonoApiDeps } from '../http/hono-api.js';
import { logger, logError } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { keepAwakeService } from '../services/core/keep-awake/index.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveScheduleParkPayload } from '../services/notifications/emitters/schedule-park.js';
import { raiseStanding } from '../services/notifications/standing-events.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { RELAY_NOT_BUILT } from '../services/relay/task-dispatch/readiness.js';
import { startAgentExecutionWatch } from '../services/tasks/approvals/agent-execution-watch.js';import { attachAgentRoots, attachTaskRoot } from '../services/tasks/attach-task-roots.js';
import { migrateLegacySchedules } from '../services/tasks/legacy-migration.js';
import type { resolveTasksFiring } from '../services/tasks/resolve-firing.js';
import { ScheduleIdentityRegistry } from '../services/tasks/schedule-identity.js';
import {
  agentTaskRoots,
  ensureGlobalSkillsRoot,
  globalTaskRoots,
} from '../services/tasks/skills-roots.js';
import { TaskFileWatcher } from '../services/tasks/task-file-watcher.js';
import { TaskReconciler } from '../services/tasks/task-reconciler.js';
import { TaskRegistrar } from '../services/tasks/task-registrar.js';
import {
  TaskSchedulerService,
  type SchedulerDeps,
} from '../services/tasks/task-scheduler-service.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { setTasksEnabled } from '../services/tasks/task-state.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import { ensureDefaultTemplates } from '../services/tasks/task-templates.js';

/** What starting Tasks needs from the startup that came before it. */
export interface TasksStartupDeps {
  /** What the moved Hono routes read; the tasks routes are handed theirs here. */
  honoDeps: HonoApiDeps;
  /** Whether Tasks is on for this boot. */
  tasksEnabled: boolean;
  /** The task store, when it opened. */
  taskStore: TaskStore | undefined;
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  /** The agent registry, when Mesh started. */
  meshCore: MeshCore | undefined;
  /** The activity feed. */
  activityService: ActivityService;
  /** The relay, when it started. */
  relayCore: SchedulerDeps['relay'];
  /** The `scheduler` config section. */
  schedulerConfig: { maxConcurrentRuns: number; retentionCount: number };
  /** Whether schedules may fire on this boot, and why not. */
  firing: ReturnType<typeof resolveTasksFiring>;
  /** Paused agents, whose runs are skipped. */
  agentPauses: SchedulerDeps['agentPauses'];
  /**
   * The adapter manager as `index.ts` holds it now. Asked per run, never
   * captured: see `relayHoldsRuntime` below.
   */
  currentAdapterManager: () => AdapterManager | undefined;
  /** The names of the routers mounted so far, for the boot log line. */
  mountedRouters: string[];
}

/** What `index.ts` keeps from Tasks, all absent when Tasks is off. */
export interface StartedTasks {
  /** The scheduler. */
  schedulerService: TaskSchedulerService | null;
  /** The one seam every writer of a task's schedule registers through. */
  taskRegistrar: TaskRegistrar | undefined;
  /** The file watcher over every schedule root. */
  taskFileWatcher: TaskFileWatcher | undefined;
  /** The reconciler behind the watcher. */
  taskReconciler: TaskReconciler | undefined;
  /** Watches a newly registered agent's schedule roots; absent without Mesh. */
  attachAgentTaskRoots: ((projectPath: string, agentId: string) => Promise<void>) | undefined;
}

/**
 * Every registered agent that has a project on disk, as the legacy migration
 * wants them.
 *
 * Lives apart rather than inline because the filter is the interesting part: an
 * agent with no resolvable project path has no `.dork/tasks/` to migrate and no
 * `.agents/skills/` to migrate into, and asking about it would only produce a
 * pair of ENOENTs.
 *
 * @param meshCore - The registry, absent when Mesh is switched off.
 */
function registeredAgentRoots(
  meshCore: MeshCore | undefined
): { agentId: string; projectPath: string }[] {
  if (!meshCore) return [];
  return meshCore.list().flatMap((agent) => {
    const projectPath = meshCore.getProjectPath(agent.id);
    return projectPath ? [{ agentId: agent.id, projectPath }] : [];
  });
}

/**
 * Start Tasks, when it is on and its store opened.
 *
 * @param deps - See {@link TasksStartupDeps}.
 * @returns See {@link StartedTasks}.
 */
export async function startTasks(deps: TasksStartupDeps): Promise<StartedTasks> {
  const {
    honoDeps,
    tasksEnabled,
    taskStore,
    dorkHome,
    meshCore,
    activityService,
    relayCore,
    schedulerConfig,
    firing,
    agentPauses,
    currentAdapterManager,
    mountedRouters,
  } = deps;
  let schedulerService: TaskSchedulerService | null = null;
  let taskRegistrar: TaskRegistrar | undefined;
  let taskFileWatcher: TaskFileWatcher | undefined;
  let taskReconciler: TaskReconciler | undefined;
  let attachAgentTaskRoots: StartedTasks['attachAgentTaskRoots'];
  // Mount Tasks routes if enabled. The scheduler resolves a runtime PER RUN off
  // the registry (DOR-1615) — it no longer holds one agent manager bound at
  // boot, which is what made every scheduled run a Claude Code run whatever the
  // task or its agent said. A test-mode boot needs nothing special: `test-mode`
  // is registered and set as the default above, so that is what a task with no
  // runtime of its own resolves to.
  if (tasksEnabled && taskStore) {
    // An agent's runtime, model or effort changed by editing its file rather
    // than through DorkOS re-asks for the approved schedules that follow it
    // (DOR-2337). `agent-execution-watch.ts` says when it looks and why.
    const agentExecutionWatch = startAgentExecutionWatch({
      dorkHome,
      store: taskStore,
      agents: () => meshCore?.listWithPaths() ?? [],
      onParked: async (tasks) => {
        for (const parked of tasks) {
          taskRegistrar?.syncTask(parked.id);
          raiseStanding('schedule.parked', await resolveScheduleParkPayload(parked));
        }
        broadcastTasksChanged();
      },
      activity: activityService,
      logger,
    });

    schedulerService = new TaskSchedulerService({
      store: taskStore,
      runtimes: runtimeRegistry,
      config: {
        maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
        retentionCount: schedulerConfig.retentionCount,
        mayFire: firing.mayFire,
        firingReason: firing.reason,
      },
      relay: relayCore,
      // Whether the bus can actually run a turn on this runtime, asked per run
      // (DOR-1614) and answered from LIVE adapter state (DOR-1636). Read
      // through the live `adapterManager` rather than captured at this line.
      // Phase C runs earlier than this in the current ordering, so capturing
      // would happen to work today — but the binding is deliberately late for
      // two reasons that outlive the ordering. Moving either block would
      // silently freeze a stale value, and Phase C RESETS `adapterManager` to
      // `undefined` when its init throws (see its catch), which a captured
      // reference could not see. A relay that never built, or that failed
      // building, must answer "no" — which is what `?? RELAY_NOT_BUILT` says —
      // and then every run executes in this process, as it always did with the
      // relay off.
      relayHoldsRuntime: (runtimeType, subject) =>
        currentAdapterManager()?.canRunTaskOnBus(runtimeType, subject) ?? RELAY_NOT_BUILT,
      meshCore,
      activityService,
      dorkHome,
      beforeScheduledFire: (task) => agentExecutionWatch.beforeScheduledFire(task),
      // Each run holds the computer awake from placement to its last event.
      keepAwake: keepAwakeService,
      // A paused agent's runs are skipped, never started (spec `audit-trail` PR5).
      agentPauses,
    });
    // The ONE registration seam, shared by every writer that can change what a
    // task's schedule is: these routes, the file watcher, and the reconciler.
    taskRegistrar = new TaskRegistrar({ store: taskStore, scheduler: schedulerService });
    honoDeps.tasks = {
      store: taskStore,
      scheduler: schedulerService,
      registrar: taskRegistrar,
      dorkHome,
      ...(meshCore && { meshCore }),
      activity: activityService,
    };
    setTasksEnabled(true);
    mountedRouters.push('tasks');

    // Cascade-pause: when an agent is unregistered from Mesh, pause its linked task schedules.
    // The callback receives the project path captured before registry removal —
    // meshCore.getProjectPath(agentId) would already return undefined here.
    if (meshCore) {
      meshCore.onUnregister((agentId, projectPath) => {
        // Forgotten, like its permission record, so a later folder reusing
        // its id starts fresh (DOR-2337).
        void agentExecutionWatch.forget(agentId);
        const pausedCount = taskStore.disableTasksByAgentId(agentId);
        if (pausedCount > 0) {
          logger.info(
            `[Tasks] Paused ${pausedCount} schedule(s) for unregistered agent ${agentId}`
          );
        }
        // Stop watching and reconciling every root that belonged to the agent.
        for (const root of agentTaskRoots(projectPath, agentId)) {
          taskFileWatcher?.stopWatching(root.dir).catch(() => {});
          taskReconciler?.removeDirectory(root.dir);
        }
      });
    }

    // Wire file watcher and reconciler for file-first schedule sync.
    //
    // One identity registry shared by both halves: they are two views of one
    // discovery pass, and a claim on a real SKILL.md only means anything if
    // both respect it (`services/tasks/schedule-identity.ts`).
    const scheduleIdentities = new ScheduleIdentityRegistry();
    taskFileWatcher = new TaskFileWatcher(taskStore, taskRegistrar, scheduleIdentities);
    // The watcher is also the reconciler's health source: a root whose watch is
    // deaf (its directory does not exist yet) or dead (chokidar errored on it,
    // after which it reports nothing at all) is covered every ten seconds
    // instead of every five minutes, because for that root the reconciler is not
    // a backstop — it is the only thing looking (DOR-1908).
    taskReconciler = new TaskReconciler(
      taskStore,
      taskRegistrar,
      scheduleIdentities,
      taskFileWatcher,
      () => agentExecutionWatch.checkAll()
    );
    const discovery = { watcher: taskFileWatcher, reconciler: taskReconciler };

    // Schedules written in the old shape move to the new one, once, on the boot
    // that finds them — files rewritten, directories moved, rows re-keyed with
    // their approvals intact (`legacy-migration.ts`, ADR `260823-200729`).
    //
    // FIRST, and the order is load-bearing twice over: before any watcher, so
    // discovery never races a file being rewritten under it, and before the
    // grant backfill below, which reads each row's own content and so has to see
    // the finished migration rather than the middle of it. A no-op in
    // microseconds once there is nothing left to migrate.
    await migrateLegacySchedules({
      dorkHome,
      store: taskStore,
      agents: registeredAgentRoots(meshCore),
    });

    // Every schedule that was already live keeps its approval across this
    // upgrade. The arm grant is a stored key now, and rows written before that
    // column existed have none — so without this pass the first sync would park
    // every schedule an alpha user already approved. Runs BEFORE any watcher
    // starts, and matches nothing on the second boot.
    // Approvals recorded in an older key format move onto today's key, extended
    // with the timezone (DOR-2307) and the settings (DOR-2323) each schedule
    // already runs with. Before the backfill and before any watcher, for the
    // same reason as both: a sync that found a stale-shaped key would park an
    // approved schedule.
    const upgraded = taskStore.approvals.upgradeLegacyApprovalKeys();
    if (upgraded > 0) {
      logger.info(
        `[Tasks] Carried ${upgraded} approval(s) over to include each schedule's timezone and settings`
      );
    }

    // Before the backfill, which then keeps what these rows already say, and before any sync reads
    // their files (DOR-3440). They stay off: the backfill grants, it never switches on.
    await taskStore.approvals.clearOutsiderParks();

    const backfilled = taskStore.approvals.backfillApprovalGrants();
    if (backfilled > 0) {
      logger.info(`[Tasks] Kept ${backfilled} already-approved schedule(s) approved`);
    }

    // `~/.dork/skills/` is created rather than merely watched, so that a person
    // looking for where to put a global schedule finds it already there.
    await ensureGlobalSkillsRoot(dorkHome);
    for (const root of globalTaskRoots(dorkHome)) attachTaskRoot(discovery, root);

    if (meshCore) {
      for (const agent of meshCore.list()) {
        const projectPath = meshCore.getProjectPath(agent.id);
        if (projectPath) attachAgentRoots(discovery, projectPath, agent.id);
      }

      // Agents that register AFTER boot get their roots watched immediately.
      //
      // Until DOR-1485 the loop above was the only place roots were ever added,
      // so a newly registered agent's schedules were invisible until the next
      // restart — the gap `task-reconciler.ts` documents in its retirement
      // notes. The agent-created listener further down calls this; that hook is
      // the one seam every arrival funnels through (create, register,
      // marketplace install, discovery adoption) and it carries the project
      // path, so nothing has to be looked up.
      attachAgentTaskRoots = async (projectPath: string, agentId: string): Promise<void> => {
        // Migrate BEFORE watching, for the same reason boot does. An agent that
        // registers after boot brings its own project with it, legacy
        // `.dork/tasks/` and all — and that directory is no longer watched, so
        // without this pass its schedules would be neither migrated nor
        // discovered until the next restart. That is a REGRESSION against the
        // build before this wave, where the legacy root was attached here and
        // its schedules started working immediately.
        //
        // Safe to call from a hook: it is idempotent, it never throws, and
        // scoping it to one agent means it reads two directories.
        await migrateLegacySchedules({
          dorkHome,
          store: taskStore,
          agents: [{ agentId, projectPath }],
        });
        attachAgentRoots(discovery, projectPath, agentId);
        // A baseline from the moment it arrives (DOR-2337).
        await agentExecutionWatch.checkAgent(projectPath);
        logger.info(`[Tasks] Watching schedule roots for newly registered agent ${agentId}`);
      };
    }

    taskReconciler.start();
    logger.info('[Tasks] File watcher and reconciler started');
    // Every registered agent gets a baseline before the first fire, so an edit
    // made after this boot is compared with something (DOR-2337).
    await agentExecutionWatch.checkAll();

    // Ensure default templates exist
    ensureDefaultTemplates(dorkHome).catch((err) => {
      logger.warn('[Tasks] Failed to seed default templates', logError(err));
    });
  }

  return { schedulerService, taskRegistrar, taskFileWatcher, taskReconciler, attachAgentTaskRoots };
}
