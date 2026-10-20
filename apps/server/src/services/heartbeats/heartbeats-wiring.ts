/**
 * Heartbeats at server startup and shutdown (spec `heartbeats` §3, §9, §11):
 * one call from the composition root builds the store, the outbox, the runner
 * and the event-wake hub, wires them to the services they read, hands over
 * what `GET /api/agents/:id/heartbeat` reads, and follows `heartbeats.enabled`.
 *
 * - **Off is really off** (§3.6). With `heartbeats.enabled` false nothing is
 *   armed and nothing is answered: no beat timer, no outbox tick, no event-wake
 *   window, and every source's wake (commitments included) reaches no hub.
 *   Held raises stay rows and go out once heartbeats are on again.
 * - **Commitment wakes** subscribe here through the same `wakeAgent` every
 *   other source uses, so the wakes the commitment service queued at its own
 *   start reach the hub only while heartbeats are on.
 *
 * @module services/heartbeats/heartbeats-wiring
 */
import { randomUUID } from 'node:crypto';
import { agentPause } from '../mesh/pause/index.js';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { MeshCore } from '@dorkos/mesh';
import { agentConnectionAttachments, pulseRuns, pulseSchedules, type Db } from '@dorkos/db';
import { resolveWorkingHours, zonedDay } from '@dorkos/shared/working-hours';
import { configManager } from '../core/config-manager.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import type { CommitmentService } from '../commitments/index.js';
import { resolveAgentIdForPath } from '../mesh/agent-path-lookup.js';
import { resolveSessionCwd } from '../workspace/resolve-session-cwd.js';
import { setLaunchOriginReader } from '../session/origin/outsider-turns.js';
import { onDispatchLifecycle } from '../session/message-dispatcher.js';
import { auditTrail } from '../audit/audit-trail.js';
import type { HeartbeatRouterDeps } from '../../routes/heartbeats.js';
import type { HeartbeatTriageRouterDeps } from '../../routes/heartbeat-triage.js';
import type { SessionOriginResolvers } from '../session/origin/session-origin-overlays.js';
import { createReportsToChain, OWNER_FALLBACK_ACCOUNT_ID } from './reports-to.js';
import { HeartbeatStore } from './heartbeat-store.js';
import { RaiseStore } from './raises/raise-store.js';
import { queueManagerChange } from './raises/report-beat.js';
import { BeatOutbox } from './outbox.js';
import { BeatRunner, type BeatAgent } from './beat-runner.js';
import { createBeatTurnLauncher, ownTurnRunning } from './beat-launch.js';
import { noteTurnStarted } from './beat-turns.js';
import { EventWakes, wakeAgent } from './event-wakes.js';
import { systemClock } from './beat-scheduler.js';
import { heartbeatStatus } from './heartbeat-status.js';
import { setRaiseRecipientCheck } from './heartbeat-capabilities.js';
import { measureAgent } from './measures/measures.js';
import { setHeartbeatStatusReader } from './measures/status-capability.js';
import { mountTriage, type TriageMount } from './triage/triage-mount.js';
import {
  beatChatResolver,
  createDeliveries,
  createRecipientCheck,
  type DeliveryDeps,
} from './heartbeat-adapters.js';
import {
  createAddressedGatherer,
  createCommitmentsGatherer,
  createHealthGatherer,
  createSchedulesGatherer,
  createWorkspaceGatherer,
  type GathererRegistry,
  type OwnRun,
} from './gatherers/index.js';

/** What the composition root hands over. */
export interface HeartbeatsWiringDeps extends DeliveryDeps {
  /**
   * Where the routes' reads go: the status route's
   * (`GET /api/agents/:id/heartbeat`) and the credits answer's
   * (`PUT /api/heartbeats/triage-credits`), both mounted by `http/hono-api.ts`.
   */
  routes: { heartbeat?: HeartbeatRouterDeps; heartbeatTriage?: HeartbeatTriageRouterDeps };
  /** The session list's origin overlays, which gain the chat list's Heartbeat label. */
  origins: SessionOriginResolvers;
  /** Mesh, once it runs. */
  meshCore: () => MeshCore | undefined;
  /** Commitments, for the gatherer, the prompt and due wakes. */
  commitments: CommitmentService;
}

/** What the composition root keeps. */
export interface HeartbeatsHandle {
  /** The runner, for tests and the loop watcher's `observe`. */
  runner: BeatRunner;
  /** Stop every timer, tick and subscription. */
  stop(): void;
}

/**
 * An agent's failed or parked runs since a moment, read off the task tables.
 *
 * @param db - The server's database.
 */
function ownRunReader(db: Db) {
  return (agentId: string, sinceIso: string | null): OwnRun[] =>
    db
      .select({
        id: pulseRuns.id,
        status: pulseRuns.status,
        name: pulseSchedules.name,
        finishedAt: pulseRuns.finishedAt,
        createdAt: pulseRuns.createdAt,
      })
      .from(pulseRuns)
      .innerJoin(pulseSchedules, eq(pulseSchedules.id, pulseRuns.scheduleId))
      .where(
        and(
          eq(pulseSchedules.agentId, agentId),
          inArray(pulseRuns.status, ['failed', 'blocked']),
          ...(sinceIso ? [gt(pulseRuns.createdAt, sinceIso)] : [])
        )
      )
      .orderBy(desc(pulseRuns.createdAt))
      .limit(20)
      .all()
      .map((row) => ({
        id: row.id,
        taskName: row.name,
        status: row.status as 'failed' | 'blocked',
        at: row.finishedAt ?? row.createdAt,
      }));
}

/**
 * Every gatherer this server runs.
 *
 * @param db - The database.
 * @param commitments - The commitment service.
 */
function gatherersFor(db: Db, commitments: CommitmentService): GathererRegistry {
  return {
    addressed: createAddressedGatherer(db),
    commitments: createCommitmentsGatherer(commitments),
    schedules: createSchedulesGatherer(ownRunReader(db)),
    health: createHealthGatherer(db),
    workspace: createWorkspaceGatherer(),
  };
}

/**
 * An agent by mesh id, as heartbeats read it.
 *
 * @param mesh - Mesh, read lazily.
 */
function agentReader(mesh: () => MeshCore | undefined) {
  const agentOf = (id: string): BeatAgent | undefined => {
    const manifest = mesh()?.get(id);
    const projectPath = mesh()?.getProjectPath(id);
    if (!manifest || !projectPath) return undefined;
    return {
      id,
      name: manifest.displayName ?? manifest.name,
      runtime: manifest.runtime,
      projectPath,
    };
  };
  const list = (): BeatAgent[] =>
    (mesh()?.list() ?? [])
      .map((manifest) => agentOf(manifest.id))
      .filter((agent): agent is BeatAgent => agent !== undefined);
  return { get: agentOf, list };
}

/**
 * Build, wire and (when enabled) start heartbeats.
 *
 * @param deps - What the composition root hands over.
 */
export function startHeartbeats(deps: HeartbeatsWiringDeps): HeartbeatsHandle {
  const { db } = deps;
  // A chat this process saw no turn of since it started reads its stored launch
  // origin, so a bridged chat's turns stay a stranger's across a restart
  // (`session/origin/outsider-turns.ts`). Set at every boot, heartbeats on or off.
  setLaunchOriginReader((sessionId) => runtimeRegistry.getSessionLaunchOrigin(sessionId));
  const store = new HeartbeatStore(db);
  const enabled = () => configManager.get('heartbeats').enabled;
  const chain = createReportsToChain({ get: (id) => deps.meshCore()?.get(id) });
  const ownerAccountId = () =>
    auditTrail()?.accounts.owner().accountId ?? OWNER_FALLBACK_ACCOUNT_ID;
  setRaiseRecipientCheck(createRecipientCheck(deps.meshCore, chain, ownerAccountId));
  const hours = () => resolveWorkingHours(configManager.get('profile'));
  const agents = agentReader(deps.meshCore);
  const isOwner = (id: string) => chain.canonical(id) === ownerAccountId();
  // A raise is answered by its reader posting in the DM it landed in; only the owner has one.
  const raises = new RaiseStore(db, {
    recipientAuthor: (to) => (isOwner(to) ? (deps.notifyDm?.operatorAuthorId() ?? null) : null),
  });
  const managerOf = (id: string) => chain.resolveManager(id).accountId;
  const isAgent = (id: string) => deps.meshCore()?.get(id) !== undefined;
  // One person per server today; their hours live in the owner's profile.
  const presenceOf = () => ({ hours: hours(), away: configManager.get('profile').away ?? null });
  const nameOf = (id: string) =>
    agents.get(id)?.name ?? configManager.get('profile').displayName ?? 'your manager';
  const triage = mountTriage({ routes: deps.routes, db, raises, timezone: () => hours().timezone });
  const outbox = new BeatOutbox({
    store,
    raises,
    managerOf,
    chainPersonOf: (id) => chain.resolveChainPerson(id).accountId,
    isAgent,
    presenceOf,
    ...createDeliveries(deps, isOwner),
    agentOf: agents.get,
    enabled,
  });
  const runner = new BeatRunner({
    store,
    agents,
    runtimeRegistered: (runtime) => runtimeRegistry.has(runtime),
    enabled,
    // An agent a person paused (spec `audit-trail` PR5) never beats.
    isPaused: (agentId) => agentPause()?.pausedAgent(agentId) !== undefined,
    hoursFor: () => hours(),
    gatherers: gatherersFor(db, deps.commitments),
    commitments: deps.commitments,
    launcher: createBeatTurnLauncher(deps.meshCore),
    outbox,
    reports: { raises, managerOf, isAgent, presenceOf, nameOf },
    ownTurnRunning: (agentId) => ownTurnRunning(resolveAgentIdForPath, agentId),
    resolveCwd: async (agent) => (await resolveSessionCwd({ agentPath: agent.projectPath })).cwd,
    triage: triage.port,
  });
  const hub = new EventWakes({
    clock: systemClock,
    localDay: (_agentId, at) => zonedDay(new Date(at), hours().timezone),
    beat: (agentId, wake) => void runner.wake(agentId, wake),
    agentIdAt: (agentPath) => deps.meshCore()?.getByPath(agentPath)?.id,
    agentsForConnection: (connectionId) =>
      db
        .select({ agentId: agentConnectionAttachments.agentId })
        .from(agentConnectionAttachments)
        .where(eq(agentConnectionAttachments.connectionId, connectionId))
        .all()
        .map((row) => row.agentId),
    noteNewManager: (agentId, event) => {
      store.patchState(agentId, { newManager: 1 });
      const at = new Date(systemClock.now()).toISOString();
      queueManagerChange(
        {
          raises,
          managerOf,
          nameOf,
          exists: (id) => chain.names(id),
          canonical: (id) => chain.canonical(id),
        },
        {
          agentId,
          before: event.managerChange?.before ?? null,
          id: randomUUID(),
          oldLineId: randomUUID(),
          at,
        }
      );
    },
    refresh: (agentId) => void runner.refreshAgent(agentId),
  });
  const stopFollowing = follow(deps, {
    enabled,
    hub,
    outbox,
    runner,
    refreshAll: () => {
      // Report timers only: a profile write must not push back anyone's timed beat.
      for (const agent of agents.list()) void runner.refreshReport(agent.id);
    },
  });
  mountStatus(deps, { store, raises, managerOf, runner, agents, enabled, triage });
  const handle: HeartbeatsHandle = {
    runner,
    stop: () => {
      stopFollowing();
      triage.stop();
      setRaiseRecipientCheck(undefined);
      setHeartbeatStatusReader(undefined);
      hub.uninstall();
      outbox.stop();
      runner.stop();
    },
  };
  running = handle;
  return handle;
}

/**
 * Follow `heartbeats.enabled`, commitments coming due, and turns that start in
 * a beat chat.
 *
 * @param deps - What the composition root handed over.
 * @param parts - The pieces to switch on and off.
 * @returns Stop following.
 */
function follow(
  deps: HeartbeatsWiringDeps,
  parts: {
    enabled: () => boolean;
    hub: EventWakes;
    outbox: BeatOutbox;
    runner: BeatRunner;
    refreshAll: () => void;
  }
): () => void {
  const apply = (): void => {
    if (parts.enabled()) {
      parts.hub.install();
      parts.outbox.start();
    } else {
      parts.hub.uninstall();
      parts.outbox.stop();
    }
    void parts.runner.refreshEnabled();
  };
  apply();
  const unobserveCommitments = deps.commitments.observe((event) =>
    wakeAgent(event.commitment.agentId, { type: 'commitment-due', eventId: event.commitment.id })
  );
  // A turn started by any other message in a beat chat is an ordinary turn (§7.2).
  const unwatchTurns = onDispatchLifecycle((event) => {
    if (event.phase === 'started') noteTurnStarted(event.sessionId, event.messageId);
  });
  const unwatchConfig = configManager.onChange((change) => {
    if (change.sections.includes('heartbeats')) apply();
    // New hours or a new away: every report timer reads them.
    if (change.sections.includes('profile')) parts.refreshAll();
  });
  return () => {
    unwatchTurns();
    unwatchConfig();
    unobserveCommitments();
  };
}

/**
 * Mount the status route, the chat list's "Heartbeat" label, and what
 * `heartbeat_status` reads.
 *
 * @param deps - What the composition root handed over.
 * @param parts - What the status reads.
 */
function mountStatus(
  deps: HeartbeatsWiringDeps,
  parts: {
    store: HeartbeatStore;
    raises: RaiseStore;
    managerOf: (agentId: string) => string;
    runner: BeatRunner;
    agents: { get(id: string): BeatAgent | undefined };
    enabled: () => boolean;
    triage: TriageMount;
  }
): void {
  deps.origins.resolveBeatChats = beatChatResolver(deps.db);
  const isAgent = (id: string) => deps.meshCore()?.get(id) !== undefined;
  const status = (agentId: string, viewerIsOwner: boolean, days?: number) =>
    heartbeatStatus({
      agent: parts.agents.get(agentId),
      store: parts.store,
      raises: parts.raises,
      managerOf: parts.managerOf,
      runner: parts.runner,
      enabled: parts.enabled(),
      runtimeRegistered: (runtime) => runtimeRegistry.has(runtime),
      isAgent,
      viewerIsOwner,
      checks: (agent, owner) => parts.triage.checks(agent, owner),
      measures: (agent) =>
        measureAgent(deps.db, {
          agentId: agent.id,
          agentPath: agent.projectPath,
          isAgent,
          now: Date.now(),
          ...(days !== undefined ? { days } : {}),
        }),
    });
  deps.routes.heartbeat = { status };
  // An agent reads what anyone but the owner sees: no held words, no chat ids.
  setHeartbeatStatusReader({
    status: (agentId, days) => status(agentId, false, days),
    agentIdForPath: (agentPath) => deps.meshCore()?.getByPath(agentPath)?.id,
  });
}

/** The heartbeats the composition root started, for {@link stopHeartbeats}. */
let running: HeartbeatsHandle | undefined;

/**
 * The heartbeats {@link startHeartbeats} started, or undefined before then and
 * after {@link stopHeartbeats}. Read by the test-only beat trigger
 * (`routes/test-heartbeat.ts`), which asks the real runner for a beat.
 */
export function runningHeartbeats(): HeartbeatsHandle | undefined {
  return running;
}

/** Stop the heartbeats {@link startHeartbeats} started, at shutdown. */
export function stopHeartbeats(): void {
  running?.stop();
  running = undefined;
}
