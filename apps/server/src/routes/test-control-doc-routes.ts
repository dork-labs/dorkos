/**
 * `POST /api/test/doc-routes/configure` — declare event routes on a canvas
 * document, as an agent's `configure_doc_channel` call would, so a browser spec
 * can drive the person's route controls (spec `doc-channel` task 5.2).
 *
 * Test mode only: registered with `addTestControlGroup` on a test-mode server,
 * so the path is the `/api` 404 everywhere else. It goes through the real grant
 * service as the request's own operator principal, so declaring a route grants
 * nothing, exactly as in production.
 *
 * `openerSession` names the agent that runs a session as the document's opener.
 * `/api/test/seed-agent` registers its agent as `codex` so that its sessions run
 * on the test-mode runtime instead; a route to that agent's session needs the two
 * to agree, so this aligns the seeded agent's recorded runtime with its session
 * first. That is fixture repair a real install never needs, which is why it
 * lives here and nowhere else.
 *
 * @module routes/test-control-doc-routes
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { agents, sessionMetadata, eq, type Db } from '@dorkos/db';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { DocChannelHttp } from './canvas-doc-events.js';
import type { DocChannelGrants } from '../services/canvas/doc-channel/grants.js';

const ConfigureSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    declaration: CanvasChannelDeclarationSchema,
    openerSession: z.string().min(1).max(200).optional(),
  })
  .strict();

/** The registered agent that runs a session, aligned with the session's runtime. */
function openerOf(db: Db, sessionId: string): string | undefined {
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
}

/**
 * Build the test-only declaration route.
 *
 * @param http - The server's document channel composition.
 * @param db - The database the agents and sessions are recorded in.
 */
export function createTestDocRouteGroup(
  http: Pick<DocChannelHttp, 'actor'> & { grants: DocChannelGrants },
  db: Db
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/configure', (c) => {
    const parsed = ConfigureSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid declaration.' }, 400);
    const { documentId, declaration, openerSession } = parsed.data;
    const openerAgentId = openerSession ? openerOf(db, openerSession) : undefined;
    if (openerSession && !openerAgentId)
      return c.json({ error: 'No registered agent runs that session.' }, 404);
    try {
      http.grants.configure(
        documentId,
        declaration,
        http.actor(honoRequestFacts(c)),
        openerAgentId
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return c.json({ error: 'Declaration refused.', code: String(code ?? 'UNKNOWN') }, 409);
    }
    return c.json({ configured: true, ...(openerAgentId ? { openerAgentId } : {}) });
  });
  return router;
}
