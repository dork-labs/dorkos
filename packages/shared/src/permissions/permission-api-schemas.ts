/**
 * The HTTP DTOs the `/api/permissions` routes speak (spec `agent-permissions`
 * D10). Kept apart from `permission-schemas.ts` on purpose: `config-schema.ts`
 * imports the stored shapes, and it may never reach a module that exports a
 * schema the OpenAPI registry registers (see
 * `__tests__/aliased-module-imports.test.ts`).
 *
 * @module shared/permissions/permission-api-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from '../zod-openapi.js';
import { CAPABILITY_TIERS } from '../capabilities.js';
import {
  AgentPermissionsSchema,
  PermissionAreaIdSchema,
  PermissionChangedMetadataSchema,
  PermissionOverridesSchema,
  PermissionPresetSchema,
  PermissionStateSchema,
  PermissionStopSchema,
  PermissionSurfaceSchema,
  ResolvedPermissionSchema,
} from './permission-schemas.js';

extendZodWithOpenApiOnce();

/** A state to set, or `null` to remove the change and fall back a layer. */
const NullableStateSchema = PermissionStateSchema.nullable();

/** One action inside an area, as the permissions pages list it. */
export const PermissionActionEntrySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    tier: z.enum(CAPABILITY_TIERS),
    /**
     * Never Allowed: its card shows the change it would make, so a person sees
     * every one. Offers Blocked and Ask only, like a floor area.
     */
    alwaysAsks: z.literal(true).optional(),
    /** What this action resolves to at the layer being viewed. */
    resolved: ResolvedPermissionSchema,
  })
  .openapi('PermissionActionEntry');

/** One action inside an area, as the permissions pages list it. */
export type PermissionActionEntry = z.infer<typeof PermissionActionEntrySchema>;

/** One area as the permissions pages list it. */
export const PermissionAreaEntrySchema = z
  .object({
    id: PermissionAreaIdSchema,
    label: z.string(),
    description: z.string(),
    floor: z.boolean(),
    kind: z.enum(['state', 'trust-stop']),
    actions: z.array(PermissionActionEntrySchema),
    /** What the area as a whole resolves to at the layer being viewed. */
    resolved: ResolvedPermissionSchema.pick({ state: true, source: true, layer: true }),
  })
  .openapi('PermissionAreaEntry');

/** One area as the permissions pages list it. */
export type PermissionAreaEntry = z.infer<typeof PermissionAreaEntrySchema>;

/** An agent whose own setting differs from the default. */
export const PermissionExceptionSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    area: PermissionAreaIdSchema,
    action: z.string().optional(),
    state: PermissionStateSchema,
  })
  .openapi('PermissionException');

/** An agent that differs from the default. */
export type PermissionException = z.infer<typeof PermissionExceptionSchema>;

/** Where a Files & commands stop came from (`resolveFilesAndCommands`). */
export const FilesAndCommandsSourceSchema = z
  .enum(['agent', 'runtime', 'default', 'runtime-own'])
  .openapi('FilesAndCommandsSource');

/** A resolved Files & commands stop: the stop, or `null` for the runtime's own behaviour. */
export const ResolvedFilesAndCommandsSchema = z
  .object({
    stop: PermissionStopSchema.nullable(),
    source: FilesAndCommandsSourceSchema,
  })
  .openapi('ResolvedFilesAndCommands');

/** The Files & commands row at the default layer. */
export const DefaultFilesAndCommandsSchema = z
  .object({
    /** `runtimes.defaultTrustStop`: where a new session starts for everyone. */
    stop: PermissionStopSchema.nullable(),
    /** The stop the chosen preset sets; `null` while no preset is chosen. */
    presetStop: PermissionStopSchema.nullable(),
    /** Per-runtime stops that are set, which beat the global one for that runtime. */
    runtimes: z.array(z.object({ runtime: z.string(), stop: PermissionStopSchema })),
    /** Agents with a Files & commands stop of their own. */
    exceptions: z.array(
      z.object({ agentId: z.string(), agentName: z.string(), stop: PermissionStopSchema })
    ),
  })
  .openapi('DefaultFilesAndCommands');

/** `GET /api/permissions`: the default layer, every area, and who differs. */
export const PermissionsResponseSchema = z
  .object({
    preset: PermissionPresetSchema.nullable(),
    defaults: PermissionOverridesSchema,
    /**
     * How many changes sit on top of the preset ("Full power, 2 changes"): the
     * default changes, plus the global Files & commands stop and each
     * per-runtime stop that differs from the preset's.
     */
    changeCount: z.number().int().min(0),
    /** The Files & commands row: the stored stops, and who differs. */
    filesAndCommands: DefaultFilesAndCommandsSchema,
    areas: z.array(PermissionAreaEntrySchema),
    exceptions: z.array(PermissionExceptionSchema),
    /** How many registered agents the defaults reach. */
    agentCount: z.number().int().min(0),
    /**
     * Set when DorkOS cannot read or save its record of which new agents it has
     * screened: until it can, every agent's own settings count only where they
     * are stricter than the defaults.
     */
    newAgentRecordUnreadable: z.literal(true).optional(),
  })
  .openapi('PermissionsResponse');

/** `GET /api/permissions` response. */
export type PermissionsResponse = z.infer<typeof PermissionsResponseSchema>;

/** `GET /api/agents/:id/permissions`: one agent's resolved state, with its source. */
export const AgentPermissionsResponseSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    overrides: AgentPermissionsSchema,
    areas: z.array(
      PermissionAreaEntrySchema.extend({
        /** What the area would be with no override for this agent. */
        inherited: ResolvedPermissionSchema.pick({ state: true, source: true, layer: true }),
        /**
         * When this area's most recent change was an edit to the agent's
         * settings file that DorkOS noticed rather than made; `null` when the
         * most recent change came through DorkOS, or there was none.
         */
        changedOutsideAt: z.string().nullable(),
      })
    ),
    /** The agent's Files & commands stop, resolved, and what it would inherit. */
    filesAndCommands: ResolvedFilesAndCommandsSchema.extend({
      inherited: ResolvedFilesAndCommandsSchema,
    }),
  })
  .openapi('AgentPermissionsResponse');

/** `GET /api/agents/:id/permissions` response. */
export type AgentPermissionsResponse = z.infer<typeof AgentPermissionsResponseSchema>;

/** `PUT /api/permissions/preset` body. */
export const SetPermissionPresetBodySchema = z
  .object({
    preset: PermissionPresetSchema,
    applyToAgents: z.array(z.string().min(1)).max(500).optional(),
    surface: PermissionSurfaceSchema,
    /**
     * The person read what Full autonomy means and said yes, recorded with the
     * preset in one write. Needed only when the preset moves Files & commands to
     * Full autonomy and no acknowledgement is on file (428 otherwise).
     */
    acknowledgeAutonomy: z.literal(true).optional(),
  })
  .openapi('SetPermissionPresetBody');

/** `PUT /api/permissions/preset` body. */
export type SetPermissionPresetBody = z.infer<typeof SetPermissionPresetBodySchema>;

/** `PATCH /api/permissions/defaults` body. `null` removes a change. */
export const PatchPermissionDefaultsBodySchema = z
  .object({
    areas: z.record(z.string(), NullableStateSchema).optional(),
    actions: z.record(z.string(), NullableStateSchema).optional(),
    applyToAgents: z.array(z.string().min(1)).max(500).optional(),
    surface: PermissionSurfaceSchema,
  })
  .openapi('PatchPermissionDefaultsBody');

/** `PATCH /api/permissions/defaults` body. */
export type PatchPermissionDefaultsBody = z.infer<typeof PatchPermissionDefaultsBodySchema>;

/** `PATCH /api/agents/:id/permissions` body. `null` = back to the default. */
export const PatchAgentPermissionsBodySchema = z
  .object({
    areas: z.record(z.string(), NullableStateSchema).optional(),
    actions: z.record(z.string(), NullableStateSchema).optional(),
    /** This agent's own Files & commands stop; `null` = back to the default. */
    filesAndCommands: PermissionStopSchema.nullable().optional(),
    surface: PermissionSurfaceSchema,
    /** As on the preset body: the acknowledgement Full autonomy needs, in the same write. */
    acknowledgeAutonomy: z.literal(true).optional(),
  })
  .openapi('PatchAgentPermissionsBody');

/** `PATCH /api/agents/:id/permissions` body. */
export type PatchAgentPermissionsBody = z.infer<typeof PatchAgentPermissionsBodySchema>;

/** `GET /api/permissions/history` query. */
export const PermissionHistoryQuerySchema = z
  .object({
    agentId: z.string().min(1).optional(),
    /** ISO 8601 cursor: events older than this. */
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  })
  .openapi('PermissionHistoryQuery');

/** `GET /api/permissions/history` query. */
export type PermissionHistoryQuery = z.infer<typeof PermissionHistoryQuerySchema>;

/** One row of the permission history. */
export const PermissionHistoryEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    actorLabel: z.string(),
    /** An extra honesty line (login off: DorkOS can't confirm who). */
    actorDetail: z.string().nullable(),
    summary: z.string(),
    metadata: PermissionChangedMetadataSchema,
  })
  .openapi('PermissionHistoryEntry');

/** One row of the permission history. */
export type PermissionHistoryEntry = z.infer<typeof PermissionHistoryEntrySchema>;

/** `GET /api/permissions/history` response. */
export const PermissionHistoryResponseSchema = z
  .object({
    items: z.array(PermissionHistoryEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('PermissionHistoryResponse');

/** `GET /api/permissions/history` response. */
export type PermissionHistoryResponse = z.infer<typeof PermissionHistoryResponseSchema>;
