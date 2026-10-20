/**
 * Top-level sections of `UserConfigSchema`, split out of `config-schema.ts` to
 * keep that file inside its line budget; plain Zod, no OpenAPI. Three are whole
 * sections on purpose so conf writes each into every stored config by itself and
 * none needs a migration: whether this computer may sleep while agents work
 * (`keepAwake`), whether agents wake on their own (`heartbeats`), and how long
 * the Activity feed keeps its history (`activity`). The fourth, `server`, is
 * as old as the file, so a field added to it needs a migration.
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

/**
 * Where the server listens and what it opens on start (`server`). Every stored
 * config already carries this section, so conf never adds a new member to it on
 * its own: a field added here needs a migration that writes it.
 */
export const ServerConfigSchema = z
  .object({
    /**
     * **Something else depends on this exact number, not just on there being
     * a default.** `conf` materializes defaults to disk, so every
     * `config.json` in the world already carries this value whether or not
     * anyone chose it. `PREFERRED_SERVER_PORT` in
     * `apps/desktop/src/main/server-port.ts` compares against it to tell a
     * port a person pinned from the one the library wrote — a pinned port is
     * claimed strictly, an unchosen one steps past a conflict. Move this
     * without moving that and every install's written-out default reads as a
     * deliberate pin, so the desktop app refuses to start instead of stepping
     * past a busy port. `config-schema.test.ts` fails with that explanation
     * if the two drift.
     */
    port: z.number().int().min(1024).max(65535).default(4242),
    cwd: z.string().nullable().default(null),
    boundary: z.string().nullable().default(null),
    open: z.boolean().default(true),
    /**
     * Let devices on the same network open DorkOS (DOR-2930). Off by default,
     * and only honoured while login is on; `DORKOS_HOST` in the environment
     * overrules it. Read by `services/core/lan-access/`.
     */
    lanAccess: z.boolean().default(false),
  })
  .default(() => ({ port: 4242, cwd: null, boundary: null, open: true, lanAccess: false }));
