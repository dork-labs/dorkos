/**
 * Chat feature — message streaming UI, tool call cards, and session interaction hooks.
 *
 * @module features/chat
 */
export { ChatPanel } from './ui/ChatPanel';
// Reusable chat primitives — surfaced for off-session composition (e.g. the
// scripted onboarding conversation renders real message bubbles, the typing
// indicator, the first-light arrival, and the composer without a live session).
export { MessageItem } from './ui/message';
// The identity gutter and the two list-level rules, surfaced so the room view
// renders the same marks and separators session chat does (spec `rooms` §7).
export { MessageAuthorAvatar, DayDivider, UnreadDivider } from './ui/message';
// The message row's layout contract (identity gutter + content column, group
// rhythm). Shared rather than re-declared so a room's rows sit on exactly the
// grid session chat does and stay there when one of them is tuned.
export { messageItem } from './ui/message/message-variants';
export { resolveMessageAuthor } from './lib/resolve-message-author';
export type { MessageAuthorAgent, MessageAuthorContext } from './lib/resolve-message-author';
export { TypingDots } from './ui/primitives';
export { FirstLight } from './ui/FirstLight';
export { ChatStatusStrip } from './ui/status/ChatStatusStrip';
export { deriveStripState } from './ui/status/strip-state';
export type { StripState } from './ui/status/strip-state';
export { useChatSession } from './model/use-chat-session';
export { useCelebrations } from './model/use-celebrations';
export { useTaskState } from './model/use-task-state';
