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
import { Hono, type Context } from 'hono';
import { RegisterPushSubscriptionRequestSchema } from '@dorkos/shared/notification-schemas';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
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

/** What the push routes need. */
export interface PushRouterDeps {
  /** The subscription rows. */
  subscriptions: PushSubscriptionStore;
  /** The channel, for the VAPID public key a browser needs to subscribe. */
  channel: WebPushChannel;
}

/** The refusal for a caller that is not the operator, or `undefined` for the operator. */
function refusedNonOperator(c: Context<ApiEnv>): Response | undefined {
  if (notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) === 'manage') {
    return undefined;
  }
  return c.json(errorBody(NOT_THE_OPERATOR, NOT_THE_OPERATOR_CODE), 403);
}

/**
 * The `/api/push` routes.
 *
 * @param deps - The subscription store and the push channel.
 * @returns The routes, for `app.route('/api/push', …)`.
 */
export function createPushRoutes(deps: PushRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/vapid-public-key', (c) => {
    const refused = refusedNonOperator(c);
    if (refused) return refused;
    // Generating the keypair is a side effect of the first read, which is what
    // keeps push free on an install nobody ever subscribes from.
    return c.json({ key: deps.channel.publicKey() });
  });

  router.get('/subscriptions', (c) => {
    const refused = refusedNonOperator(c);
    if (refused) return refused;
    return c.json({ subscriptions: deps.subscriptions.list() });
  });

  router.post('/subscriptions', (c) => {
    const refused = refusedNonOperator(c);
    if (refused) return refused;
    const body = RegisterPushSubscriptionRequestSchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);

    const stored = deps.subscriptions.upsert({
      endpoint: body.data.endpoint,
      keys: body.data.keys,
    });
    // 200 rather than 201 on purpose: the client calls this on every load to
    // refresh a subscription the browser may have rotated, so "created" would be
    // a lie most of the time and the two cases are not worth distinguishing.
    return c.json({ ok: true, subscription: pushSubscriptionDto(stored) });
  });

  router.delete('/subscriptions/:id', (c) => {
    const refused = refusedNonOperator(c);
    if (refused) return refused;
    // No 404 for an id that is not there: "stop pushing to this device" is
    // already true of a device that has no row, and the client's own list can be
    // a moment out of date on a second window.
    return c.json({ ok: true, removed: deps.subscriptions.remove(c.req.param('id')) });
  });

  return router;
}
