/**
 * The Community wire for agents: enrolling one, listing them, and where each runs and whether it
 * is there (specs/server-merge D4, step 3a, DOR-2877). Re-exported whole by `community-wire.ts`,
 * so callers import it from there like the rest of the wire.
 *
 * This module imports nothing from `community-wire.ts`, which re-exports it: a cycle would read
 * its schemas before they exist.
 *
 * @module shared/community-agent-wire
 */
import { z } from 'zod';
import { HANDLE_PATTERN } from './handle.js';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
// The same pattern as `CommunityWireHandleSchema`, which lives in `community-wire.ts`.
const handle = z.string().regex(HANDLE_PATTERN);

/** An enrolled agent identity and owner bond, without a credential. */
export const CommunityWireAgentSchema = z.strictObject({
  memberId: id,
  displayName: z.string().min(1),
  handle,
  ownerMemberId: id,
  active: z.boolean(),
});
/** An enrolled agent identity. */
export type CommunityWireAgent = z.infer<typeof CommunityWireAgentSchema>;
/**
 * Enrollment request made under a scoped personal grant. The community records the grant as the
 * agent's enrolling installation, so two installations sharing a `localAgentId` get one agent
 * each.
 */
export const CommunityWireAgentEnrollRequestSchema = z.strictObject({
  // A local harness owns this identifier. It is deliberately not constrained
  // to the community service's UUID vocabulary.
  localAgentId: z.string().min(1).max(256),
  displayName: z.string().min(1),
  /** The server derives a collision-safe handle when omitted. */
  handle: handle.optional(),
});
/** Public agent management response. */
export const CommunityWireAgentResponseSchema = z.strictObject({ agent: CommunityWireAgentSchema });
/**
 * The caller's active agents. A member signed in to the community sees all of theirs. A
 * personal grant (one installation) sees only the agents it enrolled, plus any enrolled before
 * the community recorded grants or whose enrolling grant was revoked, and can recover, rotate,
 * remove and place in channels only those.
 */
export const CommunityWireAgentListResponseSchema = z.strictObject({
  agents: z.array(CommunityWireAgentSchema),
});

/**
 * How often an app reports in for its agents, in seconds. A space answers its own number with
 * every report (`reportEverySeconds`), and an app follows that one when it has it.
 */
export const COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS = 120;
/**
 * How long after its last report an agent still reads as available: three report intervals, so
 * one late or lost report never shows an agent as offline.
 */
export const COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS =
  3 * COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS;
/** The most agents one report may name: the highest per-person agent limit a host can set. */
export const COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS = 1_000;

/** What kind of computer runs an agent: a person's own, or an agent computer. */
export const CommunityWireAgentRunsOnSchema = z.enum(['computer', 'agent-computer']);
/** What kind of computer runs an agent. */
export type CommunityWireAgentRunsOn = z.infer<typeof CommunityWireAgentRunsOnSchema>;
/**
 * Whether an agent is there: `available` when its app reported in within
 * {@link COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS}, `offline` when it reported before that, and
 * `unknown` when no app ever reported for it (an app from before reports existed), which is
 * never shown as offline.
 */
export const CommunityWireAgentAvailabilitySchema = z.enum(['available', 'offline', 'unknown']);
/** Whether an agent is there. */
export type CommunityWireAgentAvailability = z.infer<typeof CommunityWireAgentAvailabilitySchema>;

/**
 * Read an agent's availability from its last report.
 *
 * @param lastSeenAt - When its app last reported it, or null if one never has.
 * @param now - The time to read it at.
 */
export function communityAgentAvailability(
  lastSeenAt: string | Date | null,
  now: Date
): CommunityWireAgentAvailability {
  if (lastSeenAt === null) return 'unknown';
  const age = now.getTime() - new Date(lastSeenAt).getTime();
  return age <= COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS * 1_000 ? 'available' : 'offline';
}

/**
 * The availability report a paired app sends, every
 * {@link COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS}, while the computer that runs these agents
 * is on. It carries availability and nothing else: which agents, and what kind of computer runs
 * them. Each `agentId` is the destination's own id for the agent (a space's agent member id), so
 * the same shape goes to every space an agent belongs to, and to the account directory later
 * (specs/everything-is-a-space C3, B6). Strict, so a report carrying anything more is refused.
 */
export const CommunityWireAgentAvailabilityReportSchema = z.strictObject({
  agents: z
    .array(z.strictObject({ agentId: id, runsOn: CommunityWireAgentRunsOnSchema }))
    .max(COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS)
    .refine((agents) => new Set(agents.map((agent) => agent.agentId)).size === agents.length, {
      message: 'Name each agent once.',
    }),
});
/** The availability report a paired app sends. */
export type CommunityWireAgentAvailabilityReport = z.infer<
  typeof CommunityWireAgentAvailabilityReportSchema
>;
/**
 * What a space did with a report. `accepted` are the agents it recorded as there now. `refused`
 * are the rest: agents this installation did not enroll, removed ones, and ids it does not know,
 * all alike, so a report never tells whether someone else's agent exists. An app stops naming a
 * refused agent. `reportEverySeconds` is how often this space wants the next report.
 *
 * Not strict, unlike the older responses: a later space may add a field here, and an app built
 * now must still read the answer. The space strips anything this schema does not name before it
 * sends, so nothing extra ever leaves it.
 */
export const CommunityWireAgentAvailabilityReportResponseSchema = z.object({
  accepted: z.array(id),
  refused: z.array(id),
  reportEverySeconds: z.int().positive(),
});
/** What a space did with an availability report. */
export type CommunityWireAgentAvailabilityReportResponse = z.infer<
  typeof CommunityWireAgentAvailabilityReportResponseSchema
>;

/**
 * The query on a channel's member list. `include` is a comma-separated list of extras, and
 * `availability` asks for agents' availability. Without it a space answers the member list
 * exactly as before, which every installed app parses with a strict schema that would refuse the
 * new fields. A name a space does not know is ignored, and a space from before availability
 * ignores the whole query and answers without the fields, which reads as unknown.
 */
export const CommunityWireChannelMembersQuerySchema = z.object({
  include: z
    .string()
    .max(200)
    .optional()
    .transform((value) => new Set(value?.split(',') ?? [])),
});

/**
 * The availability fields of an agent's row in a channel's member list, sent only when the
 * caller asked for them (see {@link CommunityWireChannelMembersQuerySchema}). Never on a
 * person's row.
 */
export const CommunityWireMemberAvailabilityFields = {
  /** What kind of computer runs the agent, from its last report; null before one. */
  runsOn: CommunityWireAgentRunsOnSchema.nullable().optional(),
  /** When the agent's app last reported it; null before one. */
  lastSeenAt: timestamp.nullable().optional(),
  /** Derived by the space from `lastSeenAt` with {@link communityAgentAvailability}. */
  availability: CommunityWireAgentAvailabilitySchema.optional(),
};
