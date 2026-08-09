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
 * `startedAt`/`remainingMs` countdown fields (ADR-0264).
 *
 * @module shared/session-stream
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

import { PendingApprovalSchema, CapabilityApprovalOutcomeSchema } from './approval-schemas.js';
import {
  PermissionModeIdSchema,
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
  OperationProgressEventShapeSchema,
  UiCommandEventSchema,
  ErrorEventSchema,
  UsageStatusSchema,
  McpSigninRequiredEventSchema,
  McpSigninResolvedEventSchema,
  type ToolApprovalOutcome,
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
 * What a session is doing RIGHT NOW, structured rather than phrased.
 *
 * Only the two facts the server can actually know: which tool the session most
 * recently started, and the one argument of it a person would recognize (a file
 * name, a command excerpt). No prose rides the wire — the client owns the
 * wording, so a reading minted by an older server never puts stale copy on a
 * newer screen, and a consumer that is not a cockpit (a menu bar, a bot) can
 * phrase it its own way.
 *
 * The `toolName` is whatever the session's own runtime calls it, verbatim:
 * claude-code's `Bash`, codex's synthesized `Shell`/`ApplyPatch`, opencode's
 * lowercase `bash`, an MCP server's `mcp__slack__send_message`. Normalizing it
 * here would throw away the only thing a client can honestly fall back on when
 * it does not recognize the tool.
 */
export const SessionActivitySchema = z
  .object({
    /** The tool the session most recently started, named as its runtime names it. */
    toolName: z.string(),
    /**
     * The one human-relevant argument, when the input carried one a reader
     * would recognize — a file's basename, a command's first line, a search
     * pattern, a host. Absent when the tool takes no such argument, or when the
     * input could not be read: a client says less rather than inventing it.
     */
    target: z.string().optional(),
  })
  .openapi('SessionActivity');

/** Inferred type for {@link SessionActivitySchema}. */
export type SessionActivity = z.infer<typeof SessionActivitySchema>;

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
    /**
     * Runtime-neutral usage/cost descriptor (subscription utilization or
     * pay-as-you-go cost), or `null` before the runtime reports one. Merged
     * whole-object on each `status_change`: the producing mapper re-attaches
     * held subscription fields, so a partial never needs field-wise merging.
     * The `.default(null)` keeps pre-usage snapshots parsing (version skew).
     */
    usage: UsageStatusSchema.nullable().default(null),
    /** Prompt-cache accounting, or `null` before the first turn. */
    cacheStats: SessionCacheStatsSchema.nullable(),
    /** Active model identifier, or `null` before the first turn. */
    model: z.string().nullable(),
    /**
     * Active permission mode for the session — the id the session's OWN
     * runtime reports, not necessarily a member of the narrower
     * `PermissionModeSchema` enum (DOR-851). See `PermissionModeIdSchema`
     * and the matching note on `SessionSchema.permissionMode`.
     */
    permissionMode: PermissionModeIdSchema,
    /** Todo tallies, or `null` before the agent emits its first todo list. */
    todoCounts: SessionTodoCountsSchema.nullable(),
    /** Count of subagents currently running under this session. */
    runningSubagentCount: z.number().int().default(0),
    /** Coarse lifecycle phase of the session. */
    lifecycle: SessionLifecycleSchema,
    /**
     * Details of the most recent turn failure. Non-null only while the
     * session's last closed turn ended in error; cleared at the next
     * `turn_start` and by any `turn_end` that does not settle to the `error`
     * lifecycle. The `.default(null)` keeps old snapshots parsing (version skew).
     */
    lastError: ErrorEventSchema.nullable().default(null),
    /**
     * What this session is doing right now ({@link SessionActivitySchema}), or
     * ABSENT when nothing is known — an idle session, a turn that has not
     * reached a tool yet, or a status minted by a server that predates the
     * field. Optional rather than nullable-with-a-default precisely so absent is
     * the only "nothing" there is: one shape for "we don't know", which is what
     * every consumer degrades on.
     *
     * Set by the projector on each `tool_call` and cleared by it at every turn
     * boundary. It is the one field here that is deliberately EPHEMERAL: a verb
     * that outlives its turn is a lie, and a lying verb is worse than none.
     */
    activity: SessionActivitySchema.optional(),
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
 * resumes the countdown at the true offset without resetting it (ADR-0264).
 */
const interactionTimerShape = {
  /** Server timestamp (ms since epoch) when the interaction timer started. */
  startedAt: z.number(),
  /** Server-authoritative ms left before auto-deny, for drift-free resume. */
  remainingMs: z.number(),
} as const;

/**
 * The session events that stop a turn to wait on a person.
 *
 * One list, because two copies drift: the session projector folds all three
 * into lifecycle `blocked`, and the Telegram adapter stops its typing
 * indicator on all three for the same reason — the agent is not working, it is
 * waiting. Anything added here must be a state a person has to resolve.
 */
export const BLOCKING_INTERACTION_EVENT_TYPES = [
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
] as const;

/** A session event type that blocks the turn on a person. */
export type BlockingInteractionEventType = (typeof BLOCKING_INTERACTION_EVENT_TYPES)[number];

/**
 * Does this event type block the turn on a person?
 *
 * For callers holding only a discriminator string — a relay adapter reading a
 * `type` off the wire, say. Callers holding the event itself want
 * {@link isBlockingInteractionEvent}, which narrows the union.
 *
 * @param type - A session-event or stream-event `type` discriminator
 */
export function isBlockingInteractionEventType(type: string): type is BlockingInteractionEventType {
  return (BLOCKING_INTERACTION_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Does this event block the turn on a person?
 *
 * Narrows to the interaction members, so a caller can reach the `id` and
 * countdown fields only those three carry.
 *
 * @param event - Any event carrying a `type` discriminator
 */
export function isBlockingInteractionEvent<T extends { type: string }>(
  event: T
): event is Extract<T, { type: BlockingInteractionEventType }> {
  return isBlockingInteractionEventType(event.type);
}

/**
 * Discriminated union (`type`) of every event a session projects onto its
 * monotonic stream. Each member carries an integer non-negative `seq`. The
 * three interaction members (`approval_required`, `question_prompt`,
 * `elicitation_prompt`) additionally carry the server-assigned
 * `startedAt`/`remainingMs` countdown fields (ADR-0264), reusing the
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
      /**
       * The full budget this ask was given, from the runtime that enforces the
       * auto-deny. The card's countdown and draining bar are both gated on it,
       * so an emission without it renders an ask with no visible deadline
       * (DOR-810). Optional: a replay of an event recorded before the field
       * existed must still parse.
       */
      timeoutMs: z.number().optional(),
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
    //
    // `activity` is OMITTED, and that omission is the whole of its ownership
    // rule. Every other field here is something a runtime reports about
    // itself; `activity` is something the PROJECTOR derives, from the
    // `tool_call` events it has actually seen, and clears at every turn
    // boundary it controls. Left in the partial it would be a key any runtime's
    // status delta could set — merged straight into the held status and fanned
    // out fleet-wide — which is a runtime naming a tool the session never
    // started. Nothing produces it (the normalizer maps no source field to it),
    // so the delta simply cannot express it.
    z.object({
      ...seqShape,
      type: z.literal('status_change'),
      status: SessionStatusSchema.omit({ activity: true }).partial().extend({
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
    // A transient operational status (SDK status messages — hook progress, a raw
    // `status` token). Drives the client's transient status strip — NOT the
    // durable SessionStatus projection — so it rides the turn like a fidelity
    // member. Operation lifecycle (compaction) rides `operation_progress` instead.
    z.object({
      ...seqShape,
      type: z.literal('system_status'),
      ...SystemStatusEventSchema.shape,
    }),
    // Runtime-agnostic progress for a named long-running operation (DOR-110 —
    // compaction start → done/failed). Fidelity member: drives the status strip's
    // progress treatment and, on `failed`, the inline compaction error row; no
    // durable status projection. A runtime with no such operation emits nothing.
    z.object({
      ...seqShape,
      type: z.literal('operation_progress'),
      // The base object shape (not the refined schema — a discriminatedUnion
      // member must be a plain object). The cross-field invariants are enforced
      // upstream on the StreamEvent's OperationProgressEventSchema; this member
      // carries data already validated there via the normalizer.
      ...OperationProgressEventShapeSchema.shape,
    }),
    // A typed turn error, adapter-yielded (a runtime's `error` StreamEvent) or
    // server-injected (`guardTurnErrors` on a throw, the stall watchdog). It
    // renders inline in the live turn and drives `SessionStatus.lastError`.
    // Non-terminal: the turn still closes via `turn_end` (the normalizer's
    // error latch fills `terminalReason: 'error'` when no explicit reason came).
    z.object({ ...seqShape, type: z.literal('error'), ...ErrorEventSchema.shape }),
    // A pending interaction was resolved — by the operator (approved / denied /
    // answered) or WITHOUT operator action (`expired`: the interaction ran out
    // its timer and was auto-denied; `cancelled`: the SDK aborted the gating
    // tool call, e.g. a mid-turn steer superseding a pending question). Live
    // clients remove the pending card and stop its countdown — without this,
    // resolution was only observable via the next snapshot, leaving ghost (even
    // answerable) cards on every other window and after reconnect.
    //
    // `expired` and `cancelled` both mean "no operator action", but they are
    // NOT interchangeable to a reader: an expiry is an answer the system gave
    // on the person's behalf and belongs in the transcript as a receipt, while
    // an abort is a request nobody was ever asked to answer.
    z.object({
      ...seqShape,
      type: z.literal('interaction_resolved'),
      /** The interaction's id (toolCallId for approvals/questions). */
      id: z.string(),
      /** Outcome, when the resolver knows it; absent for generic clears. */
      resolution: z.enum(['approved', 'denied', 'answered', 'expired', 'cancelled']).optional(),
      /**
       * WHICH KIND of interaction this resolved, backfilled by the projector
       * from the entry it is about to drop.
       *
       * Not redundant with `resolution`, and not inferable from it: the three
       * interaction kinds share a cancellation path, so a timed-out question
       * and a timed-out permission prompt both resolve `expired`, and a
       * declined elicitation carries the same `denied` a refused permission
       * does. A consumer that renders one kind differently from another has to
       * be told which it has — inferring it from the outcome put "Expired —
       * denied" over questions nobody was ever asked to approve.
       */
      kind: z.enum(['approval', 'question', 'elicitation']).optional(),
      /**
       * Server epoch ms when the interaction resolved. Timestamps the durable
       * record a client keeps of the answer; optional so a runtime that cannot
       * say when simply omits it (the record renders without a time).
       */
      at: z.number().optional(),
      /**
       * Server epoch ms when the interaction BEGAN, backfilled by the projector
       * from the entry it is about to drop. Paired with `at` it says how long
       * the request waited — the only way a client can state that, because a
       * live client never sees `approval_required` inside the turn (it arrives
       * as a pending DTO, which this very event retires).
       */
      startedAt: z.number().optional(),
      /**
       * Whether the person's own words were delivered to the agent with this
       * denial. The transcript receipt says "agent was told why" on the
       * strength of this and nothing else, so it is set by the code that
       * actually hands the runtime the reason — never inferred from the deny UI
       * having offered a field. Absent on an `expired` resolution: the clock
       * answered, and it explained nothing.
       */
      reasonGiven: z.boolean().optional(),
    }),
    // An agent-initiated DESTRUCTIVE capability call held in-session, awaiting
    // the operator's decision (DOR-939 / spec approvals-resume-inline). The
    // same approval a person answers on the dashboard is rendered inline here,
    // and the SAME `approvalId` resolves both — the inline card calls the
    // capability decision route (`POST /api/approvals/:id/grant|deny`), never
    // the SDK `approveTool` path. Deliberately NOT a
    // `BLOCKING_INTERACTION_EVENT_TYPES` member: it does not ride the
    // PendingInteractionDTO recovery machinery (the hold is bounded by
    // `capMs`, and its inline card recovers from the in-progress-turn replay).
    // The projector tracks it as a pending HOLD so the stall watchdog pauses
    // and the session lock is not stolen while the person decides.
    z.object({
      ...seqShape,
      type: z.literal('capability_approval_required'),
      /** Server epoch ms when the hold began — the projector bounds its own expiry on this. */
      startedAt: z.number(),
      /** How long the hold waits before it degrades to the poll payload (the hold cap). */
      capMs: z.number(),
      /** The pending approval, rendered inline exactly as the dashboard card renders it. */
      approval: PendingApprovalSchema,
    }),
    // The in-session capability hold ended — an operator decision (`granted`/
    // `denied`) the held call resumed on, or a no-decision path (`expired`/
    // `timeout`) that degraded it back to the poll payload. Retires the inline
    // card everywhere and drops the projector's pending hold so the stall
    // watchdog re-arms for the rest of the turn.
    z.object({
      ...seqShape,
      type: z.literal('capability_approval_resolved'),
      /** The approval the hold was waiting on. */
      approvalId: z.string(),
      /** How it ended. */
      outcome: CapabilityApprovalOutcomeSchema,
    }),
    // An agent asked a person to sign in to an OAuth-protected managed MCP
    // server, and the card belongs in the conversation (DOR-1004). Pushed by the
    // in-session capability adapter when `mcp.signin` runs on a surface that has
    // a conversation to draw a card in; the sessionless surfaces (external
    // `/mcp`, HTTP) get no event and keep the full link-carrying message.
    //
    // Deliberately NOT a hold, and deliberately NOT tracked as a pending
    // interaction: a browser OAuth round trip routinely outlasts any safe hold,
    // so the tool call returns, the turn ends, and the card OUTLIVES its turn —
    // which is why the projector carries it into later snapshots rather than
    // letting `turn_end` drop it with the rest of the turn.
    z.object({
      ...seqShape,
      type: z.literal('mcp_signin_required'),
      ...McpSigninRequiredEventSchema.shape,
    }),
    // The in-conversation sign-in reached a terminal state (DOR-1004). Retires
    // the card on `connected`; leaves it as a terminal note on `failed`.
    z.object({
      ...seqShape,
      type: z.literal('mcp_signin_resolved'),
      ...McpSigninResolvedEventSchema.shape,
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
    // A server→client screenshot request (the `browser_screenshot` MCP tool,
    // DOR-213 Phase 3). Transient and side-effecting like `ui_command`: the
    // attached client forwards it into the preview frame, the in-page shim
    // rasterizes its own document, and the result returns via the devtools
    // ingest route tagged with this `requestId` — resolving the awaiting tool.
    // Never re-projected from a cold snapshot (a reconnect must not re-trigger
    // a stale capture; the tool's timeout has long since fired).
    z.object({
      ...seqShape,
      type: z.literal('devtools_capture_request'),
      requestId: z.string(),
    }),
  ])
  .openapi('SessionEvent');

/** Inferred type for {@link SessionEventSchema}. */
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** The `interaction_resolved` member of the session-event union. */
export type InteractionResolvedEvent = Extract<SessionEvent, { type: 'interaction_resolved' }>;

/**
 * How an approval request was ANSWERED, as the transcript records it forever.
 *
 * Narrower than {@link InteractionResolvedEvent}'s `resolution` on purpose: an
 * outcome exists only where there is an answer worth keeping. Re-exported from
 * `ToolApprovalOutcomeSchema` rather than restated, so the one enum in the wire
 * schema is the only place these three words are written down.
 */
export type { ToolApprovalOutcome };

/**
 * The receipt an answered approval leaves behind, keyed by resolution.
 * `cancelled` and `answered` are absent on purpose: an SDK abort withdrew the
 * ask before anyone answered it, and `answered` belongs to questions, which
 * keep their own answered summary.
 */
const APPROVAL_OUTCOME_BY_RESOLUTION: Partial<
  Record<NonNullable<InteractionResolvedEvent['resolution']>, ToolApprovalOutcome>
> = { approved: 'allowed', denied: 'denied', expired: 'expired' };

/**
 * The permanent record a resolved interaction earns, or `undefined` when it
 * earns none.
 *
 * ONE definition for every consumer: the client's live fold, the log-backed
 * history reconstruction, and the server-side overlay onto runtime-owned
 * history all read a receipt out of the same event, so a session's transcript
 * says the same thing whether it is being watched live or reopened a week
 * later. Two rules, and neither is inferable from the other half:
 *
 * - The KIND must be `approval`. The three interaction kinds share a
 *   cancellation path, so a timed-out question resolves `expired` exactly as a
 *   timed-out permission prompt does, and a declined elicitation carries the
 *   same `denied` a refused permission does. Reading the kind out of the
 *   outcome printed "Expired — denied" over questions nobody was asked to
 *   approve.
 * - The RESOLUTION must be one somebody (or the timer, on their behalf)
 *   actually gave. A `cancelled` ask was withdrawn before it could be answered.
 *
 * @param event - The resolving `interaction_resolved` event.
 * @returns The outcome to record, or `undefined` when there is nothing to record.
 */
export function approvalOutcomeOf(
  event: Pick<InteractionResolvedEvent, 'resolution' | 'kind'>
): ToolApprovalOutcome | undefined {
  if (event.kind !== 'approval' || event.resolution === undefined) return undefined;
  return APPROVAL_OUTCOME_BY_RESOLUTION[event.resolution];
}

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
    /** Pending interactions awaiting the operator (ADR-0264). */
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
