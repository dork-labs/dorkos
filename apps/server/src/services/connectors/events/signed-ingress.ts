/** Exact raw-body webhook mount; signature authentication replaces only this endpoint's cookie gate. */
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { CONNECTOR_EVENT_MAX_RAW_BYTES } from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectorEventCapability,
  ConnectorVerifiedEvent,
} from '@dorkos/shared/connector-events';

/** Private application composition for signed ingress, independent of cloud linking. */
export interface ConnectorSignedIngress {
  /** Select the configured provider verifier; the path ID is routing, never authority. */
  verifier(providerInstanceId: string): ConnectorEventCapability | undefined;
  /** Resolve exact stored trigger/account ownership and commit protected inbox rows before returning. */
  accept(
    providerInstanceId: string,
    event: ConnectorVerifiedEvent
  ): Promise<'accepted' | 'rejected' | 'unavailable'>;
}

/** Build the terminal raw endpoint before global parsing, logging and session authentication. */
export function createConnectorSignedIngress(ingress: ConnectorSignedIngress): RequestHandler[] {
  const validate: RequestHandler = (req, res, next) => {
    if (
      !req.is('application/json') ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    ) {
      res.status(415).json({ error: 'UNSUPPORTED_EVENT_ENCODING' });
      return;
    }
    next();
  };
  const receive: RequestHandler = async (req, res) => {
    const providerInstanceId = req.params.providerInstanceId;
    if (
      typeof providerInstanceId !== 'string' ||
      providerInstanceId.length > 256 ||
      !Buffer.isBuffer(req.body)
    ) {
      res.status(400).json({ error: 'INVALID_EVENT_REQUEST' });
      return;
    }
    const id = req.headers['webhook-id'];
    const timestamp = req.headers['webhook-timestamp'];
    const signature = req.headers['webhook-signature'];
    if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      res.status(401).json({ error: 'INVALID_EVENT_SIGNATURE' });
      return;
    }
    try {
      const verifier = ingress.verifier(providerInstanceId);
      if (!verifier) {
        res.status(503).json({ error: 'EVENTS_UNAVAILABLE' });
        return;
      }
      const verified = await verifier.verifyWebhook({
        rawBody: req.body,
        webhookId: id,
        webhookTimestamp: timestamp,
        webhookSignature: signature,
      });
      // Drop the raw body before entering any later error or request handling.
      req.body = undefined;
      if (verified.status !== 'verified') {
        res.status(401).json({ error: 'INVALID_EVENT_SIGNATURE' });
        return;
      }
      const outcome = await ingress.accept(providerInstanceId, verified.event);
      if (outcome === 'unavailable') {
        res.status(503).json({ error: 'EVENTS_UNAVAILABLE' });
        return;
      }
      if (outcome === 'rejected') {
        res.status(403).json({ error: 'EVENT_BINDING_REJECTED' });
        return;
      }
      res.status(202).json({ accepted: true });
    } catch {
      req.body = undefined;
      res.status(503).json({ error: 'EVENTS_UNAVAILABLE' });
    }
  };
  const malformed: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    req.body = undefined;
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    res
      .status(oversized ? 413 : 400)
      .json({ error: oversized ? 'EVENT_TOO_LARGE' : 'INVALID_EVENT_REQUEST' });
  };
  // Express supports error handlers in route stacks; the public return type is
  // RequestHandler[] for app.post composition, so narrow only at this boundary.
  return [
    validate,
    express.raw({ type: 'application/json', limit: CONNECTOR_EVENT_MAX_RAW_BYTES, inflate: false }),
    receive,
    malformed as unknown as RequestHandler,
  ];
}
