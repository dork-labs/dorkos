/**
 * Wake the agent when a person hands the browser back (DOR-3112).
 *
 * The agent ended its turn to wait when it asked a person for the browser, so
 * nothing starts it again but a message in its chat. The server sends that
 * message itself, once per handoff, whichever way the person handed it back.
 * The card used to send it, which left the agent asleep whenever that send
 * failed or the person resumed the browser some other way.
 */
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
} from '../../launch/launch-session.js';

/**
 * The one message the agent gets after a hand back. Fixed text, with nothing from
 * the page in it: the agent reads the page through its own tools.
 */
export const HANDED_BACK_MESSAGE = 'I’m done in the browser. Please continue.';

/** The client id the wake is sent under, so it never takes a person's tab's write lock. */
export const HAND_BACK_CLIENT_ID = 'local-browser-hand-back';

/** What the wake needs, read when a handoff ends rather than at startup. */
export interface HandBackWakeDeps {
  /** Mesh, when it is running. */
  meshCore: () => DispatchSessionMessageOpts['meshCore'];
  /** The room binding port, so a room's chat resumes in the room's folder. */
  roomSessionPlace: () => DispatchSessionMessageOpts['roomSessionPlace'];
}

/**
 * A handoff-end listener that sends the handed-back message into the handoff's chat.
 * Stop and a closed window send nothing. A busy chat queues the message like any other.
 *
 * @param deps - Mesh and the room port, read at hand-back time.
 */
export function handBackWake(deps: HandBackWakeDeps): (handoff: LocalBrowserHandoff) => void {
  const warn = (handoff: LocalBrowserHandoff, detail: Record<string, string>) =>
    logger.warn('[Browser] Couldn’t wake the agent after a hand back', {
      handoffId: handoff.id,
      ...detail,
    });
  return (handoff) => {
    if (handoff.outcome !== 'handed-back') return;
    void dispatchSessionMessage({
      // Only a person can hand back (both routes are person-only), so this is their
      // message, sent to the chat they were helping.
      origin: { kind: 'interactive' },
      sessionId: handoff.sessionId,
      request: { content: HANDED_BACK_MESSAGE },
      clientId: HAND_BACK_CLIENT_ID,
      meshCore: deps.meshCore(),
      roomSessionPlace: deps.roomSessionPlace(),
    })
      .then((result) => {
        if (isSessionLaunchRefusal(result)) warn(handoff, { refused: result.refused });
      })
      .catch((error: unknown) =>
        warn(handoff, { error: error instanceof Error ? error.message : String(error) })
      );
  };
}
