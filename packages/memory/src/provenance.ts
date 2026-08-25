/**
 * Rendering for the "where did I learn this" suffix every saved note carries.
 *
 * @module memory/provenance
 */
import type { MemoryProvenance } from '@dorkos/shared/memory-provider';

/**
 * Render where a note was learned, as it appears at the end of the note.
 *
 * Two shapes and no third: a room the note came from, or a one-to-one chat with
 * no room. `(noted in #general, 2026-08-24)` and
 * `(noted in a direct chat, 2026-08-24)`.
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
  const where = provenance.room === null ? 'a direct chat' : provenance.room;
  return `(noted in ${where}, ${provenance.date})`;
}
