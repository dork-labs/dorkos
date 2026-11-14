/**
 * The production halves of the agent-send seam (`ctx.agent.send`, DOR-2683):
 * how it reads a chat, its folder and whether it is busy, how it claims a
 * start slot for an agent's chat, and how it re-arms a chat's queue after a
 * restart. Split from `agent-send.ts` so the seam itself reads as delivery;
 * tests replace each of these.
 *
 * @module services/extensions/agent-send/agent-send-defaults
 */
import type { MeshCore } from '@dorkos/mesh';
import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { agentPause } from '../../mesh/pause/agent-pause.js';
import { adoptQueuedMessages, isTurnInFlight } from '../../session/message-dispatcher.js';
import {
  resolveChatPlace,
  type ResolveChatPlaceDeps,
} from '../../session/launch/resolve-chat-place.js';
import {
  verifyChatAgent,
  type ChatAgentRefusal,
  type VerifyChatAgentDeps,
} from '../../session/launch/verify-chat-agent.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { persistenceModeFor } from '../../session/projector-persistence.js';
import { getOrCreateProjector, peekProjector } from '../../session/session-state-projector.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { getStartWorkService, type StartReservation } from '../start-work.js';

const CHAT_QUEUE_RESUME_WARNING_MAX = 1_000;
const chatQueueResumeWarnings = new Set<string>();

/** Forget boot-recovery warning history. Tests use this to model a new process. */
export function resetChatQueueResumeWarnings(): void {
  chatQueueResumeWarnings.clear();
}

/** Log one recovery refusal for this chat and reason during the current process. */
function warnResumeRefusal(
  sessionId: string,
  reason: string,
  message: string,
  details: Record<string, unknown>
): void {
  const key = `${sessionId}:${reason}`;
  if (chatQueueResumeWarnings.has(key)) return;
  if (chatQueueResumeWarnings.size >= CHAT_QUEUE_RESUME_WARNING_MAX) {
    chatQueueResumeWarnings.clear();
  }
  chatQueueResumeWarnings.add(key);
  logger.warn(message, { sessionId, ...details });
}

/** A successful recovery makes any prior refusal fresh if this chat blocks again. */
function clearResumeRefusals(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of chatQueueResumeWarnings) {
    if (key.startsWith(prefix)) chatQueueResumeWarnings.delete(key);
  }
}

/** Production verification collaborators with selected test seams replaced. */
function chatAgentDeps(overrides: Partial<VerifyChatAgentDeps>): VerifyChatAgentDeps {
  return {
    registeredAgentPaths: () => undefined,
    pausedAgentOfTurn: (opts) => agentPause()?.pausedAgentOfTurn(opts),
    ...overrides,
  };
}

/** Keep a refused recovery row on disk and warn once for its reason. */
function refuseChatAgent(sessionId: string, refusal: ChatAgentRefusal): void {
  if (refusal.reason === 'agent-not-registered') {
    warnResumeRefusal(
      sessionId,
      refusal.reason,
      '[MessageDispatcher] queued messages kept because their agent is not registered',
      { reason: refusal.reason }
    );
    return;
  }
  warnResumeRefusal(
    sessionId,
    refusal.reason,
    '[MessageDispatcher] queued messages kept because their agent is paused',
    { reason: refusal.reason, agentId: refusal.agent.id }
  );
}

/** What DorkOS knows about a chat an extension names. */
export interface SessionFacts {
  /** Whether a session row binds it to a runtime: DorkOS has seen it start. */
  bound: boolean;
  /** `session_metadata.launch_origin`, or null. */
  launchOrigin: string | null;
  /** `session_metadata.agent_path`, or null. */
  agentPath: string | null;
  /** The extension at the root of the chat's chain of starters (`session_started_by`), or null. */
  startedByExtension: string | null;
  /** Whether a room answers for this chat (its room binding). */
  roomBound: boolean;
}

/**
 * What DorkOS knows about a chat, read from the session registry, the
 * started-by record and the room binding port.
 *
 * @param roomSessionPlace - The room port, read at call time.
 */
export function describeSessionFor(
  roomSessionPlace: (() => RoomSessionPlacePort | undefined) | undefined
): (sessionId: string) => Promise<SessionFacts> {
  return async (sessionId) => ({
    bound: (await runtimeRegistry.resolveSessionRuntime(sessionId)).bound,
    launchOrigin: runtimeRegistry.getSessionLaunchOrigin(sessionId),
    agentPath: await runtimeRegistry.getSessionAgentPath(sessionId),
    startedByExtension: getSessionStartedByStore()?.get(sessionId)?.originExtensionId ?? null,
    roomBound: (roomSessionPlace?.()?.roomFor(sessionId) ?? null) !== null,
  });
}

/**
 * The folder currently known in memory: the live projector's, else the
 * runtime's live binding. Unknown after a restart for a chat nobody has opened
 * since; a caller starting work must still resolve the chat's durable place.
 *
 * @param sessionId - The chat.
 */
export async function liveSessionCwd(sessionId: string): Promise<string | undefined> {
  const live = peekProjector(sessionId)?.cwd;
  if (live) return live;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    return runtime.getSessionCwd?.(runtime.getInternalSessionId(sessionId) ?? sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Whether a chat has a turn running right now.
 *
 * @param sessionId - The chat.
 */
export async function isSessionBusy(sessionId: string): Promise<boolean> {
  return isTurnInFlight(sessionId, await runtimeRegistry.resolveForSession(sessionId));
}

/**
 * Claim a start slot for an agent's new kept chat through the start-work
 * seam, so it says who started it and counts against the extension's limits.
 *
 * @param extensionId - The extension opening it.
 * @param sessionId - The new chat's id.
 */
export function reserveKeptChat(
  extensionId: string,
  sessionId: string
): { ok: true; reservation: StartReservation } | { ok: false; message: string } | null {
  const startWork = getStartWorkService();
  if (!startWork) return null;
  const claimed = startWork.reserve({
    sessionId,
    kind: 'extension',
    extensionId,
    startedBySessionId: null,
    originExtensionId: extensionId,
    reason: 'it sends this agent messages',
  });
  return claimed.ok ? claimed : { ok: false, message: claimed.error.message };
}

/**
 * Re-arm a chat's queued rows after a restart, rather than waiting for the
 * next message to that chat to adopt them.
 *
 * @param sessionId - The chat.
 * @param liveCwd - The folder currently known in memory, when any.
 * @param roomSessionPlace - The room binding port available to this launch surface.
 * @param placeDeps - Test seams for place resolution.
 * @param agentOverrides - Live Mesh and pause readers, with optional test seams.
 */
export async function resumeChatQueue(
  sessionId: string,
  liveCwd: string | undefined,
  roomSessionPlace?: RoomSessionPlacePort,
  placeDeps: Partial<ResolveChatPlaceDeps> = {},
  agentOverrides: Partial<VerifyChatAgentDeps> = {}
): Promise<void> {
  const agentPath = (await runtimeRegistry.getSessionAgentPath(sessionId)) ?? undefined;
  const verification = chatAgentDeps(agentOverrides);
  if (agentPath !== undefined) {
    const refusal = verifyChatAgent({ agentPath }, verification);
    if (refusal) {
      refuseChatAgent(sessionId, refusal);
      return;
    }
  }
  const place = await resolveChatPlace(
    {
      sessionId,
      ...(liveCwd !== undefined ? { cwd: liveCwd } : {}),
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(roomSessionPlace !== undefined ? { roomSessionPlace } : {}),
    },
    placeDeps
  );
  if ('refusal' in place) {
    warnResumeRefusal(
      sessionId,
      `place:${place.refusal.code}`,
      '[MessageDispatcher] queued messages kept after place refusal',
      { refusalCode: place.refusal.code }
    );
    return;
  }
  const { cwd, forAgent, additionalDirectories } = place;
  if (agentPath !== undefined) {
    const refusal = verifyChatAgent(
      {
        agentPath,
        turn: { cwd, ...(forAgent !== undefined ? { forAgent } : {}) },
      },
      verification
    );
    if (refusal) {
      refuseChatAgent(sessionId, refusal);
      return;
    }
  }
  const runtime = place.session.runtime;
  const projector = getOrCreateProjector(sessionId, cwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  if (cwd !== undefined) projector.cwd = cwd;
  adoptQueuedMessages({
    sessionId,
    projector,
    runtime,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(forAgent !== undefined ? { forAgent } : {}),
    ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    onlyFromChats: true,
  });
  clearResumeRefusals(sessionId);
}

/**
 * Build the default queue recovery callback from the service's late-bound ports.
 *
 * @param meshCore - The live Mesh accessor already held by the service.
 * @param roomSessionPlace - The live room-place accessor held by the service.
 */
export function resumeChatQueueFor(
  meshCore: () => Pick<MeshCore, 'listWithPaths'> | undefined,
  roomSessionPlace: (() => RoomSessionPlacePort | undefined) | undefined
): (sessionId: string, cwd: string | undefined) => Promise<void> {
  return (sessionId, cwd) =>
    resumeChatQueue(
      sessionId,
      cwd,
      roomSessionPlace?.(),
      {},
      {
        registeredAgentPaths: () =>
          meshCore()
            ?.listWithPaths()
            .map((agent) => agent.projectPath),
      }
    );
}
