import { z } from 'zod';
// The dependency-free constants module, never `@dorkos/shared/schemas`. The
// effort ladder is ONE list by design (see `EFFORT_LEVELS`), and this package
// ships to the browser through the barrel — the DRIFT NOTE below is about the
// permission modes, which live in the heavy module and are mirrored instead.
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { DurationSchema } from './duration.js';
import { coerceYamlBoolean } from './yaml-boolean.js';

/**
 * The permission modes a schedule may declare in its `permissions:`
 * frontmatter — the same set a chat session may run under.
 *
 * DRIFT NOTE: an inlined mirror of `PermissionModeSchema`
 * (`packages/shared/src/schemas.ts`) by value. This module ships to the browser
 * through the barrel and stays deliberately light, and importing that schema at
 * runtime would pull all of `@dorkos/shared/schemas` in behind it for six
 * strings. `__tests__/schedule-schema.test.ts` reads
 * `PermissionModeSchema.options` — a test-only import, which costs the bundle
 * nothing — and asserts the two sets are equal, so they cannot drift apart.
 *
 * `@dorkos/marketplace` re-exports this as `SCHEDULE_PERMISSION_MODES`
 * rather than keeping a third copy: what a Shape manifest may declare for a
 * schedule is exactly what the schedule's file may then carry, and a manifest
 * allowed to declare a mode the file cannot hold writes an unreadable file.
 *
 * The name keeps saying "TASK" because the REST paths, MCP tool ids and DB
 * tables do (spec `universal-scheduled-tasks` §Non-Goals): only the words a
 * person reads changed to "scheduled task", never the identifiers.
 */
export const TASK_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'auto',
] as const;

/** Default IANA timezone a schedule's cron is evaluated in. */
const DEFAULT_TIMEZONE = 'UTC';

/** Default permission mode a scheduled run executes under. */
const DEFAULT_PERMISSIONS = 'acceptEdits';

/**
 * The `schedule:` block that turns any skill into a scheduled task.
 *
 * **Presence is the switch.** A skill whose frontmatter carries this block is
 * a scheduled task; remove the block and the same file is a plain skill again.
 * Being scheduled is a property of the file, not of where it sits on disk (ADR
 * `260823-200724`, spec `universal-scheduled-tasks` §1).
 *
 * `cron` absent means the schedule is **on-demand**: it exists, it can be run
 * by hand or by another agent, and nothing fires it on a clock.
 *
 * **Validation here is SHAPE only.** `cron` is checked for being a non-empty
 * string and `timezone` for being a non-empty string — nothing in this package
 * asks whether either one is *meaningful*. Cron semantics are croner's
 * question and are answered at the server seam
 * (`apps/server/src/services/tasks/cron-validation.ts`), which is where croner
 * lives: this package ships to the browser through the barrel and must stay
 * dependency-light.
 *
 * @example
 * A skill that also runs itself every weekday morning. Everything below `name`
 * and `description` is the block; drop it and the same file is a plain skill.
 *
 * ```yaml
 * ---
 * name: daily-health-check
 * description: Runs lint, tests, and type checks and reports what broke
 * schedule:
 *   cron: '0 9 * * 1-5'
 *   timezone: America/New_York
 *   max-runtime: 20m
 * ---
 * Run lint, the test suite, and the type checker. Report anything that failed.
 * ```
 *
 * @example
 * On-demand only: no `cron`, so nothing fires it on a clock, but it can still be
 * run by hand or by another agent.
 *
 * ```yaml
 * schedule: {}
 * ```
 */
export const ScheduleBlockSchema = z.object({
  /**
   * Cron expression that fires the schedule. Absent means on-demand only.
   *
   * An empty string is rejected rather than degraded to absent: silently
   * dropping a broken cron would turn a schedule the author meant to fire into
   * one that never does, which is worse than the file parking with a
   * validation warning.
   */
  cron: z.string().min(1).optional(),

  /** IANA timezone the cron is evaluated in. */
  timezone: z.string().min(1).default(DEFAULT_TIMEZONE),

  /**
   * The author's intent: whether this schedule should run at all. Reads the
   * YAML 1.1 boolean words (`no`, `off`, a quoted `"false"`) the same way the
   * rest of the frontmatter does, and an unreadable value falls back to
   * enabled — the same answer as leaving the field out.
   *
   * Intent is not permission: a file-discovered schedule still parks for
   * approval before it is ever armed, `enabled: true` or not.
   */
  enabled: z.preprocess(coerceYamlBoolean, z.boolean()).default(true).catch(true),

  /** Maximum execution time. Duration string: "5m", "1h", "30s", "2h30m". */
  'max-runtime': DurationSchema.optional(),

  /**
   * Whether every run of this schedule picks up the SAME conversation instead of
   * starting a new one each time.
   *
   * Off (the default) is how a schedule has always worked: each run is its own
   * fresh session and remembers nothing from the run before. Turn it on and every
   * run resumes one lasting session, so the agent can say things like "since I
   * last ran, here's what changed" — it keeps the thread going across runs.
   *
   * Reads the YAML 1.1 boolean words (`yes`, `on`, a quoted `"true"`) the same way
   * the rest of the frontmatter does, and a value it cannot read falls back to
   * off, which is the same as leaving the field out.
   */
  sticky: z.preprocess(coerceYamlBoolean, z.boolean()).default(false).catch(false),

  /**
   * Agent permission mode during a scheduled run. One of
   * {@link TASK_PERMISSION_MODES}.
   *
   * **A mode id is a request, not a description.** What each one actually does
   * is declared by the runtime the run happens on
   * (`PermissionModeDescriptor.promise` in its capability profile), and the same
   * id can mean materially different things: `acceptEdits` on Claude Code edits
   * files and stops before a command, while on Codex it runs commands inside the
   * workspace too and cannot pause to ask at all. Read the runtime's profile —
   * or the Trust Dial, which renders it — for the sentence that is true for a
   * given schedule.
   *
   * What holds across runtimes:
   *
   * - `default`: the most careful setting the runtime offers.
   * - `acceptEdits` (the schema default): the agent changes files on its own.
   * - `plan`: read-only planning; nothing is written.
   * - `bypassPermissions`: nothing asks. The run does whatever it decides to.
   * - `auto`, `dontAsk`: the remaining runtime modes, carried through as-is.
   *
   * A scheduled run is unattended, so nobody answers an approval it raises. It
   * is **refused** after `SESSIONS.INTERACTION_TIMEOUT_MS` (10 minutes) and the
   * turn carries on without it — it does not stall until `max-runtime`. A long
   * run under a strict mode therefore finishes, having quietly spent ten
   * minutes per ask and skipped the work behind each one. The stricter modes
   * trade throughput for safety, deliberately; budget `max-runtime` for the
   * asks you expect.
   *
   * A scheduled run is the ONE exception to parking: an interactive session
   * holds an unanswered prompt for four hours so a person can come back to it,
   * and a run nobody is watching has nobody to come back.
   */
  permissions: z.enum(TASK_PERMISSION_MODES).default(DEFAULT_PERMISSIONS),

  /**
   * What to send when the schedule fires, instead of the skill's body.
   *
   * Absent means the body is the prompt — the ordinary case, and the only one
   * a skill written for people to read should need. Set it when the same file
   * has to teach a person one thing and tell an unattended run another.
   */
  prompt: z.string().min(1).optional(),

  /**
   * Provenance marker: where this schedule came from. `shape` = stood up by a
   * Shape apply (DOR-355); `plugin` = shipped by an installed marketplace
   * plugin. Absent = a person wrote it.
   *
   * The Shape re-bind flow only re-targets schedules carrying this marker, so
   * a person's own schedule can never be hijacked by a name collision with a
   * packaged one.
   */
  origin: z.enum(['shape', 'plugin']).optional(),

  /** The package (Shape or plugin) that created this schedule. Present with `origin`. */
  shape: z.string().optional(),

  /**
   * Which agent runtime a fire of this schedule runs on — `claude-code`,
   * `codex`, or `opencode`.
   *
   * Absent means "whatever the task's agent runs on", which is the answer every
   * schedule had before this field existed: the target agent's manifest
   * `runtime`, and the server's default runtime for a schedule with no agent.
   *
   * **Typed as a string rather than an enum, deliberately.** Whether a runtime
   * can take this run is a question about what is REGISTERED on the machine that
   * fires it, not about what the file says — a schedule naming a runtime this
   * build has no adapter for fails its run with a message naming the runtime
   * (`resolve-run-execution.ts`), which is a far better answer than a parse error
   * that turns the whole file into a complaint. A value that is not a string at
   * all degrades to absent, so one mistyped line never un-schedules the skill.
   */
  runtime: z.string().min(1).optional().catch(undefined),

  /**
   * The model a fire of this schedule runs on, in the RESOLVED runtime's own id
   * space (`sonnet`, `claude-opus-4-6`, `gpt-5.5`, `anthropic/claude-sonnet-4-5`).
   *
   * Absent means the agent's own model, then the server's per-runtime default,
   * then whatever the runtime picks — the same ladder every other unattended turn
   * walks (`resolveUnattendedSessionDefaults`).
   *
   * **Not validated against a catalog**, on the same accepted-at-write rule the
   * agent manifest's `model` follows: a model catalog is remote, a runtime can be
   * disconnected while somebody edits, and a spelling nothing offers is reported
   * at run time rather than refused here.
   *
   * **This is not the top-level `model:` field.** That one is the Claude Code
   * dialect and is read when a person invokes the skill by hand, so a codex or
   * opencode model id there would be handed to Claude Code. This field is the
   * scheduled fire's own answer; the top-level one is still honored as a fallback,
   * but only when the resolved runtime is claude-code.
   */
  model: z.string().min(1).optional().catch(undefined),

  /**
   * How hard the model thinks during a fire of this schedule.
   *
   * The shared {@link EFFORT_LEVELS} ladder every runtime maps into, never a
   * per-runtime fork. Absent means the agent's own effort, then the server's
   * per-runtime default. A runtime whose API has no effort at all (OpenCode)
   * drops it rather than pretending — see `resolveSessionDefaults`.
   */
  effort: z.enum(EFFORT_LEVELS).optional().catch(undefined),
});

/**
 * A validated `schedule:` block — see {@link ScheduleBlockSchema}.
 *
 * `timezone`, `enabled` and `permissions` are always present on a parsed
 * block because the schema supplies them; they are optional only in the file.
 */
export type ScheduleBlock = z.infer<typeof ScheduleBlockSchema>;

/**
 * A `schedule:` block that was there and could not be read.
 *
 * It exists so that "unreadable" is a THIRD answer, distinct from both a valid
 * block and no block at all. The distinction is the whole point: a file whose
 * schedule block is broken must keep working as a skill — it stays in the
 * model's listing, in the slash palette, and in its marketplace pack — while
 * the tasks subsystem, and only the tasks subsystem, gets to complain about it
 * (ADR `260823-200724`; spec `universal-scheduled-tasks` §User Experience).
 *
 * Before DOR-1485 a broken block degraded silently to absent, which was the
 * right trade only while nothing read it: there was no parked row to hold the
 * complaint, so the alternative was deleting the skill from three live surfaces
 * over one bad line. Discovery now provides that row.
 */
export interface InvalidSchedule {
  /** Discriminator. Always `true`; {@link isInvalidSchedule} is the test. */
  readonly invalid: true;
  /** What is wrong with the block, in a sentence for the person who typed it. */
  readonly problem: string;
}

/**
 * The `schedule:` frontmatter field after parsing: a usable block, a complaint
 * about an unusable one, or nothing at all.
 */
export type ScheduleField = ScheduleBlock | InvalidSchedule | undefined;

/**
 * Whether a parsed `schedule:` field is the complaint rather than a block.
 *
 * @param field - The parsed field.
 */
export function isInvalidSchedule(field: ScheduleField): field is InvalidSchedule {
  return field !== undefined && 'invalid' in field;
}

/**
 * Turn zod's account of a rejected block into one sentence a person can act on.
 *
 * Only the first issue is reported. A broken block is nearly always one wrong
 * line, and a reader who fixes it gets the next complaint on the next sync —
 * whereas a list of five nested zod messages is a wall nobody reads. The field
 * path is quoted because it is the thing to go and look at.
 *
 * @param error - The rejection from {@link ScheduleBlockSchema}.
 * @returns A sentence naming the field and what zod objected to.
 */
export function describeScheduleBlockProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Its schedule settings are not something DorkOS can read.';
  const field = issue.path.length > 0 ? `"${issue.path.join('.')}"` : 'schedule';
  return `Its ${field} setting is not something DorkOS can read (${issue.message}).`;
}

/**
 * Read the raw `schedule:` value from frontmatter into one of the three
 * outcomes in {@link ScheduleField}.
 *
 * **This never throws and never fails a parse.** That is the contract the
 * surrounding {@link SkillFrontmatterSchema} depends on: the file has to
 * survive as a skill whatever the block says.
 *
 * @param raw - Whatever sat under the `schedule:` key, if anything.
 * @returns The parsed block, a complaint, or `undefined` when the key was absent.
 */
export function readScheduleField(raw: unknown): ScheduleField {
  if (raw === undefined || raw === null) return undefined;
  const result = ScheduleBlockSchema.safeParse(raw);
  return result.success
    ? result.data
    : { invalid: true, problem: describeScheduleBlockProblem(result.error) };
}

/**
 * Whether this skill is a scheduled task — the one question every scheduler
 * surface asks about a discovered SKILL.md.
 *
 * A readable `schedule:` block makes the skill a scheduled task; no block makes
 * it a plain skill. Nothing about the file's location is consulted.
 *
 * An UNREADABLE block answers `false` here, because there is no schedule to
 * run. It is not thereby forgotten: {@link scheduleProblem} is the other half,
 * and discovery asks both so a broken block parks with its complaint instead of
 * disappearing.
 *
 * @param meta - Validated SKILL.md frontmatter.
 */
export function hasSchedule<T extends { schedule?: ScheduleField }>(
  meta: T
): meta is T & { schedule: ScheduleBlock } {
  return meta.schedule !== undefined && !isInvalidSchedule(meta.schedule);
}

/**
 * What is wrong with this skill's `schedule:` block, if anything is.
 *
 * The companion to {@link hasSchedule}: together they separate "no schedule
 * here" (both answer nothing) from "a schedule that does not read" (this one
 * answers a sentence), which is the difference between ignoring a file and
 * parking a row about it.
 *
 * @param meta - Validated SKILL.md frontmatter.
 * @returns The complaint, or `null` when the block is fine or absent.
 */
export function scheduleProblem<T extends { schedule?: ScheduleField }>(meta: T): string | null {
  return isInvalidSchedule(meta.schedule) ? meta.schedule.problem : null;
}

/**
 * Turn a validated {@link ScheduleBlock} back into the frontmatter mapping to
 * write to disk, leaving out every value that is already the default.
 *
 * This is the symmetric partner of parsing, and it exists because the two are
 * *not* symmetric on their own: `ScheduleBlockSchema` fills `timezone`,
 * `enabled` and `permissions` in on the way in, so a caller that parses a file
 * and writes the parsed block straight back grows three lines the author never
 * typed. Writing through this helper keeps a hand-written `schedule: {cron}`
 * exactly that size across any number of round trips.
 *
 * **It always returns a mapping, never `undefined`.** An all-default block
 * writes as `schedule: {}`, which round-trips exactly — gray-matter emits
 * `schedule: {}` and reads it back as `{}` — and, which matters more, keeps the
 * key present: presence is what makes the file a scheduled task, so dropping it
 * would silently un-schedule the skill. Returning `undefined` would be worse
 * still, because the spread this helper is written for
 * (`{...meta, schedule: scheduleToFrontmatter(block)}`) would hand js-yaml an
 * `undefined` and throw "unacceptable kind of an object".
 *
 * One thing it cannot preserve: a `true` the author typed by hand is
 * indistinguishable after parsing from one the schema supplied, so an explicit
 * `enabled: true` is dropped on rewrite. The file still means exactly what it
 * meant; it just gets shorter.
 *
 * @param schedule - A validated schedule block.
 * @returns A plain mapping for `writeSkillFile`'s frontmatter, empty when every
 * value is already the default.
 */
export function scheduleToFrontmatter(schedule: ScheduleBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schedule.cron !== undefined) out.cron = schedule.cron;
  if (schedule.timezone !== DEFAULT_TIMEZONE) out.timezone = schedule.timezone;
  if (schedule.enabled !== true) out.enabled = schedule.enabled;
  if (schedule.sticky !== false) out.sticky = schedule.sticky;
  if (schedule['max-runtime'] !== undefined) out['max-runtime'] = schedule['max-runtime'];
  if (schedule.permissions !== DEFAULT_PERMISSIONS) out.permissions = schedule.permissions;
  if (schedule.prompt !== undefined) out.prompt = schedule.prompt;
  if (schedule.origin !== undefined) out.origin = schedule.origin;
  if (schedule.shape !== undefined) out.shape = schedule.shape;
  if (schedule.runtime !== undefined) out.runtime = schedule.runtime;
  if (schedule.model !== undefined) out.model = schedule.model;
  if (schedule.effort !== undefined) out.effort = schedule.effort;
  return out;
}
