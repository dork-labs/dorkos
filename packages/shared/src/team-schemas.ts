/**
 * The team roster payload — one read-only projection of every identity on this
 * install (spec `identity-consistency` §W2.2, ADR 260806-222535).
 *
 * `GET /api/team` aggregates two registries that already exist — `authors` for
 * people, the mesh cache for agents — and mints, writes and stores nothing.
 * That is why this module defines no third identity model: `kind` is
 * {@link AuthorKindSchema}, `origin` is {@link AuthorOriginSchema}, and the
 * render cache keeps the field names (`emoji`, `color`) that `authors` and
 * `AgentManifest` already use. A second spelling of an identity is a mapping
 * that exists only to be forgotten.
 *
 * Two shapes here are load-bearing rather than incidental:
 *
 * - **`ownerId` is required and nullable.** Owner attribution is derived at read
 *   time (the same way {@link TopologyAgentSchema} adds health the manifest does
 *   not hold), and grouping the roster by person is a client filter over it. A
 *   schema that let it be omitted is how the field becomes optional in practice
 *   and the grouping becomes a later migration.
 * - **`warnings` is omitted entirely on a clean read, never `[]`.** Copied from
 *   the ADR-0310 envelope of `GET /api/sessions`
 *   ({@link SessionListResponseSchema}) — including the reason it travels
 *   in-band: a degradation carried in an HTTP header is invisible to the Direct
 *   in-process transport, which shares this type.
 *
 * @module shared/team-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { AuthorKindSchema, AuthorOriginSchema } from './room-schemas.js';
import { AgentHealthStatusSchema, AgentRuntimeSchema } from './mesh-schemas.js';

extendZodWithOpenApi(z);

/**
 * What is true of an agent and of nothing else on the roster.
 *
 * Present only when `kind === 'agent'`. Everything here is read from the mesh
 * cache's health-enriched listing; nothing is stored by this endpoint.
 */
export const TeamAgentFactsSchema = z
  .object({
    /** The agent's manifest ULID — the same value the row's `id` carries. */
    manifestId: z.string().min(1),
    runtime: AgentRuntimeSchema,
    /** The model new sessions start on. Absent = inherit the server default. */
    model: z.string().optional(),
    healthStatus: AgentHealthStatusSchema,
    /**
     * Whether the mesh has heard from this agent within the last hour.
     *
     * **Not "doing something right now", and named so it cannot be read that
     * way.** It restates `healthStatus === 'active'`, and the mesh's `active`
     * threshold is 60 minutes (`ACTIVE_THRESHOLD_MINUTES`), so an agent that
     * finished an hour ago is still `recentlyActive`. A renderer that wants a
     * live-turn dot needs a different source — see the note in
     * `services/identity/aggregate-team.ts`.
     */
    recentlyActive: z.boolean(),
    /**
     * The project-directory namespace used for cross-agent messaging permissions.
     *
     * Stripped from the mesh's public listing along with `projectPath` (both are
     * internal registry fields), so nothing production serves today fills it.
     * Optional rather than dropped so a future source entitled to it can fill it
     * without a schema change.
     */
    namespace: z.string().optional(),
    /**
     * Where the agent lives, when the caller is entitled to know.
     *
     * Stripped from the mesh's public listing by design (a room is a shared
     * surface and `/Users/dorian/…` is not something to hand every reader of
     * one), so — like `namespace` — nothing production serves today fills it.
     * Optional so a future source entitled to it can, without a schema change.
     */
    projectPath: z.string().optional(),
    /** Whether this is `config.agents.defaultAgent`. */
    isDefault: z.boolean(),
    /** System agents (DorkBot) are auto-managed and belong to the install. */
    isSystem: z.boolean(),
    registeredAt: z.string(),
  })
  .openapi('TeamAgentFacts');

/** What is true of an agent and of nothing else (see {@link TeamAgentFactsSchema}). */
export type TeamAgentFacts = z.infer<typeof TeamAgentFactsSchema>;

/**
 * What is true of a person and of nothing else.
 *
 * Present only when `kind === 'human'`.
 */
export const TeamPersonFactsSchema = z
  .object({
    /**
     * Backend-declared, `null` where a backend has no roles — the same
     * nullability `CommunityMember.role` carries.
     */
    role: z.string().nullable(),
    /**
     * Present ONLY on the viewer's own row. Never carried for anyone else, even
     * on a single-user install: the shape has to be right before there is a
     * second person to leak it to.
     */
    email: z.string().optional(),
  })
  .openapi('TeamPersonFacts');

/** What is true of a person and of nothing else (see {@link TeamPersonFactsSchema}). */
export type TeamPersonFacts = z.infer<typeof TeamPersonFactsSchema>;

/**
 * One identity on this install — a person or an agent, in one shape.
 *
 * The shape a remote member already arrives in: an opaque `id`, a `kind`, a
 * render cache, an `origin` and an `ownerId`. Nothing here branches on "there
 * is exactly one person", which is what makes remote membership a fill rather
 * than a rework.
 */
export const TeamMemberSchema = z
  .object({
    /**
     * Opaque roster id: the author id for a person, the manifest ULID for an
     * agent. Every id this payload returns already existed in `authors` or
     * `agents` — the roster mints none of them.
     */
    id: z.string().min(1),
    kind: AuthorKindSchema,
    displayName: z.string().min(1),
    /**
     * What to type after an `@` to address this identity, or `null` when it
     * cannot be addressed (handles spec, DOR-676).
     */
    handle: z.string().nullable(),
    /** Render cache: the emoji avatar, when this identity has one. */
    emoji: z.string().optional(),
    /** Render cache: the identity colour, when this identity has one. */
    color: z.string().optional(),
    /** Render cache: an uploaded photo, when this identity has one. */
    imageUrl: z.string().optional(),
    /**
     * True for exactly one row: the operator reading this.
     *
     * A flag on a row, never a code path — "you" is a chip the card renders,
     * not a branch the roster takes.
     */
    isSelf: z.boolean(),
    /**
     * The person this identity belongs to, in this roster's own id space, or
     * `null` when nothing owns it (a person, a system agent).
     *
     * Semantically `CommunityMemberSchema.ownerMemberId` — an agent admitted
     * because its owner vouched for it — spelled in the ids this payload uses.
     * On a single-user install every locally-registered agent resolves to the
     * one operator; when a remote member's agents arrive this is filled from
     * `ownerMemberId` and no shape changes.
     */
    ownerId: z.string().nullable(),
    origin: AuthorOriginSchema,
    /** Agents only. */
    agent: TeamAgentFactsSchema.optional(),
    /** People only. */
    person: TeamPersonFactsSchema.optional(),
  })
  .openapi('TeamMember');

/** One identity on this install (see {@link TeamMemberSchema}). */
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/**
 * One identity source that could not be read.
 *
 * The same instrument as `SessionListWarningSchema` and for the same reason: a
 * degradation invisible to the Direct transport is a degradation nobody sees,
 * so it travels in-band rather than in a header.
 */
export const TeamSourceWarningSchema = z
  .object({
    /** `'authors'`, `'agents'`, or a community ref once remote sources exist. */
    source: z.string().min(1),
    message: z.string().min(1),
  })
  .openapi('TeamSourceWarning');

/** One identity source that could not be read (see {@link TeamSourceWarningSchema}). */
export type TeamSourceWarning = z.infer<typeof TeamSourceWarningSchema>;

/**
 * Response envelope for `GET /api/team` (ADR 260806-222535, ADR-0310 shape).
 *
 * A source that fails contributes a `warnings[]` entry and zero rows — never a
 * failed request and never a blank page. `warnings` is omitted entirely when
 * every source read cleanly, so a client can treat its presence as the signal.
 */
export const TeamRosterResponseSchema = z
  .object({
    /** The operator first, then everyone else, then the agents. */
    members: z.array(TeamMemberSchema),
    /** Present only when at least one identity source failed or timed out. */
    warnings: z.array(TeamSourceWarningSchema).optional(),
  })
  .openapi('TeamRosterResponse');

/** The `GET /api/team` envelope (see {@link TeamRosterResponseSchema}). */
export type TeamRosterResponse = z.infer<typeof TeamRosterResponseSchema>;
