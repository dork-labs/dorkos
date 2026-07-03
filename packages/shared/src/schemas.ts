/**
 * Zod schemas — single source of truth for all shared types and OpenAPI metadata.
 *
 * Each schema exports an inferred TypeScript type. Types are re-exported from `types.ts`
 * for backward-compatible imports. Schemas are consumed by the OpenAPI registry for
 * auto-generated API documentation and by route handlers for request validation.
 *
 * @module shared/schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
// `ClientContextSchema` lives in additional-context.ts (which imports UiStateSchema
// from here). The reference below is wrapped in `z.lazy`, so this cyclic import is
// resolved at validation time, not module-load time — no initialization hazard.
import { ClientContextSchema } from './additional-context.js';

extendZodWithOpenApi(z);

// === Enums ===

export const PermissionModeSchema = z
  .enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'])
  .openapi('PermissionMode');

export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const SessionTaskStatusSchema = z
  .enum(['pending', 'in_progress', 'completed'])
  .openapi('SessionTaskStatus');

export type SessionTaskStatus = z.infer<typeof SessionTaskStatusSchema>;

export const StreamEventTypeSchema = z
  .enum([
    'text_delta',
    'tool_call_start',
    'tool_call_delta',
    'tool_call_end',
    'tool_result',
    'tool_progress',
    'approval_required',
    'question_prompt',
    'error',
    'rate_limit',
    'api_retry',
    'done',
    'session_status',
    'task_update',
    'relay_receipt',
    'message_delivered',
    'relay_message',
    'thinking_delta',
    'background_task_started',
    'background_task_progress',
    'background_task_done',
    'subagent_text_delta',
    'system_status',
    'memory_recall',
    'compact_boundary',
    'prompt_suggestion',
    'hook_started',
    'hook_progress',
    'hook_response',
    'ui_command',
    'session_state_changed',
    'context_usage',
    'usage_info',
    'elicitation_prompt',
    'elicitation_complete',
    'permission_denied',
    'interaction_cancelled',
  ])
  .openapi('StreamEventType');

export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;

// === Question / Option Types ===

export const QuestionOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
  })
  .openapi('QuestionOption');

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionItemSchema = z
  .object({
    header: z.string(),
    question: z.string(),
    options: z.array(QuestionOptionSchema),
    multiSelect: z.boolean(),
  })
  .openapi('QuestionItem');

export type QuestionItem = z.infer<typeof QuestionItemSchema>;

// === Session Types ===

export const EffortLevelSchema = z
  .enum(['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'])
  .openapi('EffortLevel');
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastMessagePreview: z.string().optional(),
    permissionMode: PermissionModeSchema,
    runtime: z.string(),
    model: z.string().optional(),
    effort: EffortLevelSchema.optional(),
    fastMode: z.boolean().optional(),
    contextTokens: z.number().int().optional(),
    cwd: z.string().optional(),
  })
  .openapi('Session');

export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    cwd: z.string().optional(),
  })
  .openapi('CreateSessionRequest');

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * The mutable per-session settings an operator can change. Defined once and
 * reused for the update request, the runtime `MessageOpts`/`SessionOpts`, and
 * the persisted `session_metadata` columns (ADR-0260). An omitted field means
 * "no change" / "no explicit preference" (the runtime default applies).
 */
export const SessionSettingsSchema = z.object({
  permissionMode: PermissionModeSchema.optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  fastMode: z.boolean().optional(),
});

export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const UpdateSessionRequestSchema = SessionSettingsSchema.extend({
  title: z.string().min(1).max(200).optional(),
}).openapi('UpdateSessionRequest');

export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const ForkSessionRequestSchema = z
  .object({
    /** Slice transcript up to this message ID (inclusive). If omitted, full copy. */
    upToMessageId: z.string().optional(),
    /** Custom title for the fork. If omitted, SDK derives from original title. */
    title: z.string().optional(),
  })
  .openapi('ForkSessionRequest');

export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>;

export const ReloadPluginsResultSchema = z
  .object({
    /** Number of commands available after reload. */
    commandCount: z.number().int(),
    /** Number of plugins loaded after reload. */
    pluginCount: z.number().int(),
    /** Number of errors encountered during reload. */
    errorCount: z.number().int(),
  })
  .openapi('ReloadPluginsResult');

export type ReloadPluginsResult = z.infer<typeof ReloadPluginsResultSchema>;

export const SendMessageRequestSchema = z
  .object({
    content: z.string().min(1, 'content is required'),
    cwd: z.string().optional(),
    correlationId: z.string().uuid().optional(),
    clientMessageId: z.string().optional(),
    /** Neutral client-sourced context signals (ui_state, queued). Server derives git_status/env. */
    context: z.lazy(() => ClientContextSchema).optional(),
    /**
     * Explicit runtime hint for session ownership. Used on the first message
     * only — subsequent calls for the same `sessionId` ignore this field (the
     * stored `session_metadata` row wins). Priority: `runtime` > agent-manifest
     * `runtime` field > server default. See ADR 0255.
     */
    runtime: z.string().optional(),
    /**
     * Path to the agent directory whose `.dork/agent.json` manifest seeded this
     * session. Recorded on first message for provenance. Ignored on subsequent
     * calls (session ownership is immutable).
     */
    agentPath: z.string().optional(),
    /**
     * Opt-in (DOR-84): bind this turn to a server-managed workspace keyed by this
     * unit-of-work id (issue id / spec slug). When set, the server
     * provisions-or-reuses the workspace from the supplied `cwd` (the source repo)
     * and runs the turn with `cwd = workspace.path` and the allocated port block.
     * Absent → behavior is unchanged (the supplied `cwd` is used directly).
     */
    workspaceKey: z.string().optional(),
    /** Provider for a newly-provisioned workspace; defaults to server config. */
    workspaceProvider: z.enum(['worktree', 'clone']).optional(),
  })
  .openapi('SendMessageRequest');

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * The `202 Accepted` body for `POST /api/sessions/:id/messages` (ADR-0264).
 * The POST is trigger-only: it starts the turn server-side and returns the
 * CANONICAL session id; the turn's tokens are delivered solely on
 * `GET /:id/events`. For a brand-new session this `sessionId` is the real SDK
 * id assigned during the turn (it differs from the client-supplied id), so the
 * client re-keys its URL and its `/events` subscription to it (DOR-74).
 */
export const SendMessageResponseSchema = z
  .object({
    sessionId: z
      .string()
      .describe('Canonical session id; differs from the request id for a new session'),
  })
  .openapi('SendMessageResponse');

export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const ApprovalRequestSchema = z
  .object({
    toolCallId: z.string(),
    /** When true, resolves as "Always Allow" — forwards SDK permission suggestions. */
    alwaysAllow: z.boolean().optional(),
  })
  .openapi('ApprovalRequest');

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const BatchApprovalRequestSchema = z
  .object({
    toolCallIds: z.array(z.string()).min(1),
  })
  .openapi('BatchApprovalRequest');

export type BatchApprovalRequest = z.infer<typeof BatchApprovalRequestSchema>;

export const SubmitAnswersRequestSchema = z
  .object({
    toolCallId: z.string(),
    answers: z.record(z.string(), z.string()),
  })
  .openapi('SubmitAnswersRequest');

export type SubmitAnswersRequest = z.infer<typeof SubmitAnswersRequestSchema>;

export const ElicitationModeSchema = z.enum(['form', 'url']).openapi('ElicitationMode');
export type ElicitationMode = z.infer<typeof ElicitationModeSchema>;

export const ElicitationActionSchema = z
  .enum(['accept', 'decline', 'cancel'])
  .openapi('ElicitationAction');
export type ElicitationAction = z.infer<typeof ElicitationActionSchema>;

export const SubmitElicitationRequestSchema = z
  .object({
    interactionId: z.string(),
    action: ElicitationActionSchema,
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('SubmitElicitationRequest');

export type SubmitElicitationRequest = z.infer<typeof SubmitElicitationRequestSchema>;

export const ListSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(200),
    cwd: z.string().optional(),
    /**
     * Filter the list to sessions owned by a single runtime type (e.g.
     * `'claude-code'`). Must name a runtime registered on the server —
     * unknown types are rejected with a 400 `UNKNOWN_RUNTIME`.
     */
    runtime: z.string().optional(),
  })
  .openapi('ListSessionsQuery');

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

/**
 * A per-runtime failure surfaced by session-list aggregation (ADR-0310).
 * A runtime whose `listSessions` rejects or times out contributes one warning
 * and zero sessions instead of failing the whole request.
 */
export const SessionListWarningSchema = z
  .object({
    /** Runtime type that failed to list (e.g. `'codex'`). */
    runtime: z.string(),
    /** Human-readable failure reason. */
    message: z.string(),
  })
  .openapi('SessionListWarning');

export type SessionListWarning = z.infer<typeof SessionListWarningSchema>;

/**
 * Response envelope for `GET /api/sessions` (ADR-0310).
 *
 * An envelope rather than a bare `Session[]` because the list is aggregated
 * across every registered runtime with graceful per-runtime degradation, and
 * the partial-failure `warnings[]` must travel in-band: an HTTP header would
 * be invisible to the Direct (in-process) transport, which shares this type.
 * `warnings` is omitted entirely when every runtime listed successfully.
 */
export const SessionListResponseSchema = z
  .object({
    /** Merged across runtimes, sorted by `updatedAt` descending. */
    sessions: z.array(SessionSchema),
    /** Present only when at least one runtime failed or timed out. */
    warnings: z.array(SessionListWarningSchema).optional(),
  })
  .openapi('SessionListResponse');

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const CommandsQuerySchema = z
  .object({
    refresh: z.enum(['true', 'false']).optional(),
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .openapi('CommandsQuery');

export type CommandsQuery = z.infer<typeof CommandsQuerySchema>;

// === SSE Event Types ===

export const TextDeltaSchema = z
  .object({
    text: z.string(),
  })
  .openapi('TextDelta');

export type TextDelta = z.infer<typeof TextDeltaSchema>;

export const ThinkingDeltaSchema = z
  .object({
    text: z.string(),
  })
  .openapi('ThinkingDelta');

export type ThinkingDelta = z.infer<typeof ThinkingDeltaSchema>;

const ToolCallStatusSchema = z.enum(['pending', 'running', 'complete', 'error']);

export const ToolCallEventSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string().optional(),
    result: z.string().optional(),
    status: ToolCallStatusSchema,
  })
  .openapi('ToolCallEvent');

export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolProgressEventSchema = z
  .object({
    toolCallId: z.string(),
    content: z.string(),
  })
  .openapi('ToolProgressEvent');

export type ToolProgressEvent = z.infer<typeof ToolProgressEventSchema>;

export const ApprovalEventSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
    timeoutMs: z.number().describe('Server-side approval timeout in milliseconds'),
    startedAt: z.number().describe('Server timestamp when the approval timer started'),
    // SDK-provided rich context for the approval UI
    title: z.string().optional().describe('Full permission prompt sentence from SDK'),
    displayName: z.string().optional().describe('Short noun phrase for the tool action'),
    description: z.string().optional().describe('Human-readable subtitle from SDK'),
    blockedPath: z.string().optional().describe('File path that triggered the permission request'),
    decisionReason: z.string().optional().describe('Why this permission request was triggered'),
    hasSuggestions: z.boolean().describe('Whether "Always Allow" permission updates are available'),
    remainingMs: z
      .number()
      .optional()
      .describe(
        'Server-authoritative ms left before auto-deny; present on recovery re-emit so the countdown resumes without resetting'
      ),
  })
  .openapi('ApprovalEvent');

export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const QuestionPromptEventSchema = z
  .object({
    toolCallId: z.string(),
    questions: z.array(QuestionItemSchema),
    startedAt: z
      .number()
      .optional()
      .describe('Server timestamp when the question timer started; present on recovery re-emit'),
    remainingMs: z
      .number()
      .optional()
      .describe(
        'Server-authoritative ms left before auto-deny; present on recovery re-emit so the countdown resumes without resetting'
      ),
  })
  .openapi('QuestionPromptEvent');

export type QuestionPromptEvent = z.infer<typeof QuestionPromptEventSchema>;

/**
 * Path A DTO describing a single pending interaction recoverable on session
 * (re)connect. Discriminated by `type`; every branch carries the
 * server-authoritative `startedAt`/`remainingMs` so the client can resume the
 * countdown without resetting it.
 */
export const PendingInteractionDTOSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('approval'),
      id: z.string(),
      startedAt: z.number(),
      remainingMs: z.number(),
      toolName: z.string(),
      input: z.string(),
      title: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      blockedPath: z.string().optional(),
      decisionReason: z.string().optional(),
      hasSuggestions: z.boolean(),
    }),
    z.object({
      type: z.literal('question'),
      id: z.string(),
      startedAt: z.number(),
      remainingMs: z.number(),
      questions: z.array(QuestionItemSchema),
    }),
    z.object({
      type: z.literal('elicitation'),
      id: z.string(),
      startedAt: z.number(),
      remainingMs: z.number(),
      serverName: z.string(),
      message: z.string(),
      mode: ElicitationModeSchema.optional(),
      url: z.string().optional(),
      elicitationId: z.string().optional(),
      requestedSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ])
  .openapi('PendingInteractionDTO');

export type PendingInteractionDTO = z.infer<typeof PendingInteractionDTOSchema>;

export const ErrorCategorySchema = z
  .enum(['max_turns', 'execution_error', 'budget_exceeded', 'output_format_error'])
  .openapi('ErrorCategory');

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorEvent');

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const RateLimitEventSchema = z
  .object({
    retryAfter: z.number().optional(),
  })
  .openapi('RateLimitEvent');

export type RateLimitEvent = z.infer<typeof RateLimitEventSchema>;

export const ApiRetryEventSchema = z
  .object({
    attempt: z.number(),
    maxRetries: z.number(),
    retryDelayMs: z.number(),
    errorStatus: z.number().nullable(),
  })
  .openapi('ApiRetryEvent');

export type ApiRetryEvent = z.infer<typeof ApiRetryEventSchema>;

export const DoneEventSchema = z
  .object({
    sessionId: z.string(),
    messageIds: z.object({ user: z.string(), assistant: z.string() }).optional(),
  })
  .openapi('DoneEvent');

export type DoneEvent = z.infer<typeof DoneEventSchema>;

/**
 * Why the SDK query loop terminated. Mirrors the SDK's `TerminalReason` union
 * (introduced in 0.2.91); the trailing `string & {}` alternative keeps
 * forward-compatibility if future SDK versions add values without breaking
 * downstream pattern matching.
 */
export const TerminalReasonSchema = z
  .union([
    z.enum([
      'completed',
      'aborted_tools',
      'aborted_streaming',
      'max_turns',
      'blocking_limit',
      'rapid_refill_breaker',
      'prompt_too_long',
      'image_error',
      'model_error',
      'stop_hook_prevented',
      'hook_stopped',
      'tool_deferred',
    ]),
    z.string(),
  ])
  .openapi('TerminalReason');

export type TerminalReason = z.infer<typeof TerminalReasonSchema>;

export const SessionStatusEventSchema = z
  .object({
    sessionId: z.string(),
    model: z.string().optional(),
    costUsd: z.number().optional(),
    contextTokens: z.number().int().optional(),
    contextMaxTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    /** Tokens read from prompt cache (90% cost savings). */
    cacheReadTokens: z.number().int().optional(),
    /** Tokens written to prompt cache (slight write premium). */
    cacheCreationTokens: z.number().int().optional(),
    /** Why the query loop terminated (SDK 0.2.91+ `result.terminal_reason`). */
    terminalReason: TerminalReasonSchema.optional(),
  })
  .openapi('SessionStatusEvent');

export type SessionStatusEvent = z.infer<typeof SessionStatusEventSchema>;

// === Rate Limit / Subscription Usage Types ===

export const UsageInfoSchema = z
  .object({
    /** Rate limit status: allowed, warning, or rejected. */
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    /** Percentage of rate limit consumed (0-1). */
    utilization: z.number().optional(),
    /** ISO timestamp when the rate limit resets. */
    resetsAt: z.string().optional(),
    /** Type of rate limit applied. */
    rateLimitType: z.string().optional(),
    /** Whether currently using overage tier. */
    isUsingOverage: z.boolean().optional(),
  })
  .openapi('UsageInfo');

export type UsageInfo = z.infer<typeof UsageInfoSchema>;

// === Context Usage Types ===

export const ContextUsageCategorySchema = z.object({
  name: z.string(),
  tokens: z.number().int(),
  color: z.string(),
});

export type ContextUsageCategory = z.infer<typeof ContextUsageCategorySchema>;

export const ContextUsageSchema = z
  .object({
    totalTokens: z.number().int(),
    maxTokens: z.number().int(),
    percentage: z.number(),
    model: z.string(),
    categories: z.array(ContextUsageCategorySchema),
  })
  .openapi('ContextUsage');

export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const TaskItemSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    status: SessionTaskStatusSchema,
    blockedBy: z.array(z.string()).optional(),
    blocks: z.array(z.string()).optional(),
    owner: z.string().optional(),
  })
  .openapi('TaskItem');

export type TaskItem = z.infer<typeof TaskItemSchema>;

export const TaskUpdateEventSchema = z
  .object({
    action: z.enum(['create', 'update', 'snapshot']),
    task: TaskItemSchema,
    tasks: z.array(TaskItemSchema).optional(),
  })
  .openapi('TaskUpdateEvent');

export type TaskUpdateEvent = z.infer<typeof TaskUpdateEventSchema>;

export const RelayReceiptEventSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
  })
  .openapi('RelayReceiptEvent');

export type RelayReceiptEvent = z.infer<typeof RelayReceiptEventSchema>;

export const MessageDeliveredEventSchema = z
  .object({
    messageId: z.string(),
    subject: z.string(),
    status: z.enum(['delivered', 'failed']),
  })
  .openapi('MessageDeliveredEvent');

export type MessageDeliveredEvent = z.infer<typeof MessageDeliveredEventSchema>;

export const RelayMessageEventSchema = z
  .object({
    messageId: z.string(),
    payload: z.unknown(),
    subject: z.string().optional(),
    from: z.string().optional(),
  })
  .openapi('RelayMessageEvent');

export type RelayMessageEvent = z.infer<typeof RelayMessageEventSchema>;

// === Background Task Type/Status (needed by both events and parts) ===

export const BackgroundTaskTypeSchema = z.enum(['agent', 'bash']).openapi('BackgroundTaskType');
export type BackgroundTaskType = z.infer<typeof BackgroundTaskTypeSchema>;

export const BackgroundTaskStatusSchema = z
  .enum(['running', 'complete', 'error', 'stopped'])
  .openapi('BackgroundTaskStatus');
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatusSchema>;

// === Background Task Lifecycle Events ===

export const BackgroundTaskStartedEventSchema = z
  .object({
    taskId: z.string(),
    taskType: BackgroundTaskTypeSchema,
    startedAt: z.number(),
    subagentSessionId: z.string().optional(),
    toolUseId: z.string().optional(),
    description: z.string().optional(),
    command: z.string().optional(),
  })
  .openapi('BackgroundTaskStartedEvent');

export type BackgroundTaskStartedEvent = z.infer<typeof BackgroundTaskStartedEventSchema>;

export const BackgroundTaskProgressEventSchema = z
  .object({
    taskId: z.string(),
    toolUses: z.number().int().optional(),
    lastToolName: z.string().optional(),
    durationMs: z.number().int(),
    summary: z.string().optional(),
  })
  .openapi('BackgroundTaskProgressEvent');

export type BackgroundTaskProgressEvent = z.infer<typeof BackgroundTaskProgressEventSchema>;

export const BackgroundTaskDoneEventSchema = z
  .object({
    taskId: z.string(),
    status: z.enum(['completed', 'failed', 'stopped']),
    summary: z.string().optional(),
    toolUses: z.number().int().optional(),
    durationMs: z.number().int().optional(),
  })
  .openapi('BackgroundTaskDoneEvent');

export type BackgroundTaskDoneEvent = z.infer<typeof BackgroundTaskDoneEventSchema>;

/**
 * A forwarded text delta from a subagent's stream, emitted when the SDK
 * `forwardSubagentText` option is enabled (SDK 0.2.119+). `parentToolUseId`
 * correlates the delta to the originating background task — it matches the
 * `toolUseId` carried on the corresponding `background_task_started` event.
 */
export const SubagentTextDeltaEventSchema = z
  .object({
    parentToolUseId: z.string(),
    text: z.string(),
  })
  .openapi('SubagentTextDeltaEvent');

export type SubagentTextDeltaEvent = z.infer<typeof SubagentTextDeltaEventSchema>;

export const SystemStatusEventSchema = z
  .object({
    message: z.string(),
    /**
     * Raw SDK status value (SDK 0.2.108+ — e.g., `'requesting'`, `'compacting'`).
     * `message` carries a human-readable fallback for renderers that ignore this field.
     */
    status: z.string().optional(),
    /**
     * Terminal outcome of a compaction the in-flight `status` reported (SDK
     * `compact_result`). Present on the resolving status message so a client can
     * clear the "Compacting context…" state or surface a failure.
     */
    compactResult: z.enum(['success', 'failed']).optional(),
    /** Human-readable failure detail when `compactResult` is `'failed'` (SDK `compact_error`). */
    compactError: z.string().optional(),
  })
  .openapi('SystemStatusEvent');

export type SystemStatusEvent = z.infer<typeof SystemStatusEventSchema>;

/**
 * A single memory entry surfaced by the SDK — either a recalled file (with a real
 * path) or a synthesized summary (with a `<synthesis:DIR>` sentinel path and `content`).
 * Shared by the wire event (`MemoryRecallEventSchema`) and the rendered part
 * (`MemoryRecallPartSchema`).
 */
export const MemoryEntrySchema = z.object({
  /** Absolute path to the memory file, or `<synthesis:DIR>` sentinel when mode is 'synthesize'. */
  path: z.string(),
  scope: z.enum(['personal', 'team']),
  /** Synthesis paragraph. Only present when mode is 'synthesize'. */
  content: z.string().optional(),
});

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * Emitted when the SDK's memory recall supervisor surfaces memories into the turn
 * (SDK 0.2.105+). Mirrors `SDKMemoryRecallMessage`.
 */
export const MemoryRecallEventSchema = z
  .object({
    mode: z.enum(['select', 'synthesize']),
    memories: z.array(MemoryEntrySchema),
  })
  .openapi('MemoryRecallEvent');

export type MemoryRecallEvent = z.infer<typeof MemoryRecallEventSchema>;

/**
 * Emitted at a context-window compaction boundary (SDK `compact_boundary`).
 * Carries the SDK's `compact_metadata` so a renderer can show "Compacted — N
 * tokens summarized (manual/auto)". All fields are optional: the mapper forwards
 * only what the SDK supplies, and a malformed boundary still validates as `{}`
 * (the prior shape). `trigger` and `preTokens` are present in normal operation.
 */
export const CompactBoundaryEventSchema = z
  .object({
    /** What triggered compaction: `'manual'` (user ran /compact) or `'auto'` (context-pressure threshold). */
    trigger: z.enum(['manual', 'auto']).optional(),
    /** Context tokens occupying the window immediately before compaction. */
    preTokens: z.number().int().optional(),
    /** Context tokens remaining after the summary replaced the history. */
    postTokens: z.number().int().optional(),
    /** Wall-clock duration of the compaction, in milliseconds. */
    durationMs: z.number().int().optional(),
  })
  .openapi('CompactBoundaryEvent');

export type CompactBoundaryEvent = z.infer<typeof CompactBoundaryEventSchema>;

/**
 * Emitted when the SDK denies a tool call before it reaches `canUseTool` — most
 * notably an auto-mode safety classifier denial (`reasonType === 'classifier'`).
 * Mirrors `SDKPermissionDeniedMessage`. Rendered as a read-only denial chip.
 */
export const PermissionDeniedEventSchema = z
  .object({
    /** SDK tool-use id of the denied call. */
    toolCallId: z.string(),
    /** Name of the tool that was denied (e.g. `'Bash'`). */
    toolName: z.string(),
    /** Discriminator for why the call was denied (e.g. `'classifier'`, `'rule'`). */
    reasonType: z.string().optional(),
    /** Human-readable reason from the deciding component, when available. */
    reason: z.string().optional(),
    /** The rejection message returned to the model in the tool_result. */
    message: z.string(),
  })
  .openapi('PermissionDeniedEvent');

export type PermissionDeniedEvent = z.infer<typeof PermissionDeniedEventSchema>;

export const PromptSuggestionEventSchema = z
  .object({
    suggestions: z.array(z.string()),
  })
  .openapi('PromptSuggestionEvent');

export type PromptSuggestionEvent = z.infer<typeof PromptSuggestionEventSchema>;

export const HookStartedEventSchema = z
  .object({
    hookId: z.string(),
    hookName: z.string(),
    hookEvent: z.string(),
    toolCallId: z.string().nullable(),
  })
  .openapi('HookStartedEvent');

export type HookStartedEvent = z.infer<typeof HookStartedEventSchema>;

export const HookProgressEventSchema = z
  .object({
    hookId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .openapi('HookProgressEvent');

export type HookProgressEvent = z.infer<typeof HookProgressEventSchema>;

export const HookResponseEventSchema = z
  .object({
    hookId: z.string(),
    hookName: z.string(),
    exitCode: z.number().optional(),
    outcome: z.enum(['success', 'error', 'cancelled']),
    stdout: z.string(),
    stderr: z.string(),
  })
  .openapi('HookResponseEvent');

export type HookResponseEvent = z.infer<typeof HookResponseEventSchema>;

// === Presence Types ===

/** Authoritative SDK session state change (idle/running/requires_action). */
export const SdkSessionStateSchema = z.enum(['idle', 'running', 'requires_action']);
export type SdkSessionState = z.infer<typeof SdkSessionStateSchema>;

export const SessionStateChangedEventSchema = z
  .object({
    state: SdkSessionStateSchema,
  })
  .openapi('SessionStateChangedEvent');

export type SessionStateChangedEvent = z.infer<typeof SessionStateChangedEventSchema>;

export const ElicitationPromptEventSchema = z
  .object({
    interactionId: z.string(),
    serverName: z.string(),
    message: z.string(),
    mode: ElicitationModeSchema.optional(),
    url: z.string().optional(),
    elicitationId: z.string().optional(),
    requestedSchema: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().describe('Server-side elicitation timeout in milliseconds'),
    startedAt: z
      .number()
      .optional()
      .describe('Server timestamp when the elicitation timer started; present on recovery re-emit'),
    remainingMs: z
      .number()
      .optional()
      .describe(
        'Server-authoritative ms left before auto-deny; present on recovery re-emit so the countdown resumes without resetting'
      ),
  })
  .openapi('ElicitationPromptEvent');

export type ElicitationPromptEvent = z.infer<typeof ElicitationPromptEventSchema>;

export const ElicitationCompleteEventSchema = z
  .object({
    serverName: z.string(),
    elicitationId: z.string(),
  })
  .openapi('ElicitationCompleteEvent');

export type ElicitationCompleteEvent = z.infer<typeof ElicitationCompleteEventSchema>;

/**
 * A pending interaction (approval / question / elicitation) was cancelled
 * WITHOUT an operator action: the SDK aborted the gating tool call (e.g. a
 * mid-turn steered message superseded a pending AskUserQuestion) or the
 * interaction timed out. Lets the projection drop the card instead of leaving
 * an answerable ghost until expiry.
 */
export const InteractionCancelledEventSchema = z
  .object({
    interactionId: z.string(),
    reason: z.enum(['aborted', 'timeout']).optional(),
  })
  .openapi('InteractionCancelledEvent');

export type InteractionCancelledEvent = z.infer<typeof InteractionCancelledEventSchema>;

export const StreamEventSchema = z
  .object({
    type: StreamEventTypeSchema,
    data: z.union([
      TextDeltaSchema,
      ThinkingDeltaSchema,
      ToolCallEventSchema,
      ToolProgressEventSchema,
      ApprovalEventSchema,
      QuestionPromptEventSchema,
      ErrorEventSchema,
      RateLimitEventSchema,
      ApiRetryEventSchema,
      DoneEventSchema,
      SessionStatusEventSchema,
      TaskUpdateEventSchema,
      RelayReceiptEventSchema,
      MessageDeliveredEventSchema,
      RelayMessageEventSchema,
      BackgroundTaskStartedEventSchema,
      BackgroundTaskProgressEventSchema,
      BackgroundTaskDoneEventSchema,
      SubagentTextDeltaEventSchema,
      SystemStatusEventSchema,
      MemoryRecallEventSchema,
      CompactBoundaryEventSchema,
      PromptSuggestionEventSchema,
      HookStartedEventSchema,
      HookProgressEventSchema,
      HookResponseEventSchema,
      SessionStateChangedEventSchema,
      ContextUsageSchema,
      UsageInfoSchema,
      ElicitationPromptEventSchema,
      ElicitationCompleteEventSchema,
      PermissionDeniedEventSchema,
      InteractionCancelledEventSchema,
    ]),
  })
  .openapi('StreamEvent');

export type StreamEvent = z.infer<typeof StreamEventSchema>;

// === Message Part Types ===

export const TextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .openapi('TextPart');

export type TextPart = z.infer<typeof TextPartSchema>;

export const HookStatusSchema = z.enum(['running', 'success', 'error', 'cancelled']);

export type HookStatus = z.infer<typeof HookStatusSchema>;

export const HookPartSchema = z.object({
  hookId: z.string(),
  hookName: z.string(),
  hookEvent: z.string(),
  status: HookStatusSchema,
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().optional(),
});

export type HookPart = z.infer<typeof HookPartSchema>;

export const ToolCallPartSchema = z
  .object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string().optional(),
    result: z.string().optional(),
    progressOutput: z.string().optional(),
    status: ToolCallStatusSchema,
    interactiveType: z.enum(['approval', 'question']).optional(),
    questions: z.array(QuestionItemSchema).optional(),
    answers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().optional().describe('Approval timeout duration in milliseconds'),
    /** Server timestamp (ms since epoch) when the approval timer started. Used for drift-free countdown. */
    approvalStartedAt: z.number().optional(),
    /**
     * Server-authoritative ms left before auto-deny, present on recovery re-emit/pull.
     * When set, the countdown derives its deadline as `Date.now() + approvalRemainingMs`
     * so a reconnect resumes at the true offset instead of resetting from
     * `approvalStartedAt + timeoutMs`. Covers both `approval` and `question` interactions
     * (both ride on this tool_call part). Client-only — never serialized to the transcript.
     */
    approvalRemainingMs: z.number().optional(),
    // SDK-provided rich context for approval UI
    approvalTitle: z.string().optional().describe('Full permission prompt sentence from SDK'),
    approvalDisplayName: z.string().optional().describe('Short noun phrase for the tool action'),
    approvalDescription: z.string().optional().describe('Human-readable subtitle from SDK'),
    approvalBlockedPath: z.string().optional().describe('File path that triggered the permission'),
    approvalDecisionReason: z
      .string()
      .optional()
      .describe('Why this permission request was triggered'),
    approvalHasSuggestions: z.boolean().optional().describe('Whether "Always Allow" is available'),
    hooks: z.array(HookPartSchema).optional(),
    /** Client-only: timestamp (ms since epoch) when tool_call_start was received. Never serialized. */
    startedAt: z.number().optional(),
    /** Client-only: timestamp (ms since epoch) when tool_result was received. Never serialized. */
    completedAt: z.number().optional(),
  })
  .openapi('ToolCallPart');

export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

// === Background Task Part (agent and bash) ===

export const BackgroundTaskPartSchema = z
  .object({
    type: z.literal('background_task'),
    taskId: z.string(),
    taskType: BackgroundTaskTypeSchema,
    status: BackgroundTaskStatusSchema,
    startedAt: z.number(),
    // Agent-specific
    description: z.string().optional(),
    toolUses: z.number().int().optional(),
    lastToolName: z.string().optional(),
    summary: z.string().optional(),
    /**
     * Tool-use id of the Task tool call that spawned this subagent. Used to
     * correlate forwarded `subagent_text_delta` events (which carry the same id
     * as `parentToolUseId`) back to this task. Only present for agent tasks.
     */
    toolUseId: z.string().optional(),
    /**
     * Live-streamed subagent text, accumulated from forwarded `subagent_text_delta`
     * events while the subagent runs (SDK `forwardSubagentText`). Client-only —
     * not persisted to the transcript, so it is absent on session reload.
     */
    subagentText: z.string().optional(),
    // Bash-specific
    command: z.string().optional(),
    // Shared
    durationMs: z.number().int().optional(),
  })
  .openapi('BackgroundTaskPart');

export type BackgroundTaskPart = z.infer<typeof BackgroundTaskPartSchema>;

export const ThinkingPartSchema = z
  .object({
    type: z.literal('thinking'),
    text: z.string(),
    isStreaming: z.boolean().optional(),
    elapsedMs: z.number().int().optional(),
  })
  .openapi('ThinkingPart');

export type ThinkingPart = z.infer<typeof ThinkingPartSchema>;

export const ErrorPartSchema = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorPart');

export type ErrorPart = z.infer<typeof ErrorPartSchema>;

export const ElicitationPartSchema = z
  .object({
    type: z.literal('elicitation'),
    interactionId: z.string(),
    serverName: z.string(),
    message: z.string(),
    mode: ElicitationModeSchema.optional(),
    url: z.string().optional(),
    elicitationId: z.string().optional(),
    requestedSchema: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['pending', 'submitted', 'complete']),
    action: ElicitationActionSchema.optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    /** Server timestamp (ms since epoch) when the elicitation timer started; present on recovery re-emit/pull. */
    startedAt: z.number().optional(),
    /**
     * Server-authoritative ms left before auto-deny, present on recovery re-emit/pull.
     * When set, a reconnect resumes the countdown at the true offset instead of
     * resetting. Client-only — never serialized to the transcript.
     */
    remainingMs: z.number().optional(),
  })
  .openapi('ElicitationPart');

export type ElicitationPart = z.infer<typeof ElicitationPartSchema>;

/**
 * A message part representing a memory recall event surfaced by the SDK's
 * memory supervisor. Rendered as a collapsible indicator in the chat timeline.
 */
export const MemoryRecallPartSchema = z
  .object({
    type: z.literal('memory_recall'),
    mode: z.enum(['select', 'synthesize']),
    memories: z.array(MemoryEntrySchema),
    /** Mirrors ThinkingPartSchema — drives auto-collapse in MemoryRecallBlock when streaming ends. */
    isStreaming: z.boolean().optional(),
  })
  .openapi('MemoryRecallPart');

/** Inferred type for {@link MemoryRecallPartSchema}. */
export type MemoryRecallPart = z.infer<typeof MemoryRecallPartSchema>;

/**
 * A read-only chip in the message stream marking a tool call that was denied
 * before execution (e.g. by the auto-mode safety classifier). Distinct from a
 * user-issued denial — it carries no actions and offers no re-approval path.
 * Sourced from the `permission_denied` StreamEvent.
 */
export const PermissionDeniedPartSchema = z
  .object({
    type: z.literal('permission_denied'),
    /** SDK tool-use id of the denied call. */
    toolCallId: z.string(),
    /** Name of the tool that was denied (e.g. `'Bash'`). */
    toolName: z.string(),
    /** Discriminator for why the call was denied (e.g. `'classifier'`, `'rule'`). */
    reasonType: z.string().optional(),
    /** Human-readable reason from the deciding component, when available. */
    reason: z.string().optional(),
    /** The rejection message returned to the model in the tool_result. */
    message: z.string(),
  })
  .openapi('PermissionDeniedPart');

/** Inferred type for {@link PermissionDeniedPartSchema}. */
export type PermissionDeniedPart = z.infer<typeof PermissionDeniedPartSchema>;

/**
 * An inline row in the message stream marking a context-window compaction.
 * Sourced from the `compact_boundary` session event on success (carrying the
 * SDK `compact_metadata`), or synthesized from a `system_status`
 * `compactResult: 'failed'` on failure (no boundary fires). The renderer shows
 * "Compacted — N tokens summarized (manual/auto)" or, when `failed`, an error
 * surface carrying `error`.
 */
export const CompactBoundaryPartSchema = z
  .object({
    type: z.literal('compact_boundary'),
    /** What triggered compaction: `'manual'` (user ran /compact) or `'auto'` (context pressure). */
    trigger: z.enum(['manual', 'auto']).optional(),
    /** Context tokens occupying the window immediately before compaction. */
    preTokens: z.number().int().optional(),
    /** Context tokens remaining after the summary replaced the history. */
    postTokens: z.number().int().optional(),
    /** Wall-clock duration of the compaction, in milliseconds. */
    durationMs: z.number().int().optional(),
    /** Set when compaction failed — the row renders as an error surface. */
    failed: z.boolean().optional(),
    /** Human-readable failure detail (SDK `compact_error`); present when `failed`. */
    error: z.string().optional(),
  })
  .openapi('CompactBoundaryPart');

/** Inferred type for {@link CompactBoundaryPartSchema}. */
export type CompactBoundaryPart = z.infer<typeof CompactBoundaryPartSchema>;

export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  BackgroundTaskPartSchema,
  ThinkingPartSchema,
  ErrorPartSchema,
  ElicitationPartSchema,
  MemoryRecallPartSchema,
  PermissionDeniedPartSchema,
  CompactBoundaryPartSchema,
]);

export type MessagePart = z.infer<typeof MessagePartSchema>;

// === Message Type ===

export const MessageTypeSchema = z
  .enum(['command', 'compaction', 'local_command_output'])
  .openapi('MessageType');

export type MessageType = z.infer<typeof MessageTypeSchema>;

// === Chat History Types ===

export const HistoryToolCallSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string().optional(),
    result: z.string().optional(),
    progressOutput: z.string().optional(),
    status: z.literal('complete'),
    questions: z.array(QuestionItemSchema).optional(),
    answers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('HistoryToolCall');

export type HistoryToolCall = z.infer<typeof HistoryToolCallSchema>;

/**
 * Metadata describing a context-window compaction, captured from the durable
 * transcript's `compact_boundary` system record (SDK `compactMetadata`) and
 * attached to the `compaction` history message so the renderer can show
 * "Context compacted · N tokens · manual". All fields are optional — an older
 * transcript without the boundary record (or a malformed one) still yields a
 * bare `compaction` row.
 */
export const CompactMetadataSchema = z
  .object({
    /** What triggered compaction: `'manual'` (user ran /compact) or `'auto'` (context pressure). */
    trigger: z.enum(['manual', 'auto']).optional(),
    /** Context tokens occupying the window immediately before compaction. */
    preTokens: z.number().int().optional(),
    /** Context tokens remaining after the summary replaced the history. */
    postTokens: z.number().int().optional(),
    /** Wall-clock duration of the compaction, in milliseconds. */
    durationMs: z.number().int().optional(),
  })
  .openapi('CompactMetadata');

/** Inferred type for {@link CompactMetadataSchema}. */
export type CompactMetadata = z.infer<typeof CompactMetadataSchema>;

export const HistoryMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    toolCalls: z.array(HistoryToolCallSchema).optional(),
    parts: z.array(MessagePartSchema).optional(),
    timestamp: z.string().optional(),
    messageType: MessageTypeSchema.optional(),
    /** Compaction metadata — present on `compaction` messages when the transcript records the boundary. */
    compactMetadata: CompactMetadataSchema.optional(),
    commandName: z.string().optional(),
    commandArgs: z.string().optional(),
  })
  .openapi('HistoryMessage');

export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

// === Command Types ===

export const CommandEntrySchema = z
  .object({
    namespace: z.string().optional(),
    command: z.string().optional(),
    fullCommand: z.string(),
    description: z.string(),
    argumentHint: z.string().optional(),
    /**
     * Alternate names that resolve to this command (SDK `SlashCommand.aliases`,
     * e.g. `/cost` and `/stats` both resolve to `/usage`). The palette includes
     * these in its fuzzy match so any agent's command vocabulary works (DOR-108).
     */
    aliases: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    filePath: z.string().optional(),
  })
  .openapi('CommandEntry');

export type CommandEntry = z.infer<typeof CommandEntrySchema>;

export const CommandRegistrySchema = z
  .object({
    commands: z.array(CommandEntrySchema),
    lastScanned: z.string(),
  })
  .openapi('CommandRegistry');

export type CommandRegistry = z.infer<typeof CommandRegistrySchema>;

// === File Listing Types ===

export const FileListQuerySchema = z
  .object({
    cwd: z.string().min(1),
  })
  .openapi('FileListQuery');

export type FileListQuery = z.infer<typeof FileListQuerySchema>;

export const FileListResponseSchema = z
  .object({
    files: z.array(z.string()),
    truncated: z.boolean(),
    total: z.number().int(),
  })
  .openapi('FileListResponse');

export type FileListResponse = z.infer<typeof FileListResponseSchema>;

// === File Write (canvas file-backed editing) ===

/**
 * Request to write content back to an existing file within a session's working
 * directory. Used by the editable markdown canvas. `path` is resolved against
 * `cwd` and confined to it server-side; the file must already exist (this never
 * creates files). When `expectedHash` is present the write is conditional
 * (optimistic concurrency): the server rejects with 409 if the on-disk content
 * hashes differently, i.e. it changed since the client loaded it. Omit
 * `expectedHash` to force an unconditional overwrite.
 */
export const WriteFileRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    /** SHA-256 the write is conditional on (used once the client has a hash). */
    expectedHash: z.string().optional(),
    /**
     * Baseline content the write is conditional on, when the client has no hash
     * yet (the first save). The server hashes it — this keeps all hashing
     * server-side so the client needs no `crypto.subtle` (unavailable on
     * insecure origins). Ignored if `expectedHash` is also present.
     */
    expectedContent: z.string().optional(),
  })
  .openapi('WriteFileRequest');

export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

/** Result of a successful file write: the SHA-256 of the bytes now on disk. */
export const WriteFileResponseSchema = z
  .object({
    ok: z.literal(true),
    hash: z.string(),
  })
  .openapi('WriteFileResponse');

export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>;

// === Directory Browsing Types ===

export const BrowseDirectoryQuerySchema = z
  .object({
    path: z.string().min(1).optional(),
    showHidden: z.coerce.boolean().optional().default(false),
  })
  .openapi('BrowseDirectoryQuery');

export type BrowseDirectoryQuery = z.infer<typeof BrowseDirectoryQuerySchema>;

export const DirectoryEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    isDirectory: z.boolean(),
  })
  .openapi('DirectoryEntry');

export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const BrowseDirectoryResponseSchema = z
  .object({
    path: z.string(),
    entries: z.array(DirectoryEntrySchema),
    parent: z.string().nullable(),
  })
  .openapi('BrowseDirectoryResponse');

export type BrowseDirectoryResponse = z.infer<typeof BrowseDirectoryResponseSchema>;

// === Tunnel Status ===

export const TunnelStatusSchema = z
  .object({
    enabled: z.boolean(),
    connected: z.boolean(),
    url: z.string().nullable(),
    port: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    authEnabled: z.boolean(),
    tokenConfigured: z.boolean(),
    domain: z.string().nullable(),
    passcodeEnabled: z.boolean(),
  })
  .openapi('TunnelStatus');

export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const PasscodeVerifyRequestSchema = z.object({
  passcode: z.string().regex(/^\d{6}$/),
});
export type PasscodeVerifyRequest = z.infer<typeof PasscodeVerifyRequestSchema>;

export const PasscodeVerifyResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  retryAfter: z.number().optional(),
});
export type PasscodeVerifyResponse = z.infer<typeof PasscodeVerifyResponseSchema>;

export const PasscodeSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  passcodeRequired: z.boolean(),
});
export type PasscodeSessionResponse = z.infer<typeof PasscodeSessionResponseSchema>;

// === Health Response ===

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    uptime: z.number(),
    tunnel: TunnelStatusSchema.optional(),
  })
  .openapi('HealthResponse');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// === Server Config ===

export const ServerConfigSchema = z
  .object({
    version: z.string().openapi({ description: 'Current server version' }),
    latestVersion: z.string().nullable().openapi({
      description: 'Latest available version from npm, or null if dev mode or unknown',
    }),
    isDevMode: z
      .boolean()
      .openapi({ description: 'Whether the server is running a development build' }),
    dismissedUpgradeVersions: z
      .array(z.string())
      .openapi({ description: 'Versions the user has dismissed upgrade notifications for' }),
    port: z.number().int(),
    uptime: z.number(),
    workingDirectory: z.string(),
    nodeVersion: z.string(),
    claudeCliPath: z.string().nullable(),
    tunnel: TunnelStatusSchema,
    tasks: z
      .object({
        enabled: z.boolean().openapi({ description: 'Whether the Tasks scheduler is enabled' }),
        initError: z
          .string()
          .optional()
          .openapi({ description: 'Initialization error message, if scheduler failed to start' }),
      })
      .optional()
      .openapi({ description: 'Tasks scheduler feature state' }),
    relay: z
      .object({
        enabled: z.boolean().openapi({ description: 'Whether the Relay message bus is enabled' }),
        initError: z
          .string()
          .optional()
          .openapi({ description: 'Initialization error message, if relay failed to start' }),
      })
      .optional()
      .openapi({ description: 'Relay message bus feature state' }),
    scheduler: z
      .object({
        maxConcurrentRuns: z
          .number()
          .int()
          .openapi({ description: 'Maximum concurrent task runs (1-10)' }),
        timezone: z.string().nullable().openapi({
          description: 'IANA timezone for cron expressions, or null for system default',
        }),
        retentionCount: z
          .number()
          .int()
          .openapi({ description: 'Number of task run history records to retain' }),
      })
      .optional()
      .openapi({ description: 'Task scheduler configuration' }),
    logging: z
      .object({
        level: z
          .string()
          .openapi({ description: 'Log verbosity level (fatal, error, warn, info, debug, trace)' }),
        maxLogSizeKb: z
          .number()
          .int()
          .openapi({ description: 'Maximum log file size in KB before rotation' }),
        maxLogFiles: z
          .number()
          .int()
          .openapi({ description: 'Number of rotated log files to retain' }),
      })
      .optional()
      .openapi({ description: 'Logging configuration' }),
    boundary: z
      .string()
      .openapi({ description: 'Server boundary path (home directory or configured boundary)' }),
    dorkHome: z
      .string()
      .openapi({ description: 'Data directory path (~/.dork or configured DORK_HOME)' }),
    mesh: z
      .object({
        enabled: z
          .boolean()
          .openapi({ description: 'Whether the Mesh agent discovery subsystem is enabled' }),
        scanRoots: z
          .array(z.string())
          .optional()
          .openapi({ description: 'User-configured scan roots for agent discovery' }),
        initError: z
          .string()
          .optional()
          .openapi({ description: 'Initialization error message, if mesh failed to start' }),
      })
      .optional()
      .openapi({ description: 'Mesh agent discovery feature state' }),
    onboarding: z
      .object({
        completedSteps: z
          .array(z.string())
          .openapi({ description: 'Steps the user has completed' }),
        skippedSteps: z.array(z.string()).openapi({ description: 'Steps the user has skipped' }),
        startedAt: z
          .string()
          .nullable()
          .openapi({ description: 'ISO timestamp when onboarding was started' }),
        dismissedAt: z
          .string()
          .nullable()
          .openapi({ description: 'ISO timestamp when onboarding was dismissed' }),
      })
      .optional()
      .openapi({ description: 'First-time user onboarding state' }),
    agentContext: z
      .object({
        relayTools: z
          .boolean()
          .openapi({ description: 'Whether relay tool context is injected into agent prompts' }),
        meshTools: z
          .boolean()
          .openapi({ description: 'Whether mesh tool context is injected into agent prompts' }),
        adapterTools: z
          .boolean()
          .openapi({ description: 'Whether adapter tool context is injected into agent prompts' }),
        tasksTools: z
          .boolean()
          .openapi({ description: 'Whether tasks tool context is injected into agent prompts' }),
      })
      .optional()
      .openapi({ description: 'Agent tool context injection toggles' }),
    agents: z
      .object({
        defaultDirectory: z
          .string()
          .openapi({ description: 'Default directory for agent workspaces' }),
        defaultAgent: z
          .string()
          .openapi({ description: 'Slug of the default agent to launch after onboarding' }),
      })
      .optional()
      .openapi({ description: 'Agent creation and defaults configuration' }),
    mcp: z
      .object({
        enabled: z.boolean().openapi({
          description: 'Whether the external MCP server accepts requests',
        }),
        authConfigured: z.boolean().openapi({
          description: 'True when MCP access is gated (MCP_API_KEY env var or per-user API keys)',
        }),
        authSource: z.enum(['env', 'user-keys', 'none']).openapi({
          description:
            "How MCP access is secured: 'env' (MCP_API_KEY override), 'user-keys' (per-user Better Auth API keys), or 'none' (localhost-only)",
        }),
        endpoint: z.string().openapi({
          description: 'Full URL of the external MCP endpoint',
        }),
        rateLimit: z.object({
          enabled: z.boolean(),
          maxPerWindow: z.number().int(),
          windowSecs: z.number().int(),
        }),
      })
      .optional()
      .openapi({ description: 'External MCP server access control status' }),
    telemetry: z
      .object({
        enabled: z.boolean().openapi({
          description: 'Whether marketplace install telemetry is opted in',
        }),
        userHasDecided: z.boolean().openapi({
          description: 'True once the user has explicitly chosen (banner stops appearing)',
        }),
      })
      .optional()
      .openapi({ description: 'Marketplace telemetry consent state' }),
    auth: z
      .object({
        enabled: z.boolean().openapi({
          description: 'Whether local owner login is required to reach the API and MCP endpoints',
        }),
      })
      .optional()
      .openapi({ description: 'Local login (Better Auth) state' }),
  })
  .openapi('ServerConfig');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// === Model Options ===

export const ModelOptionSchema = z
  .object({
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    displayName: z.string().openapi({ description: 'Human-readable model name' }),
    description: z.string().openapi({ description: 'Short model description' }),
    isDefault: z.boolean().optional().openapi({ description: 'Whether this is the default model' }),
    contextWindow: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'Context window size in tokens' }),
    supportsEffort: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports effort levels' }),
    supportedEffortLevels: z
      .array(EffortLevelSchema)
      .optional()
      .openapi({ description: 'Available effort levels for this model' }),
    supportsFastMode: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports fast mode' }),
    supportsAutoMode: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports auto mode' }),
    supportsAdaptiveThinking: z
      .boolean()
      .optional()
      .openapi({ description: 'Claude decides when and how much to think' }),
    maxOutputTokens: z.number().int().optional().openapi({ description: 'Maximum output tokens' }),
    provider: z
      .string()
      .optional()
      .openapi({ description: 'Provider identifier (e.g. anthropic, openai)' }),
    family: z.string().optional().openapi({ description: 'Model family (e.g. claude-4, gpt-5)' }),
    tier: z
      .enum(['flagship', 'balanced', 'fast', 'specialized', 'legacy'])
      .optional()
      .openapi({ description: 'Model tier for UI grouping' }),
    supportsVision: z.boolean().optional(),
    supportsToolUse: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsCodeExecution: z.boolean().optional(),
    isDeprecated: z.boolean().optional(),
  })
  .openapi('ModelOption');

export type ModelOption = z.infer<typeof ModelOptionSchema>;

// === Subagent Info ===

export const SubagentInfoSchema = z
  .object({
    name: z.string().openapi({ description: 'Agent type identifier (e.g. "Explore")' }),
    description: z.string().openapi({ description: 'Description of when to use this agent' }),
    model: z
      .string()
      .optional()
      .openapi({ description: 'Model alias this agent uses, or undefined to inherit parent' }),
  })
  .openapi('SubagentInfo');

export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

// === Git Status ===

export const GitStatusResponseSchema = z
  .object({
    branch: z.string().describe('Current branch name or HEAD SHA if detached'),
    ahead: z.number().int().describe('Commits ahead of remote tracking branch'),
    behind: z.number().int().describe('Commits behind remote tracking branch'),
    modified: z.number().int().describe('Count of modified files (staged + unstaged)'),
    staged: z.number().int().describe('Count of staged files'),
    untracked: z.number().int().describe('Count of untracked files'),
    conflicted: z.number().int().describe('Count of files with merge conflicts'),
    clean: z.boolean().describe('True if working directory is clean'),
    detached: z.boolean().describe('True if HEAD is detached'),
    tracking: z.string().nullable().describe('Remote tracking branch name'),
  })
  .openapi('GitStatusResponse');

export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

export const GitStatusErrorSchema = z
  .object({
    error: z.literal('not_git_repo'),
  })
  .openapi('GitStatusError');

export type GitStatusError = z.infer<typeof GitStatusErrorSchema>;

// === Error Response ===

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.any().optional(),
  })
  .openapi('ErrorResponse');

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const SessionLockedErrorSchema = z
  .object({
    error: z.literal('Session locked'),
    code: z.literal('SESSION_LOCKED'),
    lockedBy: z.string(),
    lockedAt: z.string(),
  })
  .openapi('SessionLockedError');

export type SessionLockedError = z.infer<typeof SessionLockedErrorSchema>;

// === Tasks Scheduler Types ===

export const TaskStatusSchema = z
  .enum(['active', 'paused', 'pending_approval'])
  .openapi('TaskStatus');

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRunStatusSchema = z
  .enum(['running', 'completed', 'failed', 'cancelled'])
  .openapi('TaskRunStatus');

export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;

export const TaskRunTriggerSchema = z
  .enum(['scheduled', 'manual', 'agent'])
  .openapi('TaskRunTrigger');

export type TaskRunTrigger = z.infer<typeof TaskRunTriggerSchema>;

export const TaskSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    prompt: z.string(),
    cron: z.string().nullable(),
    timezone: z.string().nullable(),
    agentId: z.string().nullable().default(null),
    enabled: z.boolean(),
    maxRuntime: z.number().int().nullable(),
    permissionMode: PermissionModeSchema,
    status: TaskStatusSchema,
    filePath: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    nextRun: z.string().nullable().optional(),
  })
  .openapi('Task');

export type Task = z.infer<typeof TaskSchema>;

export const TaskRunSchema = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    status: TaskRunStatusSchema,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    outputSummary: z.string().nullable(),
    error: z.string().nullable(),
    sessionId: z.string().nullable(),
    trigger: TaskRunTriggerSchema,
    createdAt: z.string(),
  })
  .openapi('TaskRun');

export type TaskRun = z.infer<typeof TaskRunSchema>;

export const TaskTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string(),
    prompt: z.string(),
    cron: z.string(),
    timezone: z.string().optional(),
  })
  .openapi('TaskTemplate');

export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

export const CreateTaskRequestSchema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().optional(),
    description: z.string().min(1),
    prompt: z.string().min(1),
    cron: z.string().min(1).nullable().optional(),
    timezone: z.string().nullable().optional(),
    target: z.string().min(1),
    enabled: z.boolean().optional().default(true),
    maxRuntime: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional().default('acceptEdits'),
  })
  .openapi('CreateTaskRequest');

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** Input type for creating a schedule (before Zod defaults are applied). */
export type CreateTaskInput = z.input<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    displayName: z.string().nullable().optional(),
    description: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    cron: z.string().min(1).nullable().optional(),
    timezone: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    maxRuntime: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    status: TaskStatusSchema.optional(),
  })
  .openapi('UpdateTaskRequest');

export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const ListTaskRunsQuerySchema = z
  .object({
    scheduleId: z.string().optional(),
    status: TaskRunStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi('ListTaskRunsQuery');

export type ListTaskRunsQuery = z.infer<typeof ListTaskRunsQuerySchema>;

// === Config PATCH Schemas ===

export const ConfigPatchRequestSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1024).max(65535).optional(),
        cwd: z.string().nullable().optional(),
      })
      .optional(),
    tunnel: z
      .object({
        enabled: z.boolean().optional(),
        domain: z.string().nullable().optional(),
        authtoken: z.string().nullable().optional(),
        auth: z.string().nullable().optional(),
      })
      .optional(),
    ui: z
      .object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
      })
      .optional(),
  })
  .openapi('ConfigPatchRequest');

export type ConfigPatchRequest = z.infer<typeof ConfigPatchRequestSchema>;

export const ConfigPatchResponseSchema = z
  .object({
    success: z.boolean(),
    config: z.object({
      version: z.literal(1),
      server: z.object({ port: z.number(), cwd: z.string().nullable() }),
      tunnel: z.object({
        enabled: z.boolean(),
        domain: z.string().nullable(),
        authtoken: z.string().nullable(),
        auth: z.string().nullable(),
      }),
      ui: z.object({ theme: z.enum(['light', 'dark', 'system']) }),
    }),
    warnings: z.array(z.string()).optional(),
  })
  .openapi('ConfigPatchResponse');

export type ConfigPatchResponse = z.infer<typeof ConfigPatchResponseSchema>;

// === Upload Schemas ===

export const UploadResultSchema = z
  .object({
    originalName: z.string(),
    savedPath: z.string(),
    filename: z.string(),
    size: z.number().int().nonnegative(),
    mimeType: z.string(),
  })
  .openapi('UploadResult');

export type UploadResult = z.infer<typeof UploadResultSchema>;

export const UploadResponseSchema = z
  .object({
    uploads: z.array(UploadResultSchema),
  })
  .openapi('UploadResponse');

export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const UploadProgressSchema = z.object({
  loaded: z.number(),
  total: z.number(),
  percentage: z.number(),
});

export type UploadProgress = z.infer<typeof UploadProgressSchema>;

// === UI Control Schemas ===

/**
 * Content that can be rendered in the agent-controlled canvas panel.
 * Discriminated on `type` — note each variant's payload key differs:
 * - `{ type: 'markdown', content: string, title?, sourcePath? }` — markdown text goes in `content`; `sourcePath` makes it an editable, file-backed surface
 * - `{ type: 'url', url: string, title?, sandbox? }`
 * - `{ type: 'json', data: unknown, title? }`
 */
export const UiCanvasContentSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('url'),
      url: z.string().url(),
      title: z.string().optional(),
      sandbox: z.string().optional(),
    }),
    z.object({
      type: z.literal('markdown'),
      content: z.string(),
      title: z.string().optional(),
      /**
       * Path of the file this markdown was read from, when the agent opened a
       * file (vs. generating the content inline). Workspace-relative or absolute;
       * the server resolves and confines it to the session's working directory on
       * write. Its presence is what makes the canvas an editable, file-backed
       * surface — edits save back to this path. Absent ⇒ read-only (no save
       * sink, so no edit affordance). See the canvas file-backed editing ADR.
       */
      sourcePath: z.string().optional(),
    }),
    z.object({
      type: z.literal('json'),
      data: z.unknown(),
      title: z.string().optional(),
    }),
  ])
  .openapi('UiCanvasContent');

export type UiCanvasContent = z.infer<typeof UiCanvasContentSchema>;

/** Identifies a named panel in the DorkOS UI. */
export const UiPanelIdSchema = z
  .enum(['settings', 'tasks', 'relay', 'picker'])
  .openapi('UiPanelId');

export type UiPanelId = z.infer<typeof UiPanelIdSchema>;

/** Identifies a tab in the sidebar navigation. */
export const UiSidebarTabSchema = z
  .enum(['overview', 'sessions', 'schedules', 'connections'])
  .openapi('UiSidebarTab');

export type UiSidebarTab = z.infer<typeof UiSidebarTabSchema>;

/** Severity level for agent-emitted toast notifications. */
export const UiToastLevelSchema = z
  .enum(['success', 'error', 'info', 'warning'])
  .openapi('UiToastLevel');

export type UiToastLevel = z.infer<typeof UiToastLevelSchema>;

/**
 * A command issued by an agent to mutate the DorkOS client UI.
 * Discriminated on `action` — 14 variants covering panels, sidebar, canvas,
 * notifications, theme, scroll, agent switching, and command palette.
 */
export const UiCommandSchema = z
  .discriminatedUnion('action', [
    // Panel commands
    z.object({ action: z.literal('open_panel'), panel: UiPanelIdSchema }),
    z.object({ action: z.literal('close_panel'), panel: UiPanelIdSchema }),
    z.object({ action: z.literal('toggle_panel'), panel: UiPanelIdSchema }),

    // Sidebar commands
    z.object({ action: z.literal('open_sidebar') }),
    z.object({ action: z.literal('close_sidebar') }),
    z.object({ action: z.literal('switch_sidebar_tab'), tab: UiSidebarTabSchema }),

    // Canvas commands
    z.object({
      action: z.literal('open_canvas'),
      content: UiCanvasContentSchema.optional(),
      preferredWidth: z.number().min(20).max(80).optional(),
    }),
    z.object({
      action: z.literal('update_canvas'),
      content: UiCanvasContentSchema,
    }),
    z.object({ action: z.literal('close_canvas') }),

    // Notification
    z.object({
      action: z.literal('show_toast'),
      message: z.string().max(500),
      level: UiToastLevelSchema.default('info'),
      description: z.string().max(1000).optional(),
    }),

    // Theme
    z.object({
      action: z.literal('set_theme'),
      theme: z.enum(['light', 'dark']),
    }),

    // Scroll
    z.object({
      action: z.literal('scroll_to_message'),
      messageId: z.string().optional(),
    }),

    // Agent switching
    z.object({
      action: z.literal('switch_agent'),
      cwd: z.string(),
    }),

    // Command palette
    z.object({ action: z.literal('open_command_palette') }),
  ])
  .openapi('UiCommand');

export type UiCommand = z.infer<typeof UiCommandSchema>;

/**
 * Payload of an agent-issued UI command (the `control_ui` MCP tool).
 *
 * Typeless like the other event payloads (e.g. {@link MemoryRecallEventSchema}):
 * the `type: 'ui_command'` discriminant lives on the enclosing event, so this is
 * reused as the `data` shape of the runtime `StreamEvent` and spread into the
 * `ui_command` member of the runtime-neutral `SessionEvent` contract
 * (`{ seq, type: 'ui_command', command }`).
 */
export const UiCommandEventSchema = z
  .object({
    command: UiCommandSchema,
  })
  .openapi('UiCommandEvent');

export type UiCommandEvent = z.infer<typeof UiCommandEventSchema>;

/**
 * Client UI state reported back to the agent via the Transport layer.
 * Gives agents situational awareness of what is visible and active.
 */
export const UiStateSchema = z
  .object({
    canvas: z.object({
      open: z.boolean(),
      contentType: z.enum(['url', 'markdown', 'json']).nullable(),
    }),
    panels: z.object({
      settings: z.boolean(),
      tasks: z.boolean(),
      relay: z.boolean(),
    }),
    sidebar: z.object({
      open: z.boolean(),
      activeTab: UiSidebarTabSchema.nullable(),
    }),
    agent: z.object({
      id: z.string().nullable(),
      cwd: z.string().nullable(),
    }),
  })
  .openapi('UiState');

export type UiState = z.infer<typeof UiStateSchema>;
