/**
 * Core chat message types shared across FSD layers.
 *
 * These types are used by both the entity layer (session-chat-store) and the
 * feature layer (chat). They live in shared/ to avoid FSD layer violations.
 *
 * @module shared/model/chat-message-types
 */
import type {
  QuestionItem,
  MessagePart,
  HookPart,
  CompactMetadata,
  MessageType,
  OperationKind,
} from '@dorkos/shared/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  parts: MessagePart[];
  timestamp: string;
  messageType?: MessageType;
  /** Compaction metadata — present on `compaction` messages when the transcript records the boundary. */
  compactMetadata?: CompactMetadata;
  commandName?: string;
  commandArgs?: string;
  /** @internal Client-only tag for streaming messages awaiting server ID reconciliation. */
  _streaming?: boolean;
  /**
   * @internal Client-only tag for a STAGED-context note (spec
   * `persistent-session-runtime` §2.5). A person added this for the agent to use
   * next without cutting into the running turn, so it renders as a quiet
   * transcript entry — visibly not a turn — rather than a message bubble.
   */
  _stagedContext?: boolean;
}

/** Client-side view of a single hook execution attached to a tool call. */
export type HookState = HookPart;

/**
 * Who a message is from, as the message list renders it.
 *
 * A client-derived view-model, NOT a wire-schema field (spec
 * `multi-participant-message-list`, D2): `ChatMessage` stays unchanged and a
 * pure resolver computes this from the message plus the session's agent and
 * runtime. The type is the seam — a later phase can move the source to the
 * server without touching a UI component.
 */
export interface MessageAuthor {
  /** Which kind of participant spoke: a person, an agent, or the system itself. */
  kind: 'human' | 'agent' | 'system';
  /** Stable identity key — drives grouping and avatar color. */
  id: string;
  /** Name shown in the group header. Never a bare "Assistant". */
  displayName: string;
  /** Emoji glyph for the avatar, when the identity has one. */
  emoji?: string;
  /** CSS color string for the avatar background. */
  color?: string;
  /**
   * The identity's photo, when it has one — the face the avatar prefers over
   * the emoji. Carried as the resolver received it; nothing here builds a URL.
   */
  imageUrl?: string;
  /** Runtime brand key, when the identity falls back to a runtime. */
  runtime?: string;
  /**
   * True when this identity is posting from outside this machine — a bridged
   * chat platform rather than a person or agent local to this install.
   * Falsy — present and `false`, or absent — for `agent`/`system`, which are
   * always local; never `true` for either.
   */
  isExternal?: boolean;
}

export type GroupPosition = 'only' | 'first' | 'middle' | 'last';

/** Where a message sits inside its author group — the list's vertical rhythm. */
export interface MessageGrouping {
  position: GroupPosition;
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
  /**
   * Server-authoritative ms left before auto-deny. When set, the card's
   * deadline is `Date.now() + approvalRemainingMs`, so a card recovered after a
   * reconnect resumes where the clock actually is instead of restarting.
   */
  approvalRemainingMs?: number;
  /**
   * True once the server reports this prompt as PARKED: nobody answered inside
   * the budget, so `approvalRemainingMs` runs to the four-hour ceiling rather
   * than to the `timeoutMs` beside it (spec `ask-parks-on-timeout`). Carried
   * from the part, which carries it from the pending-interaction DTO.
   */
  approvalParked?: boolean;
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
  /** Short heading shown in the error banner (e.g., "Can't reach DorkOS"). */
  heading: string;
  /** Human-readable detail message. */
  message: string;
  /** Whether the user can retry the same action. */
  retryable: boolean;
}

export type ChatStatus = 'idle' | 'streaming' | 'error';

/**
 * Per-session system-status payload surfaced on the chat store — a transient
 * informational flash (e.g. a session hook running). `message` is the copy the
 * `system-message` rung renders. Operation lifecycle (compaction) is NOT here;
 * it rides {@link OperationProgressState}.
 */
export interface SystemStatusState {
  /** Human-readable body. Always set when the record is non-null. */
  message: string;
}

/**
 * Per-session live operation-progress payload surfaced on the chat store — the
 * active phase of a named long-running operation (DOR-110), held only while the
 * operation is in progress (a `done`/`failed` phase clears it to `null`). Drives
 * the status strip's progress treatment: an indeterminate bar when
 * `determinate` is false, a `percent` bar when true.
 */
export interface OperationProgressState {
  /** Which operation is in progress (extensible union). */
  operation: OperationKind;
  /** Whether `percent` is meaningful; `false` → indeterminate bar. */
  determinate: boolean;
  /** Completion fraction 0–100, present only when `determinate` is true. */
  percent?: number;
  /** Optional operation label (e.g. "Compacting context…"). */
  message?: string;
}
