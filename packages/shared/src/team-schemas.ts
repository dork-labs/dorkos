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
 * What one agent is doing, as a profile says it out loud (spec
 * `profile-unification` §3.1).
 *
 * **One object, always present, both members nullable** — so a renderer asks
 * "is it working, else when was it last active, else it has never run" and never
 * has to guess whether an absent field means idle or means unknown. The three
 * states the status sentence renders are exactly the three this shape can hold:
 * `working` set (working now), `working` null with `lastActiveAt` set (idle,
 * last active then), both null (never run).
 *
 * Deliberately NOT derived from {@link TeamAgentFactsSchema.healthStatus}: that
 * says "seen in the last hour", which is not the same claim and cannot answer
 * "in which room, since when".
 */
export const TeamAgentActivitySchema = z
  .object({
    /**
     * The room turn this agent is holding right now, or `null` when it is not
     * mid-turn.
     *
     * Read from the live claim map (`services/rooms/room-claims.ts`), which is
     * the only record that an agent is working — see the module doc of
     * `services/identity/aggregate-team.ts`.
     */
    working: z
      .object({
        roomId: z.string().min(1),
        /**
         * The room's title, or `null` when it could not be resolved (the rooms
         * read degraded). A status sentence drops the room label rather than the
         * fact of working: "Working · 5 min".
         */
        roomName: z.string().nullable(),
        /** When the claim was taken — ISO 8601. */
        since: z.string(),
      })
      .nullable(),
    /**
     * The most recent moment this agent did anything, or `null` when it has
     * never run. ISO 8601.
     */
    lastActiveAt: z.string().nullable(),
  })
  .openapi('TeamAgentActivity');

/** What one agent is doing (see {@link TeamAgentActivitySchema}). */
export type TeamAgentActivity = z.infer<typeof TeamAgentActivitySchema>;

/**
 * What is true of an agent and of nothing else on the roster.
 *
 * Present only when `kind === 'agent'`. Read from the mesh cache's
 * health-enriched listing, the live room-claim map and the session fan-out;
 * nothing is stored by this endpoint.
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
     * live-turn dot reads {@link TeamAgentActivitySchema.shape.working} instead,
     * which is on this same object and is the only field that means "now".
     */
    recentlyActive: z.boolean(),
    /**
     * The project-directory namespace used for cross-agent messaging permissions.
     *
     * Stripped from the mesh's public listing, and — unlike `projectPath`, which
     * the roster now joins back for its one entitled reader — nothing puts it
     * back, so nothing production serves today fills it. Optional rather than
     * dropped so a future source entitled to it can fill it without a schema
     * change.
     */
    namespace: z.string().optional(),
    /**
     * Where the agent lives — its project directory.
     *
     * **Filled for every agent registered on this machine** (spec
     * `profile-unification` §3.1): the profile opens sessions, skill-packs and
     * tools by path, and the roster is the operator's own cockpit rather than a
     * shared surface. The mesh's PUBLIC listing still strips it, which is why
     * the roster reads the registry's paths beside that listing rather than
     * expecting them in it — see `TeamRosterSources.listAgents`.
     *
     * Optional rather than required because a member whose truth is remote (a
     * community backend, another machine) has no path here to give.
     */
    projectPath: z.string().optional(),
    /** What this agent is doing right now, and when it last did anything. */
    activity: TeamAgentActivitySchema,
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
    /**
     * When this person was last here, or `null` when this install cannot say.
     * ISO 8601.
     *
     * The viewer's own row carries the moment the roster was read — they are
     * here, by construction. For everybody else it is `null` today: the only
     * record of a bridged person's presence is the room log, and the query that
     * would date it scans the largest table on this install on a request the
     * profile repeats every 15 seconds. Required and nullable so the renderer
     * has one branch ("last seen X" or the fallback line) rather than two.
     */
    lastSeenAt: z.string().nullable(),
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
  .superRefine((member, ctx) => {
    // The fact blocks are structurally tied to `kind`, so a producer bug —
    // an agent row carrying person facts, a human row carrying agent facts —
    // fails at parse time instead of relying on the TSDoc staying true.
    if (member.kind !== 'agent' && member.agent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent'],
        message: `agent facts are only valid on kind 'agent', got '${member.kind}'`,
      });
    }
    if (member.kind !== 'human' && member.person !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['person'],
        message: `person facts are only valid on kind 'human', got '${member.kind}'`,
      });
    }
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

/**
 * Response to `POST /api/profile/avatar` — the URL the photo is now served
 * from (spec `identity-consistency` §W3.5, ADR 260806-222546).
 *
 * **Deliberately not a path, and deliberately not parsed.** It is whatever the
 * avatar store returned: server-relative today (`/api/profile/avatar/<id>?v=…`),
 * absolute (`https://…`) the day photos live somewhere other than this machine.
 * Every renderer already treats `imageUrl` as an opaque `src`, which is what
 * makes that change invisible.
 */
export const ProfileAvatarResponseSchema = z
  .object({
    /** Where the photo is served from. Store it; never take it apart. */
    imageUrl: z.string().min(1),
  })
  .openapi('ProfileAvatarResponse');

/** The `POST /api/profile/avatar` response (see {@link ProfileAvatarResponseSchema}). */
export type ProfileAvatarResponse = z.infer<typeof ProfileAvatarResponseSchema>;

/**
 * Body of `PATCH /api/profile` — what the operator wants to be called
 * (spec `identity-consistency` §W3.3).
 *
 * One field, and no `null`: clearing your own name is not a thing a person
 * wants, and an empty name would render as a blank row on the roster the rest
 * of this program exists to fill.
 */
export const ProfileUpdateRequestSchema = z
  .object({
    /** The name every surface should call this person. Trimmed, 1–80 characters. */
    displayName: z.string().trim().min(1).max(80),
  })
  .openapi('ProfileUpdateRequest');

/** The `PATCH /api/profile` body (see {@link ProfileUpdateRequestSchema}). */
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequestSchema>;

/**
 * Response to `PATCH /api/profile` — the name as it will now be read back.
 *
 * Echoed rather than assumed by the client, because the write and the read do
 * not use the same source: the roster resolves a *precedence* over the account
 * name, the stored profile and the author record, so the only honest answer to
 * "what did that do" is the one the server computes after writing.
 */
export const ProfileUpdateResponseSchema = z
  .object({
    /** What the roster will now show for this person. */
    displayName: z.string().min(1),
  })
  .openapi('ProfileUpdateResponse');

/** The `PATCH /api/profile` response (see {@link ProfileUpdateResponseSchema}). */
export type ProfileUpdateResponse = z.infer<typeof ProfileUpdateResponseSchema>;

/**
 * The name a roster shows for the operator when this install knows no other.
 *
 * **Shared because both sides have to agree on it, not because it is tidy.**
 * The server's `resolveOperatorProfile` returns it as the last rung of the name
 * ladder, and Settings › Profile has to RECOGNISE it — a form that seeded its
 * "Display name" field with `You` would present a placeholder as though the
 * person had chosen it, and then let them "save" it as their real name. One
 * definition crossing the wire is the only way that recognition cannot drift.
 *
 * Note this is a different decision from the `'You'` that `author-registry.ts`
 * mints a local human's row with. Those two agree today and are deliberately
 * not coupled: one is what a room calls you, this is what a roster falls back
 * to. Only the second one has a client that must detect it.
 */
export const OPERATOR_FALLBACK_DISPLAY_NAME = 'You';
