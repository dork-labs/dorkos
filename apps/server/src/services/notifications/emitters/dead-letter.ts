/**
 * Turns a Relay dead-letter arrival into the `dead-letter.created` payload.
 *
 * A dead letter names its ADDRESSEE (`endpointHash`, an unreadable hash — see
 * the registry entry's own TSDoc for why that stays off the payload) but the
 * notification wants the SENDER: whichever agent's message never arrived is
 * the one story a person can act on, the same way `dm.received` files under
 * whoever sent it rather than whoever received it. `DeadLetterNotice.fromSubject`
 * already carries the rejected envelope's own `from`, verbatim — this only
 * decides whether that subject genuinely names a Mesh agent, or is honestly
 * left unstamped: the scheduler, the console, and a runtime-scoped session
 * subject are none of them an agent to credit, and the closed
 * `parseAgentSubject` grammar (rather than a hand-rolled string check) is
 * what tells them apart from one without guessing — a shape heuristic here is
 * exactly the class of bug DOR-1337 was.
 *
 * @module services/notifications/emitters/dead-letter
 */
import { parseAgentSubject, type DeadLetterNotice } from '@dorkos/relay';
import type { NotificationPayload } from '../notification-registry.js';

/**
 * The Mesh agent id behind a dead letter's sender, or `undefined` when the
 * sender is not one — a scheduler, the console, or a runtime-scoped session
 * subject, none of which name a registered agent.
 *
 * @param fromSubject - The rejected envelope's own `from`, verbatim.
 */
export function deadLetterAgentId(fromSubject: string): string | undefined {
  const parsed = parseAgentSubject(fromSubject);
  return parsed?.format === 'agent-scoped' ? parsed.sessionId : undefined;
}

/**
 * Build the `dead-letter.created` payload for one arrival notice.
 *
 * @param notice - The arrival notice `DeadLetterQueue.reject` raised.
 */
export function deadLetterPayload(
  notice: DeadLetterNotice
): NotificationPayload<'dead-letter.created'> {
  const agentId = deadLetterAgentId(notice.fromSubject);
  return {
    deadLetterId: notice.messageId,
    reason: notice.reason,
    ...(agentId ? { agentId } : {}),
  };
}
