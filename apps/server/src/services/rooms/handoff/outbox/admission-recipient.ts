/**
 * Same-database positive admission recipient facts. Read-only: stored rows, plus the bound
 * runtime's in-memory folder for a chat that recorded no agent (DOR-5035).
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { eq, agents, authors, sessionMetadata, type Db, type DbTransaction } from '@dorkos/db';
import {
  chatAgentStateOf,
  type ChatAgentState,
} from '../../../core/agent-identity/session-agent.js';

/**
 * Whether the chat's agent state names `agentPath`. With `acceptUnknownAgent`, a chat whose
 * agent is no longer known (its runtime dropped it, no agent was recorded) is taken to be the
 * agent the caller's admission witness already named; a refused folder, nobody's folder or a
 * different agent never is. Taken by the end notice (DOR-5040) and by the claim and the
 * before-run check of a queued hand-off (DOR-5087); admission never takes it.
 */
function namesAgent(state: ChatAgentState, agentPath: string, acceptUnknownAgent: boolean) {
  if (state.kind === 'agent') return state.agentPath === agentPath;
  return state.kind === 'unknown' && acceptUnknownAgent;
}

/**
 * Capture a positive original session/agent epoch from the owning database.
 *
 * @param db - The database or open transaction.
 * @param sessionId - The chat that admitted the hand-off.
 * @param authorId - The posting agent's author id.
 * @param agentPath - The posting agent's home.
 * @param opts.acceptUnknownAgent - Only for re-checking a witness captured at admission, whose
 *   digest the caller then compares: a chat whose agent is no longer known still matches.
 */
export function captureAdmissionRecipient(
  db: Db | DbTransaction,
  sessionId: string,
  authorId: string,
  agentPath: string,
  opts: { acceptUnknownAgent?: boolean } = {}
) {
  const metadata = db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  const author = db.select().from(authors).where(eq(authors.id, authorId)).get();
  const agent = db.select().from(agents).where(eq(agents.projectPath, agentPath)).get();
  // A chat bound without an agent belongs to the agent its folder resolves to (DOR-5035).
  if (
    !metadata?.runtime ||
    !namesAgent(chatAgentStateOf(db, sessionId), agentPath, opts.acceptUnknownAgent === true) ||
    !author ||
    author.kind !== 'agent' ||
    author.naturalKey !== agentPath ||
    !agent ||
    agent.status !== 'active' ||
    author.mintedForManifestId !== agent.id ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  )
    return undefined;
  // Capture known closed origins too: admission is public NEW work; notification reach is checked separately.
  const facts = {
    sessionId,
    createdAt: metadata.createdAt,
    agentId: agent.id,
    agentPath,
    authorId,
    runtime: metadata.runtime,
    launchOrigin: metadata.launchOrigin,
    requiredLaunchId: metadata.requiredLaunchId,
  };
  return Object.freeze({
    ...facts,
    digest: createHash('sha256').update(stableStringify(facts)).digest('hex'),
  });
}
/** Immutable recipient facts captured before public handoff admission. */
export type AdmissionRecipient = NonNullable<ReturnType<typeof captureAdmissionRecipient>>;
