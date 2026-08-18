/**
 * Conversation — the one component tree every messaging surface composes.
 *
 * The agent session, a channel and a direct message are three presentations of
 * one conversation. This slice owns what they share: the row family
 * (`Message.*`), the non-message rows, the row-kind union, and the context that
 * says what a surface can do. What they do NOT share — a session's tool cards,
 * a room's markdown and mention pills — stays with the host widget behind a
 * body renderer, so the chrome unifies without the content being forced into
 * one type.
 *
 * **Look is variants; behaviour is capabilities.** `anchor`, `density`, `role`
 * and `position` decide how a row is drawn; `ConversationCapabilities` decides
 * what it offers. Nothing below `Conversation.Root` asks which surface it is on.
 *
 * The slice is deliberately neutral: it imports `entities/*`, `shared/*` and —
 * for UI composition only — sibling features. It imports no widget and no other
 * feature's model, which is what lets both host widgets wire it to their own
 * renderers without either of them reaching into the other.
 *
 * @module features/conversation
 */
export { ConversationRoot } from './ui/ConversationRoot';
export { useConversation } from './model/conversation-context';
export type { ConversationContextValue } from './model/conversation-context';
export type { ConversationCapabilities, ConversationSurface } from './model/capabilities';
export type {
  ConversationAttachmentPort,
  ConversationDraft,
  ConversationMentionCandidate,
  ConversationMentionPort,
  ConversationTarget,
} from './model/target';
export type { BodyRenderContext, ConversationBodyRenderer } from './model/body-renderer';
export type { ConversationRow } from './lib/row-kinds';
export { messageItem, toolStatus } from './ui/message/message-variants';
export { MessageAuthorAvatar } from './ui/message/MessageAuthorAvatar';
export type { MessageAuthorAvatarProps } from './ui/message/MessageAuthorAvatar';
export type { MessagePosition } from './ui/message/message-styles-context';
export { formatAbsoluteTime, formatTime } from './lib/format-entry-time';
export { DayDivider } from './ui/rows/DayDivider';
export { UnreadDivider } from './ui/rows/UnreadDivider';
export { NoticeRow } from './ui/rows/NoticeRow';
export { MomentRow } from './ui/rows/MomentRow';
export type { MomentSubjectIdentity } from './ui/rows/MomentRow';
export { ThreadReplyRow } from './ui/rows/ThreadReplyRow';

export { attachmentsSummary } from './ui/message/MessageAttachments';
export type { MessageActionsProps } from './ui/message/MessageActions';
export type { MessageAttachmentsProps } from './ui/message/MessageAttachments';
export type { MessageAuthorProps } from './ui/message/MessageAuthor';
export type { MessageBodyProps, MessageContentProps } from './ui/message/MessageBody';
export type { MessageGutterProps } from './ui/message/MessageGutter';
export type { MessageReactionsProps } from './ui/message/MessageReactions';
export type { MessageRootProps } from './ui/message/MessageRoot';

import { ConversationRoot } from './ui/ConversationRoot';
import { MessageActions } from './ui/message/MessageActions';
import { MessageAttachments } from './ui/message/MessageAttachments';
import { MessageAuthor } from './ui/message/MessageAuthor';
import { MessageBody, MessageContent } from './ui/message/MessageBody';
import { MessageGutter } from './ui/message/MessageGutter';
import { MessageReactions } from './ui/message/MessageReactions';
import { MessageRoot } from './ui/message/MessageRoot';

/**
 * The conversation compound, as a host composes it.
 *
 * `Root` is the whole of it in P1 — `LiveLane` lands in P2, and `Header`,
 * `Timeline`, `Composer` and `Footer` in P4. It is a namespace object rather
 * than six loose exports for the reason `Composer.*` already is one: a host
 * writes `<Conversation.Timeline>` beside `<Conversation.Composer>` and reads
 * the tree it is building.
 */
export const Conversation = {
  Root: ConversationRoot,
};

/**
 * The one message row, as its parts.
 *
 * A host composes these and supplies the two things only it can: who wrote the
 * message, and how to draw what they said. Everything else — the grid, the
 * grouping rhythm, the identity line, the hover capsule, the pills, the
 * right-click menu, the long-press drawer — is the same code on every surface.
 *
 * `Content` is the eighth part beside the seven the spec names, and it exists
 * because the row genuinely draws two boxes: the BODY column, whose top edge is
 * where the hover capsule is measured against, and the CONTENT inside it, which
 * is the only element a description can honestly point at. Both rows this
 * replaced already drew exactly these two, and a shipped browser test measures
 * one against the other.
 */
export const Message = {
  Root: MessageRoot,
  Gutter: MessageGutter,
  Author: MessageAuthor,
  Body: MessageBody,
  Content: MessageContent,
  Attachments: MessageAttachments,
  Reactions: MessageReactions,
  Actions: MessageActions,
};
