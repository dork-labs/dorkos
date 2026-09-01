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
 * **It is also where the escalation clock starts** (DOR-1387). An Ask is the
 * headline case for the ladder — an agent stopped, waiting on a person who may
 * have walked away — and this is the one seam that sees every Ask from every
 * runtime begin. Nothing here cancels: a resolution of any kind runs through
 * `resolveStanding`, which disarms in one place for every standing kind.
 *
 * @module services/notifications/emitters/ask-resolution
 */
import {
  onProjectorInteractionChange,
  type InteractionChange,
} from '../../session/session-state-projector.js';
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import type { NotificationOutcome } from '@dorkos/shared/notification-schemas';
import { resolveStanding } from '../notification-service.js';
import { armEscalation } from '../escalation-service.js';
import type { NotificationPayload } from '../notification-registry.js';
import { sessionLabelFor } from './session-lifecycle.js';

/** What a parked Ask looked like, kept until it resolves. */
interface RememberedAsk {
  sessionId: string;
  sessionLabel: string;
  summary: string;
  /**
   * The Mesh agent rooted at the session's `cwd`, resolved once when the Ask
   * parked. Carried through to the resolution row the same way `sessionLabel`
   * and `summary` are — `InteractionChange`'s `resolved` edge carries no
   * `cwd` of its own, so a re-resolve there has nothing to resolve against.
   */
  agentId?: string;
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

/**
 * The `ask.pending` payload, built the same way on both edges.
 *
 * One builder rather than two literals, because the escalation's subject key and
 * the history row's dedupe key are the same string by construction — and they
 * have to be, or a resolution would fail to disarm the ping it was answering.
 *
 * @param interactionId - The Ask's id.
 * @param remembered - What it looked like when it parked.
 */
function askPayload(
  interactionId: string,
  remembered: RememberedAsk
): NotificationPayload<'ask.pending'> {
  return {
    sessionId: remembered.sessionId,
    interactionId,
    sessionLabel: remembered.sessionLabel,
    summary: remembered.summary,
    ...(remembered.agentId ? { agentId: remembered.agentId } : {}),
  };
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
      const agentId = resolveAgentIdForPath(change.cwd);
      const remembered: RememberedAsk = {
        sessionId: change.sessionId,
        sessionLabel: sessionLabelFor(change.cwd),
        summary: summarize(change),
        ...(agentId ? { agentId } : {}),
      };
      parked.set(change.interaction.id, remembered);
      armEscalation('ask.pending', askPayload(change.interaction.id, remembered));
      return;
    }

    const remembered = parked.get(change.interactionId);
    parked.delete(change.interactionId);

    void resolveStanding(
      'ask.pending',
      askPayload(change.interactionId, {
        sessionId: remembered?.sessionId ?? change.sessionId,
        sessionLabel: remembered?.sessionLabel ?? 'A session',
        // An Ask this process never saw parked — one raised before a restart —
        // still deserves an honest row. It says less, not nothing.
        summary: remembered?.summary ?? 'Asked you something',
        ...(remembered?.agentId ? { agentId: remembered.agentId } : {}),
      }),
      { outcome: OUTCOMES[change.outcome] }
    );
  });
}
