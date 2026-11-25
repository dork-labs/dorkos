/**
 * Notification routes — the operator's inbox: history, read state, and the
 * unread count the bell draws (spec `notification-system`).
 *
 * **Who this answers to.** The list is one person's, so the routes ask
 * `notificationEntitlement` and nothing else decides. A machine calling in with
 * an agent token reads an EMPTY list rather than a refusal — the rooms domain's
 * own rule, where "not a member" answers exactly as "no such room", so a
 * response never tells an agent that notifications about it exist. Marking
 * something read is a claim only a person looking at a screen can make, so the
 * mutations refuse outright instead of quietly doing nothing.
 *
 * @module routes/notifications
 */
import { Hono } from 'hono';
import { ListNotificationsQuerySchema } from '@dorkos/shared/notification-schemas';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import type { NotificationService } from '../services/notifications/notification-service.js';
import { problem, validationProblem } from '@dorkos/http-kit';

/** What a caller that may not mark notifications read is told. */
const NOT_THE_OPERATOR = 'Only the person a notification was for can mark it read, in DorkOS.';

/**
 * The `/api/notifications` routes.
 *
 * @param service - The notification pipeline, for reads and read state.
 * @returns The routes, for `app.route('/api/notifications', …)`.
 */
export function createNotificationsRoutes(service: NotificationService): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const query = ListNotificationsQuerySchema.safeParse(readQuery(c));
    if (!query.success) return validationProblem(c, query.error);

    // An unentitled caller gets `200` with an empty list, never `403`: the
    // response must not tell a machine what it is not allowed to read about.
    if (notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) === 'none') {
      return c.json({ notifications: [], nextCursor: null, unreadCount: 0 });
    }

    return c.json(service.list(query.data));
  });

  router.patch('/:id/read', (c) => {
    if (notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'manage') {
      return problem(c, 'operator_only', { detail: NOT_THE_OPERATOR });
    }
    return c.json(service.markRead(c.req.param('id')));
  });

  router.post('/read-all', (c) => {
    if (notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'manage') {
      return problem(c, 'operator_only', { detail: NOT_THE_OPERATOR });
    }
    return c.json(service.markAllRead());
  });

  return router;
}
