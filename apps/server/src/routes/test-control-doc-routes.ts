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
 * @module routes/test-control-doc-routes
 */
import { Hono } from 'hono';
import { z } from 'zod';
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
    openerAgentId: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Build the test-only declaration route.
 *
 * @param http - The server's document channel composition.
 */
export function createTestDocRouteGroup(
  http: Pick<DocChannelHttp, 'actor'> & { grants: DocChannelGrants }
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/configure', (c) => {
    const parsed = ConfigureSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid declaration.' }, 400);
    const { documentId, declaration, openerAgentId } = parsed.data;
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
    return c.json({ configured: true });
  });
  return router;
}
