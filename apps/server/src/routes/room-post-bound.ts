/**
 * The bound a person's post into a room starts its turn at (DOR-3088, Security's G2 for to-do
 * turns in the Direct chat).
 *
 * - A Wi-Fi sign-in's post is held to the runtime's default, as before (`wifiTurnBound`).
 * - While to-dos are on (`DORKOS_TODOS_ENABLED`), on an install with an owner account, a post
 *   into a Direct chat that does not prove the owner (`personProof`: their own sign-in) is held to
 *   the stranger's bound too. A program at this computer can post as the person without their
 *   sign-in, and a Direct chat is where the person's own to-dos run at the person's power. With
 *   no owner account nobody can be proven, and with to-dos off no to-do runs there, so Direct
 *   chats work as they always have.
 * - An agent's own posts are never bound here: its turn carries its own power.
 *
 * @module routes/room-post-bound
 */
import type { RequestFacts } from '../http/request-facts.js';
import { ownerAccountExists } from '../services/core/auth/gate-policy.js';
import { wifiTurnBound } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { personProof } from '../services/todos/caller.js';
import { directChatHoldApplies } from '../services/rooms/limits/direct-chat-hold.js';
import { env } from '../env.js';

/**
 * The bound a post's turn starts at, or undefined for none beyond the poster's own.
 *
 * @param facts - The request's facts.
 * @param roomKind - The room's kind, or undefined when it can't be read.
 * @param callerKind - Who is posting: an agent or a person.
 * @param ownerExists - Whether the install has an owner account; fails closed by default.
 */
export function roomPostBound(
  facts: RequestFacts,
  roomKind: string | undefined,
  callerKind: string,
  ownerExists: () => boolean = ownerAccountExists
): 'runtime-default' | undefined {
  const wifi = wifiTurnBound(facts);
  if (wifi) return wifi;
  if (roomKind !== 'dm') return undefined;
  return unprovenDirectChatBound(facts, callerKind, ownerExists);
}

/**
 * The stranger's bound for a person's message into a Direct chat that does not prove the owner,
 * on an install with an owner account; undefined otherwise. The one rule behind a room post into
 * the chat and a message sent straight to its session, so the two doors agree.
 *
 * @param facts - The request's facts.
 * @param callerKind - Who is sending: an agent, or anyone else.
 * @param ownerExists - Whether the install has an owner account; fails closed by default.
 * @param todosOn - Whether to-dos are on; only then does a to-do run in a Direct chat.
 */
export function unprovenDirectChatBound(
  facts: RequestFacts,
  callerKind: string,
  ownerExists: () => boolean = ownerAccountExists,
  todosOn: boolean = env.DORKOS_TODOS_ENABLED
): 'runtime-default' | undefined {
  return directChatHoldApplies(callerKind, ownerExists, todosOn) && !personProof(facts)
    ? 'runtime-default'
    : undefined;
}

/**
 * The ceiling a person's turn in one session carries, as the spread a dispatch takes: the Wi-Fi
 * hold, or the stranger's bound for a message into a Direct chat's own session that doesn't prove
 * the owner ({@link unprovenDirectChatBound}). For the doors that reach a session without a room
 * post: a widget's action, a mini app's forward.
 *
 * @param facts - The request's facts.
 * @param directChat - Whether the session or room is a Direct chat's.
 */
export function personTurnBound(
  facts: RequestFacts,
  directChat: boolean
): 'runtime-default' | undefined {
  return (
    wifiTurnBound(facts) ?? (directChat ? unprovenDirectChatBound(facts, 'person') : undefined)
  );
}
