/**
 * Web push routes — how a browser says "reach me here" (spec
 * `notification-system` task 4.3, ADR 260819-234829).
 *
 * **Every route here is the operator's, including the reads.** That is stricter
 * than the Inbox next door, which lets an API key READ history: a subscription
 * is a capability to make somebody's phone buzz, and "which devices can be made
 * to buzz" is not a question a machine has any business asking. So an agent, a
 * bridged caller and a program all get the same refusal, and no response ever
 * carries an endpoint.
 *
 * @module routes/push
 */
import { Router, type Request, type Response } from 'express';
import { RegisterPushSubscriptionRequestSchema } from '@dorkos/shared/notification-schemas';
import { parseBody, sendError } from '../lib/route-utils.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import {
  pushSubscriptionDto,
  type PushSubscriptionStore,
} from '../services/notifications/push-subscription-store.js';
import type { WebPushChannel } from '../services/notifications/channels/web-push.js';

/** Refusal code for a caller that may not touch this install's push devices. */
const NOT_THE_OPERATOR_CODE = 'PUSH_OPERATOR_ONLY';

/** What a caller that may not touch push devices is told. */
const NOT_THE_OPERATOR =
  'Deciding which devices DorkOS may reach is something only you can do, from inside DorkOS.';

/** What the push router needs. */
export interface PushRouterDeps {
  /** The subscription rows. */
  subscriptions: PushSubscriptionStore;
  /** The channel, for the VAPID public key a browser needs to subscribe. */
  channel: WebPushChannel;
}

/**
 * Create the web push router.
 *
 * @param deps - The subscription store and the push channel.
 */
export function createPushRouter(deps: PushRouterDeps): Router {
  const router = Router();

  /** Whether this caller is the operator; sends the refusal itself when not. */
  function refusedNonOperator(req: Request, res: Response): boolean {
    if (notificationEntitlement(readCallerPrincipal(req, res)) === 'manage') return false;
    sendError(res, 403, NOT_THE_OPERATOR, NOT_THE_OPERATOR_CODE);
    return true;
  }

  router.get('/vapid-public-key', (req, res) => {
    if (refusedNonOperator(req, res)) return;
    // Generating the keypair is a side effect of the first read, which is what
    // keeps push free on an install nobody ever subscribes from.
    return res.json({ key: deps.channel.publicKey() });
  });

  router.get('/subscriptions', (req, res) => {
    if (refusedNonOperator(req, res)) return;
    return res.json({ subscriptions: deps.subscriptions.list() });
  });

  router.post('/subscriptions', (req, res) => {
    if (refusedNonOperator(req, res)) return;
    const body = parseBody(RegisterPushSubscriptionRequestSchema, req.body, res);
    if (!body) return;

    const stored = deps.subscriptions.upsert({ endpoint: body.endpoint, keys: body.keys });
    // 200 rather than 201 on purpose: the client calls this on every load to
    // refresh a subscription the browser may have rotated, so "created" would be
    // a lie most of the time and the two cases are not worth distinguishing.
    return res.json({ ok: true, subscription: pushSubscriptionDto(stored) });
  });

  router.delete('/subscriptions/:id', (req, res) => {
    if (refusedNonOperator(req, res)) return;
    // No 404 for an id that is not there: "stop pushing to this device" is
    // already true of a device that has no row, and the client's own list can be
    // a moment out of date on a second window.
    return res.json({ ok: true, removed: deps.subscriptions.remove(req.params.id) });
  });

  return router;
}
