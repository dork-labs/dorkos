/**
 * The one definition of a character a person cannot see (DOR-5060, DOR-5133).
 *
 * Two jobs read it. A consent surface SHOWS each one, as a `<U+202E>` marker,
 * so a command reads exactly as it will run (`revealHiddenCharacters` in
 * `marketplace-schemas.ts`). Text an agent reads DROPS them, so a model reads
 * what a person sees and nothing more (`untrusted-text.ts`). Both match the
 * same set, so the two can never disagree about what counts as hidden.
 *
 * The set is Unicode's own list of characters that draw nothing when a font
 * has no glyph for them (`Default_Ignorable_Code_Point`): the soft hyphen, the
 * combining grapheme joiner, the Arabic letter mark, the Hangul fillers, the
 * Mongolian vowel separator and free variation selectors, the zero-width
 * spaces and joiners, the bidi marks, overrides and isolates, the invisible
 * operators, the deprecated format characters, the BOM, every variation
 * selector and the whole tag block. To that it adds the line and paragraph
 * separators and the interlinear annotation marks, which are not on Unicode's
 * list but draw nothing either.
 *
 * Every pattern here is linear: each alternative is one code point, with
 * lookarounds at most two code points wide.
 *
 * @module shared/hidden-characters
 */

/** The hidden set, as the body of a `u`-mode character class. */
const HIDDEN_CLASS = '\\p{Default_Ignorable_Code_Point}\\u2028\\u2029\\uFFF9-\\uFFFB';

/**
 * A single U+FE0F straight after an emoji. It only asks for the emoji's colour
 * form (`❤️`) and is in most emoji people type (DOR-5075), so neither
 * job treats it as hidden. A second selector, or one after anything else, is.
 */
const EMOJI_COLOUR_SELECTOR = '(?<=\\p{Extended_Pictographic})\\uFE0F';

/**
 * Every hidden character, for showing to a person who is about to approve the
 * text. Unlike {@link stripHiddenCharacters} it marks the joiners and every
 * flag letter too: on a consent surface even a legitimate one is worth seeing.
 */
export const HIDDEN_CHARACTERS = new RegExp(`(?!${EMOJI_COLOUR_SELECTOR})[${HIDDEN_CLASS}]`, 'gu');

/**
 * A subdivision flag emoji pickers offer (England, Scotland, Wales). Its region
 * letters come from the tag block, which is hidden everywhere else.
 */
const SUBDIVISION_FLAG =
  '\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}';

/** The U+FE0F in a keycap (`1️⃣`), whose base is not an emoji on its own. */
const KEYCAP_SELECTOR = '(?<=[0-9#*])\\uFE0F(?=\\u20E3)';

/**
 * A character a joiner may join: drawn, and not ASCII. Emoji, Persian, Arabic
 * and the Indic scripts are where a joiner changes what a person sees. Between
 * two ASCII characters it changes nothing, so it is a bit nobody can see.
 */
const JOINABLE = `(?![\\x00-\\x7F${HIDDEN_CLASS}])[\\p{L}\\p{M}\\p{N}\\p{S}]`;

/**
 * A zero-width joiner or non-joiner between two characters it can join, or
 * after an emoji's colour selector (`\u{1F3F3}️‍\u{1F308}`). Anywhere
 * else, at an edge or in a run, it joins nothing.
 */
const KEPT_JOINER = `(?<=\\p{Extended_Pictographic}\\uFE0F|${JOINABLE})[\\u200C\\u200D](?=${JOINABLE})`;

/**
 * One pass over text an agent reads: group 1 is something to keep as written,
 * group 2 a separator to turn into a line break, and any other match goes.
 */
const AGENT_HIDDEN = new RegExp(
  `(${SUBDIVISION_FLAG}|${EMOJI_COLOUR_SELECTOR}|${KEYCAP_SELECTOR}|${KEPT_JOINER})|([\\u2028\\u2029])|[${HIDDEN_CLASS}]`,
  'gu'
);

/**
 * Drop every character a person cannot see from text an agent will read.
 *
 * What stays is what draws something or changes how it draws: one colour
 * selector after an emoji, the selector in a keycap, a joiner between two
 * characters it joins (emoji sequences, Persian, the Indic scripts), and the
 * England, Scotland and Wales flags whole. The line and paragraph separators
 * become `\n`, the break a person sees. Idempotent.
 *
 * @param text - Any text.
 * @returns The text as a person sees it.
 */
export function stripHiddenCharacters(text: string): string {
  return text.replace(AGENT_HIDDEN, (_match, kept?: string, separator?: string) =>
    kept !== undefined ? kept : separator !== undefined ? '\n' : ''
  );
}

/** A real subdivision flag (group 1), or a flag letter standing anywhere else. */
const FLAG_OR_STRAY_FLAG_LETTER = new RegExp(`(${SUBDIVISION_FLAG})|[\\u{E0000}-\\u{E007F}]`, 'gu');

/**
 * Drop only the flag letters that are not part of a real subdivision flag.
 *
 * Narrower than {@link stripHiddenCharacters}: `isReactionEmoji` refuses any
 * value this would change, and a reaction has its own rule for selectors.
 *
 * @param text - Any text.
 * @returns The text with only its real subdivision flags' letters left in it.
 */
export function stripStrayFlagLetters(text: string): string {
  return text.replace(FLAG_OR_STRAY_FLAG_LETTER, (_match, flag?: string) => flag ?? '');
}
