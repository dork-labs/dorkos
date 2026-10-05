/**
 * The production halves of the agent-send seam (`ctx.agent.send`, DOR-2683):
 * how it reads a chat, its folder and whether it is busy, how it claims a
 * start slot for an agent's chat, and how it re-arms a chat's queue after a
 * restart. Split from `agent-send.ts` so the seam itself reads as delivery;
 * tests replace each of these.
 *
 * @module services/extensions/agent-send/agent-send-defaults
 */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { adoptQueuedMessages, isTurnInFlight } from '../../session/message-dispatcher.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { persistenceModeFor } from '../../session/projector-persistence.js';
import { getOrCreateProjector, peekProjector } from '../../session/session-state-projector.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { getStartWorkService, type StartReservation } from '../start-work.js';

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
 * The folder a chat runs in: its live projector's, else its runtime's live
 * binding. Unknown after a restart for a chat nobody has opened since: the
 * launch then resolves the folder from the chat's stored agent path, and
 * failing that the default folder, the same ladder a person's message with no
 * `cwd` walks.
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
 * @param cwd - The folder it runs in, when known.
 */
export async function resumeChatQueue(sessionId: string, cwd: string | undefined): Promise<void> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const projector = getOrCreateProjector(sessionId, cwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  adoptQueuedMessages({ sessionId, projector, runtime, ...(cwd ? { cwd } : {}) });
}
