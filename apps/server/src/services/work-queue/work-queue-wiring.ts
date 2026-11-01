/**
 * Boot wiring for the work queue (DOR-3462): the service, the runner and its
 * production seams, the leader lock, and the timers.
 *
 * Starting a chat goes through `session_start`'s own handler, with no calling chat:
 * the same checks in the same order, at the agent's own stop, under the same chat
 * cap. The one difference is who judges a named account: core's ranking chose it,
 * so the agent-facing account policy is not asked (see `createSessionStartHandler`).
 *
 * @module services/work-queue/work-queue-wiring
 */
import type { AgentWorkItemRow, Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { refuseUnlessAccountOwner } from '../../lib/caller-authority.js';
import { logError, logger } from '../../lib/logger.js';
import type { WorkQueueRouterDeps } from '../../routes/work-queue.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { resolveCallPermission } from '../core/capabilities/permission-enforcement.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { projectOfFolder } from '../core/usage/account-eligibility.js';
import { coreRanking } from '../core/usage/account-ranking.js';
import {
  createSessionStartHandler,
  type SessionStartResult,
} from '../runtimes/claude-code/mcp-tools/session-tools.js';
import { reasonOf } from '../session/chat-messages/chat-report-back.js';
import {
  isAgentLaunchCapFull,
  resolveRuntimeTypeForNewSession,
} from '../session/launch/launch-session.js';
import {
  onProjectorRekey,
  onProjectorTurnBoundary,
  peekProjector,
} from '../session/session-state-projector.js';
import { SCHEDULER_HEARTBEAT_MS, SchedulerLock } from '../tasks/scheduler-lock.js';
import { machineHold, pickQueueAccount } from './work-queue-limits.js';
import {
  WorkQueueRunner,
  type ChatState,
  type QueueAgent,
  type StartResult,
} from './work-queue-runner.js';
import { WorkQueueService } from './work-queue-service.js';
import { WorkQueueStore } from './work-queue-store.js';

/** How often a pass runs with nothing else asking for one. */
const PASS_INTERVAL_MS = 30_000;

/** How long after a turn ends a pass runs, so the chat's status has settled. */
const TURN_END_SETTLE_MS = 1_000;

/** How long a new chat counts as running before its status can say otherwise. */
const START_GRACE_MS = 60_000;

/** The action a queued start is judged as: the same one an agent's own start is. */
const START_CHAT_ACTION = { id: 'session_start', tier: 'act', area: 'agents' } as const;

/** What the wiring needs from boot. */
export interface WorkQueueWiringDeps {
  /** The DorkOS database. */
  db: Db;
  /** The data directory: the disk measured, and where the leader lock lives. */
  dorkHome: string;
  /** The activity log, where each started chat is recorded. */
  activityService: ActivityService;
  /** The agent registry, read lazily: Mesh starts later in boot, or not at all. */
  meshCore: () => MeshCore | undefined;
}

/** The running work queue, as boot holds it. */
export interface WorkQueueWiring {
  /** The `work-queue` capability domain's deps. */
  capabilityDeps: NonNullable<CapabilityDeps['workQueueDeps']>;
  /** What the routes read, for boot to hand the Hono `/api` app. */
  routeDeps: WorkQueueRouterDeps;
  /** Stop the timers, stop listening, and give up the lock. */
  stop(): void;
}

/** What a finished chat's status says about how its item ended. */
export function chatStateFromStatus(status: Parameters<typeof reasonOf>[0]): ChatState {
  const reason = reasonOf(status);
  if (reason === null || reason === 'needs-you') return { kind: 'live' };
  return { kind: 'ended', outcome: reason };
}

/** Read what `session_start`'s handler answered as a {@link StartResult}. */
export function startResultFrom(
  answer: { content: readonly { text?: string }[]; isError?: boolean },
  accountId: string | null
): StartResult {
  const body: unknown = JSON.parse(answer.content[0]?.text ?? '{}');
  if (!answer.isError) {
    return { kind: 'started', sessionId: (body as SessionStartResult).sessionId, accountId };
  }
  const { code, error } = body as { code?: string; error?: string };
  switch (code) {
    case 'LAUNCH_CAP_FULL':
      return { kind: 'held', hold: 'chat-cap' };
    case 'AGENT_PAUSED':
      return { kind: 'held', hold: 'agent-paused' };
    case 'ACCOUNT_REFUSED':
      return { kind: 'held', hold: 'accounts' };
    default:
      return { kind: 'refused', message: error ?? 'The chat could not be started.' };
  }
}

/**
 * Build the work queue and start its timers.
 *
 * @param deps - The database, data directory, activity log and lazy agent registry.
 */
export function wireWorkQueue(deps: WorkQueueWiringDeps): WorkQueueWiring {
  const store = new WorkQueueStore(deps.db);
  const lock = new SchedulerLock({ dorkHome: deps.dorkHome, fileName: 'work-queue.lock' });
  lock.tryAcquire();

  const agentOf = (agentId: string): QueueAgent | undefined => {
    const agent = deps
      .meshCore()
      ?.listWithPaths()
      .find((a) => a.id === agentId);
    return agent
      ? {
          agentId,
          agentPath: agent.projectPath,
          label: agent.displayName ?? agent.name,
        }
      : undefined;
  };

  const startChat = async (agent: QueueAgent, item: AgentWorkItemRow): Promise<StartResult> => {
    const cwd = item.cwd ?? agent.agentPath;
    const runtimeType = await resolveRuntimeTypeForNewSession({ agentPath: agent.agentPath, cwd });
    let accountId: string | null = null;
    if (
      runtimeRegistry.has(runtimeType) &&
      runtimeRegistry.get(runtimeType).getCapabilities().supportsAccounts
    ) {
      const ranking = coreRanking(runtimeType, await projectOfFolder(cwd));
      // No ledger at all: nothing to judge by, so the usual choice decides.
      if (ranking.length > 0) {
        const account = pickQueueAccount(ranking, runtimeType);
        if (!account) return { kind: 'held', hold: 'accounts' };
        accountId = account.id;
      }
    }
    const handler = createSessionStartHandler(
      { meshCore: deps.meshCore(), activityService: deps.activityService },
      () => ({ agentPath: agent.agentPath }),
      async () => ({ allowed: true })
    );
    const answer = await handler({
      prompt: item.prompt,
      title: item.title,
      cwd,
      ...(accountId ? { account: accountId } : {}),
    });
    return startResultFrom(answer, accountId);
  };

  const chatState = async (item: { sessionId: string | null; startedAt: string | null }) => {
    const sessionId = item.sessionId as string;
    const status = peekProjector(sessionId)?.getStatus() ?? null;
    if (status?.lifecycle === 'streaming' || status?.lifecycle === 'blocked') {
      return { kind: 'live' } as const;
    }
    // The launch answers before the turn's first status, so idle this early means not yet begun.
    const age = Date.now() - Date.parse(item.startedAt ?? '');
    if (age < START_GRACE_MS && status?.lifecycle !== 'error') return { kind: 'live' } as const;
    try {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      if (runtime.holdsBackgroundWork?.(sessionId) === true) return { kind: 'live' } as const;
    } catch (err) {
      logger.debug('[work-queue] could not ask about background work', logError(err));
    }
    return chatStateFromStatus(status);
  };

  const runner = new WorkQueueRunner({
    store,
    isLeader: () => lock.isLeaderNow,
    machineHold: () => machineHold(deps.dorkHome),
    chatCapFull: isAgentLaunchCapFull,
    agentOf,
    mayStartChat: async (agent) => {
      const permission = await resolveCallPermission({
        action: START_CHAT_ACTION,
        identity: {
          agentPath: agent.agentPath,
          displayName: agent.label,
          createdAt: new Date().toISOString(),
        },
      });
      return permission === null || permission.state === 'allowed';
    },
    startChat,
    chatState,
    now: () => new Date(),
  });

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    settleTimer ??= setTimeout(() => {
      settleTimer = null;
      void runner.pass();
    }, TURN_END_SETTLE_MS);
    settleTimer.unref?.();
  };

  const service = new WorkQueueService({
    store,
    holdOf: (agentId) => runner.holdOf(agentId),
    wake,
  });

  const passTimer = setInterval(() => void runner.pass(), PASS_INTERVAL_MS);
  passTimer.unref?.();
  const lockTimer = setInterval(() => lock.heartbeat(), SCHEDULER_HEARTBEAT_MS);
  lockTimer.unref?.();
  const offTurn = onProjectorTurnBoundary((_sessionId, kind) => {
    if (kind === 'turn_end') wake();
  });
  const offRekey = onProjectorRekey((from, to) => store.rekey(from, to));

  const agentIdForPath = (agentPath: string) => deps.meshCore()?.getByPath(agentPath)?.id;
  return {
    capabilityDeps: { service, agentIdForPath },
    routeDeps: {
      service,
      agentExists: (agentId) => deps.meshCore()?.get(agentId) !== undefined,
      // The same owner bar the account routes use: a person, never an agent,
      // and with login on, the install's owner.
      isOwner: (facts) => refuseUnlessAccountOwner(facts) === undefined,
    },
    stop() {
      clearInterval(passTimer);
      clearInterval(lockTimer);
      if (settleTimer) clearTimeout(settleTimer);
      offTurn();
      offRekey();
      lock.release();
    },
  };
}
