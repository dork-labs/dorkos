/**
 * Where a verified agent's relay message into a chat may go
 * (`POST /api/relay/messages`, DOR-5200).
 *
 * A subject whose last part names a chat a runtime holds
 * (`relay.agent.<runtime>.<sessionId>`, the three-token `relay.agent.<sessionId>`,
 * or any other `relay.agent.*` shape ending in one) starts or feeds a turn in
 * that chat, just as `POST /api/sessions/:id/messages` does. So an agent whose
 * token verified meets the sessions route's own place rule
 * ({@link chatPlaceRefusal}) and gets its answer: its own chat, or a chat about
 * a folder no agent owns, goes through; a chat that is another agent's is
 * refused with `DESK_NOT_OWN`. The shape is not trusted to say which it is,
 * since the relay's adapter resumes a held chat by that id whatever the shape.
 *
 * Everything else is left as it was: the person is never asked, an id Mesh
 * knows as an agent is a message to that agent, and an id no runtime holds
 * names no chat yet. A caller DorkOS cannot name is not asked here either; how
 * far it may reach is decided apart from this rule.
 *
 * @module routes/relay-chat-place
 */
import { extractSessionIdFromSubject } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { RequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { SESSION_LAUNCH_ACTION } from '../services/session/launch/launch-audit.js';
import { chatPlaceRefusal, sessionLauncherOf } from './session-launcher.js';

/** What the place rule reads from Mesh: the registered homes, and whether an id is an agent's. */
export type RelayChatMesh = Pick<MeshCore, 'listWithPaths' | 'getProjectPath'>;

/**
 * The id a subject would reach a chat by, or `undefined` when it is an agent's
 * own address or no `relay.agent.*` subject at all.
 *
 * @param subject - The message's subject.
 * @param mesh - Mesh, to tell an agent's own address from a chat's.
 */
function chatOfSubject(subject: string, mesh: RelayChatMesh | undefined): string | undefined {
  const id = extractSessionIdFromSubject(subject);
  if (id === null || mesh?.getProjectPath(id) !== undefined) return undefined;
  return id;
}

/**
 * Whether a runtime holds this chat. A store that cannot answer counts as
 * holding it, so the place rule decides rather than nobody.
 *
 * @param sessionId - The chat.
 */
async function isHeldChat(sessionId: string): Promise<boolean> {
  try {
    return (await runtimeRegistry.resolveSessionRuntime(sessionId, { allowUnbound: true })).bound;
  } catch {
    return true;
  }
}

/**
 * Why this caller may not send into the chat the subject names, as the `403`
 * body the sessions route answers with, or `null` when it may.
 *
 * @param facts - The request's facts.
 * @param subject - The message's subject.
 * @param mesh - Mesh, which lists the registered homes.
 */
export async function relayChatPlaceRefusal(
  facts: RequestFacts,
  subject: string,
  mesh: RelayChatMesh | undefined
): Promise<{ error: string; code: string } | null> {
  if (sessionLauncherOf(facts).kind !== 'agent') return null;
  const sessionId = chatOfSubject(subject, mesh);
  if (sessionId === undefined || !(await isHeldChat(sessionId))) return null;
  const refusal = await chatPlaceRefusal(facts, mesh, sessionId, SESSION_LAUNCH_ACTION);
  return refusal ? errorBody(refusal.message, 'DESK_NOT_OWN') : null;
}
