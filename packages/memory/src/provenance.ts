/**
 * Rendering for the "where did I learn this" suffix every saved note carries.
 *
 * @module memory/provenance
 */
import {
  MIGRATED_PROVENANCE_PHRASE,
  OUTSIDER_PROVENANCE_PHRASE,
} from '@dorkos/shared/convention-files';
import type { MemoryProvenance } from '@dorkos/shared/memory-provider';

/**
 * Render where a note was learned, as it appears at the end of the note.
 *
 * Two places and no third: a room the note came from, or a one-to-one chat with
 * no room. `(noted in #general, 2026-08-24)` and
 * `(noted in a direct chat, 2026-08-24)`. Either can say the turn had read an
 * outsider's words: `(noted in a direct chat, while reading words DorkOS can't
 * vouch for, 2026-08-24)`. That part is what keeps a stranger's words, carried on
 * by another agent into a direct chat, from passing as the operator's. A note a
 * migration copied in says so instead: `(migrated from Claude Code memory,
 * 2026-10-17)`.
 *
 * **The room label is rendered exactly as given.** The caller passes what a
 * person would see — `'#general'` with its hash, or a bridged room's own name —
 * and this function decorates nothing. Guessing a `#` onto every label would put
 * one in front of names that are not channels, and stripping one would lose the
 * only thing that makes a channel look like a channel.
 *
 * The value comes from the turn's own context, never from the model: a note
 * whose provenance the writer could choose would let a poisoned entry claim it
 * came from somewhere trustworthy.
 *
 * @param provenance - The room (or `null` for a direct chat) and the date.
 */
export function renderProvenanceSuffix(provenance: MemoryProvenance): string {
  // A migrated note was not learned in any room: it was copied in, and the
  // stamp says that rather than inventing a direct chat it never came from.
  if (provenance.migrated === true) return `(${MIGRATED_PROVENANCE_PHRASE}, ${provenance.date})`;
  const where = provenance.room === null ? 'a direct chat' : provenance.room;
  const outsider = provenance.outsider === true ? `, ${OUTSIDER_PROVENANCE_PHRASE}` : '';
  return `(noted in ${where}${outsider}, ${provenance.date})`;
}
