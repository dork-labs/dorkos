/**
 * What the pinned triage header has to say, in the two registers it says it in.
 *
 * One source, because the two are the same claim: the live region speaks it as
 * a sentence, and the condensed bar writes it as counts. Two hand-written
 * copies drift the moment either wording is touched, and a summary that
 * disagrees with the announcement is worse than either alone.
 *
 * @module widgets/home/lib/triage-summary
 */
import { listWaitingKinds } from '@/layers/shared/lib';

/** What the header is holding, in numbers. */
export interface TriageCounts {
  /**
   * Prompts agents are parked on — one question apiece, however many agents
   * raised them. Two prompts from one agent are two things to answer.
   */
  questions: number;
  /** Capability approvals waiting on a decision. */
  requests: number;
  /** Schedules an agent proposed and parked, waiting for a yes or a no. */
  schedules: number;
  /** True when the approval list could not be read at all. */
  approvalsUnavailable: boolean;
  /** How many things went wrong and are still wrong. */
  attention: number;
}

/** The header's state, said two ways. */
export interface TriageSummary {
  /**
   * The sentence a screen reader hears.
   *
   * Counts, not contents: a queue of six read aloud card by card is a wall, and
   * what a reader needs from a live region is that something arrived and
   * roughly how much. Empty when there is nothing to say — silence is the point
   * of an empty live region.
   */
  spoken: string;
  /**
   * The same thing on one line, for the condensed bar.
   *
   * Empty exactly when {@link TriageSummary.spoken} is: the bar has nothing to
   * write, so there is no bar.
   */
  compact: string;
}

/**
 * Say what the header is holding.
 *
 * @param counts - What is waiting and what is wrong.
 * @returns The spoken sentence and the one-line summary, both empty when the
 * header is holding nothing.
 */
export function triageSummary({
  questions,
  requests,
  schedules,
  approvalsUnavailable,
  attention,
}: TriageCounts): TriageSummary {
  const spoken: string[] = [];
  const compact: string[] = [];

  const waiting = questions + requests + schedules;
  if (waiting > 0) {
    // **Three objects, three nouns, never one word standing in for all of them.**
    // This used to say "N approvals are waiting on you" over a queue that could
    // hold no approvals at all — a question an agent is parked on is not an
    // approval, and neither is a schedule somebody has to say yes or no to. The
    // panel's own summary already named them honestly (`InboxBell`), so the two
    // surfaces disagreed about the same queue. Same vocabulary, same order.
    spoken.push(
      `${listWaitingKinds(questions, requests, schedules)} ${waiting === 1 ? 'is' : 'are'} waiting on you.`
    );
    compact.push(`${waiting} waiting`);
  } else if (approvalsUnavailable) {
    // Worth saying on its own: an unreadable list is the case where silence
    // would be mistaken for "nothing is waiting".
    spoken.push('Approvals could not be read.');
    compact.push('Approvals unreadable');
  }

  if (attention === 1) {
    spoken.push('1 thing needs attention.');
    compact.push('1 needs attention');
  } else if (attention > 1) {
    spoken.push(`${attention} things need attention.`);
    compact.push(`${attention} need attention`);
  }

  return { spoken: spoken.join(' '), compact: compact.join(' · ') };
}
