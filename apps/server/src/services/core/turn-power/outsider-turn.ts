/**
 * Whether a turn is held as one that read words from outside the team, for the gates that keep
 * an outsider's words from reaching people or doing what cannot be undone (DOR-4587): the
 * permission gate (sends, the held actions, permission raises), the destructive cancel window,
 * and the access-grant gate.
 *
 * Two records answer it. The outsider mark rides the turn's level (a Wi-Fi hold, a carried mark,
 * a stranger on a bridged chat, a mini app's post a room turn read). The outside-words note is set
 * on the turn without a mark: a room turn that answered an agent's post relaying outside words,
 * or a chat another chat's words reached after that chat read some (`outside-words.ts`). The note
 * lowers nothing, but these gates hold what the mark holds. Reading the mark alone let a turn
 * woken by a mini app's reply send mail at Full with no card.
 *
 * Unlike `chatReadOutsideWords`, it never reads the launch origin: a chat the owner's own linked
 * Telegram or Slack account started is the owner's, and must not ask before every send.
 *
 * Read from what the server keeps, never from the model.
 *
 * @module services/core/turn-power/outsider-turn
 */
import { roomTurnReadOutsideWords } from './outside-words.js';
import { marksOf } from './turn-levels.js';

/**
 * Whether the turn read words from outside the team: its outsider mark, or the outside-words
 * note on the chat's latest room turn.
 *
 * @param sessionId - The calling chat, from the verified caller; none reads its agent's running marks.
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function turnReadOutsideWords(
  sessionId: string | null | undefined,
  agentPath: string | undefined
): boolean {
  if (marksOf(sessionId, agentPath).outsider === true) return true;
  return typeof sessionId === 'string' && sessionId !== '' && roomTurnReadOutsideWords(sessionId);
}
