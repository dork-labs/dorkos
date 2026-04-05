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

extendZodWithOpenApi(z);

// === Enums ===

export const PermissionModeSchema = z
  .enum(['default', 'plan', 'acceptEdits', 'bypassPermissions'])
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
    'sync_update',
    'sync_connected',
    'relay_receipt',
    'message_delivered',
    'relay_message',
    'thinking_delta',
    'background_task_started',
    'background_task_progress',
    'background_task_done',
    'system_status',
    'compact_boundary',
    'prompt_suggestion',
    'hook_started',
    'hook_progress',
    'hook_response',
    'presence_update',
    'ui_command',
    'session_state_changed',
    'context_usage',
    'usage_info',
    'elicitation_prompt',
    'elicitation_complete',
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

export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'max']).openapi('EffortLevel');
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastMessagePreview: z.string().optional(),
    permissionMode: PermissionModeSchema,
    model: z.string().optional(),
    effort: EffortLevelSchema.optional(),
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

export const UpdateSessionRequestSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    model: z.string().optional(),
    effort: EffortLevelSchema.optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .openapi('UpdateSessionRequest');

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
    /** Client UI state snapshot — validated against UiStateSchema via z.lazy (forward ref). */
    uiState: z.lazy(() => UiStateSchema).optional(),
  })
  .openapi('SendMessageRequest');

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const ApprovalRequestSchema = z
  .object({
    toolCallId: z.string(),
  })
  .openapi('ApprovalRequest');

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

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
  })
  .openapi('ListSessionsQuery');

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const CommandsQuerySchema = z
  .object({
    refresh: z.enum(['true', 'false']).optional(),
    cwd: z.string().optional(),
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
  })
  .openapi('ApprovalEvent');

export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const QuestionPromptEventSchema = z
  .object({
    toolCallId: z.string(),
    questions: z.array(QuestionItemSchema),
  })
  .openapi('QuestionPromptEvent');

export type QuestionPromptEvent = z.infer<typeof QuestionPromptEventSchema>;

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

export const SyncUpdateEventSchema = z
  .object({
    sessionId: z.string(),
    timestamp: z.string(),
  })
  .openapi('SyncUpdateEvent');

export type SyncUpdateEvent = z.infer<typeof SyncUpdateEventSchema>;

export const SyncConnectedEventSchema = z
  .object({
    sessionId: z.string(),
  })
  .openapi('SyncConnectedEvent');

export type SyncConnectedEvent = z.infer<typeof SyncConnectedEventSchema>;

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

export const SystemStatusEventSchema = z
  .object({
    message: z.string(),
  })
  .openapi('SystemStatusEvent');

export type SystemStatusEvent = z.infer<typeof SystemStatusEventSchema>;

export const CompactBoundaryEventSchema = z.object({}).openapi('CompactBoundaryEvent');

export type CompactBoundaryEvent = z.infer<typeof CompactBoundaryEventSchema>;

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

export const PresenceClientSchema = z.object({
  type: z.enum(['web', 'obsidian', 'mcp', 'unknown']),
  connectedAt: z.string(),
});

export type PresenceClient = z.infer<typeof PresenceClientSchema>;

export const PresenceUpdateEventSchema = z
  .object({
    sessionId: z.string(),
    clientCount: z.number().int(),
    clients: z.array(PresenceClientSchema),
    lockInfo: z
      .object({
        clientId: z.string(),
        acquiredAt: z.string(),
      })
      .nullable(),
  })
  .openapi('PresenceUpdateEvent');

export type PresenceUpdateEvent = z.infer<typeof PresenceUpdateEventSchema>;

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
      SyncUpdateEventSchema,
      SyncConnectedEventSchema,
      RelayReceiptEventSchema,
      MessageDeliveredEventSchema,
      RelayMessageEventSchema,
      BackgroundTaskStartedEventSchema,
      BackgroundTaskProgressEventSchema,
      BackgroundTaskDoneEventSchema,
      SystemStatusEventSchema,
      CompactBoundaryEventSchema,
      PromptSuggestionEventSchema,
      HookStartedEventSchema,
      HookProgressEventSchema,
      HookResponseEventSchema,
      PresenceUpdateEventSchema,
      SessionStateChangedEventSchema,
      ContextUsageSchema,
      UsageInfoSchema,
      ElicitationPromptEventSchema,
      ElicitationCompleteEventSchema,
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

const HookStatusSchema = z.enum(['running', 'success', 'error', 'cancelled']);

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
  })
  .openapi('ElicitationPart');

export type ElicitationPart = z.infer<typeof ElicitationPartSchema>;

export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  BackgroundTaskPartSchema,
  ThinkingPartSchema,
  ErrorPartSchema,
  ElicitationPartSchema,
]);

export type MessagePart = z.infer<typeof MessagePartSchema>;

// === Message Type ===

export const MessageTypeSchema = z.enum(['command', 'compaction']).openapi('MessageType');

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

export const HistoryMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    toolCalls: z.array(HistoryToolCallSchema).optional(),
    parts: z.array(MessagePartSchema).optional(),
    timestamp: z.string().optional(),
    messageType: MessageTypeSchema.optional(),
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
          description: 'True when an API key is active (from config.json or MCP_API_KEY env var)',
        }),
        authSource: z.enum(['config', 'env', 'none']).openapi({
          description: "Source of the active API key: 'config', 'env', or 'none'",
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
  })
  .openapi('ServerConfig');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// === Model Options ===

export const ModelOptionSchema = z
  .object({
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    displayName: z.string().openapi({ description: 'Human-readable model name' }),
    description: z.string().openapi({ description: 'Short model description' }),
    supportsEffort: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports effort levels' }),
    supportedEffortLevels: z
      .array(EffortLevelSchema)
      .optional()
      .openapi({ description: 'Available effort levels for this model' }),
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
 * Discriminated on `type`: `'url'`, `'markdown'`, or `'json'`.
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
  .enum(['settings', 'tasks', 'relay', 'mesh', 'picker'])
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
 * SSE event wrapper for agent-issued UI commands.
 * Carried as a `StreamEvent` with `type: 'ui_command'`.
 */
export const UiCommandEventSchema = z
  .object({
    type: z.literal('ui_command'),
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
      mesh: z.boolean(),
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
