/**
 * The signed webhook ingress, `POST /api/connectors/webhooks/:providerInstanceId`:
 * the one connector route whose caller is an outside service, not a person or
 * an agent. Its signature replaces the cookie gate for this endpoint only.
 *
 * Registered through the `/api` chain's `beforeBodyParsing` seam
 * (`http/api-chain.ts`), after the host guard and before any body is parsed,
 * the session gate, the request log and the audit fallback, which is where the
 * Express chain used to mount it: the signature is checked over the exact
 * bytes that arrived, and nothing about a refused event is logged or recorded
 * as a person.
 *
 * The bytes are read by `body-parser`'s raw reader on the Node request, the
 * reader `express.raw` is, so the ceiling, the early refusal of a declared
 * length over it, a length that does not match, and an aborted upload all
 * answer exactly as they did. Reading through `c.req.arrayBuffer()` would hold
 * an unbounded chunked body in memory before any ceiling could apply.
 *
 * @module services/connectors/events/signed-ingress
 */
import type { IncomingMessage } from 'node:http';
import bodyParser from 'body-parser';
import type { Hono } from 'hono';
import typeis from 'type-is';
import { CONNECTOR_EVENT_MAX_RAW_BYTES } from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectorEventCapability,
  ConnectorVerifiedEvent,
} from '@dorkos/shared/connector-events';
import type { ApiEnv } from '../../../http/api-chain.js';

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

/** The Node request once the raw reader has run: `body` is the bytes, or unset. */
type ReadRequest = IncomingMessage & { body?: unknown };

const readRawBody = bodyParser.raw({
  type: 'application/json',
  limit: CONNECTOR_EVENT_MAX_RAW_BYTES,
  inflate: false,
});

/**
 * Read the raw body into `incoming.body`, or say why it could not be read.
 *
 * @returns `undefined` once read, else the refusal status and code.
 */
function readBody(
  incoming: ReadRequest,
  outgoing: Parameters<typeof readRawBody>[1]
): Promise<{ status: 413 | 400; error: string } | undefined> {
  return new Promise((resolve) => {
    readRawBody(incoming, outgoing, (error?: unknown) => {
      if (error === undefined || error === null) return resolve(undefined);
      incoming.body = undefined;
      const oversized =
        typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
      resolve(
        oversized
          ? { status: 413, error: 'EVENT_TOO_LARGE' }
          : { status: 400, error: 'INVALID_EVENT_REQUEST' }
      );
    });
  });
}

/**
 * Register the terminal raw endpoint on the `/api` app, before global parsing,
 * logging and session authentication. Call it from `beforeBodyParsing`.
 *
 * @param app - The Hono `/api` app, at its before-body point.
 * @param ingress - The verifier lookup and the protected inbox.
 */
export function mountConnectorSignedIngress(
  app: Hono<ApiEnv>,
  ingress: ConnectorSignedIngress
): void {
  app.post('/api/connectors/webhooks/:providerInstanceId', async (c) => {
    const incoming = c.env.incoming as ReadRequest;
    const { headers } = incoming;
    if (
      !typeis(incoming, ['application/json']) ||
      (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
    ) {
      return c.json({ error: 'UNSUPPORTED_EVENT_ENCODING' }, 415);
    }
    const unreadable = await readBody(incoming, c.env.outgoing);
    if (unreadable) return c.json({ error: unreadable.error }, unreadable.status);

    const providerInstanceId = c.req.param('providerInstanceId');
    const rawBody = incoming.body;
    if (providerInstanceId.length > 256 || !Buffer.isBuffer(rawBody)) {
      return c.json({ error: 'INVALID_EVENT_REQUEST' }, 400);
    }
    const id = headers['webhook-id'];
    const timestamp = headers['webhook-timestamp'];
    const signature = headers['webhook-signature'];
    if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      return c.json({ error: 'INVALID_EVENT_SIGNATURE' }, 401);
    }
    try {
      const verifier = ingress.verifier(providerInstanceId);
      if (!verifier) return c.json({ error: 'EVENTS_UNAVAILABLE' }, 503);
      const verified = await verifier.verifyWebhook({
        rawBody,
        webhookId: id,
        webhookTimestamp: timestamp,
        webhookSignature: signature,
      });
      // Drop the raw body before entering any later error or request handling.
      incoming.body = undefined;
      if (verified.status !== 'verified') return c.json({ error: 'INVALID_EVENT_SIGNATURE' }, 401);
      const outcome = await ingress.accept(providerInstanceId, verified.event);
      if (outcome === 'unavailable') return c.json({ error: 'EVENTS_UNAVAILABLE' }, 503);
      if (outcome === 'rejected') return c.json({ error: 'EVENT_BINDING_REJECTED' }, 403);
      return c.json({ accepted: true }, 202);
    } catch {
      incoming.body = undefined;
      return c.json({ error: 'EVENTS_UNAVAILABLE' }, 503);
    }
  });
}
