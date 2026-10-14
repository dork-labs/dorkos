/**
 * The rules that decide whether DorkOS holds this computer awake on its own,
 * apart from the work it counts (DOR-2920): the mode, a timed session, and the
 * two power rules. Pure functions of the settings, the clock and one power
 * reading, so the whole matrix can be tested without a timer or a process.
 *
 * The computer is held when:
 *
 * 1. a timed session is running (`manualUntil` is in the future), which wins
 *    even over mode `off`; or
 * 2. the mode is `always`; or
 * 3. the mode is `agents` and some work is open (the service counts that).
 *
 * …unless a power rule says stop: on battery with `onlyOnPower`, or on battery
 * below `stopBelowBatteryPercent`. A reading that says nothing (no battery, a
 * tool that failed) never stops it: a rule acts on what is known, not a guess.
 *
 * @module services/core/keep-awake/keep-awake-policy
 */
import type { PowerReading } from '@dorkos/keep-awake';
import type { KeepAwakeBlocked, KeepAwakeMode } from '@dorkos/shared/schemas';

/** The `keepAwake` config section, as far as the service reads it. */
export interface KeepAwakeSettings {
  /** When to hold the computer awake on its own. */
  mode: KeepAwakeMode;
  /** The end of a timed session (ISO 8601), or null. A past one is over. */
  manualUntil: string | null;
  /** Keep the screen on too while anything is held. */
  keepDisplayAwake: boolean;
  /** On battery, stop below this charge. Null: never for the charge. */
  stopBelowBatteryPercent: number | null;
  /** Hold only while plugged in. */
  onlyOnPower: boolean;
}

/** The settings when the section cannot be read: what a fresh install ships. */
export const DEFAULT_KEEP_AWAKE_SETTINGS: KeepAwakeSettings = {
  mode: 'agents',
  manualUntil: null,
  keepDisplayAwake: false,
  stopBelowBatteryPercent: null,
  onlyOnPower: false,
};

/**
 * Read the settings, never throwing: a reader that throws, or a section missing
 * a leaf, falls back to the shipped defaults leaf by leaf.
 *
 * @param read - Reads the stored section.
 */
export function readKeepAwakeSettings(read: () => Partial<KeepAwakeSettings>): KeepAwakeSettings {
  try {
    return { ...DEFAULT_KEEP_AWAKE_SETTINGS, ...read() };
  } catch {
    return { ...DEFAULT_KEEP_AWAKE_SETTINGS };
  }
}

/**
 * The end of the timed session in force, or null when none is: never started,
 * already over, or not a date at all.
 *
 * @param settings - The current settings.
 * @param now - The current time in milliseconds.
 */
export function activeSessionUntil(settings: KeepAwakeSettings, now: number): string | null {
  if (!settings.manualUntil) return null;
  const until = Date.parse(settings.manualUntil);
  return Number.isFinite(until) && until > now ? settings.manualUntil : null;
}

/**
 * Whether the computer is held for its own sake (a timed session or mode
 * `always`), apart from any work.
 *
 * @param settings - The current settings.
 * @param now - The current time in milliseconds.
 */
export function holdsWithoutWork(settings: KeepAwakeSettings, now: number): boolean {
  return settings.mode === 'always' || activeSessionUntil(settings, now) !== null;
}

/**
 * Whether open work may be held at all: the mode is not `off`, or a timed
 * session is running (which holds the computer anyway).
 *
 * @param settings - The current settings.
 * @param now - The current time in milliseconds.
 */
export function holdsForWork(settings: KeepAwakeSettings, now: number): boolean {
  return settings.mode !== 'off' || activeSessionUntil(settings, now) !== null;
}

/**
 * Whether either power rule is set, so the power source has to be read.
 *
 * @param settings - The current settings.
 */
export function hasPowerRule(settings: KeepAwakeSettings): boolean {
  return settings.onlyOnPower || settings.stopBelowBatteryPercent !== null;
}

/**
 * Which power rule stops keeping awake right now, or null when none does. On
 * mains, or with nothing known, nothing stops it. `on-battery` names the
 * broader rule when both apply.
 *
 * @param settings - The current settings.
 * @param reading - The last power reading, or null when unknown.
 */
export function powerBlock(
  settings: KeepAwakeSettings,
  reading: PowerReading | null
): KeepAwakeBlocked | null {
  if (!reading || reading.onAc) return null;
  if (settings.onlyOnPower) return 'on-battery';
  const floor = settings.stopBelowBatteryPercent;
  if (floor !== null && reading.percent !== null && reading.percent < floor) return 'low-battery';
  return null;
}
