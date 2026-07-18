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
import { SidebarPrefsSchema, ShapeUserPrefsSchema } from './config-schema.js';
// Type-only import: `ui-widget.ts` value-imports `UiCommandSchema` from this
// module, so a value import of `WidgetDocumentSchema` here would form a
// load-time cycle. The canvas `widget` content carries the document typed but
// validated on the client (see the `widget` variant note below).
import type { WidgetDocument } from './ui-widget.js';

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
    'operation_progress',
    'memory_recall',
    'compact_boundary',
    'prompt_suggestion',
    'hook_started',
    'hook_progress',
    'hook_response',
    'ui_command',
    'devtools_capture_request',
    'session_state_changed',
    'context_usage',
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
    /**
     * Best-effort context-window token count for the session — the tokens
     * currently occupying the window (input + cache-read + cache-creation, per
     * `sumContextTokens`). Populated on the list wire by claude-code from its
     * JSONL tail (fresh as the last turn, mtime-cached) and on a single-session
     * read. ABSENT when no reading is available — codex/opencode closed-session
     * list rows, or an unreadable tail — in which case the client shows an
     * honest "unknown" gauge, never a fabricated 0%. Percent is derived
     * client-side against the model's context window (`ModelOption.contextWindow`).
     */
    contextTokens: z.number().int().optional(),
    /**
     * ISO-8601 timestamp of the most recent AUTO-triggered context compaction
     * visible in the session's readable transcript tail (claude-code only;
     * codex has no compaction, opencode reports it live-only). ABSENT means no
     * auto-compaction is visible in the tail — either the session never
     * auto-compacted, or the boundary has scrolled past the ~16 KB tail window
     * as the session grew (an honest, disclosed limitation; durable recency is
     * a deferred follow-up). Drives the row's discreet "auto-compacted" marker.
     */
    lastAutoCompactAt: z.string().datetime().optional(),
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

/** Character cap for ui-action identifier fields (`actionId`, `widgetId`). */
export const UI_ACTION_ID_MAX_LENGTH = 200;
/** Character cap for the forwarded widget title. */
export const UI_ACTION_TITLE_MAX_LENGTH = 300;
/** Cap (UTF-16 code units) for the SERIALIZED ui-action payload. */
export const UI_ACTION_PAYLOAD_MAX_LENGTH = 8_192;

/**
 * Request body for `POST /api/sessions/:id/ui-action` — the generative-UI
 * interactivity return channel (spec gen-ui-tier1 §3). A click on an `agent`-kind
 * widget action POSTs this; the server injects a structured `<ui_action>` block as
 * the next user turn so the agent knows what was interacted with.
 *
 * `payload` already has any enclosing `form`'s field values merged in client-side.
 * `widgetTitle` is forwarded (not derivable server-side — the widget lives in the
 * transcript) so the injected block can name the widget for the agent.
 *
 * Every field feeds the injected turn prompt (post-sanitization), so all of them
 * are bounded: scalar fields by length caps, `payload` by its serialized size
 * ({@link UI_ACTION_PAYLOAD_MAX_LENGTH}).
 */
export const UiActionRequestSchema = z
  .object({
    /** Optional id of the widget instance the action fired from (diagnostics/correlation). */
    widgetId: z.string().max(UI_ACTION_ID_MAX_LENGTH).optional(),
    /** The action's stable id (`WidgetAction.id`) — tells the agent which control fired. */
    actionId: z.string().min(1).max(UI_ACTION_ID_MAX_LENGTH),
    /** Action payload; form field values are merged in client-side before the POST. */
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (payload) =>
          payload === undefined || JSON.stringify(payload).length <= UI_ACTION_PAYLOAD_MAX_LENGTH,
        { message: `payload exceeds ${UI_ACTION_PAYLOAD_MAX_LENGTH} serialized characters` }
      ),
    /** The widget document `title`, forwarded so the agent knows which widget was used. */
    widgetTitle: z.string().max(UI_ACTION_TITLE_MAX_LENGTH).optional(),
    /** Optional working-directory override, mirroring the message trigger. */
    cwd: z.string().optional(),
  })
  .openapi('UiActionRequest');

export type UiActionRequest = z.infer<typeof UiActionRequestSchema>;

// === MCP Apps (SEP-1865) resource fetch ===

/**
 * Iframe feature-policy permissions an MCP App may declare. Named as the
 * `allow`-attribute directives they map to (`allow="camera; microphone"`), so
 * the client can pass them straight through. The default is none — an app that
 * declares nothing gets no elevated capabilities.
 */
export const McpAppPermissionSchema = z
  .enum(['camera', 'microphone', 'geolocation', 'clipboard-write'])
  .openapi('McpAppPermission');

export type McpAppPermission = z.infer<typeof McpAppPermissionSchema>;

/**
 * Request body for `POST /api/sessions/:id/mcp-app/resource`. The client sends
 * only the server name + `ui://` URI; the stdio/http connection config never
 * leaves the server (ADR `260708-141143`).
 */
export const McpAppResourceRequestSchema = z
  .object({
    /** MCP server that owns the resource. Must be in the session's MCP set. */
    serverName: z.string().min(1),
    /** The `ui://` resource URI to read. Scheme enforced server-side. */
    uri: z.string().min(1),
  })
  .openapi('McpAppResourceRequest');

export type McpAppResourceRequest = z.infer<typeof McpAppResourceRequestSchema>;

/**
 * Response for `POST /api/sessions/:id/mcp-app/resource` — the fetched app
 * resource plus the sandbox metadata the client needs to frame it. Exactly one
 * of `text` / `blob` is present (text for HTML apps, blob for binary payloads).
 */
export const McpAppResourceResponseSchema = z
  .object({
    /** Resource mime type, e.g. `text/html;profile=mcp-app`. */
    mimeType: z.string(),
    /** UTF-8 resource body (HTML apps). Mutually exclusive with `blob`. */
    text: z.string().optional(),
    /** Base64 resource body (binary). Mutually exclusive with `text`. */
    blob: z.string().optional(),
    /** Content-Security-Policy the app declared (`_meta['ui/csp']`), if any. */
    csp: z.string().optional(),
    /** Feature-policy permissions the app declared. Empty ⇒ no elevated caps. */
    permissions: z.array(McpAppPermissionSchema).default([]),
  })
  .openapi('McpAppResourceResponse');

export type McpAppResourceResponse = z.infer<typeof McpAppResourceResponseSchema>;

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

/**
 * Query for `GET /api/sessions/recent` (DOR-329): how many most-recent sessions
 * to return across all agents. `limit` is coerced from the query string and
 * validated to 1-50 (default 10); out-of-range values are rejected (400).
 */
export const RecentSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .openapi('RecentSessionsQuery');

export type RecentSessionsQuery = z.infer<typeof RecentSessionsQuerySchema>;

/**
 * Response envelope for `GET /api/sessions/recent` (DOR-329, ADR-0310).
 *
 * `sessions` are the most-recent sessions merged across every registered agent,
 * sorted `updatedAt` descending and trimmed to the requested limit.
 * `agentActivity` maps each agent's `projectPath` to its latest session
 * `updatedAt` (ISO string), computed before the trim so it is complete even for
 * agents with no session in the top `limit` — it powers the client's per-group
 * "Recent activity" sort. `warnings` carries per-runtime degradation
 * (ADR-0310), aggregated across the fan-out.
 */
export const RecentSessionsResponseSchema = z
  .object({
    sessions: z.array(SessionSchema),
    agentActivity: z.record(z.string(), z.string()),
    warnings: z.array(SessionListWarningSchema).optional(),
  })
  .openapi('RecentSessionsResponse');

export type RecentSessionsResponse = z.infer<typeof RecentSessionsResponseSchema>;

export const CommandsQuerySchema = z
  .object({
    refresh: z.enum(['true', 'false']).optional(),
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
    runtime: z.string().optional(),
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

/**
 * Reference to an MCP App (SEP-1865) `ui://` resource carried on a tool call /
 * tool result — the interactive HTML app an MCP server wants the host to render
 * for this tool's output.
 *
 * Populated only for the claude-code runtime, and only via the text-parse
 * fallback (spec `mcp-apps-host` §0/§2.2): the Claude Agent SDK strips `_meta`
 * and flattens structured resource blocks to text, so the host recovers just
 * the `ui://` URI. `preferredDisplayMode` lived in the stripped `_meta.ui` and
 * is therefore currently never recovered — it defaults to `inline` at render.
 */
export const McpAppRefSchema = z
  .object({
    /** The `ui://` resource URI the host fetches (server-side) and renders. */
    resourceUri: z.string(),
    /** Server-preferred surface. Absent under the text-parse fallback. */
    preferredDisplayMode: z.enum(['inline', 'fullscreen', 'pip']).optional(),
  })
  .openapi('McpAppRef');

export type McpAppRef = z.infer<typeof McpAppRefSchema>;

export const ToolCallEventSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string().optional(),
    result: z.string().optional(),
    status: ToolCallStatusSchema,
    /** MCP App reference when this tool result carries a `ui://` app (claude-code only). */
    ui: McpAppRefSchema.optional(),
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

// === Runtime-neutral Usage / Cost Status ===

/** Utilization health for a subscription window (drives amber/red styling). */
export const UsageStateSchema = z.enum(['ok', 'warning', 'exhausted']).openapi('UsageState');

/** Inferred type for {@link UsageStateSchema}. */
export type UsageState = z.infer<typeof UsageStateSchema>;

/**
 * Runtime-neutral usage/cost descriptor for the status strip. Each runtime
 * populates the fields it can honestly report; a runtime with no meaningful
 * quota or cost omits `usage` entirely and the item hides (ADR: runtime
 * usage/cost as a session-status field). Carried on the `session_status`
 * projection, not through a synchronous runtime method.
 */
export const UsageStatusSchema = z
  .object({
    /**
     * How this session's usage should be read:
     * - `subscription`: a metered plan with a utilization window (Claude Max/Pro).
     * - `pay-as-you-go`: per-token billing with cost-to-date, no quota (OpenCode).
     */
    kind: z.enum(['subscription', 'pay-as-you-go']),
    /** Fraction 0..1 of the active subscription window consumed. Subscription only. */
    utilization: z.number().min(0).optional(),
    /** Human label for the active window/plan, e.g. "5-hour window", "7-day Opus". */
    windowLabel: z.string().optional(),
    /** ISO timestamp when the current window resets. Subscription only. */
    resetsAt: z.string().optional(),
    /**
     * Cumulative USD cost for the relevant scope: session cost for
     * `pay-as-you-go` (primary) and an optional secondary figure for
     * `subscription`.
     */
    costUsd: z.number().min(0).optional(),
    /** Utilization health. Absent implies `ok`. Subscription only. */
    state: UsageStateSchema.optional(),
    /** One-line tooltip detail (e.g. "Using overage capacity", active provider). */
    detail: z.string().optional(),
  })
  .openapi('UsageStatus');

/** Inferred type for {@link UsageStatusSchema}. */
export type UsageStatus = z.infer<typeof UsageStatusSchema>;

export const SessionStatusEventSchema = z
  .object({
    sessionId: z.string(),
    model: z.string().optional(),
    costUsd: z.number().optional(),
    contextTokens: z.number().int().optional(),
    contextMaxTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    /**
     * Turn-total input tokens for the whole turn (summed across every API
     * round-trip), emitted ONLY on the terminal result status. Distinct from
     * `contextTokens` (the current-window size) and from the streaming
     * `outputTokens` delta the projector merges. Consumed by the AI-observability
     * seam (`gen_ai.usage.input_tokens` span attr + `$ai_input_tokens` bridge);
     * the status-strip projector ignores it. See ADR 260713-143958 Phase 7.
     */
    turnInputTokens: z.number().int().optional(),
    /**
     * Turn-total output tokens for the whole turn (summed across every API
     * round-trip), emitted ONLY on the terminal result status. Sibling of
     * {@link SessionStatusEventSchema}'s `turnInputTokens`; feeds
     * `gen_ai.usage.output_tokens` + `$ai_output_tokens`. Kept separate from the
     * streaming `outputTokens` delta so the projector's merge is unaffected.
     */
    turnOutputTokens: z.number().int().optional(),
    /** Tokens read from prompt cache (90% cost savings). */
    cacheReadTokens: z.number().int().optional(),
    /** Tokens written to prompt cache (slight write premium). */
    cacheCreationTokens: z.number().int().optional(),
    /** Why the query loop terminated (SDK 0.2.91+ `result.terminal_reason`). */
    terminalReason: TerminalReasonSchema.optional(),
    /**
     * Runtime-neutral usage/cost descriptor. Folded onto the durable
     * `status_change` projection so the merged Usage & cost status item can
     * render subscription utilization or pay-as-you-go cost. Absent when the
     * runtime has nothing meaningful to report.
     */
    usage: UsageStatusSchema.optional(),
  })
  .openapi('SessionStatusEvent');

export type SessionStatusEvent = z.infer<typeof SessionStatusEventSchema>;

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
     * Raw SDK status value (SDK 0.2.108+ — e.g., `'requesting'`). A generic,
     * runtime-shaped status channel: `message` carries the human-readable
     * fallback for renderers that ignore this field. Operation lifecycle
     * (compaction start/done/failure) is NOT reported here — it rides the
     * runtime-agnostic {@link OperationProgressEventSchema}.
     */
    status: z.string().optional(),
  })
  .openapi('SystemStatusEvent');

export type SystemStatusEvent = z.infer<typeof SystemStatusEventSchema>;

/**
 * The named long-running operations a runtime can report progress for. An
 * extensible union: today only `compaction` (context-window summarization), but
 * a runtime that exposes indexing, cloning, or model-download progress adds its
 * kind here and every consumer keeps working (unknown kinds degrade to the
 * generic bar treatment). Runtime-agnostic by construction.
 */
export const OperationKindSchema = z.enum(['compaction']).openapi('OperationKind');

export type OperationKind = z.infer<typeof OperationKindSchema>;

/** Lifecycle phase of an operation: it begins, then resolves to done or failed. */
export const OperationStateSchema = z.enum(['started', 'done', 'failed']).openapi('OperationState');

export type OperationState = z.infer<typeof OperationStateSchema>;

/**
 * Base object shape for {@link OperationProgressEventSchema}, WITHOUT the
 * cross-field refinement. Exists only so the durable-stream `SessionEvent`
 * member can reuse the fields via `.shape` — a `discriminatedUnion` member must
 * be a plain object, and `.superRefine()` returns a `ZodEffects` with no
 * `.shape`. Validate through {@link OperationProgressEventSchema}, never this.
 *
 * @internal Reused by `session-stream.ts`; not the authoritative contract.
 */
export const OperationProgressEventShapeSchema = z.object({
  /** Which operation this progress is for (extensible union). */
  operation: OperationKindSchema,
  /** Lifecycle phase: `started` opens the treatment, `done`/`failed` resolve it. */
  state: OperationStateSchema,
  /**
   * Whether `percent` is meaningful. `false` → render an indeterminate bar
   * (the runtime cannot report completion fraction — e.g. SDK compaction
   * exposes none, so parity with the CLI's own indeterminate bar is honest).
   */
  determinate: z.boolean(),
  /** Completion fraction 0–100, present iff `determinate` is true. */
  percent: z.number().min(0).max(100).optional(),
  /** Optional human-readable operation label (e.g. "Compacting context…"). */
  message: z.string().optional(),
  /** Human-readable failure reason; present only when `state` is `failed`. */
  error: z.string().optional(),
});

/**
 * Runtime-agnostic progress for a named long-running operation (DOR-110). The
 * single structured contract that replaces per-runtime, stringly-typed progress
 * signals (the old `system_status` `compactResult`/`compacting` fields the
 * client string-matched). Every runtime maps its native progress onto this
 * shape; a runtime that cannot observe a start simply omits the `started`
 * event (honest degradation), and the client renders whatever phases arrive.
 *
 * Phase semantics: a `started` shows the progress treatment (an indeterminate
 * bar when `determinate` is false, a `percent` bar when true); a `done` or
 * `failed` resolves it. On `failed`, `error` carries the human-readable reason.
 * `message` is optional operation-labelling copy (e.g. "Compacting context…")
 * the producer supplies, so the client never has to synthesize or string-match
 * copy from a status token.
 *
 * The field invariants are ENFORCED, not merely documented — this schema is the
 * authoritative contract future runtimes are onboarded against, so an adapter
 * that violates them fails wire validation rather than relying on defensive
 * consumers:
 * - `percent` is present iff `determinate` is true (a determinate phase must
 *   carry a fraction; an indeterminate one must not claim one), and
 * - `error` is present only when `state` is `failed`.
 */
export const OperationProgressEventSchema = OperationProgressEventShapeSchema.superRefine(
  (value, ctx) => {
    if (value.determinate && value.percent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['percent'],
        message: 'percent is required when determinate is true',
      });
    }
    if (!value.determinate && value.percent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['percent'],
        message: 'percent must be omitted when determinate is false',
      });
    }
    if (value.error !== undefined && value.state !== 'failed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: "error is only allowed when state is 'failed'",
      });
    }
  }
).openapi('OperationProgressEvent');

export type OperationProgressEvent = z.infer<typeof OperationProgressEventSchema>;

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
      OperationProgressEventSchema,
      MemoryRecallEventSchema,
      CompactBoundaryEventSchema,
      PromptSuggestionEventSchema,
      HookStartedEventSchema,
      HookProgressEventSchema,
      HookResponseEventSchema,
      SessionStateChangedEventSchema,
      ContextUsageSchema,
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
    /**
     * MCP App reference (SEP-1865) when this tool result carries a `ui://` app.
     * Present only on claude-code sessions; its presence is what activates the
     * inline MCP-App renderer on this part. See {@link McpAppRefSchema}.
     */
    ui: McpAppRefSchema.optional(),
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
 * SDK `compact_metadata`), or synthesized from an `operation_progress`
 * `{ operation: 'compaction', state: 'failed' }` on failure (no boundary
 * fires). The renderer shows "Compacted — N tokens summarized (manual/auto)"
 * or, when `failed`, an error surface carrying `error`.
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

/**
 * Query for the raw media-file route (`GET /api/files/raw`) that streams a local
 * image or PDF for the canvas. `path` is resolved within and confined to `cwd`
 * server-side, and only image/PDF content types are served.
 */
export const RawFileQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
  })
  .openapi('RawFileQuery');

export type RawFileQuery = z.infer<typeof RawFileQuerySchema>;

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

// === Workbench file service (tree + content + CRUD) ===
//
// Backs the right-panel workbench file explorer and viewers. Every route is
// confined to the session working directory via `validateBoundary`
// (double-validated against `cwd`); these DTOs only shape the wire payloads.

/**
 * A single entry in a workbench file-tree listing. `path` is relative to the
 * session `cwd` (POSIX-separated) so the client can re-request a child level or
 * open the file in a viewer. Directories carry `size: 0`.
 */
export const FileEntrySchema = z
  .object({
    /** Base name of the entry (no directory component). */
    name: z.string(),
    /** Path relative to `cwd`, POSIX-separated (e.g. `src/index.ts`). */
    path: z.string(),
    /** Whether the entry is a regular file or a directory. */
    type: z.enum(['file', 'dir']),
    /** Size in bytes (`0` for directories). */
    size: z.number().int().nonnegative(),
    /** Last-modified time as epoch milliseconds. */
    mtime: z.number().int().nonnegative(),
    /** True when the entry is (or resolves through) a symbolic link. */
    isSymlink: z.boolean(),
  })
  .openapi('FileEntry');

export type FileEntry = z.infer<typeof FileEntrySchema>;

/**
 * Query for `GET /api/files/tree` — lists one directory level (lazily) inside a
 * session's working directory. `path` selects the subdirectory to list
 * (relative to `cwd`, defaults to the root). `depth` bounds recursion (1 = the
 * immediate children only). `showHidden` reveals dotfiles and `.gitignore`d
 * entries, which are hidden by default.
 */
export const FileTreeQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().optional(),
    depth: z.coerce.number().int().min(1).max(8).optional().default(1),
    // Express delivers the flag as the string `'true'`/`'false'`. `z.coerce.boolean`
    // is unusable here — it maps ANY non-empty string (including `'false'`) to
    // true — so parse the literal explicitly; absent means the default (false).
    showHidden: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .openapi('FileTreeQuery');

export type FileTreeQuery = z.infer<typeof FileTreeQuerySchema>;

/** Response for `GET /api/files/tree`: entries at (or under, for `depth > 1`) the requested level. */
export const FileTreeResponseSchema = z
  .object({
    entries: z.array(FileEntrySchema),
  })
  .openapi('FileTreeResponse');

export type FileTreeResponse = z.infer<typeof FileTreeResponseSchema>;

/**
 * Query for `GET /api/files/content` — reads a UTF-8 text file's content plus
 * its SHA-256 fingerprint. Distinct from `/raw` (media bytes): binary files are
 * rejected (415) and content larger than the server cap is rejected (413).
 */
export const FileContentQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
  })
  .openapi('FileContentQuery');

export type FileContentQuery = z.infer<typeof FileContentQuerySchema>;

/** Response for `GET /api/files/content`: the decoded text, its hash, and encoding. */
export const FileContentResponseSchema = z
  .object({
    content: z.string(),
    /** SHA-256 hex of the UTF-8 content — the optimistic-concurrency fingerprint. */
    hash: z.string(),
    /** Text encoding of `content`. Always `'utf-8'` for now. */
    encoding: z.literal('utf-8'),
  })
  .openapi('FileContentResponse');

export type FileContentResponse = z.infer<typeof FileContentResponseSchema>;

/**
 * Request for `POST /api/files` — create a new file or directory inside a
 * session's working directory. Rejects with 409 if the target already exists.
 * `content` seeds a new file's bytes (ignored for `type: 'dir'`).
 */
export const CreateEntryRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(['file', 'dir']),
    content: z.string().optional(),
  })
  .openapi('CreateEntryRequest');

export type CreateEntryRequest = z.infer<typeof CreateEntryRequestSchema>;

/** Response for a successful create: the created entry's path, relative to `cwd`. */
export const CreateEntryResponseSchema = z
  .object({
    ok: z.literal(true),
    path: z.string(),
  })
  .openapi('CreateEntryResponse');

export type CreateEntryResponse = z.infer<typeof CreateEntryResponseSchema>;

/**
 * Query for `DELETE /api/files` — delete a file or directory inside a session's
 * working directory. A non-empty directory requires `recursive: true`. Refuses
 * to delete the `cwd` root itself.
 */
export const DeleteEntryQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    // Parse the literal `'true'`/`'false'` rather than `z.coerce.boolean` — the
    // latter treats `'false'` as true, which would turn `recursive=false` into a
    // recursive delete (data loss). Absent means the default (false).
    recursive: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .openapi('DeleteEntryQuery');

export type DeleteEntryQuery = z.infer<typeof DeleteEntryQuerySchema>;

/**
 * Request for `POST /api/files/rename` — move or rename an entry within a
 * session's working directory. Both `from` and `to` are boundary-validated.
 * Rejects with 409 if `to` already exists.
 */
export const RenameEntryRequestSchema = z
  .object({
    cwd: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .openapi('RenameEntryRequest');

// ---------------------------------------------------------------------------
// Diff review (DOR-212) — per-hunk agent-edit review surface
// ---------------------------------------------------------------------------

/**
 * How a diff baseline was resolved, in descending precision (DOR-212 §Q1):
 * - `pre-tool` — the exact bytes captured at the runtime's pre-tool boundary
 *   before the agent's first edit to this file (the primary, precise base);
 * - `reconstructed` — rebuilt by reverse-applying an `Edit`/`MultiEdit` tool
 *   input against current disk when no snapshot exists;
 * - `head` — the file's content at git `HEAD` (fallback, or the user-toggled
 *   compare mode);
 * - `empty` — no baseline found, so the whole file reads as added.
 */
export const DiffBaselineOriginSchema = z.enum(['pre-tool', 'reconstructed', 'head', 'empty']);

export type DiffBaselineOrigin = z.infer<typeof DiffBaselineOriginSchema>;

/**
 * Query for `GET /api/diff/baseline` — resolves the pre-edit baseline for a file
 * and returns it alongside the current disk content, both for the text-diff
 * surface. `mode` selects the base: `session` (default) uses the per-session
 * snapshot with the reconstruct→HEAD→empty fallback ladder; `head` forces the
 * git-HEAD compare.
 */
export const DiffBaselineQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    /** Session whose pre-edit snapshot to diff against; keyed `(sessionId, path)`. */
    sessionId: z.string().min(1),
    mode: z.enum(['session', 'head']).optional().default('session'),
  })
  .openapi('DiffBaselineQuery');

export type DiffBaselineQuery = z.infer<typeof DiffBaselineQuerySchema>;

/**
 * Response for `GET /api/diff/baseline`: the resolved `baseline` text and the
 * `current` disk text, each with its SHA-256 fingerprint. `currentHash` is the
 * optimistic-concurrency token a later reject write (`PUT /api/files/content`)
 * passes as `expectedHash`, so a file that changed under the diff yields a
 * 409-refresh rather than a blind clobber.
 */
export const DiffBaselineResponseSchema = z
  .object({
    baseline: z.string(),
    baselineHash: z.string(),
    current: z.string(),
    currentHash: z.string(),
    capturedFrom: DiffBaselineOriginSchema,
  })
  .openapi('DiffBaselineResponse');

export type DiffBaselineResponse = z.infer<typeof DiffBaselineResponseSchema>;

/**
 * Request for `POST /api/diff/baseline/advance` — advance a file's baseline to
 * its current disk content (finish-review), so subsequent agent edits diff from
 * the just-reviewed state. A no-op when no baseline exists for the pair.
 */
export const AdvanceDiffBaselineRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .openapi('AdvanceDiffBaselineRequest');

export type AdvanceDiffBaselineRequest = z.infer<typeof AdvanceDiffBaselineRequestSchema>;

/**
 * Query for `GET /api/diff/pending` — lists the files a session has a live
 * baseline for that still differ from disk (i.e. unreviewed agent edits). Powers
 * explorer "agent touched this" badges and a review count.
 */
export const DiffPendingQuerySchema = z
  .object({
    cwd: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .openapi('DiffPendingQuery');

export type DiffPendingQuery = z.infer<typeof DiffPendingQuerySchema>;

/** Response for `GET /api/diff/pending`: `cwd`-relative paths with pending agent edits. */
export const DiffPendingResponseSchema = z
  .object({
    files: z.array(z.string()),
  })
  .openapi('DiffPendingResponse');

export type DiffPendingResponse = z.infer<typeof DiffPendingResponseSchema>;

/**
 * Query for `GET /api/diff/baseline/raw` — streams a file's BASELINE image
 * bytes (its pre-edit snapshot, or its git-HEAD content when no snapshot
 * exists) for the image-diff surface's "before" layer. Only media types are
 * served (the `GET /api/files/raw` allowlist); 404 when no baseline exists.
 * Current bytes come from `GET /api/files/raw`.
 */
export const DiffBaselineRawQuerySchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    /** Session whose pre-edit snapshot to serve; keyed `(sessionId, path)`. */
    sessionId: z.string().min(1),
  })
  .openapi('DiffBaselineRawQuery');

export type DiffBaselineRawQuery = z.infer<typeof DiffBaselineRawQuerySchema>;

/**
 * Request for `POST /api/diff/revert` — restore a file's baseline bytes to
 * disk, whole-file (the image diff's "reject"). Binary-safe, unlike the
 * text-oriented `PUT /api/files/content`: the server writes the snapshot's own
 * bytes (git-HEAD fallback), so no bytes travel from the client. Refused (404)
 * when no restorable baseline exists — an image the agent created this session
 * has no previous version, and the revert never deletes files.
 */
export const RevertDiffBaselineRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .openapi('RevertDiffBaselineRequest');

export type RevertDiffBaselineRequest = z.infer<typeof RevertDiffBaselineRequestSchema>;

export type RenameEntryRequest = z.infer<typeof RenameEntryRequestSchema>;

/** Response for a successful delete or rename. */
export const FileMutationResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .openapi('FileMutationResponse');

export type FileMutationResponse = z.infer<typeof FileMutationResponseSchema>;

// === Workbench browser: local-HTML serving + localhost proxy (DOR-216) ===

/**
 * Request for `POST /api/workbench/sign` — mint a short-lived signed URL the
 * embedded browser loads in an opaque-origin sandbox (ADR 260708-185519).
 *
 * Two scopes, discriminated on `kind`:
 * - `serve`: static-serve local HTML from the session's working directory
 *   (`cwd`), rooted at `path` so relative assets resolve. The signed URL — not
 *   the API's cookie/header auth — authorizes the request, because a sandboxed
 *   (no `allow-same-origin`) iframe carries no credentials by design.
 * - `proxy`: reverse-proxy a localhost dev server bound to `port`. The host is
 *   pinned to loopback server-side (no arbitrary-host SSRF); the token carries
 *   only the port.
 */
export const WorkbenchSignRequestSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('serve'),
      cwd: z.string().min(1),
      /** Initial file to open, relative to `cwd` (defaults to `index.html`). */
      path: z.string().optional(),
    }),
    z.object({
      kind: z.literal('proxy'),
      /** Localhost dev-server port to proxy (1–65535). */
      port: z.number().int().min(1).max(65535),
    }),
  ])
  .openapi('WorkbenchSignRequest');

export type WorkbenchSignRequest = z.infer<typeof WorkbenchSignRequestSchema>;

/** Response for `POST /api/workbench/sign`: the signed, short-lived URL to load. */
export const WorkbenchSignResponseSchema = z
  .object({
    /** Same-origin URL embedding the signed token; load directly as an iframe `src`. */
    url: z.string(),
  })
  .openapi('WorkbenchSignResponse');

export type WorkbenchSignResponse = z.infer<typeof WorkbenchSignResponseSchema>;

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
    platform: z.string().openapi({
      description: 'Host operating system and architecture, e.g. "darwin-arm64"',
    }),
    runtimes: z.array(z.string()).openapi({
      description: 'Agent runtimes configured on the host, e.g. ["claude-code", "codex"]',
    }),
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
        authSource: z.enum(['env', 'user-keys', 'none', 'local-token']).openapi({
          description:
            "How MCP access is secured: 'env' (MCP_API_KEY override), 'user-keys' (per-user Better Auth API keys), 'local-token' (login off, no MCP_API_KEY — gated by the per-instance local token), or 'none' (the degenerate can't-generate fallback)",
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
        userHasDecided: z.boolean().openapi({
          description: 'True once the user has explicitly chosen (banner stops appearing)',
        }),
        install: z.boolean().openapi({
          description:
            'Whether the marketplace install-events channel is on (Tier 1, anonymous, opt-out, default true)',
        }),
        heartbeat: z.boolean().openapi({
          description:
            'Whether the daily anonymous heartbeat channel is on (Tier 1, anonymous, opt-out, default true)',
        }),
        errorReporting: z.boolean().openapi({
          description: 'Whether the crash/error-report channel is opted in',
        }),
        lastPromptedVersion: z.string().nullable().optional().openapi({
          description: 'DorkOS version whose consent notice this install last saw, or null',
        }),
        usage: z.boolean().optional().openapi({
          description:
            'Whether the anonymous feature-usage events channel is on (Tier 1, anonymous, opt-out, default true)',
        }),
        linkAnalyticsToAccount: z.boolean().optional().openapi({
          description:
            'Whether linking this install to a DorkOS account also merges its anonymous usage history onto the account person (Tier 2, opt-in, default false; set in the account-link flow)',
        }),
        aiMetadata: z.boolean().optional().openapi({
          description:
            'Whether the AI-run metadata bridge is on (Tier 2, opt-in, default false): per-turn model/token/timing/cost, never content',
        }),
      })
      .optional()
      .openapi({ description: 'Telemetry consent state (shared per-channel namespace)' }),
    auth: z
      .object({
        enabled: z.boolean().openapi({
          description: 'Whether local owner login is required to reach the API and MCP endpoints',
        }),
      })
      .optional()
      .openapi({ description: 'Local login (Better Auth) state' }),
    workbench: z
      .object({
        defaultViewers: z.record(z.string(), z.string()).openapi({
          description:
            'Extension → canvas-viewer overrides for the mime→viewer registry (workbench D7)',
        }),
        autoOpenDiff: z.boolean().optional().openapi({
          description: 'Auto-open a diff review when the attached agent edits a file (DOR-212)',
        }),
      })
      .optional()
      .openapi({ description: 'Right-panel workbench configuration' }),
    ui: z
      .object({
        // Server-persisted sidebar organization: groups, pinned agents,
        // per-section sort and collapse state (DOR-329). Defined in
        // config-schema.ts (no OpenAPI extension), so it is embedded rather than
        // `.openapi()`-annotated here.
        sidebar: SidebarPrefsSchema,
        // Person-scoped Shape state: active Shape, reverse affinity hints, and
        // the offer-vs-follow toggle (DOR-355). Also defined in config-schema.ts.
        shapes: ShapeUserPrefsSchema,
      })
      .optional()
      .openapi({ description: 'Cockpit UI preferences surfaced to the client' }),
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

// === Shapes (DOR-355) ===

/**
 * Request body for `POST /api/shapes/:name/fork`. `as` names the new Shape
 * (defaults to `<name>-fork`); `captureCurrent` snapshots the live arrangement
 * when forking the active Shape.
 */
export const ForkShapeRequestSchema = z
  .object({
    as: z
      .string()
      .min(1)
      .optional()
      .describe('New Shape name (kebab-case). Defaults to `<name>-fork`.'),
    captureCurrent: z
      .boolean()
      .optional()
      .describe(
        'Snapshot the live arrangement (enabled extensions + chrome) when forking the active Shape.'
      ),
  })
  .openapi('ForkShapeRequest');

/** Request body for forking a Shape. */
export type ForkShapeRequest = z.infer<typeof ForkShapeRequestSchema>;

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
 * A media source for the image/pdf canvas variants: an `https://` (or `http://`)
 * URL, a `data:` URI, or a local file path (absolute or session-relative). Local
 * paths are resolved within and confined to the session's working directory and
 * streamed by the server's raw-file route — only image and PDF content types are
 * ever served.
 */
const CanvasMediaSrcSchema = z.string().min(1);

/**
 * Content that can be rendered in the agent-controlled canvas panel.
 * Discriminated on `type` — note each variant's payload key differs:
 * - `{ type: 'markdown', content: string, title?, sourcePath? }` — markdown text goes in `content`; `sourcePath` makes it an editable, file-backed surface
 * - `{ type: 'url', url: string, title? }` — renders in the embedded browser (same renderer as `browser`), with navigation chrome and origin isolation
 * - `{ type: 'json', data: unknown, title? }`
 * - `{ type: 'image', src: string, title?, alt? }` — `src` is an https URL, a `data:` URI, or a local file path
 * - `{ type: 'pdf', src: string, title? }` — `src` follows the same rules as `image`
 * - `{ type: 'widget', definition: WidgetDocument, title? }` — a Tier-1 generative-UI widget
 */
export const UiCanvasContentSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('url'),
      url: z.string().url(),
      title: z.string().optional(),
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
    z.object({
      type: z.literal('image'),
      /** Image source: https URL, `data:` URI, or a local (cwd-confined) file path. */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
      /** Accessible description of the image. */
      alt: z.string().optional(),
    }),
    z.object({
      type: z.literal('pdf'),
      /** PDF source: https URL, `data:` URI, or a local (cwd-confined) file path. */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('widget'),
      /**
       * A Tier-1 widget document. Typed here but validated on the client
       * against `WidgetDocumentSchema` — the same posture as the fence path and
       * the `json` variant's `data`. The server does not structurally validate
       * agent-authored widget JSON; an invalid definition degrades to the D5
       * error card client-side. A value import of `WidgetDocumentSchema` here
       * would also form a load-time cycle (`ui-widget` imports `UiCommandSchema`
       * from this module). `z.custom` carries no structure for the OpenAPI
       * walker, so it declares an explicit `object` type for spec generation.
       */
      definition: z.custom<WidgetDocument>().openapi({ type: 'object' }),
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('mcp_app'),
      /** MCP server that owns the `ui://` resource — scopes the server-side fetch. */
      serverName: z.string(),
      /** The `ui://` resource URI to fetch and render in the sandboxed app frame. */
      uri: z.string(),
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('file'),
      /**
       * Path of the file this viewer reads and edits. Workspace-relative or
       * absolute; the server resolves and confines it to the session's working
       * directory. The content is loaded client-side via the file-service
       * (`readFileContent`), so — unlike the `markdown` variant — no bytes travel
       * in the command. Markdown files render in the rich editor (Blintz); every
       * other text/code file renders in CodeMirror.
       */
      sourcePath: z.string(),
      /** CodeMirror language hint (e.g. `typescript`); auto-detected from the extension when absent. */
      language: z.string().optional(),
      /** When `true`, the viewer opens without an edit affordance. Defaults to read-only-until-toggled. */
      readOnly: z.boolean().optional(),
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('model3d'),
      /** 3D model source: https URL, `data:` URI, or a local (cwd-confined) file path (glTF/GLB/STL/OBJ). */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('csv'),
      /** CSV source: https URL, `data:` URI, or a local (cwd-confined) file path. */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser'),
      /**
       * The page to open in the embedded browser (DOR-216). One of:
       * - an external `https://` / `http://` URL (rendered directly; falls back
       *   to "open in system browser" when the site refuses framing),
       * - a `localhost`/`127.0.0.1` dev-server URL (routed through the localhost
       *   reverse-proxy so it can be framed), or
       * - a local file path within the session cwd (routed through the signed
       *   static-serve route so relative assets resolve).
       *
       * Local and dev-server content renders in an opaque-origin sandbox (no
       * `allow-same-origin`) per ADR 260708-185519 — it can never call `/api/*`
       * as the user.
       */
      url: z.string().min(1),
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('diff'),
      /**
       * Path of the file whose agent edits this diff reviews. Workspace-relative
       * or absolute; the server resolves and confines it to the session's working
       * directory. No bytes travel in the command — the diff renderer loads the
       * pre-edit `baseline` and the `current` disk content itself (mirroring the
       * `file` variant), then shows a per-hunk accept/reject surface. The diff
       * base is the session's pre-edit snapshot of this path, not git HEAD (see
       * the diff-base ADR).
       */
      sourcePath: z.string().min(1),
      /**
       * Optional hint for which diff surface to render — the text (CodeMirror
       * merge) or image (2-up/swipe/onion-skin) view. Resolved from the viewer
       * registry ({@link import('./viewer-registry').diffMediaKindForPath}) when
       * absent, so the agent never needs to know a file's media type.
       */
      mediaKind: z.enum(['text', 'image']).optional(),
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

/** The canonical celebration styles the `celebrate` command can fire. */
export const CELEBRATION_KINDS = [
  'burst',
  'fireworks',
  'cannons',
  'emoji',
  'rain',
  'stars',
] as const;

/**
 * Synonym → canonical celebration kind. Lets agents reach for natural
 * vocabulary ("explosion", "party", "confetti") and still land on a real kind.
 * Every unrecognized string collapses to `burst` in the preprocess below, so
 * this map only needs the memorable aliases worth steering.
 */
const CELEBRATION_KIND_SYNONYMS: Record<string, (typeof CELEBRATION_KINDS)[number]> = {
  burst: 'burst',
  confetti: 'burst',
  pop: 'burst',
  party: 'burst',
  fireworks: 'fireworks',
  firework: 'fireworks',
  fireshow: 'fireworks',
  cannons: 'cannons',
  cannon: 'cannons',
  crossfire: 'cannons',
  emoji: 'emoji',
  emojis: 'emoji',
  rain: 'rain',
  drizzle: 'rain',
  shower: 'rain',
  stars: 'stars',
  star: 'stars',
  sparkle: 'stars',
};

/**
 * Celebration kind, tolerant by design: a recognized synonym maps to its
 * canonical kind and anything else (including a typo or an invented style)
 * falls back to `burst` instead of failing validation — a celebration should
 * never be the thing that rejects an otherwise-valid command. Non-strings pass
 * through so `.optional()` still sees `undefined` as absent.
 */
export const CelebrationKindSchema = z
  .preprocess((value) => {
    if (typeof value !== 'string') return value;
    return CELEBRATION_KIND_SYNONYMS[value.trim().toLowerCase()] ?? 'burst';
  }, z.enum(CELEBRATION_KINDS))
  .openapi('CelebrationKind');

export type CelebrationKind = z.infer<typeof CelebrationKindSchema>;

/**
 * A command issued by an agent to mutate the DorkOS client UI.
 * Discriminated on `action` — 22 variants covering panels, sidebar, canvas,
 * PIP, file/terminal/browser opening, notifications, theme, scroll, agent
 * switching, shape switching, command palette, and celebration.
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

    // PIP (floating panel)
    z.object({
      /**
       * Pop the session's NEWEST inline `dorkos-ui` widget into the floating
       * picture-in-picture panel (a bottom sheet on phones). The panel follows
       * the live fence, so the agent must emit the widget fence in a message
       * BEFORE calling this — each subsequent re-emit of the fence updates the
       * PIP in place.
       */
      action: z.literal('open_pip'),
      title: z.string().optional(),
    }),
    z.object({ action: z.literal('close_pip') }),

    z.object({
      action: z.literal('open_file'),
      /**
       * Path of the file to open in the canvas. Workspace-relative or absolute;
       * resolved and confined to the session's working directory. The client
       * picks the viewer (CodeMirror / image / PDF / 3D / CSV / Blintz) from the
       * mime→viewer registry and opens it as a new canvas document.
       */
      sourcePath: z.string().min(1),
    }),
    z.object({
      action: z.literal('open_diff'),
      /**
       * Path of the file whose agent edits to review. Workspace-relative or
       * absolute; resolved and confined to the session's working directory. Opens
       * (or refreshes) a `diff` canvas document showing what changed since the
       * session's pre-edit snapshot, with per-hunk accept/reject. Deduped by path
       * — a repeated open re-activates the existing diff document.
       */
      sourcePath: z.string().min(1),
    }),
    z.object({
      action: z.literal('open_terminal'),
      /**
       * Optional working-directory hint. The terminal always spawns in the
       * attached session's worktree (PTY creation is client-driven), so this is
       * advisory only — the client opens/focuses the Terminal tab and does not
       * spawn a second shell for a mismatching cwd.
       */
      cwd: z.string().optional(),
    }),
    z.object({
      action: z.literal('browser_navigate'),
      /**
       * The page to open in the embedded browser: an external URL, a
       * `localhost` dev-server URL, or a local (cwd-confined) file path. Opens
       * as a new browser canvas document (dedup by URL); relative-asset
       * resolution and origin isolation are handled by the browser renderer.
       */
      url: z.string().min(1),
    }),

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

    // Shape switching
    z.object({
      action: z.literal('apply_layout'),
      /**
       * Installed Shape name to apply. The client resolves its manifest
       * server-side (via the apply-shape flow), which owns layout resolution,
       * connection prompts, and per-piece degradation — inlining a raw layout
       * would duplicate the manifest and skip that handling.
       */
      shape: z.string().min(1),
    }),

    // Command palette
    z.object({ action: z.literal('open_command_palette') }),

    // Celebration
    z.object({
      action: z.literal('celebrate'),
      /**
       * The celebration style. Omit for the default `burst`. Tolerant of
       * unknown values — anything unrecognized falls back to `burst` rather than
       * rejecting the whole command (Postel's law, matching the widget coercers).
       */
      kind: CelebrationKindSchema.optional(),
      /**
       * The glyph thrown by the `emoji` kind (e.g. "🏆", "❤️", "😂"). Ignored by
       * every other kind. Defaults to "🎉" when the kind is `emoji` and this is
       * omitted. Capped at 8 chars so a stray sentence can't become a particle.
       */
      emoji: z.string().min(1).max(8).optional(),
    }),
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
      contentType: z
        .enum([
          'url',
          'markdown',
          'json',
          'image',
          'pdf',
          'widget',
          'mcp_app',
          'file',
          'model3d',
          'csv',
          'browser',
          'diff',
        ])
        .nullable(),
    }),
    panels: z.object({
      settings: z.boolean(),
      tasks: z.boolean(),
      relay: z.boolean(),
      picker: z.boolean(),
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

// === DevTools Bridge capture (DOR-213) ===
//
// The workbench embedded browser (DOR-216) renders a preview in an opaque-origin
// sandbox. An injected in-page shim captures that page's console + network and
// posts it to the DorkOS client (window.parent, never `/api/*`); the client — the
// only credentialed, same-origin party — forwards it here via
// `POST /api/sessions/:id/devtools/ingest`. These schemas validate that wire
// batch. The read tools that expose the buffer to the agent land in a follow-up.

/** Console severity captured from the preview's wrapped `console.*` calls. */
export const DevtoolsConsoleLevelSchema = z
  .enum(['log', 'info', 'warn', 'error', 'debug'])
  .openapi('DevtoolsConsoleLevel');

export type DevtoolsConsoleLevel = z.infer<typeof DevtoolsConsoleLevelSchema>;

/**
 * Serialized-size cap (in JSON characters) for one console entry's `args`.
 * The `args` elements are `unknown`, so field-level `.max()` caps alone cannot
 * bound them — without this, a hand-crafted batch bypassing the shim's own caps
 * could park ~1 MB per entry in the server ring. Together with the `text` and
 * `stack` string caps, a whole serialized entry is bounded to ~56 KB.
 */
export const DEVTOOLS_ARGS_MAX_CHARS = 16_384;

/**
 * A single captured console line (or an uncaught error / unhandled rejection,
 * both recorded at `error` level). `text` is the joined, size-capped rendering
 * the shim produced; `args` carries the structured-clone-safe, depth-capped
 * serialization of the original arguments; `stack` is present for errors.
 */
export const DevtoolsConsoleEntrySchema = z
  .object({
    level: DevtoolsConsoleLevelSchema,
    text: z.string().max(20_000),
    args: z.array(z.unknown()).max(50).optional(),
    stack: z.string().max(20_000).optional(),
    /** Epoch ms when the line was emitted in the page. */
    timestamp: z.number(),
    /** `filename:line:col` for an uncaught error, when the runtime provided it. */
    source: z.string().max(2_048).optional(),
  })
  .superRefine((entry, ctx) => {
    // Byte-bound the open-shaped `args` (the body already passed JSON.parse, so
    // stringify cannot recurse or throw here). A well-behaved shim never trips
    // this; it exists to reject hand-crafted oversized batches. The ingest route
    // maps this issue (by its message) to a 413 alongside the count caps.
    if (entry.args !== undefined && JSON.stringify(entry.args).length > DEVTOOLS_ARGS_MAX_CHARS) {
      ctx.addIssue({
        code: 'custom',
        message: `args exceed the serialized size cap (${DEVTOOLS_ARGS_MAX_CHARS} chars)`,
        path: ['args'],
      });
    }
  })
  .openapi('DevtoolsConsoleEntry');

export type DevtoolsConsoleEntry = z.infer<typeof DevtoolsConsoleEntrySchema>;

/**
 * A single captured `fetch`/XHR request. Bodies are never captured in v1 (size +
 * secret-leak surface); `responseSize` is the `content-length` header when the
 * server sent one.
 */
export const DevtoolsNetworkEntrySchema = z
  .object({
    method: z.string().max(16),
    url: z.string().max(2_048),
    status: z.number(),
    ok: z.boolean(),
    durationMs: z.number(),
    responseSize: z.number().optional(),
    /** Epoch ms when the request started in the page. */
    timestamp: z.number(),
    initiator: z.enum(['fetch', 'xhr']).optional(),
  })
  .openapi('DevtoolsNetworkEntry');

export type DevtoolsNetworkEntry = z.infer<typeof DevtoolsNetworkEntrySchema>;

/**
 * Per-batch entry caps. A batch that exceeds either is rejected with `413` (not a
 * generic `400`) so an oversized relay is a distinct, debuggable outcome. The
 * shim caps its own outbound batch to these same numbers, so a well-behaved
 * preview never trips the limit.
 */
export const DEVTOOLS_CONSOLE_BATCH_MAX = 500;
export const DEVTOOLS_NETWORK_BATCH_MAX = 200;

/**
 * Size cap (in data-URL characters) for one ingested screenshot — ~675 KB of
 * decoded PNG. Sized to fit the server's 1 MB JSON body limit with envelope
 * headroom. The shim caps its render dimensions (long edge ≤ 1568 px, the
 * sweet spot for model vision) and downscale-retries once when a render still
 * exceeds this, so a well-behaved preview rarely trips it — the cap exists so
 * a hostile page cannot POST an unbounded "screenshot" into server memory.
 */
export const DEVTOOLS_SCREENSHOT_MAX_CHARS = 900_000;

/**
 * The outcome of one `browser_screenshot` capture round-trip, relayed by the
 * client from the in-page shim. Exactly one of `dataUrl` (success) or `error`
 * (the shim could not rasterize — e.g. the page's CSP blocked the rasterizer)
 * is expected; `requestId` ties the result back to the awaiting tool call.
 */
export const DevtoolsScreenshotResultSchema = z
  .object({
    requestId: z.string().max(128),
    dataUrl: z.string().max(DEVTOOLS_SCREENSHOT_MAX_CHARS).optional(),
    error: z.string().max(2_048).optional(),
  })
  .openapi('DevtoolsScreenshotResult');

export type DevtoolsScreenshotResult = z.infer<typeof DevtoolsScreenshotResultSchema>;

/**
 * The ingest batch the DorkOS client posts to
 * `POST /api/sessions/:id/devtools/ingest`. `seq` is the shim's monotonic
 * counter (lets the buffer detect gaps); `reset` marks a navigation boundary
 * (the preview navigated, so the prior page's console/network is cleared before
 * these append); `screenshot` carries a capture round-trip result (success or
 * shim-side error) tagged with its `requestId`.
 */
export const DevtoolsIngestSchema = z
  .object({
    documentId: z.string().max(256).optional(),
    logicalUrl: z.string().max(2_048).optional(),
    seq: z.number(),
    reset: z.boolean().optional(),
    console: z.array(DevtoolsConsoleEntrySchema).max(DEVTOOLS_CONSOLE_BATCH_MAX),
    network: z.array(DevtoolsNetworkEntrySchema).max(DEVTOOLS_NETWORK_BATCH_MAX),
    screenshot: DevtoolsScreenshotResultSchema.optional(),
  })
  .openapi('DevtoolsIngest');

export type DevtoolsIngest = z.infer<typeof DevtoolsIngestSchema>;
