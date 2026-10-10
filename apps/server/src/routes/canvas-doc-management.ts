/** Scoped operator bridge to original capability dispatch; generic HTTP invocation remains untrusted. */
import { Router } from 'express';
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
  registry: CapabilityRegistry,
  http: DocChannelHttp
) {
  const router = Router(),
    resolveActor = http.actor;
  router.post('/:id/manage/:operation', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const id = req.params.id,
        operation = req.params.operation;
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 200 ||
        typeof operation !== 'string' ||
        !Object.hasOwn(operations, operation) ||
        Object.keys(req.query).length ||
        (typeof req.headers.authorization === 'string' &&
          /^Bearer dct_/iu.test(req.headers.authorization))
      )
        throw new Error('Invalid operator document operation.');
      const input = req.body;
      const candidate = operation === 'issueToken' ? input?.request : input;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        candidate.documentId !== id
      )
        throw new Error('Document operation scope differs.');
      const actor = Reflect.apply(resolveActor, http, [req, res]);
      if (actor.principal.claims.kind !== 'operator') throw new Error('Operator required.');
      const header = req.headers['x-dorkos-approval'];
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
      res.json(result);
    } catch (error) {
      if (error instanceof CapabilityGateRefusal) {
        res
          .status(error.decision.outcome === 'approval_required' ? 202 : 403)
          .json(error.decision.payload);
      } else if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ code: 'INVALID_DOC_MANAGEMENT', error: 'The document operation is not valid.' });
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
        res.status(status).json({
          code: 'DOC_MANAGEMENT_UNAVAILABLE',
          error: 'The document operation is not available.',
        });
      }
    }
  });
  return router;
}
