/**
 * The letter an identity falls back to when it has no emoji.
 *
 * @module shared/lib/initial-of
 */

/** Glyph for a name with no letter or digit to draw an initial from. */
const FALLBACK_INITIAL = '?';

/**
 * First letter or digit of a name, uppercased — the letter avatar's glyph.
 *
 * Matches on Unicode letters and digits rather than the first character, so a
 * name that opens with an emoji or a bracket still yields a letter somebody
 * would recognise.
 *
 * @param name - The display name to take an initial from.
 */
export function initialOf(name: string): string {
  const match = /\p{L}|\p{N}/u.exec(name);
  return match ? match[0].toUpperCase() : FALLBACK_INITIAL;
}
