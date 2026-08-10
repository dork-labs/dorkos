/**
 * Which row earns the welcome-back beat (BC-49).
 *
 * You went away, work carried on, and it finished before you got back. That row
 * — and only that row — glows amber once when the sidebar first paints. It is
 * the smallest possible answer to "what happened while I was gone", and it is
 * deliberately not a summary, a badge or a notification: the sidebar points at
 * the thing and then stops talking.
 *
 * The rule is a pure function over four numbers so it is decidable without a
 * clock, a store or a render, and so the threshold that governs it can be the
 * one the user already set rather than a second one invented here.
 *
 * @module shared/lib/welcome-back-glow
 */

/** Everything {@link isWelcomeBackMoment} is allowed to know. */
export interface WelcomeBackMomentInput {
  /**
   * When this row's work finished, as epoch milliseconds, or `null` when it has
   * not finished — a session still mid-turn has nothing to come back to.
   */
  finishedAt: number | null;
  /**
   * When you were last here, as epoch milliseconds, or `null` when the cockpit
   * has no record of a previous visit.
   *
   * `null` is a first visit, not an infinite absence. Treating an unknown last
   * visit as "away forever" would light up every finished row on a fresh
   * install, which is the opposite of a welcome.
   */
  lastSeenAt: number | null;
  /**
   * How long an absence has to be before coming back counts as a return, in
   * minutes.
   *
   * This is `welcomeBack.absenceThresholdMinutes` from the user's config — the
   * same number the team-room greeting already obeys, read through
   * `useWelcomeBack()`. There is deliberately no default here: a second
   * threshold is a second answer to a question the product has already
   * answered, and the two would drift.
   *
   * A non-positive value means the setting is not in force (it is what
   * `useWelcomeBack()` reports on a server that does not carry the block, and
   * in Obsidian) and nothing glows. Without that guard a threshold of zero
   * would make every finished row a homecoming.
   */
  absenceThresholdMinutes: number;
  /** Now, as epoch milliseconds. Passed in so this stays testable and pure. */
  now: number;
}

/** Minutes to milliseconds, in the one place this module needs it. */
const MS_PER_MINUTE = 60_000;

/**
 * Whether this row's work finished while you were away, and the absence was
 * long enough to count as one.
 *
 * Both halves are required, and each one alone is a different (wrong) rule.
 * "Work finished" alone glows at someone who watched it finish. "You were away"
 * alone glows at every row in the sidebar the moment you return, which is the
 * fleet-wide siren the notification rules exist to prevent (§18).
 *
 * The absence is measured from your last visit to NOW rather than to the moment
 * the work finished: you have just come back, so the absence that matters is
 * the whole of the one that just ended.
 *
 * **Read this before wiring it up: the glow is a MOUNT-time moment.**
 * `SidebarRow` latches `welcomeBack` when the row mounts and ignores every
 * later change to it (deliberately — a re-armable glow would pulse on every
 * model rebuild). So a sidebar that stays mounted across an absence never
 * glows, however long the absence was: the row was already on screen when the
 * work finished, and nothing re-mounts it. In practice the moment lands on a
 * fresh load, which is the case it was designed for and the one BC-49
 * describes ("glows once on first paint"). A caller that wants the beat on a
 * long-lived sidebar has to give the row a new React key when the absence
 * resolves — a decision for whoever owns that surface, not something this
 * function can do from here.
 *
 * @param input - The row's finish time, your last visit, the threshold and now.
 */
export function isWelcomeBackMoment(input: WelcomeBackMomentInput): boolean {
  const { finishedAt, lastSeenAt, absenceThresholdMinutes, now } = input;
  if (absenceThresholdMinutes <= 0) return false;
  if (finishedAt === null || lastSeenAt === null) return false;
  // Strictly after: work that finished at the instant you left was work you
  // were there for.
  if (finishedAt <= lastSeenAt) return false;
  return now - lastSeenAt >= absenceThresholdMinutes * MS_PER_MINUTE;
}
