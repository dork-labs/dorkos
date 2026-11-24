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
 * chat, or a chat about a folder no agent owns, goes through; a chat that is
 * another agent's, or whose record cannot be read, is refused with
 * `DESK_NOT_OWN`.
 *
 * Everything else is left as it was. The person is never asked. An id Mesh
 * knows as an agent is a message to that agent, unless a chat held under that
 * id is recorded to someone else (any agent can register one, so a Mesh id
 * alone proves nothing about a chat). An id nothing holds names no chat yet. A
 * caller DorkOS cannot name is not asked here either; how far it may reach is
 * decided apart from this rule.
 *
 * @module routes/relay-chat-place
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentTurnIdentity, type AgentSessionStoreLike } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { liveSessionCwd } from '../services/core/agent-identity/session-agent.js';
import { SESSION_LAUNCH_ACTION } from '../services/session/launch/launch-audit.js';
import { chatPlaceRefusal, sessionLauncherOf } from './session-launcher.js';

/** What the place rule reads from Mesh: the registered homes, and whether an id is an agent's. */
export type RelayChatMesh = Pick<MeshCore, 'listWithPaths' | 'getProjectPath'>;

/** What the rule reads beyond the request: Mesh, and the adapter's conversation map. */
export interface RelayChatPlaceSources {
  /** Mesh, which lists the registered homes. */
  mesh?: RelayChatMesh;
  /** The relay adapter's agent-key to conversation map, when relay bindings run. */
  agentSessions?: AgentSessionStoreLike;
}

/** A folder's real path, or its resolved spelling when it cannot be read. */
function realOr(dir: string): string {
  try {
    return fs.realpathSync.native(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
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
    if (liveSessionCwd(sessionId) !== undefined) return true;
    if (runtimeRegistry.listRuntimes().some((r) => r.getSessionCwd?.(sessionId) !== undefined)) {
      return true;
    }
    return (await runtimeRegistry.resolveSessionRuntime(sessionId)).bound;
  } catch {
    return true;
  }
}

/**
 * Whether the id is an agent's own address: Mesh knows it as an agent, and no
 * chat is held under it, or the one held is recorded to that same agent.
 *
 * @param id - The id the subject ends in.
 * @param mesh - Mesh.
 */
async function isAgentAddress(id: string, mesh: RelayChatMesh | undefined): Promise<boolean> {
  const home = mesh?.getProjectPath(id);
  if (home === undefined) return false;
  if (!(await isHeldChat(id))) return true;
  const recorded = await runtimeRegistry.getSessionAgentPath(id).catch(() => null);
  return recorded !== null && realOr(recorded) === realOr(home);
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
