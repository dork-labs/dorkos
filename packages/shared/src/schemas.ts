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

export const TaskStatusSchema = z
  .enum(['pending', 'in_progress', 'completed'])
  .openapi('TaskStatus');

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const StreamEventTypeSchema = z
  .enum([
    'text_delta',
    'tool_call_start',
    'tool_call_delta',
    'tool_call_end',
    'tool_result',
    'approval_required',
    'question_prompt',
    'error',
    'done',
    'session_status',
    'task_update',
    'sync_update',
    'sync_connected',
    'relay_receipt',
    'message_delivered',
    'relay_message',
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

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastMessagePreview: z.string().optional(),
    permissionMode: PermissionModeSchema,
    model: z.string().optional(),
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
  })
  .openapi('UpdateSessionRequest');

export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const SendMessageRequestSchema = z
  .object({
    content: z.string().min(1, 'content is required'),
    cwd: z.string().optional(),
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

export const ApprovalEventSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
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

export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
  })
  .openapi('ErrorEvent');

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const DoneEventSchema = z
  .object({
    sessionId: z.string(),
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
  })
  .openapi('SessionStatusEvent');

export type SessionStatusEvent = z.infer<typeof SessionStatusEventSchema>;

export const TaskItemSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    status: TaskStatusSchema,
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

export const StreamEventSchema = z
  .object({
    type: StreamEventTypeSchema,
    data: z.union([
      TextDeltaSchema,
      ToolCallEventSchema,
      ApprovalEventSchema,
      QuestionPromptEventSchema,
      ErrorEventSchema,
      DoneEventSchema,
      SessionStatusEventSchema,
      TaskUpdateEventSchema,
      SyncUpdateEventSchema,
      SyncConnectedEventSchema,
      RelayReceiptEventSchema,
      MessageDeliveredEventSchema,
      RelayMessageEventSchema,
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

export const ToolCallPartSchema = z
  .object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string().optional(),
    result: z.string().optional(),
    status: ToolCallStatusSchema,
    interactiveType: z.enum(['approval', 'question']).optional(),
    questions: z.array(QuestionItemSchema).optional(),
    answers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('ToolCallPart');

export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const MessagePartSchema = z.discriminatedUnion('type', [TextPartSchema, ToolCallPartSchema]);

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
    namespace: z.string(),
    command: z.string(),
    fullCommand: z.string(),
    description: z.string(),
    argumentHint: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    filePath: z.string(),
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
    connected: z.boolean(),
    url: z.string().nullable(),
    port: z.number().int().nullable(),
    startedAt: z.string().nullable(),
  })
  .openapi('TunnelStatus');

export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

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
    latestVersion: z
      .string()
      .nullable()
      .openapi({ description: 'Latest available version from npm, or null if unknown' }),
    port: z.number().int(),
    uptime: z.number(),
    workingDirectory: z.string(),
    nodeVersion: z.string(),
    claudeCliPath: z.string().nullable(),
    tunnel: z.object({
      enabled: z.boolean(),
      connected: z.boolean(),
      url: z.string().nullable(),
      authEnabled: z.boolean(),
      tokenConfigured: z.boolean(),
    }),
    pulse: z
      .object({
        enabled: z.boolean().openapi({ description: 'Whether the Pulse scheduler is enabled' }),
      })
      .optional()
      .openapi({ description: 'Pulse scheduler feature state' }),
    relay: z
      .object({
        enabled: z.boolean().openapi({ description: 'Whether the Relay message bus is enabled' }),
      })
      .optional()
      .openapi({ description: 'Relay message bus feature state' }),
    boundary: z
      .string()
      .openapi({ description: 'Server boundary path (home directory or configured boundary)' }),
    mesh: z
      .object({
        enabled: z
          .boolean()
          .openapi({ description: 'Whether the Mesh agent discovery subsystem is enabled' }),
        scanRoots: z
          .array(z.string())
          .optional()
          .openapi({ description: 'User-configured scan roots for agent discovery' }),
      })
      .optional()
      .openapi({ description: 'Mesh agent discovery feature state' }),
  })
  .openapi('ServerConfig');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// === Model Options ===

export const ModelOptionSchema = z
  .object({
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    displayName: z.string().openapi({ description: 'Human-readable model name' }),
    description: z.string().openapi({ description: 'Short model description' }),
  })
  .openapi('ModelOption');

export type ModelOption = z.infer<typeof ModelOptionSchema>;

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

// === Pulse Scheduler Types ===

export const PulseScheduleStatusSchema = z
  .enum(['active', 'paused', 'pending_approval'])
  .openapi('PulseScheduleStatus');

export type PulseScheduleStatus = z.infer<typeof PulseScheduleStatusSchema>;

export const PulseRunStatusSchema = z
  .enum(['running', 'completed', 'failed', 'cancelled'])
  .openapi('PulseRunStatus');

export type PulseRunStatus = z.infer<typeof PulseRunStatusSchema>;

export const PulseRunTriggerSchema = z.enum(['scheduled', 'manual']).openapi('PulseRunTrigger');

export type PulseRunTrigger = z.infer<typeof PulseRunTriggerSchema>;

export const PulseScheduleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prompt: z.string(),
    cron: z.string(),
    timezone: z.string().nullable(),
    cwd: z.string().nullable(),
    enabled: z.boolean(),
    maxRuntime: z.number().int().nullable(),
    permissionMode: PermissionModeSchema,
    status: PulseScheduleStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    nextRun: z.string().nullable().optional(),
  })
  .openapi('PulseSchedule');

export type PulseSchedule = z.infer<typeof PulseScheduleSchema>;

export const PulseRunSchema = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    status: PulseRunStatusSchema,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    outputSummary: z.string().nullable(),
    error: z.string().nullable(),
    sessionId: z.string().nullable(),
    trigger: PulseRunTriggerSchema,
    createdAt: z.string(),
  })
  .openapi('PulseRun');

export type PulseRun = z.infer<typeof PulseRunSchema>;

export const CreateScheduleRequestSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    enabled: z.boolean().optional().default(true),
    maxRuntime: z.number().int().positive().nullable().optional(),
    permissionMode: PermissionModeSchema.optional().default('acceptEdits'),
  })
  .openapi('CreateScheduleRequest');

export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

/** Input type for creating a schedule (before Zod defaults are applied). */
export type CreateScheduleInput = z.input<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    timezone: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    maxRuntime: z.number().int().positive().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    status: PulseScheduleStatusSchema.optional(),
  })
  .openapi('UpdateScheduleRequest');

export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ListRunsQuerySchema = z
  .object({
    scheduleId: z.string().optional(),
    status: PulseRunStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi('ListRunsQuery');

export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

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
