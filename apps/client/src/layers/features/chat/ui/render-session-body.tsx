/**
 * The session's body renderer — what goes inside one transcript row.
 *
 * One of the two implementations of {@link ConversationBodyRenderer}; the
 * room's is `widgets/room-view/ui/render-room-body.tsx`. Neither knows about the
 * other, and `features/conversation` imports neither: the chrome is shared, the
 * content stays typed at its own end.
 *
 * **It stays in `features/chat`, and P4 verified that it has to.** The spec
 * (§2.6) and P1's own record put it in `widgets/session` once the host moved up
 * there. The host DID move — `ChatPanel` and the transcript are widgets now —
 * but the ROW that calls this renderer cannot follow them: the onboarding
 * narration renders real `SessionMessage` rows for its scripted lines
 * (`features/onboarding/ui/OnboardingConversation.tsx:378`), and a feature may
 * not import a widget. So the row stays a feature export, and its renderer stays
 * beside it. `SESSION_CAPABILITIES` had no such consumer and did move.
 *
 * @module features/chat/ui/render-session-body
 */
import type { ChatMessage } from '@/layers/shared/model';
import type { ConversationBodyRenderer } from '@/layers/features/conversation';
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
