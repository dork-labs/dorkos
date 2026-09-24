/**
 * The vocabulary of the agent permission model: the three states, the area and
 * preset ids, the stored override shapes, the agent-manifest field, the
 * `permission.changed` audit metadata (spec `agent-permissions` D4, D14). The
 * HTTP DTOs live in `permission-api-schemas.ts`.
 *
 * Stored and HTTP shapes may use `z.record`; nothing here is ever an in-session
 * MCP tool input schema (claude-agent-sdk >= 0.3.257 with zod >= 4.5.3 empties
 * `tools/list` when a tool schema carries a record).
 *
 * @module shared/permissions/permission-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from '../zod-openapi.js';
import { PERMISSION_STOPS } from '../permission-semantics.js';
import {
  PERMISSION_ACTION_ID_PATTERN,
  PERMISSION_AREA_IDS,
  PERMISSION_PRESETS,
  PERMISSION_STATES,
} from './permission-ids.js';

extendZodWithOpenApiOnce();

export { PERMISSION_STATES, PERMISSION_AREA_IDS, PERMISSION_PRESETS, PERMISSION_ACTION_ID_PATTERN };

/** One of {@link PERMISSION_STATES}. */
export const PermissionStateSchema = z.enum(PERMISSION_STATES).openapi('PermissionState');

/** A permission state: Blocked, Ask, or Allowed. */
export type PermissionState = z.infer<typeof PermissionStateSchema>;

/** One of {@link PERMISSION_AREA_IDS}. */
export const PermissionAreaIdSchema = z.enum(PERMISSION_AREA_IDS).openapi('PermissionAreaId');

/** The id of an area that takes a permission state. */
export type PermissionAreaId = z.infer<typeof PermissionAreaIdSchema>;

/** One of {@link PERMISSION_PRESETS}. */
export const PermissionPresetSchema = z.enum(PERMISSION_PRESETS).openapi('PermissionPreset');

/** A preset id. */
export type PermissionPreset = z.infer<typeof PermissionPresetSchema>;

/** A capability id (`domain.verb`) or a hand-registered tool name (no dot). */
export const PermissionActionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(PERMISSION_ACTION_ID_PATTERN);

/**
 * Stored overrides. Keyed by plain string ON PURPOSE, not by the enum: a manifest
 * written by a newer build that knows an extra area must still parse on an older
 * one (the `workspace` precedent in mesh-schemas.ts: refusing the parse makes the
 * agent vanish from the fleet). Known-id and floor checks run on WRITE and the
 * resolver ignores unknown keys.
 */
export const PermissionOverridesSchema = z
  .object({
    areas: z.record(z.string(), PermissionStateSchema).default({}),
    actions: z.record(PermissionActionIdSchema, PermissionStateSchema).default({}),
  })
  .openapi('PermissionOverrides');

/** The changes a person made on top of the preset, per area and per action. */
export type PermissionOverrides = z.infer<typeof PermissionOverridesSchema>;

/** The per-agent trust stop, the "Files & commands" row. */
export const PermissionStopSchema = z.enum(PERMISSION_STOPS).openapi('PermissionStop');

/**
 * The `permissions` field of an agent manifest. Absent means the agent inherits
 * everything from the defaults. Deliberately NOT `.catch(undefined)`: a security
 * control that cannot be parsed must be loud (the `tierCeiling` precedent in
 * mesh-schemas.ts). Forward compatibility comes from the string keys instead.
 */
export const AgentPermissionsSchema = z
  .object({
    areas: z.record(z.string(), PermissionStateSchema).optional(),
    actions: z.record(PermissionActionIdSchema, PermissionStateSchema).optional(),
    /** Per-agent trust stop, the "Files & commands" row. Absent = inherit. */
    filesAndCommands: PermissionStopSchema.optional(),
  })
  .openapi('AgentPermissions');

/** One agent's stored permission overrides. */
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/** Where every "why is it this way?" answer starts: which layer decided. */
export const PERMISSION_SOURCES = [
  'agent-action',
  'agent-area',
  'default-action',
  'default-area',
  'preset',
  'unchanged',
  'floor',
  'inactive',
] as const;

/** One of {@link PERMISSION_SOURCES}. */
export const PermissionSourceSchema = z.enum(PERMISSION_SOURCES).openapi('PermissionSource');

/** Which layer of the model produced a resolved state. */
export type PermissionSource = z.infer<typeof PermissionSourceSchema>;

/** The coarse layer a resolved state came from. */
export const PermissionLayerSchema = z.enum(['agent', 'default', 'floor']);

/** A resolved permission, as the API reports it. */
export const ResolvedPermissionSchema = z
  .object({
    area: PermissionAreaIdSchema,
    state: PermissionStateSchema,
    source: PermissionSourceSchema,
    layer: PermissionLayerSchema,
    destructiveAsk: z.literal(true).optional(),
  })
  .openapi('ResolvedPermission');

// === Audit (`permission.changed`) ===

/** The surface a permission write came from. Recorded on every audit event. */
export const PERMISSION_SURFACES = [
  'settings',
  'agent-page',
  'control-center',
  'request-card',
  'first-run',
  'agent-request',
  'api',
  'cli',
  'upgrade',
  'undo',
  /** An edit to the agent's settings file that DorkOS noticed rather than made. */
  'file-edit',
] as const;

/** One of {@link PERMISSION_SURFACES}. */
export const PermissionSurfaceSchema = z.enum(PERMISSION_SURFACES).openapi('PermissionSurface');

/** The surface a permission write came from. */
export type PermissionSurface = z.infer<typeof PermissionSurfaceSchema>;

/**
 * How sure DorkOS is about who made a change. `local-trust` means login was off,
 * so the change came from "someone on this computer", never a confirmed "you".
 * `outside` means the agent's settings file changed without DorkOS writing it,
 * so nobody can be named at all.
 */
export const PermissionAttributionSchema = z
  .enum(['signed-in', 'local-trust', 'agent-request-approved', 'upgrade', 'outside'])
  .openapi('PermissionAttribution');

/** How sure DorkOS is about who made a permission change. */
export type PermissionAttribution = z.infer<typeof PermissionAttributionSchema>;

/** Which layer a recorded change landed in. */
export const PermissionChangeTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string(),
    agentPath: z.string(),
    agentName: z.string(),
  }),
]);

/** What a recorded change changed. */
export const PermissionChangeKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset') }),
  z.object({ kind: z.literal('area'), area: PermissionAreaIdSchema }),
  z.object({ kind: z.literal('action'), action: z.string(), area: PermissionAreaIdSchema }),
  z.object({ kind: z.literal('files') }),
]);

/** One change inside a `permission.changed` event. */
export const PermissionChangeSchema = z.object({
  target: PermissionChangeTargetSchema,
  key: PermissionChangeKeySchema,
  /** State, stop, or preset before the write; `null` = inherited / not set. */
  before: z.string().nullable(),
  /** State, stop, or preset after the write; `null` = inherited / not set. */
  after: z.string().nullable(),
});

/** One change inside a `permission.changed` event. */
export type PermissionChange = z.infer<typeof PermissionChangeSchema>;

/**
 * The metadata every `permission.changed` Activity event carries. One event per
 * write, a bulk write included: the default change and every agent it touched
 * are all rows of `changes`.
 */
export const PermissionChangedMetadataSchema = z.object({
  changes: z.array(PermissionChangeSchema),
  surface: PermissionSurfaceSchema,
  attribution: PermissionAttributionSchema,
  approvalId: z.string().optional(),
  undoOf: z.string().optional(),
  /** What the preset, the defaults and the trust stop were BEFORE a preset write. */
  presetSnapshot: z
    .object({
      preset: z.string().nullable(),
      defaults: PermissionOverridesSchema,
      trustStop: z.string().nullable(),
    })
    .optional(),
});

/** The metadata of a `permission.changed` Activity event. */
export type PermissionChangedMetadata = z.infer<typeof PermissionChangedMetadataSchema>;

/** The Activity event type every permission write lands as. */
export const PERMISSION_CHANGED_EVENT = 'permission.changed';

// === Audit (`permission.answered`) ===

/** The three answers a request card takes (spec `agent-permissions` D7). */
export const PERMISSION_ANSWERS = ['once', 'always', 'deny'] as const;

/** One of {@link PERMISSION_ANSWERS}. */
export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number];

/**
 * The metadata every `permission.answered` Activity event carries: one event per
 * answer on a request card, replacing the decide route's older
 * `approval.granted` / `approval.denied` lines (spec `agent-permissions` D14).
 * An Always allow ALSO records the `permission.changed` event for the setting it
 * created; this one records the answer itself.
 */
export const PermissionAnsweredMetadataSchema = z.object({
  /** The agent that asked, when DorkOS knows it. */
  agentId: z.string().optional(),
  /** The agent's project directory, when the gate recorded one. */
  agentPath: z.string().optional(),
  /** The capability id or hand-registered tool name that was asked about. */
  action: z.string(),
  /** The action's permission area, or `null` for an action with no area. */
  area: PermissionAreaIdSchema.nullable(),
  /** What the person answered. */
  answer: z.enum(PERMISSION_ANSWERS),
  /** The approval that was answered. */
  approvalId: z.string(),
  /** Whether the agent asked past a Blocked permission with `request_permission`. */
  blockedRequest: z.boolean(),
  /** The decision posture the person bars reported: login on or off. */
  posture: z.enum(['signed-in-operator', 'local-trust']),
});

/** The metadata of a `permission.answered` Activity event. */
export type PermissionAnsweredMetadata = z.infer<typeof PermissionAnsweredMetadataSchema>;

/** The Activity event type every request-card answer lands as. */
export const PERMISSION_ANSWERED_EVENT = 'permission.answered';
