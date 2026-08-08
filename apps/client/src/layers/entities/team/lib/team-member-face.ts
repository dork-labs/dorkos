/**
 * One roster row, resolved into the disc that draws it.
 *
 * @module entities/team/lib/team-member-face
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { resolveIdentityFace, type IdentityFace } from '@/layers/shared/lib';

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
 * @param member - Any row from the team roster, yours or anyone else's.
 * @returns The kind, colour, emoji, photo and fallback letter to draw.
 */
export function teamMemberFace(member: TeamMember): IdentityFace {
  return resolveIdentityFace({
    record: {
      id: member.id,
      kind: member.kind,
      displayName: member.displayName,
      ...(member.emoji ? { emoji: member.emoji } : {}),
      ...(member.color ? { color: member.color } : {}),
      ...(member.imageUrl ? { imageUrl: member.imageUrl } : {}),
    },
    origin: member.origin,
  });
}
