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
 * `openerSession` names the agent that runs a session as the document's opener,
 * found (and its seeded runtime aligned) by `services/canvas/doc-channel/route-controls/test-opener.ts`.
 *
 * @module routes/test-control-doc-routes
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import type { DocChannelHttp } from './canvas-doc-events.js';
import type { DocChannelGrants } from '../services/canvas/doc-channel/grants.js';
import type { TestDocOpener } from '../services/canvas/doc-channel/route-controls/test-opener.js';

const ConfigureSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    declaration: CanvasChannelDeclarationSchema,
    openerSession: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Build the test-only declaration route.
 *
 * @param http - The server's document channel composition.
 * @param openerOf - The registered agent that runs a session, with its seeded runtime aligned.
 */
export function createTestDocRouteGroup(
  http: Pick<DocChannelHttp, 'actor'> & { grants: DocChannelGrants },
  openerOf: TestDocOpener
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/configure', (c) => {
    const parsed = ConfigureSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationProblem(c, parsed.error);
    const { documentId, declaration, openerSession } = parsed.data;
    const openerAgentId = openerSession ? openerOf(openerSession) : undefined;
    if (openerSession && !openerAgentId)
      return problem(c, 'not_found', { detail: 'No registered agent runs that chat.' });
    try {
      http.grants.configure(
        documentId,
        declaration,
        http.actor(honoRequestFacts(c)),
        openerAgentId
      );
    } catch (error) {
      logger.warn('[TestDocRoutes] declaration refused', { error });
      return problem(c, 'conflict', { detail: 'Declaration refused.' });
    }
    return c.json({ configured: true, ...(openerAgentId ? { openerAgentId } : {}) });
  });
  return router;
}
