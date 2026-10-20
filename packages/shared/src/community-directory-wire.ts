/**
 * The Community wire for a space's member directory, `GET /members` (DOR-3005): who is in the
 * space, for every member, and with their agents, where each runs and who is muted in one
 * request when the caller asks. Re-exported whole by `community-wire.ts`, so callers import it
 * from there like the rest of the wire.
 *
 * This module imports nothing from `community-wire.ts`, which re-exports it: a cycle would read
 * its schemas before they exist.
 *
 * @module shared/community-directory-wire
 */
import { z } from 'zod';
import { HANDLE_PATTERN } from './handle.js';
import { CommunityWireMemberAvailabilityFields } from './community-agent-wire.js';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
// The same pattern as `CommunityWireHandleSchema`, which lives in `community-wire.ts`.
const handle = z.string().regex(HANDLE_PATTERN);

/**
 * The extras `GET /members?include=` can ask for, comma-separated:
 *
 * - `agents`: each person's active agents, in `agents`, linked to their owner by
 *   `ownerMemberId`. It also adds `mutedUntil` to each person's row, for an owner or admin
 *   reading in their own browser only.
 * - `availability`: on those agents' rows, where each runs and whether it is there.
 *
 * A name a space does not know is ignored. Without `include` the page is exactly as before.
 */
export const COMMUNITY_MEMBER_DIRECTORY_INCLUDES = ['agents', 'availability'] as const;

/** Bounded directory query: a page of people, and the extras the caller asks for. */
export const CommunityWireMemberDirectoryQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  include: z
    .string()
    .max(200)
    .optional()
    .transform((value) => new Set(value?.split(',') ?? [])),
});

/**
 * One row of the directory: a person, or (with `include=agents`) one of their agents. No account
 * fields ever. `joinedAt` only for an owner or admin: an ordinary member sees names and roles.
 */
export const CommunityWireDirectoryMemberSchema = z.strictObject({
  memberId: id,
  kind: z.enum(['human', 'agent']),
  displayName: z.string().min(1),
  handle,
  /** A person's role; null on an agent's row. */
  role: z.enum(['owner', 'admin', 'member']).nullable(),
  /** An agent's owner; null on a person's row. */
  ownerMemberId: id.nullable(),
  /** When a person joined, for an owner or admin only. */
  joinedAt: timestamp.optional(),
  /**
   * Until when a person is muted, null when they are not. Only with `include=agents`, and only
   * for an owner or admin reading in their own browser; a paired app's grant never sees it.
   */
  mutedUntil: timestamp.nullable().optional(),
  // An agent's `runsOn`, `lastSeenAt` and `availability`, with `include=availability`.
  ...CommunityWireMemberAvailabilityFields,
});
/** One row of a space's member directory. */
export type CommunityWireDirectoryMember = z.infer<typeof CommunityWireDirectoryMemberSchema>;

/** One page of people, and with `include=agents` the agents those people own. */
export const CommunityWireMemberDirectoryPageSchema = z.strictObject({
  members: z.array(CommunityWireDirectoryMemberSchema).max(100),
  /** The page's people's active agents, with `include=agents` only. */
  agents: z.array(CommunityWireDirectoryMemberSchema).optional(),
  nextCursor: z.uuid().nullable(),
});
/** One page of a space's member directory. */
export type CommunityWireMemberDirectoryPage = z.infer<
  typeof CommunityWireMemberDirectoryPageSchema
>;
