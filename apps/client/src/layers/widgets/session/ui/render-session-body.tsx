/**
 * The session's body renderer — what goes inside one transcript row.
 *
 * One of the two implementations of {@link ConversationBodyRenderer}; the
 * room's is `widgets/room-view/ui/render-room-body.tsx`. Neither knows about the
 * other, and `features/conversation` imports neither: the chrome is shared, the
 * content stays typed at its own end.
 *
 * It sits beside the host that draws it, which is where the spec puts it (§2.6)
 * and where P1's record always said it belonged. It could not get here during
 * the programme: `SessionMessage`, the row that calls it, was rendered by
 * `features/onboarding` for its scripted narration, and a feature may not
 * import a widget (Known Issue 29). Onboarding composing `Message.*` for itself
 * is what freed both to come up here (DOR-1353).
 *
 * @module widgets/session/ui/render-session-body
 */
import type { ChatMessage } from '@/layers/shared/model';
import type { ConversationBodyRenderer } from '@/layers/features/conversation';
import { AssistantMessageContent, UserMessageContent } from '@/layers/features/chat';

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
