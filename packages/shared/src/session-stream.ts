/**
 * Runtime-neutral session hydration & resumable streaming contract.
 *
 * Defines the snapshot + event schemas every agent runtime adapter projects
 * its state into. The contract is owned by DorkOS, not by any particular
 * backend: a file-backed runtime (Claude Code JSONL) and a log-backed runtime
 * (DorkOS test logs) both produce the same shapes. Persistence is pluggable per
 * adapter — only the projected snapshot and the monotonic event stream are part
 * of the contract (ADR-0263).
 *
 * Every {@link SessionEventSchema} member carries a per-session monotonic `seq`
 * assigned by the projector (NOT derived from JSONL line numbers), so file- and
 * log-backed runtimes expose a uniform cursor for snapshot-then-replay. The
 * three interaction members preserve the server-authoritative
 * `startedAt`/`remainingMs` countdown fields (ADR-0262).
 *
 * @module shared/session-stream
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

import {
  PermissionModeSchema,
  HistoryMessageSchema,
  PendingInteractionDTOSchema,
  SessionSchema,
  TextDeltaSchema,
  ToolCallEventSchema,
  QuestionItemSchema,
  ElicitationModeSchema,
  TaskItemSchema,
  BackgroundTaskStatusSchema,
  TerminalReasonSchema,
} from './schemas.js';

extendZodWithOpenApi(z);

// === Session Status Projection ===

/**
 * Per-session running token totals projected into the status. Mirrors the SDK
 * usage breakdown so the client can render context pressure without replaying
 * the transcript. Nullable as a whole on a cold snapshot (no turn yet).
 */
export const SessionContextUsageSchema = z
  .object({
    /** Tokens currently occupying the context window. */
    totalTokens: z.number().int(),
    /** Maximum context window size for the active model. */
    maxTokens: z.number().int(),
    /** Output tokens produced across the session so far. */
    outputTokens: z.number().int(),
    /** Tokens read from prompt cache (90% cost savings). */
    cacheReadTokens: z.number().int(),
    /** Tokens written to prompt cache (slight write premium). */
    cacheCreationTokens: z.number().int(),
  })
  .openapi('SessionContextUsage');

/** Inferred type for {@link SessionContextUsageSchema}. */
export type SessionContextUsage = z.infer<typeof SessionContextUsageSchema>;

/**
 * Prompt-cache hit/miss accounting for the status badge. Nullable on a cold
 * snapshot before the first turn establishes a cache.
 */
export const SessionCacheStatsSchema = z
  .object({
    /** Cumulative tokens served from the prompt cache. */
    cacheReadTokens: z.number().int(),
    /** Cumulative tokens written to the prompt cache. */
    cacheCreationTokens: z.number().int(),
  })
  .openapi('SessionCacheStats');

/** Inferred type for {@link SessionCacheStatsSchema}. */
export type SessionCacheStats = z.infer<typeof SessionCacheStatsSchema>;

/**
 * Todo (task) tallies for the status badge, projected from `todo_update`
 * events. Nullable until the agent emits its first todo list.
 */
export const SessionTodoCountsSchema = z
  .object({
    /** Total todos in the active list. */
    total: z.number().int(),
    /** Todos marked completed. */
    completed: z.number().int(),
    /** Todos currently in progress. */
    inProgress: z.number().int(),
  })
  .openapi('SessionTodoCounts');

/** Inferred type for {@link SessionTodoCountsSchema}. */
export type SessionTodoCounts = z.infer<typeof SessionTodoCountsSchema>;

/**
 * Coarse lifecycle phase of a session. `streaming` while a turn produces
 * output, `blocked` while an interaction awaits the operator, `interrupted`
 * when a turn was aborted, `error` on a terminal failure, `idle` otherwise.
 */
export const SessionLifecycleSchema = z
  .enum(['idle', 'streaming', 'blocked', 'error', 'interrupted'])
  .openapi('SessionLifecycle');

/** Inferred type for {@link SessionLifecycleSchema}. */
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>;

/**
 * Server-held status projection for a single session. Carried whole on a cold
 * snapshot (where the numeric/usage fields are `null` before the first turn)
 * and as a partial on each `status_change` event. Runtime-neutral: every
 * adapter projects into this shape regardless of its persistence backend.
 */
export const SessionStatusSchema = z
  .object({
    /** Token usage breakdown, or `null` before the first turn. */
    contextUsage: SessionContextUsageSchema.nullable(),
    /** Cumulative session cost in USD, or `null` before the first turn. */
    cost: z.number().nullable(),
    /** Prompt-cache accounting, or `null` before the first turn. */
    cacheStats: SessionCacheStatsSchema.nullable(),
    /** Active model identifier, or `null` before the first turn. */
    model: z.string().nullable(),
    /** Active permission mode for the session. */
    permissionMode: PermissionModeSchema,
    /** Todo tallies, or `null` before the agent emits its first todo list. */
    todoCounts: SessionTodoCountsSchema.nullable(),
    /** Count of subagents currently running under this session. */
    runningSubagentCount: z.number().int().default(0),
    /** Coarse lifecycle phase of the session. */
    lifecycle: SessionLifecycleSchema,
  })
  .openapi('SessionStatus');

/** Inferred type for {@link SessionStatusSchema}. */
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// === Session Event Stream ===

/**
 * The projector-assigned monotonic sequence number carried by every session
 * event. Strictly non-negative and integer. Uniform across file-backed and
 * log-backed runtimes — it is NOT a JSONL line number (ADR-0263). Spread into
 * each discriminated-union member so a discriminator can still be applied.
 */
const seqShape = { seq: z.number().int().nonnegative() } as const;

/**
 * Shared interaction countdown fields preserved on the recoverable interaction
 * events. Both are server-assigned and required so a reconnecting client
 * resumes the countdown at the true offset without resetting it (ADR-0262).
 */
const interactionTimerShape = {
  /** Server timestamp (ms since epoch) when the interaction timer started. */
  startedAt: z.number(),
  /** Server-authoritative ms left before auto-deny, for drift-free resume. */
  remainingMs: z.number(),
} as const;

/**
 * Discriminated union (`type`) of every event a session projects onto its
 * monotonic stream. Each member carries an integer non-negative `seq`. The
 * three interaction members (`approval_required`, `question_prompt`,
 * `elicitation_prompt`) additionally carry the server-assigned
 * `startedAt`/`remainingMs` countdown fields (ADR-0262), reusing the
 * `PendingInteractionDTO` field shapes. Tool and turn payloads reuse the
 * existing StreamEvent shapes rather than introducing parallel types.
 */
export const SessionEventSchema = z
  .discriminatedUnion('type', [
    // Streamed assistant text.
    z.object({ ...seqShape, type: z.literal('text_delta'), ...TextDeltaSchema.shape }),
    // A tool invocation (reuses the StreamEvent tool-call payload).
    z.object({ ...seqShape, type: z.literal('tool_call'), ...ToolCallEventSchema.shape }),
    // A tool result (reuses the StreamEvent tool-call payload, which carries `result`).
    z.object({ ...seqShape, type: z.literal('tool_result'), ...ToolCallEventSchema.shape }),
    // A permission approval awaiting the operator (PendingInteractionDTO `approval` shape).
    z.object({
      ...seqShape,
      type: z.literal('approval_required'),
      ...interactionTimerShape,
      id: z.string(),
      toolName: z.string(),
      input: z.string(),
      title: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      blockedPath: z.string().optional(),
      decisionReason: z.string().optional(),
      hasSuggestions: z.boolean(),
    }),
    // A structured question awaiting the operator (PendingInteractionDTO `question` shape).
    z.object({
      ...seqShape,
      type: z.literal('question_prompt'),
      ...interactionTimerShape,
      id: z.string(),
      questions: z.array(QuestionItemSchema),
    }),
    // An MCP elicitation awaiting the operator (PendingInteractionDTO `elicitation` shape).
    z.object({
      ...seqShape,
      type: z.literal('elicitation_prompt'),
      ...interactionTimerShape,
      id: z.string(),
      serverName: z.string(),
      message: z.string(),
      mode: ElicitationModeSchema.optional(),
      url: z.string().optional(),
      elicitationId: z.string().optional(),
      requestedSchema: z.record(z.string(), z.unknown()).optional(),
    }),
    // A partial status update folded into the held SessionStatus. Both the
    // top-level keys AND the nested `contextUsage` fields are optional here: a
    // streaming `session_status` carries only `outputTokens`, while the final
    // one carries context/cache totals but NO `outputTokens`. The projector
    // merges these partials field-wise, so a delta must be able to omit any
    // field it does not carry rather than zeroing it. The snapshot's resolved
    // `SessionStatus.contextUsage` stays the full (non-partial) shape.
    z.object({
      ...seqShape,
      type: z.literal('status_change'),
      status: SessionStatusSchema.partial().extend({
        contextUsage: SessionContextUsageSchema.partial().nullable().optional(),
      }),
    }),
    // A todo-list update.
    z.object({
      ...seqShape,
      type: z.literal('todo_update'),
      action: z.enum(['create', 'update', 'snapshot']),
      task: TaskItemSchema,
      tasks: z.array(TaskItemSchema).optional(),
    }),
    // A subagent lifecycle update.
    z.object({
      ...seqShape,
      type: z.literal('subagent_update'),
      taskId: z.string(),
      status: BackgroundTaskStatusSchema,
      description: z.string().optional(),
      toolUses: z.number().int().optional(),
      lastToolName: z.string().optional(),
      summary: z.string().optional(),
    }),
    // The start of an assistant turn.
    z.object({ ...seqShape, type: z.literal('turn_start') }),
    // The end of an assistant turn.
    z.object({
      ...seqShape,
      type: z.literal('turn_end'),
      terminalReason: TerminalReasonSchema.optional(),
    }),
  ])
  .openapi('SessionEvent');

/** Inferred type for {@link SessionEventSchema}. */
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// === Session Snapshot ===

/**
 * A runtime-neutral hydration snapshot for a single session: the completed
 * message history, the in-progress turn (if any) as a list of events, the
 * server-held status, the pending interactions recoverable on reconnect, and
 * the `cursor` — the highest `seq` reflected in the snapshot. A client subscribes
 * with this cursor to replay only the events it has not yet seen.
 */
export const SessionSnapshotSchema = z
  .object({
    /** Completed message history for the session. */
    messages: z.array(HistoryMessageSchema),
    /** Events of the turn still in progress, or `null` when the session is idle. */
    inProgressTurn: z.array(SessionEventSchema).nullable(),
    /** Server-held status projection. */
    status: SessionStatusSchema,
    /** Pending interactions awaiting the operator (ADR-0262). */
    pendingInteractions: z.array(PendingInteractionDTOSchema),
    /** Highest `seq` reflected in this snapshot; the resume point for replay. */
    cursor: z.number().int().nonnegative(),
  })
  .openapi('SessionSnapshot');

/** Inferred type for {@link SessionSnapshotSchema}. */
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

// === Global Session-List Stream ===

/**
 * Discriminated union (`type`) of events on the global session-list stream that
 * feeds the sidebar and the fleet-wide status view. A session is upserted with
 * its full {@link SessionSchema} payload, removed by id, or has its status
 * projection updated in place.
 */
export const SessionListEventSchema = z
  .discriminatedUnion('type', [
    // A session was created or its metadata changed.
    z.object({ type: z.literal('session_upserted'), session: SessionSchema }),
    // A session was deleted.
    z.object({ type: z.literal('session_removed'), sessionId: z.string() }),
    // A session's status projection changed.
    z.object({
      type: z.literal('session_status'),
      sessionId: z.string(),
      status: SessionStatusSchema,
    }),
  ])
  .openapi('SessionListEvent');

/** Inferred type for {@link SessionListEventSchema}. */
export type SessionListEvent = z.infer<typeof SessionListEventSchema>;
