/**
 * Resolve the place of an existing or about-to-start chat once, for both an
 * ordinary incoming message and recovery of its queued messages after boot.
 *
 * @module services/session/launch/resolve-chat-place
 */
import type { AgentRuntime, DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  resolveSessionCwdWithRoom,
  type ResolvedSessionPlace,
  type RoomSessionPlacePort,
  type RoomSessionRefusal,
} from '../../workspace/room-session-place.js';

/** What the caller already knows about the chat's place. */
export interface ResolveChatPlaceInput {
  /** The chat whose turn is about to start. */
  sessionId: string;
  /** A caller-supplied or live-projector folder, when one is known. */
  cwd?: string;
  /** The chat's verified or durably stored agent owner, when one is known. */
  agentPath?: string;
  /** The room binding port available to this launch surface. */
  roomSessionPlace?: RoomSessionPlacePort;
  /** Whether an unbound launch will resolve its directory through the workspace-key branch. */
  workspaceKeyed?: boolean;
}

/** The runtime ownership read that also supplies a bound chat's cwd probes. */
export interface ChatPlaceSessionResolution {
  /** The runtime this chat resolves to. */
  runtime: AgentRuntime;
  /** Whether durable or native state identifies that runtime as the owner. */
  bound: boolean;
}

/** A chat place that is safe to hand to the dispatcher. */
export interface ResolvedChatPlace {
  /** The folder to pass to the runtime; absent preserves its default-folder behavior. */
  cwd?: string;
  /** The room's agent identity, when the room binding supplied one. */
  forAgent?: string;
  /** The room folders the turn may reach beyond its cwd. */
  additionalDirectories?: DirectoryGrant[];
  /** The ownership read used to resolve this place, reused by the caller. */
  session: ChatPlaceSessionResolution;
}

/** A place refusal starts no turn and leaves queued work on disk. */
export interface RefusedChatPlace {
  /** The room-aware resolver's refusal. */
  refusal: RoomSessionRefusal;
}

/** Collaborators for {@link resolveChatPlace}, injectable without module mocks. */
export interface ResolveChatPlaceDeps {
  /** Resolve the runtime and whether this chat is already bound to it. */
  resolveSession(sessionId: string): Promise<ChatPlaceSessionResolution>;
  /** Read a native session's recorded directory. */
  nativeSessionCwd(sessionId: string): string | null;
  /** Apply the agent/default cwd ladder and any room binding. */
  resolveWithRoom(
    request: { cwd?: string; agentPath?: string; sessionId: string },
    roomSessionPlace: RoomSessionPlacePort | undefined
  ): Promise<ResolvedSessionPlace>;
}

/** Production chat-place collaborators with selected test seams replaced. */
function chatPlaceDeps(overrides: Partial<ResolveChatPlaceDeps>): ResolveChatPlaceDeps {
  return {
    resolveSession: (sessionId) =>
      runtimeRegistry.resolveForSessionWithOwnership(sessionId, { allowUnbound: true }),
    nativeSessionCwd: (sessionId) => runtimeRegistry.getNativeSessionCwd(sessionId),
    resolveWithRoom: resolveSessionCwdWithRoom,
    ...overrides,
  };
}

/**
 * Resolve a chat's bound-runtime cwd, then its room-aware agent/default place.
 *
 * The established-session ladder is the same one an incoming message has
 * always used: live runtime binding, native binding, runtime discovery, then
 * the room-aware agent path resolver. The resolver's `default` rung is turned
 * back into no cwd so the runtime keeps ownership of its default-folder choice.
 *
 * An unbound workspace-keyed launch stops after the ownership lookup because
 * `launchSessionMessage`'s workspace branch still owns that per-turn binding.
 *
 * @param input - The chat id and place hints the launch surface knows.
 * @param overrides - Test seams for runtime and room-aware place resolution.
 * @returns A dispatchable place and ownership read, or a refusal.
 */
export async function resolveChatPlace(
  input: ResolveChatPlaceInput,
  overrides: Partial<ResolveChatPlaceDeps> = {}
): Promise<ResolvedChatPlace | RefusedChatPlace> {
  const deps = chatPlaceDeps(overrides);
  const session = await deps.resolveSession(input.sessionId);
  let effectiveCwd = input.cwd;
  if (session.bound) {
    const actual =
      session.runtime.getSessionCwd?.(input.sessionId) ??
      deps.nativeSessionCwd(input.sessionId) ??
      (await session.runtime.findSession?.(input.sessionId))?.cwd;
    if (actual) effectiveCwd = actual;
  }

  if (input.workspaceKeyed && !session.bound) {
    return {
      cwd: effectiveCwd,
      forAgent: undefined,
      additionalDirectories: undefined,
      session,
    };
  }

  // No unit-of-work key, so ask the precedence chain where this turn belongs
  // (`services/workspace/resolve-session-cwd.ts`). An unbound workspace key
  // stops above and keeps its precedence deliberately: it is a per-turn
  // statement about this piece of work, which is strictly more specific than a
  // standing per-agent preference.
  //
  // The `default` rung is translated back into saying NOTHING, and that is
  // load-bearing rather than fussy. Every runtime already falls back to
  // `DEFAULT_CWD` on an absent cwd, so the turn runs in the same directory
  // either way — but the resolved cwd is also what the caller stamps onto
  // `projector.cwd`, overwriting whatever an `/events` subscribe put there. A
  // turn that has no opinion about its directory must not acquire one here.
  //
  // The room binding is offered to the chain rather than resolved here
  // (DOR-1624, spec `agent-home-desk` §5.7). A conversation this machine also
  // answers in a room stands in the agent's home and reaches the room's files
  // through folder grants, so a resume from the app must carry the same
  // grants or the agent loses the files it was working on. The port answers
  // `null` for every other session, which leaves the chain exactly as it was.
  const resolved = await deps.resolveWithRoom(
    {
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      agentPath: input.agentPath,
      sessionId: input.sessionId,
    },
    input.roomSessionPlace
  );
  if (resolved.refusal) return { refusal: resolved.refusal };

  return {
    cwd: resolved.rung === 'default' ? undefined : resolved.cwd,
    forAgent: resolved.forAgent,
    additionalDirectories: resolved.additionalDirectories,
    session,
  };
}
