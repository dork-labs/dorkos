/**
 * Transcript oracles: the ONE place the oracle layer reads assistant text, and
 * it does so WITHOUT judgment — mechanical, reproducible checks over the turns
 * in the collected SSE stream: a literal question-count bound and a
 * fixed-phrase first-action-offer signal in the final turn.
 *
 * WHY THIS IS STILL AN ORACLE, NOT A JUDGE: the "assert side effects, never
 * prose" principle (see `oracles/index.ts`, `stream.ts`) guards against FLAKY
 * SUBJECTIVE matching — scoring tone or whether a follow-up was the *sharpest*.
 * A count of `?` characters and a match against a committed phrase list are
 * deterministic and give the same verdict every run, which is categorically
 * different from the `RubricJudge` (`judge.ts`) that scores quality with a model.
 * These exist so an interview-style case (the design-your-own newborn) can guard
 * its two behavioral criteria — "asks ≤N questions", "proposes a first action" —
 * that leave no filesystem trace, deterministically rather than only by proxy.
 *
 * WHAT THEY READ: the eval drive opens `GET /api/sessions/:id/events` BEFORE the
 * first trigger, so every turn streams live as `turn_start` → `text_delta`* →
 * `turn_end`. These helpers fold that live stream into per-turn assistant text;
 * they do not read the cold snapshot (empty at drive start for a fresh session).
 *
 * @module evals/oracles/transcript
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle } from '../types.js';

/** The logical SessionEvent type of a frame — the `event:` line, or the payload's `type`. */
function frameType(frame: SseFrame): string | undefined {
  return frame.event || (frame.data as { type?: string } | undefined)?.type;
}

/**
 * Fold the collected stream into per-turn assistant text, in order: each
 * `turn_start` opens a turn, `text_delta`s accumulate its text, and `turn_end`
 * closes it. A still-open final turn (no `turn_end` yet) is included so a turn
 * cut off at collection time is not silently dropped. Turns with no text
 * (tool-only) fold to an empty string and are kept positionally.
 *
 * @param frames - Every SSE frame collected off the session's `/events` stream.
 * @returns The assistant text of each turn, in transcript order.
 */
export function assistantTurns(frames: SseFrame[]): string[] {
  const turns: string[] = [];
  let current: string | null = null;
  for (const frame of frames) {
    switch (frameType(frame)) {
      case 'turn_start':
        if (current !== null) turns.push(current);
        current = '';
        break;
      case 'text_delta':
        if (current !== null) current += (frame.data as { text?: string }).text ?? '';
        break;
      case 'turn_end':
        if (current !== null) {
          turns.push(current);
          current = null;
        }
        break;
      default:
        break;
    }
  }
  if (current !== null) turns.push(current);
  return turns;
}

/** The text of the last assistant turn in the stream, or `''` when there is none. */
export function finalAssistantMessage(frames: SseFrame[]): string {
  const turns = assistantTurns(frames);
  return turns.length > 0 ? turns[turns.length - 1] : '';
}

/**
 * Oracle: the assistant asked at most `max` questions ACROSS THE INTERVIEW TURNS
 * — every assistant turn except its last (the closing turn, which for an
 * interview is the confirm-and-offer whose offer may itself be phrased as a
 * question). "Question" is counted literally as `?` characters, so the check is
 * deterministic and never judges intent. A conversation with one or zero
 * assistant turns has no interview turns and trivially passes (nothing asked).
 *
 * CAVEAT (literal count): a `?` inside a code fence, URL, or quote over-counts,
 * and a full-width `？` is missed — acceptable for a lenient budget bound, not a
 * grammar-aware parse.
 *
 * @param max - The inclusive question budget (e.g. `INTERVIEW_QUESTION_BUDGET`).
 * @param label - Human-readable label; defaults to an at-most message.
 * @returns An {@link Oracle}.
 */
export function assistantAsksAtMost(max: number, label?: string): Oracle {
  return async (ctx) => {
    const turns = assistantTurns(ctx.frames);
    // The final turn is the closing/offer turn, not an interview question.
    const interviewTurns = turns.slice(0, -1);
    const questionCount = interviewTurns.reduce(
      (sum, text) => sum + (text.match(/\?/g)?.length ?? 0),
      0
    );
    const passed = questionCount <= max;
    return {
      label: label ?? `assistant asked at most ${max} questions`,
      passed,
      evidence: {
        max,
        questionCount,
        interviewTurns: interviewTurns.length,
        totalTurns: turns.length,
      },
      detail: passed ? undefined : `counted ${questionCount} question mark(s), budget is ${max}`,
    };
  };
}

/**
 * Oracle: the FINAL assistant turn's text satisfies `matcher` — used to assert
 * the newborn's closing turn proposes a first action (a fixed-phrase offer
 * signal). Mirrors `fileMatches`: pass a RegExp or a content predicate. Reads
 * the last turn only, so an offer buried in an earlier turn does not count.
 *
 * @param matcher - A RegExp tested against the final message, or a predicate.
 * @param label - Human-readable label; defaults to a final-message message.
 * @returns An {@link Oracle}.
 */
export function finalAssistantMessageMatches(
  matcher: RegExp | ((text: string) => boolean),
  label?: string
): Oracle {
  return async (ctx) => {
    const message = finalAssistantMessage(ctx.frames);
    const passed = matcher instanceof RegExp ? matcher.test(message) : matcher(message);
    return {
      label: label ?? 'final assistant message matches',
      passed,
      evidence: { matched: passed, hasFinalMessage: message.length > 0 },
      detail: passed ? undefined : 'the final assistant message did not match',
    };
  };
}
