/**
 * When a schedule runs, when two things can say so (DOR-2302).
 *
 * A schedule's row caches its SKILL.md, and for almost every schedule the
 * file's `cron` and `timezone` are simply the timing. A schedule that came with
 * an installed package is the exception: its file is the package's, DorkOS
 * never writes it, and the next update would replace it anyway. So a person's
 * own timing for it is kept on the row — `cron_override` and
 * `timezone_override` — beside the file's, which stays the default and which
 * every sync keeps writing.
 *
 * ## Why one module
 *
 * Two sources of timing on one row is exactly the shape that drifts: one reader
 * forgets the override and runs the package's timing, another remembers it, and
 * the approval grant — keyed on `[prompt, cron, timezone]` — is recorded against one and
 * checked against the other. So the rule "the override wins" is written once,
 * here, and everything that reads the raw columns goes through it: the row
 * mapper (which is how the scheduler, the registrar, the preview and the API
 * see it), the grant writer, and the file-sync gates.
 *
 * Its own directory because `services/tasks` is past the file-count ceiling;
 * `execution/` set the precedent.
 *
 * @module services/tasks/timing/effective-timing
 */
import { scheduleContentKey } from '../schedule-permission-clamp.js';

/** The four columns that decide when a schedule runs, as a row carries them. */
export interface TimingColumns {
  /** The file's cron, `''` for a schedule with no timer. */
  cron: string;
  /** The file's timezone. */
  timezone: string;
  /** A person's own cron, `''` meaning "on demand", or NULL for the file's. */
  cronOverride: string | null;
  /** A person's own timezone, or NULL for the file's. */
  timezoneOverride: string | null;
}

/** The timing a schedule actually runs on. */
export interface EffectiveTiming {
  /** The cron that runs, `''` for none. */
  cron: string;
  /** The timezone it runs in. */
  timezone: string;
}

/**
 * The timing a schedule runs on: a person's own where they set one, otherwise
 * its file's — each half on its own, so a timezone alone can be changed.
 *
 * @param row - The row's four timing columns.
 * @returns The cron and timezone that run.
 */
export function effectiveTiming(row: TimingColumns): EffectiveTiming {
  return {
    cron: row.cronOverride ?? row.cron,
    timezone: row.timezoneOverride ?? row.timezone,
  };
}

/**
 * The approval key of what this row actually runs.
 *
 * The same `[prompt, cron, timezone]` key both content gates share
 * ({@link scheduleContentKey}), with cron and timezone meaning the ones that
 * run. A person approving a schedule approved WHEN it runs, so a grant
 * recorded against the package's timing while the person's ran would cover
 * work nobody looked at.
 *
 * @param row - The row's prompt and its four timing columns.
 * @returns The content key to record or compare a grant against.
 */
export function effectiveContentKey(row: TimingColumns & { prompt: string }): string {
  const { cron, timezone } = effectiveTiming(row);
  return scheduleContentKey({ prompt: row.prompt, cron, timezone });
}

/**
 * Where an update's `cron` and `timezone` are written.
 *
 * `file` is every schedule whose SKILL.md DorkOS writes: the timing goes into
 * the file and the row's cache of it. `row` is a schedule an installed package
 * owns: the file is left alone and the timing becomes the row's override.
 */
export type TimingLandsOn = 'file' | 'row';

/** The timing fields an update request can carry. */
export interface TimingRequest {
  /** A new cron; `null` means "no timer". */
  cron?: string | null;
  /** A new timezone; `null` means "the default". */
  timezone?: string | null;
  /** Put the schedule back on its file's own timing. */
  resetTiming?: true;
}

/**
 * The column writes one update makes to a row's timing.
 *
 * - **A reset** clears both overrides, so the file's timing runs again.
 * - **Landing on the row** writes the overrides. A value equal to the file's
 *   is stored as no override at all: choosing the package's own timing is not
 *   a custom timing, and the Schedules page should not mark it as one. `cron:
 *   null` stores `''` — the person took it off its timer — and `timezone:
 *   null` stores no override, since "the default" IS the file's.
 * - **Landing on the file** writes the default columns exactly as an update
 *   always has, and clears that field's override: the file now says the new
 *   timing, and an override left behind would silently beat it.
 *
 * A value that is already what runs writes nothing, on either path.
 *
 * A request carrying a reset AND a timing is refused before it gets here
 * ({@link conflictingTimingRequest}); should one arrive anyway, the reset is
 * applied first and the explicit timing on top of it, which is the only order
 * that does not throw away something the caller said.
 *
 * @param row - The row's timing columns as they stand.
 * @param request - The timing fields the update carries.
 * @param landsOn - Where this schedule's timing is written.
 * @returns The columns to set; empty when the request says nothing about timing.
 */
export function timingColumnWrites(
  row: TimingColumns,
  request: TimingRequest,
  landsOn: TimingLandsOn
): Partial<TimingColumns> {
  const writes: Partial<TimingColumns> = {};
  if (request.resetTiming) {
    writes.cronOverride = null;
    writes.timezoneOverride = null;
  }

  // Measured against what runs AFTER the reset, so a reset plus an explicit
  // value is judged against the file's timing it just restored.
  const current = effectiveTiming({ ...row, ...writes });

  // A value already running writes nothing. Load-bearing for a package's
  // schedule, not an optimisation: a re-sent current cron changes no field, so
  // it reaches here without anyone having asked who owns the file — as `file`
  // — and writing it would stamp the person's timing over the package's
  // default and drop their override.
  const cron = request.cron === undefined ? undefined : (request.cron ?? '');
  if (cron !== undefined && cron !== current.cron) {
    if (landsOn === 'row') {
      writes.cronOverride = cron === row.cron ? null : cron;
    } else {
      writes.cron = cron;
      writes.cronOverride = null;
    }
  }

  if (request.timezone !== undefined) {
    if (landsOn === 'row') {
      const timezone = request.timezone;
      if (timezone !== current.timezone) {
        writes.timezoneOverride = timezone === null || timezone === row.timezone ? null : timezone;
      }
    } else if ((request.timezone ?? 'UTC') !== current.timezone) {
      writes.timezone = request.timezone ?? 'UTC';
      writes.timezoneOverride = null;
    }
  }

  return writes;
}

/**
 * Refuse a request that asks for a new timing and for the package's own timing
 * in the same breath.
 *
 * @param request - The timing fields the update carries.
 * @returns The sentence to refuse with, or `null` when the request is coherent.
 */
export function conflictingTimingRequest(request: TimingRequest): string | null {
  if (!request.resetTiming) return null;
  if (request.cron === undefined && request.timezone === undefined) return null;
  return (
    'This asked for a new timing and for the package’s own timing at once. ' +
    'Send resetTiming on its own to go back to the package’s timing, or cron and timezone to change it.'
  );
}

/**
 * Why a package's schedule is waiting again after an agent changed when it
 * runs.
 *
 * Written by DorkOS, so the approval card shows it plainly rather than quoting
 * it as the agent's case. Not the sync's "this schedule's file changed", which
 * would be false: nothing touched the file.
 */
export const AGENT_TIMING_CHANGE_REASON =
  'An agent changed when this schedule runs, so it is waiting for you again. ' +
  'Check the new timing, then approve it or change it back.';
