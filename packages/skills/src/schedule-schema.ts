import { z } from 'zod';
import { DurationSchema } from './duration.js';
import { coerceYamlBoolean } from './yaml-boolean.js';

/**
 * The permission modes a schedule may declare in its `permissions:`
 * frontmatter — the same set a chat session may run under.
 *
 * DRIFT NOTE: an inlined mirror of `PermissionModeSchema`
 * (`packages/shared/src/schemas.ts`) by value. `@dorkos/shared` is on zod v4
 * and this package is still on v3, and nesting a v4 `ZodType` inside a v3
 * `z.object()` silently misbehaves rather than erroring (the same boundary
 * `ui-template.ts` documents), so the six values are inlined here instead of
 * composed. `__tests__/task-schema.test.ts` reads `PermissionModeSchema.options`
 * — a version-safe string-array read, never a cross-version schema composition
 * — and asserts the two sets are equal, so they cannot drift apart.
 *
 * `@dorkos/marketplace` re-exports this as `SHAPE_SCHEDULE_PERMISSION_MODES`
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
 * lives: this package is on zod v3, ships to the browser through the barrel,
 * and must stay dependency-light.
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
});

/**
 * A validated `schedule:` block — see {@link ScheduleBlockSchema}.
 *
 * `timezone`, `enabled` and `permissions` are always present on a parsed
 * block because the schema supplies them; they are optional only in the file.
 */
export type ScheduleBlock = z.infer<typeof ScheduleBlockSchema>;

/**
 * Whether this skill is a scheduled task — the one question every scheduler
 * surface asks about a discovered SKILL.md.
 *
 * A `schedule:` block makes the skill a scheduled task; no block makes it a
 * plain skill. Nothing about the file's location is consulted.
 *
 * @param meta - Validated SKILL.md frontmatter.
 */
export function hasSchedule<T extends { schedule?: ScheduleBlock }>(
  meta: T
): meta is T & { schedule: ScheduleBlock } {
  return meta.schedule !== undefined;
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
 * @param schedule - A validated schedule block.
 * @returns A plain mapping for `writeSkillFile`'s frontmatter, or `undefined`
 * when nothing needs writing at all (an on-demand schedule left at every
 * default) — a caller writing `schedule:` with an empty mapping would produce
 * `schedule: null` on the next read.
 */
export function scheduleToFrontmatter(
  schedule: ScheduleBlock
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (schedule.cron !== undefined) out.cron = schedule.cron;
  if (schedule.timezone !== DEFAULT_TIMEZONE) out.timezone = schedule.timezone;
  if (schedule.enabled !== true) out.enabled = schedule.enabled;
  if (schedule['max-runtime'] !== undefined) out['max-runtime'] = schedule['max-runtime'];
  if (schedule.permissions !== DEFAULT_PERMISSIONS) out.permissions = schedule.permissions;
  if (schedule.prompt !== undefined) out.prompt = schedule.prompt;
  if (schedule.origin !== undefined) out.origin = schedule.origin;
  if (schedule.shape !== undefined) out.shape = schedule.shape;
  return Object.keys(out).length > 0 ? out : undefined;
}
