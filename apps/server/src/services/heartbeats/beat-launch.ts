/**
 * Starting a beat turn, and the two facts about a chat the runner needs (spec
 * `heartbeats` §7.1): whether it is mid-turn, and how to title it.
 *
 * The production seams behind {@link BeatTurnLauncher}, kept apart from the
 * runner so the runner's tests drive a fake. A beat starts its turn through
 * the turn port (spec `turns-survive-restarts` §3, T8), as a run whose words
 * stay with the beat: admission decides when it may go, so a beat that finds
 * every launch slot under `runtimes.maxAgentChats` taken waits for one
 * (`machine_full`) and starts when a slot frees, rather than being refused.
 * The turn runs on the agent's own runtime, model and account, as its other
 * chats; `unattended` keeps an approval card from holding a turn nobody is
 * watching.
 *
 * **Where the words wait.** With the beat, in this process: a restart before
 * the turn starts cancels its run (`start_lost`), and the next boot fails the
 * open beat as interrupted (`beat-runner.ts`), which moved nothing it gathered.
 *
 * @module services/heartbeats/beat-launch
 */
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { RunStatus } from '@dorkos/shared/turn-port';
import type { SpaceTurnPort, TurnRun } from '../runs/index.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { listProjectorStatuses } from '../session/session-state-projector.js';
import { resolveSessionCwd } from '../workspace/resolve-session-cwd.js';

/** What starting a beat turn answered: its turn began, or it never will. */
export type BeatLaunchResult =
  { status: 'started'; sessionId: string } | { status: 'refused'; message: string };

/** What a beat turn is started with. */
export interface BeatLaunchRequest {
  /** The beat chat. */
  sessionId: string;
  /**
   * The turn's id, a ULID: the beat-turn registry keys the turn by it, and the
   * turn port names the run by it, so the turn the dispatcher starts is known
   * as the beat's.
   */
  messageId: string;
  /** The agent, by its Mesh id. */
  agentId: string;
  /** The agent's runtime, named so the launch never falls back to another. */
  runtime: string;
  /** The beat prompt. */
  content: string;
  /**
   * The account a NEW beat chat starts on, when its own is out of usage
   * (`beat-seat.ts`). Honoured only by the send that creates the chat.
   */
  account?: string;
  /** The ceiling the beat carries when it reads words written under a turn mark (DOR-3036). */
  permissionCeiling?: TurnPermissionCeiling;
  /** A Wi-Fi hold the beat carries on from what it reads, as a mark (DOR-3561). */
  carriedMarks?: { outsider: true };
  /** Heartbeats stopped: a turn still waiting to start is taken back. */
  signal?: AbortSignal;
  /** Called once when the turn ends; `refusal` when it never reached the agent. */
  onSettled: (outcome: 'ok' | 'failed', refusal?: string) => void;
}

/** The seams the runner reaches a chat through. */
export interface BeatTurnLauncher {
  /**
   * Start a beat turn. Resolves when the turn begins, which may be after a
   * wait for a free launch slot, or with why it never will.
   */
  launch(request: BeatLaunchRequest): Promise<BeatLaunchResult>;
  /** Whether a chat is mid-turn right now. */
  isBusy(sessionId: string): boolean;
  /** What a chat's last failed turn said, or null. */
  lastError(sessionId: string): string | null;
  /** Title a chat. Best-effort: a failure leaves the runtime's own title. */
  rename(
    agent: { runtime: string; projectPath: string },
    sessionId: string,
    title: string
  ): Promise<void>;
}

/** Lifecycles that mean a chat is mid-turn. */
const RUNNING = new Set(['streaming', 'blocked']);

/** A run's statuses once its turn began. */
const BEGUN: ReadonlySet<RunStatus> = new Set(['started', 'running', 'ended', 'settled']);

/** A run's statuses once its turn is over or never comes (`RUN_ENDS` in `services/runs`). */
const OVER: ReadonlySet<RunStatus> = new Set(['ended', 'settled', 'cancelled', 'superseded']);

/** The beat record's sentence for why a beat's run never started, by the port's reason. */
const NOT_STARTED: Readonly<Record<string, string>> = {
  start_lost: 'DorkOS restarted before it began.',
  stopped: 'Heartbeats stopped before it began.',
  start_failed: 'DorkOS could not hand it to the agent.',
  agent_paused: 'Its agent is paused.',
  invalid_agent_path: 'Its agent is not registered.',
  unknown_runtime: 'Its runtime is not available here.',
  runtime_mismatch: 'Its runtime is not available here.',
  desk_not_own: 'Its folder belongs to another agent.',
  account_not_allowed: 'Its account may not work in this project.',
};

/** Why a run never started, in a sentence for the beat record. */
function notStartedLine(run: TurnRun): string {
  const why = run.endingDetail.cancelledBecause;
  return (why !== undefined && NOT_STARTED[why]) || `It did not start (${why ?? run.status}).`;
}

/**
 * How a beat's turn settled, as the runner reads it: a turn the runtime
 * refused before the agent saw it (DOR-2994) carries the refusal, and a turn
 * a person stopped is not the agent failing.
 */
function settledAs(run: TurnRun): [outcome: 'ok' | 'failed', refusal?: string] {
  if (run.ending === 'refused') {
    return ['failed', run.endingDetail.refusal ?? 'The runtime refused the turn.'];
  }
  return run.ending === 'completed' || run.ending === 'stopped' ? ['ok'] : ['failed'];
}

/**
 * Start a beat's turn through the space face and follow its run: resolve when
 * the turn begins or never will, and settle when it ends.
 */
function launchOnPort(
  door: SpaceTurnPort | undefined,
  request: BeatLaunchRequest
): Promise<BeatLaunchResult> {
  if (!door) return Promise.resolve({ status: 'refused', message: 'DorkOS is still starting.' });
  let runId: string;
  try {
    ({ runId } = door.start(
      {
        sessionId: request.sessionId,
        agentId: request.agentId,
        content: request.content,
        origin: { kind: 'heartbeat' },
        tier: 'owner',
        runtime: request.runtime,
        unattended: true,
        ...(request.account !== undefined ? { accountHint: request.account } : {}),
        ...(request.permissionCeiling !== undefined
          ? { permissionCeiling: request.permissionCeiling }
          : {}),
        ...(request.carriedMarks?.outsider === true
          ? { carriedMarks: { outsider: true as const } }
          : {}),
      },
      { runId: request.messageId }
    ));
  } catch (err) {
    // Refused at the door, before anything was saved (`TurnStartRefusedError`).
    if (err instanceof Error && err.name === 'TurnStartRefusedError') {
      return Promise.resolve({ status: 'refused', message: err.message });
    }
    throw err;
  }
  return new Promise((resolve) => {
    let begun = false;
    let over = false;
    const takeBack = (): void => {
      if (!begun) door.withdraw(runId, 'stopped');
    };
    const hear = (run: TurnRun): void => {
      if (over) return;
      if (!begun && BEGUN.has(run.status)) {
        begun = true;
        resolve({ status: 'started', sessionId: run.sessionId });
      }
      if (!OVER.has(run.status)) return;
      over = true;
      unwatch();
      request.signal?.removeEventListener('abort', takeBack);
      if (!begun) resolve({ status: 'refused', message: notStartedLine(run) });
      else request.onSettled(...settledAs(run));
    };
    // Subscribed before the first hand-over can happen: the start was only saved.
    const unwatch = door.watch(hear, { runId });
    request.signal?.addEventListener('abort', takeBack, { once: true });
    const now = door.get(runId);
    if (now) hear(now);
    if (request.signal?.aborted) takeBack();
  });
}

/**
 * The production launcher.
 *
 * @param port - The turn port's space face, read per launch; `undefined` before startup wired it.
 */
export function createBeatTurnLauncher(port: () => SpaceTurnPort | undefined): BeatTurnLauncher {
  return {
    launch: (request) => launchOnPort(port(), request),
    isBusy(sessionId) {
      return listProjectorStatuses().some(
        (entry) => entry.sessionId === sessionId && RUNNING.has(entry.status.lifecycle)
      );
    },
    lastError(sessionId) {
      const entry = listProjectorStatuses().find((status) => status.sessionId === sessionId);
      return entry?.status.lastError?.message ?? null;
    },
    async rename(agent, sessionId, title) {
      if (!runtimeRegistry.has(agent.runtime)) return;
      const runtime = runtimeRegistry.get(agent.runtime);
      const { cwd } = await resolveSessionCwd({ agentPath: agent.projectPath });
      await runtime.renameSession(runtime.getInternalSessionId(sessionId) ?? sessionId, title, cwd);
    },
  };
}

/**
 * Whether a turn of this agent's own is running now, in any of its chats: the
 * cadence table's "something it owns is in flight" (§3.2).
 *
 * @param agentIdForCwd - The agent working in a directory, or undefined.
 * @param agentId - The agent.
 */
export function ownTurnRunning(
  agentIdForCwd: (cwd: string) => string | undefined,
  agentId: string
): boolean {
  return listProjectorStatuses().some(
    (entry) =>
      RUNNING.has(entry.status.lifecycle) &&
      entry.cwd !== undefined &&
      agentIdForCwd(entry.cwd) === agentId
  );
}
