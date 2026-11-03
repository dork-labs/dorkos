/**
 * When a message into a Direct chat from anyone but an agent is held to the stranger's bound
 * (DOR-3088, Security's G2 for to-do turns in the Direct chat): while to-dos are on, on an install
 * with an owner account. A Direct chat is where the person's own to-dos run at the person's power,
 * so a message there that can't prove the person must not start a turn at it. With no owner
 * account nobody can be proven, and with to-dos off no to-do runs there, so Direct chats work as
 * they always have.
 *
 * Whether the caller DID prove the person is the door's own question: the REST routes ask
 * `personProof` (`routes/room-post-bound.ts`); the `rooms.post` capability never proves one, so it
 * holds whenever this answers yes.
 *
 * @module services/rooms/limits/direct-chat-hold
 */
import { env } from '../../../env.js';
import { ownerAccountExists } from '../../core/auth/gate-policy.js';

/**
 * Whether a message into a Direct chat from this kind of caller is held unless it proves the owner.
 *
 * @param callerKind - Who is sending: an agent, or anyone else.
 * @param ownerExists - Whether the install has an owner account; fails closed by default.
 * @param todosOn - Whether to-dos are on; only then does a to-do run in a Direct chat.
 */
export function directChatHoldApplies(
  callerKind: string,
  ownerExists: () => boolean = ownerAccountExists,
  todosOn: boolean = env.DORKOS_TODOS_ENABLED
): boolean {
  return todosOn && callerKind !== 'agent' && ownerExists();
}
