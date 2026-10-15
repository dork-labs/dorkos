/**
 * Zod schemas for heartbeats: how an agent wakes between conversations, the
 * `end_beat` call a beat finishes with, and the status the Heartbeat page reads
 * (spec `heartbeats` §2, §8, canon PROACTIVE-AGENTS §5).
 *
 * `HEARTBEAT.md` is skill-shaped: YAML frontmatter plus a free markdown body.
 * Only the frontmatter is validated here. The server reads it with
 * `@dorkos/skills`' frontmatter parser and hands the data to
 * {@link HeartbeatFrontmatterSchema}; this package stays free of that parser so
 * the browser can import the same schema.
 *
 * @module shared/heartbeat-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** How an agent wakes: on a timer and on events, on events only, or never. */
export const HEARTBEAT_WAKES = ['timed', 'events', 'off'] as const;

/** How an agent wakes. */
export const HeartbeatWakeSchema = z.enum(HEARTBEAT_WAKES).openapi('HeartbeatWake');

/** How an agent wakes. */
export type HeartbeatWake = z.infer<typeof HeartbeatWakeSchema>;

/** The gatherers a beat can run, in the order a beat reads them (spec §5). */
export const HEARTBEAT_GATHERERS = [
  'addressed',
  'commitments',
  'schedules',
  'health',
  'workspace',
] as const;

/** One gatherer's name. */
export const HeartbeatGathererSchema = z.enum(HEARTBEAT_GATHERERS).openapi('HeartbeatGatherer');

/** One gatherer's name. */
export type HeartbeatGatherer = z.infer<typeof HeartbeatGathererSchema>;

/**
 * What a beat watches when `HEARTBEAT.md` names nothing: every gatherer but
 * `workspace`, which reads git and is opted into.
 */
export const DEFAULT_HEARTBEAT_WATCH: readonly HeartbeatGatherer[] = [
  'addressed',
  'commitments',
  'schedules',
  'health',
];

/** How often an agent reports up. */
export const HEARTBEAT_REPORTS = ['daily', 'weekly', 'off'] as const;

/** How often an agent reports up. */
export const HeartbeatReportSchema = z.enum(HEARTBEAT_REPORTS).openapi('HeartbeatReport');

/** How often an agent reports up. */
export type HeartbeatReport = z.infer<typeof HeartbeatReportSchema>;

/**
 * A sweep interval: hours and minutes, like `4h` or `1h30m`. At least
 * {@link HEARTBEAT_SWEEP_MIN_MS}, so a typo cannot turn every beat into a turn.
 */
const SweepSchema = z
  .string()
  .max(16)
  .regex(/^(\d{1,3}h)?(\d{1,4}m)?$/, 'Use hours and minutes, like "4h" or "1h30m".')
  .refine((value) => value.length > 0, 'Use hours and minutes, like "4h" or "1h30m".')
  .refine(
    (value) => parseHeartbeatInterval(value) >= HEARTBEAT_SWEEP_MIN_MS,
    'A sweep runs at most every 30 minutes.'
  );

/** The shortest sweep interval: thirty minutes. */
export const HEARTBEAT_SWEEP_MIN_MS = 30 * 60 * 1000;

/**
 * An interval like `4h` or `1h30m`, in milliseconds. Returns 0 for anything
 * else; validate with {@link HeartbeatFrontmatterSchema} first.
 *
 * @param value - The interval as written in `HEARTBEAT.md`.
 */
export function parseHeartbeatInterval(value: string): number {
  const match = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?$/.exec(value);
  if (!match) return 0;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  return (hours * 60 + minutes) * 60 * 1000;
}

/**
 * The frontmatter of `HEARTBEAT.md`. Every field is optional; what an absent one
 * means is {@link resolveHeartbeatSettings}'s job. Unknown keys are ignored, so
 * a newer DorkOS can add one without an older one refusing the file.
 */
export const HeartbeatFrontmatterSchema = z
  .object({
    name: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    wake: HeartbeatWakeSchema.optional(),
    watch: z.array(HeartbeatGathererSchema).max(HEARTBEAT_GATHERERS.length).optional(),
    report: HeartbeatReportSchema.optional(),
    sweep: SweepSchema.optional(),
  })
  .openapi('HeartbeatFrontmatter');

/** The frontmatter of `HEARTBEAT.md`, as validated. */
export type HeartbeatFrontmatter = z.infer<typeof HeartbeatFrontmatterSchema>;

/** What a beat runs with once every absent field has its meaning. */
export interface HeartbeatSettings {
  /** How the agent wakes. No file, or no `wake:`, means events. */
  wake: HeartbeatWake;
  /** Which gatherers run, de-duplicated, in registry order. */
  watch: HeartbeatGatherer[];
  /** How often it reports up. */
  report: HeartbeatReport;
  /** The sweep interval in milliseconds, or null when it never sweeps. */
  sweepMs: number | null;
}

/**
 * The settings a beat runs with, from validated frontmatter or none (spec §2:
 * "No file means events").
 *
 * @param frontmatter - The validated frontmatter, or null when there is no file.
 */
export function resolveHeartbeatSettings(
  frontmatter: HeartbeatFrontmatter | null
): HeartbeatSettings {
  const watch = frontmatter?.watch ?? DEFAULT_HEARTBEAT_WATCH;
  return {
    wake: frontmatter?.wake ?? 'events',
    watch: HEARTBEAT_GATHERERS.filter((name) => watch.includes(name)),
    report: frontmatter?.report ?? 'daily',
    sweepMs: frontmatter?.sweep ? parseHeartbeatInterval(frontmatter.sweep) : null,
  };
}

/** The `HEARTBEAT.md` templates DorkOS ships, one per agent type (canon §9.1). */
export const HEARTBEAT_TEMPLATE_IDS = ['lead', 'doer', 'coder'] as const;

/** A heartbeat template's id. */
export const HeartbeatTemplateIdSchema = z
  .enum(HEARTBEAT_TEMPLATE_IDS)
  .openapi('HeartbeatTemplateId');

/** A heartbeat template's id. */
export type HeartbeatTemplateId = z.infer<typeof HeartbeatTemplateIdSchema>;

// ---------------------------------------------------------------------------
// end_beat (spec §8)
// ---------------------------------------------------------------------------

/** The longest record line a beat may leave. */
export const END_BEAT_SUMMARY_MAX = 200;

/** The longest one raise's text may be. */
export const END_BEAT_RAISE_TEXT_MAX = 2000;

/** The most raises one beat may hand over. */
export const END_BEAT_RAISES_MAX = 10;

/**
 * How loudly a raise reaches its reader, quietest first (canon P5, rungs 2–5).
 * Rung 1, the record, is the beat's summary.
 */
export const RAISE_RUNGS = ['report', 'room', 'dm', 'note'] as const;

/** One raise rung. */
export const RaiseRungSchema = z.enum(RAISE_RUNGS).openapi('HeartbeatRaiseRung');

/** One raise rung. */
export type RaiseRung = z.infer<typeof RaiseRungSchema>;

/** One thing a beat raises. */
export const EndBeatRaiseSchema = z
  .object({
    text: z.string().trim().min(1).max(END_BEAT_RAISE_TEXT_MAX),
    to: z.string().min(1).max(200).optional(),
    rung: RaiseRungSchema,
    roomId: z.string().min(1).optional(),
    urgent: z.boolean().optional(),
    about: z.array(z.string().min(1).max(300)).max(50).optional(),
    key: z.string().min(1).max(300).optional(),
  })
  .refine((raise) => raise.rung !== 'room' || Boolean(raise.roomId), {
    message: 'A room raise needs roomId.',
    path: ['roomId'],
  });

/** One thing a beat raises. */
export type EndBeatRaise = z.infer<typeof EndBeatRaiseSchema>;

/** The fastest pace an agent may ask for, in minutes. */
export const BEAT_PACE_MIN_MINUTES = 5;

/** The slowest asked-for pace, in minutes. */
export const BEAT_PACE_MAX_MINUTES = 60;

/** How long an asked-for pace may last: twelve hours. */
export const BEAT_PACE_MAX_MS = 12 * 60 * 60 * 1000;

/** A faster beat the agent asks for, for a while. */
export const BeatPaceSchema = z.object({
  everyMinutes: z.number().int().min(BEAT_PACE_MIN_MINUTES).max(BEAT_PACE_MAX_MINUTES),
  untilIso: z
    .string()
    .datetime({ offset: true })
    // A minute of slack for clocks; the runner clamps what it stores as well.
    .refine((iso) => Date.parse(iso) <= Date.now() + BEAT_PACE_MAX_MS + 60_000, {
      message: 'A faster pace lasts at most 12 hours.',
    }),
  why: z.string().trim().min(1).max(300),
});

/** A faster beat the agent asks for, for a while. */
export type BeatPace = z.infer<typeof BeatPaceSchema>;

/** What a beat finishes with. */
export const EndBeatInputSchema = z.object({
  summary: z.string().trim().min(1).max(END_BEAT_SUMMARY_MAX),
  raises: z.array(EndBeatRaiseSchema).max(END_BEAT_RAISES_MAX).optional(),
  resolved: z.array(z.string().min(1).max(300)).max(50).optional(),
  report: z.string().max(8000).nullable().optional(),
  pace: BeatPaceSchema.optional(),
});

/** What a beat finishes with. */
export type EndBeatInput = z.infer<typeof EndBeatInputSchema>;

// ---------------------------------------------------------------------------
// Status, for the Heartbeat page (GET /api/agents/:id/heartbeat)
// ---------------------------------------------------------------------------

/** How a beat ended (spec §11). */
export const BEAT_OUTCOMES = [
  'quiet',
  'queued',
  'worked',
  'no-end-beat',
  'failed',
  'refused',
  'skipped',
] as const;

/** How a beat ended. */
export const BeatOutcomeSchema = z.enum(BEAT_OUTCOMES).openapi('BeatOutcome');

/** How a beat ended. */
export type BeatOutcome = z.infer<typeof BeatOutcomeSchema>;

/** What kind of beat it was (spec §3.4). */
export const BeatKindSchema = z.enum(['pulse', 'sweep', 'report']).openapi('BeatKind');

/** What kind of beat it was. */
export type BeatKind = z.infer<typeof BeatKindSchema>;

/** One past beat, as the Heartbeat page lists it. */
export const BeatSummarySchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    kind: BeatKindSchema,
    /** `timer`, `startup`, or `event:<type>`. */
    wake: z.string(),
    outcome: BeatOutcomeSchema,
    /** The record line. */
    summary: z.string(),
    raises: z.number().int(),
    /** The beat chat, when a turn ran. */
    sessionId: z.string().nullable(),
  })
  .openapi('BeatSummary');

/** One past beat. */
export type BeatSummary = z.infer<typeof BeatSummarySchema>;

/** One raise held for a person's hours. */
export const HeldRaiseSchema = z
  .object({
    id: z.string(),
    to: z.string(),
    rung: RaiseRungSchema,
    /** The words, for the reader it is held for (the owner); null for anyone else. */
    text: z.string().nullable(),
    deliverAfter: z.string(),
    createdAt: z.string(),
  })
  .openapi('HeldRaise');

/** One raise held for a person's hours. */
export type HeldRaise = z.infer<typeof HeldRaiseSchema>;

/** An agent's next report (spec §3.4, §9.3). */
export const HeartbeatReportStatusSchema = z
  .object({
    /** How often it reports, from its `HEARTBEAT.md`. */
    cadence: HeartbeatReportSchema,
    /** Who reads it: a person's account id or an agent's mesh id. */
    to: z.string(),
    /** When its next report beat runs, or null when none is scheduled. */
    nextReportAt: z.string().nullable(),
    /** What the next report covers so far: queued lines plus beat turns since the last one. */
    items: z.number().int(),
  })
  .openapi('HeartbeatReportStatus');

/** An agent's next report. */
export type HeartbeatReportStatus = z.infer<typeof HeartbeatReportStatusSchema>;

/**
 * Where an agent's cheap checks run, live, and what they used today (spec §6.3,
 * §7.6). Never the configured choice alone: credits that dropped out read as
 * the runtime.
 */
export const HeartbeatChecksSchema = z
  .object({
    /** Where the next check runs: on DorkOS credits, or on the agent's own runtime. */
    runsOn: z.enum(['credits', 'runtime']),
    /** The agent's runtime type, for "Checks run on {runtime}." */
    runtime: z.string(),
    /** Checks this agent ran on credits today, in its chain person's day. */
    today: z.number().int(),
    /** The tokens those checks used. */
    tokens: z.number().int(),
    /**
     * Whether to show the one-time "Run cheap checks on DorkOS credits?" card:
     * linked, nobody has answered, and the viewer owns this install.
     */
    offer: z.boolean(),
  })
  .openapi('HeartbeatChecks');

/** Where an agent's cheap checks run, and what they used today. */
export type HeartbeatChecks = z.infer<typeof HeartbeatChecksSchema>;

/**
 * One measured share (spec §13): `part` of `whole`, beside canon §6.1's
 * starting target. The target is a bet to compare against, never a grade.
 */
export const MeasureRateSchema = z
  .object({
    /** `part ÷ whole`, from 0 to 1, or null when there was nothing to count. */
    value: z.number().nullable(),
    part: z.number().int(),
    whole: z.number().int(),
    /** The starting target, in words ("95% or more"). */
    target: z.string(),
    /** What it is counted from, in one plain line. */
    source: z.string(),
  })
  .openapi('MeasureRate');

/** One measured share. */
export type MeasureRate = z.infer<typeof MeasureRateSchema>;

/**
 * Whether an agent's work on its own helped, over a window (spec §13, canon
 * §6). Computed on read from the beat record, the outbox, commitments and the
 * audit trail; nothing comes from the agent's own account of itself.
 */
export const HeartbeatMeasuresSchema = z
  .object({
    /** How many days back it counts. */
    windowDays: z.number().int(),
    /** Where the window starts (ISO 8601). */
    since: z.string(),
    /** Beat turns that acted and were not undone within 7 days. */
    keptRate: MeasureRateSchema,
    /** Raises to people answered or reacted to (not 👎) within 48 hours. */
    usefulRaiseRate: MeasureRateSchema,
    /** Messages that reached people ÷ (kept actions + useful raises). */
    interruptions: z.object({
      /** The ratio, or null when there was no useful outcome to divide by. */
      value: z.number().nullable(),
      messages: z.number().int(),
      usefulOutcomes: z.number().int(),
      target: z.string(),
      source: z.string(),
    }),
    /** Not computed in v1: it needs the manager to say so. */
    surprises: z.object({ measured: z.literal(false), source: z.string() }),
    /** Times a person paused it, switched its heartbeat off, or muted it. */
    mutesAndPauses: z.object({
      total: z.number().int(),
      pauses: z.number().int(),
      wakeOff: z.number().int(),
      mutes: z.number().int(),
      target: z.string(),
      source: z.string(),
    }),
    /** Canon §6.2's supporting measures that the record can answer today. */
    supporting: z.object({
      /** Beats that ran (not skipped) in the window. */
      beats: z.number().int(),
      /** Beats that ended with nothing raised. */
      quietBeats: MeasureRateSchema,
      /** Promises that came due in the window and were kept by their date. */
      commitmentsOnTime: MeasureRateSchema,
      /** Beat turns that ended without `end_beat`. */
      noEndBeat: z.number().int(),
      /** Cheap checks on a decision model, and their tokens. */
      triage: z.object({ checks: z.number().int(), tokens: z.number().int() }),
      /** Beat turns, and tokens per turn where the runtime reported them (else null). */
      turns: z.object({ count: z.number().int(), tokensPerTurn: z.number().nullable() }),
      /** Room posts and notes its beat turns made around `end_beat`. */
      bypass: z.number().int(),
      /** Messages to people still held for their hours. */
      held: z.number().int(),
    }),
  })
  .openapi('HeartbeatMeasures');

/** Whether an agent's work on its own helped. */
export type HeartbeatMeasures = z.infer<typeof HeartbeatMeasuresSchema>;

/** The answer to `PUT /api/heartbeats/triage-credits`: a person's answer to the offer. */
export const TriageCreditsChoiceSchema = z
  .object({
    /** `true` is **Use credits**; `false` is **Not now**. */
    useCredits: z.boolean(),
  })
  .openapi('TriageCreditsChoice');

/** A person's answer to the offer. */
export type TriageCreditsChoice = z.infer<typeof TriageCreditsChoiceSchema>;

/** The answer to GET /api/agents/:id/heartbeat. */
export const HeartbeatStatusSchema = z
  .object({
    /** Whether heartbeats run on this server at all (`heartbeats.enabled`). */
    enabled: z.boolean(),
    /** How this agent wakes, from its `HEARTBEAT.md`. */
    wake: HeartbeatWakeSchema,
    /** When its next timed beat is due, or null when none is scheduled. */
    nextBeatAt: z.string().nullable(),
    /** Why it does not beat, when it does not. */
    skippedReason: z.string().nullable(),
    /**
     * Why the settings at the top of `HEARTBEAT.md` do not read, as the parser
     * said it (`wake: Invalid enum value…`), or null when they do or there is
     * no file. The last good settings stay in force (spec §2).
     */
    fileError: z.string().nullable(),
    /** Its last beats, newest first. */
    lastBeats: z.array(BeatSummarySchema),
    /** Raises to people still held for their hours. */
    held: z.array(HeldRaiseSchema),
    /** Its next report. */
    report: HeartbeatReportStatusSchema,
    /** Where its cheap checks run, and what they used today. */
    checks: HeartbeatChecksSchema,
    /** Whether its work on its own helped, over the last 7 days (spec §13). */
    measures: HeartbeatMeasuresSchema,
  })
  .openapi('HeartbeatStatus');

/** The answer to GET /api/agents/:id/heartbeat. */
export type HeartbeatStatus = z.infer<typeof HeartbeatStatusSchema>;
