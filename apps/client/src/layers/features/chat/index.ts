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
export { TypingDots } from './ui/primitives';
export { ChatInput, type ChatInputHandle } from './ui/input/ChatInput';
export { FirstLight } from './ui/FirstLight';
export { ChatStatusStrip, deriveStripState } from './ui/status/ChatStatusStrip';
export type { StripState } from './ui/status/ChatStatusStrip';
export { useChatSession } from './model/use-chat-session';
export { useCelebrations } from './model/use-celebrations';
export { useTaskState } from './model/use-task-state';
export { useMessageQueue } from './model/use-message-queue';
export type { QueueItem } from './model/use-message-queue';
