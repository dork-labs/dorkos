/**
 * Test mode only: the registered agent that opens a document for a browser spec's declared
 * routes (`POST /api/test/doc-routes/configure`, `routes/test-control-doc-routes.ts`).
 *
 * `/api/test/seed-agent` registers its agent as `codex` so that its sessions run on the test-mode
 * runtime instead; a route to that agent's session needs the two to agree, so this aligns the
 * seeded agent's recorded runtime with its session first. That is fixture repair a real install
 * never needs, which is why only the test-control group calls it.
 *
 * @module services/canvas/doc-channel/route-controls/test-opener
 */
import { agents, sessionMetadata, eq, type Db } from '@dorkos/db';

/** The registered agent that runs a session, aligned with the session's runtime. */
export type TestDocOpener = (sessionId: string) => string | undefined;

/**
 * Bind the opener lookup to the database the agents and sessions are recorded in.
 *
 * @param db - The database the agents and sessions are recorded in.
 * @returns The lookup the test-control declaration route calls.
 */
export function testDocOpener(db: Db): TestDocOpener {
  return (sessionId) => {
    const session = db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (!session?.agentPath || !session.runtime) return undefined;
    const agent = db.select().from(agents).where(eq(agents.projectPath, session.agentPath)).get();
    if (!agent) return undefined;
    if (agent.runtime !== session.runtime)
      db.update(agents).set({ runtime: session.runtime }).where(eq(agents.id, agent.id)).run();
    return agent.id;
  };
}
