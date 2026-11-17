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
 * @module services/core/turn-power/chat-outside-words
 */
import { runtimeRegistry } from '../runtime-registry.js';
import { roomTurnReadOutsideWords } from './outside-words.js';
import { marksOf } from './turn-levels.js';

/** Launch origins whose every turn is a stranger's: a bridged Telegram or Slack chat, an outside agent, a connected app's event. */
const OUTSIDE_LAUNCH_ORIGINS: ReadonlySet<string> = new Set([
  'relay-binding',
  'outside-sender',
  'connector-event',
]);

/**
 * Whether a chat's words, sent on now, carry outside words with them.
 *
 * @param sessionId - The sending chat, from the verified caller; none reads as clean.
 * @param agentPath - The sending agent's home, from its verified identity.
 */
export function chatReadOutsideWords(
  sessionId: string | null | undefined,
  agentPath?: string
): boolean {
  if (!sessionId) return false;
  if (marksOf(sessionId, agentPath).outsider === true) return true;
  if (roomTurnReadOutsideWords(sessionId)) return true;
  try {
    return OUTSIDE_LAUNCH_ORIGINS.has(runtimeRegistry.getSessionLaunchOrigin(sessionId) ?? '');
  } catch {
    // No database (early boot): nothing stored to read, as memory and the browser read it.
    return false;
  }
}
