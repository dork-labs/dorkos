/**
 * Whether a launching turn is the owner's own send, carrying no outside words and no mark
 * (DOR-4693). Only such a turn ends the outside-words note an earlier turn left on its chat: before,
 * only a room turn ever ended it, so in a direct chat one agent message that carried outside words
 * marked every later turn the owner typed.
 *
 * Narrow on purpose (Security's ruling): a turn another chat, a schedule, a relay, a heartbeat, a
 * mini app or a system wake started keeps the note, and so does any turn held to the runtime's
 * default, a continuation or a turn carrying a mark.
 *
 * @module services/session/message-dispatcher/owner-send
 */
import { isChatClientId } from '../chat-messages/chat-client-id.js';
import { RELAY_CLIENT_PREFIX } from '../../core/session-relay/relay-client-id.js';
import { isExtensionClientId } from '../../extensions/agent-send/extension-client-id.js';
import { HAND_BACK_CLIENT_ID } from '../local-browser/hand-back-wake/client-id.js';
import { getMessageQueueStore } from '../message-queue-store.js';
import { launchCarriesHold, launchCarriesWords, launchCeiling } from './state.js';
import type { DispatchPlan } from './types.js';

/**
 * Whether this launch is a person's own send with nothing outside in it.
 *
 * @param plan - The launching message.
 */
export function isOwnersCleanSend(plan: DispatchPlan): boolean {
  const { turn, clientId, messageId } = plan;
  if (turn.turnStarter !== 'person') return false;
  if (turn.roomTurn || turn.continuationHold || turn.unattended) return false;
  if (turn.carriedMarks?.outsider === true || turn.privateReceiptId !== undefined) return false;
  // The web relay and the browser's hand-back wake both start their turns as a person's.
  if (
    isChatClientId(clientId) ||
    isExtensionClientId(clientId) ||
    clientId.startsWith(RELAY_CLIENT_PREFIX) ||
    clientId === HAND_BACK_CLIENT_ID
  ) {
    return false;
  }
  if (launchCarriesWords(clientId, messageId) || launchCarriesHold(clientId, messageId)) {
    return false;
  }
  // A Wi-Fi sign-in's hold, or any bound at all, reads as not the owner's own clean words.
  const heldToDefault = getMessageQueueStore()?.get(messageId)?.heldToDefault === true;
  return launchCeiling(clientId, messageId, turn.permissionCeiling, heldToDefault) === undefined;
}
