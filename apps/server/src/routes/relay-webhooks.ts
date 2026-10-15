/**
 * The signed Relay webhook receiver, `POST /api/relay/webhooks/:adapterId`:
 * the one Relay route whose caller is an outside service. A webhook connection
 * checks an HMAC over the exact bytes that arrived, so those bytes are kept
 * raw by {@link relayWebhookBodyRule} rather than parsed as JSON.
 *
 * Unlike the connector ingress (`services/connectors/events/signed-ingress.ts`),
 * which answers to its signature alone ahead of the chain, this receiver still
 * stands behind the session gate, the request log and the audit fallback, as
 * it did on Express. So its raw read is a body rule in the chain's body stage,
 * not a route registered before it.
 *
 * @module routes/relay-webhooks
 */
import bodyParser from 'body-parser';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { WebhookAdapter } from '@dorkos/relay';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody, type BodyRule } from '../http/request-body.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';

/** The receiver's raw byte ceiling. */
const WEBHOOK_BODY_LIMIT = '1mb';

/** The receiver's path, as Express matched its mount: any case, one trailing slash. */
const WEBHOOK_PATH = /^\/api\/relay\/webhooks\/[^/]+\/?$/i;

/**
 * The receiver's body: the raw bytes, of any content type, up to 1 MB, read
 * INSTEAD of the app-wide JSON parser. Only `POST /api/relay/webhooks/:adapterId`;
 * every neighbouring path and method is parsed as JSON as before. It applies
 * only while the receiver is mounted (Relay on, with adapters): with Relay off
 * nothing on Hono claims the path, and the chain answers it as any unknown
 * `/api` path. An oversized body is thrown to the chain's error handler, the same
 * `413` it was.
 */
export const relayWebhookBodyRule: BodyRule = {
  matches: (method, path) => method === 'POST' && WEBHOOK_PATH.test(path),
  parse: bodyParser.raw({ type: '*/*', limit: WEBHOOK_BODY_LIMIT }),
};

/**
 * The webhook receiver, mounted under the Relay routes when an
 * {@link AdapterManager} is available.
 *
 * @param adapterManager - Finds the webhook connection and its running adapter.
 * @returns The routes.
 */
export function createRelayWebhookRoutes(adapterManager: AdapterManager): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/webhooks/:adapterId', async (c) => {
    const adapterInfo = adapterManager.getAdapter(c.req.param('adapterId'));
    if (!adapterInfo || adapterInfo.config.type !== 'webhook') {
      return c.json({ error: 'Webhook adapter not found' }, 404);
    }
    const registry = adapterManager.getRegistry();
    const adapter = registry.get(c.req.param('adapterId'));
    if (!adapter) return c.json({ error: 'Adapter not running' }, 404);
    if (
      !('handleInbound' in adapter) ||
      typeof (adapter as Record<string, unknown>).handleInbound !== 'function'
    ) {
      return c.json({ error: 'Adapter does not support webhook ingestion' }, 500);
    }
    // Raw parsing skips requests without a content type. A cast cannot turn
    // an absent body (or a body consumed by an earlier parser) back into bytes.
    const rawBody = readJsonBody(c);
    if (!Buffer.isBuffer(rawBody)) {
      return c.json({ error: 'Send a request body with a content type.' }, 400);
    }
    const webhookAdapter = adapter as WebhookAdapter;
    const result = await webhookAdapter.handleInbound(
      rawBody,
      c.env.incoming.headers as Record<string, string | string[] | undefined>
    );
    if (result.ok) return c.json({ ok: true }, 200);
    return c.json({ error: result.error }, (result.status ?? 401) as ContentfulStatusCode);
  });

  return router;
}
