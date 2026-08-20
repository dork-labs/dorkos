/**
 * Who may see notifications, and who may act on them.
 *
 * The notification domain answers to one person: the operator. Everything in it
 * is about what THEIR agents are doing and what is waiting on THEM, so the
 * shape of the answer follows the Ask discipline (`asks/ask-entitlement.ts`)
 * rather than being invented again here.
 *
 * @module services/notifications/notification-entitlement
 */
import type { CallerPrincipal } from '../../lib/caller-principal.js';
import type { BroadcastAudience } from '../core/event-fan-out.js';

/**
 * What a caller may do with the notification list.
 *
 * `manage` — see it and mark it read. `see` — read it, but read state is not
 * theirs to move. `none` — the list does not exist for this caller.
 */
export type NotificationEntitlement = 'manage' | 'see' | 'none';

/**
 * What this caller may do with notifications.
 *
 * The three answers mirror `askEntitlement`, for the same reasons and with the
 * same consequence for a machine: **an agent gets `none`.** A notification says
 * what an agent is doing and what is waiting on a person, which is exactly the
 * detail an agent asking the server about itself has no business reading.
 *
 * A `program` — somebody's own API key, driving DorkOS from a script — may READ
 * the history, because it is acting as that person and the list is theirs. It
 * may not move read state: "I have seen this" is a claim only a person looking
 * at a screen can make honestly, and a script clearing the bell would hide
 * something nobody looked at.
 *
 * A `bridged` caller — somebody pressing a button in Telegram — gets `none`.
 * They are entitled to the ONE Ask that was addressed to them (which
 * `askEntitlement` decides, unchanged), never to the operator's whole inbox.
 *
 * @param principal - Who is calling, as `readCallerPrincipal` resolved them.
 */
export function notificationEntitlement(principal: CallerPrincipal): NotificationEntitlement {
  switch (principal.kind) {
    case 'agent':
      return 'none';
    case 'operator':
      return 'manage';
    case 'program':
      return 'see';
    case 'bridged':
      return 'none';
  }
}

/**
 * The SSE audience for notification events: anyone entitled to read them.
 *
 * Passed as the third argument to `eventFanOut.broadcast`, which is what keeps
 * an agent principal's connection from receiving detail the routes would refuse
 * it anyway. The two have to agree, and a conformance test pins that they do.
 */
export const operatorAudience: BroadcastAudience = (principal) =>
  notificationEntitlement(principal) !== 'none';
