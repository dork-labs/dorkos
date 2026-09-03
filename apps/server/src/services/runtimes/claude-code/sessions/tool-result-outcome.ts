/**
 * What a `tool_result` in the SDK's JSONL actually SAYS happened.
 *
 * A `tool_use` block on disk proves only that the model asked for something. The
 * paired `tool_result` is where the transcript records whether it happened —
 * and, when it did not, which of several very different things went wrong. The
 * transcript parser used to skip that question entirely and stamp every recorded
 * call `complete`, which is how a question nobody answered came back from a
 * reload wearing a green check (DOR-1293).
 *
 * ## Reading English out of a transcript, safely
 *
 * These outcomes are carried as prose, because prose is what the model is meant
 * to read. That makes matching them a real hazard: a `Read` of this very file
 * returns a tool_result whose text contains every sentence below, and a `Bash`
 * run that times out says "Command timed out after 2m 0s". Both were observed
 * while this module was written.
 *
 * `is_error === true` is the guard that makes the rest safe. Sweeping every
 * JSONL transcript on the author's machine, every false match of every sentence
 * below sat OUTSIDE the `is_error` set — they were file contents being read
 * back, grep output, and command timeouts. So the flag is consulted FIRST and
 * the sentences only afterwards, on text already known to be a failure. The
 * patterns are anchored to the whole (trimmed) result or its opening sentence
 * for the same reason; "timed out after" free-floating in the middle of a Bash
 * failure is a command timeout, not an approval one.
 *
 * **An unrecognised failure degrades to `errored`, never to a decision.** That
 * asymmetry is deliberate: `errored` says "this did not work", which is true of
 * every failure, while `denied` and `expired` claim a person (or a timer) acted.
 * Widening a pattern costs nothing if it is wrong in the direction of `errored`
 * and puts words in someone's mouth if it is wrong the other way.
 *
 * ## Whose words these are
 *
 * Two authors, and the difference matters for drift. The DorkOS-authored
 * denials are exported here as builders and used verbatim by
 * `messaging/interactive-handlers.ts`, so the thing that writes them and the
 * thing that reads them cannot disagree (the round-trip is pinned by this
 * module's tests). The CLI's own refusal sentences are quoted from the SDK and
 * can only be tracked, not owned — an unrecognised failure degrades to
 * `errored`, which is honest, so drift there costs precision and never truth.
 *
 * @module runtimes/claude-code/sessions/tool-result-outcome
 */
import type {
  HistoryToolCall,
  QuestionItem,
  QuestionOutcome,
  ToolCallPart,
} from '@dorkos/shared/types';
import { SDK_TOOL_NAMES } from '@dorkos/shared/constants';
import { mapSdkAnswersToIndices, parseQuestionAnswers } from './question-answers.js';

/**
 * What a paired `tool_result` says became of the call.
 *
 * `complete` is the ordinary case — the tool ran and returned. The other four
 * are the ways a call can end without doing what it was asked, which the
 * transcript previously flattened into "it ran".
 */
export type ToolResultOutcome = 'complete' | 'expired' | 'denied' | 'cancelled' | 'errored';

/**
 * How long a refusal says it waited, in the unit that reads best: whole hours
 * from an hour up, whole minutes below it.
 *
 * One rule, one place, because three sentences quote it — the two denials below
 * and the log line the claude-code handlers write. A prompt normally waits four
 * hours (`SESSIONS.INTERACTION_PARK_CEILING_MS`), but an unattended run still
 * refuses at ten minutes because nobody is coming back to it (spec
 * `ask-parks-on-timeout` §7), so the unit cannot be fixed at either.
 *
 * @param waitedMs - How long the prompt actually went unanswered.
 */
export function describeWaited(waitedMs: number): string {
  const [count, unit] =
    waitedMs >= 3_600_000
      ? ([Math.round(waitedMs / 3_600_000), 'hour'] as const)
      : ([Math.ceil(waitedMs / 60_000), 'minute'] as const);
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * What DorkOS tells the model when an `AskUserQuestion` goes unanswered until
 * the agent gives up. Read back by {@link classifyToolResult} as `expired`.
 *
 * @param waitedMs - How long the prompt went unanswered.
 */
export function questionTimeoutDenial(waitedMs: number): string {
  return `User did not respond within ${describeWaited(waitedMs)}`;
}

/**
 * What DorkOS tells the model when a permission prompt goes unanswered until
 * the agent gives up. Read back by {@link classifyToolResult} as `expired`.
 *
 * @param waitedMs - How long the prompt went unanswered.
 */
export function approvalTimeoutDenial(waitedMs: number): string {
  return `Tool approval timed out after ${describeWaited(waitedMs)}`;
}

/**
 * What DorkOS tells the model when a person refuses a tool, with their own
 * words appended when they gave any. Read back as `denied`.
 *
 * @param reason - What the person said, if anything.
 */
export function toolDenial(reason?: string): string {
  const said = reason?.trim();
  return said ? `User denied tool execution. Reason: ${said}` : 'User denied tool execution';
}

/**
 * The DorkOS-authored denials that mean the ask was WITHDRAWN rather than
 * answered — an SDK abort, or a client retracting the interaction. Read back as
 * `cancelled`.
 */
export const WITHDRAWN_DENIALS = {
  /** An `AskUserQuestion` cancelled by the SDK's per-tool abort signal. */
  question: 'Question cancelled',
  /** A permission prompt cancelled by the SDK's per-tool abort signal. */
  approval: 'Tool approval aborted',
  /** Either kind, retracted by the client rather than the SDK. */
  interaction: 'Interaction cancelled',
} as const;

/**
 * DorkOS's timeout denials, unit-agnostic so a changed budget still reads. The
 * minute forms stay for the transcripts written before a prompt waited hours
 * (spec `ask-parks-on-timeout` §5.5): widening the copy without widening this
 * would file every expired call as `errored` instead.
 */
const TIMEOUT_PATTERNS = [
  /^User did not respond within \d+ (?:minutes?|hours?)$/,
  /^Tool approval timed out after \d+ (?:minutes?|hours?)$/,
];

/**
 * The CLI's own refusal sentences, quoted from the SDK. Prefix matches, because
 * the first carries the person's words after a `the user said:` colon.
 */
const CLI_REFUSAL_PREFIXES = [
  "The user doesn't want to proceed with this tool use.",
  "The user doesn't want to take this action right now.",
];

/**
 * A refusal by a permission RULE rather than by a person answering a card —
 * `Permission to use Bash with command <cmd> has been denied.`
 *
 * The most common refusal shape in the corpus, and the one this classifier
 * originally missed: it outnumbered both {@link CLI_REFUSAL_PREFIXES} sentences
 * together, and every occurrence carried `is_error: true`. It reads as `denied`
 * because the tool was refused and did not run, which is the claim the
 * transcript makes. Who did the refusing — a `deny` rule the operator wrote
 * earlier, rather than a click just now — is not something the result text
 * distinguishes, and the receipt does not pretend to.
 */
const RULE_REFUSAL_PATTERN = /^Permission to use .+ has been denied\.?$/s;

/** Withdrawal shapes, including the CLI's own interrupt marker. */
const WITHDRAWN_PREFIXES = ['[Request interrupted by user'];

/**
 * Read a paired `tool_result` and say what became of the call.
 *
 * @param resultText - The result's text content, as the model received it.
 * @param isError - The block's `is_error` flag. Anything but `true` — including
 *   an absent flag, which is the common shape for a success — is a result that
 *   arrived, so the call is `complete` and no sentence is consulted.
 * @returns Which of the five endings the transcript records.
 */
export function classifyToolResult(
  resultText: string,
  isError: boolean | undefined
): ToolResultOutcome {
  if (isError !== true) return 'complete';

  const text = resultText.trim();
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(text))) return 'expired';
  if (Object.values(WITHDRAWN_DENIALS).some((denial) => text === denial)) return 'cancelled';
  if (WITHDRAWN_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'cancelled';
  if (CLI_REFUSAL_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'denied';
  if (text.startsWith(toolDenial())) return 'denied';
  if (RULE_REFUSAL_PATTERN.test(text)) return 'denied';

  return 'errored';
}

/** How a non-`complete` outcome reads as a QUESTION's ending. */
const QUESTION_OUTCOME_BY_RESULT: Record<
  Exclude<ToolResultOutcome, 'complete'>,
  Exclude<QuestionOutcome, 'answered'>
> = { expired: 'expired', denied: 'denied', cancelled: 'cancelled', errored: 'errored' };

/**
 * The fields a resolving result writes, shared by history's two shapes of a
 * tool call. `HistoryToolCall` carries no `interactiveType`, which is the only
 * difference between them and is handled at the one call site that has one.
 */
type ResolvableToolCall = Pick<
  HistoryToolCall,
  | 'toolName'
  | 'result'
  | 'status'
  | 'questions'
  | 'answers'
  | 'questionOutcome'
  | 'approvalOutcome'
  | 'approvalResolvedAt'
  | 'approvalStartedAt'
>;

/** Everything one `tool_result` block says about the call it answers. */
export interface ToolResultApplication {
  /** The HistoryToolCall to update, or undefined if not tracked. */
  tc?: HistoryToolCall;
  /** The ToolCallPart to update, or undefined if not tracked. */
  tcPart?: ToolCallPart;
  /** Extracted text content from the tool_result block. */
  resultText: string;
  /** The block's `is_error` flag, verbatim. */
  isError?: boolean;
  /** SDK-provided answers keyed by question text, when the record carried them. */
  sdkAnswers?: Record<string, string>;
  /**
   * Epoch ms the result landed, from the tool_result record's own timestamp.
   * Timestamps a receipt DorkOS has no other record of — a permission answered
   * in the bare CLI, or one whose event log has since been pruned.
   */
  resolvedAt?: number;
  /** Epoch ms the call was made, from the assistant record's own timestamp. */
  startedAt?: number;
}

/**
 * Write one classified result onto one shape of the tool call.
 *
 * Whether this is a QUESTION is decided by the tool's NAME, never by whether
 * its `questions` array parsed. Routing on the array meant an `AskUserQuestion`
 * whose input was malformed — or truncated, or written by a future SDK — fell
 * through to the approval arm and rendered "Expired — denied" over a question
 * nobody was ever asked to approve, which is precisely the confusion
 * `approvalOutcomeOf`'s contract exists to prevent. A question with no readable
 * options is still a question; it simply has no answers to show.
 */
function resolveToolCall(
  target: ResolvableToolCall,
  outcome: ToolResultOutcome,
  app: ToolResultApplication
): void {
  const { resultText, sdkAnswers, resolvedAt, startedAt } = app;
  target.result = resultText;
  target.status = outcome === 'complete' ? 'complete' : 'error';

  if (target.toolName === SDK_TOOL_NAMES.ASK_USER_QUESTION) {
    if (outcome !== 'complete') {
      target.questionOutcome = QUESTION_OUTCOME_BY_RESULT[outcome];
      return;
    }
    // Answers are read ONLY out of a result that succeeded. A failed one has
    // none to give, and parsing it anyway is how the empty `{}` that renders as
    // "Question answered" was minted (DOR-1293).
    const questions = target.questions as QuestionItem[] | undefined;
    if (!target.answers && questions) {
      target.answers = sdkAnswers
        ? mapSdkAnswersToIndices(sdkAnswers, questions)
        : parseQuestionAnswers(resultText, questions);
    }
    target.questionOutcome = 'answered';
    return;
  }

  if (outcome === 'denied' || outcome === 'expired') {
    target.approvalOutcome = outcome;
    target.approvalResolvedAt = resolvedAt;
    target.approvalStartedAt = startedAt;
  }
}

/**
 * Apply a `tool_result` block to the matching {@link HistoryToolCall} and
 * {@link ToolCallPart} — the result text, the terminal status, and whatever
 * the ending was.
 *
 * Which ending is recorded depends on what was asked:
 *
 * - **A question** takes a {@link QuestionOutcome}.
 * - **A tool a person refused or let expire** takes an `approvalOutcome`. This
 *   is the ONLY record of such a decision when it was made outside DorkOS — in
 *   the bare CLI, or in a session whose event log has since been pruned. Where
 *   DorkOS does hold the answer, `session/overlays/approval-receipt-overlay` runs after
 *   this and replaces it with the authoritative one.
 * - **Anything else that failed** takes `status: 'error'` and nothing more; the
 *   result text is the tool card's own explanation.
 *
 * Mutates `tc` and `tcPart` in place.
 *
 * @param app - The block and its record's context.
 */
export function applyToolResult(app: ToolResultApplication): void {
  const outcome = classifyToolResult(app.resultText, app.isError);
  if (app.tc) resolveToolCall(app.tc, outcome, app);
  if (app.tcPart) {
    resolveToolCall(app.tcPart, outcome, app);
    // `interactiveType` is what marks the part as a permission prompt at all —
    // the receipt renderer keys off it, so the outcome without it would restore
    // the fact and none of the display. Only the part has the field.
    if (app.tcPart.approvalOutcome !== undefined) app.tcPart.interactiveType = 'approval';
  }
}
