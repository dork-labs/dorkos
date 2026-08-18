/**
 * Chat feature — message streaming UI, tool call cards, and session interaction hooks.
 *
 * @module features/chat
 */
export { ChatPanel } from './ui/ChatPanel';
// The session transcript's row, surfaced for off-session composition (e.g. the
// scripted onboarding conversation renders real message rows, the typing
// indicator, the first-light arrival, and the composer without a live session).
export { SessionMessage } from './ui/message';
export { resolveMessageAuthor } from './lib/resolve-message-author';
export type { MessageAuthorAgent, MessageAuthorContext } from './lib/resolve-message-author';
export { TypingDots } from './ui/primitives';
export { FirstLight } from './ui/FirstLight';
/**
 * What an agent session's conversation can do — the one table that says how
 * this surface differs from a channel's.
 */
export { SESSION_CAPABILITIES } from './config/session-capabilities';
export { useChatSession } from './model/use-chat-session';
export { useCelebrations } from './model/use-celebrations';
export { useTaskState } from './model/use-task-state';
