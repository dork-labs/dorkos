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

import { ConversationRoot } from './ui/ConversationRoot';

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
