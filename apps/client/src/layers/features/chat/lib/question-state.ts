/**
 * What the transcript says about ONE `AskUserQuestion`, as the renderer needs
 * to know it.
 *
 * Both answers here used to be read straight off `status !== 'pending'`, which
 * cannot tell an unanswered question from an answered one somebody ELSE
 * submitted — and rendered both as a green "Question answered" (DOR-1293).
 *
 * @module features/chat/lib/question-state
 */
import type { MessagePart, QuestionOutcome } from '@dorkos/shared/types';

/** The `tool_call` member of {@link MessagePart}. */
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

/**
 * Whether a question is over AND was actually answered — the only state the
 * renderer's empty-answers fallback may stand in for.
 *
 * `questionOutcome` is authoritative wherever it exists, and for a question in
 * history it very nearly always does: claude-code's parser re-derives it from
 * the JSONL on every read (so there is no such thing as an old transcript that
 * lacks it), and the log-backed fold stamps `unresolved` on anything its event
 * stream never resolved.
 *
 * The fallback is not decoration, and these are the cases that reach it:
 *
 * - The LIVE path. A question nothing has resolved yet is still `pending`, and
 *   nothing has folded an ending onto it.
 * - A log-backed turn that produced no `turn_end` — a server crash mid-turn —
 *   so `markUnresolvedQuestions` never ran over it.
 * - A log-backed ask whose `question_prompt` id did not match any tool call and
 *   whose row is not named `AskUserQuestion` either, so nothing identified it
 *   as a question to mark.
 *
 * In all three, "settled means answered" is the same rule the renderer used
 * before any of this existed.
 *
 * @param part - The question's tool-call part.
 */
export function isSettledQuestion(part: ToolCallPart): boolean {
  if (part.questionOutcome !== undefined) return part.questionOutcome === 'answered';
  return part.status !== 'pending';
}

/**
 * How the question ended, or `undefined` while it is still being asked.
 *
 * A part the server still reports as `pending` is being asked RIGHT NOW,
 * whatever a history copy says about it — the DOR-1269 recovery deliberately
 * re-pends a question from the snapshot's `pendingInteractions`, and a terminal
 * row drawn over that is a card nobody can answer.
 *
 * @param part - The question's tool-call part.
 */
export function questionEnding(part: ToolCallPart): QuestionOutcome | undefined {
  return part.status === 'pending' ? undefined : part.questionOutcome;
}
