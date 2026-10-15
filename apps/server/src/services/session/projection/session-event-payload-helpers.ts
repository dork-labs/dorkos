import { AlwaysAllowScopeSchema } from '@dorkos/shared/schemas';
import type { AlwaysAllowScope, StreamEvent, TerminalReason } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent } from '../session-state-projector.js';
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../../core/capabilities/capability-approval-hold.js';

type StreamData = Record<string, unknown>;
type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/** Map a `hook_response` outcome to the hook-update status enum. */
export function mapHookOutcome(outcome: unknown): 'success' | 'error' | 'cancelled' {
  if (outcome === 'error') return 'error';
  if (outcome === 'cancelled') return 'cancelled';
  return 'success';
}

/**
 * Map an `interaction_cancelled` event's `reason` to the resolution its
 * `interaction_resolved` projection carries (DOR-1148). `approved`/`denied`
 * name a real answer (an OpenCode `permission.replied` echo reporting an
 * answer given outside DorkOS); `timeout` names an answer the system gave on
 * the person's behalf. Anything else — including the ordinary `aborted` and a
 * reason a future runtime has not taught this function yet — is a withdrawal,
 * not an answer, so it defaults to `cancelled` rather than inventing a receipt.
 */
export function resolutionForCancelledReason(
  reason: unknown
): RawOf<'interaction_resolved'>['resolution'] {
  if (reason === 'timeout') return 'expired';
  if (reason === 'approved') return 'approved';
  if (reason === 'denied') return 'denied';
  return 'cancelled';
}

/**
 * Extract the shared ToolCallEvent payload fields from a `StreamEvent`'s data.
 * Both `tool_call` and `tool_result` members share this body (minus `type`).
 */
export function toToolPayload(data: StreamData): Omit<RawOf<'tool_call'>, 'type'> {
  return {
    toolCallId: String(data.toolCallId ?? ''),
    toolName: String(data.toolName ?? ''),
    status: (data.status as RawOf<'tool_call'>['status']) ?? 'running',
    ...(data.input !== undefined ? { input: String(data.input) } : {}),
    ...(data.result !== undefined ? { result: String(data.result) } : {}),
    // MCP App reference (SEP-1865) passes through structurally when present —
    // only claude-code tool_result events populate it (spec mcp-apps-host §2.2).
    ...(data.ui !== undefined ? { ui: data.ui as RawOf<'tool_call'>['ui'] } : {}),
  };
}

/**
 * The countdown fields every interaction member carries, mapped once.
 *
 * All three kinds are drawn on the same cards and answered the same way, so the
 * timer is read here rather than per-kind: `toQuestionEvent` used to drop the
 * budget its runtime declared while `toApprovalEvent` kept it, which left a live
 * question's card with a deadline it could only count from NOW — restarting the
 * countdown on every remount instead of letting it decay (DOR-1442).
 *
 * `timeoutMs` is carried only when the runtime declared one: an invented budget
 * would draw a deadline nothing enforces (DOR-810).
 */
function toInteractionTimer(data: StreamData): {
  startedAt: number;
  remainingMs: number;
  timeoutMs?: number;
} {
  return {
    startedAt: Number(data.startedAt ?? Date.now()),
    remainingMs: Number(data.remainingMs ?? data.timeoutMs ?? 0),
    ...(data.timeoutMs !== undefined ? { timeoutMs: Number(data.timeoutMs) } : {}),
  };
}

/** Map an `approval_required` StreamEvent to its session-stream member. */
export function toApprovalEvent(data: StreamData): RawOf<'approval_required'> {
  return {
    type: 'approval_required',
    id: String(data.toolCallId ?? ''),
    ...toInteractionTimer(data),
    toolName: String(data.toolName ?? ''),
    input: String(data.input ?? ''),
    hasSuggestions: Boolean(data.hasSuggestions),
    ...(data.title !== undefined ? { title: String(data.title) } : {}),
    ...(data.displayName !== undefined ? { displayName: String(data.displayName) } : {}),
    ...(data.description !== undefined ? { description: String(data.description) } : {}),
    ...(data.blockedPath !== undefined ? { blockedPath: String(data.blockedPath) } : {}),
    ...(data.decisionReason !== undefined ? { decisionReason: String(data.decisionReason) } : {}),
    // Validated rather than cast: this one drives the sentence beside "Always
    // Allow", and a runtime that shipped an unrecognised word would have the
    // card make a promise nobody wrote. An unreadable value is simply absent,
    // which renders as the plain button it always was.
    ...(isAlwaysAllowScope(data.alwaysAllowScope)
      ? { alwaysAllowScope: data.alwaysAllowScope }
      : {}),
  };
}

/** Whether a raw stream value is one of the three scopes a card can name. */
function isAlwaysAllowScope(value: unknown): value is AlwaysAllowScope {
  return AlwaysAllowScopeSchema.safeParse(value).success;
}

/** Map a `question_prompt` StreamEvent to its session-stream member. */
export function toQuestionEvent(data: StreamData): RawOf<'question_prompt'> {
  return {
    type: 'question_prompt',
    id: String(data.toolCallId ?? ''),
    ...toInteractionTimer(data),
    // QuestionItem[] passes through structurally; the projector treats it opaquely.
    questions: (data.questions as RawOf<'question_prompt'>['questions']) ?? [],
  };
}

/** Map a `capability_approval_required` StreamEvent to its session-stream member. */
export function toCapabilityApprovalRequiredEvent(
  data: StreamData
): RawOf<'capability_approval_required'> {
  return {
    type: 'capability_approval_required',
    // The pending approval passes through structurally — the adapter built it
    // from the approval service, so the projector treats it opaquely.
    approval: data.approval as RawOf<'capability_approval_required'>['approval'],
    // `|| default`, NOT `?? 0`: a malformed `startedAt`/`capMs` must fail toward
    // KEEPING the stall-pause (a live hold), never toward silently disabling it.
    // `Number(undefined)` and `Number('typo')` are `NaN`, and `now - NaN < capMs`
    // is always false — so a `?? 0` (or a bare `Number(...)`) would drop the pause
    // the instant a typo reached here, and the watchdog would reap the turn while
    // the person was still deciding. `|| default` catches undefined, NaN, and 0
    // (never a real value) and substitutes a safe live hold.
    startedAt: Number(data.startedAt) || Date.now(),
    capMs: Number(data.capMs) || CAPABILITY_APPROVAL_HOLD_CAP_MS,
  };
}

/** Map a `capability_approval_resolved` StreamEvent to its session-stream member. */
export function toCapabilityApprovalResolvedEvent(
  data: StreamData
): RawOf<'capability_approval_resolved'> {
  return {
    type: 'capability_approval_resolved',
    // A missing id fails SAFE in the same direction as the required event: an
    // empty id matches no tracked hold, so the untrack is a no-op and the hold
    // self-expires at its cap rather than being dropped early — it never
    // un-pauses a still-live wait.
    approvalId: String(data.approvalId ?? ''),
    // A missing outcome degrades to `timeout` — the no-decision word, which is
    // exactly how a hold that reached here without one should read.
    //
    // Unreachable today, and worth keeping honest about what it would cost if it
    // ever became reachable: the sole emitter (`awaitCapabilityApproval`) always
    // sets an outcome, and since DOR-987 `timeout` is the one value the client
    // does NOT retire the card on — it converts it to a permanent terminal note.
    // So a genuinely missing outcome would leave a card saying "the agent stopped
    // waiting" on a request that was in fact granted. That is still the right
    // default (it points at the approvals list rather than silently vanishing),
    // but a second emitter must set `outcome` rather than lean on this.
    outcome: (data.outcome as RawOf<'capability_approval_resolved'>['outcome']) ?? 'timeout',
  };
}

/**
 * Map an `mcp_signin_required` StreamEvent to its session-stream member
 * (DOR-1004).
 *
 * Every field is coerced with `String(... ?? '')` and every default fails toward
 * KEEPING the card on screen, mirroring the approval pair's rule.
 *
 * `authorizeUrl` is the one field where that direction is arguable, and it is
 * settled at the EMITTER rather than here: `in-session-card.ts` refuses to push a
 * card whose link the schema would reject, so that call falls through to the
 * ordinary prose result and the person still gets a link — in the agent's reply
 * instead of on a card. By the time an event reaches this function its link has
 * already been checked, so the coercion below is a shape guard for a malformed
 * frame, not the place the decision is made.
 */
export function toMcpSigninRequiredEvent(data: StreamData): RawOf<'mcp_signin_required'> {
  return {
    type: 'mcp_signin_required',
    serverName: String(data.serverName ?? ''),
    agentId: String(data.agentId ?? ''),
    flowId: String(data.flowId ?? ''),
    authorizeUrl: String(data.authorizeUrl ?? ''),
    disclosure: String(data.disclosure ?? ''),
  };
}

/**
 * Map an `mcp_signin_resolved` StreamEvent to its session-stream member
 * (DOR-1004).
 *
 * A missing outcome degrades to `failed`, which is the fail-safe direction here:
 * `connected` RETIRES the card outright, so guessing it would delete a live
 * sign-in surface on a malformed event, while `failed` leaves a visible note the
 * person can act on. A missing `flowId` matches no card and resolves nothing —
 * the card then stays until the conversation moves on, which is also the safe
 * side.
 */
export function toMcpSigninResolvedEvent(data: StreamData): RawOf<'mcp_signin_resolved'> {
  return {
    type: 'mcp_signin_resolved',
    flowId: String(data.flowId ?? ''),
    outcome: data.outcome === 'connected' ? 'connected' : 'failed',
  };
}

/** Map an `elicitation_prompt` StreamEvent to its session-stream member. */
export function toElicitationEvent(data: StreamData): RawOf<'elicitation_prompt'> {
  return {
    type: 'elicitation_prompt',
    id: String(data.interactionId ?? data.elicitationId ?? ''),
    ...toInteractionTimer(data),
    serverName: String(data.serverName ?? ''),
    message: String(data.message ?? ''),
    ...(data.mode !== undefined ? { mode: data.mode as RawOf<'elicitation_prompt'>['mode'] } : {}),
    ...(data.url !== undefined ? { url: String(data.url) } : {}),
    ...(data.elicitationId !== undefined ? { elicitationId: String(data.elicitationId) } : {}),
    ...(data.requestedSchema !== undefined
      ? { requestedSchema: data.requestedSchema as Record<string, unknown> }
      : {}),
  };
}

/** The partial status payload carried by a `status_change` event. */
type StatusChangePayload = RawOf<'status_change'>['status'];

/** The partial `contextUsage` payload allowed inside a `status_change`. */
type PartialContextUsage = NonNullable<StatusChangePayload['contextUsage']>;

/**
 * Fold a `session_status` StreamEvent into a partial-status `status_change`.
 * Only fields present on the event are projected; absent
 * fields leave the held status untouched (the projector merges partials,
 * including field-wise within `contextUsage`).
 *
 * Two real `session_status` shapes exist: the streaming mapper emits only
 * `outputTokens`, while the final result mapper emits `contextTokens`/
 * `contextMaxTokens`/cache totals but NO `outputTokens`. Fabricating absent
 * fields as `0` here would let the final event zero the running output-token
 * count, so each `contextUsage`/`cacheStats` field is emitted ONLY when its
 * source field is present.
 */
export function toStatusChange(data: StreamData): RawSessionEvent | null {
  const status: StatusChangePayload = {};
  if (data.model !== undefined) status.model = String(data.model);
  if (data.costUsd !== undefined) status.cost = Number(data.costUsd);

  // `usage` is all-or-nothing (the producing mapper re-attaches held
  // subscription fields), so it merges whole-object like `model`/`cost`.
  if (data.usage !== undefined) status.usage = data.usage as StatusChangePayload['usage'];

  // A hard usage limit (spec claude-account-fleet D4), or `null` to clear one.
  // Whole-object like `usage`; absent leaves the held limit alone.
  if (data.limit !== undefined) status.limit = data.limit as StatusChangePayload['limit'];

  const contextUsage = toPartialContextUsage(data);
  if (contextUsage !== null) status.contextUsage = contextUsage;

  // cacheStats carries exactly two fields that the source event always supplies
  // together (the final result event) or omits together (streaming), so it is
  // all-or-nothing — emit the full object only when both are present.
  if (data.cacheReadTokens !== undefined && data.cacheCreationTokens !== undefined) {
    status.cacheStats = {
      cacheReadTokens: Number(data.cacheReadTokens),
      cacheCreationTokens: Number(data.cacheCreationTokens),
    };
  }

  if (Object.keys(status).length === 0) return null;
  const change: RawOf<'status_change'> = { type: 'status_change', status };
  return change;
}

/**
 * Build a partial `contextUsage` carrying ONLY the token fields present on the
 * source event, or `null` when none are present. Omitting a field lets the
 * projector preserve its prior value rather than zeroing it. A context reading
 * (`contextTokens`) is stamped with `observedAt`.
 */
function toPartialContextUsage(data: StreamData): PartialContextUsage | null {
  const usage: PartialContextUsage = {};
  if (data.contextTokens !== undefined) {
    usage.totalTokens = Number(data.contextTokens);
    // A live reading is dated now, so a client can say how fresh the gauge is
    // and a restored reading (spec `claude-account-fleet` §6 U) reads as older.
    usage.observedAt = new Date().toISOString();
  }
  if (data.contextMaxTokens !== undefined) usage.maxTokens = Number(data.contextMaxTokens);
  if (data.outputTokens !== undefined) usage.outputTokens = Number(data.outputTokens);
  if (data.cacheReadTokens !== undefined) usage.cacheReadTokens = Number(data.cacheReadTokens);
  if (data.cacheCreationTokens !== undefined) {
    usage.cacheCreationTokens = Number(data.cacheCreationTokens);
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

/** Map a `task_update` StreamEvent (Task tool / TodoWrite) to a `todo_update` member. */
export function toTodoUpdate(data: StreamData): RawOf<'todo_update'> {
  return {
    type: 'todo_update',
    action: (data.action as RawOf<'todo_update'>['action']) ?? 'snapshot',
    task: data.task as RawOf<'todo_update'>['task'],
    ...(data.tasks !== undefined ? { tasks: data.tasks as RawOf<'todo_update'>['tasks'] } : {}),
    ...(data.previousId !== undefined
      ? { previousId: data.previousId as RawOf<'todo_update'>['previousId'] }
      : {}),
  };
}

/** Map a `background_task_done` SDK status to the subagent-update status enum. */
export function mapDoneStatus(status: unknown): 'complete' | 'error' | 'stopped' {
  if (status === 'failed') return 'error';
  if (status === 'stopped') return 'stopped';
  return 'complete';
}

/**
 * Read a {@link TerminalReason} off a `done`/`session_status` StreamEvent's
 * data, if present, for the synthesized `turn_end`.
 */
export function readTerminalReason(event: StreamEvent): TerminalReason | undefined {
  const data = (event.data ?? {}) as StreamData;
  return data.terminalReason as TerminalReason | undefined;
}

/**
 * Read the `code` off an `error` StreamEvent's data, if it carried one — the
 * field {@link isNonFatalErrorCode} classifies.
 */
export function readErrorCode(event: StreamEvent): string | undefined {
  const code = ((event.data ?? {}) as StreamData).code;
  return typeof code === 'string' ? code : undefined;
}
