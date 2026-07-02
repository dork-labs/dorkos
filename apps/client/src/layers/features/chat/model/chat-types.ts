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
  SystemStatusState,
} from '@/layers/shared/model/chat-message-types';

export interface ChatSessionOptions {
  /** Transform message content before sending to server (e.g., prepend context) */
  transformContent?: (content: string) => string | Promise<string>;
  /** Called when a task_update event is received during streaming */
  onTaskEvent?: (event: TaskUpdateEvent) => void;
  /** Called when the SDK assigns a different session ID (e.g., first message in a new session) */
  onSessionIdChange?: (newSessionId: string) => void;
  /**
   * Called when a brand-new session's client UUID resolves to its SDK-canonical
   * id after the trigger POST (create-on-first-message). REPLACES the URL in
   * place (no history push) so the optimistic UUID is silently superseded.
   */
  onSessionIdChangeReplace?: (canonicalSessionId: string) => void;
  /** Called when streaming completes after 3+ seconds (for notification sound) */
  onStreamingDone?: () => void;
  /**
   * Runtime selected at launch (the `?runtime=` search param). Sent as the
   * `runtime` hint on the session-creating first message ONLY — the server's
   * `persistSessionRuntime` is first-write-wins, so later sends never carry it.
   * Absent means the server resolves the runtime (agent manifest, then default).
   */
  launchRuntime?: string;
}
