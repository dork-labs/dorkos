/**
 * Three top-level sections of `UserConfigSchema`, each a whole section on
 * purpose so conf writes it into every stored config by itself: whether this
 * computer may sleep (`keepAwake`, whose later leaves needed `'0.116.0'`),
 * whether agents wake on their own (`heartbeats`), and how long the Activity
 * feed keeps its history (`activity`). Split out of `config-schema.ts` to keep
 * that file inside its line budget; plain Zod, no OpenAPI.
 *
 * @module shared/config-sections
 */
import { z } from 'zod';

/** When DorkOS keeps this computer awake on its own (spec `keep-awake`). */
export const KeepAwakeModeSchema = z.enum(['off', 'agents', 'always']);

/** When DorkOS keeps this computer awake on its own. */
export type KeepAwakeMode = z.infer<typeof KeepAwakeModeSchema>;

/**
 * Whether this computer may idle-sleep (spec `keep-awake`, DOR-2718; modes
 * DOR-2920). A whole top-level section, so conf writes it into a config that
 * never had it; the leaves added after it first shipped are nested, so the
 * `'0.116.0'` migration writes them (and turns the retired `whileAgentsWork`
 * into `mode`). Every default is declared twice, here and in the section
 * literal below, and the two must agree.
 */
export const KeepAwakeConfigSchema = z
  .object({
    /**
     * When to hold the computer awake on its own: never (`off`), while any
     * agent works (`agents`), or all the time while DorkOS runs (`always`).
     */
    mode: KeepAwakeModeSchema.default('agents'),
    /**
     * A timed session: keep the computer awake until this moment, whatever the
     * mode says (it wins even over `off`). Stored so it survives a restart; a
     * moment in the past is simply over. Null when no session was started.
     */
    manualUntil: z.iso.datetime({ offset: true }).nullable().default(null),
    /** Keep the screen on too while the computer is held, where the OS allows it. */
    keepDisplayAwake: z.boolean().default(false),
    /**
     * On battery, stop holding the computer awake once the charge is below this
     * percentage. Null: never stop for the charge.
     */
    stopBelowBatteryPercent: z.number().int().min(5).max(95).nullable().default(null),
    /** Hold the computer awake only while it is plugged in. */
    onlyOnPower: z.boolean().default(false),
    /**
     * Wake the computer shortly before each approved scheduled run (needs
     * one-time admin setup on macOS and Linux). Read by nothing yet: the wake
     * half of the spec ships later, and Settings offers no switch for it
     * until then. It ships in this section now so adding it later is not a
     * nested-leaf migration.
     */
    wakeForScheduledTasks: z.boolean().default(false),
    /**
     * Keep a Mac awake with its lid closed while the computer is held (owner
     * only, off by default). Read by nothing yet: part 5 of the keep-awake modes
     * (DOR-2923) wires it. It ships in this section now so adding it later is
     * not a second nested-leaf migration.
     */
    closedLid: z.boolean().default(false),
  })
  .default(() => ({
    mode: 'agents' as const,
    manualUntil: null,
    keepDisplayAwake: false,
    stopBelowBatteryPercent: null,
    onlyOnPower: false,
    wakeForScheduledTasks: false,
    closedLid: false,
  }));

/** The `keepAwake` config section. */
export type KeepAwakeConfig = z.infer<typeof KeepAwakeConfigSchema>;

/**
 * Heartbeats (spec `heartbeats` §3.6): whether agents wake on their own, on a
 * beat or an event. A whole top-level section on purpose, like `keepAwake`:
 * conf writes a new section into every stored config on its own, so the field
 * needs no migration. The default is declared twice, here and in the section
 * literal below, and the two must agree. Operator-only: off stops every beat
 * and clears every timer.
 */
export const HeartbeatsConfigSchema = z
  .object({
    /** Agents wake on their own. Off stops the beat runner for every agent. */
    enabled: z.boolean().default(true),
    /**
     * Whether a beat's cheap check may run on DorkOS credits (spec `heartbeats`
     * §6.3, ADR 261001-000811 as amended by 261010-092116). `null` until a
     * person answers the one-time offer: only **Use credits** sets `true`, and
     * **Not now** sets `false`. Nothing is spent while it is `null` or `false`.
     *
     * No migration, on purpose: a stored `heartbeats` section without this leaf
     * reads as `null`, which is exactly "not chosen", so there is no value a
     * migration could seed that the absence does not already say. Operator-only.
     */
    triageOnCredits: z.boolean().nullable().default(null),
  })
  .default(() => ({ enabled: true, triageOnCredits: null }));
/**
 * The Activity feed (spec `audit-trail` §3.5). A whole top-level section on
 * purpose, like `keepAwake`: conf writes a new section into every stored
 * config on its own, so the field needs no migration. The default is declared
 * twice, here and in the section literal below, and the two must agree.
 */
export const ActivityConfigSchema = z
  .object({
    /**
     * Days of Activity history to keep. `DORKOS_ACTIVITY_RETENTION_DAYS`
     * overrides it when set. Permission changes are kept regardless, and the
     * audit log keeps every action forever whatever this says.
     */
    retentionDays: z.number().int().min(1).max(3650).default(365),
  })
  .default(() => ({ retentionDays: 365 }));
