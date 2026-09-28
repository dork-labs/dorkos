/** Where a notification's events go (its one chat) and how the newest one went, for its owner. */
import type { Db } from '@dorkos/db';
import type {
  ConnectionEventDeliveryProblem,
  ConnectionEventLastDelivery,
} from '@dorkos/shared/connector-event-schemas';

/**
 * The owner-facing reason behind one inbox failure code. Codes are written by
 * the inbox, the delivery worker and the private-session source adapter; any
 * code this does not name is the destination not being reachable.
 */
function deliveryProblem(failureCode: string | null): ConnectionEventDeliveryProblem {
  switch (failureCode) {
    case 'dispatch_outcome_unknown':
      return 'unknown_outcome';
    case 'dispatch_cancelled':
      return 'cancelled';
    case 'event_authority_changed':
      return 'changed';
    case 'event_destination_refused':
      return 'refused';
    default:
      return 'unreachable';
  }
}

/**
 * What happened to the newest event one notification received, in the few
 * outcomes an owner can act on, or null before its first event. Payload-free:
 * it reads only inbox state, never content.
 *
 * @param db - The DorkOS database.
 * @param subscriptionId - The notification.
 */
export function readLastDelivery(
  db: Db,
  subscriptionId: string
): ConnectionEventLastDelivery | null {
  const row = db.$client
    .prepare(
      `SELECT state, failure_code, received_at FROM connector_event_inbox
      WHERE subscription_id = ? ORDER BY received_at DESC, id DESC LIMIT 1`
    )
    .get(subscriptionId) as
    { state: string; failure_code: string | null; received_at: string } | undefined;
  if (!row) return null;
  const receivedAt = row.received_at;
  if (row.state === 'completed') return { outcome: 'delivered', receivedAt, problem: null };
  if (row.state === 'expired') return { outcome: 'failed', receivedAt, problem: 'expired' };
  const problem = deliveryProblem(row.failure_code);
  if (row.state === 'failed') return { outcome: 'failed', receivedAt, problem };
  // A received row with a failure on it is waiting out a backoff before its
  // next attempt; any other live state is simply on its way.
  if (row.state === 'received' && row.failure_code)
    return { outcome: 'retrying', receivedAt, problem };
  return { outcome: 'sending', receivedAt, problem: null };
}

/**
 * The chat an agent-bound notification last posted into, if it has one.
 *
 * @param db - The DorkOS database.
 * @param subscriptionId - The notification.
 */
export function readChatSession(db: Db, subscriptionId: string): string | undefined {
  const row = db.$client
    .prepare('SELECT session_id FROM connector_event_subscriptions WHERE id = ?')
    .get(subscriptionId) as { session_id: string | null } | undefined;
  return row?.session_id ?? undefined;
}

/**
 * Remember the one chat a notification posts into, so its next event joins it.
 *
 * @param db - The DorkOS database.
 * @param subscriptionId - The notification.
 * @param sessionId - The chat it now posts into.
 */
export function keepChatSession(db: Db, subscriptionId: string, sessionId: string): void {
  db.$client
    .prepare('UPDATE connector_event_subscriptions SET session_id = ? WHERE id = ?')
    .run(sessionId, subscriptionId);
}
