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
 * **Reachable over a tunnel, on purpose (Security's ruling, DOR-3650)**, on
 * four conditions pinned by `__tests__/relay-signed-json.test.ts`: the HMAC,
 * timestamp window and nonce are checked before anything is published, and
 * every refusal before that is one flat 401; the route matches exactly; the
 * caller never counts as the person, whatever cookie it carries; and what it
 * publishes goes out as `relay.webhook.<id>`, which never starts a turn and,
 * if one ever did, is outside sender shaping (`turn-shaping-sender.ts`).
 *
 * @module routes/relay-webhooks
 */
import bodyParser from 'body-parser';
import { Hono } from 'hono';
import type { WebhookAdapter } from '@dorkos/relay';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, type BodyRule } from '@dorkos/http-kit';
import type { AdapterManager } from '../services/relay/adapter-manager.js';

/**
 * The one sentence for any request whose signature was not verified
 * (DOR-3650): the same for every check, so it says nothing about which failed.
 */
const INVALID_SIGNATURE = 'The signature, time or nonce didn’t check out.';

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
    // The caller is an outside service, never the person, whatever cookie it
    // carries (DOR-3650, Security's condition 3): nothing after this reads one.
    c.set('user', undefined);
    c.set('agentIdentity', undefined);
    // Every refusal before a verified signature is the same flat 401, so an
    // unsigned caller learns nothing: not which connections exist or run, nor
    // which check failed (Security's condition 1).
    const refused = () => problem(c, 'invalid_signature', { detail: INVALID_SIGNATURE });
    const adapterInfo = adapterManager.getAdapter(c.req.param('adapterId'));
    if (!adapterInfo || adapterInfo.config.type !== 'webhook') return refused();
    const registry = adapterManager.getRegistry();
    const adapter = registry.get(c.req.param('adapterId'));
    if (
      !adapter ||
      !('handleInbound' in adapter) ||
      typeof (adapter as Record<string, unknown>).handleInbound !== 'function'
    ) {
      return refused();
    }
    // Raw parsing skips requests without a content type. A cast cannot turn
    // an absent body (or a body consumed by an earlier parser) back into bytes.
    const rawBody = readJsonBody(c);
    if (!Buffer.isBuffer(rawBody)) {
      return problem(c, 'malformed_request', {
        detail: 'Send a request body with a content type.',
      });
    }
    const webhookAdapter = adapter as WebhookAdapter;
    const result = await webhookAdapter.handleInbound(
      rawBody,
      c.env.incoming.headers as Record<string, string | string[] | undefined>
    );
    if (result.ok) return c.json({ ok: true }, 200);
    // After the request checked out, a delivery that failed says so, so the
    // sender tries again; its own words stay in the adapter's log.
    if (result.status === 422) {
      return problem(c, 'malformed_request', { detail: 'The request’s body isn’t JSON.' });
    }
    if (result.status === 503) {
      return problem(c, 'temporarily_unavailable', {
        detail: 'DorkOS couldn’t take this request now. Send it again later.',
      });
    }
    if (result.status === 500) {
      return problem(c, 'internal_error', { detail: 'DorkOS couldn’t deliver this request.' });
    }
    // Every other refusal is the flat 401: a signature, timestamp or nonce, and
    // the 403 for an address DorkOS keeps, which is checked before the
    // signature and so must tell an unsigned caller nothing about settings.
    return refused();
  });

  return router;
}
