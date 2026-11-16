/** Narrow seat-chat routing; ordinary origins and stop authority remain unchanged. */
import { isActiveChatAsk } from '../chat-message-store.js';
import { ChatMessageError } from '../chat-message-error.js';
import { sameChat, CHAT_SENDABLE_ORIGINS } from '../chat-target.js';
import type { ChatCaller, ChatSendInput, ChatMessageServiceDeps } from '../chat-message-service.js';
import type {
  RoomSeatMessagesPort,
  SeatMessageTarget,
} from '../../../rooms/handoff/seat-message-types.js';

/** A validated peer write, with reply classification independent of unsolicited reach. */
export interface ChatSeatTarget {
  port: RoomSeatMessagesPort;
  seat: SeatMessageTarget;
  replyToId: string | null;
}

/** Resolve only an explicit bound seat chat, never an agent-id DM or an ordinary origin. */
export async function resolveChatSeatTarget(
  deps: ChatMessageServiceDeps,
  caller: ChatCaller,
  input: ChatSendInput
): Promise<ChatSeatTarget | null> {
  const mesh = deps.meshCore();
  if (mesh?.get(input.to) && mesh.getProjectPath(input.to)) return null;
  const port = deps.seatMessages?.();
  const seat = port?.resolveSeatTarget(input.to);
  const facts = await deps.describeSession(seat?.canonicalSessionId ?? input.to);
  if (!facts.roomBound && !seat) return null;
  if (!port || !seat || !facts.bound || !facts.roomBound || facts.agentPath !== seat.agentPath) {
    throw new ChatMessageError('NOT_ALLOWED', 'That room seat is unavailable.');
  }
  if (
    input.to === caller.sessionId ||
    (await sameChat(deps, seat.canonicalSessionId ?? input.to, caller.sessionId))
  ) {
    throw new ChatMessageError('SELF', 'That is your own chat. Keep working there.');
  }
  const asked =
    input.replyTo !== undefined
      ? deps.store.get(input.replyTo)
      : deps.store.latestUnansweredFromAliases(seat.aliases ?? [input.to], caller.sessionId);
  const sourceSeat = asked ? port.resolveSeatTarget(asked.fromSessionId) : null;
  const identityMatches =
    asked !== undefined &&
    asked !== null &&
    sourceSeat?.roomId === seat.roomId &&
    sourceSeat?.authorId === seat.authorId &&
    sourceSeat?.joinedAt === seat.joinedAt &&
    sourceSeat?.canonicalSessionId === seat.canonicalSessionId &&
    (await sameChat(deps, asked.toSessionId, caller.sessionId));
  if (input.replyTo !== undefined && !identityMatches)
    throw new ChatMessageError(
      'NOT_ALLOWED',
      'replyTo must name a message this seat sent your chat.'
    );
  const replyToId = identityMatches && isActiveChatAsk(asked) ? asked.id : null;
  if (
    (seat.bridged && replyToId === null) ||
    !seatOriginAllowed(facts.launchOrigin, seat, replyToId !== null)
  )
    throw new ChatMessageError('NOT_ALLOWED', 'That room seat is unavailable.');
  return { port, seat, replyToId };
}

/** Existing eligibility plus the room bridge's intentional legacy adoption compatibility. */
function seatOriginAllowed(
  origin: string | null,
  seat: SeatMessageTarget,
  answer: boolean
): boolean {
  if (origin === 'room' || (origin !== null && CHAT_SENDABLE_ORIGINS.has(origin))) return true;
  // Adoption keeps immutable historical origin, including pre-origin-column nulls.
  // This is current server bridge/ledger authority, not proof that an adopter invocation ran.
  return (
    answer && seat.bridgeOwnership !== undefined && (origin === 'relay-binding' || origin === null)
  );
}
