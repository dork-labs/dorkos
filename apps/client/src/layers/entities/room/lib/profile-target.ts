/**
 * The one rule for turning a room author into the id a profile opens on.
 *
 * @module entities/room/lib/profile-target
 */
import type { AuthorRef } from '@dorkos/shared/room-schemas';

/**
 * The id the TEAM roster files this author under, or `undefined` when nothing
 * the caller holds can say.
 *
 * **Two id spaces meet at this line, and they only overlap for people.** A
 * person's roster row IS their author row, so the id a room already carries
 * opens their profile directly. An agent's does not: its roster row is keyed by
 * the id the mesh registered it under, while the room knows the separate author
 * ULID minted for it the first time it spoke (the two are joined server-side on
 * `mintedForManifestId`). So the agent half cannot be worked out from an author
 * at all — it has to be handed in by whoever could reach the fleet, which is
 * what `agentMemberId` is.
 *
 * `system` — the room's own voice — is on nobody's roster and never will be.
 *
 * The rule lives here rather than in any one surface because four of them now
 * ask it: a mention pill, the face beside a message, a member row in the room
 * sheet, and the strip of who is working. A second copy is how one of them ends
 * up opening an empty profile on an id the roster does not hold.
 *
 * @param author - The room's own record for this author.
 * @param agentMemberId - The roster id for this agent, when the caller resolved
 *   one; `undefined` for an agent the fleet could not name. Ignored for anyone
 *   who is not an agent.
 * @returns The roster id to open a profile on, or `undefined` for an identity
 *   with no profile to open — which a caller must render as plain art rather
 *   than as a control that opens nothing.
 */
export function profileMemberIdOf(
  author: Pick<AuthorRef, 'id' | 'kind'>,
  agentMemberId: string | undefined
): string | undefined {
  if (author.kind === 'human') return author.id;
  if (author.kind === 'agent') return agentMemberId;
  return undefined;
}
