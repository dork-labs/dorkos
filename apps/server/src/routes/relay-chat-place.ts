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
 * @module routes/relay-chat-place
 */
import { resolveAgentTurnIdentity, type AgentSessionStoreLike } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { homeOf, resolveAgentHome } from '../services/core/agent-identity/agent-home.js';
import { realOr } from '../services/session/launch/launch-caller.js';
import { SESSION_LAUNCH_ACTION } from '../services/session/launch/launch-audit.js';
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
 * Whether something holds a chat under this id: a runtime running it now, a
 * binding row, or a runtime's own store (`resolveSessionRuntime`, asked
 * without leave to guess). A lookup that fails counts as held.
 *
 * @param sessionId - The id.
 */
async function isHeldChat(sessionId: string): Promise<boolean> {
  try {
    if (chatFolderOf(sessionId) !== undefined) return true;
    return (await runtimeRegistry.resolveSessionRuntime(sessionId)).bound;
  } catch {
    return true;
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
 * @param mesh - Mesh.
 */
async function isAgentAddress(id: string, mesh: RelayChatMesh | undefined): Promise<boolean> {
  const home = mesh?.getProjectPath(id);
  if (home === undefined) return false;
  if (!(await isHeldChat(id))) return true;
  const owner = await heldChatOwner(id);
  return owner !== undefined && realOr(owner) === realOr(home);
}

/**
 * The chats this message would reach: the subject's own id and the key the
 * adapter would run its turn under, each only when something holds it.
 *
 * @param message - The subject and payload, as sent.
 * @param sources - Mesh and the adapter's conversation map.
 */
async function chatsReached(
  message: { subject: string; payload: unknown },
  sources: RelayChatPlaceSources
): Promise<string[]> {
  const envelope = { payload: message.payload } as RelayEnvelope;
  const identity = resolveAgentTurnIdentity(message.subject, envelope, sources.agentSessions);
  if (!identity || (await isAgentAddress(identity.agentId, sources.mesh))) return [];
  const ids = [...new Set([identity.agentId, identity.key])];
  const held = await Promise.all(ids.map(isHeldChat));
  return ids.filter((_, i) => held[i]);
}

/**
 * Why this caller may not send this message into the chat it reaches, as the
 * `403` body the sessions route answers with, or `null` when it may.
 *
 * @param facts - The request's facts.
 * @param message - The subject and payload, as sent.
 * @param sources - Mesh and the adapter's conversation map.
 */
export async function relayChatPlaceRefusal(
  facts: RequestFacts,
  message: { subject: string; payload: unknown },
  sources: RelayChatPlaceSources
): Promise<{ error: string; code: string } | null> {
  if (sessionLauncherOf(facts).kind !== 'agent') return null;
  for (const sessionId of await chatsReached(message, sources)) {
    const refusal = await chatPlaceRefusal(facts, sources.mesh, sessionId, SESSION_LAUNCH_ACTION);
    if (refusal) return errorBody(refusal.message, 'DESK_NOT_OWN');
  }
  return null;
}
