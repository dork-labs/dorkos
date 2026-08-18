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
// The two list-level rules, surfaced so the room view renders the same
// separators session chat does (spec `rooms` §7).
export { DayDivider, UnreadDivider } from './ui/message';
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
