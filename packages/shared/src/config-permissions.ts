/**
 * The `permissions` section of `~/.dork/config.json`, kept beside
 * `config-schema.ts` the way `config-relay.ts` keeps the relay section.
 *
 * Built from the plain id lists in `permissions/permission-ids.ts`, never from
 * the named schemas in `permissions/permission-schemas.ts`: `config-schema.ts`
 * is aliased to SRC in every vitest project, so nothing it reaches may drag in
 * a schema the OpenAPI registry registers (`__tests__/aliased-module-imports.test.ts`).
 *
 * @module shared/config-permissions
 */
import { z } from 'zod';
import {
  PERMISSION_ACTION_ID_PATTERN,
  PERMISSION_PRESETS,
  PERMISSION_STATES,
} from './permissions/permission-ids.js';

/** A permission state as the config file stores it. */
const PermissionConfigStateSchema = z.enum(PERMISSION_STATES);

/**
 * What agents may do, by area (spec `agent-permissions` D4). The preset every
 * area starts from, plus the changes a person made on top of it; each agent's
 * own differences live in its manifest, not here.
 *
 * `operator-only` and refused outright by the generic config write paths
 * (`PATCH /api/config`, `dorkos config set`): only the permission routes may
 * write it, so every change carries a person's yes and an audit event.
 *
 * Declared twice on purpose (per field AND in the object-literal default):
 * one feeds fresh installs, the other upgrades, and they must agree.
 */
export const PermissionsSettingsSchema = z
  .object({
    /**
     * The preset every area starts from. Ships `'trusted'` (ADR
     * 261006-225605): our own agents work without asking, and every action is
     * recorded. `'careful'` turns asking back on. `null` is still readable and
     * means the same as `'trusted'`; the `'0.115.0'` migration leaves none.
     */
    preset: z.enum(PERMISSION_PRESETS).nullable().default('trusted'),
    /** The changes a person made on top of the preset ("Full power, 2 changes"). */
    defaults: z
      .object({
        areas: z.record(z.string(), PermissionConfigStateSchema).default(() => ({})),
        actions: z
          .record(z.string().regex(PERMISSION_ACTION_ID_PATTERN), PermissionConfigStateSchema)
          .default(() => ({})),
      })
      .default(() => ({ areas: {}, actions: {} })),
    /**
     * The server version the permission upgrade sweep last ran for; `null`
     * means never. Machine-managed: the boot sweep stamps it.
     */
    upgradeSweptVersion: z.string().nullable().default(null),
    /**
     * When the open mesh rule, the Trusted default kept outside this file, was
     * applied, as an ISO 8601 string; `null` means not yet. Machine-managed:
     * the boot step that does that work stamps it once
     * (`services/mesh/seed-open-mesh.ts`), so a person who later closes the
     * mesh keeps it closed. Carried across a config wipe for the same reason.
     */
    trustedStoresAppliedAt: z.string().datetime().nullable().default(null),
    /**
     * When the once-per-install step shared each connected app nobody held
     * with every agent, as an ISO 8601 string; `null` means not yet. Its own
     * stamp, so the step runs once wherever it arrives. A Careful install is
     * stamped too, with nothing shared, as the open mesh step does.
     * Machine-managed, and carried across a config wipe so a wipe never runs
     * the step a second time.
     */
    sharedAppsAppliedAt: z.string().datetime().nullable().default(null),
    /**
     * The connections the once-per-install step shared with every
     * agent because nobody held access to them (spec `trusted-by-default-flip`
     * §5.6, decision D1), by connection id. The one-time trust notice names
     * them and offers to narrow each. Machine-managed; `[]` when it shared none.
     */
    sharedAtUpgrade: z.array(z.string().min(1)).default(() => []),
    /**
     * The folder allow lists a person has let apply (DOR-3039): an agent's own
     * `.claude/settings*.json` `permissions.allow` rules, which Claude Code
     * ignores in a folder it has not been told to trust and DorkOS hands it
     * instead. Each entry is `<agentId>@folder-allows-<digest>`, where the digest
     * covers the agent's home and the exact rules shown on the approval card, so
     * an edited list asks again instead of riding an old yes. Empty by default.
     */
    approvedFolderAllows: z.array(z.string().min(1)).default(() => []),
    /**
     * The folder allow lists a person has turned down, in the same form as
     * {@link approvedFolderAllows}, and never in both. A refusal expires on its
     * own once the list changes, because the digest stops matching.
     */
    refusedFolderAllows: z.array(z.string().min(1)).default(() => []),
    /**
     * The rules behind each agent's current yes in {@link approvedFolderAllows},
     * by agent id, so a card can say what changed and a list that only lost
     * rules can apply without asking. Read only where a stored yes still
     * digests to them.
     */
    approvedFolderAllowRules: z.record(z.string(), z.array(z.string())).default(() => ({})),
  })
  .default(() => ({
    preset: 'trusted' as const,
    defaults: { areas: {}, actions: {} },
    upgradeSweptVersion: null,
    trustedStoresAppliedAt: null,
    sharedAppsAppliedAt: null,
    sharedAtUpgrade: [],
    approvedFolderAllows: [],
    refusedFolderAllows: [],
    approvedFolderAllowRules: {},
  }));
