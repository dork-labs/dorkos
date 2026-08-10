/**
 * Normalizer from a runtime's {@link StreamEvent} stream into the
 * runtime-neutral {@link RawSessionEvent} union the projector ingests.
 *
 * Every `AgentRuntime.sendMessage` yields SDK-free DorkOS `StreamEvent`s (the
 * Claude adapter translates raw SDK `SDKMessage`s into them in
 * `sdk/event-mappers/`); this module is the SECOND, lossy hop that folds those
 * `StreamEvent`s into the smaller session-stream contract the projector and
 * every client consume. `triggerTurn` drives EVERY runtime's turns through
 * {@link feedProjector} (the single delivery path, ADR-0264), so the normalizer
 * lives beside the projector it feeds — not inside any one adapter.
 *
 * Why a separate hop instead of feeding `StreamEvent`s directly: the
 * session-stream union is intentionally smaller (text/thinking/tool/interaction/
 * status/todo/subagent/hook/memory/error/turn), runtime-neutral, and carries the
 * projector-stamped `seq`. Transient `StreamEvent`s with no durable projection
 * (sync/presence, relay receipts, raw context-usage) map to `null` and are
 * dropped. Typed `error` events are NOT dropped: they ride the durable stream
 * so live clients render the failure inline and the projector latches
 * `SessionStatus.lastError`.
 *
 * Turn boundaries are NOT carried by `StreamEvent`s. The trigger knows when a
 * turn begins (the first event of a `sendMessage` generator) and ends (the
 * `done` event), so {@link feedProjector} synthesizes `turn_start`/`turn_end`
 * around the per-event mapping.
 *
 * @module services/session/session-event-normalizer
 */
import type { StreamEvent, TerminalReason } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent, SessionStateProjector } from './session-state-projector.js';
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../core/capabilities/capability-approval-hold.js';

/** A `StreamEvent`'s `data` payload, read defensively as a loose record. */
type StreamData = Record<string, unknown>;

/**
 * The `seq`-less shape of a single {@link SessionEvent} member, selected by its
 * `type` discriminator. `Omit<SessionEvent, 'seq'>` collapses the union to its
 * common keys; distributing `Extract` first preserves each member's full field
 * set so object literals type-check precisely.
 */
type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/**
 * Map a single DorkOS {@link StreamEvent} to a {@link RawSessionEvent}, or
 * `null` when the event has no durable session-stream projection.
 *
 * Pure and synchronous: it never reads I/O and never stamps `seq` (the
 * projector owns that). Task #6 calls this per `StreamEvent` during a triggered
 * turn; external-session deltas (task #6/#9) can reuse it once JSONL deltas are
 * translated back into `StreamEvent`s.
 *
 * @param event - A DorkOS `StreamEvent` as produced by `sendMessage`.
 * @returns The normalized event, or `null` to drop it.
 */
export function toRawSessionEvent(event: StreamEvent): RawSessionEvent | null {
  const data = (event.data ?? {}) as StreamData;
  switch (event.type) {
    case 'text_delta': {
      const delta: RawOf<'text_delta'> = { type: 'text_delta', text: String(data.text ?? '') };
      return delta;
    }
    case 'thinking_delta': {
      const delta: RawOf<'thinking_delta'> = {
        type: 'thinking_delta',
        text: String(data.text ?? ''),
      };
      return delta;
    }

    case 'tool_progress': {
      const progress: RawOf<'tool_progress'> = {
        type: 'tool_progress',
        toolCallId: String(data.toolCallId ?? ''),
        content: String(data.content ?? ''),
      };
      return progress;
    }

    // tool_call_start/delta map to an in-progress tool_call; tool_call_end and
    // tool_result map to the terminal tool_result. All reuse the ToolCallEvent
    // payload shape, so we pass the fields straight through.
    case 'tool_call_start':
    case 'tool_call_delta': {
      const call: RawOf<'tool_call'> = { type: 'tool_call', ...toToolPayload(data) };
      return call;
    }
    case 'tool_call_end':
    case 'tool_result': {
      const result: RawOf<'tool_result'> = { type: 'tool_result', ...toToolPayload(data) };
      return result;
    }

    case 'approval_required':
      return toApprovalEvent(data);
    case 'question_prompt':
      return toQuestionEvent(data);
    case 'elicitation_prompt':
      return toElicitationEvent(data);

    // An in-session destructive capability call held awaiting the operator's
    // decision, and its resolution (DOR-939). The projector tracks the required
    // event as a pending HOLD (pausing the stall watchdog); the resolved event
    // drops it and retires the inline card.
    case 'capability_approval_required':
      return toCapabilityApprovalRequiredEvent(data);
    case 'capability_approval_resolved':
      return toCapabilityApprovalResolvedEvent(data);

    case 'mcp_signin_required':
      return toMcpSigninRequiredEvent(data);
    case 'mcp_signin_resolved':
      return toMcpSigninResolvedEvent(data);

    case 'session_status':
      return toStatusChange(data);

    case 'task_update':
      return toTodoUpdate(data);

    case 'background_task_started': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: 'running',
        ...(data.description !== undefined ? { description: String(data.description) } : {}),
      };
      return update;
    }
    case 'background_task_progress': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: 'running',
        ...(data.toolUses !== undefined ? { toolUses: Number(data.toolUses) } : {}),
        ...(data.lastToolName !== undefined ? { lastToolName: String(data.lastToolName) } : {}),
        ...(data.summary !== undefined ? { summary: String(data.summary) } : {}),
      };
      return update;
    }
    case 'background_task_done': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: mapDoneStatus(data.status),
        ...(data.summary !== undefined ? { summary: String(data.summary) } : {}),
        ...(data.toolUses !== undefined ? { toolUses: Number(data.toolUses) } : {}),
      };
      return update;
    }

    // The three hook phases collapse into one `hook_update` member keyed by
    // hookId (the subagent_update precedent): start carries identity, progress
    // carries cumulative output, response carries the outcome.
    case 'hook_started': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: 'running',
        hookName: String(data.hookName ?? ''),
        hookEvent: String(data.hookEvent ?? ''),
        toolCallId: data.toolCallId === null ? null : String(data.toolCallId ?? ''),
      };
      return update;
    }
    case 'hook_progress': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: 'running',
        stdout: String(data.stdout ?? ''),
        stderr: String(data.stderr ?? ''),
      };
      return update;
    }
    case 'hook_response': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: mapHookOutcome(data.outcome),
        hookName: String(data.hookName ?? ''),
        stdout: String(data.stdout ?? ''),
        stderr: String(data.stderr ?? ''),
        ...(data.exitCode !== undefined ? { exitCode: Number(data.exitCode) } : {}),
      };
      return update;
    }

    case 'memory_recall': {
      const recall: RawOf<'memory_recall'> = {
        type: 'memory_recall',
        mode: (data.mode as RawOf<'memory_recall'>['mode']) ?? 'select',
        // MemoryEntry[] passes through structurally; the projector treats it opaquely.
        memories: (data.memories as RawOf<'memory_recall'>['memories']) ?? [],
      };
      return recall;
    }

    // A context-window compaction boundary. The mapper camelCases the SDK
    // `compact_metadata`; forward only the fields present so a malformed boundary
    // still validates as `{}`. `!== undefined` (not truthiness) so `0` survives.
    case 'compact_boundary': {
      const boundary: RawOf<'compact_boundary'> = {
        type: 'compact_boundary',
        ...(data.trigger !== undefined
          ? { trigger: data.trigger as RawOf<'compact_boundary'>['trigger'] }
          : {}),
        ...(data.preTokens !== undefined ? { preTokens: Number(data.preTokens) } : {}),
        ...(data.postTokens !== undefined ? { postTokens: Number(data.postTokens) } : {}),
        ...(data.durationMs !== undefined ? { durationMs: Number(data.durationMs) } : {}),
      };
      return boundary;
    }

    // A transient operational status (hook progress, a raw SDK `status` token).
    // Drives the client status strip; forward only the fields present. Operation
    // lifecycle (compaction) rides `operation_progress`, not this member.
    case 'system_status': {
      const status: RawOf<'system_status'> = {
        type: 'system_status',
        message: String(data.message ?? ''),
        ...(data.status !== undefined ? { status: String(data.status) } : {}),
      };
      return status;
    }

    // Runtime-agnostic operation progress (DOR-110 — compaction start/done/failed).
    // Drives the status strip's progress treatment and the failed-compaction error
    // surface; forward only the fields present so a lean phase stays lean.
    case 'operation_progress': {
      const progress: RawOf<'operation_progress'> = {
        type: 'operation_progress',
        operation: data.operation as RawOf<'operation_progress'>['operation'],
        state: data.state as RawOf<'operation_progress'>['state'],
        determinate: Boolean(data.determinate),
        ...(data.percent !== undefined ? { percent: Number(data.percent) } : {}),
        ...(data.message !== undefined ? { message: String(data.message) } : {}),
        ...(data.error !== undefined ? { error: String(data.error) } : {}),
      };
      return progress;
    }

    // A pending interaction was cancelled WITHOUT an operator action (SDK
    // abort — e.g. a mid-turn steer superseding a pending question — or
    // timeout). Projects to the same `interaction_resolved` member the
    // operator paths use, so every consumer drops the card identically.
    //
    // The two reasons stay distinguishable downstream: a `timeout` was answered
    // (auto-denied) on the person's behalf and is worth recording, an `aborted`
    // ask was withdrawn before anyone could answer it and is not.
    case 'interaction_cancelled': {
      const resolved: RawOf<'interaction_resolved'> = {
        type: 'interaction_resolved',
        id: String(data.interactionId ?? ''),
        resolution: data.reason === 'timeout' ? 'expired' : 'cancelled',
        at: Date.now(),
      };
      return resolved;
    }

    // An agent-issued imperative UI command (the `control_ui` MCP tool pushes it
    // onto the eventQueue, which `message-sender` drains into this turn's
    // StreamEvent stream). Carried whole into the contract as a transient,
    // side-effecting member: the projector folds no state for it (the `default`
    // arm of `project()`), so it forwards live and clears with the turn. The
    // command rode the StreamEvent under `data.command`.
    case 'ui_command': {
      const command = data.command;
      if (command === undefined) return null;
      const uiCommand: RawOf<'ui_command'> = {
        type: 'ui_command',
        command: command as RawOf<'ui_command'>['command'],
      };
      return uiCommand;
    }

    // A server→client screenshot request (the `browser_screenshot` MCP tool,
    // DOR-213 Phase 3). Same transient, side-effecting class as `ui_command`:
    // forwards live to the attached client (which relays it into the preview
    // frame) and clears with the turn — never re-projected from a snapshot.
    case 'devtools_capture_request': {
      const requestId = data.requestId;
      if (requestId === undefined) return null;
      const captureRequest: RawOf<'devtools_capture_request'> = {
        type: 'devtools_capture_request',
        requestId: String(requestId),
      };
      return captureRequest;
    }

    // A typed turn error, adapter-yielded or server-injected (guardTurnErrors
    // on a throw, the stall watchdog). Optionals are forwarded only when
    // present so a lean adapter error stays lean.
    case 'error': {
      const error: RawOf<'error'> = {
        type: 'error',
        message: String(data.message ?? 'Unknown error'),
        ...(data.code !== undefined ? { code: String(data.code) } : {}),
        ...(data.category !== undefined
          ? { category: data.category as RawOf<'error'>['category'] }
          : {}),
        ...(data.details !== undefined ? { details: String(data.details) } : {}),
      };
      return error;
    }

    // No session-stream projection: raw context/usage notices, sync/presence/
    // relay traffic, prompt suggestions, permission denials, and `done` (turn
    // boundary handled by feedProjector, not by a per-event mapping).
    default:
      return null;
  }
}

/** Map a `hook_response` outcome to the hook-update status enum. */
function mapHookOutcome(outcome: unknown): 'success' | 'error' | 'cancelled' {
  if (outcome === 'error') return 'error';
  if (outcome === 'cancelled') return 'cancelled';
  return 'success';
}

/**
 * Extract the shared ToolCallEvent payload fields from a `StreamEvent`'s data.
 * Both `tool_call` and `tool_result` members share this body (minus `type`).
 */
function toToolPayload(data: StreamData): Omit<RawOf<'tool_call'>, 'type'> {
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

/** Map an `approval_required` StreamEvent to its session-stream member. */
function toApprovalEvent(data: StreamData): RawOf<'approval_required'> {
  return {
    type: 'approval_required',
    id: String(data.toolCallId ?? ''),
    startedAt: Number(data.startedAt ?? Date.now()),
    remainingMs: Number(data.remainingMs ?? data.timeoutMs ?? 0),
    toolName: String(data.toolName ?? ''),
    input: String(data.input ?? ''),
    hasSuggestions: Boolean(data.hasSuggestions),
    // The client gates its countdown on this, so it has to survive the hop from
    // the runtime's StreamEvent onto the durable member (DOR-810). Carried only
    // when the runtime declared one — an invented budget would draw a deadline
    // nothing enforces.
    ...(data.timeoutMs !== undefined ? { timeoutMs: Number(data.timeoutMs) } : {}),
    ...(data.title !== undefined ? { title: String(data.title) } : {}),
    ...(data.displayName !== undefined ? { displayName: String(data.displayName) } : {}),
    ...(data.description !== undefined ? { description: String(data.description) } : {}),
    ...(data.blockedPath !== undefined ? { blockedPath: String(data.blockedPath) } : {}),
    ...(data.decisionReason !== undefined ? { decisionReason: String(data.decisionReason) } : {}),
  };
}

/** Map a `question_prompt` StreamEvent to its session-stream member. */
function toQuestionEvent(data: StreamData): RawOf<'question_prompt'> {
  return {
    type: 'question_prompt',
    id: String(data.toolCallId ?? ''),
    startedAt: Number(data.startedAt ?? Date.now()),
    remainingMs: Number(data.remainingMs ?? data.timeoutMs ?? 0),
    // QuestionItem[] passes through structurally; the projector treats it opaquely.
    questions: (data.questions as RawOf<'question_prompt'>['questions']) ?? [],
  };
}

/** Map a `capability_approval_required` StreamEvent to its session-stream member. */
function toCapabilityApprovalRequiredEvent(
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
function toCapabilityApprovalResolvedEvent(
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
function toMcpSigninRequiredEvent(data: StreamData): RawOf<'mcp_signin_required'> {
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
function toMcpSigninResolvedEvent(data: StreamData): RawOf<'mcp_signin_resolved'> {
  return {
    type: 'mcp_signin_resolved',
    flowId: String(data.flowId ?? ''),
    outcome: data.outcome === 'connected' ? 'connected' : 'failed',
  };
}

/** Map an `elicitation_prompt` StreamEvent to its session-stream member. */
function toElicitationEvent(data: StreamData): RawOf<'elicitation_prompt'> {
  return {
    type: 'elicitation_prompt',
    id: String(data.interactionId ?? data.elicitationId ?? ''),
    startedAt: Number(data.startedAt ?? Date.now()),
    remainingMs: Number(data.remainingMs ?? data.timeoutMs ?? 0),
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
function toStatusChange(data: StreamData): RawSessionEvent | null {
  const status: StatusChangePayload = {};
  if (data.model !== undefined) status.model = String(data.model);
  if (data.costUsd !== undefined) status.cost = Number(data.costUsd);

  // `usage` is all-or-nothing (the producing mapper re-attaches held
  // subscription fields), so it merges whole-object like `model`/`cost`.
  if (data.usage !== undefined) status.usage = data.usage as StatusChangePayload['usage'];

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
 * projector preserve its prior value rather than zeroing it.
 */
function toPartialContextUsage(data: StreamData): PartialContextUsage | null {
  const usage: PartialContextUsage = {};
  if (data.contextTokens !== undefined) usage.totalTokens = Number(data.contextTokens);
  if (data.contextMaxTokens !== undefined) usage.maxTokens = Number(data.contextMaxTokens);
  if (data.outputTokens !== undefined) usage.outputTokens = Number(data.outputTokens);
  if (data.cacheReadTokens !== undefined) usage.cacheReadTokens = Number(data.cacheReadTokens);
  if (data.cacheCreationTokens !== undefined) {
    usage.cacheCreationTokens = Number(data.cacheCreationTokens);
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

/** Map a `task_update` StreamEvent (TodoWrite) to a `todo_update` member. */
function toTodoUpdate(data: StreamData): RawOf<'todo_update'> {
  return {
    type: 'todo_update',
    action: (data.action as RawOf<'todo_update'>['action']) ?? 'snapshot',
    task: data.task as RawOf<'todo_update'>['task'],
    ...(data.tasks !== undefined ? { tasks: data.tasks as RawOf<'todo_update'>['tasks'] } : {}),
  };
}

/** Map a `background_task_done` SDK status to the subagent-update status enum. */
function mapDoneStatus(status: unknown): 'complete' | 'error' | 'stopped' {
  if (status === 'failed') return 'error';
  if (status === 'stopped') return 'stopped';
  return 'complete';
}

/**
 * Read a {@link TerminalReason} off a `done`/`session_status` StreamEvent's
 * data, if present, for the synthesized `turn_end`.
 */
function readTerminalReason(event: StreamEvent): TerminalReason | undefined {
  const data = (event.data ?? {}) as StreamData;
  return data.terminalReason as TerminalReason | undefined;
}

/**
 * The normalized event types that REOPEN a turn window when they arrive after
 * the window already closed (DOR-1100).
 *
 * ## What this is for
 *
 * The claude-code adapter emits `done` on every SDK `result`
 * (`result-event-mapper.ts`, "Always emit done"), and {@link feedProjector}
 * closes the turn on it — but the CLI can keep a turn alive past its `result`
 * when a background task's notification is queued. The agent wakes, says more,
 * calls more tools, and every one of those events used to land OUTSIDE any turn:
 * the cockpit read idle while the agent worked, and the continuation was never
 * persisted (`flushTurn` only runs for events held in an open turn). Reopening a
 * window puts the continuation back on screen, back in the lifecycle, and back
 * in history.
 *
 * ## Why exactly these three, and why nothing else
 *
 * The line is THE MODEL SPEAKING AGAIN — new prose, new reasoning, a new tool
 * call — and nothing else. It is deliberately narrower than "content", because
 * plenty of ordinary content-shaped traffic trails a `result` in a turn that is
 * genuinely over, and reopening on any of it would manufacture a window nothing
 * ever fills: a ghost window, costing a `turn_start`/`turn_end` pair on the
 * durable stream, a spurious `streaming` flicker, and an empty persisted turn,
 * on turns that were perfectly normal.
 *
 * `tool_result` and `tool_progress` are the two that look like they belong here
 * and do not. All four of these post-`done` shapes were reproduced through the
 * real mappers:
 *
 * | Trailing SDK message                                   | Maps to          |
 * | ------------------------------------------------------ | ---------------- |
 * | `user` carrying the CLI's interrupt sentinel           | `tool_result`    |
 * | `tool_use_summary` for a tool that was in flight       | `tool_result`    |
 * | `stream_event` `content_block_stop` of a live tool     | `tool_result`    |
 * | `tool_progress` from a long-running tool               | `tool_progress`  |
 *
 * The first is pinned on `main` by `message-sender-phantom-cancellation.test.ts`
 * ("surfaces but does NOT steer a phantom arriving after the result message"),
 * and `message-sender`'s own `sawResult` guard exists precisely because that
 * ordering is real. All four are a tool call that was already running when the
 * `result` landed, reporting in afterwards — the turn settling, not restarting.
 *
 * The rest are bookkeeping ABOUT a turn rather than a turn:
 *
 * - **`status_change`** — `mapResultEvent` emits the terminal `session_status`
 *   BEFORE `done`, but a `rate_limit_event` can land after it, and the projector
 *   merges it into the held status either way.
 * - **`system_status`** — the phantom-cancellation notice (DOR-1087) is yielded
 *   deliberately AFTER its message's mapped events, so it is guaranteed to be
 *   able to trail a terminal `done`. An operator note, not work.
 * - **`subagent_update`** — a background child starting, reporting, or finishing
 *   is precisely the "idle, but children are still live" state; the projector's
 *   `runningSubagentCount` carries it, and drawing a turn around it would claim
 *   the agent is talking when it is not.
 * - **`error`** — `message-sender` orders every error BEFORE the terminal `done`
 *   on purpose ("nothing may follow done"). One arriving after is a stream-death
 *   artifact, and wrapping it in a fresh window would invent a turn that failed.
 * - Todo/hook/memory/compaction/interaction/sign-in/UI-command members are all
 *   either bookkeeping or a card, and none of them is the model talking.
 *
 * The narrowing costs nothing against the incident this exists for: a genuine
 * wake-up is the agent REACTING to a notification, which starts with reasoning,
 * prose, or a fresh tool call — all three still here.
 *
 * ## Why this is keyed on the StreamEvent, not the normalized member
 *
 * Because the normalizer ERASES the distinction this rule turns on.
 * `tool_call_start` (the model opening a NEW call) and `tool_call_delta` (an
 * already-open call streaming its arguments, or an `assistant` message
 * backfilling them) both normalize to one `tool_call` member — so a set keyed on
 * the normalized type cannot tell "the agent started something" from "the thing
 * it already started is still arriving". Two shapes exploit that gap, both
 * reproduced: a `content_block_delta{input_json_delta}` for a tool still open at
 * the `result`, and the `assistant` arm's input backfill for an id `toolState`
 * already knows — whose `content_block_start` was in the window that just
 * closed, so it is perfectly capable of being the first event after one.
 *
 * Reading the StreamEvent keeps the discriminant intact and costs nothing: this
 * predicate runs one line above the normalization anyway.
 */
export const TURN_REOPENING_STREAM_EVENT_TYPES: ReadonlySet<StreamEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call_start',
]);

/**
 * Drive a single triggered turn through the projector: emit `turn_start`,
 * normalize and ingest each `StreamEvent`, then emit `turn_end` when the turn's
 * `done` event arrives (or when the stream ends without one). The last-seen
 * `terminalReason` (carried on `session_status`/`done`) is attached to
 * `turn_end`; when none was carried but the turn yielded a typed `error`, the
 * error latch fills `terminalReason: 'error'` so the failure settles instead
 * of reading idle.
 *
 * ## One stream, one or more turn WINDOWS
 *
 * A `done` closes the window that is currently open. A `done` with no open
 * window is a no-op — never a second `turn_end` for the same window, never a
 * crash (spec `persistent-session-runtime` P0 / task 0.1; F5). The `finally`
 * closes whatever is still open, so the projection can never be left
 * `streaming`.
 *
 * A stream can carry MORE than one window, because the CLI can keep a turn alive
 * past the `result` DorkOS closed on: a queued background-task notification
 * wakes the agent and it keeps working. A content event arriving after the
 * window closed OPENS A NEW ONE ({@link TURN_REOPENING_STREAM_EVENT_TYPES}, DOR-1100),
 * so the continuation streams live, puts the lifecycle back to `streaming`, and
 * is persisted as its own turn when its own `done` (or the end of the stream)
 * closes it. The invariant that holds throughout is the spec's C2: exactly one
 * `turn_end` per window, however many native `result`s the backend produced.
 *
 * A reopened window resets the per-window latches, which is what makes it a
 * window rather than a continuation of the closed one: the previous window's
 * `terminalReason` and `error` belonged to the turn that already ended, and
 * carrying either forward would settle the new work as failed or interrupted
 * before it produced anything. Only the FIRST window notifies `onTurnStart` —
 * the caller's turn identity is the turn it triggered, not one the runtime
 * started on its own.
 *
 * This is the call site task #6 uses to make the message POST trigger-only:
 * pass it the runtime's `sendMessage(...)` generator so the turn is projected
 * once and read back over `subscribeSession`. It is also reusable for
 * externally-driven turns once JSONL deltas are re-expressed as `StreamEvent`s.
 *
 * @param projector - The session's projector (from `getOrCreateProjector`).
 * @param events - The adapter's `StreamEvent` stream for one turn.
 * @param opts.userMessage - The user message that triggered this turn, carried
 *   on the synthesized `turn_start` so log-backed runtimes can reconstruct the
 *   user side of the conversation from the EventLog alone (the POST is
 *   trigger-only, so the durable stream is the only place it can ride).
 * @param opts.onTurnStart - Receives the `seq` this turn's `turn_start` was
 *   stamped with — the turn's identity, for a caller that also reads the stream
 *   and has to know which turn on it is the one it started. Called
 *   SYNCHRONOUSLY, in the same block as the ingest, so it always runs before any
 *   subscriber's continuation can observe the event; a caller may therefore
 *   treat "a `turn_start` arrived and I still have no identity" as proof the
 *   turn is somebody else's.
 */
export async function feedProjector(
  projector: SessionStateProjector,
  events: AsyncIterable<StreamEvent>,
  opts: { userMessage?: string; onTurnStart?: (seq: number) => void } = {}
): Promise<void> {
  const start: RawOf<'turn_start'> = {
    type: 'turn_start',
    ...(opts.userMessage !== undefined ? { userMessage: opts.userMessage } : {}),
  };
  // Two statements, and they must stay two. Folded into
  // `opts.onTurnStart?.(projector.ingest(start).seq)` the optional CALL
  // short-circuits its own arguments, so a caller that passed no callback — which
  // is every caller but the room — never opened its turn at all.
  const started = projector.ingest(start);
  opts.onTurnStart?.(started.seq);
  /** Whether a turn window is open right now — the thing `done` closes. */
  let turnOpen = true;
  let terminalReason: TerminalReason | undefined;
  // Error latch: a turn that carried a typed `error` but whose runtime never
  // attached an explicit terminalReason (OpenCode/Codex crash paths) must still
  // close as `turn_end{terminalReason:'error'}` so it settles to the error
  // lifecycle. Explicit reasons always win; the latch only fills undefined.
  let sawError = false;
  const closeTurn = (): void => {
    // No open window: a second `done`, or a `finally` after one already closed.
    // Silently nothing — a second `turn_end` would double-settle the lifecycle,
    // re-flush the turn to the store, and (once the pump lands) close a window
    // that belongs to a different dispatch.
    if (!turnOpen) return;
    turnOpen = false;
    const reason = terminalReason ?? (sawError ? 'error' : undefined);
    projector.ingest({
      type: 'turn_end',
      ...(reason !== undefined ? { terminalReason: reason } : {}),
    });
  };
  /** Open a fresh window for runtime-initiated continuation work (DOR-1100). */
  const reopenTurn = (): void => {
    turnOpen = true;
    terminalReason = undefined;
    sawError = false;
    // `origin: 'runtime'` and no `userMessage`: nobody asked for this one, the
    // agent woke itself up. Both projections read that field to keep a window
    // nobody asked for from spending a sign-in card's grace, sounding the
    // turn-finished notification twice, or blanking the reply just produced.
    const reopened: RawOf<'turn_start'> = { type: 'turn_start', origin: 'runtime' };
    projector.ingest(reopened);
  };
  try {
    for await (const event of events) {
      const raw = toRawSessionEvent(event);
      // Checked BEFORE the latches below so the reopen's reset cannot be undone
      // by the very event that caused it (content events carry neither a
      // terminal reason nor an error, so this is belt-and-braces).
      if (!turnOpen && TURN_REOPENING_STREAM_EVENT_TYPES.has(event.type)) reopenTurn();
      const reason = readTerminalReason(event);
      if (reason !== undefined) terminalReason = reason;
      if (event.type === 'error') sawError = true;
      if (event.type === 'done') {
        closeTurn();
        continue;
      }
      if (raw !== null) projector.ingest(raw);
    }
  } finally {
    // The end of the stream is the end of the runtime's process, so anything it
    // still reports as running has stopped being OBSERVABLE. Retire each
    // stranded child with a terminal `subagent_update` BEFORE the close, so the
    // updates ride inside the last window (persisted with it), every consumer
    // drains through the same event it would have drained through anyway, and
    // the turn settles with an honest zero.
    //
    // The stream, not the turn, is the right boundary — verified in the
    // claude-code runtime rather than assumed. `executeSdkQuery` releases stdin
    // at the `result` and keeps reading, so the subprocess stays alive exactly
    // as long as it has queued background work to drain; that is what lets a
    // finished task wake the agent for another window in the first place. When
    // the iterator finally ends the process is gone, and no `task_notification`
    // can ever follow. The same holds for the paths that end a stream early — a
    // stop escalating to `query.close()`, a crash, an abandoned generator —
    // which is why this is one sweep at the end rather than a special case per
    // terminal reason. Without it the count is a permanent on-screen lie:
    // nothing else would ever clear it.
    //
    // ## Why `untracked` and not `stopped` (DOR-1108)
    //
    // This sweep used to declare every swept child STOPPED, on the reasoning
    // that the process hosting it had exited. That reasoning is one case short.
    // A subagent does live inside the CLI process and does die with it — but a
    // child the agent DETACHED does not: a `nohup`'d dev server started as a
    // background task is still serving long after the turn, the CLI, and the
    // session are over. DorkOS cannot observe either kind once the stream ends,
    // so it cannot tell them apart, and `stopped` asserted a death for both.
    //
    // `untracked` is the strongest claim the evidence supports: DorkOS lost
    // sight of this child. It is terminal in every way `stopped` was — it leaves
    // the running count, it retires the row — and it stops the product saying
    // something it does not know. Actually WATCHING a detached child is not this
    // fix's job and is not attempted here; the persistent-session pump (spec
    // `persistent-session-runtime`, P3) owns child lifecycle.
    //
    // It sweeps the SESSION's children, not this stream's, so it depends on one
    // stream per session at a time — the single-flight guarantee `sendMessage`
    // has always claimed and that DOR-1088 / PR #906 actually enforce (turn
    // serialization plus a lock that refuses any live holder). If two streams
    // ever ran concurrently on one session, whichever finished first would
    // retire the other's live children. The persistent pump keeps this correct
    // for a different reason: its stream spans every turn, so the `finally` is
    // the pump dying, which is still exactly when it stops being able to see
    // them.
    for (const taskId of projector.listRunningSubagents()) {
      const untracked: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId,
        status: 'untracked',
      };
      projector.ingest(untracked);
    }
    // Defensive: a stream that ends with a window still open — no `done` at all,
    // or a reopened continuation the runtime never terminated — still closes it
    // so the projection does not stay `streaming` forever.
    closeTurn();
  }
}
