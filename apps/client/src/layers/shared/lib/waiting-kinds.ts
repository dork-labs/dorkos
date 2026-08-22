/**
 * The nouns the cockpit counts "what's waiting on you" in.
 *
 * **Three different objects, and none of them stands in for another.** A prompt
 * an agent is parked on is a QUESTION; a capability hold is a REQUEST; a
 * schedule an agent proposed is a SCHEDULE. They share one badge and one queue,
 * which is exactly why the words have to stay apart — a person who reads "3
 * approvals" and finds two questions and a proposed cron has been told
 * something untrue about their own machine.
 *
 * It lives in `shared` because two widgets say this sentence — the Inbox bell's
 * pill and panel, and the home surface's pinned triage header — and a widget
 * may not import a sibling widget. Two hand-written copies drifted exactly once
 * before this file existed: the popover already named all three kinds while the
 * header still called the whole queue "approvals".
 *
 * @module shared/lib/waiting-kinds
 */

/**
 * "1 request", "2 schedules" — one counted noun, correctly pluralized.
 *
 * Deliberately not exported: it is how {@link listWaitingKinds} spells its
 * parts, not a general pluralizer. Nothing outside this file has ever wanted
 * one, and exporting it would invite a second counting vocabulary next to the
 * one this module exists to keep single.
 *
 * @param count - How many of this kind are waiting.
 * @param noun - The noun's singular form.
 */
function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Every kind that is actually waiting, named and joined with an Oxford comma.
 *
 * "1 question and 2 schedules", "1 question, 2 requests, and 3 schedules". A
 * kind with nothing waiting is left out entirely rather than reported as zero.
 *
 * Order matches the order the surfaces list them in: questions first (their
 * window is the shortest), then capability requests, then schedules (which are
 * on no clock at all).
 *
 * @param questions - Prompts agents are parked on.
 * @param requests - Capability approvals waiting.
 * @param schedules - Parked schedules waiting.
 * @returns The joined phrase, or `''` when nothing is waiting — a caller with
 *   nothing to count has a different sentence to say, and building one out of
 *   an empty list is how ", and undefined" reaches a screen.
 */
export function listWaitingKinds(questions: number, requests: number, schedules: number): string {
  const parts = [
    questions > 0 ? countNoun(questions, 'question') : null,
    requests > 0 ? countNoun(requests, 'request') : null,
    schedules > 0 ? countNoun(schedules, 'schedule') : null,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
