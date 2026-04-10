/**
 * Core chat message types shared across FSD layers.
 *
 * These types are used by both the entity layer (session-chat-store) and the
 * feature layer (chat). They live in shared/ to avoid FSD layer violations.
 *
 * @module shared/model/chat-message-types
 */
import type { QuestionItem, MessagePart, HookPart } from '@dorkos/shared/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  parts: MessagePart[];
  timestamp: string;
  messageType?: 'command' | 'compaction';
  commandName?: string;
  commandArgs?: string;
  /** @internal Client-only tag for streaming messages awaiting server ID reconciliation. */
  _streaming?: boolean;
}

/** Client-side view of a single hook execution attached to a tool call. */
export type HookState = HookPart;

export type GroupPosition = 'only' | 'first' | 'middle' | 'last';

export interface MessageGrouping {
  position: GroupPosition;
  groupIndex: number;
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: string;
  result?: string;
  /** Intermediate output from tool_progress events (cleared when result arrives) */
  progressOutput?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  /** Set when this tool call requires interactive UI (approval or question) */
  interactiveType?: 'approval' | 'question';
  /** Question data when interactiveType is 'question' */
  questions?: QuestionItem[];
  /** Submitted answers (present when restored from history) */
  answers?: Record<string, string>;
  /** Approval timeout duration in milliseconds (present for approval-type tool calls) */
  timeoutMs?: number;
  /** Server timestamp (ms since epoch) when the approval timer started — for drift-free countdown */
  approvalStartedAt?: number;
  /** SDK-provided full permission prompt sentence */
  approvalTitle?: string;
  /** SDK-provided short noun phrase for the tool action */
  approvalDisplayName?: string;
  /** SDK-provided human-readable subtitle */
  approvalDescription?: string;
  /** File path that triggered the permission request */
  approvalBlockedPath?: string;
  /** Why this permission request was triggered */
  approvalDecisionReason?: string;
  /** Whether "Always Allow" permission updates are available */
  approvalHasSuggestions?: boolean;
  /** Hook executions attached to this tool call (pre-tool and post-tool hooks). */
  hooks?: HookState[];
  /** Timestamp (ms since epoch) when tool_call_start was received. */
  startedAt?: number;
  /** Timestamp (ms since epoch) when tool_result was received. */
  completedAt?: number;
}

/** Structured error information for transport-level failures. */
export interface TransportErrorInfo {
  /** Short heading shown in the error banner (e.g., "Connection failed"). */
  heading: string;
  /** Human-readable detail message. */
  message: string;
  /** Whether the user can retry the same action. */
  retryable: boolean;
  /** If set, the error banner auto-dismisses after this many ms. */
  autoDismissMs?: number;
}

export type ChatStatus = 'idle' | 'streaming' | 'error';
