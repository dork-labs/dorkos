/**
 * Where a verified agent's relay message into a chat may go
 * (`POST /api/relay/messages`, DOR-5200).
 *
 * A `relay.agent.*` subject starts or feeds a turn in a chat, just as
 * `POST /api/sessions/:id/messages` does, whenever the id it ends in, or the key
 * the relay's adapter would run the turn under ({@link resolveAgentTurnIdentity}:
 * the conversation that id and the payload's `conversationId` already map to),
 * is a chat something holds. Held means a binding row, a runtime's own store,
 * or a runtime running it now. A lookup that fails counts as held, so the place
 * rule decides rather than nobody. The subject's shape is not trusted to say
 * which it is, since the adapter resumes a held chat by that id whatever the
 * shape.
 *
 * So an agent whose token verified meets the sessions route's own place rule
 * ({@link chatPlaceRefusal}) for each such chat and gets its answer: its own
 * chat, or a chat about a folder no agent owns outside the protected folders,
 * goes through; a chat that is another agent's, whose record cannot be read, or
 * that no agent runs in a protected folder is refused with `DESK_NOT_OWN`.
 *
 * Everything else is left as it was. The person is never asked. An id Mesh
 * knows as an agent is a message to that agent, unless a chat held under that
 * id is someone else's, by its record or its folder (any agent can register
 * one, so a Mesh id alone proves nothing about a chat). An id nothing holds names no chat yet. A
 * caller DorkOS cannot name is not asked here either; how far it may reach is
 * decided apart from this rule.
 *
 * By design, a message to another agent's own address with a `conversationId`
 * in its payload goes on in the relay conversation that id names, which is
 * that agent's own, and never the person's chat. The conversation id is what
 * keeps such a conversation apart, so a sender that knows one may write into it,
 * as the relay always allowed. The sessions route has no such way in; a rule
 * that held each conversation to the agents in it would be new work.
 *
 * Both this rule and {@link chatPlaceRefusal} read a chat's folder through one
 * reader, {@link chatFolderOf}, so they cannot disagree about where it stands.
 *
 * A message from anyone but the person that starts a new chat (an id nothing
 * holds and Mesh does not know as an agent) opens it where the sessions route
 * would open it ({@link relayNewChatPlace}, DOR-5209): a verified, registered
 * agent's in its own home, run as itself, and a place that route refuses is
 * refused the same way.
 *
 * @module routes/relay-chat-place
 */
import {
  resolveAgentTurnIdentity,
  type AgentSessionStoreLike,
  type NewChatPlace,
} from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RequestFacts } from '../http/request-facts.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { homeOf, resolveAgentHome } from '../services/core/agent-identity/agent-home.js';
import {
  launchedByOf,
  launchPlaceRefusal,
  realOr,
} from '../services/session/launch/launch-caller.js';
import {
  auditRefusedLaunch,
  SESSION_LAUNCH_ACTION,
} from '../services/session/launch/launch-audit.js';
import type { SessionLaunchRefusal } from '../services/session/launch/launch-session.js';
import { resolveChatPlace } from '../services/session/launch/resolve-chat-place.js';
import { registeredChatAgentPath } from '../services/session/launch/verify-chat-agent.js';
import { chatFolderOf, chatPlaceRefusal, sessionLauncherOf } from './session-launcher.js';

/** What the place rule reads from Mesh: the registered homes, and whether an id is an agent's. */
export type RelayChatMesh = Pick<MeshCore, 'listWithPaths' | 'getProjectPath'>;

/** What the rule reads beyond the request: Mesh, and the adapter's conversation map. */
export interface RelayChatPlaceSources {
  /** Mesh, which lists the registered homes. */
  mesh?: RelayChatMesh;
  /** The relay adapter's agent-key to conversation map, when relay bindings run. */
  agentSessions?: AgentSessionStoreLike;
}

/**
 * Whether something holds a chat under an id: `held` (a runtime running it
 * now, a binding row, or a runtime's own store), `free` (nothing does), or
 * `unknown` (a runtime's store could not be read, and no other source holds
 * it). With the runtime the registry would start a free or unknown id on.
 */
interface ChatHold {
  /** What the sources say. */
  hold: 'held' | 'free' | 'unknown';
  /** The runtime a new chat under this id resolves to, when that could be read. */
  runtime?: string;
}

/**
 * Read whether something holds a chat under this id ({@link ChatHold}): asked
 * strictly first, then, when a runtime's store fails, again without it, as the
 * sessions route asks of a new chat (`resolveChatPlace`). A read that fails
 * outright is `unknown`.
 *
 * @param sessionId - The id.
 */
async function chatHoldOf(sessionId: string): Promise<ChatHold> {
  try {
    if (chatFolderOf(sessionId) !== undefined) return { hold: 'held' };
    const strict = await runtimeRegistry.resolveSessionRuntime(sessionId);
    return strict.bound ? { hold: 'held' } : { hold: 'free', runtime: strict.type };
  } catch {
    try {
      const loose = await runtimeRegistry.resolveSessionRuntime(sessionId, { allowUnbound: true });
      return loose.bound ? { hold: 'held' } : { hold: 'unknown', runtime: loose.type };
    } catch {
      return { hold: 'unknown' };
    }
  }
}

/**
 * Whose a chat held under this id is, read as {@link chatPlaceRefusal} reads
 * it: the recorded agent, else the agent whose home the chat's folder is.
 * `undefined` when nobody can be named or a read fails.
 *
 * @param id - The id.
 */
async function heldChatOwner(id: string): Promise<string | undefined> {
  try {
    const recorded = await runtimeRegistry.getSessionAgentPath(id);
    if (recorded) return recorded;
    const cwd = chatFolderOf(id);
    return cwd ? homeOf(resolveAgentHome(cwd)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the id is an agent's own address: Mesh knows it as an agent, and no
 * chat is held under it, or the chat held there is that same agent's (a relay
 * turn first runs under the Mesh id, and the runtime's store keeps answering
 * to it). A chat that cannot be named is not an address.
 *
 * @param id - The id the subject ends in.
 * @param hold - Whether something holds a chat under it.
 * @param mesh - Mesh.
 */
async function isAgentAddress(
  id: string,
  hold: ChatHold,
  mesh: RelayChatMesh | undefined
): Promise<boolean> {
  const home = mesh?.getProjectPath(id);
  if (home === undefined) return false;
  if (hold.hold === 'free') return true;
  const owner = await heldChatOwner(id);
  return owner !== undefined && realOr(owner) === realOr(home);
}

/** What one message reaches, read once: who it is for, and who holds each chat it names. */
export interface RelayChatReach {
  /** The subject's id and the key the adapter would run its turn under. */
  identity: NonNullable<ReturnType<typeof resolveAgentTurnIdentity>>;
  /** Whether the subject's id is an agent's own address. */
  agentAddress: boolean;
  /** Who holds a chat under the subject's id and under the turn's key. */
  holds: ReadonlyMap<string, ChatHold>;
}

/**
 * What this message reaches, for a caller other than the person, or `null`
 * when the caller is the person or the subject names no agent. Each id is
 * asked once, and both rules below read the answer.
 *
 * @param facts - The request's facts.
 * @param message - The subject and payload, as sent.
 * @param sources - Mesh and the adapter's conversation map.
 */
export async function relayChatReach(
  facts: RequestFacts,
  message: { subject: string; payload: unknown },
  sources: RelayChatPlaceSources
): Promise<RelayChatReach | null> {
  if (sessionLauncherOf(facts).kind === 'person') return null;
  const envelope = { payload: message.payload } as RelayEnvelope;
  const identity = resolveAgentTurnIdentity(message.subject, envelope, sources.agentSessions);
  if (!identity) return null;
  const ids = [...new Set([identity.agentId, identity.key])];
  const holds = new Map(
    await Promise.all(ids.map(async (id) => [id, await chatHoldOf(id)] as const))
  );
  const agentAddress = await isAgentAddress(
    identity.agentId,
    holds.get(identity.agentId)!,
    sources.mesh
  );
  return { identity, agentAddress, holds };
}

/** Why a verified agent's message is refused when no store can say whose the chat is. */
export const CHAT_UNCHECKED_MESSAGE =
  "DorkOS can't check whose chat that is right now. Try again in a moment.";

/**
 * Why this caller may not send this message into the chat it reaches, as the
 * sentence of the `403` `desk_not_own` problem the route answers with, or `null` when it may. A chat
 * whose hold is `unknown` counts as held, so the place rule refuses it, with a
 * sentence that says the check could not be made.
 *
 * @param facts - The request's facts.
 * @param reach - What the message reaches ({@link relayChatReach}).
 * @param sources - Mesh and the adapter's conversation map.
 */
export async function relayChatPlaceRefusal(
  facts: RequestFacts,
  reach: RelayChatReach | null,
  sources: RelayChatPlaceSources
): Promise<string | null> {
  if (!reach || reach.agentAddress || sessionLauncherOf(facts).kind !== 'agent') return null;
  for (const [sessionId, { hold }] of reach.holds) {
    if (hold === 'free') continue;
    const refusal = await chatPlaceRefusal(facts, sources.mesh, sessionId, SESSION_LAUNCH_ACTION);
    if (refusal) {
      return hold === 'unknown' ? CHAT_UNCHECKED_MESSAGE : refusal.message;
    }
  }
  return null;
}

/** A new chat's place as the message carries it, or why the chat may not start. */
export type RelayNewChatPlace = { refused: SessionLaunchRefusal } | { place?: NewChatPlace };

/**
 * Where a new chat this message starts opens, asked as
 * `POST /api/sessions/:id/messages` asks it of a new chat that names no folder
 * (`launchSessionMessage`): a verified agent Mesh lists is the chat's agent, so
 * the chat resolves to its home ({@link resolveChatPlace}); anyone else gets the
 * server's default folder; and the place rule then decides, so a protected
 * default is refused with `PROTECTED_FOLDER`. A chat whose hold is `unknown`
 * is asked as a new chat, as the sessions route asks it. The person, a message
 * to an agent's own address and a chat something holds are not asked: they
 * carry no place.
 *
 * @param facts - The request's facts.
 * @param reach - What the message reaches ({@link relayChatReach}).
 * @param sources - Mesh and the adapter's conversation map.
 */
export async function relayNewChatPlace(
  facts: RequestFacts,
  reach: RelayChatReach | null,
  sources: RelayChatPlaceSources
): Promise<RelayNewChatPlace> {
  const launcher = sessionLauncherOf(facts);
  if (!reach || reach.agentAddress || launcher.kind === 'person') return {};
  const sessionKey = reach.identity.key;
  const { hold, runtime } = reach.holds.get(sessionKey)!;
  if (hold === 'held') return {};
  const registered = {
    registeredAgentPaths: () => sources.mesh?.listWithPaths().map((a) => a.projectPath),
  };
  // The registered spelling, as the sessions route records an agent's own chat.
  const own =
    launcher.kind === 'agent' ? registeredChatAgentPath(launcher.agentPath, registered) : undefined;
  // Who holds the chat was read above; a new chat is not asked again.
  const unbound = runtime
    ? { resolveSession: async () => ({ runtime: runtimeRegistry.get(runtime), bound: false }) }
    : {};
  const resolved = await resolveChatPlace(
    { sessionId: sessionKey, ...(own !== undefined ? { agentPath: own } : {}) },
    unbound
  );
  if ('refusal' in resolved) {
    return { refused: { refused: resolved.refusal.code, message: resolved.refusal.message } };
  }
  const place = { cwd: resolved.cwd ?? DEFAULT_CWD, defaulted: resolved.cwd === undefined };
  const refusal = launchPlaceRefusal(sources.mesh, launcher, place);
  if (refusal) {
    auditRefusedLaunch(sessionKey, refusal, launchedByOf(sources.mesh, launcher), place);
    const { code, message: sentence } = refusal;
    return { refused: { refused: 'DESK_NOT_OWN', message: sentence, launcherRefused: code } };
  }
  const forAgent = resolved.forAgent ?? own;
  if (resolved.cwd === undefined && forAgent === undefined) return {};
  return {
    place: {
      sessionKey,
      ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
      ...(forAgent !== undefined ? { forAgent } : {}),
    },
  };
}
