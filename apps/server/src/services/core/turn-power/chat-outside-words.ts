/**
 * Whether a chat has read words from outside the team, as the words it sends on carry them
 * (DOR-4029). Marks spread through agent hops: a chat that read a stranger's words and then sends
 * a chat message, starts a chat or posts in a room hands those words on, and the turn they wake
 * is noted as one that read outside words (`noteRoomTurnWords`). Memory, the browser and the
 * narrowing gate read that one note.
 *
 * Read from what the server keeps, never from the model: the turn's own mark (a Wi-Fi hold), the
 * outside-words note on its latest turn, and a launch origin whose every turn is a stranger's.
 *
 * A bridged Telegram or Slack chat is the one origin that can be the owner's own (DOR-4593). With
 * stranger marking on, a bridged turn is marked unless its sender is on the connection's approver
 * list in a one-to-one chat (`wordsAreUntrusted`), and the chat keeps whose words it holds
 * (`bridgedSenderVouched`): vouched only while every bridged turn on it was a vouched sender's, and
 * a stranger's for good once any turn on it was marked or ran with marking off. So the owner's own
 * linked chat hands on clean words, while a group's, an unlisted sender's, and any chat not known
 * to be vouched still count, whatever turns ran on it since. With marking off nothing tells them
 * apart, so every bridged chat counts.
 *
 * @module services/core/turn-power/chat-outside-words
 */
import { env } from '../../../env.js';
import { runtimeRegistry } from '../runtime-registry.js';
import { bridgedSenderVouched, chatHeldStrangerWords, lastTurnHeld } from './continuation-hold.js';
import { chatEverReadOutsideText } from './live-outsider-turns.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { roomTurnReadOutsideWords } from './outside-words.js';
import { marksOf } from './turn-levels.js';

/** Launch origins whose every turn is a stranger's: an outside agent, a connected app's event. */
const OUTSIDE_LAUNCH_ORIGINS: ReadonlySet<string> = new Set(['outside-sender', 'connector-event']);

/** A bridged Telegram or Slack chat: a stranger's unless its turns say it is the owner's. */
const BRIDGED_LAUNCH_ORIGIN = 'relay-binding';

/**
 * Whether a chat's words, sent on now, carry outside words with them.
 *
 * @param sessionId - The sending chat, from the verified caller; none reads as clean.
 * @param agentPath - The sending agent's home, from its verified identity.
 * @param markStrangerTurns - DOR-3858's boot flag; this boot's value by default.
 */
export function chatReadOutsideWords(
  sessionId: string | null | undefined,
  agentPath?: string,
  markStrangerTurns = env.DORKOS_MARK_STRANGER_TURNS
): boolean {
  if (!sessionId) return false;
  if (marksOf(sessionId, agentPath).outsider === true) return true;
  if (roomTurnReadOutsideWords(sessionId)) return true;
  try {
    const origin = runtimeRegistry.getSessionLaunchOrigin(sessionId) ?? '';
    if (origin === BRIDGED_LAUNCH_ORIGIN)
      return !markStrangerTurns || !bridgedSenderVouched(sessionId);
    return OUTSIDE_LAUNCH_ORIGINS.has(origin);
  } catch {
    // No database (early boot): nothing stored to read, as memory and the browser read it.
    return false;
  }
}

/**
 * Whether a chat's messages may hold words from outside the team (DOR-3969): the chat reads them
 * by its own record (`chatReadOutsideWords`: its running turn's mark, its latest room turn, a
 * stranger's launch origin), a stranger ever spoke on its bridge, a read in any of its turns handed
 * it outside text, or its latest turn was held.
 *
 * @param chatId - The chat read.
 */
export function chatHoldsOutsideText(chatId: string): boolean {
  return (
    chatReadOutsideWords(chatId) ||
    chatHeldStrangerWords(chatId) ||
    chatEverReadOutsideText(primaryOf(chatId)) ||
    lastTurnHeld(chatId)
  );
}
