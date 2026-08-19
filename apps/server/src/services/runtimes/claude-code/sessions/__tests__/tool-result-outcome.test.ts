import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage, ToolCallPart } from '@dorkos/shared/types';
import { parseTranscript } from '../transcript-parser.js';
import {
  approvalTimeoutDenial,
  classifyToolResult,
  questionTimeoutDenial,
  toolDenial,
  WITHDRAWN_DENIALS,
} from '../tool-result-outcome.js';

/**
 * Every terminal shape in one transcript, taken from the operator's own
 * `46053f9b` session and from a census of ~14,000 real tool results —
 * anonymised, with no real paths.
 */
const FIXTURE = fileURLToPath(
  new URL('./fixtures/tool-result-terminal-shapes.jsonl', import.meta.url)
);

/** Parse the fixture once per test file; the parser is pure. */
const MESSAGES: HistoryMessage[] = parseTranscript(
  readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
);

/** The `tool_call` part carrying `toolCallId`, from anywhere in the fixture. */
function part(toolCallId: string): ToolCallPart {
  for (const message of MESSAGES) {
    const found = message.parts?.find((p) => p.type === 'tool_call' && p.toolCallId === toolCallId);
    if (found?.type === 'tool_call') return found;
  }
  throw new Error(`no tool_call part for ${toolCallId}`);
}

/** The legacy `toolCalls` twin of {@link part}, which history also carries. */
function call(toolCallId: string) {
  for (const message of MESSAGES) {
    const found = message.toolCalls?.find((tc) => tc.toolCallId === toolCallId);
    if (found) return found;
  }
  throw new Error(`no toolCall for ${toolCallId}`);
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

describe('classifyToolResult', () => {
  it('classifies an hours-shaped timeout denial as expired', () => {
    // The unit changed when prompts started parking (spec
    // `ask-parks-on-timeout`): a prompt now waits four hours before it is
    // refused, and the receipt the transcript builds is read out of this
    // sentence. Widening the copy without widening TIMEOUT_PATTERNS files every
    // expired call as `errored` instead.
    expect(questionTimeoutDenial(FOUR_HOURS)).toBe('User did not respond within 4 hours');
    expect(approvalTimeoutDenial(FOUR_HOURS)).toBe('Tool approval timed out after 4 hours');
    expect(classifyToolResult(questionTimeoutDenial(FOUR_HOURS), true)).toBe('expired');
    expect(classifyToolResult(approvalTimeoutDenial(FOUR_HOURS), true)).toBe('expired');
  });

  it('still classifies a minutes-shaped timeout denial as expired', () => {
    // Two callers write minutes: an unattended run, which never parks, and
    // every transcript recorded before the park existed. Both keep their
    // receipts.
    expect(questionTimeoutDenial(TEN_MINUTES)).toBe('User did not respond within 10 minutes');
    expect(approvalTimeoutDenial(TEN_MINUTES)).toBe('Tool approval timed out after 10 minutes');
    expect(classifyToolResult('User did not respond within 10 minutes', true)).toBe('expired');
    expect(classifyToolResult('Tool approval timed out after 10 minutes', true)).toBe('expired');
  });

  it('reads back every denial DorkOS itself writes', () => {
    // The round trip is the anti-drift mechanism: these are the exact strings
    // `messaging/interactive-handlers.ts` hands the SDK, so a reworded denial
    // that this classifier no longer recognises fails here rather than silently
    // degrading a transcript to "errored" months later.
    expect(classifyToolResult(questionTimeoutDenial(FOUR_HOURS), true)).toBe('expired');
    expect(classifyToolResult(approvalTimeoutDenial(FOUR_HOURS), true)).toBe('expired');
    // A changed budget must still read as a timeout, not as a bare error.
    expect(classifyToolResult(questionTimeoutDenial(3 * 60_000), true)).toBe('expired');
    expect(classifyToolResult(approvalTimeoutDenial(60_000), true)).toBe('expired');
    expect(classifyToolResult(toolDenial(), true)).toBe('denied');
    expect(classifyToolResult(toolDenial('not on main'), true)).toBe('denied');
    expect(classifyToolResult(WITHDRAWN_DENIALS.question, true)).toBe('cancelled');
    expect(classifyToolResult(WITHDRAWN_DENIALS.approval, true)).toBe('cancelled');
    expect(classifyToolResult(WITHDRAWN_DENIALS.interaction, true)).toBe('cancelled');
  });

  it("reads back the CLI's own refusals and interrupt", () => {
    expect(
      classifyToolResult(
        "The user doesn't want to take this action right now. STOP what you are doing.",
        true
      )
    ).toBe('denied');
    expect(
      classifyToolResult(
        "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nuse a scratch dir",
        true
      )
    ).toBe('denied');
    expect(classifyToolResult('[Request interrupted by user for tool use]', true)).toBe(
      'cancelled'
    );
  });

  it('reads a permission RULE refusal as a denial', () => {
    // The most common refusal shape in the corpus, and the one the first cut of
    // this classifier missed entirely — it outnumbered both CLI refusal
    // sentences together and landed in `errored`, so the tool read as "failed"
    // rather than "refused".
    expect(
      classifyToolResult('Permission to use Bash with command ls -la .env has been denied.', true)
    ).toBe('denied');
    // Multi-line commands are ordinary; the pattern must not stop at the first
    // newline and fall through to `errored`.
    expect(
      classifyToolResult(
        'Permission to use Bash with command foo \\\n  && bar has been denied.',
        true
      )
    ).toBe('denied');
  });

  it('calls an unrecognised failure errored rather than guessing', () => {
    expect(classifyToolResult('Exit code 1\nTraceback (most recent call last):', true)).toBe(
      'errored'
    );
    expect(
      classifyToolResult('<tool_use_error>File has not been read yet.</tool_use_error>', true)
    ).toBe('errored');
  });

  it('never reads a sentence out of a result that SUCCEEDED', () => {
    // The census that motivated the `is_error` guard: a `Read` of a file that
    // quotes these sentences, and a Bash timeout that shares the words "timed
    // out after". Both arrive with the flag absent or false, and both are the
    // ordinary success case.
    expect(classifyToolResult(questionTimeoutDenial(FOUR_HOURS), undefined)).toBe('complete');
    expect(classifyToolResult(toolDenial('not on main'), false)).toBe('complete');
    expect(classifyToolResult('Exit code 143\nCommand timed out after 2m 0s', undefined)).toBe(
      'complete'
    );
  });
});

describe('parseTranscript terminal shapes (DOR-1293)', () => {
  it('an ordinary tool that ran and returned is unchanged', () => {
    expect(part('tool-ok')).toMatchObject({ status: 'complete', result: 'hello' });
    expect(part('tool-ok').questionOutcome).toBeUndefined();
    expect(part('tool-ok').approvalOutcome).toBeUndefined();
    expect(part('tool-ok').interactiveType).toBeUndefined();
    expect(call('tool-ok')).toMatchObject({ status: 'complete', result: 'hello' });
  });

  it('an answered question keeps its answers and says it was answered', () => {
    expect(part('tool-answered')).toMatchObject({
      status: 'complete',
      interactiveType: 'question',
      questionOutcome: 'answered',
      answers: { '0': 'Mergesort' },
    });
    expect(call('tool-answered')).toMatchObject({
      questionOutcome: 'answered',
      answers: { '0': 'Mergesort' },
    });
  });

  it('a question nobody answered is expired, with NO answers to imply one', () => {
    // The reported bug, exactly: this is the operator's `46053f9b` session,
    // asked 21:21:34 and auto-denied 21:31:34. Before the fix the parser handed
    // the client `status: 'complete'` and `answers: {}`, which renders as a
    // green "Question answered".
    const expired = part('tool-expired');
    expect(expired.status).toBe('error');
    expect(expired.questionOutcome).toBe('expired');
    expect(expired.answers).toBeUndefined();
    expect(expired.result).toBe('User did not respond within 10 minutes');
    expect(call('tool-expired')).toMatchObject({ status: 'error', questionOutcome: 'expired' });
  });

  it('a withdrawn question is cancelled, not answered', () => {
    expect(part('tool-question-cancelled')).toMatchObject({
      status: 'error',
      questionOutcome: 'cancelled',
    });
    expect(part('tool-question-cancelled').answers).toBeUndefined();
  });

  it('a refused tool becomes an approval receipt the transcript can draw', () => {
    const denied = part('tool-denied');
    expect(denied.status).toBe('error');
    // `interactiveType` is what makes the renderer draw a receipt at all.
    expect(denied.interactiveType).toBe('approval');
    expect(denied.approvalOutcome).toBe('denied');
    expect(denied.approvalStartedAt).toBe(Date.parse('2026-08-15T21:33:00.000Z'));
    expect(denied.approvalResolvedAt).toBe(Date.parse('2026-08-15T21:33:12.000Z'));
    expect(call('tool-denied')).toMatchObject({ status: 'error', approvalOutcome: 'denied' });
  });

  it('an approval that timed out says how long it waited', () => {
    const expired = part('tool-approval-expired');
    expect(expired.approvalOutcome).toBe('expired');
    // Ten minutes, from the transcript's own two timestamps — this is the
    // "after 10:00" the receipt line states, and the only place that number
    // exists for a decision DorkOS did not record itself.
    expect(expired.approvalResolvedAt! - expired.approvalStartedAt!).toBe(600_000);
  });

  it('a tool that simply failed errors, and claims no decision was made', () => {
    const errored = part('tool-errored');
    expect(errored.status).toBe('error');
    expect(errored.result).toContain('Exit code 1');
    expect(errored.approvalOutcome).toBeUndefined();
    expect(errored.interactiveType).toBeUndefined();
  });

  it('a tool refused by a permission RULE reads as refused, not as broken', () => {
    const denied = part('tool-rule-denied');
    expect(denied.status).toBe('error');
    expect(denied.interactiveType).toBe('approval');
    expect(denied.approvalOutcome).toBe('denied');
    // The command that was blocked is the whole content of the refusal, and the
    // receipt suppresses the tool card — so losing this text loses the only
    // record of WHAT was refused.
    expect(denied.result).toContain('ls -la .env');
  });

  it('a question whose input did not parse is still a QUESTION', () => {
    // Routing on the `questions` array rather than the tool name sent this down
    // the approval arm, where it rendered "Expired — denied after 10:00" over a
    // question nobody was ever asked to approve.
    const malformed = part('tool-malformed');
    expect(malformed.interactiveType).toBe('question');
    expect(malformed.questionOutcome).toBe('expired');
    expect(malformed.approvalOutcome).toBeUndefined();
    // No options survived the malformed input, and none are invented.
    expect(malformed.questions).toBeUndefined();
  });

  it('a question the transcript never answers says it does not know', () => {
    // A turn that died between the ask and any result. `status` stays
    // `complete` on purpose — `pending` would make `use-chat-session`'s scan
    // claim a closed session is waiting on you — so the honesty lives on the
    // field that scan never reads.
    const orphan = part('tool-orphan');
    expect(orphan.questionOutcome).toBe('unresolved');
    expect(orphan.answers).toBeUndefined();
    expect(orphan.result).toBeUndefined();
    expect(call('tool-orphan').questionOutcome).toBe('unresolved');
  });

  it('a successful Read of a file QUOTING those sentences stays complete', () => {
    // Without the `is_error` guard this file's own text would classify as a
    // denial, an expiry and an interrupt at once.
    const quoting = part('tool-quoting');
    expect(quoting.status).toBe('complete');
    expect(quoting.approvalOutcome).toBeUndefined();
    expect(quoting.interactiveType).toBeUndefined();
  });
});
