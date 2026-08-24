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
import { PendingApprovalSchema, CapabilityApprovalOutcomeSchema } from './approval-schemas.js';
import {
  SidebarPrefsSchema,
  ShapeUserPrefsSchema,
  StatusBarPrefsSchema,
  ComposerPrefsSchema,
  NotificationPrefsSchema,
} from './config-schema.js';
// The effort ladder itself lives in the dependency-free constants module so this
// file and `config-schema.ts` (which this file already imports) can both build
// their enums from ONE list — see `EFFORT_LEVELS` for why it cannot live in either.
import { EFFORT_LEVELS } from './constants.js';
// Type-only import: `ui-widget.ts` value-imports `UiCommandSchema` from this
// module, so a value import of `WidgetDocumentSchema` here would form a
// load-time cycle. The canvas `widget` content carries the document typed but
// validated on the client (see the `widget` variant note below).
import type { WidgetDocument } from './ui-widget.js';
// Type-only: the stop vocabulary's home is the runtime contract, and this module
// only restates it for the wire (see `PermissionStopSchema`).
import type { PermissionStop } from './agent-runtime.js';

extendZodWithOpenApi(z);

// === Enums ===

/**
 * The permission-mode ids DorkOS's own long-lived surfaces name directly —
 * scheduled tasks, relay bindings, config defaults.
 *
 * NOT the set of ids that exist. A runtime names its own modes and declares
 * what each one does, so this enum is the union of the names DorkOS's runtimes
 * happen to use, not a definition. Do NOT reach for it to validate a mode id
 * arriving from a client: use {@link PermissionModeIdSchema} and let the
 * session's own runtime say whether it declares the id (`test-mode` names all
 * three of its modes outside this enum on purpose).
 */
export const PermissionModeSchema = z
  .enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'])
  .openapi('PermissionMode');

/** A permission-mode id DorkOS names directly. See {@link PermissionModeSchema}. */
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * A permission-mode id as a REQUEST carries it — any well-formed id, not a
 * member of {@link PermissionModeSchema}.
 *
 * ## Why this is a string and not the enum
 *
 * A runtime names its own permission modes: `PermissionModeDescriptor.id` is a
 * `string`, and what a mode MEANS is read off the descriptor's semantics
 * (`stop`/`asks`/`reach`), never off its name. `PermissionModeSchema` is the
 * union of the ids DorkOS's own runtimes happened to pick, so validating a
 * request against it is a hardcoded id list wearing a schema — and it was
 * wrong in practice: `test-mode` deliberately names its three modes outside
 * that union, so its mode picker could never be applied. The request was
 * refused at the schema boundary before anything that knows about runtimes got
 * to look at it.
 *
 * ## What still validates the id
 *
 * This shape check is a bound, not the authority. The authority is the owning
 * runtime's own capability declaration, enforced server-side in
 * `PATCH /api/sessions/:id`: an id that runtime does not declare is refused
 * with `UNSUPPORTED_PERMISSION_MODE`, whether or not the shared enum contains
 * it. The refusal moved from a list of names to the runtime that owns the
 * session, which is the only thing that can answer the question correctly.
 *
 * The pattern and length bound keep an id that no runtime could ever declare
 * out of a persisted settings row or a log line.
 *
 * ## This shape is a CONTRACT on declared ids, not just a filter on requests
 *
 * A bound only stays honest if every id a runtime can declare fits through it —
 * otherwise a runtime naming a mode `_internal` or `read only` gets the DOR-811
 * defect back, refused for its shape before its own runtime is consulted, with
 * the enum swapped for a regex. So every mode every shipped runtime declares is
 * checked against this schema by
 * `apps/server/src/services/runtimes/__tests__/permission-semantics.test.ts`,
 * alongside the rest of the descriptor contract. A profile that names a mode
 * outside this shape fails that suite; widen the pattern here rather than
 * working around it there.
 *
 * ## Also the shape of the OUTGOING id (DOR-851)
 *
 * `Session.permissionMode` and `SessionStatus.permissionMode` carry the SAME
 * kind of value on the way out that this schema validates on the way in: the
 * id the session's own runtime actually reports, which for `test-mode` is one
 * of its three deliberately-non-enum ids. Before DOR-851 those two fields still
 * validated against {@link PermissionModeSchema} — harmless while every runtime
 * happened to report an enum id, but the moment `test-mode`'s birth mode
 * started reporting its OWN declared default (DOR-811's fix, `always-allow`)
 * every `session_upserted`/`session_status` broadcast for that runtime failed
 * `SessionListEventSchema` and was silently dropped by
 * `SessionListBroadcaster`, emptying the session list for that runtime's
 * sessions entirely. The two directions are the same contract — a runtime
 * names its own modes — so they share this one schema.
 */
export const PermissionModeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Not a valid permission mode id')
  .openapi('PermissionModeId');

/** A permission-mode id as a request carries it. See {@link PermissionModeIdSchema}. */
export type PermissionModeId = z.infer<typeof PermissionModeIdSchema>;

/**
 * A Trust Dial position on the wire — the runtime-neutral half of a permission
 * mode (spec `trust-dial`, decision 2).
 *
 * The vocabulary's home is {@link PermissionStop} in `agent-runtime.ts`, which
 * every runtime declares against; this is the same three words in the shape the
 * API and OpenAPI export need. The two are pinned together by
 * {@link AssertStopVocabulary} below, so adding a fourth stop in one place fails
 * the build rather than shipping two disagreeing lists.
 */
export const PermissionStopSchema = z.enum(['ask', 'act', 'autonomy']).openapi('PermissionStop');

/** A Trust Dial position. See {@link PermissionStopSchema}. */
export type PermissionStopValue = z.infer<typeof PermissionStopSchema>;

/**
 * Compile-time proof that the wire enum and {@link PermissionStop} name the same
 * three stops, in both directions. Never evaluated; `never` on either side is a
 * type error at the declaration.
 *
 * @internal
 */
type AssertStopVocabulary = [PermissionStopValue] extends [PermissionStop]
  ? [PermissionStop] extends [PermissionStopValue]
    ? true
    : never
  : never;
const _assertStopVocabulary: AssertStopVocabulary = true;
void _assertStopVocabulary;

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
    'capability_approval_required',
    'capability_approval_resolved',
    'mcp_signin_required',
    'mcp_signin_resolved',
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

export const EffortLevelSchema = z.enum(EFFORT_LEVELS).openapi('EffortLevel');
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * What started a session.
 *
 * `channel` is a BRIDGED chat (Telegram, Slack, a webhook) and `room` is one of
 * this machine's own rooms — a channel or a DM in the cockpit. They are two
 * different facts and the names are unfortunately close, which is why `room`
 * exists rather than being folded into `channel`: a room's turns are engine runs
 * under a thread the reader can already see (ADR 260808-140954,
 * thread-over-sessions), so a surface that lists threads has to be able to tell
 * them apart and drop the run.
 *
 * `room` is only ever assigned by the server-side overlay that joins against
 * `room_sessions` — the transcript-head classifier cannot see it, because a room
 * turn carries no marker of its own.
 */
export const SessionOriginSchema = z
  .enum(['user', 'agent', 'channel', 'room', 'task', 'external'])
  .openapi('SessionOrigin');
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastMessagePreview: z.string().optional(),
    /**
     * The id the session's OWN runtime reports, not necessarily a member of
     * {@link PermissionModeSchema} (DOR-851) — `test-mode` reports its three
     * deliberately-non-enum ids, and this field carries whatever a runtime's
     * own descriptor names. See {@link PermissionModeIdSchema}.
     */
    permissionMode: PermissionModeIdSchema,
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
     * auto-compacted, or the boundary has scrolled past the 64 KB tail window
     * as the session grew (an honest, disclosed limitation; durable recency is
     * a deferred follow-up). Drives the row's discreet "auto-compacted" marker.
     */
    lastAutoCompactAt: z.string().datetime().optional(),
    /**
     * Best-effort classification of what initiated this session, derived from
     * durable markers in the transcript head (never persisted, never trusted as
     * a security boundary). ABSENT means user-initiated — the unmarked default —
     * so runtimes that never receive automated traffic need no changes.
     */
    origin: SessionOriginSchema.optional(),
    /**
     * Short human-readable origin descriptor for non-user origins, e.g.
     * "Telegram", "warden (agent)", "Scheduled task · daily-digest", "A2A client".
     * Absent when `origin` is absent or no better label than the kind exists.
     */
    originLabel: z.string().optional(),
    /**
     * The id of the room that started this session, when one did — the exact
     * room, not a name that might belong to two of them.
     *
     * Present only alongside `origin: 'room'`, and stamped from the server's own
     * `room_sessions` binding (`applyRoomOriginOverlay`). ABSENT everywhere else,
     * including on a room turn that a scheduled run then claims: Pulse wins the
     * origin, so it takes this with it rather than leaving an id under a `task`.
     *
     * **Why it exists beside {@link Session.originLabel}, which names the same
     * room.** A label is a name and names are not unique here. Channel slugs are
     * unique only among LIVE channels (`rooms_channel_slug_unique` is partial on
     * `archived = 0`), so an archived `#shipping` and a live `#shipping` are both
     * legal at once — and nothing stops a direct message being titled `#general`.
     * A client joining conversations to rooms by label had to pick one of the
     * colliding rooms and was silently wrong for the other: turns from the
     * archived room were offered under the live one, and the losing room showed
     * no conversations at all (DOR-1157). An id cannot collide.
     *
     * The label stays: it is what a person READS, it tracks renames (the binding
     * is joined to the live `rooms` row on every request), and it is the honest
     * fallback for a room this reader cannot see.
     */
    originRoomId: z.string().optional(),
    /**
     * Which Claude Code account this session belongs to — the absolute Claude
     * config directory its transcript lives under (`~/.claude`, `~/.claude2`,
     * …). Derived from disk on every read and never stored: a session's
     * transcript exists under exactly one account, and that is also the only
     * account that can resume it (spec `claude-code-accounts` D3). ABSENT means
     * the account is unknown — the unmarked default — so runtimes with no
     * account concept (codex, opencode) need no changes and neither does a
     * single-account machine's history. Best-effort, never a security boundary;
     * a client turns it into a human label by matching it against the
     * registered accounts in `GET /api/config`.
     */
    account: z.string().optional(),
    /**
     * ISO-8601 timestamp of the last message a PERSON sent in this session —
     * the server half of the sidebar's interaction-recency order key
     * (`lastInteractionAt = max(userLastMessageAt, userLastOpenedAt)`, spec
     * `sidebar-now-today-library` BC-16). The name matches BC-16 and the
     * client's own key rather than the `last…At` shape of its neighbours here,
     * because one name across the wire and the consumer is worth more than
     * local symmetry.
     *
     * Deliberately NOT {@link Session.updatedAt}: `updatedAt` moves every time
     * the AGENT writes (for claude-code it is the transcript's mtime), which is
     * exactly the signal Today must not reorder on. This field moves only when
     * a person writes, so a row whose agent has been working for an hour keeps
     * its place.
     *
     * ABSENT means nobody can honestly say — omission, never a guess, and the
     * client then orders that row by its local `userLastOpenedAt` alone. It is
     * absent in four situations, and the last two are the interesting ones:
     *
     * 1. **The runtime cannot derive it.** Codex, opencode and test-mode all
     *    omit it; each says why in its conformance declaration.
     * 2. **The person's last turn is out of reach.** Claude-code reads it from
     *    the transcript tail it already reads (64 KB), which covered ~90% of
     *    conversations touched in the last week when measured over 474 real
     *    transcripts. A longer agent monologue pushes the turn out of the
     *    window and the row honestly says nothing.
     * 3. **Nobody wrote the message.** The `user` role is a wire role, not an
     *    author: tool results, resume bootstraps, compaction summaries, DorkOS's
     *    own corrective notes and relay hand-offs from other agents all arrive
     *    on it, and none of them count.
     * 4. **Nobody wrote in the SESSION.** A scheduled task's prompt and a room
     *    post by another agent arrive as plain, unmarked user text that no
     *    content rule can tell from something you typed — so a session whose
     *    `origin` is `agent`, `task` or `room` reports nothing at all. A
     *    `channel` session still reports: that IS a person, writing from
     *    Telegram or Slack.
     *
     * Best-effort and never a security boundary — the markers it reads are the
     * same advisory ones {@link Session.origin} is derived from.
     */
    userLastMessageAt: z.string().datetime().optional(),
    cwd: z.string().optional(),
  })
  .openapi('Session');

export type Session = z.infer<typeof SessionSchema>;

/**
 * What `PATCH /api/sessions/:id` answers with: the session as it now stands,
 * plus — on a `202` — the one thing the session itself cannot say.
 *
 * The extra field is deliberately NOT part of {@link SessionSchema}. It is a
 * fact about one write at one moment, not a property of the session, and a
 * session carrying it around would go stale the instant the next turn started.
 */
export const SessionUpdateResponseSchema = SessionSchema.extend({
  /**
   * The stricter permission mode is saved, but the reply already in flight
   * keeps the looser one it started under — the new mode applies from the next
   * reply. Present only on a `202`, and only for a tightening.
   */
  permissionModePendingUntilNextTurn: z.literal(true).optional(),
}).openapi('SessionUpdateResponse');

/** Inferred type for {@link SessionUpdateResponseSchema}. */
export type SessionUpdateResponse = z.infer<typeof SessionUpdateResponseSchema>;

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
  /**
   * The mode to switch to — any id the session's runtime declares, checked
   * against that runtime rather than against a fixed list of names. See
   * {@link PermissionModeIdSchema}.
   */
  permissionMode: PermissionModeIdSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  /**
   * "The person asked for this, and they were told what it means." Required —
   * as this flag or as the standing record in `ui.autonomyAcknowledgedAt` — on
   * any request that moves an interactive session to a Full-autonomy mode, and
   * ignored on every other request (spec `trust-dial`, decision 5).
   *
   * Deliberately NOT part of {@link SessionSettingsSchema}: it is a statement
   * about this one request, not a setting. Nothing persists it, and the next
   * PATCH has to say it again.
   *
   * It proves a ritual happened, not an identity. Any caller can send `true`;
   * see `ui.autonomyAcknowledgedAt` for what this does and does not defend.
   */
  acknowledgedAutonomy: z.boolean().optional(),
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

/**
 * Longest `seedContext` accepted. Room enough for a page's worth of background
 * and short enough that a paste accident — or a caller looping a whole document
 * into it — cannot quietly become most of the agent's prompt. The person cannot
 * see this text, so a runaway one is a cost nobody can spot from the UI.
 */
export const SEED_CONTEXT_MAX_LENGTH = 10_000;

// === Message disposition & the server-owned queue ===

/**
 * What a sender wants done with a message while a turn is already running
 * (spec `persistent-session-runtime`, ADR `260816-143752`).
 *
 * - `queue` — wait for the running turn to end, then run it. Always available:
 *   the SERVER owns the queue, so no runtime has to.
 * - `steer` — hand it to the agent mid-turn, so it changes course now.
 * - `stage` — put it in front of the agent as context for the turn it is
 *   already running, without asking it to change course.
 *
 * **Ignored when the session is IDLE.** With no turn open there is nothing to
 * wait behind, steer, or stage into, so every disposition means the same thing:
 * run it now. A sender never has to check whether the session is busy before
 * choosing one.
 *
 * Defaults to `queue` at every ingress — the route, the dispatcher, and the
 * store all read an absent disposition as `queue`, so a caller that says
 * nothing gets the behavior that is always supported.
 */
export const MessageDispositionSchema = z
  .enum(['queue', 'steer', 'stage'])
  .openapi('MessageDisposition');

/** What a sender asked be done with a message. See {@link MessageDispositionSchema}. */
export type MessageDisposition = z.infer<typeof MessageDispositionSchema>;

/**
 * Why a requested {@link MessageDispositionSchema} was not the one applied.
 *
 * Carried on {@link MessageDeliveryOutcomeSchema} so the cockpit can say
 * "queued instead of steered — this runtime cannot steer mid-turn" rather than
 * quietly doing something other than what was asked.
 *
 * - `unsupported` — the session's runtime does not declare the capability, so a
 *   stage folded into the next dispatch instead of reaching the transcript
 *   natively (to the person a stage landed either way; this says how).
 * - `session-idle` — no turn was running, so the message ran immediately. The
 *   one downgrade worth staying quiet about: "it ran now" is not a loss.
 * - `not-steerable` — a turn WAS running and the runtime could not join it,
 *   because the mechanism that cuts in is not under this session (the runtime's
 *   `canSteerSession`). Distinct from `session-idle`, which
 *   it used to be reported as: nothing ran early here, the message went to the
 *   back of the line, and the sender has to be told (DOR-1268).
 * - `not-stageable` — the runtime CAN stage, but the seam that does it is not
 *   under this session (the runtime's `canStageSession`), so the words were
 *   folded into the next dispatch instead of reaching the transcript now. The
 *   stage still landed. Distinct from `unsupported`, which claimed the adapter
 *   could not stage at all and so contradicted its own declared capability on
 *   every default claude-code install (DOR-1307).
 * - `turn-owned-elsewhere` — a turn IS open (checked against the session's own
 *   projection, never assumed) and a DIFFERENT caller started it, so this sender
 *   may not write into it: a steer is a write, gated by the same lock a send
 *   passes. The caller need not be another window — a room, an MCP client and an
 *   embedded surface all hold the lock under their own ids — so nothing built on
 *   this may name one. The message waits in the queue instead. It replaced
 *   `no-open-turn`, which folded this together with "the turn had ended" and so
 *   let the cockpit tell a person their task had finished while it was visibly
 *   running (DOR-1315).
 * - `pending-interaction` — the turn is waiting on a person (a permission ask,
 *   a question), and delivering into that would answer something nobody was
 *   asked.
 */
export const DispositionDowngradeReasonSchema = z
  .enum([
    'unsupported',
    'session-idle',
    'not-steerable',
    'not-stageable',
    'turn-owned-elsewhere',
    'pending-interaction',
  ])
  .openapi('DispositionDowngradeReason');

/** Why a disposition was downgraded. See {@link DispositionDowngradeReasonSchema}. */
export type DispositionDowngradeReason = z.infer<typeof DispositionDowngradeReasonSchema>;

/**
 * What actually happened to an accepted message — the receipt every ingress
 * returns and every `queue_update` carries.
 *
 * `requested` and `applied` are both present, always, even when they match:
 * a consumer decides whether to say anything by comparing them, never by the
 * presence of a field.
 */
export const MessageDeliveryOutcomeSchema = z
  .object({
    /** Server-minted id for the message this outcome is about. */
    messageId: z.string(),
    /** What the sender asked for. */
    requested: MessageDispositionSchema,
    /** What the server did. Equal to `requested` when nothing was downgraded. */
    applied: MessageDispositionSchema,
    /** Why they differ; absent when they do not. */
    degradedBecause: DispositionDowngradeReasonSchema.optional(),
  })
  .openapi('MessageDeliveryOutcome');

/** What happened to an accepted message. See {@link MessageDeliveryOutcomeSchema}. */
export type MessageDeliveryOutcome = z.infer<typeof MessageDeliveryOutcomeSchema>;

/** One message waiting to be dispatched to a session. */
export const QueuedMessageSchema = z
  .object({
    /** Server-minted id; the same id the delivery outcome correlates on. */
    id: z.string(),
    /** The person's words, pristine — context injection never mutates them. */
    content: z.string(),
    /** The disposition as REQUESTED, not as applied. */
    disposition: MessageDispositionSchema,
    /** Epoch ms the message was accepted. */
    enqueuedAt: z.number(),
    /** The client that enqueued it, so a window can tell its own from another's. */
    enqueuedBy: z.string(),
  })
  .openapi('QueuedMessage');

/** One message waiting on a session's queue. See {@link QueuedMessageSchema}. */
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

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
     * Which Claude Code account this session should run and BILL on — a
     * registry id (`runtimes.claudeCode.accounts[].id`), never a path.
     *
     * A launch hint, on the same lifecycle as `runtime` above: honored only on
     * the message that CREATES the session, and only for the claude-code
     * runtime. A later send, another runtime, or an id that is not registered is
     * ignored with a logged warning — after launch the account is a fact on disk
     * (ADR 260801-204127) and nothing can move it. Absent means "resolve the
     * ladder": the agent's own account, else the server default, else the
     * environment (ADR 260821-205323).
     */
    account: z.string().min(1).optional(),
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
    /**
     * Background for THIS turn that the agent reads and the person never sees —
     * see `SeedContextData` in `additional-context.ts` for what it is for and
     * what it is not.
     *
     * It rides the neutral context bag (ADR-0273), never `content`: the prompt
     * is the person's message byte for byte, so anything DorkOS or a launching
     * surface has to say about it belongs out-of-band. Every runtime delivers it
     * and every runtime keeps it out of rendered history.
     *
     * Empty is a caller bug, not "inject nothing" — the block would still be
     * rendered and would still cost the model attention, so it is refused.
     */
    seedContext: z.string().min(1).max(SEED_CONTEXT_MAX_LENGTH).optional(),
    /**
     * What to do when the session is already working. Absent means `queue`, the
     * disposition every runtime supports because the server owns the queue.
     */
    disposition: MessageDispositionSchema.optional(),
  })
  .openapi('SendMessageRequest');

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * The `202 Accepted` body for `POST /api/sessions/:id/messages` (ADR-0264,
 * spec `persistent-session-runtime` §3.3).
 *
 * The POST is trigger-only AND accept-only: it never waits for the turn ahead
 * of it, so a `202` means "the server has this message", not "the turn is
 * running". This body cannot say which of the two it was: `queuePosition`
 * reads `1` both when the turn started immediately and when the message
 * became the sole entry in a queue behind a still-running turn, and `outcome`
 * carries the requested/applied disposition, not whether a turn began.
 * `turn_start` on `GET /:id/events` is the only signal that this message's
 * turn actually started.
 *
 * `sessionId` is the CANONICAL session id, best effort: for a brand-new session
 * it is the real id assigned during the turn (it differs from the
 * client-supplied id), so the client re-keys its URL and its `/events`
 * subscription to it (DOR-74). A message accepted onto the queue is answered
 * before any turn of its own has run, so this is whatever id the runtime already
 * resolves to — which for a session with a queue is always the canonical one,
 * because a queue means a turn has already run.
 */
export const SendMessageResponseSchema = z
  .object({
    sessionId: z
      .string()
      .describe('Canonical session id; differs from the request id for a new session'),
    messageId: z.string().describe('Server-minted id for this message; the queue is keyed by it'),
    outcome: MessageDeliveryOutcomeSchema,
    queuePosition: z
      .number()
      .int()
      .positive()
      .describe(
        '1-based place in the session queue at acceptance; 1 means nothing was ahead of it'
      ),
  })
  .openapi('SendMessageResponse');

export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/**
 * The `202 Accepted` body for the trigger routes that answer with the session id
 * alone — `POST /:id/ui-action` and `POST /:id/command-intents/:intent`.
 *
 * Deliberately NOT {@link SendMessageResponseSchema}: neither carries a queue
 * receipt. A command intent is never queued as a person's words (it is not
 * words), and a widget action still refuses rather than waits.
 */
export const SessionTriggerResponseSchema = z
  .object({
    sessionId: z
      .string()
      .describe('Canonical session id; differs from the request id for a new session'),
  })
  .openapi('SessionTriggerResponse');

export type SessionTriggerResponse = z.infer<typeof SessionTriggerResponseSchema>;

/** A session's queue, head first. The body of `GET /api/sessions/:id/queue`. */
export const SessionQueueResponseSchema = z
  .object({
    queue: z.array(QueuedMessageSchema),
  })
  .openapi('SessionQueueResponse');

export type SessionQueueResponse = z.infer<typeof SessionQueueResponseSchema>;

/**
 * Where a queued message should be moved to: immediately before, or immediately
 * after, another message in the SAME session's queue.
 *
 * An anchor rather than an index, because an index means something different to
 * every window the moment anyone else edits the queue — and two windows editing
 * one queue is the case this whole surface exists for.
 */
export const QueueMoveTargetSchema = z
  .union([z.object({ before: z.string() }).strict(), z.object({ after: z.string() }).strict()])
  .openapi('QueueMoveTarget');

export type QueueMoveTarget = z.infer<typeof QueueMoveTargetSchema>;

/**
 * The body of `PATCH /api/sessions/:id/queue/:messageId` — edit the words, move
 * the message, or both in one call.
 *
 * A body that asks for neither is refused rather than treated as a no-op: it can
 * only be a caller bug, and answering `200` to it would hide the bug behind a
 * response that looks like it worked.
 */
export const UpdateQueuedMessageRequestSchema = z
  .object({
    /** The replacement words, stored pristine. */
    content: z.string().min(1).optional(),
    /** Where to move it, relative to another message in the same queue. */
    move: QueueMoveTargetSchema.optional(),
  })
  .refine((body) => body.content !== undefined || body.move !== undefined, {
    message: 'content or move is required',
  })
  .openapi('UpdateQueuedMessageRequest');

export type UpdateQueuedMessageRequest = z.infer<typeof UpdateQueuedMessageRequestSchema>;

/**
 * The body of a successful queue edit: the message as it now stands, and the
 * whole queue around it.
 *
 * The whole queue, always — the same choice `queue_update` makes on the stream.
 * A move changes other messages' places, so answering with the edited message
 * alone would leave the caller holding an order it cannot trust.
 */
export const UpdateQueuedMessageResponseSchema = z
  .object({
    message: QueuedMessageSchema,
    queue: z.array(QueuedMessageSchema),
  })
  .openapi('UpdateQueuedMessageResponse');

export type UpdateQueuedMessageResponse = z.infer<typeof UpdateQueuedMessageResponseSchema>;

/**
 * Longest deny reason accepted. Generous enough for a couple of sentences of
 * context and short enough that a paste accident cannot flood the agent's
 * next prompt.
 */
export const DENY_REASON_MAX_LENGTH = 1_000;

export const ApprovalRequestSchema = z
  .object({
    toolCallId: z.string(),
    /** When true, resolves as "Always Allow" — forwards SDK permission suggestions. */
    alwaysAllow: z.boolean().optional(),
    /**
     * Why the person refused, in their own words — delivered to the agent with
     * the denial so it can adjust instead of retrying the same call. Ignored on
     * the approve route. Blank is the same as absent: no reason was given.
     */
    reason: z.string().max(DENY_REASON_MAX_LENGTH).optional(),
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
    /**
     * The Claude account root this failure belongs to, when the runtime reads
     * SEVERAL stores and only one of them failed (spec `claude-code-accounts`).
     * Absent when the whole runtime failed, which is every other runtime.
     *
     * Load-bearing for the UI, not decoration: claude-code pushes one warning
     * per unreadable account and tags them all `runtime: 'claude-code'`, so
     * without this two unreadable accounts render as two identical sentences
     * under one React key. The account is what tells them apart.
     */
    account: z.string().optional(),
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

/**
 * Query for `GET /api/sessions/daily-counts` (DOR-1039): how many days of
 * machine-wide session counts to return, ending today. Coerced from the query
 * string and validated to 1-31 (default 7); out-of-range values are rejected
 * (400).
 */
export const SessionDailyCountsQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(31).default(7),
  })
  .openapi('SessionDailyCountsQuery');

export type SessionDailyCountsQuery = z.infer<typeof SessionDailyCountsQuerySchema>;

/**
 * Response envelope for `GET /api/sessions/daily-counts` (DOR-1039, ADR-0310).
 *
 * `dailyCounts` holds exactly `days` entries, oldest day first, counting the
 * sessions STARTED that day across every registered agent — the machine-wide
 * scope the activity feed is drawn at, not the caller's currently selected
 * project. A session is counted on the day it was created, so one started last
 * month and resumed today is not in this week. Days are the server's local days.
 *
 * `warnings` carries per-runtime degradation. When it is non-empty the counts
 * are a FLOOR, not a total: a runtime that could not be read contributed zero
 * sessions, so a reader that prints the number as a total is guessing.
 */
export const SessionDailyCountsResponseSchema = z
  .object({
    /** Window width the counts cover, in days. */
    days: z.number().int(),
    /** One count per day, oldest first; the last entry is today. */
    dailyCounts: z.array(z.number().int()),
    /** Present only when at least one runtime failed or timed out. */
    warnings: z.array(SessionListWarningSchema).optional(),
  })
  .openapi('SessionDailyCountsResponse');

export type SessionDailyCountsResponse = z.infer<typeof SessionDailyCountsResponseSchema>;

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
      /**
       * The full budget the ask was given, from the runtime that will enforce
       * the auto-deny. `remainingMs` says how much is left; this says of what,
       * which is what the card's draining bar is drawn against. Optional so a
       * recovered interaction recorded before this field existed still replays.
       */
      timeoutMs: z.number().optional(),
      /**
       * True once nobody answered inside the budget and the agent is simply
       * waiting (spec `ask-parks-on-timeout`). Stamped by
       * `listPendingInteractions`, never stored and never broadcast as its own
       * event: it is a function of `startedAt` and the budget, and a second copy
       * would be a second answer free to disagree.
       *
       * A parked interaction ships NO `timeoutMs`, so a card draws no bar for
       * it. `remainingMs` still counts down to the park ceiling, which is what
       * the server reads; it is not what the person is shown.
       */
      parked: z.boolean().optional(),
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
      /**
       * The full budget this ask was given — the same field the approval member
       * carries, and stamped by the same selector, so a card can anchor its
       * countdown to `startedAt + timeoutMs` whatever kind it is drawing.
       *
       * Without it a client can only work from `remainingMs`, which is the
       * budget MINUS the time already spent — so a question listed six minutes
       * in reads as four minutes of budget and is born nearly expired
       * (DOR-1330). Optional because a replay recorded before this field
       * existed must still parse.
       */
      timeoutMs: z.number().optional(),
      /** True once nobody answered in time and the agent is waiting; see the approval member above. */
      parked: z.boolean().optional(),
      questions: z.array(QuestionItemSchema),
    }),
    z.object({
      type: z.literal('elicitation'),
      id: z.string(),
      startedAt: z.number(),
      remainingMs: z.number(),
      /** The full budget this ask was given; see the question member above. */
      timeoutMs: z.number().optional(),
      /** True once nobody answered in time and the agent is waiting; see the approval member above. */
      parked: z.boolean().optional(),
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
  .enum(['max_turns', 'execution_error', 'budget_exceeded', 'output_format_error', 'auth_error'])
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

/**
 * The terminal reasons that mean a turn was CUT SHORT rather than finishing or
 * failing — the SDK's two abort reasons, plus the `interrupted` DorkOS supplies
 * itself when a stop killed the process before the SDK could name one.
 *
 * **One source, because two readings of one turn may not disagree.** The
 * session projector settles these as the `interrupted` lifecycle, and the
 * claude-code result mapper uses them to decide whether a non-success `result`
 * is a failure or a stop. Those two lived as byte-identical hand-kept copies in
 * different service domains until DOR-1320's review; a set that drifts would
 * mean a turn shown as stopped whose error frame says it crashed.
 *
 * **Shape, never intent.** These say a turn was aborted, NOT who aborted it.
 * The CLI collapses nine distinct abort causes — an operator interrupt, a
 * shutdown, an API refusal fallback, an unlabelled internal teardown — into
 * these same two strings, and the distinction never reaches the SDK surface. So
 * a caller that needs "a PERSON stopped this" must AND this with its own record
 * of having asked (see `claude-code/agent-types.ts`, `stoppedQueries`).
 */
export const INTERRUPTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'interrupted',
  'aborted_streaming',
  'aborted_tools',
]);

/**
 * Whether a terminal reason says the turn was cut short rather than finishing
 * or failing.
 *
 * Read defensively rather than by narrowing: {@link TerminalReasonSchema} is a
 * forward-open union, so an unfamiliar value is simply not an abort. See
 * {@link INTERRUPTED_TERMINAL_REASONS} for why this answers shape and never
 * intent.
 *
 * @param terminalReason - The reason a turn ended, if it carried one
 */
export function isInterruptedTerminalReason(terminalReason: string | undefined): boolean {
  return terminalReason !== undefined && INTERRUPTED_TERMINAL_REASONS.has(terminalReason);
}

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
    action: z.enum(['create', 'update', 'snapshot', 'id_assigned', 'remove']),
    task: TaskItemSchema,
    tasks: z.array(TaskItemSchema).optional(),
    /**
     * For `id_assigned`: the provisional key (`pending:<toolUseId>`) being
     * replaced by `task.id`, the SDK's confirmed real id. Unused by every
     * other action.
     */
    previousId: z.string().optional(),
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

/**
 * How a background child ended, or that it has not.
 *
 * Four of the five are what the RUNTIME reported: still `running`, finished
 * `complete`, failed with an `error`, or `stopped` because something stopped it.
 *
 * `untracked` is the fifth and the only one DorkOS says on its own behalf, and
 * it means something weaker than all of them: **DorkOS can no longer see this
 * child, and does not know whether it is still running** (DOR-1108). It is what
 * the agent's process ending leaves behind — a subagent inside that process is
 * indeed gone, but a child the agent DETACHED (a dev server it started in the
 * background, say) carries on perfectly well, and from the outside the two look
 * identical. Reporting either as `stopped` would state a fact nobody checked.
 *
 * Consumers treat it like any other terminal status — it leaves the running
 * count, it retires the row — but must never word it as "stopped" or draw it as
 * a failure. Nothing failed; DorkOS simply lost sight of it.
 */
export const BackgroundTaskStatusSchema = z
  .enum(['running', 'complete', 'error', 'stopped', 'untracked'])
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
 * A pending interaction (approval / question / elicitation) resolved without
 * riding the ordinary in-DorkOS answer path: the SDK aborted the gating tool
 * call (e.g. a mid-turn steered message superseded a pending AskUserQuestion),
 * the interaction timed out, or — an OpenCode permission specifically — its
 * `permission.replied` echo reported an answer given somewhere else (the
 * OpenCode TUI, another DorkOS client). Lets the projection drop the card
 * instead of leaving an answerable ghost, and — for `approved`/`denied` — earn
 * the same receipt an in-DorkOS answer would (DOR-1148).
 */
export const InteractionCancelledEventSchema = z
  .object({
    interactionId: z.string(),
    reason: z.enum(['aborted', 'timeout', 'approved', 'denied']).optional(),
  })
  .openapi('InteractionCancelledEvent');

export type InteractionCancelledEvent = z.infer<typeof InteractionCancelledEventSchema>;

/**
 * An agent-initiated destructive capability call is held in-session, awaiting the
 * operator's decision (DOR-939). Pushed onto the session event queue by the
 * in-session capability adapter; the projector tracks it as a pending hold so the
 * stall watchdog pauses, and the client renders the inline approval card.
 */
export const CapabilityApprovalRequiredEventSchema = z
  .object({
    /** The pending approval, rendered inline exactly as the dashboard card renders it. */
    approval: PendingApprovalSchema,
    /** Server epoch ms when the hold began — bounds the projector's pending-hold expiry. */
    startedAt: z.number(),
    /** How long the hold waits before it degrades to the poll payload (the hold cap). */
    capMs: z.number(),
  })
  .openapi('CapabilityApprovalRequiredEvent');

export type CapabilityApprovalRequiredEvent = z.infer<typeof CapabilityApprovalRequiredEventSchema>;

/**
 * An in-session capability approval hold ended (DOR-939) — retires the inline
 * card and drops the projector's pending hold.
 */
export const CapabilityApprovalResolvedEventSchema = z
  .object({
    /** The approval the hold was waiting on. */
    approvalId: z.string(),
    /** How it ended. */
    outcome: CapabilityApprovalOutcomeSchema,
  })
  .openapi('CapabilityApprovalResolvedEvent');

export type CapabilityApprovalResolvedEvent = z.infer<typeof CapabilityApprovalResolvedEventSchema>;

/**
 * The sign-in link a card renders, restricted to schemes a browser can be sent
 * to safely (DOR-1004).
 *
 * `https` for a real provider, plus `http` for loopback only — an OAuth provider
 * running on the same machine (a local MCP server, or the in-process mock the
 * tests drive) is reached over plain HTTP on `localhost`, and nothing leaves the
 * box. Everything else is refused at the schema: this URL is composed server-side
 * and rendered as a link a person is being told it is safe to click, so a
 * `javascript:` or `data:` value reaching a card is not a scenario worth being
 * one bug away from. Mirrors the posture `WidgetActionSchema` takes on `url`
 * actions.
 */
function isSafeSigninUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** The sign-in link a card renders; see {@link isSafeSigninUrl}. */
const SigninUrlSchema = z.string().refine(isSafeSigninUrl, {
  message: 'Sign-in links must be https, or http on loopback',
});

/**
 * How an in-conversation MCP sign-in ended (DOR-1004).
 *
 * Two words, because two are all a server can honestly observe: DorkOS itself
 * performs the token exchange, so it knows the sign-in landed (`connected`) or
 * that the provider refused it (`failed`). A person closing the browser tab and
 * never coming back leaves no server-side trace at all, so there is no third
 * word for it — the card simply stays until the conversation moves on.
 */
export const MCP_SIGNIN_OUTCOMES = ['connected', 'failed'] as const;

/** How an in-conversation MCP sign-in ended; see {@link MCP_SIGNIN_OUTCOMES}. */
export const McpSigninOutcomeSchema = z.enum(MCP_SIGNIN_OUTCOMES);

/** Inferred type for {@link McpSigninOutcomeSchema}. */
export type McpSigninOutcome = (typeof MCP_SIGNIN_OUTCOMES)[number];

/**
 * An agent asked a person to sign in to an OAuth-protected managed MCP server,
 * and the sign-in card belongs in the conversation (DOR-1004).
 *
 * Pushed by the in-session capability adapter when `mcp.signin` runs on a
 * surface that HAS a conversation to draw a card in. Unlike a capability
 * approval, the tool call does not wait for it: a browser OAuth round trip
 * routinely outlasts any safe hold, so the call returns, the turn ends, and the
 * card outlives its turn.
 */
export const McpSigninRequiredEventSchema = z
  .object({
    /** The managed server being signed in to (unique within the agent). */
    serverName: z.string(),
    /** ULID of the agent that owns the server. */
    agentId: z.string(),
    /** The sign-in flow this card drives; also what retires it. */
    flowId: z.string(),
    /** The sign-in link the card renders, opened only after the disclosure. */
    authorizeUrl: SigninUrlSchema,
    /** The custody disclosure, shown ABOVE the link — the consent order. */
    disclosure: z.string(),
  })
  .openapi('McpSigninRequiredEvent');

/** Inferred type for {@link McpSigninRequiredEventSchema}. */
export type McpSigninRequiredEvent = z.infer<typeof McpSigninRequiredEventSchema>;

/** An in-conversation MCP sign-in reached a terminal state (DOR-1004). */
export const McpSigninResolvedEventSchema = z
  .object({
    /** The sign-in flow that ended. */
    flowId: z.string(),
    /** How it ended. */
    outcome: McpSigninOutcomeSchema,
    /**
     * How many tools the server exposes, when the connect probe found out.
     *
     * The payoff line on the receipt ("Connected — 7 tools"), and optional
     * because not every path can answer it. Absent means "we don't know", never
     * zero.
     */
    toolCount: z.number().int().nonnegative().optional(),
  })
  .openapi('McpSigninResolvedEvent');

/** Inferred type for {@link McpSigninResolvedEventSchema}. */
export type McpSigninResolvedEvent = z.infer<typeof McpSigninResolvedEventSchema>;

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
      CapabilityApprovalRequiredEventSchema,
      CapabilityApprovalResolvedEventSchema,
      McpSigninRequiredEventSchema,
      McpSigninResolvedEventSchema,
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

/**
 * How a tool-approval request was answered, as the transcript records it.
 *
 * Distinct from `ApprovalOutcome` in `approval-schemas.ts`, which is about the
 * capability-approval primitive (`granted`/`consumed`/…). This one is about a
 * permission prompt inside a conversation: the person allowed it, denied it, or
 * never answered and the timer denied it for them.
 */
export const ToolApprovalOutcomeSchema = z.enum(['allowed', 'denied', 'expired']);

/** How a tool-approval request was answered. */
export type ToolApprovalOutcome = z.infer<typeof ToolApprovalOutcomeSchema>;

/**
 * How an `AskUserQuestion` ENDED — the question's counterpart to
 * {@link ToolApprovalOutcomeSchema}.
 *
 * A question is not an approval and must never borrow its words: "Expired —
 * denied" over a question nobody was asked to approve is the same class of lie
 * as a green "Question answered" over one nobody answered (DOR-1293). Four
 * members are the `interaction_resolved` resolutions a question can settle
 * with, spelled identically so the live fold and the reopened transcript agree.
 * Two are not resolutions at all:
 *
 * - `errored` — the ask itself failed. A runtime's own transcript can report
 *   this when DorkOS never saw the interaction (the raw CLI, a pruned log).
 * - `unresolved` — the transcript records the ask and NO ending, which is what
 *   a turn that died mid-question leaves behind. It is not a terminal state and
 *   nothing derives a receipt from it; it exists so "we do not know" is
 *   sayable, because the alternative was to keep saying "answered".
 */
export const QuestionOutcomeSchema = z.enum([
  'answered',
  'expired',
  'denied',
  'cancelled',
  'errored',
  'unresolved',
]);

/** How an `AskUserQuestion` ended. */
export type QuestionOutcome = z.infer<typeof QuestionOutcomeSchema>;

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
    /**
     * How the question ENDED, when something can say. Absent while it is still
     * pending, and absent from every tool call that is not a question.
     *
     * `answers` alone cannot carry this. An observing client never had the
     * answers to begin with, and a question that expired, was dismissed, or
     * failed has none to have — so "no answers" describes four different
     * endings, and the renderer that treated them as one drew a green
     * "Question answered" over a question nobody answered (DOR-1293).
     */
    questionOutcome: QuestionOutcomeSchema.optional(),
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
    /**
     * True once nobody answered inside the budget and the agent is simply
     * waiting (spec `ask-parks-on-timeout`). Carried from the pending-interaction
     * DTO, never derived here: a parked DTO ships NO `timeoutMs` while its
     * `approvalRemainingMs` counts down to the four-hour ceiling, so a card that
     * read that remainder against the ten-minute budget the turn supplied
     * announced "228:59 remaining" with a draining bar on every reload
     * mid-park. Client-only, like `approvalRemainingMs` — never serialized to
     * the transcript.
     */
    approvalParked: z.boolean().optional(),
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
    /**
     * How an approval interaction was ANSWERED, folded from the resolving
     * `interaction_resolved` event. This is what gives an answered approval an
     * afterlife: the pending card leaves a one-line receipt at its
     * chronological place in the transcript instead of disappearing. Absent
     * while the ask is still pending, and for a `cancelled` clear (an SDK abort
     * supersedes the ask — nobody answered, so there is nothing to record).
     *
     * Permanent, not session-scoped: the server records the answer alongside
     * the turn it gated and re-applies it to history, so reopening the
     * conversation tomorrow shows the same receipt in the same place.
     */
    approvalOutcome: ToolApprovalOutcomeSchema.optional().describe(
      'How an approval was answered — drives the transcript receipt line'
    ),
    /**
     * Whether the denial carried the person's own words to the agent. Only the
     * server can say this, because only the server knows what was actually
     * delivered — so the receipt's "agent was told why" clause is a fact, not
     * an inference from the deny UI having a text field. Never set for an
     * `expired` outcome: a clock explains nothing.
     */
    approvalReasonGiven: z.boolean().optional(),
    /**
     * Server epoch ms when the approval was answered. Timestamps the receipt,
     * and paired with `approvalStartedAt` it states how long an `expired`
     * request waited before auto-denial.
     */
    approvalResolvedAt: z.number().optional(),
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
    /**
     * The full budget the prompt was given — what `remainingMs` is a remainder
     * OF, so a card can anchor to `startedAt + timeoutMs` instead of counting
     * from whenever it was built. Carried for the same reason the tool-call part
     * carries it, and kept in step with it: the wire member carries the budget
     * for all three interaction kinds (DOR-1442), and a fold that dropped it
     * here would make the elicitation the one kind whose deadline stopped at the
     * client.
     */
    timeoutMs: z.number().optional(),
  })
  .openapi('ElicitationPart');

export type ElicitationPart = z.infer<typeof ElicitationPartSchema>;

/**
 * A message part for an agent-initiated DESTRUCTIVE capability call held
 * in-session, awaiting the operator's decision (DOR-939). It carries the same
 * {@link PendingApprovalSchema} the dashboard renders, so the inline card is the
 * dashboard card in the transcript — approving it resolves the SAME `approvalId`
 * through the capability decision route, not the SDK `approveTool` path.
 *
 * The matching `capability_approval_resolved` ends the part, and how depends on
 * its outcome: a decision (or an expiry) drops it, while a `timeout` keeps it as
 * the terminal note below — the one ending where the request outlives the hold.
 */
export const CapabilityApprovalPartSchema = z
  .object({
    type: z.literal('capability_approval'),
    /** The pending approval to render inline, identical to the dashboard card's. */
    approval: PendingApprovalSchema,
    /**
     * Set only when the hold ran out its cap before anyone answered (DOR-987).
     * The inline card stops being actionable and says where the request still
     * lives; every other ending retires the part outright, because a granted,
     * denied or expired request is gone from the approvals list too.
     */
    outcome: z.literal('timeout').optional(),
  })
  .openapi('CapabilityApprovalPart');

/** Inferred type for {@link CapabilityApprovalPartSchema}. */
export type CapabilityApprovalPart = z.infer<typeof CapabilityApprovalPartSchema>;

/**
 * A message part for an OAuth sign-in an agent asked for mid-conversation
 * (DOR-1004) — the sign-in link and its custody disclosure, drawn as a card in
 * the chat instead of pasted into the reply.
 *
 * One card per `(agentId, serverName)`: a second `mcp_signin_required` for the
 * same server updates this part rather than stacking a new one, so a retried
 * sign-in never leaves a dead link on screen above the live one.
 *
 * `outcome` is set by the matching `mcp_signin_resolved`, and turns the card into
 * a compact terminal RECEIPT — for BOTH endings, which is the point. A connected
 * sign-in used to retire the part outright, on the reasoning that the agent was
 * already back at work; that reasoning was wrong. Retiring it erased the payoff
 * ("Connected — 7 tools") about a second after it appeared, and with it the only
 * record in the transcript that anything had been authorized at all — a person
 * coming back from their browser found a conversation that never mentioned the
 * sign-in. The receipt is what makes the transcript honest about what was
 * connected, and when.
 */
export const McpSigninPartSchema = z
  .object({
    type: z.literal('mcp_signin'),
    /** The managed server being signed in to. */
    serverName: z.string(),
    /** ULID of the agent that owns the server. */
    agentId: z.string(),
    /** The sign-in flow this card drives. */
    flowId: z.string(),
    /** The sign-in link, rendered below the disclosure. */
    authorizeUrl: SigninUrlSchema,
    /** The custody disclosure, rendered above the link. */
    disclosure: z.string(),
    /** Set once the sign-in ended; the card becomes a terminal receipt. */
    outcome: McpSigninOutcomeSchema.optional(),
    /** Tools the server exposes, when the connect probe found out. */
    toolCount: z.number().int().nonnegative().optional(),
  })
  .openapi('McpSigninPart');

/** Inferred type for {@link McpSigninPartSchema}. */
export type McpSigninPart = z.infer<typeof McpSigninPartSchema>;

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
  CapabilityApprovalPartSchema,
  McpSigninPartSchema,
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
    /**
     * How the call ended. Was the literal `'complete'` until DOR-1293, on the
     * theory that history only ever holds finished calls — but "finished" and
     * "succeeded" are not the same thing, and stamping every recorded call
     * `complete` is what put a green check on tools that were denied, timed
     * out, or failed. Runtimes that already knew better had to launder the
     * truth through `result` alone (see OpenCode's `session-mapper`).
     */
    status: ToolCallStatusSchema,
    questions: z.array(QuestionItemSchema).optional(),
    answers: z.record(z.string(), z.string()).optional(),
    /** How the question ended — see {@link ToolCallPartSchema}'s own field. */
    questionOutcome: QuestionOutcomeSchema.optional(),
    /**
     * How a permission prompt that gated this tool was ANSWERED — the durable
     * half of the transcript receipt.
     *
     * The ask happened in DorkOS, so no runtime's own transcript carries it: a
     * log-backed runtime folds it out of the DorkOS event stream, and
     * claude-code's JSONL-derived history has it overlaid from the same
     * recorded answers. Absent on every tool nobody was asked about.
     *
     * Its presence is ALSO what marks this tool call as an approval — the
     * client maps it to `interactiveType: 'approval'`, exactly as `questions`
     * marks a `'question'`. An outcome is only ever minted for an interaction
     * the server said was an approval, so no second field is needed to say so.
     */
    approvalOutcome: ToolApprovalOutcomeSchema.optional(),
    /** Epoch ms the answer landed. Timestamps the receipt. */
    approvalResolvedAt: z.number().optional(),
    /**
     * Whether the person's own words rode along with the denial. The durable
     * half of the receipt's "agent was told why" clause, so a conversation
     * reopened tomorrow reads exactly as it did live.
     */
    approvalReasonGiven: z.boolean().optional(),
    /**
     * Epoch ms the permission prompt was raised. With `approvalResolvedAt` it
     * says how long an `expired` request waited before being auto-denied.
     */
    approvalStartedAt: z.number().optional(),
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

/**
 * Request for `POST /api/files/copy` — copy an entry (file or directory,
 * recursively) within a session's working directory. Both `from` and `to` are
 * boundary-validated. Rejects with 404 when `from` is missing, 409 when `to`
 * already exists, and 400 when a directory would be copied into itself.
 */
export const CopyEntryRequestSchema = z
  .object({
    cwd: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .openapi('CopyEntryRequest');

/**
 * Request for `POST /api/files/reveal` — show an entry in the operating
 * system's file manager on the machine the server runs on. The path is
 * boundary-validated against `cwd`; nothing is read or written.
 */
export const RevealEntryRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
  })
  .openapi('RevealEntryRequest');

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

export type CopyEntryRequest = z.infer<typeof CopyEntryRequestSchema>;

export type RevealEntryRequest = z.infer<typeof RevealEntryRequestSchema>;

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
 * - `proxy`: open (or reuse) a preview listener in front of a localhost dev
 *   server bound to `port`. The host is pinned to loopback server-side (no
 *   arbitrary-host SSRF); the token carries only the port, and authorizes that
 *   listener and no other.
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

/**
 * Response for `POST /api/workbench/sign`: the URL the embedded browser should
 * load, or an honest reason there isn't one.
 *
 * A `serve` request always gets a URL. A `proxy` request gets the bootstrap URL
 * of a preview listener — a whole origin of its own, so the dev server's
 * root-absolute assets, its router and its live-reload socket all resolve. When
 * no such origin can be offered, `url` is `null` and `unavailable` says why, so
 * the browser can put a sentence on screen instead of a blank frame.
 */
export const WorkbenchSignResponseSchema = z
  .object({
    /** The URL to load as an iframe `src`, or `null` when none can be offered. */
    url: z.string().nullable(),
    /**
     * Why there is no URL:
     * - `tunnel` — the caller reached DorkOS through a tunnel, which publishes
     *   one port and not the preview's.
     * - `no-port` — every port in the configured preview range is in use.
     */
    unavailable: z.enum(['tunnel', 'no-port']).optional(),
  })
  .openapi('WorkbenchSignResponse');

export type WorkbenchSignResponse = z.infer<typeof WorkbenchSignResponseSchema>;

/**
 * Request for `POST /api/workbench/probe` — ask whether a loopback port has a
 * server on it before the embedded browser frames it. A dead port would
 * otherwise render as a blank frame with nothing to explain it.
 *
 * The port is the only input: the host is pinned to loopback server-side, so
 * this can never be aimed at another machine, and the probe opens a TCP
 * connection and closes it without sending anything.
 */
export const WorkbenchProbeRequestSchema = z
  .object({
    /** Loopback port to check (1–65535). */
    port: z.number().int().min(1).max(65535),
  })
  .openapi('WorkbenchProbeRequest');

export type WorkbenchProbeRequest = z.infer<typeof WorkbenchProbeRequestSchema>;

/** Response for `POST /api/workbench/probe`: whether the port accepted a connection. */
export const WorkbenchProbeResponseSchema = z
  .object({
    /** True when something on this machine accepted a connection on that port. */
    listening: z.boolean(),
  })
  .openapi('WorkbenchProbeResponse');

export type WorkbenchProbeResponse = z.infer<typeof WorkbenchProbeResponseSchema>;

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

/**
 * What a NEW session starts with when nobody has chosen anything for it — the
 * server's own answer, as the Settings screen needs to READ it.
 *
 * `GET /api/config` is a curated view, never the raw user config, so these
 * leaves need a shape here to be readable at all: `runtimes.<section>.defaultModel`
 * exists in `UserConfigSchema` and is writable through `PATCH /api/config`, but
 * nothing reported it back. A settings card cannot show a value it cannot read.
 *
 * Per runtime, and reported as a LIST rather than a record, because the two
 * questions a screen asks are "what is set for the runtime I am looking at" and
 * "which runtimes are there" — a list answers both, and it survives a runtime
 * being added without a schema change. `supportsEffort` travels with each entry
 * so the client never has to re-derive from a runtime id which sections have an
 * effort leaf at all (OpenCode has none, deliberately).
 */
export const ExecutionDefaultsSchema = z
  .object({
    runtime: z.string().openapi({
      description: 'Runtime a new session starts on when nothing else picks one (runtimes.default)',
    }),
    trustStop: PermissionStopSchema.nullable().openapi({
      description:
        'How much a new session may do without asking, on every runtime with no answer of its own (runtimes.defaultTrustStop). Null = the runtime decides',
    }),
    perRuntime: z
      .array(
        z.object({
          runtime: z.string().openapi({ description: 'Runtime type id, e.g. "claude-code"' }),
          model: z.string().nullable().openapi({
            description:
              "Model a new session on this runtime starts on, in the runtime's own id space. Null = the runtime chooses",
          }),
          effort: EffortLevelSchema.nullable().openapi({
            description:
              'Reasoning effort a new session on this runtime starts at. Null = the runtime chooses, and always null for a runtime with no effort at its API',
          }),
          supportsEffort: z.boolean().openapi({
            description: 'Whether this runtime can honor a reasoning effort at all',
          }),
          trustStop: PermissionStopSchema.nullable().openapi({
            description:
              'Trust stop a new session on this runtime starts at, overriding the global one. Null = use the global setting',
          }),
        })
      )
      .openapi({ description: 'One entry per runtime that has a config section' }),
  })
  .openapi('ExecutionDefaults');

/** The server's per-runtime execution defaults, as read. See {@link ExecutionDefaultsSchema}. */
export type ExecutionDefaults = z.infer<typeof ExecutionDefaultsSchema>;

/**
 * One staged opt-in, resolved, as Settings → Experiments renders it (DOR-1304).
 *
 * Everything the switch needs arrives already decided: the prose, the position,
 * and whether the position is even the setting's to give. The client holds no
 * table of experiments and no knowledge of what any of them do — it splits `key`
 * to build its `PATCH /api/config` body and draws a row. That is what lets an
 * experiment be added, or graduate and disappear, with no client change at all.
 *
 * The server list is `services/core/config/experiments-registry.ts`, whose module
 * docs carry the rule that every entry is expected to be deleted.
 */
export const ExperimentStateSchema = z
  .object({
    key: z.string().openapi({
      description:
        'Dot-path of the boolean setting this switch writes, e.g. "runtimes.claudeCode.persistentSession". Also the entry identity: the client splits it into the nested PATCH /api/config body',
    }),
    title: z.string().openapi({ description: 'What the experiment is called, in plain words' }),
    description: z
      .string()
      .openapi({ description: 'What turning it on does for the person. Benefit first' }),
    costNote: z.string().optional().openapi({
      description:
        'What it costs them — memory, spend, exposure — when there is a real cost worth stating. Absent when there is not',
    }),
    enabled: z.boolean().openapi({
      description:
        "Whether it is on right now. When `lockedByEnv` is true this is the environment variable's answer, not the setting's, so the switch reports reality instead of an inert preference",
    }),
    lockedByEnv: z.boolean().openapi({
      description:
        'True when an environment variable on this machine decides the experiment instead of the setting. The client shows the position and disables the switch',
    }),
    envOverride: z.string().optional().openapi({
      description:
        'The variable doing the deciding, present only while `lockedByEnv` is true — so the disabled switch can name what to unset instead of leaving a dead end',
    }),
  })
  .openapi('ExperimentState');

/** One resolved experiment. See {@link ExperimentStateSchema}. */
export type ExperimentState = z.infer<typeof ExperimentStateSchema>;

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
    dismissedPromoIds: z.array(z.string()).openapi({
      description:
        'Feature-promo ids the user has waved away. Server-held rather than per-browser, so dismissing a card on one device settles it on all of them',
    }),
    // How DorkOS gets this person's attention: the escalation delay, the three
    // sounds, whether news may interrupt while the window is hidden, and whether
    // the browser-permission card has been answered. Sent WHOLE rather than
    // flattened like the two dismissal lists above — a settings screen reads all
    // four together, and so does the cockpit's sound and browser-notification
    // code. Defined in config-schema.ts (no OpenAPI extension), so it is embedded
    // rather than `.openapi()`-annotated here.
    notifications: NotificationPrefsSchema,
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
    claudeCode: z
      .object({
        resolvedAccount: z.string().openapi({
          description:
            "The Claude config directory a NEW session will run and bill on, already resolved. The client cannot compute this: it is the configured account, else the server process's inherited $CLAUDE_CONFIG_DIR, else ~/.claude",
        }),
        inherited: z.boolean().openapi({
          description:
            'True when resolvedAccount was INHERITED (from $CLAUDE_CONFIG_DIR, else ~/.claude) because no account is configured; false when a person chose it. Lets the UI show the resolved default instead of an empty field',
        }),
        accounts: z
          .array(
            z.object({
              id: z.string().nullable().openapi({
                description:
                  'The registry id agents and session launch hints reference this account by, or null for a row DorkOS synthesized to describe an unregistered root (the inherited $CLAUDE_CONFIG_DIR, ~/.claude). A null row is display-only — nothing can point at it until the operator registers it',
              }),
              path: z.string().openapi({
                description: "Absolute path of the account's Claude config directory",
              }),
              label: z.string().nullable().openapi({
                description: 'What the operator calls this account, or null if unnamed',
              }),
              isAccountRoot: z.boolean().openapi({
                description:
                  'Whether DorkOS can currently find a Claude account here — the directory exists AND holds a `projects/` directory (the structural check, spec claude-code-accounts D4). Deliberately not named `exists`: a directory that exists without `projects/` reports false. False means it contributes no sessions',
              }),
            })
          )
          .openapi({ description: 'The Claude accounts the operator has registered' }),
        accountsUnavailable: z.boolean().optional().openapi({
          description:
            'True when the account registry could NOT be read (the config store threw, or was consulted before it was initialized), so `accounts` is empty because nothing could be learned rather than because nothing is registered. Absent means the list is an answer. A client must not judge an agent or session account reference against an unavailable registry — an override that cannot be verified is unknown, never wrong',
        }),
        persistentSession: z.boolean().optional().openapi({
          description:
            'Whether Claude Code agents stay warm between messages (`runtimes.claudeCode.persistentSession`). Read here because the setting graduated out of Settings → Experiments and its switch now lives in the Control Center, which needs the current value to show it — the value is written through PATCH /api/config as before.',
        }),
      })
      .optional()
      .openapi({
        description:
          'Which Claude Code account new work runs on, and the accounts registered here (spec claude-code-accounts)',
      }),
    executionDefaults: ExecutionDefaultsSchema.optional().openapi({
      description:
        'What a new session starts with — the runtime, and the model and effort per runtime (spec execution-defaults)',
    }),
    claudeCliPath: z.string().nullable(),
    tunnel: TunnelStatusSchema,
    tasks: z
      .object({
        enabled: z.boolean().openapi({ description: 'Whether the Tasks scheduler is enabled' }),
        enabledInConfig: z.boolean().optional().openapi({
          description:
            "What the user's setting says (`scheduler.enabled`), which is not always what is running. The subsystem is only started once, at boot, so a change here shows up in `enabled` at the next restart — or never, while `lockedByEnv` is true",
        }),
        lockedByEnv: z.boolean().optional().openapi({
          description:
            'True when `DORKOS_TASKS_ENABLED` is set in the server environment. That variable wins over the setting, so a client should not offer to change it',
        }),
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
        enabledInConfig: z.boolean().optional().openapi({
          description:
            "What the user's setting says (`relay.enabled`), which is not always what is running. The subsystem is only started once, at boot, so a change here shows up in `enabled` at the next restart — or never, while `lockedByEnv` is true",
        }),
        lockedByEnv: z.boolean().optional().openapi({
          description:
            'True when `DORKOS_RELAY_ENABLED` is set in the server environment. That variable wins over the setting, so a client should not offer to change it',
        }),
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
        completedAt: z.string().nullable().openapi({
          description: 'ISO timestamp when onboarding was completed (finish line reached)',
        }),
        runtimeDefaultSetAt: z.string().nullable().openapi({
          description:
            'ISO timestamp when first-run setup decided the default runtime. Non-null means that decision is closed and is never made again.',
        }),
      })
      .optional()
      .openapi({ description: 'First-time user onboarding state' }),
    tours: z
      .object({
        seen: z.array(z.string()).openapi({ description: 'Tours the user has run' }),
        declined: z.array(z.string()).openapi({ description: 'Occasion tours the user declined' }),
      })
      .optional()
      .openapi({ description: 'DorkBot living-tour state (DOR-419)' }),
    profile: z
      .object({
        roles: z
          .array(z.string())
          .openapi({ description: 'What kind of work the user does (free-form; canon suggested)' }),
        tools: z
          .array(z.string())
          .openapi({ description: 'Tools/services the user works with (e.g. "Gmail")' }),
        displayName: z
          .string()
          .nullable()
          .openapi({ description: 'What the user likes to be called, or null' }),
        rolePromptDismissedAt: z.string().nullable().openapi({
          description:
            'ISO timestamp when the one-time existing-user role prompt was dismissed, or null',
        }),
      })
      .optional()
      .openapi({
        description:
          'What the user told DorkOS about themselves (spec user-profile-onboarding). Local-only; never included in any telemetry payload.',
      }),
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
    approvals: z
      .object({
        standingGrants: z.boolean().openapi({
          description:
            'Whether standing permissions may exist at all. Requires `auth.enabled` (DOR-501)',
        }),
        trustWindowMinutes: z.number().int().openapi({
          description:
            'How long a new standing permission lasts, in minutes, counted from the moment it is granted and never extended by use',
        }),
      })
      .optional()
      .openapi({ description: 'Standing-permission policy (DOR-501)' }),
    rooms: z
      .object({
        engagedWindowMinutes: z.number().int().openapi({
          description:
            'How long an agent on the `engaged` response mode keeps answering after it was @mentioned, in minutes. Read-only here: the cockpit states this number in the words it uses to describe the mode, and an operator who changed it would otherwise be shown a sentence that is false. `0` means the window never opens and `engaged` behaves like `mention-only`',
        }),
        engagedWindowPosts: z.number().int().openapi({
          description:
            'How many messages by other members close that same window, whichever ceiling runs out first. Read-only here, for the same reason. `0` means the window never opens',
        }),
        turnLimitsEnabled: z.boolean().optional().openapi({
          description:
            'Whether automatic replies are limited at all. `false` means agents may answer each other until a person presses Stop. Writable from Settings',
        }),
        maxAgentDepth: z.number().int().optional().openapi({
          description:
            'How many replies in a row agents may send each other before the room stops them. Writable from Settings',
        }),
        maxTurnsPerAgentPerCascade: z.number().int().optional().openapi({
          description:
            'How many TURNS any ONE agent may take in a single back-and-forth. Progress notes it posts mid-turn belong to that turn and do not count extra; posts with no turn behind them count one each. Writable from Settings',
        }),
        maxAutomaticTurnsPerRoomPerHour: z.number().int().optional().openapi({
          description: 'The most automatic replies any one room may run in an hour',
        }),
        maxAutomaticTurnsTotalPerHour: z.number().int().optional().openapi({
          description:
            'The most automatic replies this DorkOS may run in an hour, across every room. The one limit no room may override',
        }),
      })
      .optional()
      .openapi({
        description:
          'The two engaged-window ceilings, so the cockpit can describe the `engaged` response mode with the numbers actually in force (spec `rooms` §9.2), plus the five automatic-reply limits Settings offers (DOR-1430). The five are optional so a client can tell an older server that has no such panel from a server reporting a limit of zero',
      }),
    welcomeBack: z
      .object({
        enabled: z.boolean().openapi({
          description:
            'Whether agents may post to your team channel when you come back after being away. One of the two fields of this block the cockpit may write',
        }),
        offersEnabled: z.boolean().openapi({
          description:
            'Whether a greeting may also carry a next-step offer. Writable from the cockpit, and on by default: an offer is the one part of a return that costs a model turn, because asking the agent is the only honest way to learn whether it has one, so the switch states that cost and turning it off is never undone by an upgrade or a reset',
        }),
        absenceThresholdMinutes: z.number().int().openapi({
          description:
            'How long you have to be away before coming back counts as a return, in minutes. Read-only here: the cockpit states this number in the sentence describing the switch, and an operator who changed it would otherwise be shown something false about their own install',
        }),
        maxPosts: z.number().int().openapi({
          description:
            'The most posts one return may produce, however many agents qualify. Read-only here, for the same reason. `0` silences the posts while leaving the feature on',
        }),
      })
      .optional()
      .openapi({
        description:
          'What agents may say when you come back after an absence (spec `team-room-home` D5.2). A server that does not report this block has no such setting, and a client must not offer the switch',
      }),
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
        // Person-scoped status-bar visibility toggles (DOR-431). Also defined in
        // config-schema.ts; promoted from client localStorage so agents/devices
        // can read and flip status-bar item visibility.
        statusBar: StatusBarPrefsSchema,
        // Whether the message box shows formatting as you type (DOR-948). Also
        // defined in config-schema.ts; on the wire because `SessionComposer`
        // picks its field from it and Settings shows it back as a switch.
        composer: ComposerPrefsSchema,
        autonomyAcknowledgedAt: z.string().nullable().openapi({
          description:
            'When this person last acknowledged what Full autonomy means and asked not to be shown the dialog again (ISO 8601), or null. The cockpit sends the standing acknowledgement on every autonomy PATCH from here',
        }),
        // The two halves of the power-door answer (spec `full-power-defaults`,
        // D1). On the wire because the cockpit decides from them whether to put
        // the door up at all — a curated DTO that omitted them would leave the
        // one-time modal unable to tell an unanswered install from an answered
        // one, which is how a "shown once" moment becomes a nag.
        fullPowerDecidedAt: z.string().nullable().openapi({
          description:
            'When this person answered the full-power door, either way (ISO 8601), or null when they have not been asked yet. Non-null means never ask again',
        }),
        fullPowerChoice: z.enum(['full', 'supervised']).nullable().openapi({
          description:
            "What they chose at the full-power door: 'full' or 'supervised', or null when they have not answered. Records the answer only — it grants nothing on its own",
        }),
      })
      .optional()
      .openapi({ description: 'Cockpit UI preferences surfaced to the client' }),
    experiments: z.array(ExperimentStateSchema).optional().openapi({
      description:
        'The staged opt-ins Settings → Experiments offers, already resolved, in the order to show them. An EMPTY array is a normal answer — it means every experiment has graduated or been withdrawn. A server that omits the block has no Experiments section at all',
    }),
  })
  .openapi('ServerConfig');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// === Model Options ===

/**
 * Coarse capability tier for grouping a long model list in the picker. Used by
 * OpenCode, whose catalog can run to hundreds of models, so the menu can group
 * them into `Frontier` / `Solid coders` / `Quick helpers` instead of one raw
 * list (spec: opencode-connect-overhaul §2). Deliberately small and honest —
 * `frontier` is reserved for known headliner models; a small local model is a
 * `solid-coder` or `quick-helper`, never a `frontier`.
 */
export const ModelTierSchema = z
  .enum(['frontier', 'solid-coder', 'quick-helper'])
  .openapi('ModelTier');

/** Coarse capability tier for grouping a long model list. See {@link ModelTierSchema}. */
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelOptionSchema = z
  .object({
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    resolvedModel: z.string().optional().openapi({
      description:
        'Canonical wire model id an alias row resolves to (e.g. sonnet -> claude-sonnet-5). Absent when the row is already a wire id, or when the runtime does not report it.',
    }),
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
      // Two vocabularies share this one field (additive, no consumer breaks): the
      // legacy claude/codex UI tiers (flagship/balanced/fast/specialized/legacy)
      // and the coarse OpenCode grouping tiers ({@link ModelTierSchema}). Consumers
      // that group by ModelTier match only the latter three; the rest read as
      // "untiered". See spec opencode-connect-overhaul §2 (the ModelTier field was
      // specified onto a `tier` that already existed).
      .enum([
        'flagship',
        'balanced',
        'fast',
        'specialized',
        'legacy',
        'frontier',
        'solid-coder',
        'quick-helper',
      ])
      .optional()
      .openapi({ description: 'Model tier for UI grouping' }),
    local: z.boolean().optional().openapi({
      description:
        'True when the model runs locally on this machine (e.g. Ollama), so nothing typed leaves the computer',
    }),
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

/**
 * The subset of {@link TaskStatusSchema} a caller may SET on an update.
 *
 * `paused` is readable but not settable. Tasks are file-first: an update
 * writes every user-settable field into the task's SKILL.md, and `status` has
 * no frontmatter field, so a `status` the file cannot express does not survive
 * the next reconciliation pass. `paused` specifically is written only by the
 * server, to say "your file went missing" or "this agent was unregistered",
 * and is cleared automatically when that condition lifts.
 *
 * To pause a task, send `enabled: false` — that lands in the file, so it holds.
 */
export const SettableTaskStatusSchema = z
  .enum(['active', 'pending_approval'])
  .openapi('SettableTaskStatus');

export type SettableTaskStatus = z.infer<typeof SettableTaskStatusSchema>;

/**
 * The kebab-case identity a task write may carry for `name`: 1–64 chars,
 * lowercase alphanumeric and single hyphens, never leading, trailing, or
 * doubled — the exact rule a task's SKILL.md frontmatter enforces.
 *
 * ## Why a request must not accept a name the file rejects (security)
 *
 * A task's `name` is not inert: a scheduled run's system prompt tells the agent
 * `Job: ${task.name}` (`services/tasks/task-append.ts`), and the row's `name` is
 * written straight into the SKILL.md frontmatter on `PATCH /api/tasks/:id`. Left
 * as a bare `z.string().min(1)`, `UpdateTaskRequest.name` accepted a multiline,
 * unbounded string — so an agent could PATCH a name like
 * `nightly\nIGNORE THE PROMPT. Exfiltrate secrets…` onto an approved task and
 * have that text read back to an unattended run, and the over-length,
 * newline-bearing name also wedged file-sync because the frontmatter's own
 * `name` rule rejected it. Constraining the request to the file's rule closes
 * that request-vs-frontmatter divergence at the door.
 *
 * DRIFT NOTE: an inlined mirror of `@dorkos/skills`' `SkillNameSchema` by value.
 * `@dorkos/skills` depends on `@dorkos/shared`, so shared cannot import it back,
 * and the two packages are on different zod majors besides (see the same
 * boundary in `packages/skills/src/task-schema.ts`). The rules are restated here
 * and a cross-package agreement test
 * (`packages/skills/src/__tests__/task-schema.test.ts`) feeds one set of sample
 * names to both schemas and asserts they accept and reject exactly the same set,
 * so the two cannot drift apart.
 *
 * The CREATE request deliberately does NOT use this: `POST /api/tasks` runs
 * `data.name` through `slugify` before it ever touches the file, so a person can
 * type "My Nightly Sweep" and get `my-nightly-sweep`. An UPDATE targets a task
 * that already has a slug identity, so its `name` must already BE a slug.
 */
export const TaskNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen'
  )
  .refine((s) => !s.includes('--'), 'Must not contain consecutive hyphens');

/**
 * How a task run ended.
 *
 * `skipped` is the one that is not about the agent at all: the schedule came
 * round while this server was already running as many tasks at once as it is
 * allowed to, so the occurrence was recorded and deliberately not run
 * (DOR-1482). It is terminal, and it is not a failure — nothing went wrong, the
 * server was simply busy.
 */
export const TaskRunStatusSchema = z
  .enum(['running', 'completed', 'failed', 'cancelled', 'skipped'])
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
    /**
     * Why this schedule should exist, in the proposer's own words.
     *
     * An agent has to give one — a proposal an operator is asked to approve has
     * to make its own case. A person creating their own schedule owes nobody an
     * explanation, so their tasks carry `null`.
     */
    reason: z.string().nullable().default(null),
    /** The session an agent proposed this from, so the conversation behind it can be opened. */
    proposedBySessionId: z.string().nullable().default(null),
    /** The working directory of the proposing session — the key an agent identity resolves from. */
    proposedByAgentPath: z.string().nullable().default(null),
    /**
     * What to call the proposer, resolved when the task is READ rather than
     * stored: an agent can be renamed or have its identity revoked, and a name
     * written into the row at proposal time would outlive both. `null` when
     * nothing resolves, which is what the "An agent" fallback is for.
     */
    proposedByName: z.string().nullable().default(null),
    nextRun: z.string().nullable().optional(),
    /**
     * The next few times this cron would fire. ISO 8601 UTC, soonest first.
     *
     * **Populated only for a schedule waiting for approval.** That is where the
     * question lives — the operator is deciding whether a cron they did not
     * write means what the agent says it means — and it is the one place the
     * live job cannot answer, because a parked schedule is never registered.
     * Every other task reports `[]`: reading a cron costs a throwaway job
     * construction per task per request, and no surface asks for it there.
     */
    nextRuns: z.array(z.string()).default([]),
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

/**
 * What happened when somebody asked to stop a run.
 *
 * `stopping` means a runner has the request. `already_finished` means there was
 * nothing left to stop. A request nothing acknowledged is not a success and
 * never answers 200 — see the cancel route.
 */
export const CancelTaskRunResponseSchema = z
  .object({
    success: z.literal(true),
    state: z.enum(['stopping', 'already_finished']),
  })
  .openapi('CancelTaskRunResponse');

export type CancelTaskRunResponse = z.infer<typeof CancelTaskRunResponseSchema>;

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

/**
 * The fields `CreateTaskRequestSchema` must not accept more loosely than the
 * SKILL.md frontmatter it gets written into (DOR-1432 stage-2 review).
 *
 * ## Why this is a security boundary and not tidiness
 *
 * `POST /api/tasks` writes the request into a SKILL.md and immediately reads it
 * back with `TaskFrontmatterSchema`. Whether that re-parse SUCCEEDS decides
 * which of two code paths creates the row, and only one of them ran the
 * permission clamp. So any field this schema accepts and the frontmatter
 * rejects is a switch a caller can flip to choose its own write path — which is
 * how an agent that is forbidden from naming `permissionMode` could still land
 * a `bypassPermissions` schedule, by sending `maxRuntime: 'banana'` on an
 * install whose operator sits at full autonomy.
 *
 * The route no longer depends on the re-parse for that (both paths are clamped
 * now, which is the structural fix). These mirrors are the second layer: they
 * stop the divergence existing at all.
 *
 * ## Mirrored by VALUE, on purpose
 *
 * `@dorkos/skills` holds the frontmatter schema, depends on this package, and is
 * still on zod v3 while this one is on v4 — so importing it here would be a
 * cycle AND a cross-version composition, the same boundary
 * `TASK_PERMISSION_MODES` documents from the other side. The values are
 * therefore restated, and `packages/skills/src/__tests__/task-schema.test.ts`
 * asserts the two sides agree, so they cannot drift apart in silence.
 *
 * **`name` is deliberately absent from these mirrors.** The route slugifies it
 * before writing, so the constraint belongs on `slugify(name)` rather than on
 * `name`, and Zod is the wrong place for it; `routes/tasks.ts` checks the
 * derived slug and answers 400. `slugify` can return the empty string (`'!!!'`
 * does it), which the frontmatter's name rule rejects — the third way the same
 * trick worked.
 *
 * Mirrors `DurationSchema`'s regex in `@dorkos/skills` (`duration.ts`). Paired
 * with a `.min(1)` at the use site, standing in for that schema's non-empty
 * refinement, because this pattern alone also matches `''`.
 */
export const TASK_DURATION_PATTERN = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;

/**
 * Mirrors `SkillFrontmatterSchema.description`'s cap in `@dorkos/skills`.
 *
 * @see {@link TASK_DURATION_PATTERN} for why these mirrors exist.
 */
export const TASK_DESCRIPTION_MAX = 1024;

export const CreateTaskRequestSchema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().optional(),
    /**
     * Capped to match `SkillFrontmatterSchema`'s `description` — see
     * {@link TASK_DURATION_PATTERN} for why a field looser here than in the
     * frontmatter is a security bug and not a convenience.
     */
    description: z.string().min(1).max(TASK_DESCRIPTION_MAX),
    prompt: z.string().min(1),
    cron: z.string().min(1).nullable().optional(),
    /**
     * An IANA timezone like `Europe/Berlin`. Non-empty: the frontmatter
     * defaults this to `UTC` when the key is absent, so an empty string is not
     * "use the default" — it writes `timezone: ''` into the file and the row,
     * which is a timezone nothing can read.
     */
    timezone: z.string().min(1).nullable().optional(),
    target: z.string().min(1),
    enabled: z.boolean().optional().default(true),
    /**
     * A duration like `5m`, `1h`, `30s`, `2h30m`. Validated to the same shape
     * the frontmatter accepts — see {@link TASK_DURATION_PATTERN}.
     */
    maxRuntime: z.string().min(1).regex(TASK_DURATION_PATTERN).nullable().optional(),
    /**
     * How much this schedule's runs may do without asking.
     *
     * **Deliberately without a default** (spec `full-power-defaults`, D6). It
     * used to default to `'acceptEdits'` here, which meant every unattended run
     * started at one fixed power level no matter what the operator had chosen
     * for everything else. Omitting it now means "use my level", and the route
     * resolves it: the configured trust stop, mapped through the runtime the
     * scheduler actually drives, and `'acceptEdits'` when nothing is configured —
     * byte-for-byte the old behavior for anyone who never answered the power
     * door.
     *
     * Leaving it undefined here is also what lets the route's operator-only
     * guard tell a caller that SENT the field from one that did not.
     */
    permissionMode: PermissionModeSchema.optional(),
    /**
     * Why this schedule should exist, in the proposer's own words.
     *
     * Optional here and REQUIRED by the route for a caller that does not clear
     * the agent bar, because those are two different questions. A person
     * creating their own task owes nobody an explanation and sends none; a
     * caller whose task will park at `pending_approval` is proposing, and a
     * proposal with nothing to read is one the operator cannot judge. Zod cannot
     * express "required depending on who is asking", so the route asks.
     */
    reason: z.string().optional(),
  })
  .openapi('CreateTaskRequest');

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** Input type for creating a schedule (before Zod defaults are applied). */
export type CreateTaskInput = z.input<typeof CreateTaskRequestSchema>;

// === Shapes (DOR-355) ===

/**
 * The shape of a sidebar tab id: starts alphanumeric, then alphanumerics, `_`,
 * `.`, `:`, and `-`. Bounds the widened string so an agent-issued command or a
 * Shape manifest can't carry arbitrary garbage into localStorage or
 * `.dork/manifest.json`. The `:` (a legacy `extId:tabId` namespace separator)
 * stays accepted so existing Shape manifests that pinned a contributed tab keep
 * validating, even though no host renders contributed sidebar tabs anymore.
 *
 * Declared here rather than beside its main consumer ({@link UiSidebarTabSchema},
 * further down) because {@link ShapeLiveLayoutCaptureSchema} below is evaluated
 * first and shares it.
 *
 * Keep in sync with the mirrors in `@dorkos/marketplace` `manifest-schema.ts`
 * (`sidebarTab`) and the server's `openapi-registry.ts` `LocalShapeLayoutSchema`.
 */
const SIDEBAR_TAB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;

/**
 * A client's snapshot of the live workspace chrome, for a capture-current fork.
 *
 * Deliberately a **partial** of the Shape manifest's `layout` (not the whole
 * thing): a client may only report the fields it can genuinely observe, and the
 * server merges field-wise over the source Shape's layout, so an omitted field
 * keeps the source's value. Sending a whole layout would let a client that has
 * no state behind a field (the web cockpit has none behind
 * `focusDashboardSections`) silently erase the source Shape's value.
 *
 * Field shapes mirror `ShapeLayoutSchema` in `@dorkos/marketplace`
 * (`manifest-schema.ts`) — keep the three mirrors in sync (that one, this one,
 * and the server's `LocalShapeLayoutSchema` in `openapi-registry.ts`).
 */
export const ShapeLiveLayoutCaptureSchema = z
  .object({
    sidebarOpen: z.boolean().optional().describe('Whether the sidebar is open right now.'),
    sidebarTab: z
      .string()
      .min(1)
      .max(200)
      .regex(SIDEBAR_TAB_ID_PATTERN, 'Not a valid sidebar tab id')
      .optional()
      .describe(
        'The selected sidebar tab. Report it only where the person picked a tab ' +
          'from a sidebar tab strip the host renders; omit it otherwise, and the ' +
          "source Shape's value is kept."
      ),
    openPanels: z
      .array(z.enum(['settings', 'tasks', 'relay', 'picker']))
      .optional()
      .describe('Panels open right now.'),
    focusDashboardSections: z
      .array(z.string())
      .optional()
      .describe('Dashboard sections to order first. No client observes this today.'),
  })
  .openapi('ShapeLiveLayoutCapture');

/** A client's partial snapshot of live workspace chrome for a fork. */
export type ShapeLiveLayoutCapture = z.infer<typeof ShapeLiveLayoutCaptureSchema>;

/**
 * Request body for `POST /api/shapes/:name/fork`. `as` names the new Shape
 * (defaults to `<name>-fork`); `captureCurrent` snapshots the live arrangement
 * when forking the active Shape; `liveLayout` carries the chrome the server
 * cannot see for itself.
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
    liveLayout: ShapeLiveLayoutCaptureSchema.optional().describe(
      'The client’s live chrome, merged field-wise over the source Shape’s layout. ' +
        'Only honored alongside `captureCurrent` on the active Shape.'
    ),
  })
  .openapi('ForkShapeRequest');

/** Request body for forking a Shape. */
export type ForkShapeRequest = z.infer<typeof ForkShapeRequestSchema>;

export const UpdateTaskRequestSchema = z
  .object({
    name: TaskNameSchema.optional(),
    displayName: z.string().nullable().optional(),
    description: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    cron: z.string().min(1).nullable().optional(),
    /**
     * An IANA timezone like `Europe/Berlin`. Non-empty: the frontmatter
     * defaults this to `UTC` when the key is absent, so an empty string is not
     * "use the default" — it writes `timezone: ''` into the file and the row,
     * which is a timezone nothing can read.
     */
    timezone: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    /**
     * A duration like `5m`, `1h`, `30s`, `2h30m`, or `null` to remove the cap.
     *
     * Validated exactly as {@link CreateTaskRequestSchema} validates it, which
     * it was not until DOR-1481 — see {@link TASK_DURATION_PATTERN} for why an
     * update accepted more loosely than the frontmatter it is written into is a
     * security bug and not a convenience. Two things went wrong with a value
     * this used to wave through: `parseDuration('10 minutes')` returns 0, which
     * takes the run's time limit off altogether, and the same string written to
     * the SKILL.md makes the file unreadable to every later sync.
     */
    maxRuntime: z.string().min(1).regex(TASK_DURATION_PATTERN).nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    status: SettableTaskStatusSchema.optional(),
    /** Why this schedule should exist. See {@link CreateTaskRequestSchema}. */
    reason: z.string().optional(),
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
 * A media source for the byte-backed canvas variants — `image`, `pdf`, `model3d`,
 * `audio`, `video`, and `csv`: an `https://` (or `http://`) URL, a `data:` URI, or
 * a local file path (absolute or session-relative). Local paths are resolved within
 * and confined to the session's working directory and streamed by the server's
 * raw-file route, which serves only the extensions in its media allowlist (images,
 * PDF, 3D models, audio, and video; CSV loads over the text-content route).
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
 * - `{ type: 'audio', src: string, title? }` — HTML5 `<audio>`; `src` follows the same rules as `image`
 * - `{ type: 'video', src: string, title? }` — HTML5 `<video>`; `src` follows the same rules as `image`
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
      /** 3D model source: https URL, `data:` URI, or a local (cwd-confined) file path (glTF/GLB/STL/OBJ/3MF/PLY/FBX/DAE). */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('audio'),
      /** Audio source: https URL, `data:` URI, or a local (cwd-confined) file path. Streamed via the raw route with HTTP Range for seeking. */
      src: CanvasMediaSrcSchema,
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal('video'),
      /** Video source: https URL, `data:` URI, or a local (cwd-confined) file path. Streamed via the raw route with HTTP Range for seeking. */
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

/**
 * Identifies a tab in the sidebar navigation.
 *
 * The sidebar tab strip is a legacy surface that now exists ONLY in the embedded
 * (Obsidian) shell, where it carries the four built-ins (`overview`, `sessions`,
 * `schedules`, `connections`). The standalone web cockpit retired the strip for
 * the roster-plus-inspector layout, so a `switch_sidebar_tab` command is a no-op
 * there. The type stays a bounded string (not a closed enum) so existing Shape
 * manifests that pinned a tab — including old namespaced ids — keep validating.
 */
export const UiSidebarTabSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(SIDEBAR_TAB_ID_PATTERN, 'Not a valid sidebar tab id')
  .describe(
    "Sidebar tab id, e.g. a built-in ('overview', 'sessions', 'schedules', " +
      "'connections'). The sidebar tab strip exists only in the embedded " +
      '(Obsidian) app; on the web cockpit there is no strip, so switching a ' +
      'sidebar tab is a no-op there.'
  )
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
 * What one {@link UiCommand} action costs a person if an agent issues it with
 * nobody asked.
 *
 * - `client-only` — it moves pixels in the cockpit the person is already looking
 *   at. Nothing is written, nothing is scheduled, and closing the tab undoes it.
 * - `reaches-the-machine` — it leaves the browser: it calls a mutating DorkOS
 *   API, writes to disk, or arms work that runs later.
 */
export type UiCommandReach = 'client-only' | 'reaches-the-machine';

/**
 * Every UI command's reach, and therefore whether an agent may issue it without
 * an approval card (DOR-625).
 *
 * ## Why this exists as a table and not a list of exceptions
 *
 * `control_ui` is one MCP tool carrying 22 different effects, and the interactive
 * gate (`services/runtimes/claude-code/messaging/interactive-handlers.ts`)
 * auto-allows tools by NAME. So a single tool-level "safe" verdict had to cover
 * all 22 at once, and it did: the tool was auto-allowed under the comment "pure
 * client-side UI mutations, no system access". `apply_layout` is not that. The
 * cockpit answers it by POSTing `/api/shapes/:name/apply`, which creates the
 * Shape's schedules ENABLED, carrying the permission mode the Shape's manifest
 * chose — `bypassPermissions` included. An agent could arm a recurring unattended
 * run with every safety prompt off, in plain `default` mode, without a prompt.
 *
 * The table lives HERE, in the same file as the union, because the failure mode
 * is a twenty-third action added without anyone thinking about the gate. Being a
 * `Record` over `UiCommand['action']` makes that a `tsc` error in the file you are
 * already editing: you cannot add a variant above without classifying it below.
 * That is the same closed-end trick `resolveModeDecision` uses with its `never`
 * arm, and it is why this is a total map rather than a set of the dangerous ones.
 *
 * **When you add an action, `reaches-the-machine` is the default answer.** Choose
 * `client-only` only when the client's handler for it touches nothing but local UI
 * state; if it calls anything on the Transport, it is not client-only.
 */
export const UI_COMMAND_REACH: Record<UiCommand['action'], UiCommandReach> = {
  // Panels, sidebar, canvas, PIP, palette, theme, scroll, toast, confetti: all of
  // this is Zustand state and DOM in the tab the person is looking at.
  open_panel: 'client-only',
  close_panel: 'client-only',
  toggle_panel: 'client-only',
  open_sidebar: 'client-only',
  close_sidebar: 'client-only',
  switch_sidebar_tab: 'client-only',
  open_canvas: 'client-only',
  update_canvas: 'client-only',
  close_canvas: 'client-only',
  open_pip: 'client-only',
  close_pip: 'client-only',
  show_toast: 'client-only',
  set_theme: 'client-only',
  scroll_to_message: 'client-only',
  open_command_palette: 'client-only',
  celebrate: 'client-only',
  // Reads, and only of things the agent can already reach. `open_file` and
  // `open_diff` render a file the agent could have `Read`; `browser_navigate`
  // opens a page it could have fetched; `open_terminal` reveals a shell for the
  // PERSON in the session's own worktree, which the agent cannot type into.
  // Putting a card in front of these would train people to dismiss cards.
  open_file: 'client-only',
  open_diff: 'client-only',
  open_terminal: 'client-only',
  browser_navigate: 'client-only',
  // Navigation: it re-points the cockpit at another working directory and
  // refetches. Nothing is written and the person sees it happen.
  switch_agent: 'client-only',
  // The one that leaves the browser. See the TSDoc above.
  apply_layout: 'reaches-the-machine',
};

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
          'audio',
          'video',
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
