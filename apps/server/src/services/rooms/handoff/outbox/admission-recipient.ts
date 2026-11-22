/** Same-database positive admission recipient facts. Read-only; never resolves a native session. */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { eq, agents, authors, sessionMetadata, type Db, type DbTransaction } from '@dorkos/db';
/** Capture a positive original session/agent epoch from the owning database. */
export function captureAdmissionRecipient(
  db: Db | DbTransaction,
  sessionId: string,
  authorId: string,
  agentPath: string
) {
  const metadata = db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  const author = db.select().from(authors).where(eq(authors.id, authorId)).get();
  const agent = db.select().from(agents).where(eq(agents.projectPath, agentPath)).get();
  if (
    !metadata?.runtime ||
    metadata.agentPath !== agentPath ||
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
