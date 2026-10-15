import { captureOriginalDocHttpActor } from '../services/canvas/doc-channel/http-composition.js';
/** Scoped operator bridge to original capability dispatch; generic HTTP invocation remains untrusted. */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { readJsonBody } from '../http/request-body.js';
import type { DocChannelHttp } from './canvas-doc-events.js';
import {
  invokeOriginalCapabilityRegistry,
  type CapabilityRegistry,
} from '../services/core/capabilities/registry.js';
import { CapabilityGateRefusal } from '../services/core/capabilities/index.js';
import { z } from 'zod';
const operations = Object.freeze({
  configure: 'ui.configure_doc_channel',
  approve: 'ui.approve_doc_route',
  revoke: 'ui.revoke_doc_route',
  replay: 'ui.replay_doc_batch',
  inspect: 'ui.inspect_doc_channel',
  issueToken: 'ui.issue_doc_token',
  revokeToken: 'ui.revoke_doc_token',
});
/** Capture the same installed HTTP actor and original registry; no body principal or trusted marker is accepted. */
export function createCanvasDocManagementRouter(
  source: () => { registry?: CapabilityRegistry; http?: DocChannelHttp }
) {
  const router = new Hono<ApiEnv>();
  router.post('/:id/manage/:operation', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const { registry, http } = source();
      if (!registry || !http) throw new Error('Original document management is unavailable.');
      const resolveActor = captureOriginalDocHttpActor(http);
      const id = c.req.param('id'),
        operation = c.req.param('operation');
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 200 ||
        typeof operation !== 'string' ||
        !Object.hasOwn(operations, operation) ||
        Object.keys(readQuery(c)).length ||
        (typeof c.env.incoming.headers.authorization === 'string' &&
          /^Bearer dct_/iu.test(c.env.incoming.headers.authorization))
      )
        throw new Error('Invalid operator document operation.');
      const input = readJsonBody(c) as Record<string, unknown> | undefined;
      const candidate = (operation === 'issueToken' ? input?.request : input) as
        Record<string, unknown> | undefined;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        candidate.documentId !== id
      )
        throw new Error('Document operation scope differs.');
      const actor = Reflect.apply(resolveActor, http, [honoRequestFacts(c)]);
      if (actor.principal.claims.kind !== 'operator') throw new Error('Operator required.');
      const header = c.env.incoming.headers['x-dorkos-approval'];
      if (header !== undefined && typeof header !== 'string')
        throw new Error('Invalid approval header.');
      const owner = actor.principal.claims.owner;
      // Registry tier and independent exact route approval both remain in force.
      const result = await invokeOriginalCapabilityRegistry(
        registry,
        operations[operation as keyof typeof operations],
        input,
        {
          serverPrincipal: actor.principal,
          ...(owner.kind === 'user' ? { userId: owner.userId } : {}),
          ...(header ? { approvalToken: header } : {}),
          retryChannel: 'http-header',
        }
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof CapabilityGateRefusal) {
        return c.json(
          error.decision.payload,
          error.decision.outcome === 'approval_required' ? 202 : 403
        );
      } else if (error instanceof z.ZodError) {
        return c.json(
          { code: 'INVALID_DOC_MANAGEMENT', error: 'The document operation is not valid.' },
          400
        );
      } else {
        const status =
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          typeof error.status === 'number' &&
          error.status >= 400 &&
          error.status <= 499
            ? error.status
            : 403;
        return c.json(
          {
            code: 'DOC_MANAGEMENT_UNAVAILABLE',
            error: 'The document operation is not available.',
          },
          status as ContentfulStatusCode
        );
      }
    }
  });
  return router;
}
