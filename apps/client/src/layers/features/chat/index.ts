/**
 * Chat feature — message streaming UI, tool call cards, and session interaction hooks.
 *
 * @module features/chat
 */
export { ChatPanel } from './ui/ChatPanel';
export { useChatSession } from './model/use-chat-session';
export { useCelebrations } from './model/use-celebrations';
export { useTaskState } from './model/use-task-state';
export { useMessageQueue } from './model/use-message-queue';
export type { QueueItem } from './model/use-message-queue';
