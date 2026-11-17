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
 * A bridged Telegram or Slack chat counts by its origin only while stranger marking is off
 * (DOR-4587). While it is on, the bridge marks every turn a non-owner's message starts, so a
 * bridged chat with no mark is the owner's own linked account: trust follows who wrote, not the
 * app that carried it.
 *
 * @module services/core/turn-power/chat-outside-words
 */
import { env } from '../../../env.js';
import { runtimeRegistry } from '../runtime-registry.js';
import { roomTurnReadOutsideWords } from './outside-words.js';
import { marksOf } from './turn-levels.js';

/** Launch origins whose every turn is a stranger's: an outside agent, a connected app's event. */
const OUTSIDE_LAUNCH_ORIGINS: ReadonlySet<string> = new Set(['outside-sender', 'connector-event']);

/** A bridged Telegram or Slack chat: a stranger's only when the bridge does not mark strangers. */
const BRIDGED_LAUNCH_ORIGIN = 'relay-binding';

/**
 * Whether a chat's words, sent on now, carry outside words with them.
 *
 * @param sessionId - The sending chat, from the verified caller; none reads as clean.
 * @param agentPath - The sending agent's home, from its verified identity.
 * @param markStrangerTurns - Whether the bridge marks a non-owner's turns (`DORKOS_MARK_STRANGER_TURNS`).
 */
export function chatReadOutsideWords(
  sessionId: string | null | undefined,
  agentPath?: string,
  markStrangerTurns: boolean = env.DORKOS_MARK_STRANGER_TURNS
): boolean {
  if (!sessionId) return false;
  if (marksOf(sessionId, agentPath).outsider === true) return true;
  if (roomTurnReadOutsideWords(sessionId)) return true;
  try {
    const origin = runtimeRegistry.getSessionLaunchOrigin(sessionId) ?? '';
    return (
      OUTSIDE_LAUNCH_ORIGINS.has(origin) || (!markStrangerTurns && origin === BRIDGED_LAUNCH_ORIGIN)
    );
  } catch {
    // No database (early boot): nothing stored to read, as memory and the browser read it.
    return false;
  }
}
