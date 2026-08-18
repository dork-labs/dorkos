/**
 * The session's body renderer — what goes inside one transcript row.
 *
 * One of the two implementations of {@link ConversationBodyRenderer}; the
 * room's is `widgets/room-view/ui/render-room-body.tsx`. Neither knows about the
 * other, and `features/conversation` imports neither: the chrome is shared, the
 * content stays typed at its own end.
 *
 * It lives beside the components it calls rather than in `widgets/session`,
 * which is where the composer host will own it from P4. The renderer is invoked
 * by the ROW, deep inside this feature, and a feature may not import a widget —
 * so putting it one layer up today would mean threading a function through
 * `ChatPanel`, `ChatMessageArea` and `MessageList` purely to satisfy a path,
 * and P4 deletes all three of those hops.
 *
 * @module features/chat/ui/render-session-body
 */
import type { ConversationBodyRenderer } from '@/layers/features/conversation';
import type { ChatMessage } from '../model/use-chat-session';
import { AssistantMessageContent } from './message/AssistantMessageContent';
import { UserMessageContent } from './message/UserMessageContent';

/**
 * Draw one session message's body.
 *
 * The split is by ROLE and nothing else — everything downstream of it (tool
 * cards, thinking blocks, the three inline prompts, streaming text, output
 * renderers) is `AssistantMessageContent`'s business, and what the reader typed
 * is `UserMessageContent`'s. Local-command output is a `user`-role message whose
 * content is a command result, which is why the row's TYPOGRAPHY treats it as an
 * assistant line while its body is still drawn here as the user's.
 *
 * The payload is this host's own `ChatMessage`: the timeline hands back exactly
 * what it was given, so the cast asserts a fact the host established rather than
 * a hope.
 */
export const renderSessionBody: ConversationBodyRenderer = (payload) => {
  const message = payload as ChatMessage;
  return message.role === 'user' ? (
    <UserMessageContent message={message} />
  ) : (
    <AssistantMessageContent message={message} />
  );
};
