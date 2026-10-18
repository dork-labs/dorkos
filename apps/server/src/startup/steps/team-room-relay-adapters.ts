/**
 * Work that needs Mesh: carried Claude accounts, the team room, live change
 * broadcasts, moment detectors, the relay adapters and the notification
 * pipeline's out-of-app leg, and the task run listeners.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/team-room-relay-adapters
 */
import { moveAccountReferences } from '../../services/core/usage/account-reference-move.js';
import { renameAccountInProjectAccounts } from '../../services/core/usage/account-eligibility-writes.js';
import { configManager } from '../../services/core/config-manager.js';
import { renameScheduleAccount } from '../../services/tasks/approvals/account-rename.js';
import { isPackageOwned, packageOwnershipContext } from '../../services/tasks/task-file-update.js';
import { dropClaudeAccountRenameMarkers } from '../../services/runtimes/claude-code/claude-config-dir.js';
import {
  type TeamRoomDeps,
  ensureTeamRoom,
  watchDefaultAgent,
} from '../../services/rooms/ensure-team-room.js';
import {
  sweepDepartedAgentSeats,
  diskEvidence,
} from '../../services/rooms/manage/departed-agents.js';
import { logger, logError } from '../../lib/logger.js';
import { wireLiveChangeBroadcasts } from '../../services/core/streams/live-change-broadcasts.js';
import {
  getRemoteConnectionStore,
  isConnectionVisible,
} from '../../services/communities/remote/state.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { createMomentDetectors } from '../../services/rooms/moments/index.js';
import { startRelayAdapters } from '../relay-adapters.js';
import type { NotifyDmDeps } from '../../services/relay/notify-dm.js';
import { createRunTerminalListener } from '../../services/tasks/run-terminal-broadcaster.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  type StandingCondition,
  getEscalationService,
} from '../../services/notifications/escalation-service.js';
import { needsScheduleApprovalAttention } from '../../services/tasks/schedule-permission-clamp.js';
import { resolveScheduleParkPayload } from '../../services/notifications/emitters/schedule-park.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { StartSearchRelayAndMeshResult } from './search-relay-mesh.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireTeamRoomAndRelayAdapters} reads from the startup steps before it. */
export interface WireTeamRoomAndRelayAdaptersInput {
  db: OpenConfigAndDatabaseResult['db'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  roomService: WireRoomsResult['roomService'];
  resolveOperatorAuthorId: WireRoomsResult['resolveOperatorAuthorId'];
  directChats: WireRoomsResult['directChats'];
  roomStore: WireRoomsResult['roomStore'];
  roomAuthors: WireRoomsResult['roomAuthors'];
  activityService: WireCoreStoresResult['activityService'];
  relayEnabled: StartSearchRelayAndMeshResult['relayEnabled'];
  roomBridges: WireRoomsResult['roomBridges'];
  resolveOperatorDisplayName: WireRoomsResult['resolveOperatorDisplayName'];
  meshSignalEmitter: StartSearchRelayAndMeshResult['meshSignalEmitter'];
}

/**
 * Wire the team room, the relay adapters and what rides on them.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireTeamRoomAndRelayAdapters(
  refs: ServerRefs,
  built: WireTeamRoomAndRelayAdaptersInput
) {
  const {
    db,
    dorkHome,
    roomService,
    resolveOperatorAuthorId,
    directChats,
    roomStore,
    roomAuthors,
    activityService,
    relayEnabled,
    roomBridges,
    resolveOperatorDisplayName,
    meshSignalEmitter,
  } = built;
  // Carry any Claude account the '0.87.0' config migration renamed (a row called
  // `default`, now `default-N`) through to its references: agent manifests,
  // schedules with their approvals, and schedule files (spec
  // `claude-account-fleet` §6 R). Wired once the agent registry and the task
  // tables exist, and run at once, before any schedule file watcher starts, so
  // a sync never reads a file halfway through the move.
  if (refs.accountUsageStore) {
    const mesh = refs.meshCore;
    refs.accountUsageStore.setReferenceMover({
      move: (renames) =>
        moveAccountReferences(renames, {
          agents: mesh
            ? {
                list: () =>
                  mesh.list().map((agent) => ({
                    id: agent.id,
                    account: agent.account,
                    projectPath: mesh.getProjectPath(agent.id) ?? undefined,
                  })),
                setAccount: async (agentId, account) => {
                  await mesh.update(agentId, { account });
                },
              }
            : undefined,
          renameInProjectAccounts: (from, to) =>
            renameAccountInProjectAccounts(configManager, from, to),
          renameScheduleAccount: (from, to) =>
            renameScheduleAccount(db, from, to, (schedule) =>
              isPackageOwned(
                schedule.filePath,
                packageOwnershipContext(
                  dorkHome,
                  schedule.agentId ? mesh?.getProjectPath(schedule.agentId) : undefined
                )
              )
            ),
        }),
      dropMarkers: async (ids) => {
        dropClaudeAccountRenameMarkers(configManager, ids);
      },
    });
    // Fresh, not the one a config write or the scan may have in flight: that one
    // started without the mover.
    await refs.accountUsageStore.reconcileAccounts({ fresh: true });
  }

  // Open #team, the room the home tab renders, and seat every registered agent
  // in it (team-room-home spec D3.1).
  //
  // AFTER the mesh block for the ordering, OUTSIDE it for the degradation. The
  // ordering: `ensureDorkBot` and startup reconciliation are what put agents in
  // the registry this reads, and on a fresh install DorkBot is the only one — a
  // day-one #team with nobody in it would be an empty room where the product
  // promises a conversation. The degradation: a room needs the room service and
  // nothing else, so an install whose mesh failed to start still gets its home
  // room, with whatever roster it can name (none) rather than none at all.
  //
  // Idempotent on a well-known key, so every boot after the first only backfills
  // a roster, and it never throws.
  //
  // Built once and shared with the `agent-created` seam below and with the
  // settings watcher: all three ask the same three questions of the same
  // install, and a second copy is how one of them would come to read a
  // different registry or a different setting.
  const teamRoomDeps: TeamRoomDeps = {
    service: roomService,
    operatorAuthorId: resolveOperatorAuthorId,
    agents: () =>
      refs.meshCore
        ?.listWithPaths()
        .map((agent) => ({ name: agent.name, path: agent.projectPath })) ?? [],
    defaultAgentName: () => configManager.getAll().agents.defaultAgent,
  };
  ensureTeamRoom(teamRoomDeps);

  // Repair the channel rosters unregisters left behind before the cascade above
  // existed (DOR-2095). Only once the registry has been reconciled against disk:
  // "no longer registered" is a question the registry answers, and a sweep
  // reading one that has not caught up would be guessing. Idempotent, so it runs
  // every boot; non-blocking and non-fatal, because a roster repair is never a
  // reason for the server not to start.
  if (refs.meshCore && refs.meshStartupReconciled) {
    const mesh = refs.meshCore;
    sweepDepartedAgentSeats({
      rooms: roomService,
      evidence: diskEvidence(() => mesh.listDenied()),
      logger,
    }).catch((err: unknown) => {
      logger.warn('[rooms] could not repair channel rosters', logError(err));
    });
  }

  // Typing in #team without addressing anybody reaches your DEFAULT agent, and
  // that is an `always` membership on an ordinary room rather than a routing
  // layer (team-room-home spec D3.4). So the setting has to move the membership:
  // change the default agent in Settings and the next thing you type in #team
  // goes to the new one, without a restart.
  watchDefaultAgent(teamRoomDeps, { onChange: (listener) => configManager.onChange(listener) });

  // An agent registered, renamed or removed, and a settings write, each reaching
  // every window that should hear it (DOR-2052). Both decisions — the global
  // audience on one, `operatorAudience` on the other, and what each payload may
  // carry — live in the module, where a test can drive them; a one-line wiring
  // here could only ever be tested by a test that copied it.
  wireLiveChangeBroadcasts({
    meshCore: refs.meshCore,
    configManager,
    communityConnections: getRemoteConnectionStore(),
    connectionVisible: isConnectionVisible,
    eventFanOut,
  });

  // The milestones #team marks (team-room-home spec D5.1). Two seams feed them
  // and NEITHER is a timer: the agent-created seam below, and the activity log
  // as it is written. Schedules, runs and connections all already emit there, so
  // the detectors learn what happened from the record that happened rather than
  // from a poller keeping a second copy of it. A quiet install stays quiet.
  const momentDetectors = createMomentDetectors({
    service: roomService,
    store: roomStore,
    authors: roomAuthors,
    db,
  });
  activityService.observe((event) => momentDetectors.activityObserved(event));

  // Phase C: adapter manager — now meshCore is available for CWD resolution.
  // Must run after meshCore init so buildContext() can call meshCore.getProjectPath().
  // Which runtimes the relay carries, and why its own runtime is written last:
  // `startup/relay-adapters.ts`.
  refs.adapterManager = await startRelayAdapters({
    relayEnabled,
    relayCore: refs.relayCore,
    adapterRegistry: refs.adapterRegistry,
    traceStore: refs.traceStore,
    relayAgentRuntime: refs.relayAgentRuntime,
    claudeRuntime: refs.claudeRuntime,
    dorkHome,
    db,
    taskStore: refs.taskStore,
    activityService,
    meshCore: refs.meshCore,
    roomService,
    roomStore,
    roomAuthors,
    roomBridges,
    resolveOperatorAuthorId,
    resolveOperatorDisplayName,
  });

  // Where a proactive message goes when no external chat integration can carry
  // it: the sending agent's own direct message with the operator (DOR-1209).
  // Needs mesh to place the sender on disk, which is what an author row keys on
  // — without it a proactive note reports non-delivery rather than guessing at
  // an identity. Hoisted to one binding because two things need it now: the MCP
  // tool deps below, and the notification pipeline's relay channel.
  const notifyDm: NotifyDmDeps | undefined = refs.meshCore
    ? {
        rooms: roomService,
        authors: roomAuthors,
        mesh: refs.meshCore,
        operatorAuthorId: resolveOperatorAuthorId,
        directChats,
        logger,
      }
    : undefined;

  // The notification pipeline's out-of-app leg, now that the relay and the
  // adapters it publishes through exist. The service itself was built long
  // before this (search `relayChannelDeps`) and reads this binding per send, so
  // a notification raised during boot is recorded either way — it simply has no
  // chat leg until this line runs.
  refs.relayChannelDeps = {
    relayCore: refs.relayCore,
    ...(refs.adapterManager
      ? {
          adapterManager: refs.adapterManager,
          bindingStore: refs.adapterManager.getBindingStore(),
          bindingRouter: refs.adapterManager.getBindingRouter(),
        }
      : {}),
    bridgeStore: roomBridges,
    notifyDm,
  };

  // Store-level run-terminal hook (DOR-240): the single seam that fires exactly
  // once per non-terminal → terminal transition, for BOTH scheduler-side
  // failures and relay-delivered runs finalized by the receiver's
  // updateRun(...). Three consumers ride it, composed into one listener (because
  // setOnRunTerminal holds a single listener) in `createRunTerminalListener`:
  //   1. Pulse attention broadcast (DOR-403) — the badge ticks the instant a run
  //      fails, on every execution path.
  //   2. The `run.completed` notification (DOR-240, DOR-1383) — the inbox row for
  //      a finished run, plus the chat ping when an integration can carry it.
  //   3. The activity-feed event (DOR-1573) — a completed or failed run now
  //      broadcasts to the feed live on BOTH paths, where before the relay path
  //      reached the feed only on the next poll.
  if (refs.taskStore) {
    // The fourth consumer (DOR-2717): a run whose agent finishes the work in a
    // turn it starts after the run's own turn ended has that turn's words added
    // to the run, rather than left only in its session.
    refs.taskStore.setOnRunTerminal(
      createRunTerminalListener(activityService, {
        store: refs.taskStore,
        runtimeFor: (type) => (runtimeRegistry.has(type) ? runtimeRegistry.get(type) : undefined),
      })
    );
  }

  // Catch up the escalation ladder on what was already waiting when this process
  // started (ADR 260819-234829). Parked schedules are one of the two standing
  // conditions a cold boot can still FIND — pending approvals are the other, and
  // they get the same treatment further down. An Ask lives in a projector, which
  // is rebuilt from a transcript on demand, so a cold boot genuinely has none to
  // find and the live seam picks up each one as its session rehydrates. A dead
  // runtime sign-in is a third case and a deliberate non-participant: its state
  // is process-local, and its stored rows say only that a credential failed at
  // some point, never that it is still failing — so re-arming from them would
  // buzz a phone about a sign-in the operator may well have fixed while the
  // server was down (see `services/observability/runtime-signin-watch.ts`). The
  // ledger makes this idempotent, and the service's own catch-up window keeps a
  // schedule that has been parked for a week from buzzing a phone on every
  // restart.
  if (refs.taskStore) {
    try {
      const stillParked: StandingCondition[] = (
        await Promise.all(
          refs.taskStore
            .getTasks()
            // A package can ship a schedule switched off; discovery still
            // parks it, but it is not asking to run, so a restart must not
            // re-arm an escalation for it (DOR-2059).
            .filter((task) => needsScheduleApprovalAttention(task))
            .map(async (task) => ({
              kind: 'schedule.parked' as const,
              // Resolved here too, not just at the live edges: a proposal that
              // survived a restart is the one an operator has had longest, and
              // the escalation it re-arms is the message most likely to reach a
              // phone. It should still name the agent.
              payload: await resolveScheduleParkPayload(task),
              since: Date.parse(task.updatedAt),
            }))
        )
      ).filter((condition) => Number.isFinite(condition.since));
      getEscalationService()?.rearmFromStandingState(stillParked);
    } catch (err) {
      logger.warn('[Escalation] Could not re-arm from parked schedules', logError(err));
    }
  }

  // Subscribe to lifecycle signals for diagnostic logging
  if (meshSignalEmitter && refs.meshCore) {
    meshSignalEmitter.subscribe('mesh.agent.lifecycle.>', (subject, signal) => {
      logger.info(`[mesh] lifecycle: ${signal.state}`, { subject, data: signal.data });
    });
  }
  return { teamRoomDeps, momentDetectors, notifyDm };
}

/** What {@link wireTeamRoomAndRelayAdapters} hands the steps after it. */
export type WireTeamRoomAndRelayAdaptersResult = Awaited<
  ReturnType<typeof wireTeamRoomAndRelayAdapters>
>;
