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
 * status/todo/subagent/hook/memory/turn), runtime-neutral, and carries the
 * projector-stamped `seq`. Transient `StreamEvent`s with no durable projection
 * (sync/presence, relay receipts, raw context-usage) map to `null` and are
 * dropped.
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

    // A transient operational status (e.g. "Compacting context…") and the
    // compaction resolution. Drives the client status strip and the failed-
    // compaction error surface; forward only the fields present.
    case 'system_status': {
      const status: RawOf<'system_status'> = {
        type: 'system_status',
        message: String(data.message ?? ''),
        ...(data.status !== undefined ? { status: String(data.status) } : {}),
        ...(data.compactResult !== undefined
          ? { compactResult: data.compactResult as RawOf<'system_status'>['compactResult'] }
          : {}),
        ...(data.compactError !== undefined ? { compactError: String(data.compactError) } : {}),
      };
      return status;
    }

    // A pending interaction was cancelled WITHOUT an operator action (SDK
    // abort — e.g. a mid-turn steer superseding a pending question — or
    // timeout). Projects to the same `interaction_resolved` member the
    // operator paths use, so every consumer drops the card identically.
    case 'interaction_cancelled': {
      const resolved: RawOf<'interaction_resolved'> = {
        type: 'interaction_resolved',
        id: String(data.interactionId ?? ''),
        resolution: 'cancelled',
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
 * Drive a single triggered turn through the projector: emit `turn_start`,
 * normalize and ingest each `StreamEvent`, then emit `turn_end` when the turn's
 * `done` event arrives (or when the stream ends without one). The last-seen
 * `terminalReason` (carried on `session_status`/`done`) is attached to
 * `turn_end`.
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
 */
export async function feedProjector(
  projector: SessionStateProjector,
  events: AsyncIterable<StreamEvent>,
  opts: { userMessage?: string } = {}
): Promise<void> {
  const start: RawOf<'turn_start'> = {
    type: 'turn_start',
    ...(opts.userMessage !== undefined ? { userMessage: opts.userMessage } : {}),
  };
  projector.ingest(start);
  let terminalReason: TerminalReason | undefined;
  let ended = false;
  try {
    for await (const event of events) {
      const reason = readTerminalReason(event);
      if (reason !== undefined) terminalReason = reason;
      if (event.type === 'done') {
        projector.ingest({
          type: 'turn_end',
          ...(terminalReason !== undefined ? { terminalReason } : {}),
        });
        ended = true;
        continue;
      }
      const raw = toRawSessionEvent(event);
      if (raw !== null) projector.ingest(raw);
    }
  } finally {
    // Defensive: a stream that ends without an explicit `done` still closes the
    // turn so the projection does not stay `streaming` forever.
    if (!ended) {
      projector.ingest({
        type: 'turn_end',
        ...(terminalReason !== undefined ? { terminalReason } : {}),
      });
    }
  }
}
