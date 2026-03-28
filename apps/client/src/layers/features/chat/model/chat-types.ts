import type { TaskUpdateEvent } from '@dorkos/shared/types';

// Core chat types live in the shared layer (used by both entities and features).
// Re-exported here for backward compatibility — all existing imports continue to work.
export type {
  ChatMessage,
  HookState,
  GroupPosition,
  MessageGrouping,
  ToolCallState,
  TransportErrorInfo,
  ChatStatus,
} from '@/layers/shared/model/chat-message-types';

export interface ChatSessionOptions {
  /** Transform message content before sending to server (e.g., prepend context) */
  transformContent?: (content: string) => string | Promise<string>;
  /** Called when a task_update event is received during streaming */
  onTaskEvent?: (event: TaskUpdateEvent) => void;
  /** Called when the SDK assigns a different session ID (e.g., first message in a new session) */
  onSessionIdChange?: (newSessionId: string) => void;
  /** Called when streaming completes after 3+ seconds (for notification sound) */
  onStreamingDone?: () => void;
}
