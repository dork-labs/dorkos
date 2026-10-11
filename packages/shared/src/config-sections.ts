/**
 * Three top-level sections of `UserConfigSchema`, each a whole section on
 * purpose so conf writes it into every stored config by itself and none needs a
 * migration: whether this computer may sleep while agents work (`keepAwake`),
 * whether agents wake on their own (`heartbeats`), and how long the Activity
 * feed keeps its history (`activity`). Split out of `config-schema.ts` to keep
 * that file inside its line budget; plain Zod, no OpenAPI.
 *
 * @module shared/config-sections
 */
import { z } from 'zod';

/**
 * Whether this computer may idle-sleep while agents work (spec `keep-awake`,
 * DOR-2718). A whole top-level section on purpose: conf writes a new section
 * into every stored config on its own, so neither field needs a migration.
 * Both defaults are declared twice, here and in the section literal below,
 * and the two must agree.
 */
export const KeepAwakeConfigSchema = z
  .object({
    /** Hold the computer awake while any agent works; release when idle. */
    whileAgentsWork: z.boolean().default(true),
    /**
     * Wake the computer shortly before each approved scheduled run (needs
     * one-time admin setup on macOS and Linux). Read by nothing yet: the wake
     * half of the spec ships later, and Settings offers no switch for it
     * until then. It ships in this section now so adding it later is not a
     * nested-leaf migration.
     */
    wakeForScheduledTasks: z.boolean().default(false),
  })
  .default(() => ({ whileAgentsWork: true, wakeForScheduledTasks: false }));
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
  })
  .default(() => ({ enabled: true }));
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
