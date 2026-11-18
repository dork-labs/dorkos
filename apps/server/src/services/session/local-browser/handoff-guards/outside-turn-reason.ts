/**
 * Which mark makes a chat's turn an outsider's for the browser handoff (DOR-4693), and what the
 * agent hears when the handoff is refused for it. A page the agent read is told from a turn a
 * stranger started, so the handoff can let the first through for a page DorkOS saw refuse.
 *
 * @module services/session/local-browser/handoff-guards/outside-turn-reason
 */
import { LocalBrowserError } from '../errors.js';

/** Which mark made a turn an outsider's. */
export type OutsideTurnReason =
  'stranger_chat' | 'room_outside_words' | 'outsider_turn' | 'read_outside_text';

/** Which mark, if any, a chat's current turn carries: the handoff's check, wired at startup. */
export type OutsideTurnCheck = (sessionId: string) => Promise<OutsideTurnReason | null>;

/** What the agent hears when a handoff is refused for a mark, so it can tell the person why. */
const OUTSIDE_TURN_REFUSALS: Record<OutsideTurnReason, string> = {
  stranger_chat:
    'Someone outside your team started this chat, so it can’t hand the browser to a person.',
  room_outside_words:
    'This turn holds words from outside your team, so it can’t hand the browser to a person. Ask the person in a direct chat with you.',
  outsider_turn:
    'This turn started from outside your team, so it can’t hand the browser to a person.',
  read_outside_text:
    'This turn read outside text, and the page isn’t one DorkOS saw refuse the browser, so it can’t hand it to a person.',
};

/**
 * The handoff's refusal for a mark, naming it in `fields.reason`.
 *
 * @param reason - The mark the turn carries.
 */
export function outsideTurnRefusal(reason: OutsideTurnReason): LocalBrowserError {
  return new LocalBrowserError('outside_turn', OUTSIDE_TURN_REFUSALS[reason], { reason });
}
