/**
 * Turns the end of an Ask into the one history row it leaves behind.
 *
 * An Ask is a standing condition: while an agent is parked on it, the
 * interaction store is the truth and every attention surface already derives
 * from it. Nothing is written then. What the history is missing is only how it
 * ENDED — and specifically, that some of them end because nobody answered.
 * Before this, an Ask that ran out its four-hour park ceiling simply vanished.
 * Now it leaves a row that says `expired`.
 *
 * The projector's `resolved` change carries an id and an outcome, and nothing a
 * person could read: the summary and the session it belonged to are dropped when
 * the card retires. So this remembers those two things from the `pending` change
 * and reads them back at resolution. The map holds only Asks currently parked,
 * which is single digits in practice.
 *
 * @module services/notifications/emitters/ask-resolution
 */
import {
  onProjectorInteractionChange,
  type InteractionChange,
} from '../../session/session-state-projector.js';
import type { NotificationOutcome } from '@dorkos/shared/notification-schemas';
import { resolveStanding } from '../notification-service.js';
import { sessionLabelFor } from './session-lifecycle.js';

/** What a parked Ask looked like, kept until it resolves. */
interface RememberedAsk {
  sessionId: string;
  sessionLabel: string;
  summary: string;
}

/**
 * One line saying what an Ask wants.
 *
 * Deliberately the tool or the question and nothing else — never the tool INPUT,
 * which is the command line an agent proposed to run. A notification title can
 * end up on a phone lock screen, and that is not where a shell command belongs.
 *
 * @param interaction - The pending interaction, as the projector fanned it out.
 */
function summarize(interaction: InteractionChange & { type: 'pending' }): string {
  const ask = interaction.interaction;
  if (ask.type === 'approval') {
    return ask.displayName ?? ask.title ?? `Wants to run ${ask.toolName}`;
  }
  return 'Asked you a question';
}

/** How the projector's outcome reads in the notification vocabulary. */
const OUTCOMES: Record<'answered' | 'cancelled' | 'expired', NotificationOutcome> = {
  answered: 'answered',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * Watch Asks and record how each one ended.
 *
 * @returns An unsubscribe function.
 */
export function watchAskResolution(): () => void {
  const parked = new Map<string, RememberedAsk>();

  return onProjectorInteractionChange((change) => {
    if (change.type === 'pending') {
      parked.set(change.interaction.id, {
        sessionId: change.sessionId,
        sessionLabel: sessionLabelFor(change.cwd),
        summary: summarize(change),
      });
      return;
    }

    const remembered = parked.get(change.interactionId);
    parked.delete(change.interactionId);

    void resolveStanding(
      'ask.pending',
      {
        sessionId: remembered?.sessionId ?? change.sessionId,
        interactionId: change.interactionId,
        sessionLabel: remembered?.sessionLabel ?? 'A session',
        // An Ask this process never saw parked — one raised before a restart —
        // still deserves an honest row. It says less, not nothing.
        summary: remembered?.summary ?? 'Asked you something',
      },
      { outcome: OUTCOMES[change.outcome] }
    );
  });
}
