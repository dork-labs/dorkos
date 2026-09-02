/**
 * The one line a surface draws when the name it is showing was an agent's idea
 * (DOR-1022).
 *
 * `config.profile.displayName` is agent-writable on purpose — DorkBot saving
 * "call me Dorian" mid-conversation is how a person gets a name at all — and
 * since DOR-979 that name is also what the roster and the account menu call
 * them. So a suggestion could quietly become the answer to "who are you" with
 * nothing anywhere saying it was proposed rather than chosen.
 *
 * One implementation, three surfaces (the roster card, the account menu, the
 * Settings › Profile name field), because the same sentence appearing three
 * different ways would read as three different facts.
 *
 * @module entities/team/lib/name-provenance
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';

/**
 * What a hint says when this install knows an agent wrote the name but not
 * which one.
 *
 * "an agent" and not a made-up name: attribution is best-effort — an agent whose
 * identity token expired still wrote the name — and the honest version of "we
 * cannot say who" is saying so.
 */
const UNNAMED_AGENT = 'an agent';

/**
 * The provenance note for one roster row, or `null` when there is nothing to
 * say.
 *
 * **`undefined` and `null` are different answers on the wire**, which is why
 * this reads `=== undefined` rather than falling back with `??`. Absent means
 * "no hint" — a person saved the name, or this install has no record, and every
 * install that had a name before provenance was recorded is in that second
 * group. `null` means an agent wrote it and could not be named. See
 * `TeamPersonFacts.nameSuggestedBy`.
 *
 * @param member - The roster row being drawn. Only the viewer's own row ever
 *   carries this fact, so every other row answers `null` for free.
 * @returns The sentence to draw, or `null` to draw nothing.
 */
export function nameProvenanceNote(member: TeamMember): string | null {
  const suggestedBy = member.person?.nameSuggestedBy;
  if (suggestedBy === undefined) return null;
  return `Suggested by ${suggestedBy ?? UNNAMED_AGENT}`;
}
