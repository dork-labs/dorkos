/**
 * Zod schemas for Relay envelopes, budgets, payloads, signals,
 * HTTP API request/query schemas, and dispatch-related schemas.
 *
 * @module shared/relay-envelope-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { PermissionModeSchema } from './schemas.js';

extendZodWithOpenApi(z);

// === Subject grammar (documentation) ===

/**
 * How an agent's Relay inbox address is spelled, as a template for prose.
 *
 * The address itself is BUILT by `agentSubject()` in
 * `packages/relay/src/lib/subjects.ts`, which is the single authoritative
 * grammar; this is only the shape, and it lives in `@dorkos/shared` because
 * `@dorkos/relay` is a server-side package the client cannot import while the
 * cockpit still shows this format to a person (the agent-settings context
 * preview). `packages/relay/src/__tests__/subject-matcher.test.ts` asserts the
 * built subject against this template, so the two cannot drift.
 *
 * Load-bearing, not decorative: every namespace access rule is written against
 * this four-segment shape, and a two-segment `relay.agent.{agentId}` taught by
 * prose is what sent agents into ACCESS_DENIED for a full release (DOR-1337).
 */
export const AGENT_SUBJECT_FORMAT = 'relay.agent.{namespace}.{agentId}' as const;

// === Enums ===

export const PerformativeSchema = z
  .enum(['request', 'inform', 'query', 'propose', 'accept', 'reject', 'cfp', 'failure'])
  .openapi('Performative');

export type Performative = z.infer<typeof PerformativeSchema>;

export const SignalTypeSchema = z
  .enum(['typing', 'presence', 'read_receipt', 'delivery_receipt', 'progress', 'backpressure'])
  .openapi('SignalType');

export type SignalType = z.infer<typeof SignalTypeSchema>;

export const ChannelTypeSchema = z
  .enum(['dm', 'group', 'channel', 'thread'])
  .openapi('ChannelType');

export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// === Budget ===

export const RelayBudgetSchema = z
  .object({
    hopCount: z.number().int().min(0),
    maxHops: z.number().int().min(1).default(5),
    ancestorChain: z.array(z.string()),
    ttl: z
      .number()
      .int()
      .min(0)
      .openapi({ description: 'Absolute expiry timestamp (ms since epoch)' }),
    callBudgetRemaining: z.number().int().min(0),
  })
  .openapi('RelayBudget');

export type RelayBudget = z.infer<typeof RelayBudgetSchema>;

// === Envelope ===

export const RelayEnvelopeSchema = z
  .object({
    id: z.string().describe('ULID message ID'),
    subject: z.string(),
    from: z.string(),
    replyTo: z.string().optional(),
    budget: RelayBudgetSchema,
    createdAt: z.string().datetime(),
    payload: z.unknown(),
    // The one hop AsyncLocalStorage provably cannot cross: a republish mints a
    // fresh ULID, so the inbound and outbound `id`s of one logical delivery are
    // unrelated values. The correlation id therefore has to ride the envelope.
    //
    // OPTIONAL, and it must stay optional: every existing producer and every
    // envelope already sitting in a maildir predates this field and must keep
    // parsing.
    dispatchId: z
      .string()
      .optional()
      .describe('Opaque correlation id joining every hop of one dispatch'),
  })
  .openapi('RelayEnvelope');

export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

// === Relay Flow (topology pulse) ===

/** Direction a relay message travels across a binding edge. */
export const RelayFlowDirectionSchema = z
  .enum(['inbound', 'outbound'])
  .openapi('RelayFlowDirection');

export type RelayFlowDirection = z.infer<typeof RelayFlowDirectionSchema>;

/**
 * Metadata-only signal that one relay message was delivered across a binding
 * edge, used solely to animate a transient pulse on the topology. Carries the
 * routing skeleton and NOTHING about the message itself — no payload, text,
 * subject, or chat id.
 */
export const RelayFlowEventSchema = z
  .object({
    /** Binding UUID. The client maps this to edge id `binding:{bindingId}`. */
    bindingId: z.string(),
    /** Adapter instance id (`binding.adapterId`); edge source `adapter:{adapterId}`. */
    adapterId: z.string(),
    /** Mesh agent id (`binding.agentId`); edge target. */
    agentId: z.string(),
    /** Travel direction: `inbound` = adapter→agent (source→target). */
    direction: RelayFlowDirectionSchema,
    /** Emit timestamp (ISO 8601), for client-side staleness/coalescing. */
    at: z.string().datetime(),
  })
  .openapi('RelayFlowEvent');

export type RelayFlowEvent = z.infer<typeof RelayFlowEventSchema>;

// === Standard Payload ===

export const AttachmentSchema = z
  .object({
    path: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().optional(),
  })
  .openapi('Attachment');

export type Attachment = z.infer<typeof AttachmentSchema>;

export const ResponseContextSchema = z
  .object({
    platform: z.string(),
    maxLength: z.number().int().optional(),
    supportedFormats: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    formattingInstructions: z.string().optional(),
  })
  .openapi('ResponseContext');

export type ResponseContext = z.infer<typeof ResponseContextSchema>;

export const StandardPayloadSchema = z
  .object({
    content: z.string(),
    senderName: z.string().optional(),
    senderAvatar: z.string().optional(),
    channelName: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    attachments: z.array(AttachmentSchema).optional(),
    responseContext: ResponseContextSchema.optional(),
    performative: PerformativeSchema.optional(),
    conversationId: z.string().optional(),
    correlationId: z.string().optional(),
    platformData: z.unknown().optional(),
  })
  .openapi('StandardPayload');

export type StandardPayload = z.infer<typeof StandardPayloadSchema>;

// === Signals ===

export const SignalSchema = z
  .object({
    type: SignalTypeSchema,
    state: z.string(),
    endpointSubject: z.string(),
    timestamp: z.string().datetime(),
    data: z.unknown().optional(),
  })
  .openapi('Signal');

export type Signal = z.infer<typeof SignalSchema>;

// === HTTP API Request/Query Schemas ===

export const RelaySendMessageRequestSchema = z
  .object({
    subject: z.string().min(1),
    payload: z.unknown(),
    from: z.string().min(1),
    replyTo: z.string().optional(),
    budget: z
      .object({
        maxHops: z.number().int().min(1).optional(),
        ttl: z.number().int().optional(),
        callBudgetRemaining: z.number().int().min(0).optional(),
      })
      .optional(),
  })
  .openapi('RelaySendMessageRequest');

export type RelaySendMessageRequest = z.infer<typeof RelaySendMessageRequestSchema>;

/** @deprecated Use `RelaySendMessageRequestSchema` — renamed to avoid collision with schemas.ts */
export const SendMessageRequestSchema = RelaySendMessageRequestSchema;
/** @deprecated Use `RelaySendMessageRequest` — renamed to avoid collision with schemas.ts */
export type SendMessageRequest = RelaySendMessageRequest;

export const MessageListQuerySchema = z
  .object({
    subject: z.string().optional(),
    status: z.enum(['new', 'cur', 'failed']).optional(),
    from: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('MessageListQuery');

export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

/**
 * Inbox status filter values, keyed to the real message status enum
 * (`pending` | `delivered` | `failed`) plus `all` to opt out of filtering
 * entirely.
 */
export const InboxStatusFilterSchema = z
  .enum(['pending', 'delivered', 'failed', 'all'])
  .openapi('InboxStatusFilter');

export type InboxStatusFilter = z.infer<typeof InboxStatusFilterSchema>;

export const InboxQuerySchema = z
  .object({
    status: InboxStatusFilterSchema.default('pending').openapi({
      description:
        'Filter messages by status. Defaults to "pending" (deliverable, unread messages) so ' +
        'budget-rejected failures never surface silently next to real deliverables. Pass ' +
        '"failed" to see budget-rejected/dead-lettered messages, "delivered" for already-read ' +
        'ones (metadata only — the payload is removed once a message completes), or "all" for ' +
        'every status.',
    }),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('InboxQuery');

export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const EndpointRegistrationSchema = z
  .object({
    subject: z.string().min(1),
    description: z.string().optional(),
  })
  .openapi('EndpointRegistration');

export type EndpointRegistration = z.infer<typeof EndpointRegistrationSchema>;

// === Task Dispatch ===

/**
 * Subject prefix one task's dispatch envelope is published to.
 *
 * The concrete subject is this prefix plus the task id and NOTHING else — see
 * {@link isTaskDispatchSubject}, which is the rule a receiver must apply rather
 * than a bare `startsWith`.
 */
export const TASK_DISPATCH_SUBJECT_PREFIX = 'relay.system.tasks.';

/**
 * The subject one task's dispatch is published to.
 *
 * @param taskId - The task being dispatched.
 */
export function taskDispatchSubject(taskId: string): string {
  return `${TASK_DISPATCH_SUBJECT_PREFIX}${taskId}`;
}

/**
 * Whether a subject is EXACTLY one task's dispatch subject.
 *
 * A receiver claims {@link TASK_DISPATCH_SUBJECT_PREFIX} as a prefix, so every
 * subject BENEATH a dispatch subject reaches it too — and a prefix test alone
 * then reads `relay.system.tasks.<id>.<anything>` as a dispatch. That is not
 * hypothetical: the task path used to stream a run's own progress to
 * `relay.system.tasks.<id>.response`, every event of which came straight back
 * in as a malformed dispatch and dead-lettered. One live run produced 279
 * "could not be delivered" notifications (DOR-1567).
 *
 * Task ids are ULIDs, which contain no dot, so "the tail is one segment" is the
 * whole test.
 *
 * @param subject - The subject a message arrived on.
 */
export function isTaskDispatchSubject(subject: string): boolean {
  if (!subject.startsWith(TASK_DISPATCH_SUBJECT_PREFIX)) return false;
  const tail = subject.slice(TASK_DISPATCH_SUBJECT_PREFIX.length);
  return tail.length > 0 && !tail.includes('.');
}

export const TaskDispatchPayloadSchema = z
  .object({
    type: z.literal('task_dispatch'),
    taskId: z.string(),
    runId: z.string(),
    prompt: z.string(),
    cwd: z.string().nullable(),
    // The scheduled run's safety posture, handed straight to the agent session
    // it starts — so the wire contract holds it to the same enum every other
    // surface uses, rather than any string.
    permissionMode: PermissionModeSchema,
    taskName: z.string(),
    cron: z.string().nullable(),
    trigger: z.string(),
    /**
     * The unattended-run briefing the agent starts with — what job this is,
     * what schedule raised it, and that nobody is here to answer questions
     * (`buildTaskAppend` server-side).
     *
     * On the wire because the receiver runs in another process and cannot
     * rebuild it: the task's agent id and the run's trigger are not otherwise
     * here. Optional so an envelope written before this field existed — a
     * dead-letter replay, say — still parses; a run without it simply gets no
     * briefing, which is what every relay-dispatched run got before DOR-1567.
     */
    systemPromptAppend: z.string().optional(),
  })
  .openapi('TaskDispatchPayload');

export type TaskDispatchPayload = z.infer<typeof TaskDispatchPayloadSchema>;

// === Task Cancel ===

/**
 * Subject prefix a stop request for one run is published to (DOR-808).
 *
 * Two namespaces were ruled out, and both for reasons that bite.
 *
 * NOT under `relay.system.tasks.`, which the Claude Code adapter claims as a
 * delivery prefix: a stop must reach a run that is already holding one of the
 * adapter's concurrency slots, and anything routed through `deliver()` queues
 * behind exactly the run it is trying to end. It travels the way tool approvals
 * do instead — a subscription the adapter registers on start.
 *
 * NOT under `relay.system.` at all, which is subtler and worse. A subscriber is
 * counted as a DELIVERY unless it explicitly refuses, and `GET
 * /api/relay/stream` lets anyone watch `relay.system.>` with a handler that
 * only forwards what it sees. A watcher attached to a stop's subject therefore
 * makes every stop report "delivered" while nothing was stopped — the honest
 * "nobody took it" answer becomes unreachable precisely when it is true.
 * `relay.control.` is outside every prefix that route will accept, and the bus
 * refuses a mailbox there outright — not because a mailbox would swallow the
 * stop (it would not: the Maildir watcher re-dispatches to the same
 * subscribers, so the handler still runs), but because `deliveredTo` would
 * then count the mailbox and report the same false confirmation by a second
 * route.
 *
 * The concrete subject is this prefix plus the run id, so a trace row names the
 * run it belongs to.
 */
export const TASK_CANCEL_SUBJECT_PREFIX = 'relay.control.task-cancel.';

/**
 * The only principal allowed to stop a run.
 *
 * Server-injected on publish and not reachable from a model, so a handler that
 * checks it knows the request came from the scheduler acting on a person's
 * button press — not from an agent that guessed a run id.
 */
export const TASK_SCHEDULER_PRINCIPAL = 'relay.system.tasks.scheduler';

export const TaskCancelPayloadSchema = z
  .object({
    type: z.literal('task_cancel'),
    /** The run to stop. Authoritative — the subject's tail is for humans. */
    runId: z.string(),
  })
  .openapi('TaskCancelPayload');

export type TaskCancelPayload = z.infer<typeof TaskCancelPayloadSchema>;

// === Agent Turn Cancel ===

/**
 * Subject prefix a stop request for one agent turn is published to (DOR-791).
 *
 * The same reasoning as {@link TASK_CANCEL_SUBJECT_PREFIX}, for the other kind
 * of work a runtime adapter executes on somebody else's behalf. A turn started
 * by an A2A `message/send` runs inside the adapter, so the gateway holds no
 * handle on it: dropping its reply subscription abandons the stream and leaves
 * the model running — and billing — for as long as it wants. The stop travels
 * the bus the message did.
 *
 * `relay.control.` for the same two reasons: a stop must not queue behind the
 * turn it exists to end (so it arrives by subscription, not delivery), and
 * nothing may attach a watcher to it, because a watcher counts as a delivery
 * and would make every unanswered stop report success.
 *
 * The concrete subject is this prefix plus the A2A task id, so a trace row
 * names the task it belongs to; the payload's `replyTo` is what actually
 * identifies the turn.
 */
export const AGENT_CANCEL_SUBJECT_PREFIX = 'relay.control.agent-cancel.';

/**
 * The only principal allowed to stop an agent turn.
 *
 * Server-injected on publish and not reachable from a model, exactly like
 * {@link TASK_SCHEDULER_PRINCIPAL}: a handler that checks it knows the request
 * came from the A2A gateway acting on its caller's `tasks/cancel`, and not from
 * an agent with `relay_send` that guessed a reply subject.
 */
export const A2A_GATEWAY_PRINCIPAL = 'relay.system.a2a.gateway';

/** Why a turn is being stopped, in the words its runner writes to the log. */
export const AgentCancelReasonSchema = z.enum(['caller_canceled', 'caller_timeout']);

export type AgentCancelReason = z.infer<typeof AgentCancelReasonSchema>;

export const AgentCancelPayloadSchema = z
  .object({
    type: z.literal('agent_cancel'),
    /**
     * The reply subject of the turn to stop — authoritative, and the reason
     * this is not the agent id: a reply subject is minted per execution, so it
     * names ONE turn even when two turns of the same task run at once.
     */
    replyTo: z.string(),
    /** Whether the caller cancelled or simply stopped waiting. */
    reason: AgentCancelReasonSchema,
  })
  .openapi('AgentCancelPayload');

export type AgentCancelPayload = z.infer<typeof AgentCancelPayloadSchema>;

// === Console Relay Receipt ===

export const RelayReceiptSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
  })
  .openapi('RelayReceipt');

export type RelayReceipt = z.infer<typeof RelayReceiptSchema>;

// === Dispatch Progress ===

/** Published by CCA to relay.inbox.dispatch.* on each progress event. */
export const RelayProgressPayloadSchema = z
  .object({
    type: z.literal('progress'),
    step: z.number().int().min(1).describe('Monotonically increasing step counter'),
    step_type: z
      .enum(['message', 'tool_result'])
      .describe('message = assistant text block completed; tool_result = tool execution completed'),
    text: z.string().describe('Text content of this progress step'),
    done: z.literal(false),
  })
  .openapi('RelayProgressPayload');

export type RelayProgressPayload = z.infer<typeof RelayProgressPayloadSchema>;

/**
 * Published by CCA to relay.inbox.dispatch.* as the final event.
 * Also published to relay.inbox.query.* (existing behavior, done field added).
 */
export const RelayAgentResultPayloadSchema = z
  .object({
    type: z.literal('agent_result'),
    text: z.string().describe('Full collected response text from the agent session'),
    done: z.literal(true),
    error: z
      .string()
      .optional()
      .describe(
        'Present only when the agent turn failed. `text` then holds whatever was ' +
          'streamed before the failure, so a reader must check this field before ' +
          'treating the result as an answer (DOR-1337).'
      ),
  })
  .openapi('RelayAgentResultPayload');

export type RelayAgentResultPayload = z.infer<typeof RelayAgentResultPayloadSchema>;

// === Conversation View ===

export const SubjectLabelSchema = z
  .object({
    label: z.string(),
    raw: z.string(),
  })
  .openapi('SubjectLabel');

export type SubjectLabel = z.infer<typeof SubjectLabelSchema>;

export const RelayConversationSchema = z
  .object({
    id: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    status: z.enum(['delivered', 'failed', 'pending']),
    from: SubjectLabelSchema,
    to: SubjectLabelSchema,
    preview: z.string(),
    payload: z.unknown().optional(),
    responseCount: z.number(),
    sentAt: z.string(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
    subject: z.string(),
    sessionId: z.string().optional(),
    clientId: z.string().optional(),
    traceId: z.string().optional(),
    failureReason: z.string().optional(),
  })
  .openapi('RelayConversation');

export type RelayConversation = z.infer<typeof RelayConversationSchema>;
