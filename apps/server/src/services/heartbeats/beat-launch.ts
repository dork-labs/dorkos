/**
 * Starting a beat turn, and the two facts about a chat the runner needs (spec
 * `heartbeats` §7.1): whether it is mid-turn, and how to title it.
 *
 * The production seams behind {@link BeatTurnLauncher}, kept apart from the
 * runner so the runner's tests drive a fake and this file is the one place a
 * beat reaches the session launch service. The turn runs on the agent's own
 * runtime, model and account, as its other chats; `unattended` keeps an
 * approval card from holding a turn nobody is watching, and
 * `countsTowardLaunchCap` keeps forty agents inside the machine's live-launch
 * cap.
 *
 * @module services/heartbeats/beat-launch
 */
import type { MeshCore } from '@dorkos/mesh';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../core/runtime-registry.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
} from '../session/launch/launch-session.js';
import { listProjectorStatuses } from '../session/session-state-projector.js';
import { resolveSessionCwd } from '../workspace/resolve-session-cwd.js';

/** What starting a beat turn answered. */
export type BeatLaunchResult =
  | { status: 'started'; sessionId: string }
  | { status: 'cap-full' }
  | { status: 'refused'; message: string };

/** What a beat turn is started with. */
export interface BeatLaunchRequest {
  /** The beat chat. */
  sessionId: string;
  /** The message id the beat-turn registry keys the turn by. */
  messageId: string;
  /** The agent's home. */
  agentPath: string;
  /** The agent's runtime, named so the launch never falls back to another. */
  runtime: string;
  /** The beat prompt. */
  content: string;
  /** The ceiling the beat carries when it reads words written under a turn mark (DOR-3036). */
  permissionCeiling?: TurnPermissionCeiling;
  /** Called once when the turn ends; `refusal` when it never reached the agent. */
  onSettled: (outcome: 'ok' | 'failed', refusal?: string) => void;
}

/** The seams the runner reaches a chat through. */
export interface BeatTurnLauncher {
  /** Start a beat turn. */
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

/**
 * The production launcher.
 *
 * @param meshCore - Mesh, read per launch, so the launch checks the agent path against it.
 */
export function createBeatTurnLauncher(meshCore: () => MeshCore | undefined): BeatTurnLauncher {
  return {
    async launch(request) {
      const result = await dispatchSessionMessage({
        origin: { kind: 'heartbeat' },
        sessionId: request.sessionId,
        messageId: request.messageId,
        request: {
          content: request.content,
          agentPath: request.agentPath,
          runtime: request.runtime,
        },
        clientId: 'heartbeat',
        meshCore: meshCore(),
        // A beat chat is in no room.
        roomSessionPlace: undefined,
        unattended: true,
        ...(request.permissionCeiling !== undefined
          ? { permissionCeiling: request.permissionCeiling }
          : {}),
        countsTowardLaunchCap: true,
        onSettled: request.onSettled,
      });
      if (isSessionLaunchRefusal(result)) {
        return result.refused === 'LAUNCH_CAP_FULL'
          ? { status: 'cap-full' }
          : { status: 'refused', message: result.message };
      }
      if (!result.accepted)
        return { status: 'refused', message: 'The chat did not take the beat.' };
      return { status: 'started', sessionId: result.canonicalId ?? request.sessionId };
    },
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
