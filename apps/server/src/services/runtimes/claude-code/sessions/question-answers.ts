/**
 * Claude Code AskUserQuestion answer-format translation.
 *
 * This module is the single boundary where DorkOS's **canonical** answer format
 * is translated to and from the **Claude Agent SDK's** native format. Keeping it
 * here means the rest of DorkOS (shared schema, transport, client, the
 * `AgentRuntime` interface) only ever deals in the runtime-neutral canonical
 * shape — a future runtime translates the same canonical answers into whatever
 * its backend expects.
 *
 * **Canonical format (DorkOS, runtime-neutral):** `Record<string, string>` keyed
 * by question **index** (`"0"`, `"1"`, …). Each value is the user's answer as a
 * display string; multi-select selections are joined with `", "`.
 *
 * **SDK format (`AskUserQuestionOutput.answers`):** `Record<string, string>` keyed
 * by the question **text**; multi-select answers are comma-separated. The native
 * executor matches answers to questions by text, so index keys are silently
 * dropped — the bug this module exists to prevent.
 *
 * @module runtimes/claude-code/sessions/question-answers
 */
import type { QuestionItem } from '@dorkos/shared/types';

/**
 * Normalize a single canonical answer value to a comma-separated display string.
 *
 * New clients already send multi-select answers comma-joined. This also tolerates
 * the legacy `JSON.stringify(array)` encoding that older clients produced, so a
 * version-skewed client never surfaces raw JSON to the agent.
 */
function normalizeAnswerValue(value: string): string {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch {
      // Not JSON — fall through and use the value verbatim.
    }
  }
  return value;
}

/**
 * Translate DorkOS canonical answers into the SDK's question-text-keyed format
 * for injection into an `AskUserQuestion` tool's `updatedInput`.
 *
 * Numeric keys are mapped to their question's text. Non-numeric keys (already
 * question text, e.g. from a future client) and out-of-range indices pass
 * through unchanged, making the function idempotent and skew-tolerant.
 *
 * @param answers - Canonical answers keyed by question index.
 * @param questions - The questions asked, in order, for index → text resolution.
 * @returns Answers keyed by question text, ready for the SDK.
 */
export function toSdkQuestionAnswers(
  answers: Record<string, string>,
  questions: QuestionItem[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    const question = /^\d+$/.test(key) ? questions[Number(key)] : undefined;
    // Only multi-select values can carry the legacy JSON-array encoding. Never
    // reinterpret a single-select freeform answer that merely looks like JSON.
    const normalized = question?.multiSelect ? normalizeAnswerValue(value) : value;
    out[question ? question.question : key] = normalized;
  }
  return out;
}

/**
 * Translate recorded SDK answers back into DorkOS canonical (index-keyed) form
 * for history display.
 *
 * Handles both the SDK/raw-CLI shape (keyed by question text) and DorkOS's own
 * legacy recordings (already index-keyed) via a digit-key fallback.
 *
 * @param sdkAnswers - Answers as recorded in the transcript.
 * @param questions - The questions asked, in order.
 * @returns Canonical answers keyed by question index.
 */
export function mapSdkAnswersToIndices(
  sdkAnswers: Record<string, string>,
  questions: QuestionItem[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [questionText, answerText] of Object.entries(sdkAnswers)) {
    const qIdx = questions.findIndex((q) => q.question === questionText);
    if (qIdx !== -1) {
      answers[String(qIdx)] = answerText;
    }
  }
  // Fallback: keys are already indices (legacy DorkOS recordings).
  if (Object.keys(answers).length === 0) {
    for (const [key, value] of Object.entries(sdkAnswers)) {
      if (/^\d+$/.test(key)) {
        answers[key] = value;
      }
    }
  }
  return answers;
}

/**
 * Parse answers from an `AskUserQuestion` tool_result text as a last resort.
 * Format: `..."Question text"="Answer text", "Q2"="A2". You can now...`
 *
 * @param resultText - The tool_result text the model received.
 * @param questions - The questions asked, in order.
 * @returns Canonical answers keyed by question index.
 */
export function parseQuestionAnswers(
  resultText: string,
  questions: QuestionItem[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  const pairRegex = /"([^"]+?)"\s*=\s*"([^"]+?)"/g;
  let match;
  while ((match = pairRegex.exec(resultText)) !== null) {
    const [, questionText, answerText] = match;
    const qIdx = questions.findIndex((q) => q.question === questionText);
    if (qIdx !== -1) {
      answers[String(qIdx)] = answerText;
    }
  }
  return answers;
}
