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
 * `MessageItem`/`AssistantMessageContent` already render.
 *
 * It is PURE (no React, no store) so it is trivially unit-testable and can be
 * memoized in the chat hooks.
 *
 * @module features/chat/model/stream/project-session-turn
 */
import type { HistoryMessage, MessagePart, PendingInteractionDTO } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ChatMessage } from '../chat-types';
import { deriveFromParts } from './stream-event-helpers';
import { mapHistoryMessage } from './stream-history-helpers';

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
  const last = parts[parts.length - 1];
  if (last && last.type === 'text') {
    last.text += event.text;
  } else {
    parts.push({ type: 'text', text: event.text });
  }
}

/** Push a new `tool_call` part for a `tool_call` event. */
function foldToolCall(parts: MessagePart[], event: Extract<SessionEvent, { type: 'tool_call' }>) {
  parts.push({
    type: 'tool_call',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input ?? '',
    status: event.status,
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
  } else {
    parts.push({
      type: 'tool_call',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input ?? '',
      result: event.result,
      status: event.status,
    });
  }
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

/** The settled tool-part status for a resolution outcome. */
function resolvedToolStatus(
  resolution: 'approved' | 'denied' | 'answered' | undefined
): 'running' | 'complete' | 'error' {
  if (resolution === 'denied') return 'error';
  if (resolution === 'answered') return 'complete';
  // Approved (or unknown): the tool is now executing; the following
  // tool_result event carries the real terminal status.
  return 'running';
}

/**
 * Settle the pending state on the part matching a resolved interaction. Needed
 * for parts folded from snapshot-carried interaction EVENTS (which set
 * `interactiveType` directly): removing the pending DTO alone cannot un-pend
 * those, so without this a resolved card kept rendering with a dead countdown.
 */
function foldInteractionResolved(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'interaction_resolved' }>
) {
  const toolCall = findToolCallPart(parts, event.id);
  if (toolCall && toolCall.status === 'pending') {
    toolCall.status = resolvedToolStatus(event.resolution);
    toolCall.approvalRemainingMs = undefined;
  }
  const elicitation = findElicitationPart(parts, event.id);
  if (elicitation && elicitation.status === 'pending') {
    elicitation.status = 'submitted';
    elicitation.remainingMs = undefined;
  }
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
 * Fold any snapshot-authoritative pending interactions onto the part list,
 * skipping those already represented (the in-progress turn owns the live
 * ordering for an interaction present in BOTH). This surfaces an interaction
 * that lives ONLY in `pendingInteractions` — e.g. a session still `blocked`
 * after `turn_end`, whose `inProgressTurn` was cleared (DOR-73 recovery).
 *
 * @param parts - Parts folded from the in-progress turn (mutated in place).
 * @param pendingInteractions - The snapshot's recoverable pending interactions.
 */
function foldPendingInteractions(
  parts: MessagePart[],
  pendingInteractions: PendingInteractionDTO[]
): void {
  for (const dto of pendingInteractions) {
    if (partsContainInteraction(parts, dto.id)) continue;
    foldPendingInteraction(parts, pendingInteractionToEvent(dto));
  }
}

/**
 * Fold the in-progress turn's {@link SessionEvent}s into the renderable
 * {@link MessagePart}[] for the trailing assistant bubble.
 *
 * `text_delta`s coalesce into text parts; `tool_call`/`tool_result` pair onto a
 * single tool-call part; the three interaction events surface as the same
 * pending tool-call / elicitation parts the live pipeline produces;
 * `subagent_update` maps to a `background_task` part. `turn_start`, `turn_end`,
 * `status_change`, and `todo_update` carry no renderable part and are skipped
 * (they drive the status projection, not the bubble).
 *
 * @param events - The store's `inProgressTurn` events, in seq order.
 * @returns The assistant bubble's message parts.
 */
export function projectInProgressTurn(events: SessionEvent[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        foldTextDelta(parts, event);
        break;
      case 'tool_call':
        foldToolCall(parts, event);
        break;
      case 'tool_result':
        foldToolResult(parts, event);
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
      case 'interaction_resolved':
        foldInteractionResolved(parts, event);
        break;
      case 'subagent_update':
        foldSubagent(parts, event);
        break;
      // turn_start, turn_end, status_change, todo_update carry no renderable part.
      default:
        break;
    }
  }
  return parts;
}

/**
 * Build the trailing in-progress assistant {@link ChatMessage} from the folded
 * parts, or `null` when the turn produced no renderable parts.
 */
function buildInProgressMessage(parts: MessagePart[]): ChatMessage | null {
  if (parts.length === 0) return null;
  const derived = deriveFromParts(parts);
  return {
    id: IN_PROGRESS_ASSISTANT_ID,
    role: 'assistant',
    content: derived.content,
    toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : [],
    parts,
    timestamp: '',
    _streaming: true,
  };
}

/**
 * Project the per-session stream store's server state into the rendered
 * {@link ChatMessage}[]: completed history mapped via {@link mapHistoryMessage},
 * followed by the trailing in-progress assistant bubble.
 *
 * The bubble folds the in-progress turn's events AND any snapshot-authoritative
 * `pendingInteractions` not already represented by the turn (dedup strictly by
 * interaction id). This surfaces a recovered interaction in the
 * `blocked`-after-`turn_end` state, where the turn was cleared and the
 * interaction lives ONLY in `pendingInteractions` — without it, a refreshed
 * blocked session would show no Approve/Deny card (regressing DOR-73 recovery).
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
 * @param pendingInteractions - Snapshot's recoverable pending interactions (ADR-0262).
 * @param optimisticUserMessage - The just-submitted user message, or `null`.
 * @returns The renderable message list.
 */
export function projectSessionMessages(
  snapshotMessages: HistoryMessage[],
  inProgressTurn: SessionEvent[],
  pendingInteractions: PendingInteractionDTO[] = [],
  optimisticUserMessage: { id: string; content: string } | null = null
): ChatMessage[] {
  const messages = snapshotMessages.map(mapHistoryMessage);
  if (optimisticUserMessage) {
    messages.push(buildOptimisticUserMessage(optimisticUserMessage.content));
  }
  const parts = projectInProgressTurn(inProgressTurn);
  foldPendingInteractions(parts, pendingInteractions);
  const inProgress = buildInProgressMessage(parts);
  if (inProgress) messages.push(inProgress);
  return messages;
}
