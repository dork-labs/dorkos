/**
 * The words an account's notifications are shown in: what a filter asks for,
 * and the one line that says how a notification is doing and what, if
 * anything, the owner can do about it. Pure, so every state is tested here
 * without rendering.
 *
 * @module features/connections/lib/notification-copy
 */
import type { ConnectionEventSubscription } from '@dorkos/shared/connector-event-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';
import type { EventFilterField } from './event-filter-fields';

/** `labelIds` reads "Label ids", `from_address` reads "From address". */
function humanizeKey(key: string): string {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key;
}

function filterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.map((item) => filterValue(item)).join(', ');
  }
  return 'a custom value';
}

/**
 * A notification's filter as a sentence, or null when it has none.
 *
 * Labels come from the app's own field titles when the notification's kind of
 * activity is still listed, and from the field's name otherwise, so a filter
 * never reaches the screen as JSON.
 *
 * @param filter - The stored filter.
 * @param fields - The activity's filter fields, when known.
 */
export function describeEventFilter(
  filter: Record<string, unknown>,
  fields: EventFilterField[] | null = null
): string | null {
  const parts = Object.entries(filter)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = fields?.find((field) => field.name === key)?.label ?? humanizeKey(key);
      return `${label} is ${filterValue(value)}`;
    });
  return parts.length > 0 ? `Only when ${parts.join(' and ')}` : null;
}

/** How a status line reads: plain, or a problem the owner should see. */
export type NotificationStatusTone = 'plain' | 'problem';

/** The one line under a notification, and whether "Open chat" is its fix. */
export interface NotificationStatus {
  text: string;
  tone: NotificationStatusTone;
  /** True when opening the notification's chat is how the owner checks on it. */
  checkInChat: boolean;
}

/**
 * The one line that says how a notification is doing.
 *
 * Every problem line names what happened in plain words and ends with the next
 * step, even when that step is "nothing to do". There is no retry: a failed
 * event's content is deleted, and one that may have arrived can't be resent
 * safely. DorkOS retrying on its own is said as such, never as a problem.
 *
 * @param subscription - The notification.
 * @param destination - Who or where it goes, in words ("Researcher", "#updates").
 * @param cadence - When the app sends this kind of activity, for a notification with nothing yet.
 */
export function notificationStatus(
  subscription: Pick<ConnectionEventSubscription, 'state' | 'lastDelivery' | 'destination'>,
  destination: string,
  cadence: string
): NotificationStatus {
  const plain = (text: string): NotificationStatus => ({ text, tone: 'plain', checkInChat: false });
  const problem = (text: string, checkInChat = false): NotificationStatus => ({
    text,
    tone: 'problem',
    checkInChat,
  });
  switch (subscription.state) {
    case 'pending':
      return plain('Setting up. DorkOS keeps trying on its own.');
    case 'unavailable':
      return problem(
        'Paused while this account can’t be used. Fix the account above to start it again.'
      );
    case 'revoked':
      return problem('Stopped for good. Remove it and set it up again to keep getting these.');
    case 'active':
      break;
  }
  const last = subscription.lastDelivery;
  if (!last) return plain(cadence);
  const when = formatRelativeTime(last.receivedAt);
  switch (last.outcome) {
    case 'delivered':
      return plain(`Last one delivered · ${when}`);
    case 'sending':
      return plain(`Newest one on its way · ${when}`);
    case 'retrying':
      return plain(`Newest one hasn’t reached ${destination} yet. DorkOS is trying again.`);
    case 'failed':
      break;
  }
  const inChat = subscription.destination.kind === 'agent';
  switch (last.problem) {
    case 'unknown_outcome':
      return problem(
        inChat
          ? `DorkOS can’t tell whether ${destination} got the newest one (${when}). Open the chat to check.`
          : `DorkOS can’t tell whether the newest one reached ${destination} (${when}). Look there to check.`,
        inChat
      );
    case 'refused':
      return problem(
        `The newest one (${when}) was turned away by ${destination}. Check that it still lets this agent post there.`
      );
    case 'changed':
      return problem(
        `The newest one (${when}) was held back because this notification changed. Nothing to do: the next one comes as usual.`
      );
    case 'cancelled':
      return problem(
        `The newest one (${when}) was cancelled before ${destination} read it. Nothing to do: the next one comes as usual.`
      );
    case 'expired':
      return problem(
        `The newest one (${when}) waited too long and was dropped. If it keeps happening, remove it and set it up again.`
      );
    case 'unreachable':
    case null:
      return problem(
        `The newest one (${when}) didn’t reach ${destination}. If it keeps happening, remove it and set it up again.`
      );
  }
}

/**
 * The hint on the row that opens an account's notifications: how many of them
 * have a problem line, so a failure is seen without opening every section.
 *
 * @param subscriptions - The account's notifications.
 */
export function notificationProblemHint(
  subscriptions: Array<Pick<ConnectionEventSubscription, 'state' | 'lastDelivery' | 'destination'>>
): string | undefined {
  const count = subscriptions.filter(
    (subscription) => notificationStatus(subscription, '', '').tone === 'problem'
  ).length;
  if (count === 0) return undefined;
  return count === 1 ? '1 notification needs a look' : `${count} notifications need a look`;
}
