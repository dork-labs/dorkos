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
import { Router } from 'express';
import { ListNotificationsQuerySchema } from '@dorkos/shared/notification-schemas';
import { parseBody, sendError } from '../lib/route-utils.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import type { NotificationService } from '../services/notifications/notification-service.js';

/** Refusal code for a caller that may not move read state. */
const NOT_THE_OPERATOR_CODE = 'NOTIFICATIONS_OPERATOR_ONLY';

/** What a caller that may not mark notifications read is told. */
const NOT_THE_OPERATOR =
  'Marking a notification read has to happen inside DorkOS, by the person it was for.';

/**
 * Create the notifications router.
 *
 * @param service - The notification pipeline, for reads and read state.
 */
export function createNotificationsRouter(service: NotificationService): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const query = parseBody(ListNotificationsQuerySchema, req.query, res);
    if (!query) return;

    // An unentitled caller gets `200` with an empty list, never `403`: the
    // response must not tell a machine what it is not allowed to read about.
    if (notificationEntitlement(readCallerPrincipal(req, res)) === 'none') {
      return res.json({ notifications: [], nextCursor: null, unreadCount: 0 });
    }

    return res.json(service.list(query));
  });

  router.patch('/:id/read', (req, res) => {
    if (notificationEntitlement(readCallerPrincipal(req, res)) !== 'manage') {
      return sendError(res, 403, NOT_THE_OPERATOR, NOT_THE_OPERATOR_CODE);
    }
    return res.json(service.markRead(req.params.id));
  });

  router.post('/read-all', (req, res) => {
    if (notificationEntitlement(readCallerPrincipal(req, res)) !== 'manage') {
      return sendError(res, 403, NOT_THE_OPERATOR, NOT_THE_OPERATOR_CODE);
    }
    return res.json(service.markAllRead());
  });

  return router;
}
