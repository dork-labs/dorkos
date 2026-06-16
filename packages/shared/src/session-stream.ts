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
  ThinkingDeltaSchema,
  ToolCallEventSchema,
  ToolProgressEventSchema,
  QuestionItemSchema,
  ElicitationModeSchema,
  TaskItemSchema,
  BackgroundTaskStatusSchema,
  TerminalReasonSchema,
  HookStatusSchema,
  MemoryRecallEventSchema,
  CompactBoundaryEventSchema,
  SystemStatusEventSchema,
  UiCommandEventSchema,
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
 *
 * The fidelity members (`thinking_delta`, `tool_progress`, `hook_update`,
 * `memory_recall`, `compact_boundary`, `system_status`) carry no durable status
 * projection — they exist so a LIVE turn renders with the same fidelity the
 * post-turn history reload provides (or, for the last two, drive transient
 * client UI the snapshot does not persist). Adapters MAY omit them (a runtime
 * with no thinking/hook/compaction concept emits nothing); clients degrade to a
 * lean render with no behavioral branch.
 */
export const SessionEventSchema = z
  .discriminatedUnion('type', [
    // Streamed assistant text.
    z.object({ ...seqShape, type: z.literal('text_delta'), ...TextDeltaSchema.shape }),
    // Streamed assistant thinking (extended reasoning). Delta semantics: clients
    // coalesce consecutive deltas into one thinking block, finalized by the next
    // non-thinking output.
    z.object({ ...seqShape, type: z.literal('thinking_delta'), ...ThinkingDeltaSchema.shape }),
    // A tool invocation (reuses the StreamEvent tool-call payload).
    z.object({ ...seqShape, type: z.literal('tool_call'), ...ToolCallEventSchema.shape }),
    // A tool result (reuses the StreamEvent tool-call payload, which carries `result`).
    z.object({ ...seqShape, type: z.literal('tool_result'), ...ToolCallEventSchema.shape }),
    // Incremental live output from a running tool (e.g. Bash stdout). Delta
    // semantics: clients append `content` to the tool part's progress output;
    // the terminal `tool_result` supersedes it.
    z.object({ ...seqShape, type: z.literal('tool_progress'), ...ToolProgressEventSchema.shape }),
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
    // A hook lifecycle update, collapsing the adapter's started/progress/response
    // phases into one member keyed by `hookId` (the `subagent_update` precedent).
    // Only `hookId` and `status` are always present: the start carries the
    // identity fields (`hookName`/`hookEvent`/`toolCallId`), progress carries the
    // cumulative `stdout`/`stderr`, and the terminal update carries the outcome
    // status plus `exitCode`. Clients merge updates field-wise onto the hook.
    z.object({
      ...seqShape,
      type: z.literal('hook_update'),
      hookId: z.string(),
      status: HookStatusSchema,
      hookName: z.string().optional(),
      hookEvent: z.string().optional(),
      /** Tool call this hook is attached to; `null`/absent for session-level hooks. */
      toolCallId: z.string().nullable().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      exitCode: z.number().optional(),
    }),
    // Memories surfaced into the turn by the SDK's memory supervisor.
    z.object({ ...seqShape, type: z.literal('memory_recall'), ...MemoryRecallEventSchema.shape }),
    // A context-window compaction boundary (SDK `compact_boundary`). Carries the
    // SDK `compact_metadata` so the client folds an inline "Compacted — N tokens
    // summarized (manual/auto)" row. Fidelity member: no status projection.
    z.object({
      ...seqShape,
      type: z.literal('compact_boundary'),
      ...CompactBoundaryEventSchema.shape,
    }),
    // A transient operational status (SDK status messages — "Compacting context…",
    // hook progress) plus the compaction resolution (`compactResult`/`compactError`).
    // Drives the client's transient status strip — NOT the durable SessionStatus
    // projection — so it rides the turn like a fidelity member; the client folds a
    // failed compaction into an inline error surface.
    z.object({
      ...seqShape,
      type: z.literal('system_status'),
      ...SystemStatusEventSchema.shape,
    }),
    // A pending interaction was resolved — by the operator (approved / denied /
    // answered) or WITHOUT operator action (`cancelled`: the SDK aborted the
    // gating tool call, e.g. a mid-turn steer superseding a pending question,
    // or the interaction timed out). Live clients remove the pending card and
    // stop its countdown — without this, resolution was only observable via
    // the next snapshot, leaving ghost (even answerable) cards on every other
    // window and after reconnect.
    z.object({
      ...seqShape,
      type: z.literal('interaction_resolved'),
      /** The interaction's id (toolCallId for approvals/questions). */
      id: z.string(),
      /** Outcome, when the resolver knows it; absent for generic clears. */
      resolution: z.enum(['approved', 'denied', 'answered', 'cancelled']).optional(),
    }),
    // The start of an assistant turn. Carries the user message that triggered
    // it (when the turn was DorkOS-triggered): the POST is trigger-only
    // (ADR-0264), so the durable stream is the only delivery path — and for a
    // log-backed runtime the EventLog is the only persistence, so the trigger
    // content must ride the stream or the reconstructed history would hold
    // answers with no questions. Optional: externally-driven turns (e.g. the
    // Claude CLI appending JSONL) have no DorkOS-observed trigger.
    z.object({ ...seqShape, type: z.literal('turn_start'), userMessage: z.string().optional() }),
    // The end of an assistant turn.
    z.object({
      ...seqShape,
      type: z.literal('turn_end'),
      terminalReason: TerminalReasonSchema.optional(),
    }),
    // An agent-issued imperative UI command (the `control_ui` MCP tool →
    // `ui-tools.ts`). Transient and side-effecting, NOT a durable state
    // projection: the server projector folds no status for it (the `default`
    // arm of `project()`), so it forwards live and rides `inProgressTurn` —
    // cleared at `turn_end`, never re-projected from a cold snapshot. Live
    // clients dispatch it through `executeUiCommand`; cross-reconnect canvas
    // state is restored from localStorage, not by replaying the command. The
    // command's own discriminated union is carried whole.
    z.object({ ...seqShape, type: z.literal('ui_command'), ...UiCommandEventSchema.shape }),
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
      // Working directory of the session, when the server knows it — lets
      // clients aggregate liveness per agent (sidebar agent rows light up
      // when any session in the agent's cwd is streaming/blocked).
      cwd: z.string().optional(),
      // Set on the re-announce after a first-turn rekey: the request UUID the
      // session streamed under before the canonical id resolved. Clients MUST
      // drop any status they hold under this id — transitions broadcast
      // pre-rekey land under it and no session_removed will ever fire for it.
      retiredSessionId: z.string().optional(),
      status: SessionStatusSchema,
    }),
  ])
  .openapi('SessionListEvent');

/** Inferred type for {@link SessionListEventSchema}. */
export type SessionListEvent = z.infer<typeof SessionListEventSchema>;

// === Resume Errors ===

/**
 * Thrown EAGERLY by `AgentRuntime.subscribeSession` (at call time, before any
 * iteration) when a resume cursor cannot be served gap-free: the cursor is
 * ahead of the session's current seq (the seq space was reset — e.g. a server
 * restart re-created the projector), or it predates the oldest retained event
 * (the replay buffer was trimmed past it).
 *
 * Callers (the `/events` route, in-process subscribers) MUST catch this and
 * fall back to the cold path — send a fresh snapshot, then subscribe from its
 * cursor — instead of resuming. Silently subscribing would leave the client
 * permanently deaf: the gap is unservable and a reset seq space filters every
 * future event below the stale cursor.
 */
export class StaleResumeCursorError extends Error {
  constructor(
    /** The session whose resume was rejected. */
    readonly sessionId: string,
    /** The unservable cursor the client presented. */
    readonly sinceCursor: number,
    message?: string
  ) {
    super(
      message ?? `Resume cursor ${sinceCursor} for session ${sessionId} cannot be served gap-free`
    );
    this.name = 'StaleResumeCursorError';
  }
}
