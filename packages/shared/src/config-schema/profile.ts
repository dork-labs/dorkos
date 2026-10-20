/**
 * The person's profile: display name and where it came from, working hours, away state.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/profile
 */
import { z } from 'zod';

/**
 * Where the stored {@link UserProfileSchema} `displayName` came from (DOR-1022).
 *
 * `displayName` stays agent-writable, because DorkBot saving "call me Dorian"
 * mid-conversation is the onboarding flow rather than a loophole in it. What was
 * missing is the other half: the name an agent chose then seeded the roster, the
 * account menu and the Settings field with no sign it was not the person's own.
 * This records who wrote the value that is stored right now, so a surface can
 * say "Suggested by DorkBot" until the person saves a name themselves.
 *
 * **`null` means "no record", and it is deliberately NOT read as "an agent did
 * it".** Every install that had a name before this field existed carries `null`,
 * and flagging a name somebody has answered to for months would be a worse lie
 * than staying quiet. So only `{ kind: 'agent' }` ever draws a hint.
 *
 * `agentName` is nullable because attribution is best-effort: the writing agent
 * is named from its resolved identity, and an agent whose identity token this
 * install cannot resolve still wrote the name. A surface says "an agent" rather
 * than inventing one.
 */
export const DisplayNameSourceSchema = z.discriminatedUnion('kind', [
  /** A person saved it — through Settings › Profile, the config door or the CLI. */
  z.object({ kind: z.literal('operator') }),
  /** An agent wrote it through `config_patch`, and which one if this install knows. */
  z.object({
    kind: z.literal('agent'),
    agentName: z.string().trim().min(1).max(80).nullable(),
  }),
]);

/** Where the stored display name came from (see {@link DisplayNameSourceSchema}). */
export type DisplayNameSource = z.infer<typeof DisplayNameSourceSchema>;

/**
 * Whether a string names a time zone this runtime knows.
 *
 * Asks `Intl` rather than a list, so it agrees with the formatter every
 * working-hours computation uses (`@dorkos/shared/working-hours`): a zone `Intl`
 * cannot format is a zone nothing can compute hours in. Lives here, not in
 * `working-hours.ts`, so this module imports nothing with state (see the module
 * doc).
 *
 * @param zone - A candidate IANA zone, e.g. `"Europe/Berlin"`.
 */
export function isValidTimeZone(zone: string): boolean {
  if (zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` on a 24-hour clock, 00:00 to 23:59. */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A person's working window (spec `heartbeats` §3.5): which days, and from when
 * to when, read in their own `profile.timezone`.
 *
 * The day ends after it starts, always. A window that runs past midnight
 * (22:00–06:00) is refused rather than guessed at: which day it belongs to is a
 * question this shape cannot answer, and nobody has asked for it yet.
 */
export const WorkingHoursSchema = z
  .object({
    /** Working days, 0 = Sunday … 6 = Saturday. At least one, each once. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'Each day can appear only once.'),
    /** When the working day starts, `HH:MM`. */
    start: z.string().regex(CLOCK_PATTERN, 'Use a 24-hour time like 09:00.'),
    /** When it ends, `HH:MM`, after `start`. */
    end: z.string().regex(CLOCK_PATTERN, 'Use a 24-hour time like 17:00.'),
  })
  .refine((hours) => hours.end > hours.start, {
    message: 'The day has to end after it starts.',
    path: ['end'],
  });

/** A person's working window (see {@link WorkingHoursSchema}). */
export type WorkingHours = z.infer<typeof WorkingHoursSchema>;

/**
 * That a person is away (spec `heartbeats` §3.5, canon P4): until when, and an
 * optional note. `until: null` means away until they say otherwise.
 */
export const AwaySchema = z.object({
  /** ISO timestamp they are back, or `null` for "until further notice". */
  until: z.iso.datetime({ offset: true }).nullable(),
  /** A short note, e.g. "On holiday". */
  note: z.string().trim().min(1).max(200).optional(),
});

/** That a person is away (see {@link AwaySchema}). */
export type Away = z.infer<typeof AwaySchema>;

/**
 * What the user has told DorkOS about themselves (spec `user-profile-onboarding`).
 *
 * **Local-only by tested invariant, not by promise:** the telemetry heartbeat
 * and usage-event payloads are strict allowlists that never carry any of these
 * fields, and sentinel-value exclusion tests keep it that way. The profile is
 * used in exactly two places: a short factual `<user_profile>` block projected
 * into every session's agent context, and the pure role → recommendations
 * mapping in `@dorkos/shared/profile-recommendations`.
 *
 * The first four leaves are `expose` + `agent-writable` on purpose: agents
 * knowing and updating the profile IS the feature (DorkBot saves "call me
 * Dorian" or "I also use Figma" via `config_patch` mid-conversation).
 * {@link displayNameSource} is the one exception, and the reason is in its own
 * doc: it is the RECORD of who wrote a field rather than a preference, so an
 * agent able to write it could sign the person's name to its own suggestion.
 */
export const UserProfileSchema = z.object({
  /** What kind of work the user does. Free-form, but onboarding offers ROLE_CANON. */
  roles: z
    .array(z.string().trim().min(1).max(60))
    .max(10)
    .default(() => []),
  /** Tools/services the user works with (e.g. "Gmail", "Linear"). Not asked in onboarding v1. */
  tools: z
    .array(z.string().trim().min(1).max(60))
    .max(50)
    .default(() => []),
  /** What the user likes to be called. Optional; never required. */
  displayName: z.string().trim().min(1).max(80).nullable().default(null),
  /**
   * Who wrote the {@link displayName} that is stored right now, or `null` when
   * this install has no record (see {@link DisplayNameSourceSchema}).
   *
   * Machine-managed on every path — the profile route, the config door and the
   * `config_patch` tool all stamp it as a side effect of writing the name, and
   * no surface asks a person to choose it.
   */
  displayNameSource: DisplayNameSourceSchema.nullable().default(null),
  /**
   * ISO timestamp when the one-time existing-user prompt was dismissed
   * ("don't ask again"). Machine-managed; null = never dismissed.
   */
  rolePromptDismissedAt: z.string().nullable().default(null),
  /**
   * ISO timestamp when the person closed the one-time "what should we call
   * you?" question (DOR-677) — by saving a name or handle, or by skipping it —
   * in onboarding, the getting-started card or the sidebar prompt.
   * Machine-managed; null = never asked.
   *
   * One fact for all three surfaces, and written on a save as well as on a
   * skip: a person who saved a name and left the handle empty has answered, and
   * asking again would be nagging. The name and the handle themselves live on
   * the profile route and the author row, never here — this only records that
   * the question was put. Nothing derives a handle when it is absent (DOR-604).
   */
  identityPromptDismissedAt: z.string().nullable().default(null),
  /**
   * The person's IANA time zone (spec `heartbeats` §3.5), or `null` while the
   * app has not told the server one. The app fills it from the browser the
   * first time it opens after an upgrade, and never overwrites a set value, so
   * a server in a container or on another host never decides it. Until then
   * the server's own zone stands in.
   */
  timezone: z
    .string()
    .refine(isValidTimeZone, 'Use a time zone name like Europe/Berlin.')
    .nullable()
    .default(null),
  /** When the person works, or `null` for Monday to Friday, 09:00 to 17:00. */
  workingHours: WorkingHoursSchema.nullable().default(null),
  /** That the person is away, or `null` when they are not (see {@link AwaySchema}). */
  away: AwaySchema.nullable().default(null),
});

/** What the user has told DorkOS about themselves (see {@link UserProfileSchema}). */
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** Frozen defaults for the {@link UserProfileSchema} block (empty on a fresh install). */
export const USER_PROFILE_DEFAULTS: UserProfile = UserProfileSchema.parse({});
