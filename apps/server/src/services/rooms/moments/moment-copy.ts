/**
 * The words a moment says (team-room-home spec D5.1).
 *
 * Every line here is written the way a person would say it out loud —
 * `writing-for-humans`, plain enough for somebody who does not code. "tangerines
 * joined your team", never "🎉 New team member onboarded!". No exclamation
 * marks, no congratulation, no emoji: the room is telling you something true,
 * not celebrating at you.
 *
 * **Every number in these lines is counted, never rounded.** The functions below
 * take the real value and print it; none of them accepts an approximation and
 * none of them softens one ("about a week", "lots of activity"). A moment whose
 * number a person could check and find wrong would cost this feature the only
 * thing it has.
 *
 * Kept in its own file so the copy can be read — and reviewed — as copy, without
 * the detector logic around it.
 *
 * @module server/services/rooms/moments/moment-copy
 */
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * A name from outside, safe to drop into a line DorkOS wrote.
 *
 * An agent names itself in a manifest on disk and a person names their own
 * schedules, so every name in this file arrives from somewhere else — the same
 * posture every other room surface takes with one (`sanitizeIdentity`). A name
 * that sanitizes away to nothing still has to leave a readable sentence behind,
 * which is what the fallback is for.
 *
 * @param name - The name as its source gives it.
 * @param fallback - What to say when nothing readable survives.
 */
function named(name: string, fallback: string): string {
  return sanitizeIdentity(name) ?? fallback;
}

/**
 * A wall-clock time, formatted by hand rather than by `Intl`.
 *
 * Deliberately not locale-formatted: this string is asserted in tests and read
 * by one person on one machine, and `Intl` would make the same code print a
 * different sentence depending on the host's locale — a difference nobody asked
 * for and every test would have to tolerate.
 *
 * @param at - The instant, read in the server's own timezone, which is the
 *   person's: "overnight" only means anything on the clock they sleep by.
 */
function clockTime(at: Date): string {
  const hours = at.getHours();
  const suffix = hours < 12 ? 'AM' : 'PM';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(at.getMinutes()).padStart(2, '0')} ${suffix}`;
}

/**
 * The first agent this install ever registered, beyond DorkBot.
 *
 * @param name - The agent's display name.
 */
export function firstAgentText(name: string): string {
  return `${named(name, 'An agent')} joined your team. Your first agent.`;
}

/**
 * A later agent joining — the canonical moment, and the plainest line here.
 *
 * @param name - The agent's display name.
 */
export function joinedTeamText(name: string): string {
  return `${named(name, 'An agent')} joined your team.`;
}

/**
 * The first schedule this install ever made.
 *
 * Says it was set up and stops there. Whether it is switched ON is a separate
 * fact this event does not carry, and a line promising "it runs on its own from
 * now on" would be wrong for a schedule created paused.
 *
 * @param label - The schedule's name, as the person typed it.
 */
export function firstScheduleText(label: string): string {
  return `Your first schedule is set up: ${named(label, 'a new schedule')}.`;
}

/**
 * The first schedule that finished in the middle of the night.
 *
 * It names the clock time because that is the whole of what makes it a moment,
 * and it does not say "while you slept" — DorkOS does not know that.
 *
 * @param label - The schedule's name.
 * @param at - When the run finished.
 */
export function firstOvernightRunText(label: string, at: Date): string {
  return `${named(label, 'A schedule')} ran overnight and finished at ${clockTime(at)}. Your first overnight run.`;
}

/** The first time an agent was wired up to something outside DorkOS. */
export function firstConnectionText(): string {
  return 'Your first connection is set up. You can reach an agent from outside DorkOS now.';
}

/**
 * A week in which something happened here every single day.
 *
 * @param count - How many things happened, counted exactly.
 */
export function weeklyStreakText(count: number): string {
  return `Something ran here every day this week: ${count} things in seven days.`;
}

/**
 * A week or a month of working with one agent.
 *
 * @param name - The agent's display name.
 * @param span - Which anniversary this is.
 */
export function anniversaryText(name: string, span: 'week' | 'month'): string {
  return `It's been a ${span} since ${named(name, 'an agent')} joined your team.`;
}
