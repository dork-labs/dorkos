/**
 * One roster row, resolved into the disc that draws it.
 *
 * @module entities/team/lib/team-member-face
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { hashToEmoji, resolveIdentityFace, type IdentityFace } from '@/layers/shared/lib';

/**
 * Turn a `TeamMember` into the face `IdentityAvatar` draws.
 *
 * **This exists because the record-building step was the leak, not the
 * resolver.** `resolveIdentityFace` is shared and always was; what five
 * surfaces each hand-wrote was the ten lines that spread a `TeamMember`'s
 * cached fields into its input — and two of those five copies (the Team card
 * and the roster's cluster header) silently omitted `imageUrl`, so a photo
 * uploaded in Settings appeared everywhere except the page the roster is named
 * after. A copied spread cannot be kept correct by review; it can only be
 * deleted. Every surface that draws a roster row goes through here, so a fifth
 * cached field lands in all of them at once or in none.
 *
 * Only the fields the member actually has are passed: `resolveIdentityFace`
 * distinguishes "no cached colour" from `undefined` by absence, and a spread
 * that always wrote the key would hand it `undefined` and defeat the fallback.
 *
 * **An agent that never chose an icon still gets one here** (DOR-1122), because
 * a roster row is the one place that can honestly invent it: a `TeamMember`'s
 * `id` IS the agent's manifest ULID (`TeamAgentFactsSchema.manifestId` is
 * documented as "the same value the row's `id` carries"), so hashing it reaches
 * the exact emoji `resolveAgentVisual` gives the sidebar for that agent. The
 * rung deliberately does NOT live in `resolveIdentityFace`: `MemberList` feeds
 * that function author-row ids, which hash to a different emoji, so one agent
 * would wear two faces in one room. A person keeps the letter — an invented
 * emoji beside somebody's name claims a face nobody chose.
 *
 * It is also not routed through the `override` slot, which outranks a record's
 * own emoji. A hash is the weakest source there is and must lose to anything
 * the agent actually chose.
 *
 * @param member - Any row from the team roster, yours or anyone else's.
 * @returns The kind, colour, emoji, photo and fallback letter to draw.
 */
export function teamMemberFace(member: TeamMember): IdentityFace {
  // Truthiness, not `??`: an empty string is not a face. The spread below drops
  // `''` the same way it drops `undefined`, so a nullish check would let one
  // through to the letter and quietly defeat the invariant above. Nothing
  // produces `emoji: ''` today — `aggregate-team` strips empties — which is
  // exactly why the failure would be silent if that ever changed.
  const emoji = member.emoji || (member.kind === 'agent' ? hashToEmoji(member.id) : undefined);
  return resolveIdentityFace({
    record: {
      id: member.id,
      kind: member.kind,
      displayName: member.displayName,
      ...(emoji ? { emoji } : {}),
      ...(member.color ? { color: member.color } : {}),
      ...(member.imageUrl ? { imageUrl: member.imageUrl } : {}),
    },
    origin: member.origin,
  });
}
