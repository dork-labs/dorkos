/**
 * Wake the agent when a person hands the browser back (DOR-3112).
 *
 * The agent ended its turn to wait when it asked a person for the browser, so
 * nothing starts it again but a message in its chat. The server sends that
 * message itself, once per handoff, whichever way the person handed it back.
 * The card used to send it, which left the agent asleep whenever that send
 * failed or the person resumed the browser some other way.
 *
 * The message is a wake (spec `turns-survive-restarts` §6.3, T7), keyed by the
 * hand-off's own id and saved the moment the hand-off ends, so a restart before
 * the turn starts loses nothing and a second end of one hand-off sends nothing
 * more. Startup hands the wake's door in: this code is turn code, which never
 * imports the run record (§3.4).
 */
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import type { WakeRequest } from '@dorkos/shared/turn-port';
import { logger } from '../../../../lib/logger.js';

/**
 * The one message the agent gets after a hand back. Fixed text, with nothing from
 * the page in it: the agent reads the page through its own tools.
 */
export const HANDED_BACK_MESSAGE = 'I’m done in the browser. Please continue.';

/** What the wake needs. */
export interface HandBackWakeDeps {
  /** Saves one event's wake (the run record's `wakeChat`). */
  wake: (request: WakeRequest) => boolean;
}

/**
 * A handoff-end listener that wakes the handoff's chat with the handed-back message.
 * Stop and a closed window send nothing. A busy chat queues the message like any other.
 *
 * @param deps - The wake's door.
 */
export function handBackWake(deps: HandBackWakeDeps): (handoff: LocalBrowserHandoff) => void {
  return (handoff) => {
    if (handoff.outcome !== 'handed-back') return;
    try {
      deps.wake({
        sourceKind: 'hand-back',
        eventId: handoff.id,
        start: {
          sessionId: handoff.sessionId,
          content: HANDED_BACK_MESSAGE,
          // Only a person can hand back (both routes are person-only), so this is their
          // message, sent to the chat they were helping.
          origin: { kind: 'interactive' },
          tier: 'owner',
        },
      });
    } catch (error) {
      logger.warn('[Browser] Couldn’t wake the agent after a hand back', {
        handoffId: handoff.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
