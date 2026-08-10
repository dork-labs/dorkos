import { describe, it, expect } from 'vitest';
import { isWelcomeBackMoment, type WelcomeBackMomentInput } from '../welcome-back-glow';

/** Epoch anchors, so every case below reads as a clock rather than a number. */
const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** A four-hour absence with work that landed in the middle of it. */
function moment(overrides: Partial<WelcomeBackMomentInput> = {}): WelcomeBackMomentInput {
  return {
    finishedAt: NOW - 90 * MINUTE,
    lastSeenAt: NOW - 240 * MINUTE,
    absenceThresholdMinutes: 240,
    now: NOW,
    ...overrides,
  };
}

describe('isWelcomeBackMoment (BC-49)', () => {
  it('glows for work that finished while you were away', () => {
    expect(isWelcomeBackMoment(moment())).toBe(true);
  });

  it('stays quiet for an absence shorter than the threshold you set', () => {
    // One minute under. The threshold is the user's own
    // `welcomeBack.absenceThresholdMinutes` — there is no second one.
    expect(isWelcomeBackMoment(moment({ lastSeenAt: NOW - 239 * MINUTE }))).toBe(false);
    // …and exactly ON it counts as away: four hours away is the four hours the
    // setting names.
    expect(isWelcomeBackMoment(moment({ lastSeenAt: NOW - 240 * MINUTE }))).toBe(true);
  });

  it('follows the threshold rather than a number of its own', () => {
    const away = moment({ lastSeenAt: NOW - 30 * MINUTE, finishedAt: NOW - 10 * MINUTE });
    expect(isWelcomeBackMoment({ ...away, absenceThresholdMinutes: 240 })).toBe(false);
    expect(isWelcomeBackMoment({ ...away, absenceThresholdMinutes: 15 })).toBe(true);
  });

  it('stays quiet for work you watched finish before you left', () => {
    // Finished BEFORE the last visit — you were there for it. And the instant
    // of the visit itself counts as "you were there".
    expect(isWelcomeBackMoment(moment({ finishedAt: NOW - 300 * MINUTE }))).toBe(false);
    expect(isWelcomeBackMoment(moment({ finishedAt: NOW - 240 * MINUTE }))).toBe(false);
  });

  it('stays quiet for work that has not finished', () => {
    // A session still mid-turn is not something to come back to — it is
    // something to watch, and the verb line is already saying so.
    expect(isWelcomeBackMoment(moment({ finishedAt: null }))).toBe(false);
  });

  it('treats a first visit as a first visit, not as an infinite absence', () => {
    // With no record of a previous visit, "how long were you away" has no
    // answer. Guessing "forever" would light up every finished row on a fresh
    // install, which is the opposite of a welcome.
    expect(isWelcomeBackMoment(moment({ lastSeenAt: null }))).toBe(false);
  });

  it('glows at nothing when the setting is not in force', () => {
    // `useWelcomeBack()` reports 0 on a server that does not carry the block
    // and in Obsidian. Without this guard a zero threshold is satisfied by
    // every absence, including one of no time at all — every finished row in
    // the sidebar would glow, forever, on every install that lacks the setting.
    expect(isWelcomeBackMoment(moment({ absenceThresholdMinutes: 0 }))).toBe(false);
    expect(isWelcomeBackMoment(moment({ absenceThresholdMinutes: -5 }))).toBe(false);
    // Proof the guard is what did it: the same case with the setting in force
    // is a homecoming.
    expect(isWelcomeBackMoment(moment({ absenceThresholdMinutes: 1 }))).toBe(true);
  });
});
