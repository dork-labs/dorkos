/**
 * Resolve the place of an existing or about-to-start chat once, for both an
 * ordinary incoming message and recovery of its queued messages after boot.
 *
 * @module services/session/launch/resolve-chat-place
 */
import type { AgentRuntime, DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type {
  PersonChatBinding,
  PersonDraftWitness,
} from '../../core/runtime-seam/person-draft-settings.js';
import {
  SessionBirthWriteError,
  type SessionBirthWriteContext,
} from '../../core/runtime-seam/session-birth-write.js';
import type { FreshDmBirth } from '../chat-messages/sending/chat-message-birth.js';
import { recordedAgentOf } from './session-tool-warnings.js';
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

/** Production chat-place collaborators with selected seams replaced. */
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
 * @param overrides - Seams for runtime and room-aware place resolution: a caller that
 *   already read who holds the chat, or a test.
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

/** Where a chat that has run before stands and as whom. */
export interface HeldChatPlace {
  /** The chat's recorded folder; absent leaves it to the runtime. */
  cwd?: string;
  /** The agent recorded when the chat began, when there is one. */
  forAgent?: string;
}

/**
 * Where a chat something already holds stands, and as whom: the folder its
 * runtime records ({@link resolveChatPlace}), else its recorded agent's home,
 * and the agent recorded when it began. `null` when nothing holds the chat yet,
 * so it is a new chat. No room binding is read, so a room-bound chat gets no
 * room folders here. A failed agent read keeps the folder. A relay turn that
 * names no folder of its own reads its chat's place here (DOR-5245).
 *
 * @param sessionId - The chat.
 * @param overrides - Seams for place resolution, for a test.
 */
export async function heldChatPlace(
  sessionId: string,
  overrides: Partial<ResolveChatPlaceDeps> = {}
): Promise<HeldChatPlace | null> {
  const deps = chatPlaceDeps(overrides);
  const session = await deps.resolveSession(sessionId);
  if (!session.bound) return null;
  const recorded = (await recordedAgentOf(sessionId)) ?? undefined;
  const resolved = await resolveChatPlace(
    { sessionId, ...(recorded !== undefined ? { agentPath: recorded } : {}) },
    { ...overrides, resolveSession: async () => session }
  );
  // Only a room binding refuses a place, and none is passed here; the chat is still held.
  if ('refusal' in resolved) return {};
  const forAgent = resolved.forAgent ?? recorded;
  return {
    ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
    ...(forAgent !== undefined ? { forAgent } : {}),
  };
}

/** Match a saved folder to its directory and a registered agent to its verified owner.
 * A registered agent can use a different directory through ordinary workspace placement.
 */
export function matchesPersonChatPlace(
  source: PersonChatBinding,
  place: ResolvedChatPlace,
  verifiedAgentPath: string | undefined
): boolean {
  const birth = 'birth' in source ? source.birth : undefined;
  const draft = 'draft' in source ? source.draft : undefined;
  const expectedAgentPath =
    birth?.kind === 'person-agent'
      ? birth.recordedRegisteredPath
      : draft?.sourceKind === 'person-agent'
        ? draft.sourcePath
        : undefined;
  return expectedAgentPath !== undefined
    ? verifiedAgentPath === expectedAgentPath &&
        (place.forAgent === undefined || place.forAgent === expectedAgentPath)
    : place.cwd === (birth?.kind === 'person-location' ? birth.cwd : draft?.sourcePath);
}

/** Select the exact server-owned source for a first bind without changing ordinary calls. */
export function launchBindingSourceArgs(
  place: ResolvedChatPlace,
  verifiedAgentPath: string | undefined,
  person: PersonChatBinding | undefined,
  freshDm: FreshDmBirth | undefined
): [SessionBirthWriteContext?, PersonDraftWitness?] {
  if (person) {
    if (freshDm || place.session.bound || !matchesPersonChatPlace(person, place, verifiedAgentPath))
      throw new SessionBirthWriteError('source');
    return 'birth' in person ? [person.birth] : [undefined, person.draft];
  }
  if (!freshDm) return [];
  if (place.session.bound || freshDm.targetAgent.path !== verifiedAgentPath)
    throw new SessionBirthWriteError('source');
  return [freshDm];
}
