/**
 * Pure projection from the runtime-neutral session contract (spec
 * chat-stream-reconnection) into the renderer's {@link ChatMessage}/{@link MessagePart}
 * shapes.
 *
 * The per-session stream store (`entities/session/session-stream-store`) holds the
 * server-derived projection: completed `messages` plus the `inProgressTurn` as a
 * flat list of {@link SessionEvent}s. The renderer, however, consumes
 * {@link ChatMessage}s whose assistant bubble is a `MessagePart[]`. This module
 * folds the in-progress turn's events into that part list and assembles the
 * trailing assistant `ChatMessage`, mirroring the OLD `StreamEvent` pipeline's
 * `deriveFromParts` / tool-handler logic so the output is byte-for-byte the shape
 * `widgets/session`'s `SessionMessage` / `AssistantMessageContent` already render.
 *
 * It is PURE (no React, no store) so it is trivially unit-testable and can be
 * memoized in the chat hooks.
 *
 * @module features/chat/model/stream/project-session-turn
 */
import type {
  HistoryMessage,
  HookPart,
  MessagePart,
  PendingInteractionDTO,
} from '@dorkos/shared/types';
import {
  approvalOutcomeOf,
  questionOutcomeOf,
  type InteractionResolvedEvent,
  type SessionEvent,
} from '@dorkos/shared/session-stream';
import type { ChatMessage } from '../chat-types';
import { deriveFromParts } from './stream-event-helpers';
import { mapHistoryMessage } from './stream-history-helpers';
import { foldCapabilityApproval, foldCapabilityApprovalResolved } from './capability-approval-fold';
import { foldMcpSignin, foldMcpSigninResolved } from './mcp-signin-fold';

/** Stable id for the synthesized trailing in-progress assistant bubble. */
const IN_PROGRESS_ASSISTANT_ID = '__in_progress_turn__';

/** Stable id for the optimistic user message bubble (bridges the send→reconcile gap). */
const OPTIMISTIC_USER_ID = '__optimistic_user__';

/** Build the synthetic optimistic user {@link ChatMessage}. */
function buildOptimisticUserMessage(content: string): ChatMessage {
  return {
    id: OPTIMISTIC_USER_ID,
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: '',
    _streaming: true,
  };
}

/**
 * Build the inline user bubble for a steer (`turn_input`).
 *
 * A steer JOINED the running turn — it did not open one — so it renders as an
 * ordinary user message at the point it arrived, keyed by its server-minted
 * `messageId` so the bubble is stable across re-renders and replays. It carries
 * `_streaming` because it is a live-turn synthetic: at `turn_end` the canonical
 * history reload replaces it (claude-code's own JSONL records the steered input,
 * and a log-backed runtime rebuilds it from the persisted `turn_input`), so this
 * only bridges the gap until then.
 */
function buildSteerUserMessage(event: Extract<SessionEvent, { type: 'turn_input' }>): ChatMessage {
  return {
    id: `steer-${event.messageId}`,
    role: 'user',
    content: event.content,
    parts: [{ type: 'text', text: event.content }],
    timestamp: '',
    _streaming: true,
  };
}

/**
 * Build the quiet note for a staged message (`context_staged`).
 *
 * A stage did NOT steer the agent — it added context for the next turn without
 * cutting into this one — so it must not read as a message the agent replied to.
 * It renders as a quiet transcript entry (`_stagedContext`), keyed by its
 * server-minted `messageId` so it is stable across re-renders and replays, and
 * carries `_streaming` because it is a live-turn synthetic: the post-turn history
 * reload replaces it with whatever the runtime's own transcript recorded.
 */
function buildStagedContextMessage(
  event: Extract<SessionEvent, { type: 'context_staged' }>
): ChatMessage {
  return {
    id: `staged-${event.messageId}`,
    role: 'user',
    content: event.content,
    parts: [{ type: 'text', text: event.content }],
    timestamp: '',
    _streaming: true,
    _stagedContext: true,
  };
}

/** Find the last `tool_call` part matching `toolCallId`, or `undefined`. */
function findToolCallPart(
  parts: MessagePart[],
  toolCallId: string
): Extract<MessagePart, { type: 'tool_call' }> | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'tool_call' && part.toolCallId === toolCallId) return part;
  }
  return undefined;
}

/** Find the last `elicitation` part matching `interactionId`, or `undefined`. */
function findElicitationPart(
  parts: MessagePart[],
  interactionId: string
): Extract<MessagePart, { type: 'elicitation' }> | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'elicitation' && part.interactionId === interactionId) return part;
  }
  return undefined;
}

/** Find the last `background_task` part matching `taskId`, or `undefined`. */
function findBackgroundTaskPart(
  parts: MessagePart[],
  taskId: string
): Extract<MessagePart, { type: 'background_task' }> | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'background_task' && part.taskId === taskId) return part;
  }
  return undefined;
}

/** Append a `text_delta` onto the trailing text part, coalescing consecutive deltas. */
function foldTextDelta(parts: MessagePart[], event: Extract<SessionEvent, { type: 'text_delta' }>) {
  // Assistant text means the thinking phase is over — finalize any streaming
  // thinking block so it auto-collapses (mirrors the legacy handler).
  finalizeStreamingThinking(parts);
  const last = parts[parts.length - 1];
  if (last && last.type === 'text') {
    last.text += event.text;
  } else {
    parts.push({ type: 'text', text: event.text });
  }
}

/** Coalesce a `thinking_delta` onto the trailing thinking part (mirrors the legacy handler). */
function foldThinkingDelta(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'thinking_delta' }>
) {
  const last = parts[parts.length - 1];
  if (last && last.type === 'thinking' && last.isStreaming) {
    last.text += event.text;
  } else {
    parts.push({ type: 'thinking', text: event.text, isStreaming: true });
  }
}

/**
 * Mark any still-streaming thinking part finished. The event stream carries no
 * timestamps, so `elapsedMs` is omitted — the block renders without a duration
 * until the post-turn history reload supplies the canonical part.
 */
function finalizeStreamingThinking(parts: MessagePart[]) {
  for (const part of parts) {
    if (part.type === 'thinking' && part.isStreaming) part.isStreaming = false;
  }
}

/**
 * Upsert a `tool_call` event onto its part. The adapter's `tool_call_start` AND
 * each streamed `input_json_delta` fragment all normalize to `tool_call`, so a
 * repeat for a known id APPENDS its input fragment to the existing part (legacy
 * `handleToolCallDelta` parity) — pushing per event would render one duplicate
 * tool part per fragment. The two adapter input sources (streamed fragments vs
 * the whole-input fallback on the assistant message) are mutually exclusive, so
 * appending never doubles the input. The first fold attaches any hooks that
 * arrived before the part existed.
 */
function foldToolCall(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'tool_call' }>,
  orphanHooks: Map<string, HookPart[]>
) {
  const existing = findToolCallPart(parts, event.toolCallId);
  if (existing) {
    if (event.input !== undefined) existing.input = (existing.input ?? '') + event.input;
    return;
  }
  const buffered = orphanHooks.get(event.toolCallId);
  orphanHooks.delete(event.toolCallId);
  parts.push({
    type: 'tool_call',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input ?? '',
    status: event.status,
    ...(buffered && buffered.length > 0 ? { hooks: buffered } : {}),
  });
}

/** Merge a `tool_result` event onto its matching `tool_call` part (creating one if missing). */
function foldToolResult(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'tool_result' }>
) {
  const existing = findToolCallPart(parts, event.toolCallId);
  if (existing) {
    existing.result = event.result;
    existing.status = event.status;
    // MCP App reference (SEP-1865) arrives on the terminal result — carry it so
    // the inline App renderer activates (spec mcp-apps-host §2.3).
    if (event.ui !== undefined) existing.ui = event.ui;
    // The terminal result supersedes any streamed progress output (legacy parity).
    if (event.result !== undefined) existing.progressOutput = undefined;
  } else {
    parts.push({
      type: 'tool_call',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input ?? '',
      result: event.result,
      status: event.status,
      ...(event.ui !== undefined ? { ui: event.ui } : {}),
    });
  }
}

/** Append a `tool_progress` delta to its tool part's live progress output. */
function foldToolProgress(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'tool_progress' }>
) {
  const existing = findToolCallPart(parts, event.toolCallId);
  if (existing) {
    existing.progressOutput = (existing.progressOutput ?? '') + event.content;
  }
  // Unknown toolCallId: drop (mirrors the legacy handler's warn-and-skip).
}

/** Upsert the approval fields onto the matching `tool_call` part (mirrors `handleApprovalRequired`). */
function foldApproval(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'approval_required' }>
) {
  const approvalFields = {
    interactiveType: 'approval' as const,
    input: event.input,
    status: 'pending' as const,
    // The countdown and its draining bar are both gated on `timeoutMs`: the
    // card renders without a deadline anywhere on it when the emission omits
    // one, which is exactly what production did before DOR-810.
    timeoutMs: event.timeoutMs,
    approvalStartedAt: event.startedAt,
    approvalRemainingMs: event.remainingMs,
    approvalTitle: event.title,
    approvalDisplayName: event.displayName,
    approvalDescription: event.description,
    approvalBlockedPath: event.blockedPath,
    approvalDecisionReason: event.decisionReason,
    approvalHasSuggestions: event.hasSuggestions,
  };
  const existing = findToolCallPart(parts, event.id);
  if (existing) {
    Object.assign(existing, approvalFields);
  } else {
    parts.push({
      type: 'tool_call',
      toolCallId: event.id,
      toolName: event.toolName,
      ...approvalFields,
    });
  }
}

/** Upsert the question fields onto the matching `tool_call` part (mirrors `handleQuestionPrompt`). */
function foldQuestion(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'question_prompt' }>
) {
  const existing = findToolCallPart(parts, event.id);
  const countdownFields = {
    approvalStartedAt: event.startedAt,
    approvalRemainingMs: event.remainingMs,
  };
  if (existing) {
    existing.interactiveType = 'question';
    existing.questions = event.questions;
    existing.status = 'pending';
    Object.assign(existing, countdownFields);
  } else {
    parts.push({
      type: 'tool_call',
      toolCallId: event.id,
      toolName: 'AskUserQuestion',
      input: '',
      status: 'pending',
      interactiveType: 'question',
      questions: event.questions,
      ...countdownFields,
    });
  }
}

/** Upsert an `elicitation` part for an `elicitation_prompt` event (mirrors `handleElicitationPrompt`). */
function foldElicitation(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'elicitation_prompt' }>
) {
  const elicitationFields = {
    serverName: event.serverName,
    message: event.message,
    mode: event.mode,
    url: event.url,
    elicitationId: event.elicitationId,
    requestedSchema: event.requestedSchema,
    status: 'pending' as const,
    startedAt: event.startedAt,
    remainingMs: event.remainingMs,
  };
  const existing = findElicitationPart(parts, event.id);
  if (existing) {
    Object.assign(existing, elicitationFields);
  } else {
    parts.push({ type: 'elicitation', interactionId: event.id, ...elicitationFields });
  }
}

/** The resolution kinds an interaction can settle with. */
type InteractionResolution = NonNullable<InteractionResolvedEvent['resolution']>;

/** The settled tool-part status for a resolution outcome. */
function resolvedToolStatus(
  resolution: InteractionResolution | undefined
): 'running' | 'complete' | 'error' {
  if (resolution === 'denied') return 'error';
  // Expired / cancelled (no operator action): the gated tool never ran and no
  // real tool_result is guaranteed to follow — settle as error.
  if (resolution === 'expired' || resolution === 'cancelled') return 'error';
  if (resolution === 'answered') return 'complete';
  // Approved (or unknown): the tool is now executing; the following
  // tool_result event carries the real terminal status.
  return 'running';
}

/**
 * Settle the pending state on the part matching a resolved interaction, and —
 * for an approval — record HOW it was answered.
 *
 * Settling is needed for parts folded from snapshot-carried interaction EVENTS
 * (which set `interactiveType` directly): removing the pending DTO alone cannot
 * un-pend those, so without it a resolved card kept rendering with a dead
 * countdown. The recorded outcome is what gives the answered card its
 * afterlife: it lives on the projected part, not in component state, so every
 * consumer of the same event stream — a re-render, another window, a replay
 * from `Last-Event-ID`, a cold snapshot carrying the turn — reconstructs the
 * identical receipt.
 */
function foldInteractionResolved(parts: MessagePart[], event: InteractionResolvedEvent) {
  const toolCall = findToolCallPart(parts, event.id);
  if (toolCall) {
    if (toolCall.status === 'pending') {
      toolCall.status = resolvedToolStatus(event.resolution);
      toolCall.approvalRemainingMs = undefined;
    }
    // `approvalOutcomeOf` is the one definition of what a resolution earns,
    // shared with the server's history derivation so a reopened session
    // rebuilds the identical line. It insists the server SAY this was an
    // approval: all three kinds share a cancellation path, so a timed-out
    // question resolves `expired` exactly as a timed-out permission prompt
    // does — and AskUserQuestion is an ordinary tool_use block, so it has a
    // real tool_call part under the same id for this to land on. Reading the
    // kind out of the resolution printed "Expired — denied" over questions.
    const outcome = approvalOutcomeOf(event);
    if (outcome) {
      // Tagging the part is the point of doing this here: on the live path
      // `approval_required` never enters the turn (it arrives as a pending DTO
      // that this event retires), so by the time the answer lands the part is a
      // bare tool_call with nothing marking it as gated. Deliberately NOT gated
      // on `status === 'pending'`: an approval whose tool_result raced ahead of
      // its resolution still earns its receipt.
      toolCall.interactiveType = 'approval';
      toolCall.approvalOutcome = outcome;
      toolCall.approvalResolvedAt = event.at;
      // Only the server can say a reason reached the agent, so the receipt's
      // claim is copied from the resolution and never inferred here. An
      // `expired` auto-deny never carries it: the clock explained nothing.
      if (event.reasonGiven === true) toolCall.approvalReasonGiven = true;
      // The live path also loses `startedAt` with the DTO, so prefer the
      // server's backfill and fall back to whatever the part already holds.
      toolCall.approvalStartedAt = event.startedAt ?? toolCall.approvalStartedAt;
    }
    // A question's ending, by the same rule and for the same reason: the
    // resolution alone cannot say which kind it retired, and until this was
    // recorded a question that expired or was withdrawn kept every visible
    // property of one that had been answered — no answers, no longer pending —
    // so the renderer drew "Question answered" over it (DOR-1293).
    const questionOutcome = questionOutcomeOf(event);
    if (questionOutcome) toolCall.questionOutcome = questionOutcome;
  }
  const elicitation = findElicitationPart(parts, event.id);
  if (elicitation && elicitation.status === 'pending') {
    elicitation.status = 'submitted';
    elicitation.remainingMs = undefined;
  }
}

/** Find a hook by id across all tool parts' attached hook lists, or `undefined`. */
function findHookById(parts: MessagePart[], hookId: string): HookPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'tool_call' && part.hooks) {
      const hook = part.hooks.find((h) => h.hookId === hookId);
      if (hook) return hook;
    }
  }
  return undefined;
}

/** Find a hook by id in the orphan buffer (hooks whose tool part has not folded yet). */
function findOrphanHookById(
  orphanHooks: Map<string, HookPart[]>,
  hookId: string
): HookPart | undefined {
  for (const hooks of orphanHooks.values()) {
    const hook = hooks.find((h) => h.hookId === hookId);
    if (hook) return hook;
  }
  return undefined;
}

/**
 * Merge a `hook_update` onto its hook (attached to a tool part or still
 * orphan-buffered), or create one under its tool part. A `hook_started` can
 * precede its `tool_call` event, so a hook with no matching tool part buffers
 * in `orphanHooks` for {@link foldToolCall} to drain (legacy parity). Updates
 * merge field-wise: progress replaces the cumulative stdout/stderr, the
 * terminal update settles status/exitCode. Session-level hooks (no
 * `toolCallId`) have no renderable part and are dropped, as in the legacy
 * pipeline.
 */
function foldHookUpdate(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'hook_update' }>,
  orphanHooks: Map<string, HookPart[]>
) {
  const existing =
    findHookById(parts, event.hookId) ?? findOrphanHookById(orphanHooks, event.hookId);
  if (existing) {
    existing.status = event.status;
    if (event.hookName !== undefined) existing.hookName = event.hookName;
    if (event.stdout !== undefined) existing.stdout = event.stdout;
    if (event.stderr !== undefined) existing.stderr = event.stderr;
    if (event.exitCode !== undefined) existing.exitCode = event.exitCode;
    return;
  }
  if (!event.toolCallId) return; // session-level hook — no renderable part
  const hook: HookPart = {
    hookId: event.hookId,
    hookName: event.hookName ?? '',
    hookEvent: event.hookEvent ?? '',
    status: event.status,
    stdout: event.stdout ?? '',
    stderr: event.stderr ?? '',
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };
  const toolCall = findToolCallPart(parts, event.toolCallId);
  if (toolCall) {
    toolCall.hooks = [...(toolCall.hooks ?? []), hook];
  } else {
    orphanHooks.set(event.toolCallId, [...(orphanHooks.get(event.toolCallId) ?? []), hook]);
  }
}

/**
 * Upsert the turn's `memory_recall` part, pinned at index 0 (mirrors the legacy
 * `upsertMemoryRecallPart`). First-writer-wins per memory path: the SDK pairs
 * path ↔ content 1:1 per turn, so a duplicate path can only be a replay.
 */
function foldMemoryRecall(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'memory_recall' }>
) {
  const existing = parts[0];
  if (existing && existing.type === 'memory_recall') {
    const existingPaths = new Set(existing.memories.map((m) => m.path));
    const fresh = event.memories.filter((m) => !existingPaths.has(m.path));
    if (fresh.length > 0) existing.memories = [...existing.memories, ...fresh];
    return;
  }
  const seen = new Set<string>();
  const deduped = event.memories.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
  parts.unshift({ type: 'memory_recall', mode: event.mode, memories: deduped, isStreaming: true });
}

/**
 * Fold a `compact_boundary` event into an inline compaction row part (success).
 * Appended at the current tail — the event stream carries no positional anchor,
 * so for a mid-turn auto-compaction the row sits after the text streamed so far
 * rather than at its exact byte position. Manual `/compact` runs between turns,
 * where the tail IS the correct position.
 */
function foldCompactBoundary(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'compact_boundary' }>
) {
  parts.push({
    type: 'compact_boundary',
    ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
    ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
    ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  });
}

/**
 * Fold an `operation_progress` event. A successful compaction renders its inline
 * row from `compact_boundary`; a FAILED compaction fires NO boundary, so its only
 * durable signal is `operation_progress` `{ operation: 'compaction', state:
 * 'failed' }` — surface that inline as a failed compaction row (DOR-110). The
 * `started`/`done` phases drive the transient status strip via
 * `useSystemStatusEvents`, not the bubble, so they produce no part here.
 */
function foldOperationProgress(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'operation_progress' }>
) {
  if (event.operation !== 'compaction' || event.state !== 'failed') return;
  parts.push({
    type: 'compact_boundary',
    failed: true,
    ...(event.error !== undefined ? { error: event.error } : {}),
  });
}

/**
 * Fold a typed `error` event into an inline error part, ending any streaming
 * thinking block first (an error terminates the thinking phase the same way
 * assistant text does — see {@link foldTextDelta}). A live typed error now
 * renders the inline `ErrorMessageBlock` for every runtime, and
 * `shouldShowTurnFailedNotice` auto-suppresses the redundant panel notice when
 * the turn's tail contains an error part.
 *
 * `ErrorPart` carries no `code` field, so a code is folded into the details
 * string (prefixed `[code]`) rather than dropped — the exact format the
 * server's `event-log-history.ts` uses, so the live part matches the
 * post-turn history reload byte-for-byte.
 */
function foldError(parts: MessagePart[], event: Extract<SessionEvent, { type: 'error' }>) {
  finalizeStreamingThinking(parts);
  const details =
    event.code !== undefined
      ? event.details !== undefined
        ? `[${event.code}] ${event.details}`
        : `[${event.code}]`
      : event.details;
  parts.push({
    type: 'error',
    message: event.message,
    ...(event.category !== undefined ? { category: event.category } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

/** Upsert a `background_task` part for a `subagent_update` event (mirrors the subagent handlers). */
function foldSubagent(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'subagent_update' }>
) {
  const existing = findBackgroundTaskPart(parts, event.taskId);
  if (existing) {
    existing.status = event.status;
    if (event.description !== undefined) existing.description = event.description;
    if (event.toolUses !== undefined) existing.toolUses = event.toolUses;
    if (event.lastToolName !== undefined) existing.lastToolName = event.lastToolName;
    if (event.summary !== undefined) existing.summary = event.summary;
  } else {
    parts.push({
      type: 'background_task',
      taskId: event.taskId,
      taskType: 'agent',
      status: event.status,
      startedAt: 0,
      description: event.description,
      toolUses: event.toolUses,
      lastToolName: event.lastToolName,
      summary: event.summary,
    });
  }
}

/**
 * Maps a {@link PendingInteractionDTO} `type` to its interaction
 * {@link SessionEvent} `type`. The DTO and the live interaction event carry the
 * same fields (id, timer, type-specific payload) under different `type`
 * discriminants (e.g. DTO `approval` ↔ event `approval_required`); this is the
 * inverse of the store's `interactionEventToDTO` re-tag.
 */
const DTO_TO_INTERACTION_EVENT_TYPE = {
  approval: 'approval_required',
  question: 'question_prompt',
  elicitation: 'elicitation_prompt',
} as const;

/** Interaction `SessionEvent` members (the three recoverable interaction kinds). */
type InteractionEvent = Extract<
  SessionEvent,
  { type: 'approval_required' | 'question_prompt' | 'elicitation_prompt' }
>;

/**
 * Re-tag a {@link PendingInteractionDTO} as the matching interaction
 * {@link SessionEvent} so it can flow through the existing `fold*` handlers and
 * produce the SAME pending part shape the live `approval_required` /
 * `question_prompt` / `elicitation_prompt` events produce. A synthetic non-real
 * `seq` of `0` is attached — the fold handlers ignore `seq`, and these recovered
 * DTOs never advance the store watermark.
 */
function pendingInteractionToEvent(dto: PendingInteractionDTO): InteractionEvent {
  const { type, ...rest } = dto;
  return { ...rest, seq: 0, type: DTO_TO_INTERACTION_EVENT_TYPE[type] } as InteractionEvent;
}

/**
 * Whether `parts` already carries an INTERACTION representation for the id — a
 * tool_call part folded WITH its interaction fields, or an elicitation part.
 *
 * A BARE tool_call part with the same id does NOT count: during a live turn the
 * `tool_call` event precedes `approval_required` (which lands only in
 * `pendingInteractions`), so the bare part must still have the approval fields
 * upserted onto it — treating it as "already represented" suppressed the
 * Approve/Deny card for every live approval (CLI-C1).
 */
function partsContainInteraction(parts: MessagePart[], interactionId: string): boolean {
  const toolCall = findToolCallPart(parts, interactionId);
  if (toolCall?.interactiveType !== undefined) return true;
  return findElicitationPart(parts, interactionId) !== undefined;
}

/** Dispatch a recovered interaction event onto the right `fold*` handler. */
function foldPendingInteraction(parts: MessagePart[], event: InteractionEvent): void {
  switch (event.type) {
    case 'approval_required':
      foldApproval(parts, event);
      break;
    case 'question_prompt':
      foldQuestion(parts, event);
      break;
    case 'elicitation_prompt':
      foldElicitation(parts, event);
      break;
  }
}

/**
 * Re-assert the hold on an already-represented interaction, and give it the
 * snapshot's countdown.
 *
 * THE ONLY FRESH TIMER IN THE PAYLOAD. A replayed `approval_required` carries
 * the remainder it had at EMISSION — which for a live ask is the whole budget —
 * so a card rebuilt from the turn alone jumps back to the start of its
 * countdown on every reload, every second window, and every replay from
 * `Last-Event-ID`. The pending DTO's `remainingMs` is computed when the
 * snapshot is built, so it is the one number that is true now (DOR-810).
 *
 * The STATUS is re-asserted for a different reason, and it is what makes a
 * parked prompt survive a refresh at all (DOR-1269). A DTO exists only while
 * the server is still waiting: the projector drops it the moment
 * `interaction_resolved` folds. So its presence is the authority on this
 * interaction being unanswered, and nothing the turn's replay left behind may
 * overrule it. The replay routinely does: a cold snapshot's `inProgressTurn`
 * carries the interaction event itself (the LIVE store deliberately does not —
 * it routes those three straight to `pendingInteractions`), so on the cold path
 * `foldApproval`/`foldQuestion` pend the part mid-turn, and the `tool_result`
 * that claude-code emits when the model finishes STREAMING the tool's input —
 * `content_block_stop` → `tool_call_end`, long before the gated tool runs —
 * then overwrote `pending` with `complete`. The card became an answered receipt
 * over a question nobody had answered, and the pending scan that drives the
 * composer's answer panel (`status === 'pending'`) went blind, so there was no
 * way left to answer it.
 *
 * TWO THINGS OUTRANK THE DTO, and both are the same rule
 * {@link foldInteractionResolved} applies with its own `status === 'pending'`
 * guard: an answer the turn already carries, and a result the tool already
 * produced. A DTO can outlive either by a beat — the snapshot is a copy taken
 * at one instant — and re-pending on top of one draws an Approve/Deny card over
 * an edit that has already been applied. So the hold is re-asserted only when
 * nothing in the turn says otherwise.
 *
 * The elicitation branch takes the countdown and nothing else. Its status has
 * exactly two writers — `foldElicitation` (pending) and
 * {@link foldInteractionResolved} (submitted) — and no `tool_result` can reach
 * an elicitation part, so there is no un-pending to undo and the only thing a
 * re-assert could do is resurrect a form somebody has already submitted.
 *
 * @param parts - The trailing segment's parts (mutated in place).
 * @param dto - The interaction the snapshot still reports as unanswered.
 * @param settledInTurn - Whether the turn already folded an
 *   `interaction_resolved` for this id.
 */
function applyRecoveredHold(
  parts: MessagePart[],
  dto: PendingInteractionDTO,
  settledInTurn: boolean
): void {
  const toolCall = findToolCallPart(parts, dto.id);
  if (toolCall) {
    if (!settledInTurn && toolCall.result === undefined) toolCall.status = 'pending';
    toolCall.approvalStartedAt = dto.startedAt;
    toolCall.approvalRemainingMs = dto.remainingMs;
    // Only when the DTO actually declares a budget: absent means "this runtime
    // did not say", not "no deadline", so clearing one the turn supplied would
    // take the countdown away rather than correct it.
    if (dto.type === 'approval' && dto.timeoutMs !== undefined) toolCall.timeoutMs = dto.timeoutMs;
    return;
  }
  const elicitation = findElicitationPart(parts, dto.id);
  if (elicitation) {
    elicitation.startedAt = dto.startedAt;
    elicitation.remainingMs = dto.remainingMs;
  }
}

/**
 * Fold any snapshot-authoritative pending interactions onto the part list.
 *
 * An interaction the turn does not represent is folded whole — this is what
 * surfaces a session still `blocked` after `turn_end`, whose `inProgressTurn`
 * was cleared (DOR-73 recovery). An interaction present in BOTH keeps the
 * turn's part (which owns the live ordering) and takes the DTO's hold and
 * countdown, via {@link applyRecoveredHold}.
 *
 * @param parts - Parts folded from the in-progress turn (mutated in place).
 * @param pendingInteractions - The snapshot's recoverable pending interactions.
 * @param settledIds - Interaction ids the turn already resolved. Read from the
 *   WHOLE turn rather than this segment, because a steer can split the two
 *   apart and an answer is an answer wherever in the turn it landed.
 */
function foldPendingInteractions(
  parts: MessagePart[],
  pendingInteractions: PendingInteractionDTO[],
  settledIds: ReadonlySet<string>
): void {
  for (const dto of pendingInteractions) {
    if (partsContainInteraction(parts, dto.id)) {
      applyRecoveredHold(parts, dto, settledIds.has(dto.id));
      continue;
    }
    foldPendingInteraction(parts, pendingInteractionToEvent(dto));
  }
}

/** The interaction ids an `interaction_resolved` in this turn already answered. */
function settledInteractionIds(events: SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === 'interaction_resolved') ids.add(event.id);
  }
  return ids;
}

/**
 * Fold the in-progress turn's {@link SessionEvent}s into the renderable
 * {@link MessagePart}[] for the trailing assistant bubble.
 *
 * `text_delta`s coalesce into text parts (finalizing any streaming thinking
 * block); `thinking_delta`s coalesce into a thinking part; `tool_call`/
 * `tool_result` pair onto a single tool-call part with `tool_progress` deltas
 * appended between them; the three interaction events surface as the same
 * pending tool-call / elicitation parts the live pipeline produces;
 * `subagent_update` maps to a `background_task` part; `hook_update`s attach to
 * their tool part (buffered when they precede it); `memory_recall` pins a
 * collapsible part at index 0; a typed `error` folds an inline error part (the
 * live `ErrorMessageBlock`, for every runtime). `turn_start`, `turn_end`,
 * `status_change`, and `todo_update` carry no renderable part and are skipped
 * (they drive the status/task projections, not the bubble).
 *
 * @param events - The store's `inProgressTurn` events, in seq order.
 * @returns The assistant bubble's message parts.
 */
export function projectInProgressTurn(events: SessionEvent[]): MessagePart[] {
  const parts: MessagePart[] = [];
  // Hooks whose tool_call event has not folded yet, keyed by toolCallId —
  // drained by foldToolCall when the part appears (pass-local, never escapes).
  const orphanHooks = new Map<string, HookPart[]>();
  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        foldTextDelta(parts, event);
        break;
      case 'thinking_delta':
        foldThinkingDelta(parts, event);
        break;
      case 'tool_call':
        foldToolCall(parts, event, orphanHooks);
        break;
      case 'tool_result':
        foldToolResult(parts, event);
        break;
      case 'tool_progress':
        foldToolProgress(parts, event);
        break;
      case 'approval_required':
        foldApproval(parts, event);
        break;
      case 'question_prompt':
        foldQuestion(parts, event);
        break;
      case 'elicitation_prompt':
        foldElicitation(parts, event);
        break;
      case 'capability_approval_required':
        foldCapabilityApproval(parts, event);
        break;
      case 'capability_approval_resolved':
        foldCapabilityApprovalResolved(parts, event);
        break;
      case 'mcp_signin_required':
        foldMcpSignin(parts, event);
        break;
      case 'mcp_signin_resolved':
        foldMcpSigninResolved(parts, event);
        break;
      case 'interaction_resolved':
        foldInteractionResolved(parts, event);
        break;
      case 'subagent_update':
        foldSubagent(parts, event);
        break;
      case 'hook_update':
        foldHookUpdate(parts, event, orphanHooks);
        break;
      case 'memory_recall':
        foldMemoryRecall(parts, event);
        break;
      case 'compact_boundary':
        foldCompactBoundary(parts, event);
        break;
      case 'operation_progress':
        foldOperationProgress(parts, event);
        break;
      case 'error':
        foldError(parts, event);
        break;
      // turn_start, turn_end, status_change, todo_update, system_status carry no
      // renderable part (system_status drives only the transient status strip).
      default:
        break;
    }
  }
  return parts;
}

/**
 * Build an in-progress assistant {@link ChatMessage} from the folded parts, or
 * `null` when the segment produced no renderable parts.
 *
 * @param parts - The folded message parts for this assistant segment.
 * @param id - The bubble id. The TRAILING segment keeps
 *   {@link IN_PROGRESS_ASSISTANT_ID}; a segment that precedes a steer gets a
 *   distinct id so the two bubbles reconcile independently.
 */
function buildInProgressMessage(parts: MessagePart[], id: string): ChatMessage | null {
  if (parts.length === 0) return null;
  const derived = deriveFromParts(parts);
  return {
    id,
    role: 'assistant',
    content: derived.content,
    toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : [],
    parts,
    timestamp: '',
    _streaming: true,
  };
}

/**
 * Fold the in-progress turn into rendered {@link ChatMessage}s, splitting it at
 * each person's mid-turn entry — a steer (`turn_input`) or a staged note
 * (`context_staged`) — so each renders in reading order rather than being folded
 * into the assistant bubble: a steer as an inline user bubble, a staged note as
 * a quiet transcript entry.
 *
 * With no such entry this is one assistant bubble, byte-for-byte the earlier
 * behaviour: the single trailing segment keeps {@link IN_PROGRESS_ASSISTANT_ID}
 * and takes the snapshot's pending interactions. With one the turn becomes
 * assistant-segment / entry / assistant-segment…: each run of assistant events
 * before an entry is its own bubble, the entry sits between them, and the
 * snapshot's pending interactions fold into the TRAILING segment — the one still
 * open — exactly as they did when the turn was one bubble.
 *
 * @param inProgressTurn - The in-progress turn's events, in seq order.
 * @param pendingInteractions - Snapshot's recoverable pending interactions.
 */
function projectInProgressSegments(
  inProgressTurn: SessionEvent[],
  pendingInteractions: PendingInteractionDTO[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let run: SessionEvent[] = [];
  let precedingSegments = 0;
  for (const event of inProgressTurn) {
    // Both a steer (`turn_input`) and a staged note (`context_staged`) arrive
    // mid-turn and split it: the run of assistant events before them closes as
    // its own bubble, then the person's entry renders in reading order — a user
    // bubble for a steer, a quiet note for a stage.
    if (event.type !== 'turn_input' && event.type !== 'context_staged') {
      run.push(event);
      continue;
    }
    // Close the assistant run that arrived before this entry as its own bubble.
    // No pending-interaction fold here — those belong to the turn's OPEN tail,
    // which is a later segment.
    const parts = projectInProgressTurn(run);
    const bubble = buildInProgressMessage(
      parts,
      `${IN_PROGRESS_ASSISTANT_ID}-${precedingSegments}`
    );
    if (bubble) out.push(bubble);
    precedingSegments += 1;
    out.push(
      event.type === 'turn_input' ? buildSteerUserMessage(event) : buildStagedContextMessage(event)
    );
    run = [];
  }
  // The trailing (open) segment: it takes the pending interactions and keeps the
  // stable trailing id, so a turn with no steer is identical to the old output.
  const parts = projectInProgressTurn(run);
  foldPendingInteractions(parts, pendingInteractions, settledInteractionIds(inProgressTurn));
  const trailing = buildInProgressMessage(parts, IN_PROGRESS_ASSISTANT_ID);
  if (trailing) out.push(trailing);
  return out;
}

/** Every `toolCallId` the live turn's own bubbles already speak for. */
function liveToolCallIds(segments: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of segments) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Whether a history tool part is a FINISHED-LOOKING BUT EMPTY record — the exact
 * shape the parked-prompt duplicate takes, and nothing else.
 *
 * A tool call that really ran and was really recorded always carries something
 * it produced: a `result`, the `answers` a question was given, the
 * `approvalOutcome` a permission ask settled with, or a `questionOutcome`
 * saying how the question ended. The DOR-1269 duplicate carries none of them,
 * because nothing has happened to it yet — the model has merely emitted the
 * `tool_use` block and the transcript parser stamped it `complete`.
 *
 * `questionOutcome: 'unresolved'` is the one value that does NOT count as
 * something produced, and it has to be excluded by name. It is the parked
 * prompt's own marker — "the transcript records no ending" is precisely the
 * duplicate's condition (DOR-1293) — so treating its presence as evidence of a
 * real record would put the duplicate card back, which is the whole of DOR-1269.
 * Every other value is a real ending and protects the record it sits on.
 *
 * This is what keeps {@link withoutEmptyDuplicateToolCalls} from eating a real
 * earlier call, which matters because tool-call ids are NOT unique across a
 * session: codex uses the raw SDK item id and starts a fresh thread per turn
 * (so turn 2 opens at `'0'` again), and the test-mode scenarios re-run with the
 * same literal ids on every turn. A log-backed question record is the sharpest
 * case: it is `{questions, questionOutcome}` with no `result` and no `answers`
 * (nothing in the event fold ever assigns them), so before `questionOutcome`
 * was counted here, an id collision deleted the very record this fix creates.
 */
function isEmptyFinishedToolCall(part: MessagePart): boolean {
  return (
    part.type === 'tool_call' &&
    part.result === undefined &&
    part.answers === undefined &&
    part.approvalOutcome === undefined &&
    (part.questionOutcome === undefined || part.questionOutcome === 'unresolved')
  );
}

/**
 * Drop the history copy of a tool call the live turn is still rendering.
 *
 * The two halves of the transcript can describe the SAME tool call at once, and
 * for a parked prompt they describe it differently (DOR-1269). claude-code
 * persists an assistant record the moment the model emits the `tool_use` block,
 * and the transcript parser stamps every such block `complete` — so while a
 * person is being asked, history already holds a finished-looking
 * `AskUserQuestion` with its questions and no answers, which renders as a green
 * "Question answered" line. Concatenating that with the live turn put the lie
 * directly above the card the person still has to answer.
 *
 * The LIVE part wins because it is the one that knows the call is still open:
 * it carries the hold, the countdown, and whatever the turn has streamed since.
 * History will speak for the call again on the next reload, once the turn it
 * belongs to has closed and stopped being replayed.
 *
 * NARROW ON PURPOSE, in two directions, because an id match ALONE is not
 * evidence of a duplicate. Tool-call ids repeat across turns on shipped runtimes
 * — codex passes the SDK's raw item id through and opens a new thread per turn,
 * so every turn starts counting at `'0'` again — so a wider rule would delete a
 * real, finished call from an earlier turn out of the transcript the moment the
 * new turn happened to reuse its id. The two guards are:
 *
 * 1. only an {@link isEmptyFinishedToolCall} part, and
 * 2. only within the trailing run of assistant records, the only ones the open
 *    turn can overlap (the caller enforces this).
 *
 * @param message - One mapped history message from that trailing run.
 * @param liveIds - Tool-call ids the in-progress turn already renders.
 * @returns The message without those parts, or `null` when nothing is left of it.
 */
function withoutEmptyDuplicateToolCalls(
  message: ChatMessage,
  liveIds: ReadonlySet<string>
): ChatMessage | null {
  const kept = message.parts.filter(
    (part) =>
      part.type !== 'tool_call' || !liveIds.has(part.toolCallId) || !isEmptyFinishedToolCall(part)
  );
  if (kept.length === message.parts.length) return message;
  if (kept.length === 0) return null;
  // `content`/`toolCalls` are derived from the parts, so they have to be
  // re-derived rather than carried over from the full list.
  const derived = deriveFromParts(kept);
  return {
    ...message,
    parts: kept,
    content: derived.content,
    toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : undefined,
  };
}

/**
 * Index of the first message in the trailing run of assistant records — the
 * only stretch of history the still-open turn can overlap.
 *
 * Anything before the last person's message belongs to a turn that has closed,
 * so a matching id there is a DIFFERENT call that happens to share a number.
 *
 * @param messages - Mapped history, in order.
 */
function trailingAssistantRun(messages: ChatMessage[]): number {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === 'assistant') start -= 1;
  return start;
}

/**
 * Project the per-session stream store's server state into the rendered
 * {@link ChatMessage}[]: completed history mapped via {@link mapHistoryMessage},
 * followed by the in-progress turn ({@link projectInProgressSegments}) — one
 * trailing assistant bubble, or, when a steer joined the turn, a sequence of
 * assistant bubbles with the steer's inline user bubble in reading order.
 *
 * The trailing bubble folds the in-progress turn's events AND any
 * snapshot-authoritative `pendingInteractions` not already represented by the
 * turn (dedup strictly by interaction id). This surfaces a recovered interaction
 * in the `blocked`-after-`turn_end` state, where the turn was cleared and the
 * interaction lives ONLY in `pendingInteractions` — without it, a refreshed
 * blocked session would show no Approve/Deny card (regressing DOR-73 recovery).
 *
 * History is then deduped AGAINST that turn, narrowly: an EMPTY finished-looking
 * copy of a tool call the live turn is still rendering, in the trailing
 * assistant run, is dropped so one call is one card
 * ({@link withoutEmptyDuplicateToolCalls}).
 *
 * Under the trigger-only POST contract the just-sent user message is NOT yet in
 * `snapshotMessages` (the snapshot was captured before the send, and the
 * `/events` stream carries no user-message event), so when an
 * `optimisticUserMessage` is supplied it is rendered AFTER history and BEFORE
 * the in-progress assistant bubble. The turn_end reconcile reloads canonical
 * history and clears it, so it only bridges the send→reconcile gap.
 *
 * @param snapshotMessages - Completed message history from the snapshot.
 * @param inProgressTurn - The in-progress turn's events (empty when idle).
 * @param pendingInteractions - Snapshot's recoverable pending interactions (ADR-0264).
 * @param optimisticUserMessage - The just-submitted user message, or `null`.
 * @returns The renderable message list.
 */
export function projectSessionMessages(
  snapshotMessages: HistoryMessage[],
  inProgressTurn: SessionEvent[],
  pendingInteractions: PendingInteractionDTO[] = [],
  optimisticUserMessage: { id: string; content: string } | null = null
): ChatMessage[] {
  // The turn is projected FIRST because history is deduped against it.
  const segments = projectInProgressSegments(inProgressTurn, pendingInteractions);
  const liveIds = liveToolCallIds(segments);
  const mapped = snapshotMessages.map(mapHistoryMessage);
  // Only the trailing assistant run is a dedup candidate — see
  // `withoutEmptyDuplicateToolCalls` for why an id match alone proves nothing.
  const dedupFrom = liveIds.size === 0 ? mapped.length : trailingAssistantRun(mapped);
  const messages: ChatMessage[] = [];
  for (const [index, message] of mapped.entries()) {
    const kept = index < dedupFrom ? message : withoutEmptyDuplicateToolCalls(message, liveIds);
    if (kept) messages.push(kept);
  }
  if (optimisticUserMessage) {
    messages.push(buildOptimisticUserMessage(optimisticUserMessage.content));
  }
  messages.push(...segments);
  return messages;
}
